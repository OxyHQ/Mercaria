/**
 * Is every canonical reference this draft holds still one the catalogue offers
 * (#758, ADR 0007 D10).
 *
 * The residual #766 left open. That change narrowed the PICKER to
 * `status = 'active'`, which stops a suppressed brand being offered and stops
 * its name being disclosed to anybody who can type a prefix — and it
 * deliberately did not touch a draft that already HELD such an id, because
 * filtering a search cannot reach a stored row. This is that half, and it takes
 * the second of the three readings recorded on the issue: the reference is
 * SURFACED as a validation finding so the author is asked to choose again,
 * rather than left to publish silently or resolved behind their back.
 *
 * ## Why it is a finding and not a filter
 *
 * A draft's answer is a thing a person entered. Rewriting it to the merge winner
 * or dropping it would be the catalogue editing somebody's work without saying
 * so, and both leave the author looking at a form that no longer says what they
 * typed. A finding says which reference and why, and `withProposalFindings`
 * turns it into a publication refusal through the machinery that already exists
 * — so publish needs no branch of its own.
 *
 * ## ONE question, every reader
 *
 * `docs/reviews/2026-08-17-catalog-authoring-security-review.md` §6 lesson 2:
 * "for any question answered separately by several reads, write the question
 * down and check every reader against it". A draft holds THREE kinds of
 * canonical reference and, before this module, they were answered three
 * different ways:
 *
 *  - `draft_variants.selected_canonical_variant_id` — resolved at publish and
 *    REFUSED when it leads nowhere, with the reasoning stated in place.
 *  - `catalog_authoring_drafts.selected_canonical_product_id` — resolved at
 *    publish and the `null` SILENTLY COERCED (`?.id ?? null`), so the draft
 *    published unlinked and the variant belongs-to consistency check was
 *    skipped. That is the failure the variant branch five lines below it names
 *    — "publishing without the link would quietly hand the variant to the
 *    matcher, which is exactly the overruling D10 forbids, arrived at by
 *    omission" — happening to the product-level selection.
 *  - `catalog_authoring_draft_values.canonical_ref_id`, the picker's own output
 *    — checked NOWHERE. `validation.ts` says so in place: "whether the id names
 *    a row that exists is a READ, and this module takes no database.
 *    `validateDraftRow` is where that belongs and it does not do it yet".
 *
 * All three now get one answer here. The publish-time refusal on the variant is
 * left standing as a backstop: `validateDraftRow` runs inside the publish
 * transaction, so nothing can pass this check and then fail that one — but a
 * publish path whose correctness depended on validation having run first would
 * be one refactor from not being checked at all.
 *
 * ## What "still offered" means
 *
 * Resolvable, through any merge chain, to an `active` row. A merge is routine
 * and the author did nothing; `resolveCanonicalProductSelection` already lands a
 * publication on the winner with no rehoming pass having run, so reporting a
 * merged-but-resolvable reference would refuse publications that work today for
 * a catalogue event the merchant cannot see. What is reported is a chain whose
 * END is not selectable — suppressed, inactive, discontinued, a tombstone with
 * no successor, or an id naming no row.
 *
 * ## It READS and writes nothing
 *
 * Four SELECTs at most, through the resolvers `db/catalogAuthoring/` already
 * owns, so there is one spelling of "does this reference still lead somewhere"
 * in the domain. `catalog-authoring-isolation.test.ts`'s write wall covers the
 * tables reached here; this is a join, which that wall's own comment permits.
 *
 * ## Known and NOT changed here
 *
 * A `canonical_reference` ANSWER that resolves through a merge publishes the id
 * the author picked — the tombstone — because `displayValueOf` writes the stored
 * string into the attribute claim and follows no pointer. That predates this
 * module and is unchanged by it; rewriting a stored answer at publish is a write
 * decision belonging with whoever owns the claim vocabulary, not to a read that
 * exists to ask a question.
 */

import type {
  AuthoringCanonicalRefKind,
  AuthoringValidationFinding,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  resolveBrandSelection,
  resolveCanonicalProductFamilySelection,
  resolveCanonicalProductSelection,
  resolveCanonicalVariantSelection,
} from '../../db/catalogAuthoring/canonicalSearchRepository.js';

/** One variant, as this read sees it. */
export interface DraftVariantForCanonicalSelection {
  readonly id: string;
  readonly position: number;
  readonly selectedCanonicalVariantId: string | null;
}

