/**
 * Reads and writes for `merchants`, `merchant_aliases` and `merchant_domains`.
 *
 * `db` is the first parameter everywhere, for the reason
 * `paymentRepository.ts` gives: a helper typed only as `Database` would
 * silently run outside its caller's transaction.
 *
 * Nothing here follows a merge redirect — `merged_into_id` resolution is the
 * SERVICE's job (`merchant.service.getMerchantPublic`), because whether a
 * tombstone should redirect, 404 or be shown raw depends on which surface is
 * asking. A repository that silently swapped rows would make the operator
 * surface unable to inspect the tombstone itself.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { CanonicalAliasKind } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { merchantAliases, merchantDomains, merchants } from '../schema/merchants.js';

/** A merchant row as the services read it back. */
export type MerchantRow = typeof merchants.$inferSelect;
/** An alias row. `normalizedAlias` is DB-generated (`aliasColumns()`, D16). */
export type MerchantAliasRow = typeof merchantAliases.$inferSelect;
/** A domain observation/verification row. */
export type MerchantDomainRow = typeof merchantDomains.$inferSelect;

/** What the create path supplies; everything else defaults in the schema. */
export interface CreateMerchantInput {
  name: string;
  slug: string;
  merchantType?: MerchantRow['merchantType'];
  description?: string;
}

export async function insertMerchant(
  db: DatabaseOrTransaction,
  input: CreateMerchantInput,
): Promise<MerchantRow> {
  const [row] = await db
    .insert(merchants)
    .values({
      name: input.name,
      slug: input.slug,
      merchantType: input.merchantType ?? null,
      description: input.description ?? null,
    })
    .returning();
  if (!row) {
    throw new Error('Inserting a merchant returned no row.');
  }
  return row;
}

export async function findMerchantById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<MerchantRow | undefined> {
  const [row] = await db.select().from(merchants).where(eq(merchants.id, id));
  return row;
}

export async function findMerchantBySlug(
  db: DatabaseOrTransaction,
  slug: string,
): Promise<MerchantRow | undefined> {
  const [row] = await db.select().from(merchants).where(eq(merchants.slug, slug));
  return row;
}

/** For `ensureUniqueSlug` — cheaper than loading the row it must not find. */
export async function merchantSlugExists(
  db: DatabaseOrTransaction,
  slug: string,
): Promise<boolean> {
  const [row] = await db.select({ id: merchants.id }).from(merchants).where(eq(merchants.slug, slug));
  return row !== undefined;
}

/**
 * Add an alias, converging on the existing row when the normalized form is
 * already present for this merchant — re-asserting a known alias is ordinary
 * (a re-run ingestion batch, D22) and must not error or touch the row.
 */
export async function insertMerchantAlias(
  db: DatabaseOrTransaction,
  input: {
    merchantId: string;
    alias: string;
    kind: CanonicalAliasKind;
    language?: string;
    createdByOxyUserId?: string;
  },
): Promise<MerchantAliasRow | undefined> {
  const [row] = await db
    .insert(merchantAliases)
    .values({
      merchantId: input.merchantId,
      alias: input.alias,
      kind: input.kind,
      language: input.language ?? null,
      createdByOxyUserId: input.createdByOxyUserId ?? null,
    })
    .onConflictDoNothing({
      target: [merchantAliases.merchantId, merchantAliases.normalizedAlias],
    })
    .returning();
  return row;
}

/**
 * Every merchant a normalized alias resolves to. The caller normalizes with
 * the SAME recipe the generated column uses (`lower(btrim(...))`) — the
 * service owns that spelling so the two cannot drift per call site.
 */
export async function findMerchantsByNormalizedAlias(
  db: DatabaseOrTransaction,
  normalizedAlias: string,
): Promise<MerchantRow[]> {
  const aliasRows = await db
    .select({ merchantId: merchantAliases.merchantId })
    .from(merchantAliases)
    .where(eq(merchantAliases.normalizedAlias, normalizedAlias));
  if (aliasRows.length === 0) return [];
  const ids = [...new Set(aliasRows.map((row) => row.merchantId))];
  return db.select().from(merchants).where(inArray(merchants.id, ids));
}

