/**
 * Claiming a guest checkout group, against a REAL PostgreSQL server (#109,
 * ADR 0003 D14).
 *
 * Every property pinned here IS a database behaviour and has no mocked
 * counterpart, which is the blind spot `AGENTS.md` names: the partial unique
 * index that makes two concurrent claims produce one winner, the row lock that
 * serializes them, the compare-and-swap that stamps every sibling or none, the
 * `CREATE OR REPLACE`d trigger that refuses a value → value ownership move, the
 * four-eyes CHECK on a revocation, and the `ON CONFLICT DO NOTHING` that makes
 * a retried claim transaction queue nothing twice. A mocked `insert` accepts
 * every one of those statements, including the ones the server rejects.
 *
 * ## What this file deliberately does NOT re-test
 *
 * The REFERRAL boundary. "A claim cannot create, replace, extend or transfer an
 * attribution" is held by `guest-claim-isolation.test.ts`, which asserts the
 * claim path has no code route into the referral domain in either direction —
 * a strictly stronger statement than "these rows did not move this time" — and
 * #142's own `referral-writes.realdb.test.ts` already drives the commercial
 * case end to end ("a guest purchase and a later Oxy claim produce ONE
 * attribution and ONE conversion"). Rebuilding that fixture stack here would
 * duplicate it against a GLOBAL program namespace, which is how a shared-slot
 * flake gets introduced. What this file DOES pin is acceptance 12 from the
 * other side: order access after a claim is a function of the claim columns
 * alone, through both spellings of the rule.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres serves the whole suite and vitest runs files in
 * parallel workers. Every row created here carries a per-run tag and is deleted
 * in teardown; no assertion counts a whole table.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';

const RUN = Math.random().toString(36).slice(2, 10);
const DAY_MS = 24 * 60 * 60 * 1_000;
/**
 * The instant every fixture and every claim is judged against.
 *
 * Five minutes in the PAST rather than a fixed literal, and it is load-bearing
 * rather than tidy: the outbox dispatcher takes its own `new Date()`, so a job
 * queued with `available_at` in the future is not claimable and the eligibility
 * cases would assert against a queue that never ran — a green-looking failure
 * to measure anything. Nothing here asserts on the value itself.
 */
const NOW = new Date(Date.now() - 5 * 60_000);

let db: import('../../db/postgres.js').Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let schema: typeof import('../../db/schema/index.js');
let grantRepo: typeof import('../../db/guestPortal/grantRepository.js');
let claimRepo: typeof import('../../db/guestClaims/claimRepository.js');
let outboxRepo: typeof import('../../db/guestClaims/claimOutboxRepository.js');
let tokens: typeof import('../guest-portal/grant-token.js');
let claimSvc: typeof import('../guest-claims/claim.service.js');
let revocationSvc: typeof import('../guest-claims/revocation.service.js');
let outboxSvc: typeof import('../guest-claims/claim-outbox.service.js');
let operatorSvc: typeof import('../guest-claims/operator.service.js');
let orderRepo: typeof import('../../db/orders/orderRepository.js');
let access: typeof import('../orders/order-access.service.js');

const createdGroupIds: string[] = [];
const createdOrderIds: string[] = [];
const createdSessionIds: string[] = [];

/** The five columns `orders` insists on, plus whatever the case is about. */
function orderValues(overrides: Record<string, unknown>): Record<string, unknown> {
  const dual = (prefix: string) => ({
    [`${prefix}ShopAmount`]: 0,
    [`${prefix}ShopCurrency`]: 'FAIR',
    [`${prefix}PresentmentAmount`]: 0,
    [`${prefix}PresentmentCurrency`]: 'FAIR',
  });
  return {
    orderNumber: `MRC-K${RUN}-${Math.floor(Math.random() * 1_000_000)}`,
    status: 'paid',
    sellerType: 'user',
    sellerOxyUserId: `seller-${RUN}`,
    shippingAddressRecipientName: 'Jane',
    shippingAddressLine1: 'Street 1',
    shippingAddressCity: 'Valencia',
    shippingAddressPostalCode: '46004',
    shippingAddressCountry: 'ES',
    shippingMethod: 'standard',
    shippingLabel: 'Standard shipping',
    ...dual('shippingCost'),
    ...dual('totalsSubtotal'),
    ...dual('totalsDiscountTotal'),
    ...dual('totalsShipping'),
    ...dual('totalsTax'),
    ...dual('totalsGrandTotal'),
    ...overrides,
  };
}

