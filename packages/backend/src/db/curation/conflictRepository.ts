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

import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import type { CatalogMergeConflictKind } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { commerceRelationships } from '../schema/relationships.js';
import { offers } from '../schema/offers.js';

/** One collision, in the shape `catalog_merge_conflicts` stores. */
export interface DetectedConflict {
  readonly kind: CatalogMergeConflictKind;
  readonly loserRowId: string;
  readonly winnerRowId: string;
  readonly detail: string;
}

interface RawConflictRow {
  readonly loser_row_id: string;
  readonly winner_row_id: string;
  readonly detail: string;
}

/** Read a detector's rows without trusting the driver's row shape. */
function toConflicts(
  kind: CatalogMergeConflictKind,
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
