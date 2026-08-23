/**
 * Rendering a listing's options from the TYPED axes (#367 line 324, ADR 0007 D6).
 *
 * `db/schema/variantAxes.ts` states the goal in one line — the typed layer
 * "replaces them by ADDITION" — and until this module existed the addition was
 * the whole of it: `native_listing_variant_axes` and
 * `native_variant_axis_assignments` were WRITTEN by the authoring publish path
 * and by the backfill script, and READ by exactly two non-test modules, neither
 * of them a serving path. So nothing a shopper saw came from them, and #367
 * line 324's "not the new source of truth" was unmet for a reason no listing's
 * own state could express.
 *
 * This module is the projection a serving read uses. It is PURE — rows in, DTO
 * fragments out, no database handle and no clock — so the preference is
 * testable without a server and cannot acquire a query.
 *
 * ## What a typed axis renders as, and why not `legacy_option_name`
 *
 * The axis NAME is `attribute_definitions.label`, resolved at read time.
 * `legacy_option_name` is provenance — the verbatim string a backfilled axis
 * was resolved FROM — and rendering it would reproduce the exact defect
 * ADR 0007 D6 exists to remove: `Color`, `Colour`, `color ` and `Tono` as four
 * distinct axes for one shoe. #94 freezes a definition's MEANING once published
 * and deliberately does not freeze its label, so resolving it per read is the
 * design rather than a shortcut.
 *
 * The VALUE is `native_variant_axis_assignments.display_value` — "the seller's
 * own words", the column that exists so `normalized_value` can be the signature
 * input without anybody having to read a folded string.
 *
 * ## A listing is projected WHOLE or not at all
 *
 * {@link projectTypedListingAxes} answers with a listing's complete option set
 * or with `null`, never with a partial one. Mixing representations — this axis
 * from the registry, that one from free text — produces a listing whose two
 * options are named under two different rules, which is worse than either rule
 * applied consistently and is invisible in the DTO. A listing that declares no
 * typed axis at all is the ordinary case and answers `null`, which is the
 * FALLBACK line 324 asks for rather than a failure.
 *
 * ## What this module deliberately cannot reach
 *
 * **An order's option snapshot.** `checkout.service` copies the legacy
 * `{name, value}` pairs onto `order_items` at purchase, and those are frozen by
 * design — an order records what the buyer was shown, and #90's three
 * `order_items` condition columns refuse UPDATE outright for the same reason.
 * Nothing here takes an order, an order item or a draft order, and "make the
 * legacy tables a projection" must never be read as covering them: retyping a
 * placed order's options would rewrite what somebody bought. The seam is stated
 * rather than guarded because there is no function here with an order-shaped
 * parameter to guard.
 *
 * **A write.** No function in this file returns anything a caller could persist
 * and none takes a transaction. The typed rows are written by
 * `variant-axes.service.ts` and the backfill, and this module only reads what
 * they wrote.
 */

import type { ListingOption } from '@mercaria/shared-types';
import type {
  NativeVariantAxisAssignmentRow,
  NativeVariantAxisWithLabel,
} from '../../db/variantAxes/variantAxisRepository.js';

/** One variant's `{name, value}` pairs, the shape `ProductVariantDTO` carries. */
export interface ProjectedVariantOptionValue {
  readonly name: string;
  readonly value: string;
}

/** One listing's whole typed projection — its axes and each variant's values. */
export interface ProjectedTypedAxes {
  /** The listing-level option list, in declared order. */
  readonly options: ListingOption[];
  /** Per variant id, that variant's values in the listing's own axis order. */
  readonly valuesByVariant: Map<string, ProjectedVariantOptionValue[]>;
}

/**
 * Project one listing's typed axes, or `null` when it declares none.
 *
 * `axes` must be this listing's rows in display order and `assignments` its
 * variants' rows in any order; both are already batched by the caller.
 *
 * A variant with NO assignment gets an EMPTY list rather than being omitted,
 * which matters because it is the commonest variant in this catalogue: a
 * single-SKU listing's one variant has no axis value and still exists. Omitting
 * it would make the caller unable to tell "this variant has no values" from
 * "this variant was not projected", and the safe-looking handling of the second
 * is to fall back to legacy for the whole listing — silently, on the most
 * ordinary row there is.
 */