/** A guest checkout group with `orderCount` sibling orders, each with one line. */
async function makeGuestGroup(
  orderCount = 2,
  options: { guestSessionId?: string } = {},
): Promise<{
  checkoutGroupId: string;
  guestCheckoutId: string;
  guestSessionId: string;
  orderIds: string[];
}> {
  const checkoutGroupId = uuidv7();
  createdGroupIds.push(checkoutGroupId);
  const guestSessionId = options.guestSessionId ?? `gs-${RUN}-${checkoutGroupId.slice(0, 8)}`;

  const [contact] = await db
    .insert(schema.guestCheckouts)
    .values({
      checkoutGroupId,
      guestSessionId,
      emailCiphertext: `v1:iv:tag:ct-${RUN}`,
      emailHash: `hash-${RUN}-${checkoutGroupId.slice(0, 8)}`,
      emailRedacted: 'j***@example.com',
      marketingOptIn: false,
    })
    .returning({ id: schema.guestCheckouts.id });

  const orderIds: string[] = [];
  for (let index = 0; index < orderCount; index += 1) {
    const [order] = await db
      .insert(schema.orders)
      .values(
        orderValues({
          checkoutGroupId,
          buyerOrigin: 'guest',
          buyerGuestCheckoutId: contact.id,
          sellerOxyUserId: `seller-${RUN}-${index}`,
        }) as never,
      )
      .returning({ id: schema.orders.id });
    createdOrderIds.push(order.id);
    orderIds.push(order.id);
    await db.insert(schema.orderItems).values({
      orderId: order.id,
      listingId: `listing-${RUN}-${index}`,
      variantId: `variant-${RUN}-${index}`,
      title: 'A thing',
      variantTitle: 'Default',
      quantity: 1,
      unitPriceShopAmount: 0,
      unitPriceShopCurrency: 'FAIR',
      unitPricePresentmentAmount: 0,
      unitPricePresentmentCurrency: 'FAIR',
      lineTotalShopAmount: 0,
      lineTotalShopCurrency: 'FAIR',
      lineTotalPresentmentAmount: 0,
      lineTotalPresentmentCurrency: 'FAIR',
      discountTotalShopAmount: 0,
      discountTotalShopCurrency: 'FAIR',
      discountTotalPresentmentAmount: 0,
      discountTotalPresentmentCurrency: 'FAIR',
    } as never);
  }

  return { checkoutGroupId, guestCheckoutId: contact.id, guestSessionId, orderIds };
}

/** A live guest cart session, so the claim's #104 merge has something to converge on. */
async function makeGuestSession(): Promise<string> {
  const [row] = await db
    .insert(schema.guestSessions)
    .values({
      tokenHash: `sess-${RUN}-${Math.random().toString(36).slice(2, 12)}`,
      clientClass: 'web',
      lastSeenAt: NOW,
      expiresAt: new Date(NOW.getTime() + 90 * DAY_MS),
    })
    .returning({ id: schema.guestSessions.id });
  createdSessionIds.push(row.id);
  return row.id;
}

/** A live portal grant over a group, verified and `claim:write` by default. */
async function makeGrant(
  group: { checkoutGroupId: string; guestCheckoutId: string },
  overrides: Record<string, unknown> = {},
): Promise<import('../../db/guestPortal/grantRepository.js').GuestOrderAccessGrantRow> {
  const expiresAt = new Date(NOW.getTime() + 30 * DAY_MS);
  return await grantRepo.insertGuestOrderAccessGrant(db, {
    checkoutGroupId: group.checkoutGroupId,
    guestCheckoutId: group.guestCheckoutId,
    tokenHash: tokens.hashPortalToken(tokens.mintPortalToken().token),
    purpose: 'portal',
    createdVia: 'magic_link',
    scopes: ['orders:read', 'claim:write'],
    emailVerifiedAt: NOW,
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + 90 * DAY_MS),
    ...overrides,
  } as Parameters<typeof grantRepo.insertGuestOrderAccessGrant>[1]);
}

/**
 * Assert a rejection whose text names a constraint or a trigger.
 *
 * drizzle wraps the driver error: the outer message is `Failed query: …` and
 * the constraint name lives on `cause`. Matching only the outer message would
 * pass for ANY failed statement — the vacuous shape `~/Oxy/AGENTS.md` (C)
 * warns about.
 */
async function expectPgRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (err) {
    failure = err;
  }
  expect(failure, `expected a rejection matching ${String(pattern)}`).toBeDefined();
  const cause = (failure as { cause?: { message?: string; constraint_name?: string } }).cause;
  const text = [
    (failure as Error).message,
    cause?.message ?? '',
    cause?.constraint_name ?? '',
  ].join(' ');
  expect(text).toMatch(pattern);
}

beforeAll(async () => {
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.GUEST_EMAIL_HASH_KEY = 'b'.repeat(64);
  process.env.GUEST_MAGIC_LINK_BASE_URL = 'https://mercaria.co/guest-orders/portal';

  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  schema = await import('../../db/schema/index.js');
  grantRepo = await import('../../db/guestPortal/grantRepository.js');
  claimRepo = await import('../../db/guestClaims/claimRepository.js');
  outboxRepo = await import('../../db/guestClaims/claimOutboxRepository.js');
  tokens = await import('../guest-portal/grant-token.js');
  claimSvc = await import('../guest-claims/claim.service.js');
  revocationSvc = await import('../guest-claims/revocation.service.js');
  outboxSvc = await import('../guest-claims/claim-outbox.service.js');
  operatorSvc = await import('../guest-claims/operator.service.js');
  orderRepo = await import('../../db/orders/orderRepository.js');
  access = await import('../orders/order-access.service.js');
}, 120_000);

