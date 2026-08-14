/**
 * Merchant → native store linkage against a REAL PostgreSQL database — issue
 * #84's seven linkage cases and its seven acceptance criteria, every one of
 * which is held by a partial unique index, a generated column, a CHECK, a
 * trigger or a compare-and-swap that does not exist under a mocked repository.
 *
 * What is checked here and could not be checked anywhere else:
 *
 *  - **acceptance 4, the load-bearing one** — replaying store creation or
 *    linkage creates no duplicate store, merchant mapping or follow target. The
 *    first is `store_linkage_requests_open_key`, a partial unique on a GENERATED
 *    key; the second is #54's paired partial uniques; the third is derived from
 *    the first, because a follow target's identity is the store's immutable id;
 *  - **case 4 / revocation rule 6** — a store already linked to another
 *    canonical merchant BLOCKS, and stays blocked;
 *  - **acceptance 2** — an existing store links without its handle, members,
 *    orders or policies changing, compared field by field around the link;
 *  - **acceptance 5** — a revoked claim erases no commerce or analytics history;
 *  - **acceptance 6** — conflicts and corrections are auditable: the revoked
 *    link row survives with its actor, time and reason;
 *  - the schema's own refusals: an opening request that claims to supersede
 *    something, a correction that supersedes nothing, an `applied` row with no
 *    store, a blocked row with no reason, and the two triggers (identity is
 *    immutable, adoptions are append-only).
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every handle, slug and actor id this file writes
 * carries a per-run suffix, and teardown deletes exactly what it created —
 * children first, because the linkage tables' references into `stores`,
 * `merchants` and `native_store_links` are RESTRICT by design.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { stores } from '../schema/stores.js';
import { deleteTestStores } from './store-teardown.js';
import { withTriggerToggleLock } from './trigger-toggle-lock.js';
import { merchants, nativeStoreLinks } from '../schema/merchants.js';
import { merchantClaims, merchantClaimScopes } from '../schema/merchantClaims.js';
import {
  storeLinkageCandidates,
  storeLinkageOfferOverlaps,
  storeLinkageProfileAdoptions,
  storeLinkageRequests,
} from '../schema/storeLinkage.js';
import {
  countLinkageImpact,
  openStoreLinkageRequest,
  recordProfileAdoption,
  resolveStoreForRequest,
  selectCandidate,
  upsertCandidate,
} from '../store-linkage/storeLinkageRepository.js';
import { findActiveLinkByStore } from '../commerce-graph/nativeStoreLinkRepository.js';
import { createMerchant } from '../../services/commerce-graph/merchant.service.js';
import { linkNativeStore } from '../../services/commerce-graph/native-store-link.service.js';
import {
  applyLinkageRequest,
  getLinkageDiff,
  openLinkageCorrection,
  openLinkageRequest,
  unlinkOnClaimRevocation,
} from '../../services/store-linkage/store-linkage.service.js';
import { createStore } from '../../services/store.service.js';
import { resetCanonicalMatcher } from '../../services/store-linkage/canonical-matcher.port.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const createdMerchantIds: string[] = [];
const createdStoreIds: string[] = [];
const createdClaimIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
  // The seam must be UNREGISTERED for every case here: #58 is not on `main`, so
  // `matcher_unavailable` is the state production is in and the state these
  // cases must describe. A registration leaked from another file would make
  // them pass for a reason that does not hold.
  resetCanonicalMatcher();
}, 120_000);

afterAll(async () => {
  // Children first; the RESTRICT constraints make any wrong order loud, not
  // silent. Adoptions are append-only by TRIGGER, which refuses UPDATE and
  // DELETE alike, so they are deleted DIRECTLY with that trigger suspended for
  // the one statement — see the window below. (This comment used to say they
  // were removed by cascading their request, and that the cascade doubled as a
  // check on the request→adoption RESTRICT. Neither has been true of the code
  // beneath it.)
  if (createdMerchantIds.length > 0 || createdStoreIds.length > 0) {
    const requestIds = (
      await db
        .select({ id: storeLinkageRequests.id })
        .from(storeLinkageRequests)
        .where(inArray(storeLinkageRequests.merchantId, createdMerchantIds))
    ).map((row) => row.id);

    if (requestIds.length > 0) {
      await db
        .delete(storeLinkageOfferOverlaps)
        .where(inArray(storeLinkageOfferOverlaps.requestId, requestIds));
      // The adoption table's append-only TRIGGER refuses a DELETE, which is the
      // property under test — so teardown suspends it for the one statement that
      // has to clean up, under the shared trigger-toggle lock and on the
      // transaction that lock opens.
      //
      // The comment this replaces said suspending it was "safe here and nowhere
      // else: this table belongs to this file alone". That is the reasoning #283
      // contradicts: `alter table … disable trigger` is DATABASE-WIDE, so who
      // owns the TABLE decides nothing — every realdb file shares one server, and
      // two files inside such a window at once leave one deleting against a
      // trigger the other has just re-enabled. The `finally` that re-enabled it
      // went with the fix rather than beside it: inside the transaction an
      // aborted window rolls the DDL back by itself, and a second mechanism for
      // one fact is a way for the two to disagree.
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(
          sql`alter table store_linkage_profile_adoptions disable trigger store_linkage_profile_adoptions_append_only`,
        );
        await tx
          .delete(storeLinkageProfileAdoptions)
          .where(inArray(storeLinkageProfileAdoptions.requestId, requestIds));
        await tx.execute(
          sql`alter table store_linkage_profile_adoptions enable trigger store_linkage_profile_adoptions_append_only`,
        );
      });
      await db
        .delete(storeLinkageCandidates)
        .where(inArray(storeLinkageCandidates.requestId, requestIds));
      await db.delete(storeLinkageRequests).where(inArray(storeLinkageRequests.id, requestIds));
    }
  }
  if (createdMerchantIds.length > 0) {
    // By MERCHANT, because these merchants are about to go and a link RESTRICTs
    // them. This is NOT the store side of the same problem, and reading it as
    // such is what made this file the one that failed a full local run: the
    // backfill's `store_merchants` pass links every active store under ITS OWN
    // merchant, so that row is invisible to this predicate. `deleteTestStores`
    // below is what clears it.
    await db
      .delete(nativeStoreLinks)
      .where(inArray(nativeStoreLinks.merchantId, createdMerchantIds));
    await db.delete(merchantClaimScopes).where(inArray(merchantClaimScopes.claimId, createdClaimIds));
    await db.delete(merchantClaims).where(inArray(merchantClaims.id, createdClaimIds));
    await db.delete(merchants).where(inArray(merchants.id, createdMerchantIds));
  }
  await deleteTestStores(db, createdStoreIds);
  await closePostgres();
});

/** A merchant through the real service, registered for teardown. */
async function mintMerchant(label: string): Promise<string> {
  const merchant = await createMerchant({ name: `Linkage ${label} ${RUN}` });
  createdMerchantIds.push(merchant.id);
  return merchant.id;
}

