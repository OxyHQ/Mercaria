/**
 * The canonical merchant/storefront graph against a REAL PostgreSQL database —
 * issue #54, acceptance criterion 6: source upsert, domain collision,
 * marketplace seller identity, native-store linkage. Plus the merge/redirect
 * substrate and alias normalization, because every one of those properties is
 * held by a partial unique index, a CHECK, a generated column or an
 * `ON CONFLICT` arbiter — none of which exists under a mocked repository.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every name, slug, domain, handle and source id this
 * file writes carries a per-run suffix, and teardown deletes exactly what it
 * created (children first; merge tombstones are neutralized before deletion
 * because `merged_into_id` is RESTRICT — which is itself the property D12
 * wants: a winner cannot vanish from under its tombstones).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { NATIVE_STORE_LINK_METHODS } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { stores } from '../schema/stores.js';
import { deleteTestStores } from './store-teardown.js';
import {
  merchantDomains,
  merchants,
  nativeStoreLinks,
  storefronts,
} from '../schema/merchants.js';
import {
  findMerchantById,
  insertMerchant,
  insertMerchantAlias,
} from '../commerce-graph/merchantRepository.js';
import { findStorefrontBySource } from '../commerce-graph/storefrontRepository.js';
import { findActiveLinkByStore } from '../commerce-graph/nativeStoreLinkRepository.js';
import {
  createMerchant,
  getMerchantPublic,
  getNativeCheckoutEligibility,
  lookupMerchantsByAlias,
  lookupMerchantsByDomain,
  recordDomainObservation,
  verifyDomainForMerchant,
} from '../../services/commerce-graph/merchant.service.js';
import {
  applySourceObservation,
  createStorefront,
  getStorefrontPublic,
} from '../../services/commerce-graph/storefront.service.js';
import {
  findMerchantForNativeStore,
  linkNativeStore,
  revokeLink,
} from '../../services/commerce-graph/native-store-link.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const createdMerchantIds: string[] = [];
const createdStoreIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  // Children first; RESTRICT constraints make any wrong order loud, not silent.
  if (createdMerchantIds.length > 0) {
    // By MERCHANT, because these merchants are about to go and a link RESTRICTs
    // them. It is NOT the store side of the same problem: a link the backfill
    // minted over one of these stores sits under ITS merchant and is invisible
    // here, which is what `deleteTestStores` below covers.
    await db
      .delete(nativeStoreLinks)
      .where(inArray(nativeStoreLinks.merchantId, createdMerchantIds));
    // Neutralize tombstones so the self-referencing RESTRICT lets rows go.
    await db
      .update(storefronts)
      .set({ status: 'active', mergedIntoId: null })
      .where(inArray(storefronts.merchantId, createdMerchantIds));
    await db.delete(storefronts).where(inArray(storefronts.merchantId, createdMerchantIds));
    await db
      .update(merchants)
      .set({ status: 'active', mergedIntoId: null })
      .where(inArray(merchants.id, createdMerchantIds));
    // Aliases, domains and source links cascade with their merchants.
    await db.delete(merchants).where(inArray(merchants.id, createdMerchantIds));
  }
  await deleteTestStores(db, createdStoreIds);
  await closePostgres();
});

/** Create a merchant through the real service and register it for teardown. */
async function mintMerchant(name: string): Promise<string> {
  const merchant = await createMerchant({ name });
  createdMerchantIds.push(merchant.id);
  return merchant.id;
}

/** Insert a native store row directly — the operational side of the graph. */
async function mintStore(): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      handle: `graph-store-${RUN}-${createdStoreIds.length}`,
      name: `Graph Store ${RUN}`,
      description: '',
      brandColor: '#112233',
    })
    .returning();
  if (!row) throw new Error('store insert returned no row');
  createdStoreIds.push(row.id);
  return row.id;
}