afterEach(async () => {
  const groupIds = createdGroupIds.splice(0);
  const orderIds = createdOrderIds.splice(0);
  const sessionIds = createdSessionIds.splice(0);

  if (groupIds.length > 0) {
    // Children before parents, and by the GROUP rather than by tracked ids: the
    // claim mints rows inside the service, so a case cannot always name every
    // row it caused.
    await db
      .delete(schema.guestOrderClaimOutbox)
      .where(inArray(schema.guestOrderClaimOutbox.checkoutGroupId, groupIds));
    const claims = await db
      .select({ id: schema.guestOrderClaims.id })
      .from(schema.guestOrderClaims)
      .where(inArray(schema.guestOrderClaims.checkoutGroupId, groupIds));
    if (claims.length > 0) {
      await db.delete(schema.guestOrderClaimRevocations).where(
        inArray(
          schema.guestOrderClaimRevocations.claimId,
          claims.map((row) => row.id),
        ),
      );
      await db
        .delete(schema.guestOrderClaims)
        .where(inArray(schema.guestOrderClaims.checkoutGroupId, groupIds));
    }
    await db
      .delete(schema.guestPortalMessages)
      .where(inArray(schema.guestPortalMessages.checkoutGroupId, groupIds));
    await db
      .delete(schema.guestOrderAccessGrants)
      .where(inArray(schema.guestOrderAccessGrants.checkoutGroupId, groupIds));
  }
  if (orderIds.length > 0) {
    await db
      .delete(schema.reviewEligibilities)
      .where(inArray(schema.reviewEligibilities.orderId, orderIds));
    await db.delete(schema.orders).where(inArray(schema.orders.id, orderIds));
  }
  if (groupIds.length > 0) {
    await db
      .delete(schema.guestCheckouts)
      .where(inArray(schema.guestCheckouts.checkoutGroupId, groupIds));
  }
  if (sessionIds.length > 0) {
    // `cart_merges` is deliberately NOT deleted: a trigger refuses DELETE on it
    // (#104's append-only merge audit), and its rows are keyed on a per-run
    // session id that no other file can collide with. Trying to clean it would
    // fail the teardown for every case in this file.
    await db.delete(schema.guestSessions).where(inArray(schema.guestSessions.id, sessionIds));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('a claim is group-atomic and idempotent (acceptance 4 and 12)', () => {
  it('stamps EVERY sibling, records one claim, revokes the group’s credentials', async () => {
    const group = await makeGuestGroup(3);
    const grant = await makeGrant(group);

    const outcome = await claimSvc.claimGuestCheckoutGroup({
      grant,
      oxyUserId: `owner-${RUN}`,
      now: NOW,
    });

    expect(outcome.status).toBe('claimed');
    if (outcome.status !== 'claimed') return;
    expect(outcome.result.alreadyClaimed).toBe(false);
    expect(outcome.result.claim.orderCount).toBe(3);
    expect(outcome.result.portalAccessRevoked).toBe(true);

    const orders = await orderRepo.findOrdersInCheckoutGroup(group.checkoutGroupId, db);
    expect(orders).toHaveLength(3);
    for (const order of orders) {
      expect(order.claimedByOxyUserId).toBe(`owner-${RUN}`);
      expect(order.claimedAt).not.toBeNull();
      // I7: the ORIGIN never moves. A claim is a second owner, not a rewrite.
      expect(order.buyerOrigin).toBe('guest');
      expect(order.buyerOxyUserId).toBeNull();
    }

    // The credential that authorized the claim is revoked WITH the rest: after
    // a claim, order access is the Oxy account and not the emailed link (D14).
    const live = await grantRepo.grantIsStillLive(db, grant.id, NOW);
    expect(live).toBe(false);

    // Both durable follow-up jobs, committed with the claim.
    const jobs = await outboxRepo.listGuestClaimJobsForGroup(db, group.checkoutGroupId, 10);
    expect(jobs.map((job) => job.type).sort()).toEqual([
      'claim_notification',
      'review_eligibility',
    ]);
  });

  it('a retry by the SAME account returns the same claim and queues nothing twice', async () => {
    const group = await makeGuestGroup(2);
    const first = await claimSvc.claimGuestCheckoutGroup({
      grant: await makeGrant(group),
      oxyUserId: `owner-${RUN}`,
      now: NOW,
    });
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') return;

    // A retry needs a FRESH credential, because the first claim revoked the one
    // it used — which is itself the D14 behaviour, and it is the fixture's
    // honest shape rather than a convenience: a real client retrying on the SAME
    // cookie is answered 401 by the MIDDLEWARE and never reaches this service.
    // What rule 12 promises is that the SERVICE converges for every request that
    // does reach it, which is exactly what this case drives.
    const second = await claimSvc.claimGuestCheckoutGroup({
      grant: await makeGrant(group),
      oxyUserId: `owner-${RUN}`,
      now: new Date(NOW.getTime() + 60_000),
    });

    expect(second.status).toBe('claimed');
    if (second.status !== 'claimed') return;
    expect(second.result.alreadyClaimed).toBe(true);
    expect(second.result.claim.id).toBe(first.result.claim.id);
    // Claim-transaction rule 12: the SAME completed result. Not a new row, and
    // not a moved timestamp on the old one.
    expect(second.result.claim.completedAt).toBe(first.result.claim.completedAt);

    const claims = await claimRepo.listClaimsForGroup(db, group.checkoutGroupId, 10);
    expect(claims).toHaveLength(1);
    const jobs = await outboxRepo.listGuestClaimJobsForGroup(db, group.checkoutGroupId, 10);
    expect(jobs).toHaveLength(2);
  });

  it('refuses a claim by a SECOND account, records the contest, and moves nothing', async () => {
    const group = await makeGuestGroup(2);
    await claimSvc.claimGuestCheckoutGroup({
      grant: await makeGrant(group),
      oxyUserId: `owner-a-${RUN}`,
      now: NOW,
    });

    const contested = await claimSvc.claimGuestCheckoutGroup({
      grant: await makeGrant(group),
      oxyUserId: `owner-b-${RUN}`,
      now: new Date(NOW.getTime() + 60_000),
    });

    expect(contested.status).toBe('refused');
    if (contested.status !== 'refused') return;
    expect(contested.refusal).toBe('claimed_by_another_account');

    // The orders did NOT move — the whole of acceptance 8.
    const orders = await orderRepo.findOrdersInCheckoutGroup(group.checkoutGroupId, db);
    for (const order of orders) {
      expect(order.claimedByOxyUserId).toBe(`owner-a-${RUN}`);
    }

    // And the contest is RECORDED, so an operator resolving a disputed
    // purchase can see that a second account presented valid proof.
    const claims = await claimRepo.listClaimsForGroup(db, group.checkoutGroupId, 10);
    expect(claims).toHaveLength(2);
    const conflicted = claims.find((row) => row.state === 'conflicted');
    expect(conflicted?.claimedByOxyUserId).toBe(`owner-b-${RUN}`);
    expect(conflicted?.conflictReason).toBe('already_claimed_by_another_account');
  });

  it('two CONCURRENT claims from two accounts produce exactly one winner', async () => {
    const group = await makeGuestGroup(2);
    const [grantA, grantB] = await Promise.all([makeGrant(group), makeGrant(group)]);

    // Genuinely concurrent: two transactions in flight on two pool connections.
    const [a, b] = await Promise.all([
      claimSvc.claimGuestCheckoutGroup({ grant: grantA, oxyUserId: `race-a-${RUN}`, now: NOW }),
      claimSvc.claimGuestCheckoutGroup({ grant: grantB, oxyUserId: `race-b-${RUN}`, now: NOW }),
    ]);

    const claimed = [a, b].filter((outcome) => outcome.status === 'claimed');
    const refused = [a, b].filter((outcome) => outcome.status === 'refused');
    expect(claimed).toHaveLength(1);
    expect(refused).toHaveLength(1);

    const completed = await claimRepo.findActiveClaimForGroup(db, group.checkoutGroupId);
    expect(completed).not.toBeNull();
    const orders = await orderRepo.findOrdersInCheckoutGroup(group.checkoutGroupId, db);
    const owners = new Set(orders.map((order) => order.claimedByOxyUserId));
    // One owner across every sibling: a group can never be split (D14).
    expect(owners.size).toBe(1);
    expect([...owners][0]).toBe(completed?.claimedByOxyUserId);

    /**
     * And the loser's contest is RECORDED — which is what the row lock buys.
     *
     * Worth stating precisely, because it was mutation-tested rather than
     * assumed: removing `FOR UPDATE` from `findGuestCheckoutByGroupForUpdate`
     * leaves the OWNERSHIP outcome correct (the partial unique index refuses
     * the second `completed` row and the loser refuses without stamping
     * anything), and it loses this row — both racers read "unclaimed", so the
     * loser never sees a claim to record a contest against and fails at the
     * insert instead. The lock is therefore load-bearing for the AUDIT rather
     * than for the ownership, and this assertion is the only thing that
     * notices.
     */
    const claims = await claimRepo.listClaimsForGroup(db, group.checkoutGroupId, 10);
    expect(claims.filter((row) => row.state === 'completed')).toHaveLength(1);
    expect(claims.filter((row) => row.state === 'conflicted')).toHaveLength(1);
  });
});

describe('the two proofs, and what each one alone cannot do', () => {
  it('refuses a credential with no `claim:write` scope', async () => {
    const group = await makeGuestGroup(1);
    const grant = await makeGrant(group, { scopes: ['orders:read'] });

    const outcome = await claimSvc.claimGuestCheckoutGroup({
      grant,
      oxyUserId: `owner-${RUN}`,
      now: NOW,
    });
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.refusal).toBe('claim_scope_missing');
    expect(await claimRepo.findActiveClaimForGroup(db, group.checkoutGroupId)).toBeNull();
  });

  it('refuses an UNVERIFIED credential — a device is not a person (D17)', async () => {
    const group = await makeGuestGroup(1);
    // The database refuses `claim:write` on an unverified row outright, so the
    // only unverified credential that exists is a `post_checkout` one — which
    // is the point: paying cannot produce a claimable credential in any code
    // path.
    await expectPgRejection(
      makeGrant(group, {
        createdVia: 'post_checkout',
        emailVerifiedAt: null,
        scopes: ['claim:write'],
      }),
      /guest_order_access_grants_unverified_scope_check/,
    );

    const grant = await makeGrant(group, {
      createdVia: 'post_checkout',
      emailVerifiedAt: null,
      scopes: ['tracking:read'],
    });
    const outcome = await claimSvc.claimGuestCheckoutGroup({
      grant,
      oxyUserId: `owner-${RUN}`,
      now: NOW,
    });
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.refusal).toBe('claim_scope_missing');
  });

  it('refuses a credential REVOKED between the request and the commit (conflict case 4)', async () => {
    const group = await makeGuestGroup(1);
    const grant = await makeGrant(group);
    // The middleware resolved it; a second device then pressed "secure my
    // access". The transaction's revalidation is what catches it.
    await grantRepo.revokeGrant(db, grant.id, NOW);

    const outcome = await claimSvc.claimGuestCheckoutGroup({
      grant,
      oxyUserId: `owner-${RUN}`,
      now: NOW,
    });
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.refusal).toBe('access_revoked');
    expect(await claimRepo.findActiveClaimForGroup(db, group.checkoutGroupId)).toBeNull();
  });
});