/** A native store through the real service, registered for teardown. */
async function mintStore(owner: string, label: string): Promise<string> {
  const store = await createStore(owner, { name: `Linkage Store ${label} ${RUN}` });
  createdStoreIds.push(store.id);
  return store.id;
}

/**
 * A VERIFIED claim, written directly.
 *
 * Deliberately not driven through #83's whole flow: that flow is #83's own
 * realdb test's subject, and reproducing it here would make these cases fail
 * for #83's reasons. What #84 needs from a claim is exactly two facts — it is
 * `verified` and its merchant scope is `verified` — and writing those is
 * writing the precondition, not stubbing it.
 */
async function mintVerifiedClaim(input: {
  merchantId: string;
  claimantOxyUserId: string;
  nativeStoreId?: string;
}): Promise<string> {
  const now = new Date();
  const [claim] = await db
    .insert(merchantClaims)
    .values({
      merchantId: input.merchantId,
      claimantOxyUserId: input.claimantOxyUserId,
      nativeStoreId: input.nativeStoreId ?? null,
      method: 'dns_txt',
      subjectKind: 'domain',
      subjectRef: `linkage-${RUN}-${createdClaimIds.length}.example`,
      state: 'verified',
      verifiedAt: now,
    })
    .returning();
  if (!claim) throw new Error('claim insert returned no row');
  createdClaimIds.push(claim.id);

  await db.insert(merchantClaimScopes).values({
    claimId: claim.id,
    scopeKind: 'merchant',
    scopeRef: input.merchantId,
    state: 'verified',
    verifiedAt: now,
  });
  return claim.id;
}

const REASON = 'linking this merchant to the store its owner operates';

/**
 * Assert that a statement was refused by a TRIGGER carrying a given message.
 *
 * Written as a helper because the obvious spelling does not work: drizzle wraps
 * the driver error, so `rejects.toThrow(/append-only/)` matches against
 * `"Failed query: update …"` and FAILS — while a test asserting only
 * `rejects.toThrow()` would pass on any error at all, including the wrong one.
 * Walking the cause chain is what makes the assertion name the trigger it means.
 * `isUniqueViolation`/`isCheckViolation` from `@oxyhq/db` walk the same chain
 * for the same reason.
 */
async function expectTriggerRefusal(
  operation: Promise<unknown>,
  message: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the statement was not refused at all').toBeDefined();

  const messages: string[] = [];
  for (let error = caught; error instanceof Error; error = error.cause) {
    messages.push(error.message);
  }
  expect(messages.join('\n'), `no error in the cause chain matched ${message}`).toMatch(message);
}

// ── Case 1: a verified merchant with no native store ────────────────────────

describe('case 1 — a verified merchant with no native store gets one', () => {
  it('creates the store, links it, and makes the claimant its OWNER', async () => {
    const owner = `owner-1-${RUN}`;
    const merchantId = await mintMerchant('case1');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });

    const request = await openLinkageRequest({
      claimId,
      claimantOxyUserId: owner,
      mode: 'create_store',
      reason: REASON,
    });
    expect(request.state).toBe('draft');

    const applied = await applyLinkageRequest({ requestId: request.id, actorOxyUserId: owner });
    expect(applied.state).toBe('applied');
    expect(applied.step).toBe('completed');
    expect(applied.resolvedStoreId).not.toBeNull();
    expect(applied.nativeStoreLinkId).not.toBeNull();

    const storeId = applied.resolvedStoreId ?? '';
    createdStoreIds.push(storeId);

    // Issue store-creation rules 1 and 2: the EXISTING creation service and
    // permission model, with the verified claimant as owner.
    const [store] = await db.select().from(stores).where(eq(stores.id, storeId));
    expect(store?.handle).toBeTruthy();
    const members = await db.query.storeMembers.findMany({ where: (m, { eq: e }) => e(m.storeId, storeId) });
    expect(members).toHaveLength(1);
    expect(members[0]?.oxyUserId).toBe(owner);
    expect(members[0]?.role).toBe('owner');

    // Issue store-creation rule 6: the mapping is #54's model, not a second one.
    const link = await findActiveLinkByStore(db, storeId);
    expect(link?.merchantId).toBe(merchantId);
    expect(link?.id).toBe(applied.nativeStoreLinkId);

    // Issue store-creation rule 7: merchant and storefront ids stay canonical
    // identity. The merchant row's id is untouched and it holds no store id.
    const [merchant] = await db.select().from(merchants).where(eq(merchants.id, merchantId));
    expect(merchant?.id).toBe(merchantId);
    expect(Object.keys(merchant ?? {})).not.toContain('storeId');

    // #58 is not on `main`, so the seam reports honestly rather than guessing.
    expect(applied.matchState).toBe('nothing_to_match');
  });
});

