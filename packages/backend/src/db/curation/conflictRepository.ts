/**
 * Conflict DETECTION and RESOLUTION — the queries behind #59 merge invariant 4,
 * "identifier conflicts must be resolved explicitly before commit".
 *
 * ## Every detector probes a real constraint, and probes it the way Postgres will
 *
 * The planning phase's job is to answer "what would this merge's UPDATEs be
 * refused for", so each detector reproduces one unique index's own predicate
 * against the loser/winner pair. The alternative — attempt the merge and catch
 * `23505` — is the shape that produces a HALF-MERGED entity: by the time the
 * violation is raised, four phases have already moved rows, and unwinding them
 * is a second merge nobody planned.
 *
 * ## The joins compare the OTHER key components, not the whole key
 *
 * A merge repoints exactly one column. Two rows collide after it iff the winner
 * already holds a row whose key agrees on every component the merge does NOT
 * touch — so the detectors join on those, with the merged column pinned to the
 * winner. That is why they read as "same kind, same other endpoints" rather
 * than as a comparison of two generated keys: the loser's key is not yet what
 * it would become.
 */

import type { MergeableEntityType } from '@mercaria/shared-types';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import type { CatalogMergeConflictKind } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { commerceRelationships } from '../schema/relationships.js';
import { offers } from '../schema/offers.js';

/** A PAIR collision: two legal rows that become one illegal key. */
export interface DetectedPairConflict {
  /**
   * SUBTRACTIVE, so every kind added to the shared tuple lands here BY DEFAULT
   * and has to be excluded deliberately — `entity_suppressed` (#694) is the
   * first to prove it, having silently become a legal pair kind the moment it
   * joined `CATALOG_MERGE_CONFLICT_KINDS`. The database refuses what this type
   * would admit (`..._pair_shape_check`'s `else false`), so the failure would
   * have been a runtime `23514` rather than a wrong row — but the type should
   * not have to be rescued by the CHECK.
   */
  readonly kind: Exclude<
    CatalogMergeConflictKind,
    | 'compatibility_endpoint_collapse'
    | 'redirect_endpoint_collapse'
    | 'bundle_self_containment'
    | 'entity_suppressed'
  >;
  readonly loserRowId: string;
  readonly winnerRowId: string;
  readonly detail: string;
}

/**
 * A COLLAPSE: ONE row, legal before the merge and illegal after it (#405).
 *
 * A separate shape rather than a pair with a null side, and the difference is
 * load-bearing rather than tidy. `toConflicts` DROPS any row missing either id,
 * so a collapse squeezed into the pair shape would be silently discarded by the
 * very helper that reads it — a detector that finds the case and reports
 * nothing, which is indistinguishable from one that never fired.
 */
export interface DetectedCollapseConflict {
  readonly kind: 'compatibility_endpoint_collapse';
  readonly collapsingRowId: string;
  readonly detail: string;
}

/**
 * A redirect hop a merge would turn into a self-redirect (#405).
 *
 * `table` rather than two shapes, because it is ONE constraint written twice
 * over the same columns — the mapping to a column is `conflictColumns`'s job and
 * a `switch` over it fails `tsc` on a third table nobody wired up.
 */
export interface DetectedRedirectCollapseConflict {
  readonly kind: 'redirect_endpoint_collapse';
  readonly table: 'canonical_product_redirects' | 'canonical_product_family_redirects';
  readonly collapsingRowId: string;
  readonly detail: string;
}

/**
 * A bundle component a merge would make the bundle itself (#405).
 *
 * Named by the PAIR rather than the row id, because the row is removed — by the
 * operator, through the catalogue — BEFORE the conflict is resolved, so an id
 * reference would have to survive its own referent.
 */
export interface DetectedBundleCollapseConflict {
  readonly kind: 'bundle_self_containment';
  readonly bundleVariantId: string;
  readonly componentVariantId: string;
  readonly detail: string;
}

/**
 * An OPEN suppression a merge would destroy (#694).
 *
 * A fourth shape, and neither a pair nor a collapse: it names no catalogue row
 * at all, only the DECISION standing over one. It also carries the SIDE,
 * because the two harms are opposite — a suppressed loser has its suppression
 * LIFTED by the merge, a suppressed winner has its suppression EXTENDED to
 * content nobody examined — and an operator reading the conflict needs to know
 * which one they are looking at.
 */
export interface DetectedSuppressionConflict {
  readonly kind: 'entity_suppressed';
  readonly suppressionId: string;
  readonly side: 'loser' | 'winner';
  readonly detail: string;
}