export function projectTypedListingAxes(
  axes: readonly NativeVariantAxisWithLabel[],
  assignments: readonly NativeVariantAxisAssignmentRow[],
  variantIds: readonly string[],
): ProjectedTypedAxes | null {
  if (axes.length === 0) return null;

  // The axis order IS the listing's declared order; every per-variant list is
  // emitted in it, so two variants of one listing never disagree about which
  // option comes first.
  const orderOfKey = new Map(axes.map((axis, index) => [axis.attributeKey, index]));
  const labelOfKey = new Map(axes.map((axis) => [axis.attributeKey, axis.label]));

  const byVariant = new Map<string, NativeVariantAxisAssignmentRow[]>();
  for (const assignment of assignments) {
    // An assignment naming an axis this listing does not declare cannot exist —
    // `native_variant_axis_assignments.axis_id` is a NOT NULL foreign key onto
    // the axis row and a scope trigger ties it to the variant's listing. The
    // guard is here because the caller batches across a PAGE of listings, so a
    // sibling listing's rows are one mis-scoped bucket away.
    if (!orderOfKey.has(assignment.attributeKey)) continue;
    const bucket = byVariant.get(assignment.variantId);
    if (bucket) bucket.push(assignment);
    else byVariant.set(assignment.variantId, [assignment]);
  }

  // The listing's own option list is the DISTINCT display values observed on
  // each axis, in first-seen order within the axis. Deriving it from the
  // assignments rather than storing a value list is the sparse-matrix rule one
  // layer up: nothing in this domain enumerates a Cartesian product, so the
  // values a listing offers are exactly the ones some variant actually has.
  //
  // Accumulated per attribute KEY rather than per label, because a label is not
  // unique: `native_listing_variant_axes_listing_attribute_key` makes the KEY
  // unique per listing and nothing stops two definitions carrying the same
  // word. Bucketing by label would silently fold two axes into one option and
  // render a listing that varies along two dimensions as though it varied along
  // one.
  const valuesOfKey = new Map<string, string[]>(axes.map((axis) => [axis.attributeKey, []]));

  const valuesByVariant = new Map<string, ProjectedVariantOptionValue[]>();
  for (const variantId of variantIds) {
    const rows = [...(byVariant.get(variantId) ?? [])].sort(
      (a, b) => orderOfKey.get(a.attributeKey) - orderOfKey.get(b.attributeKey),
    );
    valuesByVariant.set(
      variantId,
      rows.map((row) => {
        const seen = valuesOfKey.get(row.attributeKey);
        if (seen !== undefined && !seen.includes(row.displayValue)) seen.push(row.displayValue);
        return { name: labelOfKey.get(row.attributeKey), value: row.displayValue };
      }),
    );
  }

  const options: ListingOption[] = axes.map((axis) => ({
    name: axis.label,
    values: valuesOfKey.get(axis.attributeKey) ?? [],
  }));

  return { options, valuesByVariant };
}

/* -------------------------------------------------------------------------- */
/* The shadow comparison                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How one listing's two representations compared.
 *
 * `agreed` is the only class a rollout can move on. The other three are the
 * three ways `VARIANT_AXIS_READS=on` would change what a shopper sees, and they
 * are kept apart because they route to different owners:
 *
 * - `typed_absent` — the listing has legacy options and no typed axes. The
 *   backfill has not reached it. Expected, and the count is the migration
 *   backlog measured on live traffic rather than on a table scan.
 * - `legacy_absent` — typed axes and no legacy rows. Nothing produces this
 *   today; if it appears, a write path stopped maintaining the projection.
 * - `diverged` — both present and different. THIS is the one to watch. A
 *   variant edit rewrites `product_variant_option_values`
 *   (`db/catalog/variantRepository.ts` `updateVariant`) and touches no typed
 *   axis, so a re-sync or a merchant edit desynchronises them silently. Under
 *   `on` a shopper would be served the stale typed value; under `shadow` it is
 *   a counter.
 */