// ── Acceptance 4: idempotency is a DATABASE property ────────────────────────

describe('acceptance 4 — replaying creates no duplicate store, mapping or follow target', () => {
  it('a replayed OPEN converges on the same request row', async () => {
    const owner = `owner-replay-${RUN}`;
    const merchantId = await mintMerchant('replay');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });

    const first = await openLinkageRequest({
      claimId,
      claimantOxyUserId: owner,
      mode: 'create_store',
      reason: REASON,
    });
    const second = await openLinkageRequest({
      claimId,
      claimantOxyUserId: owner,
      mode: 'create_store',
      reason: 'a different reason entirely, which must not mint a second request',
    });
    expect(second.id).toBe(first.id);

    const rows = await db
      .select()
      .from(storeLinkageRequests)
      .where(eq(storeLinkageRequests.claimId, claimId));
    expect(rows).toHaveLength(1);
  });

  it('a replayed APPLY reuses the store — no second store, no second link', async () => {
    const owner = `owner-reapply-${RUN}`;
    const merchantId = await mintMerchant('reapply');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });

    const request = await openLinkageRequest({
      claimId,
      claimantOxyUserId: owner,
      mode: 'create_store',
      reason: REASON,
    });
    const first = await applyLinkageRequest({ requestId: request.id, actorOxyUserId: owner });
    const second = await applyLinkageRequest({ requestId: request.id, actorOxyUserId: owner });

    createdStoreIds.push(first.resolvedStoreId ?? '');

    expect(second.id).toBe(first.id);
    expect(second.resolvedStoreId).toBe(first.resolvedStoreId);
    expect(second.nativeStoreLinkId).toBe(first.nativeStoreLinkId);

    // The three "no duplicate" claims, each read from the database:
    //  1. ONE store carrying this merchant's name pattern;
    const storeRows = await db
      .select()
      .from(stores)
      .where(eq(stores.id, first.resolvedStoreId ?? ''));
    expect(storeRows).toHaveLength(1);
    //  2. ONE active `native_store_links` row per side;
    const links = await db
      .select()
      .from(nativeStoreLinks)
      .where(eq(nativeStoreLinks.merchantId, merchantId));
    expect(links.filter((row) => row.status === 'active')).toHaveLength(1);
    //  3. ONE follow target, which is the SAME fact as one store whose id never
    //     moves — a `mercaria.store` target's identity is
    //     `https://mercaria.co/stores/<storeId>` and `ensureFollowTarget` is
    //     idempotent on it. The backend creates no target, so the guarantee is
    //     the store id being stable, which the write-once CAS gives.
    expect(second.resolvedStoreId).toBe(storeRows[0]?.id);
  });

  it('the OPEN key is a partial unique on a GENERATED column, not a service check', async () => {
    // The strongest form of acceptance 4: bypass the service entirely and write
    // the duplicate directly. A read-then-write in the service would let this
    // through; the index does not.
    const owner = `owner-index-${RUN}`;
    const merchantId = await mintMerchant('index');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });

    const base = {
      merchantId,
      claimId,
      claimantOxyUserId: owner,
      mode: 'create_store' as const,
      requestedStoreId: null,
      supersedesLinkId: null,
      reason: REASON,
      impact: await countLinkageImpact(db, { storeId: null, merchantId }),
    };

    const first = await openStoreLinkageRequest(db, base);
    expect(first.created).toBe(true);

    // A raw insert with the same identity — the index is what refuses it.
    await expect(
      db.insert(storeLinkageRequests).values({
        merchantId,
        claimId,
        claimantOxyUserId: owner,
        mode: 'create_store',
        requestedStoreId: null,
        reason: REASON,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isUniqueViolation(error, 'store_linkage_requests_open_key'),
    );

    // And the repository's own path converges rather than throwing.
    const second = await openStoreLinkageRequest(db, base);
    expect(second.created).toBe(false);
    expect(second.request.id).toBe(first.request.id);
  });

  it('the generated key spans the four IMMUTABLE identity columns', async () => {
    const owner = `owner-key-${RUN}`;
    const merchantId = await mintMerchant('key');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });
    const storeId = await mintStore(owner, 'key');

    const [row] = await db
      .insert(storeLinkageRequests)
      .values({
        merchantId,
        claimId,
        claimantOxyUserId: owner,
        mode: 'link_existing',
        requestedStoreId: storeId,
        reason: REASON,
      })
      .returning();
    expect(row?.requestKey).toBe(`${claimId}|link_existing|${storeId}|`);
  });
});

// ── Case 2: link an existing store ──────────────────────────────────────────