export type DetectedConflict =
  | DetectedPairConflict
  | DetectedCollapseConflict
  | DetectedRedirectCollapseConflict
  | DetectedBundleCollapseConflict
  | DetectedSuppressionConflict;

interface RawConflictRow {
  readonly loser_row_id: string;
  readonly winner_row_id: string;
  readonly detail: string;
}

/** Read a detector's rows without trusting the driver's row shape. */
function toConflicts(
  kind: DetectedPairConflict['kind'],
  rows: readonly unknown[],
): readonly DetectedConflict[] {
  const detected: DetectedConflict[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const typed = row as Partial<RawConflictRow>;
    if (!typed.loser_row_id || !typed.winner_row_id) continue;
    detected.push({
      kind,
      loserRowId: typed.loser_row_id,
      winnerRowId: typed.winner_row_id,
      detail: typed.detail ?? kind,
    });
  }
  return detected;
}

/**
 * ADR 0002 D14's collision gate, probed at the merge's own grain.
 *
 * TWO uniques are covered by the one `or`, and both matter: the GLOBAL
 * `(canonical_scheme, canonical_value) WHERE active` gate — one owner per GTIN —
 * and the per-entity `(entity, scheme, normalized_value) WHERE active` one that
 * would fire the moment both rows landed on the winner. Detecting only the
 * first would let two identical MPN assertions through, and only the second
 * would let two spellings of one GTIN through.
 *
 * @param grainColumn `product_identifiers.product_id` or `.variant_id`.
 */