describe('source upsert (acceptance 6.1)', () => {
  it('converges a re-delivered source observation on one row, refreshing observation fields only', async () => {
    const merchantId = await mintMerchant(`Upsert Shop ${RUN}`);
    const source = { provider: 'shopify', externalShopId: `shop-${RUN}` };

    const first = await applySourceObservation({
      merchantId,
      ...source,
      channelKind: 'web',
      name: `Upsert Shop ${RUN}`,
      domain: `upsert-${RUN}.example.com`,
      currency: 'RON',
      observedAt: new Date('2026-08-01T00:00:00Z'),
    });

    const second = await applySourceObservation({
      merchantId,
      ...source,
      channelKind: 'web',
      name: `Upsert Shop ${RUN} renamed`,
      domain: `upsert-${RUN}.example.com`,
      currency: 'RON',
      observedAt: new Date('2026-08-02T00:00:00Z'),
    });

    // One row, same identity: the slug is minted once and never re-minted.
    expect(second.id).toBe(first.id);
    expect(second.slug).toBe(first.slug);
    expect(second.firstSeenAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    // Observation fields moved.
    expect(second.name).toBe(`Upsert Shop ${RUN} renamed`);
    expect(second.lastSeenAt?.toISOString()).toBe('2026-08-02T00:00:00.000Z');
    // `currency` is the channel's own and deliberately outside Mercaria's
    // presentment tuple — the shape CHECK admitted RON.
    expect(second.currency).toBe('RON');

    const rows = await db
      .select()
      .from(storefronts)
      .where(eq(storefronts.externalShopId, source.externalShopId));
    expect(rows).toHaveLength(1);
  });

  it("never resurrects an operator's suppression and never overwrites a pinned field", async () => {
    const merchantId = await mintMerchant(`Pinned Shop ${RUN}`);
    const source = { provider: 'woocommerce', externalShopId: `pinned-${RUN}` };

    const created = await applySourceObservation({
      merchantId,
      ...source,
      channelKind: 'web',
      name: `Pinned Shop ${RUN}`,
      observedAt: new Date('2026-08-01T00:00:00Z'),
    });
    await db
      .update(storefronts)
      .set({ status: 'suppressed', pinnedFields: ['name'] })
      .where(eq(storefronts.id, created.id));

    const after = await applySourceObservation({
      merchantId,
      ...source,
      channelKind: 'web',
      name: `Pinned Shop ${RUN} SPAM RENAME`,
      observedAt: new Date('2026-08-03T00:00:00Z'),
    });

    expect(after.id).toBe(created.id);
    expect(after.status).toBe('suppressed');
    expect(after.name).toBe(`Pinned Shop ${RUN}`);
    expect(after.lastSeenAt?.toISOString()).toBe('2026-08-03T00:00:00.000Z');
  });

  it('resolves the source identity back through the lookup key', async () => {
    const merchantId = await mintMerchant(`Lookup Shop ${RUN}`);
    const created = await applySourceObservation({
      merchantId,
      provider: 'Shopify', // case-insensitive on the way in
      externalShopId: `lookup-${RUN}`,
      channelKind: 'web',
      name: `Lookup Shop ${RUN}`,
    });
    const found = await findStorefrontBySource(db, 'shopify', `lookup-${RUN}`);
    expect(found?.id).toBe(created.id);
  });
});

describe('domain collision (acceptance 6.2)', () => {
  it('lets many merchants OBSERVE one domain but exactly one VERIFY it', async () => {
    const domain = `contested-${RUN}.example.com`;
    const merchantA = await mintMerchant(`Domain Holder ${RUN}`);
    const merchantB = await mintMerchant(`Domain Contender ${RUN}`);

    // Observation is not a claim: both record it, and the URL-shaped input is
    // normalized to the bare hostname the CHECK requires.
    await recordDomainObservation({
      merchantId: merchantA,
      domain: `HTTPS://Contested-${RUN}.Example.COM/some/path`,
    });
    await recordDomainObservation({ merchantId: merchantB, domain });

    await verifyDomainForMerchant({ merchantId: merchantA, domain, verifiedByOxyUserId: 'op-1' });
    // Re-verifying the same holder converges rather than erroring.
    await verifyDomainForMerchant({ merchantId: merchantA, domain, verifiedByOxyUserId: 'op-1' });

    // The contender is refused by the partial unique index, surfaced as 409.
    await expect(
      verifyDomainForMerchant({ merchantId: merchantB, domain, verifiedByOxyUserId: 'op-1' }),
    ).rejects.toSatisfy(
      (error: unknown) => isMercariaError(error) && error.httpStatus === 409,
      'expected a 409 MercariaError',
    );

    const rows = await db.select().from(merchantDomains).where(eq(merchantDomains.domain, domain));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === 'verified')).toHaveLength(1);

    // The resolver puts the verified holder first.
    const resolved = await lookupMerchantsByDomain(domain);
    expect(resolved[0]?.merchant.id).toBe(merchantA);
    expect(resolved[0]?.domainStatus).toBe('verified');
    expect(resolved).toHaveLength(2);
  });

  it('cannot verify a domain that was never observed for the merchant', async () => {
    const merchantId = await mintMerchant(`No Observation ${RUN}`);
    await expect(
      verifyDomainForMerchant({ merchantId, domain: `never-${RUN}.example.com` }),
    ).rejects.toSatisfy(
      (error: unknown) => isMercariaError(error) && error.httpStatus === 404,
      'expected a 404 MercariaError',
    );
  });
});