describe('case 2 / acceptance 2 — an existing store links without changing', () => {
  it('leaves handle, members, policies and settings byte-for-byte identical', async () => {
    const owner = `owner-2-${RUN}`;
    const merchantId = await mintMerchant('case2');
    const storeId = await mintStore(owner, 'case2');
    const claimId = await mintVerifiedClaim({
      merchantId,
      claimantOxyUserId: owner,
      nativeStoreId: storeId,
    });

    const [before] = await db.select().from(stores).where(eq(stores.id, storeId));
    const membersBefore = await db.query.storeMembers.findMany({
      where: (m, { eq: e }) => e(m.storeId, storeId),
    });

    const request = await openLinkageRequest({
      claimId,
      claimantOxyUserId: owner,
      mode: 'link_existing',
      storeId,
      reason: REASON,
    });
    expect(request.state).toBe('draft');

    const applied = await applyLinkageRequest({ requestId: request.id, actorOxyUserId: owner });
    expect(applied.state).toBe('applied');
    expect(applied.resolvedStoreId).toBe(storeId);

    const [after] = await db.select().from(stores).where(eq(stores.id, storeId));
    const membersAfter = await db.query.storeMembers.findMany({
      where: (m, { eq: e }) => e(m.storeId, storeId),
    });

    // Field by field rather than a whole-row compare, so a future column that
    // linkage legitimately touches is a visible edit here. `updatedAt` is
    // excluded because nothing was written — and asserting it is UNCHANGED is
    // the stronger claim, so it is asserted.
    expect(after?.handle).toBe(before?.handle);
    expect(after?.name).toBe(before?.name);
    expect(after?.description).toBe(before?.description);
    expect(after?.defaultCurrency).toBe(before?.defaultCurrency);
    expect(after?.status).toBe(before?.status);
    expect(after?.policiesRefundPolicy).toBe(before?.policiesRefundPolicy);
    expect(after?.taxSettingsPricesIncludeTax).toBe(before?.taxSettingsPricesIncludeTax);
    expect(after?.updatedAt.toISOString()).toBe(before?.updatedAt.toISOString());
    expect(membersAfter).toEqual(membersBefore);

    // Issue existing-store rule 5: the native store now maps to the canonical
    // merchant, and that is the ONLY thing that changed.
    expect((await findActiveLinkByStore(db, storeId))?.merchantId).toBe(merchantId);
  });

  it('adopts a selected field explicitly, keeping the previous value as provenance', async () => {
    const owner = `owner-adopt-${RUN}`;
    const merchantId = await mintMerchant('adopt');
    const storeId = await mintStore(owner, 'adopt');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });

    const [before] = await db.select().from(stores).where(eq(stores.id, storeId));
    const request = await openLinkageRequest({
      claimId,
      claimantOxyUserId: owner,
      mode: 'link_existing',
      storeId,
      reason: REASON,
    });
    await applyLinkageRequest({
      requestId: request.id,
      actorOxyUserId: owner,
      adoptFields: ['name'],
    });

    const [merchant] = await db.select().from(merchants).where(eq(merchants.id, merchantId));
    const [after] = await db.select().from(stores).where(eq(stores.id, storeId));
    expect(after?.name).toBe(merchant?.name);
    // The handle is NOT recomputed from the new name — issue existing-store
    // rule 7, and the reason `handle` is not an adoptable field at all.
    expect(after?.handle).toBe(before?.handle);

    const [adoption] = await db
      .select()
      .from(storeLinkageProfileAdoptions)
      .where(eq(storeLinkageProfileAdoptions.requestId, request.id));
    expect(adoption?.field).toBe('name');
    expect(adoption?.source).toBe('canonical_merchant');
    expect(adoption?.previousValue).toBe(before?.name);
    expect(adoption?.adoptedValue).toBe(merchant?.name);
  });
});

// ── Case 4: the conflicting link ────────────────────────────────────────────