export async function detectIdentifierConflicts(
  grainColumn: AnyPgColumn,
  loserId: string,
  winnerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly DetectedConflict[]> {
  const grain = sql.identifier(sqlColumnName(grainColumn));
  const rows = await db.execute(sql`
    select l.id as loser_row_id, w.id as winner_row_id,
           coalesce(l.canonical_scheme, l.scheme) || ':' ||
           coalesce(l.canonical_value, l.normalized_value) as detail
    from product_identifiers l
    join product_identifiers w
      on w.${grain} = ${winnerId}
     and w.status = 'active'
     and (
       (l.canonical_scheme is not null
        and w.canonical_scheme = l.canonical_scheme
        and w.canonical_value = l.canonical_value)
       or (w.scheme = l.scheme and w.normalized_value = l.normalized_value)
     )
    where l.${grain} = ${loserId} and l.status = 'active'
  `);
  return toConflicts('identifier', rows);
}

/**
 * `canonical_variants_product_signature_key` — two variants of one product
 * cannot carry the same option assignments.
 *
 * TOMBSTONES are included deliberately: that unique is full, not partial, so a
 * merged variant still occupies its `(product_id, signature)` slot. This is
 * also why the plan repoints variants with an absence guard — the tombstone
 * stays with the product it was under, and its `merged_into_id` is what resolves.
 */
export async function detectVariantSignatureConflicts(
  loserProductId: string,
  winnerProductId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly DetectedConflict[]> {
  const rows = await db.execute(sql`
    select l.id as loser_row_id, w.id as winner_row_id,
           'signature ' || substr(l.signature, 1, 12) as detail
    from canonical_variants l
    join canonical_variants w on w.product_id = ${winnerProductId} and w.signature = l.signature
    where l.product_id = ${loserProductId} and l.status <> 'merged'
  `);
  return toConflicts('variant_signature', rows);
}

/** `canonical_variants_product_default_key` — at most one default per product. */
export async function detectDefaultVariantConflicts(
  loserProductId: string,
  winnerProductId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly DetectedConflict[]> {
  const rows = await db.execute(sql`
    select l.id as loser_row_id, w.id as winner_row_id, 'default variant' as detail
    from canonical_variants l
    join canonical_variants w on w.product_id = ${winnerProductId} and w.is_default
    where l.product_id = ${loserProductId} and l.is_default
  `);
  return toConflicts('default_variant', rows);
}

/** Every endpoint and scope column that composes `commerce_relationships.endpoint_key`. */
const RELATIONSHIP_KEY_COLUMNS: readonly AnyPgColumn[] = [
  commerceRelationships.organizationId,
  commerceRelationships.brandId,
  commerceRelationships.merchantId,
  commerceRelationships.productFamilyId,
  commerceRelationships.relatedBrandId,
  commerceRelationships.storefrontId,
];

/**
 * `commerce_relationships_open_claim_key` — one OPEN claim per (kind, endpoints).
 *
 * The join pins the merged column to the winner and requires every OTHER
 * component of `endpoint_key` to agree, which is exactly what the generated key
 * would compare after the repoint.
 */
export async function detectRelationshipEndpointConflicts(
  endpointColumn: AnyPgColumn,
  loserId: string,
  winnerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly DetectedConflict[]> {
  const merged = sqlColumnName(endpointColumn);
  const others = RELATIONSHIP_KEY_COLUMNS.filter((column) => sqlColumnName(column) !== merged).map(
    (column) => {
      const name = sql.identifier(sqlColumnName(column));
      return sql` and coalesce(w.${name}, '') = coalesce(l.${name}, '')`;
    },
  );
  const rows = await db.execute(sql`
    select l.id as loser_row_id, w.id as winner_row_id, l.kind as detail
    from commerce_relationships l
    join commerce_relationships w
      on w.kind = l.kind and w.valid_to is null and w.${sql.identifier(merged)} = ${winnerId}
      ${sql.join(others, sql``)}
    where l.${sql.identifier(merged)} = ${loserId} and l.valid_to is null
  `);
  return toConflicts('relationship_endpoint', rows);
}

/**
 * `commerce_relationships_verified_brand_owner_key` — at most ONE current
 * verified owner per brand.
 *
 * A SECOND detector rather than a case of the one above, because this unique
 * spans only `brand_id`: two brands owned by two DIFFERENT organizations
 * collide on a brand merge, and the endpoint comparison above would find
 * nothing precisely because the organizations differ. Missing it would leave
 * the merge to fail at the `relationships` phase with a raw `23505` after four
 * phases had already moved rows.
 */
export async function detectVerifiedBrandOwnerConflicts(
  loserBrandId: string,
  winnerBrandId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly DetectedConflict[]> {
  const rows = await db.execute(sql`
    select l.id as loser_row_id, w.id as winner_row_id, 'verified brand owner' as detail
    from commerce_relationships l
    join commerce_relationships w
      on w.kind = 'organization_owns_brand' and w.status = 'verified'
     and w.valid_to is null and w.brand_id = ${winnerBrandId}
    where l.kind = 'organization_owns_brand' and l.status = 'verified'
      and l.valid_to is null and l.brand_id = ${loserBrandId}
  `);
  return toConflicts('relationship_endpoint', rows);
}

/** The components of `offers.commercial_key`. */
const OFFER_KEY_COLUMNS: readonly AnyPgColumn[] = [
  offers.canonicalVariantId,
  offers.merchantId,
  offers.storefrontId,
  offers.condition,
];

/**
 * `offers_active_commercial_key` — one ACTIVE offer per (canonical variant,
 * seller, channel, condition), for every kind but `native`.
 *
 * Native offers are excluded on both sides because their own unique is on the
 * NATIVE variant, which no canonical merge touches.
 */
export async function detectActiveOfferConflicts(
  offerColumn: AnyPgColumn,
  loserId: string,
  winnerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly DetectedConflict[]> {
  const merged = sqlColumnName(offerColumn);
  const others = OFFER_KEY_COLUMNS.filter((column) => sqlColumnName(column) !== merged).map(
    (column) => {
      const name = sql.identifier(sqlColumnName(column));
      return sql` and coalesce(w.${name}, '') = coalesce(l.${name}, '')`;
    },
  );
  const rows = await db.execute(sql`
    select l.id as loser_row_id, w.id as winner_row_id,
           'active offer on ' || coalesce(l.canonical_variant_id, '?') as detail
    from offers l
    join offers w
      on w.status = 'active' and w.kind <> 'native' and w.${sql.identifier(merged)} = ${winnerId}
      ${sql.join(others, sql``)}
    where l.${sql.identifier(merged)} = ${loserId} and l.status = 'active' and l.kind <> 'native'
  `);
  return toConflicts('active_offer', rows);
}

/**
 * `generic_compatibility_relations_distinct_endpoints_check` — a merge that
 * would land BOTH ends of one relation on the winner (#405).
 *
 * ## Why this detector does not look like the others
 *
 * Every detector above JOINS the loser's rows to the winner's, because a pair
 * collision needs two rows. Here there is one, and the winner side of the join
 * would match nothing — which is precisely how this case reached production
 * undetected: `absenceGuard` and the pair detectors ask the same question, "does
 * the winner already hold an equivalent row", and a collapse answers no.
 *
 * ## TWO shapes, not three
 *
 * `(loser, winner)` and `(winner, loser)`. `(loser, loser)` — the shape #405's
 * own text names first — is UNREPRESENTABLE: the CHECK is unconditional and
 * total, so it refuses `(x, x)` at INSERT, which
 * `curation-writes.realdb.test.ts` asserts against the named constraint
 * with a passing control beside it. Probing for it would be a branch that can
 * never match, and a branch that can never match reads as coverage.
 *
 * Both surviving shapes are enumerated rather than written as a set test,
 * because the second is the one a rewrite drops: it already names the winner
 * and only its OTHER end has to move, so nothing about it looks like the loser's
 * row.
 *
 * ## Only OPEN relations, and the guard is deliberately wider
 *
 * The CHECK is not partial, so a CLOSED relation would raise `23514` on the
 * repoint just as surely — which is why `collapseGuard` skips those too. It
 * raises no conflict, because a closed relation is history and staying with the
 * tombstone is what history does; blocking a merge on one would be a decision
 * with only one possible answer.
 */
export async function detectCompatibilityEndpointCollapse(
  subjectColumn: AnyPgColumn,
  targetColumn: AnyPgColumn,
  loserId: string,
  winnerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly DetectedConflict[]> {
  const subject = sql.identifier(sqlColumnName(subjectColumn));
  const target = sql.identifier(sqlColumnName(targetColumn));
  const rows = await db.execute(sql`
    select r.id as row_id,
           r.kind || ' relation ' ||
           case
             when r.${subject} = ${loserId} then 'points from the loser at the winner'
             else 'points from the winner at the loser'
           end as detail
    from generic_compatibility_relations r
    where r.valid_to is null
      and (
        (r.${subject} = ${loserId} and r.${target} = ${winnerId})
        or (r.${target} = ${loserId} and r.${subject} = ${winnerId})
      )
  `);
  const detected: DetectedCollapseConflict[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const typed = row as { row_id?: string; detail?: string };
    if (!typed.row_id) continue;
    detected.push({
      kind: 'compatibility_endpoint_collapse',
      collapsingRowId: typed.row_id,
      detail: typed.detail ?? 'compatibility endpoint collapse',
    });
  }
  return detected;
}

/**
 * `canonical_product_redirects_self_check` / `canonical_family_redirects_self_check`
 * — a merge that would turn a redirect hop into a self-redirect (#405).
 *
 * ## ONE shape, and the reachability is #59 acceptance 2 rather than a race
 *
 * Only `to_id` moves (`from_id` is `untouched`: a hop OUT of the loser is
 * history about the loser). So the row must already read `(winner, loser)` —
 * a hop INTO the loser whose other end is the winner already. `(loser, loser)`
 * is refused at INSERT by the very CHECK this detects, and `(loser, winner)`
 * has `to_id = winner`, which the repoint's own `where to_id = <loser>` never
 * matches. One shape, therefore, not three.
 *
 * That state looks unreachable — a redirect FROM the winner means the winner was
 * merged away, and `requestMerge` refuses a tombstone winner — until a SPLIT is
 * taken into account. `revive_tombstone` clears `merged_into_id` and returns the
 * status to active while deliberately leaving the redirect rows standing (they
 * are the record that the hop happened). So a revived entity is a legal merge
 * WINNER that still carries a redirect naming the loser, and no race is needed:
 * the reachability comes from the rollback path #59 acceptance 2 exists for.
 *
 * @param table the redirect table, which is also its `catalog_merge_conflicts` column.
 */
export async function detectRedirectEndpointCollapse(
  table: DetectedRedirectCollapseConflict['table'],
  loserId: string,
  winnerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly DetectedConflict[]> {
  const rows = await db.execute(sql`
    select r.id as row_id,
           'redirect from ' || r.from_id || ' to ' || r.to_id ||
           ', which this merge would make a self-redirect' as detail
    from ${sql.identifier(table)} r
    where r.to_id = ${loserId} and r.from_id = ${winnerId}
  `);
  const detected: DetectedRedirectCollapseConflict[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const typed = row as { row_id?: string; detail?: string };
    if (!typed.row_id) continue;
    detected.push({
      kind: 'redirect_endpoint_collapse',
      table,
      collapsingRowId: typed.row_id,
      detail: typed.detail ?? 'redirect endpoint collapse',
    });
  }
  return detected;
}

/**
 * `bundle_components_self_check` — a merge that would make a bundle contain
 * itself (#405).
 *
 * TWO shapes, `(loser, winner)` and `(winner, loser)`, and `(loser, loser)` is
 * refused at INSERT by the very CHECK this detects. `quantity` and `position`
 * ride in the detail so the composition an operator is about to change is
 * legible from the conflict itself — this is the one collapse whose row will be
 * GONE by the time anybody reads the decision.
 */
export async function detectBundleSelfContainment(
  loserVariantId: string,
  winnerVariantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly DetectedConflict[]> {
  const rows = await db.execute(sql`
    select b.bundle_variant_id, b.component_variant_id,
           'bundle ' || b.bundle_variant_id || ' contains component ' ||
           b.component_variant_id || ' (quantity ' || b.quantity || ', position ' ||
           b.position || '), which this merge would make the bundle itself' as detail
    from bundle_components b
    where (b.bundle_variant_id = ${loserVariantId} and b.component_variant_id = ${winnerVariantId})
       or (b.component_variant_id = ${loserVariantId} and b.bundle_variant_id = ${winnerVariantId})
  `);
  const detected: DetectedBundleCollapseConflict[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const typed = row as {
      bundle_variant_id?: string;
      component_variant_id?: string;
      detail?: string;
    };
    if (!typed.bundle_variant_id || !typed.component_variant_id) continue;
    detected.push({
      kind: 'bundle_self_containment',
      bundleVariantId: typed.bundle_variant_id,
      componentVariantId: typed.component_variant_id,
      detail: typed.detail ?? 'bundle self containment',
    });
  }
  return detected;
}

/** Whether that component row is still there — the gate on `drop_component`. */
export async function bundleComponentStillExists(
  bundleVariantId: string,
  componentVariantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db.execute(sql`
    select 1 from bundle_components
    where bundle_variant_id = ${bundleVariantId}
      and component_variant_id = ${componentVariantId}
    limit 1
  `);
  return rows.length > 0;
}

/**
 * `merchant_claims`' `(merchant_id) WHERE state = 'verified'` — #83 acceptance 4.
 *
 * Two claimed merchants cannot become one without deciding who operates the
 * survivor, and that is an ACCESS decision. Nothing in a merge may make it.
 */
export async function detectVerifiedClaimConflicts(
  loserMerchantId: string,
  winnerMerchantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly DetectedConflict[]> {
  const rows = await db.execute(sql`
    select l.id as loser_row_id, w.id as winner_row_id, 'verified merchant claim' as detail
    from merchant_claims l
    join merchant_claims w on w.merchant_id = ${winnerMerchantId} and w.state = 'verified'
    where l.merchant_id = ${loserMerchantId} and l.state = 'verified'
  `);
  return toConflicts('verified_claim', rows);
}

/**
 * `catalog_entity_suppressions` — an open suppression on either side (#694).
 *
 * The first detector that is TYPE-INDEPENDENT: every other one probes a
 * constraint that exists for one entity kind, while a suppression can stand
 * over any of the seven. It is still registered in `detectMergeConflicts`'
 * per-entity table for all seven rather than called outside it, because that
 * table's whole value is that "does a storefront merge probe suppressions" is
 * answered by reading one place — and a reader who found it silent would
 * conclude the probe does not run.
 *
 * It is also the first that names no CONSTRAINT. Nothing in this schema refuses
 * a merge of a suppressed entity; that absence IS the bug, and `docs/curation.md`
 * carries the amended membership test — does proceeding destroy something
 * somebody decided.
 *
 * `entity_id` carries no foreign key (it is polymorphic, discriminated by
 * `entity_type` — #654's subject), so the predicate names both columns. Matching
 * on the id alone would find a suppression of a DIFFERENT entity kind that
 * happens to share an id.
 */
export async function detectEntitySuppressionConflicts(
  entityType: MergeableEntityType,
  loserId: string,
  winnerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly DetectedConflict[]> {
  const rows = await db.execute(sql`
    select s.id as suppression_id,
           case when s.entity_id = ${loserId} then 'loser' else 'winner' end as side,
           case when s.entity_id = ${loserId}
                then 'the losing ' || s.entity_type || ' is suppressed (' || s.reason ||
                     '), and this merge would LIFT that: the tombstone write replaces ' ||
                     'the suppressed status with merged, and every row it covered is rehomed onto a ' ||
                     'winner that is not suppressed'
                else 'the winning ' || s.entity_type || ' is suppressed (' || s.reason ||
                     '), and this merge would EXTEND that suppression to everything the loser ' ||
                     'owns, which nobody examined'
           end as detail
    from catalog_entity_suppressions s
    where s.entity_type = ${entityType}
      and s.lifted_at is null
      and s.entity_id in (${loserId}, ${winnerId})
    order by s.suppressed_at
  `);
  const detected: DetectedSuppressionConflict[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const typed = row as { suppression_id?: string; side?: string; detail?: string };
    if (!typed.suppression_id) continue;
    if (typed.side !== 'loser' && typed.side !== 'winner') continue;
    detected.push({
      kind: 'entity_suppressed',
      suppressionId: typed.suppression_id,
      side: typed.side,
      detail: typed.detail ?? 'an open suppression stands over one side of this merge',
    });
  }
  return detected;
}
