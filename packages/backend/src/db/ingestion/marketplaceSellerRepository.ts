/**
 * Resolving one MARKETPLACE ACCOUNT to the merchant Mercaria minted for it —
 * issue #65 acceptance 2, "the same product sold by several marketplace sellers
 * produces separate offers under one canonical product".
 *
 * ## Convergence is a UNIQUE, not a read-then-write
 *
 * `INSERT … ON CONFLICT DO NOTHING … RETURNING` plus a read of the row that
 * won. Two concurrent pages observing the same seller — which is ordinary, since
 * one seller appears on many items in one sweep and on many marketplaces at
 * once — converge on one merchant by construction rather than by whoever checked
 * first. A read-then-write would satisfy the words and fail the two cases that
 * actually happen: two workers on one page, and a retry after a timeout the
 * caller never saw.
 *
 * The mint is deliberately NOT inside the identity's transaction as one unit
 * with a `SELECT … FOR UPDATE`: a merchant that loses the race is left
 * unreferenced rather than rolled back, which is a wasted row and not a wrong
 * one. Locking instead would serialize every seller sighting in a page behind
 * one row lock, on the hot path of a marketplace ingestion.
 *
 * ## What a minted merchant is, and everything it is not
 *
 * It is a SELLER OF RECORD on a comparison surface: `merchant_type =
 * 'marketplace_seller'`, `claim_state = 'unclaimed'`, a provider-namespaced
 * slug. It carries no relationship (#55), no native-store link (#84), no
 * verified domain and no native checkout — each of those is its own audited act,
 * and `ebay-marketplace-isolation.test.ts` fails the build if this domain
 * reaches one.
 */

import { and, eq } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { marketplaceSellerIdentities } from '../schema/ingestion.js';
import { merchants } from '../schema/merchants.js';
import { merchantSourceLinks } from '../schema/merchants.js';

export type MarketplaceSellerIdentityRow = typeof marketplaceSellerIdentities.$inferSelect;

/** The identity for one marketplace account, if Mercaria has already minted one. */
export async function findMarketplaceSellerIdentity(
  db: DatabaseOrTransaction = getDb(),
  input: { provider: string; externalSellerId: string },
): Promise<MarketplaceSellerIdentityRow | undefined> {
  const [row] = await db
    .select()
    .from(marketplaceSellerIdentities)
    .where(
      and(
        eq(marketplaceSellerIdentities.provider, input.provider),
        eq(marketplaceSellerIdentities.externalSellerId, input.externalSellerId),
      ),
    );
  return row;
}

export interface ClaimMarketplaceSellerInput {
  provider: string;
  externalSellerId: string;
  merchantId: string;
  sourceId: string;
  sourceRecordId: string;
  displayName: string | null;
  now: Date;
}

/**
 * Claim the identity slot for a marketplace account.
 *
 * @returns The row that WON — this call's, or the concurrent one that got there
 *   first. The caller compares `merchantId` against the one it minted to learn
 *   whether it lost, and a loser's merchant is simply never referenced.
 */
export async function claimMarketplaceSellerIdentity(
  db: DatabaseOrTransaction = getDb(),
  input: ClaimMarketplaceSellerInput,
): Promise<{ row: MarketplaceSellerIdentityRow; created: boolean }> {
  const [inserted] = await db
    .insert(marketplaceSellerIdentities)
    .values({
      provider: input.provider,
      externalSellerId: input.externalSellerId,
      merchantId: input.merchantId,
      firstSourceId: input.sourceId,
      firstSourceRecordId: input.sourceRecordId,
      displayName: input.displayName,
      firstSeenAt: input.now,
      lastSeenAt: input.now,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted !== undefined) return { row: inserted, created: true };

  const existing = await findMarketplaceSellerIdentity(db, {
    provider: input.provider,
    externalSellerId: input.externalSellerId,
  });
  if (existing === undefined) {
    // The insert wrote nothing and the row is not there. That is not a
    // convergence — it is a real fault (a rolled-back sibling, a connection
    // dropped mid-statement), and reading it as "somebody else won" would
    // silently drop the seller from the offer path.
    throw new Error(
      'marketplace_seller_identities conflicted but the winning row could not be read',
    );
  }
  return { row: existing, created: false };
}

/**
 * Move an identity's `last_seen_at`.
 *
 * A separate statement from the claim, and deliberately not part of it: it runs
 * on every sighting of an already-known seller, which is the overwhelming
 * majority of sightings, and folding it into an upsert would make the ordinary
 * path take the write lock the conflict branch needs.
 */
export async function touchMarketplaceSellerIdentity(
  db: DatabaseOrTransaction = getDb(),
  input: { id: string; now: Date; displayName: string | null },
): Promise<void> {
  await db
    .update(marketplaceSellerIdentities)
    .set({
      lastSeenAt: input.now,
      // The display name is refreshed and the canonical `merchants.name` is
      // NOT. A seller renaming their shop must not silently rewrite an identity
      // other rows point at; that is what `merchant_aliases` is for and what #59
      // reviews.
      ...(input.displayName === null ? {} : { displayName: input.displayName }),
    })
    .where(eq(marketplaceSellerIdentities.id, input.id));
}

/**
 * Mint the merchant for a marketplace account.
 *
 * The slug is namespaced by PROVIDER so it can never collide with a claimed
 * merchant's, and the mint is one INSERT rather than a call into
 * `createMerchant`: that service takes a transaction of its own and mints
 * aliases, and a marketplace seller has no alias to mint — its name IS its
 * account handle, which is already the identity row's `display_name`.
 */
export async function insertMarketplaceSellerMerchant(
  db: DatabaseOrTransaction = getDb(),
  input: { name: string; slug: string },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(merchants)
    .values({
      name: input.name,
      slug: input.slug,
      merchantType: 'marketplace_seller',
    })
    .returning({ id: merchants.id });
  if (!row) throw new Error('merchants insert returned no row');
  return row;
}

/** Whether a slug is taken. Merchant slugs are unique FOREVER, tombstones included. */
export async function marketplaceSellerSlugExists(
  db: DatabaseOrTransaction = getDb(),
  slug: string,
): Promise<boolean> {
  const [row] = await db.select({ id: merchants.id }).from(merchants).where(eq(merchants.slug, slug));
  return row !== undefined;
}

/**
 * Record WHICH observation produced a merchant, once.
 *
 * `connector_declared` is the method: the source declared the seller and no
 * matcher decided anything, so a confidence would be a number about a fact
 * nobody estimated. Written only on the MINT — one row per merchant rather than
 * one per observation, because the provenance question is "where did this
 * identity come from" and the answer does not change on the ten-thousandth
 * sighting.
 */
export async function insertMarketplaceSellerSourceLink(
  db: DatabaseOrTransaction = getDb(),
  input: { merchantId: string; sourceRecordId: string; provider: string },
): Promise<void> {
  await db
    .insert(merchantSourceLinks)
    .values({
      merchantId: input.merchantId,
      sourceRecordId: input.sourceRecordId,
      method: 'connector_declared',
      matchRule: `${input.provider}:seller_username`,
      status: 'active',
    })
    .onConflictDoNothing();
}