export type VariantAxisShadowClass =
  | 'agreed'
  | 'typed_absent'
  | 'legacy_absent'
  | 'diverged';

/**
 * Classify one listing's two option sets. Pure, so it is testable alone.
 *
 * ## VALUES are compared and NAMES deliberately are not
 *
 * The axis NAME differing is the feature working, not a fault: the whole point
 * of ADR 0007 D6 is that a seller's `Colour` and another's `Tono` both resolve
 * to one definition whose label is `Color`. Counting that as a divergence would
 * mark every backfilled listing permanently diverged and leave the counter
 * unable to report the one thing it exists for — and a metric that is always
 * red is a metric nobody reads.
 *
 * No write path can move a typed axis's label on its own, either: the label
 * lives on `attribute_definitions` and changing it is a deliberate registry
 * edit that moves every listing at once. So a name difference is never evidence
 * of a desync, which is what makes ignoring it safe rather than merely
 * convenient.
 *
 * What IS compared is each variant's ORDERED value sequence, because that is
 * what `updateVariant` moves and because option order is part of what a shopper
 * sees — two representations offering the same values in a different order do
 * not agree for the purpose this comparison serves.
 */
export function classifyVariantAxisShadow(
  typed: ProjectedTypedAxes | null,
  legacyByVariant: ReadonlyMap<string, readonly ProjectedVariantOptionValue[]>,
): VariantAxisShadowClass {
  const legacyHasAny = [...legacyByVariant.values()].some((values) => values.length > 0);
  if (typed === null) return legacyHasAny ? 'typed_absent' : 'agreed';
  const typedHasAny = [...typed.valuesByVariant.values()].some((values) => values.length > 0);
  if (!legacyHasAny) return typedHasAny ? 'legacy_absent' : 'agreed';

  for (const [variantId, legacyValues] of legacyByVariant) {
    const typedValues = typed.valuesByVariant.get(variantId) ?? [];
    if (typedValues.length !== legacyValues.length) return 'diverged';
    for (let index = 0; index < typedValues.length; index += 1) {
      if (typedValues[index].value !== legacyValues[index].value) return 'diverged';
    }
  }
  return 'agreed';
}

/** The counters one process has accumulated. */
export interface VariantAxisShadowCounters {
  readonly listings: number;
  readonly agreed: number;
  readonly typedAbsent: number;
  readonly legacyAbsent: number;
  readonly diverged: number;
}

const EMPTY: VariantAxisShadowCounters = {
  listings: 0,
  agreed: 0,
  typedAbsent: 0,
  legacyAbsent: 0,
  diverged: 0,
};

/*
 * Process-local, the `services/search/shadow.ts` decision verbatim: several ECS
 * tasks each observe their own traffic, a durable row per hydrated listing
 * would be an analytics table this domain has no business owning, and
 * aggregating across tasks belongs to `oxy-infra` scraping the operator
 * endpoint. It is also why nothing here can fail a request.
 */
let counters: VariantAxisShadowCounters = EMPTY;

/** Record one listing's comparison. Never throws; a counter cannot fail a read. */
export function recordVariantAxisShadow(verdict: VariantAxisShadowClass): void {
  counters = {
    listings: counters.listings + 1,
    agreed: counters.agreed + (verdict === 'agreed' ? 1 : 0),
    typedAbsent: counters.typedAbsent + (verdict === 'typed_absent' ? 1 : 0),
    legacyAbsent: counters.legacyAbsent + (verdict === 'legacy_absent' ? 1 : 0),
    diverged: counters.diverged + (verdict === 'diverged' ? 1 : 0),
  };
}

/** The counters, for the operator surface. */
export function readVariantAxisShadowCounters(): VariantAxisShadowCounters {
  return counters;
}

/** Reset. Test-only seam; production never calls it. */
export function resetVariantAxisShadowCounters(): void {
  counters = EMPTY;
}