describe('case 4 / revocation rule 6 — a conflicting live link BLOCKS', () => {
  it('refuses a store already linked to another canonical merchant, and stays refused', async () => {
    const incumbentOwner = `owner-incumbent-${RUN}`;
    const challengerOwner = `owner-challenger-${RUN}`;
    const incumbentMerchantId = await mintMerchant('incumbent');
    const challengerMerchantId = await mintMerchant('challenger');
    const storeId = await mintStore(challengerOwner, 'contested');

    // The store already resolves to somebody else's canonical identity.
    await linkNativeStore({
      merchantId: incumbentMerchantId,
      storeId,
      method: 'operator',
      reason: 'the incumbent linkage this case is a conflict with',
      actorOxyUserId: incumbentOwner,
    });

    const claimId = await mintVerifiedClaim({
      merchantId: challengerMerchantId,
      claimantOxyUserId: challengerOwner,
    });
    const request = await openLinkageRequest({
      claimId,
      claimantOxyUserId: challengerOwner,
      mode: 'link_existing',
      storeId,
      reason: REASON,
    });

    expect(request.state).toBe('blocked');
    expect(request.blockReason).toBe('store_linked_to_other_merchant');

    // "Blocks new activation until resolved": applying is refused, and the
    // refusal names no other party's merchant or store.
    await expect(
      applyLinkageRequest({ requestId: request.id, actorOxyUserId: challengerOwner }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isMercariaError(error)) return false;
      expect(error.message).not.toContain(incumbentMerchantId);
      return error.code === 'CONFLICT';
    });

    // And the incumbent link is exactly where it was.
    expect((await findActiveLinkByStore(db, storeId))?.merchantId).toBe(incumbentMerchantId);
  });

  it('the database refuses a second ACTIVE link even bypassing the service', async () => {
    // #54's paired partial uniques are the mapping's own idempotency, and #84
    // inherits rather than restates them. Asserted here because acceptance 4
    // names "no duplicate merchant mapping" and this is where that lives.
    const owner = `owner-dbconflict-${RUN}`;
    const merchantA = await mintMerchant('dbconflict-a');
    const merchantB = await mintMerchant('dbconflict-b');
    const storeId = await mintStore(owner, 'dbconflict');

    await linkNativeStore({
      merchantId: merchantA,
      storeId,
      method: 'operator',
      reason: 'the first link, which holds the store side of the cardinality',
      actorOxyUserId: owner,
    });

    await expect(
      db.insert(nativeStoreLinks).values({
        merchantId: merchantB,
        storeId,
        verificationMethod: 'operator',
        verifiedByOxyUserId: owner,
        verifiedAt: new Date(),
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isUniqueViolation(error, 'native_store_links_store_id_active_key'),
    );
  });
});

// ── Case 3: several candidates require review ───────────────────────────────

describe('case 3 — several candidate stores go to review, not to a guess', () => {
  it('routes to `awaiting_review` and records every candidate with its evidence', async () => {
    const owner = `owner-3-${RUN}`;
    const merchantId = await mintMerchant('case3');
    const storeA = await mintStore(owner, 'case3a');
    const storeB = await mintStore(owner, 'case3b');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });

    const request = await openLinkageRequest({
      claimId,
      claimantOxyUserId: owner,
      // No store named, and the claimant manages two — the ambiguity itself.
      mode: 'create_store',
      reason: REASON,
    });

    // `create_store` is never ambiguous (it makes a NEW store), so the review
    // path is exercised through the linkage the ambiguity actually affects.
    expect(request.state).toBe('draft');

    const ambiguous = await openLinkageRequest({
      claimId,
      claimantOxyUserId: owner,
      mode: 'link_existing',
      storeId: storeA,
      reason: REASON,
    });
    // Naming one of two RESOLVES the ambiguity — that is the sanctioned way out
    // of case 3, and it must not be mistaken for the guess the issue forbids:
    // the claimant said which, explicitly, holding `store:manage` on it.
    expect(ambiguous.state).toBe('draft');

    const candidates = await db
      .select()
      .from(storeLinkageCandidates)
      .where(eq(storeLinkageCandidates.requestId, ambiguous.id));
    expect(candidates.map((row) => row.storeId).sort()).toEqual([storeA, storeB].sort());
    // Every candidate carries EVIDENCE from the closed set, and none of it is a
    // name — the property the whole review path exists to preserve.
    for (const candidate of candidates) {
      expect(candidate.source).not.toMatch(/name|similar|score/i);
    }
    expect(
      candidates.find((row) => row.storeId === storeA)?.disposition,
    ).toBe('selected');
    expect(
      candidates.find((row) => row.storeId === storeB)?.disposition,
    ).toBe('rejected');
  });

  it('at most ONE candidate can be selected per request, by index', async () => {
    const owner = `owner-select-${RUN}`;
    const merchantId = await mintMerchant('select');
    const storeA = await mintStore(owner, 'selecta');
    const storeB = await mintStore(owner, 'selectb');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });

    const [request] = await db
      .insert(storeLinkageRequests)
      .values({
        merchantId,
        claimId,
        claimantOxyUserId: owner,
        mode: 'link_existing',
        requestedStoreId: storeA,
        reason: REASON,
      })
      .returning();
    const requestId = request?.id ?? '';

    await upsertCandidate(db, { requestId, storeId: storeA, source: 'operator', evidenceRef: null });
    await upsertCandidate(db, { requestId, storeId: storeB, source: 'operator', evidenceRef: null });
    await selectCandidate(db, { requestId, storeId: storeA });

    // A raw second selection — the partial unique is what refuses it, and a
    // request resolving to two stores is the ambiguity case 3 exists to stop.
    await expect(
      db
        .update(storeLinkageCandidates)
        .set({ disposition: 'selected' })
        .where(
          // `and(...)`, never a JS `&&`: `&&` on two SQL fragments evaluates to
          // the SECOND one, so the request scope would silently vanish and the
          // update would touch every request's candidate for that store — a
          // test that passed for the wrong reason.
          and(
            eq(storeLinkageCandidates.requestId, requestId),
            eq(storeLinkageCandidates.storeId, storeB),
          ),
        ),
    ).rejects.toSatisfy((error: unknown) =>
      isUniqueViolation(error, 'store_linkage_candidates_selected_key'),
    );
  });
});

// ── Case 5: one merchant, several storefronts, one native store ─────────────

describe('case 5 — several storefronts, ONE native store', () => {
  it('links once and the merchant keeps every channel it operates', async () => {
    const owner = `owner-5-${RUN}`;
    const merchantId = await mintMerchant('case5');
    const storeId = await mintStore(owner, 'case5');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });

    const request = await openLinkageRequest({
      claimId,
      claimantOxyUserId: owner,
      mode: 'link_existing',
      storeId,
      reason: REASON,
    });
    await applyLinkageRequest({ requestId: request.id, actorOxyUserId: owner });

    // D4's cardinality is per MERCHANT, not per channel: however many
    // storefronts the merchant operates, exactly one active link exists.
    const active = await db
      .select()
      .from(nativeStoreLinks)
      .where(eq(nativeStoreLinks.merchantId, merchantId));
    expect(active.filter((row) => row.status === 'active')).toHaveLength(1);

    // And a SECOND store cannot join the same merchant — the merchant-side
    // partial unique, which is what makes "one native store" true rather than
    // merely intended.
    //
    // The SAME claim is reused deliberately, and it is not a shortcut: #83's
    // `merchant_claims_merchant_verified_key` permits exactly ONE verified claim
    // per merchant, so a second one does not exist to open a second request
    // with. That constraint is what makes this case's shape inevitable rather
    // than chosen.
    const secondStore = await mintStore(owner, 'case5-second');
    const secondRequest = await openLinkageRequest({
      claimId,
      claimantOxyUserId: owner,
      mode: 'link_existing',
      storeId: secondStore,
      reason: REASON,
    });
    expect(secondRequest.state).toBe('blocked');
    expect(secondRequest.blockReason).toBe('merchant_linked_to_other_store');
  });
});

// ── Case 7 / acceptance 5 & 6: revocation and correction ────────────────────