/** One stored answer, as this read sees it. */
export interface DraftValueForCanonicalSelection {
  readonly fieldId: string;
  readonly attributeKey: string;
  readonly draftVariantId: string | null;
  readonly ordinal: number;
  readonly canonicalRefKind: AuthoringCanonicalRefKind | null;
  readonly canonicalRefId: string | null;
}

export interface CanonicalSelectionInput {
  readonly selectedCanonicalProductId: string | null;
  readonly variants: readonly DraftVariantForCanonicalSelection[];
  readonly values: readonly DraftValueForCanonicalSelection[];
}

/**
 * Whether one reference still leads to a row an author may select.
 *
 * The `switch` is total over {@link AuthoringCanonicalRefKind} and has no
 * default that could answer `true`: a kind added to the tuple without a resolver
 * fails `tsc` here rather than being admitted by a fall-through, which is the
 * direction that matters — the permissive answer is the one nobody notices.
 */
async function referenceIsSelectable(
  db: DatabaseOrTransaction,
  kind: AuthoringCanonicalRefKind,
  id: string,
): Promise<boolean> {
  switch (kind) {
    case 'brand':
      return (await resolveBrandSelection(db, id)) !== null;
    case 'canonical_product':
      return (await resolveCanonicalProductSelection(db, id)) !== null;
    case 'canonical_variant':
      return (await resolveCanonicalVariantSelection(db, id)) !== null;
    case 'canonical_product_family':
      return (await resolveCanonicalProductFamilySelection(db, id)) !== null;
  }
}

/**
 * Findings for every reference this draft holds that the catalogue no longer
 * offers.
 *
 * Answers `[]` with NO database call for a draft that holds none, which is the
 * ordinary case for a merchant who typed their own product from scratch.
 */
export async function canonicalSelectionFindings(
  db: DatabaseOrTransaction,
  input: CanonicalSelectionInput,
): Promise<AuthoringValidationFinding[]> {
  const findings: AuthoringValidationFinding[] = [];

  const selectedProduct = input.selectedCanonicalProductId;
  if (selectedProduct !== null && selectedProduct !== '') {
    if (!(await referenceIsSelectable(db, 'canonical_product', selectedProduct))) {
      findings.push({
        code: 'canonical_reference_not_selectable',
        severity: 'error',
        path: 'classification.selectedCanonicalProductId',
      });
    }
  }

  for (const variant of input.variants) {
    const selected = variant.selectedCanonicalVariantId;
    if (selected === null || selected === '') continue;
    if (await referenceIsSelectable(db, 'canonical_variant', selected)) continue;
    findings.push({
      code: 'canonical_reference_not_selectable',
      severity: 'error',
      path: `variants[${variant.position}].selectedCanonicalVariantId`,
    });
  }

  const positionByVariantId = new Map(
    input.variants.map((variant) => [variant.id, variant.position]),
  );

  /**
   * One lookup per DISTINCT (kind, id), not per answer.
   *
   * Two variants legitimately name one brand, and the catalogue has one answer
   * about it either way — the `identifierCollisionFindings` folding, for the
   * same reason: a second statement on a validate request buys no new fact.
   */
  const selectable = new Map<string, boolean>();
  for (const value of input.values) {
    const id = value.canonicalRefId;
    const kind = value.canonicalRefKind;
    // `catalog_authoring_draft_values_canonical_ref_shape_check` makes the pair
    // all-or-nothing, so a half-populated row is unrepresentable. The narrowing
    // is stated rather than assumed because this file compiles under
    // `strict: false`, where a `null` would flow into a `string` parameter in
    // silence.
    if (id === null || id === '' || kind === null) continue;
    const cacheKey = `${kind}:${id}`;
    let ok = selectable.get(cacheKey);
    if (ok === undefined) {
      ok = await referenceIsSelectable(db, kind, id);
      selectable.set(cacheKey, ok);
    }
    if (ok) continue;
    findings.push({
      code: 'canonical_reference_not_selectable',
      severity: 'error',
      path:
        value.draftVariantId === null
          ? value.ordinal === 0
            ? `fields.${value.attributeKey}`
            : `fields.${value.attributeKey}[${value.ordinal}]`
          : `variants[${positionByVariantId.get(value.draftVariantId) ?? 0}].fields.${value.attributeKey}`,
      fieldId: value.fieldId,
      attributeKey: value.attributeKey,
    });
  }

  return findings;
}