describe('marketplace seller identity (acceptance 6.3)', () => {
  it('keeps "Sold by Amazon" and "Sold by Shop X on Amazon" as separate identities', async () => {
    // Amazon plays two roles here — first-party seller of record AND channel
    // operator — and ADR 0002's identity table gives it distinct rows for
    // them. Seller X is its own merchant whose offers would carry the SAME
    // storefront, and the marketplace fact is the key comparison, never a flag.
    const amazonId = await mintMerchant(`Amazon ${RUN}`);
    const sellerXId = await mintMerchant(`Shop X ${RUN}`);
    expect(sellerXId).not.toBe(amazonId);

    const amazonEs = await applySourceObservation({
      merchantId: amazonId,
      provider: 'amazon',
      externalShopId: `amazon-es-${RUN}`,
      channelKind: 'marketplace',
      name: `Amazon.es ${RUN}`,
      domain: `amazon-${RUN}.example.es`,
      country: 'ES',
    });

    // The two roles a future offer (#57) carries: seller of record and
    // channel. For a first-party offer they coincide; for Seller X they
    // differ — and that DERIVED comparison is the marketplace fact (D8).
    const firstPartyOffer = { sellerMerchantId: amazonId, storefrontId: amazonEs.id };
    const marketplaceOffer = { sellerMerchantId: sellerXId, storefrontId: amazonEs.id };
    expect(firstPartyOffer.sellerMerchantId).toBe(amazonEs.merchantId);
    expect(marketplaceOffer.sellerMerchantId).not.toBe(amazonEs.merchantId);

    // A merchant may operate several regional storefronts (acceptance 2).
    const amazonDe = await applySourceObservation({
      merchantId: amazonId,
      provider: 'amazon',
      externalShopId: `amazon-de-${RUN}`,
      channelKind: 'marketplace',
      name: `Amazon.de ${RUN}`,
      country: 'DE',
    });
    expect(amazonDe.id).not.toBe(amazonEs.id);
    expect(amazonDe.merchantId).toBe(amazonId);

    const profile = await getMerchantPublic(amazonId);
    expect(profile.storefronts.map((s) => s.id).sort()).toEqual(
      [amazonEs.id, amazonDe.id].sort(),
    );
  });
});