describe('case 7 / acceptance 5 — revocation preserves everything public', () => {
  it('revokes the link, keeps the store, its orders and the merchant page', async () => {
    const owner = `owner-revoke-${RUN}`;
    const merchantId = await mintMerchant('revoke');
    const storeId = await mintStore(owner, 'revoke');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });

    const request = await openLinkageRequest({
      claimId,
      claimantOxyUserId: owner,
      mode: 'link_existing',
      storeId,
      reason: REASON,
    });
    const applied = await applyLinkageRequest({ requestId: request.id, actorOxyUserId: owner });

    const [storeBefore] = await db.select().from(stores).where(eq(stores.id, storeId));
    const [merchantBefore] = await db.select().from(merchants).where(eq(merchants.id, merchantId));

    const { revokedLinkId } = await unlinkOnClaimRevocation({
      merchantId,
      operatorOxyUserId: `operator-${RUN}`,
      reason: 'the operator withdrew the verification',
    });
    expect(revokedLinkId).toBe(applied.nativeStoreLinkId);

    // The native store is untouched — acceptance 5, and the reason revocation
    // is an unlink rather than a deletion.
    const [storeAfter] = await db.select().from(stores).where(eq(stores.id, storeId));
    expect(storeAfter).toEqual(storeBefore);

    // The public merchant is untouched too.
    const [merchantAfter] = await db.select().from(merchants).where(eq(merchants.id, merchantId));
    expect(merchantAfter).toEqual(merchantBefore);

    // Acceptance 6: the link row SURVIVES as the audit record, with its actor,
    // its time and its reason. Revoking is not deleting.
    const [link] = await db
      .select()
      .from(nativeStoreLinks)
      .where(eq(nativeStoreLinks.id, revokedLinkId ?? ''));
    expect(link?.status).toBe('revoked');
    expect(link?.revokedByOxyUserId).toBe(`operator-${RUN}`);
    expect(link?.revokedAt).not.toBeNull();
    expect(link?.revokeReason).toContain('claim revoked');
    // The original verification facts are intact — a revocation rewrites no
    // history.
    expect(link?.verificationMethod).toBe('owner_authentication');
    expect(link?.verifiedByOxyUserId).toBe(owner);

    // And the applied linkage REQUEST survives too, with its impact preview.
    const [requestAfter] = await db
      .select()
      .from(storeLinkageRequests)
      .where(eq(storeLinkageRequests.id, request.id));
    expect(requestAfter?.state).toBe('applied');
  });

  it('unlinking a merchant with no link is a no-op, not an error', async () => {
    const merchantId = await mintMerchant('nolink');
    expect(
      await unlinkOnClaimRevocation({
        merchantId,
        operatorOxyUserId: `operator-${RUN}`,
        reason: 'nothing to remove, and that is a normal outcome',
      }),
    ).toEqual({ revokedLinkId: null });
  });
});

describe('case 7 — a mistaken link is correctable, with a stored impact preview', () => {
  it('opens a correction carrying the counts, and applying it moves the link', async () => {
    const owner = `owner-correct-${RUN}`;
    const wrongMerchantId = await mintMerchant('correct-wrong');
    const rightMerchantId = await mintMerchant('correct-right');
    const storeId = await mintStore(owner, 'correct');
    const claimId = await mintVerifiedClaim({
      merchantId: wrongMerchantId,
      claimantOxyUserId: owner,
    });

    const original = await openLinkageRequest({
      claimId,
      claimantOxyUserId: owner,
      mode: 'link_existing',
      storeId,
      reason: REASON,
    });
    const applied = await applyLinkageRequest({ requestId: original.id, actorOxyUserId: owner });

    const correction = await openLinkageCorrection({
      storeId,
      intendedMerchantId: rightMerchantId,
      reason: 'this store was linked to the wrong canonical merchant',
      operatorOxyUserId: `operator-${RUN}`,
    });
    expect(correction.mode).toBe('correct_link');
    expect(correction.supersedesLinkId).toBe(applied.nativeStoreLinkId);

    // Issue revocation rule 5: the impact preview is on the RECORD, not on a
    // screen somebody looked at. The store has one member and no orders, and
    // those are the counts stored.
    expect(correction.impactStoreMembers).toBe(1);
    expect(correction.impactPlacedOrders).toBe(0);

    const corrected = await applyLinkageRequest({
      requestId: correction.id,
      actorOxyUserId: `operator-${RUN}`,
    });
    expect(corrected.state).toBe('applied');

    // The store now resolves to the RIGHT merchant…
    expect((await findActiveLinkByStore(db, storeId))?.merchantId).toBe(rightMerchantId);
    // …the wrong link survives as history (acceptance 6)…
    const [wrongLink] = await db
      .select()
      .from(nativeStoreLinks)
      .where(eq(nativeStoreLinks.id, applied.nativeStoreLinkId ?? ''));
    expect(wrongLink?.status).toBe('revoked');
    // …and the STORE's handle and orders never moved (revocation rule 3).
    const [store] = await db.select().from(stores).where(eq(stores.id, storeId));
    expect(store?.id).toBe(storeId);
  });

  it('a store can be corrected MORE THAN ONCE, because the key names the link it ends', async () => {
    // The bug the four-column key exists to prevent: keyed on (claim, mode,
    // store) alone, an applied correction would hold the key forever and a
    // second correction would silently converge on it.
    const owner = `owner-twice-${RUN}`;
    const merchantA = await mintMerchant('twice-a');
    const merchantB = await mintMerchant('twice-b');
    const merchantC = await mintMerchant('twice-c');
    const storeId = await mintStore(owner, 'twice');
    const claimId = await mintVerifiedClaim({ merchantId: merchantA, claimantOxyUserId: owner });

    const first = await openLinkageRequest({
      claimId,
      claimantOxyUserId: owner,
      mode: 'link_existing',
      storeId,
      reason: REASON,
    });
    await applyLinkageRequest({ requestId: first.id, actorOxyUserId: owner });

    const correctionOne = await openLinkageCorrection({
      storeId,
      intendedMerchantId: merchantB,
      reason: 'the first correction, which was also wrong',
      operatorOxyUserId: `operator-${RUN}`,
    });
    await applyLinkageRequest({ requestId: correctionOne.id, actorOxyUserId: `operator-${RUN}` });

    const correctionTwo = await openLinkageCorrection({
      storeId,
      intendedMerchantId: merchantC,
      reason: 'the second correction, which finally names the right merchant',
      operatorOxyUserId: `operator-${RUN}`,
    });
    expect(correctionTwo.id).not.toBe(correctionOne.id);
    expect(correctionTwo.supersedesLinkId).not.toBe(correctionOne.supersedesLinkId);

    await applyLinkageRequest({ requestId: correctionTwo.id, actorOxyUserId: `operator-${RUN}` });
    expect((await findActiveLinkByStore(db, storeId))?.merchantId).toBe(merchantC);
  });
});