describe('order ACCESS follows the claim, through both spellings of the rule', () => {
  it('grants the claimant and refuses everybody else, in the decision AND the list', async () => {
    const group = await makeGuestGroup(2);
    await claimSvc.claimGuestCheckoutGroup({
      grant: await makeGrant(group),
      oxyUserId: `owner-${RUN}`,
      now: NOW,
    });

    const orders = await orderRepo.findOrdersInCheckoutGroup(group.checkoutGroupId, db);
    const claimant = { kind: 'oxy_account' as const, oxyUserId: `owner-${RUN}` };
    const stranger = { kind: 'oxy_account' as const, oxyUserId: `stranger-${RUN}` };

    for (const order of orders) {
      const facts = access.orderAccessFactsFromRecord(order);
      expect(access.authorizeOrderAccess(claimant, facts, NOW)).toEqual({
        allowed: true,
        reason: 'claiming_oxy_account',
      });
      expect(access.authorizeOrderAccess(stranger, facts, NOW).allowed).toBe(false);
    }

    // The SQL spelling. Two representations of one rule can disagree, which is
    // why #106 drives both — and #109 is the first change that makes the second
    // one return anything at all.
    const listed = await orderRepo.findOrders(
      { buyerOrClaimantOxyUserId: `owner-${RUN}` },
      db,
    );
    const listedIds = listed.map((order) => order.id).sort();
    expect(listedIds).toEqual([...group.orderIds].sort());

    // …and "which orders did this account PLACE" stays empty, which is the
    // distinction `OrderListFilter` keeps two fields for: a claimed guest order
    // was not placed by the claimant.
    const placed = await orderRepo.findOrders({ buyerOxyUserId: `owner-${RUN}` }, db);
    expect(placed.filter((order) => group.orderIds.includes(order.id))).toHaveLength(0);
  });
});