describe('native store linkage (acceptance 6.4)', () => {
  it('links one store to one merchant after verification, reversibly, leaving the store untouched', async () => {
    const storeId = await mintStore();
    const merchantId = await mintMerchant(`Native Seller ${RUN}`);
    const otherMerchantId = await mintMerchant(`Native Rival ${RUN}`);
    const otherStoreId = await mintStore();

    const [storeBefore] = await db.select().from(stores).where(eq(stores.id, storeId));

    const link = await linkNativeStore({
      merchantId,
      storeId,
      method: 'operator',
      actorOxyUserId: 'op-oxy-1',
      reason: 'Verified against the seller registry; duplicate review passed.',
    });
    expect(link.status).toBe('active');
    expect(link.verificationMethod).toBe('operator');
    expect(link.verifiedByOxyUserId).toBe('op-oxy-1');

    // Linkage rule 2 / acceptance 4: the native store row is byte-identical —
    // members, handle, policies and counters all live there and none moved.
    const [storeAfter] = await db.select().from(stores).where(eq(stores.id, storeId));
    expect(storeAfter).toEqual(storeBefore);

    // ≤1 active per STORE: a second merchant is refused, naming the taken side.
    await expect(
      linkNativeStore({
        merchantId: otherMerchantId,
        storeId,
        method: 'operator',
        actorOxyUserId: 'op-oxy-1',
        reason: 'Attempting to take an already-linked store.',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isMercariaError(error) && error.httpStatus === 409 && error.message.includes(merchantId),
      'expected a 409 naming the holding merchant',
    );

    // ≤1 active per MERCHANT: the same merchant cannot take a second store.
    await expect(
      linkNativeStore({
        merchantId,
        storeId: otherStoreId,
        method: 'operator',
        actorOxyUserId: 'op-oxy-1',
        reason: 'Attempting a second store for a linked merchant.',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isMercariaError(error) && error.httpStatus === 409,
      'expected a 409 MercariaError',
    );

    // Reverse lookup resolves the store to its canonical merchant.
    const reverse = await findMerchantForNativeStore(storeId);
    expect(reverse.merchant.id).toBe(merchantId);

    // REVERSIBLE: revoke, then the same pair can link again; history remains.
    await revokeLink({
      linkId: link.id,
      actorOxyUserId: 'op-oxy-2',
      reason: 'Linked in error during the pilot.',
    });
    expect(await findActiveLinkByStore(db, storeId)).toBeUndefined();

    const relink = await linkNativeStore({
      merchantId,
      storeId,
      method: 'domain_verification',
      actorOxyUserId: 'op-oxy-1',
      reason: 'Re-verified after the revocation.',
    });
    expect(relink.id).not.toBe(link.id);

    const history = await db
      .select()
      .from(nativeStoreLinks)
      .where(eq(nativeStoreLinks.storeId, storeId));
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.id === link.id)?.status).toBe('revoked');
    expect(history.find((row) => row.id === link.id)?.revokeReason).toBe(
      'Linked in error during the pilot.',
    );
  });

  it('has no name-match verification method, and the schema refuses an unauditable revocation', async () => {
    // Issue linkage rule 4, structurally: the closed set is exactly these
    // three, so "the names matched" is not an expressible verification.
    expect([...NATIVE_STORE_LINK_METHODS].sort()).toEqual([
      'domain_verification',
      'operator',
      'owner_authentication',
    ]);

    const storeId = await mintStore();
    const merchantId = await mintMerchant(`Audit Seller ${RUN}`);
    const link = await linkNativeStore({
      merchantId,
      storeId,
      method: 'owner_authentication',
      actorOxyUserId: 'owner-oxy-1',
      reason: "The store owner's authenticated session is the evidence.",
    });

    // A revocation stripped of its actor/time is refused by the CHECK — the
    // audit trail is a database property, not service discipline.
    let refused: unknown;
    try {
      await db
        .update(nativeStoreLinks)
        .set({ status: 'revoked' })
        .where(eq(nativeStoreLinks.id, link.id));
    } catch (error) {
      refused = error;
    }
    expect(isCheckViolation(refused, 'native_store_links_revoked_state_check')).toBe(true);
  });

  it('derives native-checkout eligibility instead of storing it', async () => {
    const storeId = await mintStore();
    const merchantId = await mintMerchant(`Eligible Seller ${RUN}`);

    // Unclaimed, unlinked: both conjuncts false.
    let verdict = await getNativeCheckoutEligibility(merchantId);
    expect(verdict).toEqual({
      merchantId,
      eligible: false,
      claimState: 'unclaimed',
      hasActiveNativeStoreLink: false,
    });

    await linkNativeStore({
      merchantId,
      storeId,
      method: 'operator',
      actorOxyUserId: 'op-oxy-1',
      reason: 'Linking for the eligibility derivation test.',
    });

    // Linked but unclaimed: still not eligible (D9 — no claim, no checkout).
    verdict = await getNativeCheckoutEligibility(merchantId);
    expect(verdict.eligible).toBe(false);
    expect(verdict.hasActiveNativeStoreLink).toBe(true);

    // The claim seam (#40/#83) moves ONE stored verdict; eligibility follows
    // with no second write anywhere — there is no column that could go stale.
    await db
      .update(merchants)
      .set({ claimState: 'claimed', claimedByOxyUserId: 'owner-oxy-9', claimedAt: new Date() })
      .where(eq(merchants.id, merchantId));
    verdict = await getNativeCheckoutEligibility(merchantId);
    expect(verdict.eligible).toBe(true);
  });
});

describe('merge, suppression and redirect substrate', () => {
  it('redirects a merged tombstone to its winner and never reuses its slug', async () => {
    const winnerId = await mintMerchant(`Ray-Ban ${RUN}`);
    const loserId = await mintMerchant(`Rayban ${RUN}`);
    const loser = await findMerchantById(db, loserId);
    if (!loser) throw new Error('loser vanished');

    await db
      .update(merchants)
      .set({ status: 'merged', mergedIntoId: winnerId })
      .where(eq(merchants.id, loserId));

    const resolved = await getMerchantPublic(loser.slug);
    expect(resolved.merchant.id).toBe(winnerId);
    expect(resolved.redirectedFrom).toBe(loserId);

    // The tombstone keeps its slug forever (D12): a new row cannot take it.
    let refused: unknown;
    try {
      await insertMerchant(db, { name: 'Slug Thief', slug: loser.slug });
    } catch (error) {
      refused = error;
    }
    expect(isUniqueViolation(refused, 'merchants_slug_key')).toBe(true);
  });

  it('refuses a merged status without a winner, and a winner on a live row', async () => {
    const merchantId = await mintMerchant(`Consistency ${RUN}`);
    const otherId = await mintMerchant(`Consistency Winner ${RUN}`);

    let noWinner: unknown;
    try {
      await db.update(merchants).set({ status: 'merged' }).where(eq(merchants.id, merchantId));
    } catch (error) {
      noWinner = error;
    }
    expect(isCheckViolation(noWinner, 'merchants_merged_state_check')).toBe(true);

    let liveWinner: unknown;
    try {
      await db
        .update(merchants)
        .set({ mergedIntoId: otherId })
        .where(eq(merchants.id, merchantId));
    } catch (error) {
      liveWinner = error;
    }
    expect(isCheckViolation(liveWinner, 'merchants_merged_state_check')).toBe(true);
  });

  it('hides a suppressed merchant from public reads and redirects storefront tombstones', async () => {
    const merchantId = await mintMerchant(`Suppressed ${RUN}`);
    await db
      .update(merchants)
      .set({ status: 'suppressed' })
      .where(eq(merchants.id, merchantId));
    await expect(getMerchantPublic(merchantId)).rejects.toSatisfy(
      (error: unknown) => isMercariaError(error) && error.httpStatus === 404,
      'expected a 404 MercariaError',
    );

    const operatorId = await mintMerchant(`Channel Owner ${RUN}`);
    const winner = await createStorefront({
      merchantId: operatorId,
      name: `Winner Channel ${RUN}`,
      channelKind: 'web',
    });
    const loser = await createStorefront({
      merchantId: operatorId,
      name: `Loser Channel ${RUN}`,
      channelKind: 'web',
    });
    await db
      .update(storefronts)
      .set({ status: 'merged', mergedIntoId: winner.id })
      .where(eq(storefronts.id, loser.id));

    const resolved = await getStorefrontPublic(loser.slug);
    expect(resolved.storefront.id).toBe(winner.id);
    expect(resolved.redirectedFrom).toBe(loser.id);
  });
});

describe('alias normalization', () => {
  it('resolves an alias through the generated normalized form, and a repeat insert converges', async () => {
    const merchantId = await mintMerchant(`Alias Holder ${RUN}`);
    const inserted = await insertMerchantAlias(db, {
      merchantId,
      alias: `  Ray-Ban Official ${RUN}  `,
      kind: 'former_name',
    });
    expect(inserted).toBeDefined();

    // The generated column applied lower(btrim(…)); the JS lookup uses the
    // service's one normalization, so a differently-cased, padded query hits.
    const found = await lookupMerchantsByAlias(`RAY-BAN OFFICIAL ${RUN}`);
    expect(found.map((m) => m.id)).toEqual([merchantId]);

    // A re-assertion of the same normalized form is a no-op, not an error.
    const repeat = await insertMerchantAlias(db, {
      merchantId,
      alias: `ray-ban official ${RUN}`,
      kind: 'name_variant',
    });
    expect(repeat).toBeUndefined();
  });
});