// ── The schema's own refusals ───────────────────────────────────────────────

describe('the schema refuses states the workflow must never reach', () => {
  it('an opening request cannot claim to supersede a link', async () => {
    const owner = `owner-check1-${RUN}`;
    const merchantId = await mintMerchant('check1');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });
    const storeId = await mintStore(owner, 'check1');
    const link = await linkNativeStore({
      merchantId,
      storeId,
      method: 'operator',
      reason: 'a link for the CHECK below to try to supersede illegitimately',
      actorOxyUserId: owner,
    });

    await expect(
      db.insert(storeLinkageRequests).values({
        merchantId,
        claimId,
        claimantOxyUserId: owner,
        mode: 'create_store',
        supersedesLinkId: link.id,
        reason: REASON,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isCheckViolation(error, 'store_linkage_requests_supersedes_check'),
    );
  });

  it('a `create_store` request cannot name a store, and `link_existing` must', async () => {
    const owner = `owner-check2-${RUN}`;
    const merchantId = await mintMerchant('check2');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });
    const storeId = await mintStore(owner, 'check2');

    await expect(
      db.insert(storeLinkageRequests).values({
        merchantId,
        claimId,
        claimantOxyUserId: owner,
        mode: 'create_store',
        requestedStoreId: storeId,
        reason: REASON,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isCheckViolation(error, 'store_linkage_requests_requested_store_check'),
    );

    await expect(
      db.insert(storeLinkageRequests).values({
        merchantId,
        claimId,
        claimantOxyUserId: owner,
        mode: 'link_existing',
        reason: REASON,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isCheckViolation(error, 'store_linkage_requests_requested_store_check'),
    );
  });

  it('a `blocked` request must carry a reason, and a live one must not', async () => {
    const owner = `owner-check3-${RUN}`;
    const merchantId = await mintMerchant('check3');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });

    await expect(
      db.insert(storeLinkageRequests).values({
        merchantId,
        claimId,
        claimantOxyUserId: owner,
        mode: 'create_store',
        state: 'blocked',
        reason: REASON,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isCheckViolation(error, 'store_linkage_requests_blocked_state_check'),
    );

    await expect(
      db.insert(storeLinkageRequests).values({
        merchantId,
        claimId,
        claimantOxyUserId: owner,
        mode: 'create_store',
        state: 'draft',
        blockReason: 'multiple_candidates',
        reason: REASON,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isCheckViolation(error, 'store_linkage_requests_blocked_state_check'),
    );
  });

  it('an `applied` request must name its store, its time and its completed step', async () => {
    const owner = `owner-check4-${RUN}`;
    const merchantId = await mintMerchant('check4');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });
    const storeId = await mintStore(owner, 'check4');
    const link = await linkNativeStore({
      merchantId,
      storeId,
      method: 'operator',
      reason: 'a link so the unlink fixture below has something to supersede',
      actorOxyUserId: owner,
    });

    /**
     * `unlink` rather than `create_store`, and that choice is the assertion.
     *
     * A `create_store` row with `state = 'applied'` and no store violates BOTH
     * `applied_state_check` and `applied_link_check`, and Postgres reports
     * whichever it evaluates first — so naming one of them would be a test that
     * passes or fails on constraint ordering rather than on the rule it means.
     * `unlink` is the one applied mode that legitimately produces no link, so
     * `applied_link_check` is satisfied and only the store/time/step rule can
     * fire.
     */
    await expect(
      db.insert(storeLinkageRequests).values({
        merchantId,
        claimId,
        claimantOxyUserId: owner,
        mode: 'unlink',
        requestedStoreId: storeId,
        supersedesLinkId: link.id,
        state: 'applied',
        reason: REASON,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isCheckViolation(error, 'store_linkage_requests_applied_state_check'),
    );

    // And the other half, isolated the same way: an applied LINKING mode with a
    // store but no link row violates `applied_link_check` alone.
    await expect(
      db.insert(storeLinkageRequests).values({
        merchantId,
        claimId,
        claimantOxyUserId: owner,
        mode: 'link_existing',
        requestedStoreId: storeId,
        resolvedStoreId: storeId,
        state: 'applied',
        step: 'completed',
        appliedAt: new Date(),
        reason: REASON,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isCheckViolation(error, 'store_linkage_requests_applied_link_check'),
    );
  });
});

describe('the two triggers, which a CHECK cannot express', () => {
  it('refuses to edit the columns the idempotency key is generated from', async () => {
    const owner = `owner-trigger1-${RUN}`;
    const merchantId = await mintMerchant('trigger1');
    const otherMerchantId = await mintMerchant('trigger1-other');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });

    const [row] = await db
      .insert(storeLinkageRequests)
      .values({
        merchantId,
        claimId,
        claimantOxyUserId: owner,
        mode: 'create_store',
        reason: REASON,
      })
      .returning();

    // Moving `mode` would change the generated key, release the one this row is
    // holding, and admit the second `create_store` — and therefore the second
    // store, and the second follow target.
    await expectTriggerRefusal(
      db
        .update(storeLinkageRequests)
        .set({ mode: 'link_existing' })
        .where(eq(storeLinkageRequests.id, row?.id ?? '')),
      /identity is immutable/,
    );

    await expectTriggerRefusal(
      db
        .update(storeLinkageRequests)
        .set({ merchantId: otherMerchantId })
        .where(eq(storeLinkageRequests.id, row?.id ?? '')),
      /identity is immutable/,
    );
  });

  it('makes `resolved_store_id` write-once', async () => {
    const owner = `owner-trigger2-${RUN}`;
    const merchantId = await mintMerchant('trigger2');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });
    const storeA = await mintStore(owner, 'trigger2a');
    const storeB = await mintStore(owner, 'trigger2b');

    const [row] = await db
      .insert(storeLinkageRequests)
      .values({
        merchantId,
        claimId,
        claimantOxyUserId: owner,
        mode: 'create_store',
        reason: REASON,
      })
      .returning();
    const requestId = row?.id ?? '';

    const resolved = await resolveStoreForRequest(db, { requestId, storeId: storeA });
    expect(resolved?.resolvedStoreId).toBe(storeA);

    // The CAS answers "already resolved" with an empty result…
    expect(await resolveStoreForRequest(db, { requestId, storeId: storeB })).toBeUndefined();
    // …and the trigger refuses a caller who never comes through it.
    await expectTriggerRefusal(
      db
        .update(storeLinkageRequests)
        .set({ resolvedStoreId: storeB })
        .where(eq(storeLinkageRequests.id, requestId)),
      /write-once/,
    );
  });

  it('makes a profile adoption append-only, so provenance cannot be rewritten', async () => {
    const owner = `owner-trigger3-${RUN}`;
    const merchantId = await mintMerchant('trigger3');
    const claimId = await mintVerifiedClaim({ merchantId, claimantOxyUserId: owner });
    const storeId = await mintStore(owner, 'trigger3');

    const [row] = await db
      .insert(storeLinkageRequests)
      .values({
        merchantId,
        claimId,
        claimantOxyUserId: owner,
        mode: 'link_existing',
        requestedStoreId: storeId,
        reason: REASON,
      })
      .returning();

    const adoption = await recordProfileAdoption(db, {
      requestId: row?.id ?? '',
      storeId,
      field: 'name',
      previousValue: 'the store’s own name',
      adoptedValue: 'the canonical merchant’s name',
      actorOxyUserId: owner,
      at: new Date(),
    });
    expect(adoption).toBeDefined();

    await expectTriggerRefusal(
      db
        .update(storeLinkageProfileAdoptions)
        .set({ previousValue: 'a value nobody ever had' })
        .where(eq(storeLinkageProfileAdoptions.id, adoption?.id ?? '')),
      /append-only/,
    );

    await expectTriggerRefusal(
      db
        .delete(storeLinkageProfileAdoptions)
        .where(eq(storeLinkageProfileAdoptions.id, adoption?.id ?? '')),
      /append-only/,
    );

    // A REPEAT of the same adoption writes nothing at all — the (request, field)
    // unique with `DO NOTHING`, which is what makes a resumed application
    // re-apply nothing and leave one audit row rather than two.
    expect(
      await recordProfileAdoption(db, {
        requestId: row?.id ?? '',
        storeId,
        field: 'name',
        previousValue: 'something else entirely',
        adoptedValue: 'and a different value too',
        actorOxyUserId: owner,
        at: new Date(),
      }),
    ).toBeUndefined();

    const rows = await db
      .select()
      .from(storeLinkageProfileAdoptions)
      .where(eq(storeLinkageProfileAdoptions.requestId, row?.id ?? ''));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.previousValue).toBe('the store’s own name');
  });
});

// ── The diff, against real rows ─────────────────────────────────────────────

describe('the diff reads real rows and applies nothing', () => {
  it('reports both sides, the verified source facts and the impact counts', async () => {
    const owner = `owner-diff-${RUN}`;
    const merchantId = await mintMerchant('diff');
    const storeId = await mintStore(owner, 'diff');

    const [storeBefore] = await db.select().from(stores).where(eq(stores.id, storeId));
    const result = await getLinkageDiff({ storeId, merchantId });

    expect(result.storeId).toBe(storeId);
    expect(result.merchantId).toBe(merchantId);
    expect(result.fields.map((field) => field.field)).toEqual(['name', 'description']);
    expect(result.impact.storeMembers).toBe(1);
    expect(result.impact.placedOrders).toBe(0);
    expect(result.unchanged.some((entry) => entry.includes('handle'))).toBe(true);

    // Reading a diff changes nothing — it is a question, and an endpoint that
    // opened a workflow row to answer one would make browsing an act.
    const [storeAfter] = await db.select().from(stores).where(eq(stores.id, storeId));
    expect(storeAfter).toEqual(storeBefore);
    const requests = await db
      .select()
      .from(storeLinkageRequests)
      .where(eq(storeLinkageRequests.merchantId, merchantId));
    expect(requests).toEqual([]);
  });
});