describe('the guest cart merges exactly once (acceptance 6)', () => {
  it('runs #104’s merge on the presented session and converges on a retry', async () => {
    const sessionId = await makeGuestSession();
    const group = await makeGuestGroup(1, { guestSessionId: sessionId });

    const first = await claimSvc.claimGuestCheckoutGroup({
      grant: await makeGrant(group),
      oxyUserId: `owner-${RUN}`,
      presentedGuestSessionId: sessionId,
      now: NOW,
    });
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') return;
    expect(first.result.cartMerge?.merged).toBe(true);

    const second = await claimSvc.claimGuestCheckoutGroup({
      grant: await makeGrant(group),
      oxyUserId: `owner-${RUN}`,
      presentedGuestSessionId: sessionId,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(second.status).toBe('claimed');
    if (second.status !== 'claimed') return;
    // The merge CONVERGED rather than running again — `merged: false` plus
    // exactly one `cart_merges` row is what exactly-once looks like here.
    expect(second.result.cartMerge?.merged).toBe(false);

    const merges = await db
      .select({ id: schema.cartMerges.id })
      .from(schema.cartMerges)
      .where(eq(schema.cartMerges.guestSessionId, sessionId));
    expect(merges).toHaveLength(1);

    // And the session is converted AND revoked together — ADR 0003 D3's
    // "sign-in revokes a guest session rather than upgrading it".
    const [session] = await db
      .select({
        convertedAt: schema.guestSessions.convertedAt,
        revokedAt: schema.guestSessions.revokedAt,
      })
      .from(schema.guestSessions)
      .where(eq(schema.guestSessions.id, sessionId));
    expect(session.convertedAt).not.toBeNull();
    expect(session.revokedAt).not.toBeNull();
  });
});

describe('the durable follow-up work (acceptance 9, conflict case 11)', () => {
  it('grants verified-purchase eligibility ONCE, however often the job runs', async () => {
    const group = await makeGuestGroup(1);
    await claimSvc.claimGuestCheckoutGroup({
      grant: await makeGrant(group),
      oxyUserId: `owner-${RUN}`,
      now: NOW,
    });

    await outboxSvc.dispatchGuestClaimJobs();

    const granted = await db
      .select({
        id: schema.reviewEligibilities.id,
        scope: schema.reviewEligibilities.scope,
        evidenceType: schema.reviewEligibilities.evidenceType,
        oxyUserId: schema.reviewEligibilities.oxyUserId,
        claimId: schema.reviewEligibilities.claimId,
      })
      .from(schema.reviewEligibilities)
      .where(inArray(schema.reviewEligibilities.orderId, group.orderIds));

    // One line on a P2P order resolves to `native_transaction` and
    // `p2p_seller`; the canonical product and the listing are absent in this
    // fixture, and #76 skips those scopes silently rather than refusing the
    // whole grant.
    expect(granted.map((row) => row.scope).sort()).toEqual([
      'native_transaction',
      'p2p_seller',
    ]);
    for (const row of granted) {
      // The CLAIMED evidence type and a claim id, never `authenticated_purchase`
      // — losing that distinction would record a guest purchase as an account's
      // own.
      expect(row.evidenceType).toBe('claimed_guest_purchase');
      expect(row.claimId).not.toBeNull();
      expect(row.oxyUserId).toBe(`owner-${RUN}`);
    }

    // A second pass over a re-queued job creates nothing new: the unique index
    // on (order_item_id, oxy_user_id, scope) converges.
    await db
      .update(schema.guestOrderClaimOutbox)
      .set({ state: 'pending', completedAt: null, availableAt: new Date(0) })
      .where(
        and(
          eq(schema.guestOrderClaimOutbox.checkoutGroupId, group.checkoutGroupId),
          eq(schema.guestOrderClaimOutbox.type, 'review_eligibility'),
        ),
      );
    await outboxSvc.dispatchGuestClaimJobs();

    const after = await db
      .select({ id: schema.reviewEligibilities.id })
      .from(schema.reviewEligibilities)
      .where(inArray(schema.reviewEligibilities.orderId, group.orderIds));
    expect(after).toHaveLength(granted.length);
  });

  it('a failed job retries and is reclaimable rather than lost (conflict case 11)', async () => {
    const group = await makeGuestGroup(1);
    await claimSvc.claimGuestCheckoutGroup({
      grant: await makeGrant(group),
      oxyUserId: `owner-${RUN}`,
      now: NOW,
    });

    // A claim instant strictly AFTER the enqueue: the claimable predicate is
    // `available_at < now`, so passing the enqueue instant itself claims
    // nothing and the case would assert against an empty queue.
    const claimAt = new Date(NOW.getTime() + 60_000);
    const [job] = await outboxRepo.claimGuestClaimJobs(db, {
      owner: 'worker-a',
      now: claimAt,
      leaseUntil: new Date(claimAt.getTime() + 60_000),
      limit: 1,
    });
    expect(job).toBeDefined();

    // The OWNER guard: a worker whose lease expired cannot report on a row the
    // new owner holds.
    expect(
      await outboxRepo.markGuestClaimJobCompleted(db, {
        id: job.id,
        owner: 'worker-b',
        now: NOW,
      }),
    ).toBe(false);

    await outboxRepo.markGuestClaimJobFailed(db, {
      id: job.id,
      owner: 'worker-a',
      error: 'downstream projection failed',
      nextState: 'pending',
      availableAt: new Date(0),
    });

    // Both of the claim's jobs are due, so this claims the pair and picks the
    // one under test out of it rather than assuming an order — the outbox
    // claims oldest-first and the two were enqueued in the same statement, so
    // asserting on a `[0]` would be asserting on a tie-break.
    const reclaimed = await outboxRepo.claimGuestClaimJobs(db, {
      owner: 'worker-c',
      now: new Date(NOW.getTime() + 120_000),
      leaseUntil: new Date(NOW.getTime() + 180_000),
      limit: 5,
    });
    const again = reclaimed.find((row) => row.id === job.id);
    expect(again, 'the failed job was not reclaimable').toBeDefined();
    expect(again?.attempts).toBe(1);
    expect(again?.lastError).toBe('downstream projection failed');
  });
});

describe('revocation: the audited compensating operation', () => {
  it('needs a SECOND operator, and the database refuses a self-approval outright', async () => {
    const group = await makeGuestGroup(2);
    const claimed = await claimSvc.claimGuestCheckoutGroup({
      grant: await makeGrant(group),
      oxyUserId: `owner-${RUN}`,
      now: NOW,
    });
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') return;

    const requested = await revocationSvc.requestClaimRevocation({
      claimId: claimed.result.claim.id,
      reason: 'wrong_account',
      evidenceRef: `CASE-${RUN}`,
      requestedByOxyUserId: `operator-a-${RUN}`,
    });
    expect(requested.status).toBe('ok');
    if (requested.status !== 'ok') return;
    expect(requested.value.fourEyesRequired).toBe(true);

    // The service refuses a self-approval…
    const self = await revocationSvc.approveClaimRevocation({
      revocationId: requested.value.id,
      approvedByOxyUserId: `operator-a-${RUN}`,
      now: NOW,
    });
    expect(self.status).toBe('refused');
    if (self.status !== 'refused') return;
    expect(self.refusal).toBe('approver_is_requester');

    // …and so does the DATABASE, which is what makes it hold when a future
    // path forgets the comparison.
    await expectPgRejection(
      db
        .update(schema.guestOrderClaimRevocations)
        .set({ approvedByOxyUserId: `operator-a-${RUN}` })
        .where(eq(schema.guestOrderClaimRevocations.id, requested.value.id)),
      /guest_order_claim_revocations_four_eyes_check/,
    );

    // A SECOND operator executes it, and the orders come back to the guest.
    const approved = await revocationSvc.approveClaimRevocation({
      revocationId: requested.value.id,
      approvedByOxyUserId: `operator-b-${RUN}`,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(approved.status).toBe('ok');
    if (approved.status !== 'ok') return;
    expect(approved.value.detachedOrderIds).toHaveLength(2);

    const orders = await orderRepo.findOrdersInCheckoutGroup(group.checkoutGroupId, db);
    for (const order of orders) {
      expect(order.claimedByOxyUserId).toBeNull();
      expect(order.claimedAt).toBeNull();
      // Revocation rule 7: the ORIGIN and every prior claim event survive.
      expect(order.buyerOrigin).toBe('guest');
    }

    // The claim row keeps its history and moves to `revoked`.
    const claims = await claimRepo.listClaimsForGroup(db, group.checkoutGroupId, 10);
    const revoked = claims.find((row) => row.id === claimed.result.claim.id);
    expect(revoked?.state).toBe('revoked');
    expect(revoked?.completedAt).not.toBeNull();
    expect(revoked?.revokedByOxyUserId).toBe(`operator-b-${RUN}`);
    expect(revoked?.revocationReason).toBe('wrong_account');

    // Access follows immediately, with no sweep and no second flag.
    for (const order of orders) {
      const decision = access.authorizeOrderAccess(
        { kind: 'oxy_account', oxyUserId: `owner-${RUN}` },
        access.orderAccessFactsFromRecord(order),
        NOW,
      );
      expect(decision).toEqual({ allowed: false, reason: 'order_unclaimed' });
    }
  });

  it('allows only ONE open request per claim, so two operators converge', async () => {
    const group = await makeGuestGroup(1);
    const claimed = await claimSvc.claimGuestCheckoutGroup({
      grant: await makeGrant(group),
      oxyUserId: `owner-${RUN}`,
      now: NOW,
    });
    if (claimed.status !== 'claimed') throw new Error('fixture claim failed');

    const first = await revocationSvc.requestClaimRevocation({
      claimId: claimed.result.claim.id,
      reason: 'buyer_request',
      evidenceRef: `CASE-${RUN}-1`,
      requestedByOxyUserId: `operator-a-${RUN}`,
    });
    expect(first.status).toBe('ok');

    const second = await revocationSvc.requestClaimRevocation({
      claimId: claimed.result.claim.id,
      reason: 'wrong_account',
      evidenceRef: `CASE-${RUN}-2`,
      requestedByOxyUserId: `operator-b-${RUN}`,
    });
    expect(second.status).toBe('refused');
    if (second.status !== 'refused') return;
    expect(second.refusal).toBe('revocation_already_open');
  });

  it('after a revocation the eligibility job grants nothing', async () => {
    const group = await makeGuestGroup(1);
    const claimed = await claimSvc.claimGuestCheckoutGroup({
      grant: await makeGrant(group),
      oxyUserId: `owner-${RUN}`,
      now: NOW,
    });
    if (claimed.status !== 'claimed') throw new Error('fixture claim failed');

    const requested = await revocationSvc.requestClaimRevocation({
      claimId: claimed.result.claim.id,
      reason: 'account_compromise',
      evidenceRef: `CASE-${RUN}`,
      requestedByOxyUserId: `operator-a-${RUN}`,
    });
    if (requested.status !== 'ok') throw new Error('fixture revocation request failed');
    await revocationSvc.approveClaimRevocation({
      revocationId: requested.value.id,
      approvedByOxyUserId: `operator-b-${RUN}`,
      now: NOW,
    });

    // The job was queued BEFORE the revocation and runs after it. Two
    // independent walls stop it: this handler skips a claim that is no longer
    // `completed`, and #76's own comparison would refuse anyway because the
    // orders no longer carry the claimant.
    await outboxSvc.dispatchGuestClaimJobs();
    const granted = await db
      .select({ id: schema.reviewEligibilities.id })
      .from(schema.reviewEligibilities)
      .where(inArray(schema.reviewEligibilities.orderId, group.orderIds));
    expect(granted).toHaveLength(0);
  });
});

describe('the operator surface', () => {
  it('traces a group’s claims, revocations and jobs from the GROUP alone', async () => {
    const group = await makeGuestGroup(1);
    const claimed = await claimSvc.claimGuestCheckoutGroup({
      grant: await makeGrant(group),
      oxyUserId: `owner-${RUN}`,
      now: NOW,
    });
    if (claimed.status !== 'claimed') throw new Error('fixture claim failed');
    await revocationSvc.requestClaimRevocation({
      claimId: claimed.result.claim.id,
      reason: 'legal_or_compliance',
      evidenceRef: `CASE-${RUN}`,
      requestedByOxyUserId: `operator-a-${RUN}`,
    });

    const trace = await operatorSvc.traceGuestClaims(group.checkoutGroupId);
    expect(trace.checkoutGroupId).toBe(group.checkoutGroupId);
    expect(trace.claims).toHaveLength(1);
    expect(trace.revocations).toHaveLength(1);
    expect(trace.outbox).toHaveLength(2);
    // The projection carries no contact, no credential and no source grant.
    expect(JSON.stringify(trace)).not.toContain('hash-');
    expect(JSON.stringify(trace)).not.toContain('@example.com');
  });

  it('reports zero drift for a healthy claim', async () => {
    const group = await makeGuestGroup(2);
    await claimSvc.claimGuestCheckoutGroup({
      grant: await makeGrant(group),
      oxyUserId: `owner-${RUN}`,
      now: NOW,
    });

    const consistency = await operatorSvc.readGuestClaimConsistency();
    expect(consistency.claimOrderDrift.count).toBe(0);
    expect(consistency.unrecordedClaims.count).toBe(0);
  });

  it('SEES an order stamped without a claim row — the probe is not vacuous', async () => {
    // The mutation self-test for the consistency read: an order carrying a
    // claimant that no completed claim names is exactly what ADR 0003 I6 says
    // cannot happen, and a probe that reported zero for it would be measuring
    // nothing.
    const group = await makeGuestGroup(1);
    await db
      .update(schema.orders)
      .set({ claimedByOxyUserId: `ghost-${RUN}`, claimedAt: NOW })
      .where(eq(schema.orders.checkoutGroupId, group.checkoutGroupId));

    const consistency = await operatorSvc.readGuestClaimConsistency();
    expect(consistency.unrecordedClaims.count).toBeGreaterThan(0);
    expect(consistency.unrecordedClaims.sample).toContain(group.orderIds[0]);

    await db
      .update(schema.orders)
      .set({ claimedByOxyUserId: null, claimedAt: null })
      .where(eq(schema.orders.checkoutGroupId, group.checkoutGroupId));
  });
});

describe('the claim CHECKs, against the server that enforces them', () => {
  it('refuses a completed claim with no completion instant', async () => {
    const group = await makeGuestGroup(1);
    await expectPgRejection(
      db.insert(schema.guestOrderClaims).values({
        checkoutGroupId: group.checkoutGroupId,
        guestCheckoutId: group.guestCheckoutId,
        claimedByOxyUserId: `owner-${RUN}`,
        sourceGrantId: `grant-${RUN}`,
        state: 'completed',
        orderCount: 1,
      } as never),
      /guest_order_claims_state_shape_check/,
    );
  });

  it('refuses a conflicted claim with no reason', async () => {
    const group = await makeGuestGroup(1);
    await expectPgRejection(
      db.insert(schema.guestOrderClaims).values({
        checkoutGroupId: group.checkoutGroupId,
        guestCheckoutId: group.guestCheckoutId,
        claimedByOxyUserId: `owner-${RUN}`,
        sourceGrantId: `grant-${RUN}`,
        state: 'conflicted',
        orderCount: 1,
      } as never),
      /guest_order_claims_state_shape_check/,
    );
  });

  it('refuses a second COMPLETED claim on one group, at the index', async () => {
    const group = await makeGuestGroup(1);
    const values = {
      checkoutGroupId: group.checkoutGroupId,
      guestCheckoutId: group.guestCheckoutId,
      claimedByOxyUserId: `owner-${RUN}`,
      sourceGrantId: `grant-${RUN}`,
      state: 'completed',
      orderCount: 1,
      completedAt: NOW,
    };
    await db.insert(schema.guestOrderClaims).values(values as never);
    await expectPgRejection(
      db.insert(schema.guestOrderClaims).values({
        ...values,
        claimedByOxyUserId: `other-${RUN}`,
      } as never),
      /guest_order_claims_active_group_key/,
    );
  });

  it('permits a fresh claim once the first is REVOKED', async () => {
    // The partial index sees only `completed` rows, which is what lets a
    // corrected group be claimed again — by the rightful buyer, through the
    // ordinary proof.
    const group = await makeGuestGroup(1);
    const base = {
      checkoutGroupId: group.checkoutGroupId,
      guestCheckoutId: group.guestCheckoutId,
      sourceGrantId: `grant-${RUN}`,
      orderCount: 1,
      completedAt: NOW,
    };
    await db.insert(schema.guestOrderClaims).values({
      ...base,
      claimedByOxyUserId: `owner-a-${RUN}`,
      state: 'revoked',
      revokedAt: NOW,
      revokedByOxyUserId: `operator-${RUN}`,
      revocationReason: 'wrong_account',
    } as never);
    await db.insert(schema.guestOrderClaims).values({
      ...base,
      claimedByOxyUserId: `owner-b-${RUN}`,
      state: 'completed',
    } as never);

    const active = await claimRepo.findActiveClaimForGroup(db, group.checkoutGroupId);
    expect(active?.claimedByOxyUserId).toBe(`owner-b-${RUN}`);
  });
});