export async function listMerchantAliases(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<MerchantAliasRow[]> {
  return db.select().from(merchantAliases).where(eq(merchantAliases.merchantId, merchantId));
}

/**
 * Record (or refresh) a public-website OBSERVATION.
 *
 * Converges on `(merchant_id, domain)`: a repeat sighting moves
 * `last_observed_at` and nothing else — in particular it never touches
 * `status`, so a re-observation can neither un-verify nor un-reject a domain
 * an operator or #83 already decided about.
 */
export async function observeMerchantDomain(
  db: DatabaseOrTransaction,
  input: { merchantId: string; domain: string; observedAt: Date; note?: string },
): Promise<MerchantDomainRow> {
  const [row] = await db
    .insert(merchantDomains)
    .values({
      merchantId: input.merchantId,
      domain: input.domain,
      firstObservedAt: input.observedAt,
      lastObservedAt: input.observedAt,
      note: input.note ?? null,
    })
    .onConflictDoUpdate({
      target: [merchantDomains.merchantId, merchantDomains.domain],
      set: { lastObservedAt: input.observedAt },
    })
    .returning();
  if (!row) {
    throw new Error('Upserting a merchant domain observation returned no row.');
  }
  return row;
}

/**
 * Mark a domain VERIFIED for a merchant — the write the partial unique
 * `merchant_domains_domain_verified_key` gates: at most one verified holder
 * per domain, ever, at a time. The caller interprets the unique violation;
 * this function deliberately does not catch it, because "who may verify" and
 * "what a collision means" are service decisions.
 *
 * A single-statement CAS on the observation row: re-verifying an
 * already-verified row converges (the WHERE matches, the values are stable),
 * and verifying a domain never observed for this merchant returns undefined
 * rather than inventing an observation.
 */
export async function verifyMerchantDomain(
  db: DatabaseOrTransaction,
  input: { merchantId: string; domain: string; verifiedAt: Date; verifiedByOxyUserId?: string },
): Promise<MerchantDomainRow | undefined> {
  const [row] = await db
    .update(merchantDomains)
    .set({
      status: 'verified',
      verifiedAt: input.verifiedAt,
      verifiedByOxyUserId: input.verifiedByOxyUserId ?? null,
    })
    .where(
      and(eq(merchantDomains.merchantId, input.merchantId), eq(merchantDomains.domain, input.domain)),
    )
    .returning();
  return row;
}

/**
 * Move `merchants.claim_state` and the claim actor that goes with it — the ONE
 * writer of ADR 0002 D9's stored verdict, called only by #83's claim service.
 *
 * The three columns move TOGETHER because they are one fact: a `claimed`
 * merchant with no claimant, or a claimant on an `unclaimed` merchant, are
 * both states nothing downstream could interpret. Revocation passes `null` for
 * the actor and the time, which is what returns the row to exactly the shape
 * it had before it was ever claimed.
 */
export async function setMerchantClaimVerdict(
  db: DatabaseOrTransaction,
  input: {
    merchantId: string;
    claimState: MerchantRow['claimState'];
    claimedByOxyUserId: string | null;
    claimedAt: Date | null;
  },
): Promise<MerchantRow | undefined> {
  const [row] = await db
    .update(merchants)
    .set({
      claimState: input.claimState,
      claimedByOxyUserId: input.claimedByOxyUserId,
      claimedAt: input.claimedAt,
    })
    .where(eq(merchants.id, input.merchantId))
    .returning();
  return row;
}

/** Every merchant with a row for this domain, verified holder first. */
export async function findMerchantDomainsByDomain(
  db: DatabaseOrTransaction,
  domain: string,
): Promise<MerchantDomainRow[]> {
  return db.select().from(merchantDomains).where(eq(merchantDomains.domain, domain));
}

export async function listMerchantDomains(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<MerchantDomainRow[]> {
  return db.select().from(merchantDomains).where(eq(merchantDomains.merchantId, merchantId));
}
