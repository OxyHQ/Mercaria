/**
 * The buyer CLAIM and the audit ACTOR on `orders` / `order_status_history`,
 * against a REAL Postgres server (#106, ADR 0003 D6/D16).
 *
 * Everything asserted here is a DATABASE property with no mocked counterpart —
 * the blind spot `AGENTS.md` names. A widened multi-column CHECK, a
 * `CREATE OR REPLACE`d BEFORE-UPDATE trigger that must permit two transitions
 * and refuse a third, a partial index, and a `publicColumns` withholding that
 * has to hold on the SQL a repository actually issues: a mocked `insert`
 * accepts every one of these statements, including the ones the server rejects.
 *
 * The two-representations check at the end is the one worth reading. Buyer
 * access is stated twice on purpose — once as a pure decision
 * (`authorizeOrderAccess`) and once as an indexable predicate
 * (`buyerOrClaimantSql`, through `findOrdersPage`) — because a JavaScript
 * predicate cannot scope a million-row list and a SQL predicate cannot be unit
 * tested over a subject union. Two spellings of one rule can disagree, so this
 * file drives the SAME order matrix through both and fails if they ever do.
 *
 * Rows are scoped by a per-run id suffix rather than truncated: sibling test
 * files share this database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { OrderAccessFacts, OrderAccessSubject } from '../../../services/orders/order-access.service.js';

const RUN = Math.random().toString(36).slice(2, 10);
const NOW = new Date('2026-05-06T07:08:09.000Z');

let db: import('../../postgres.js').Database;
let closePostgres: typeof import('../../postgres.js').closePostgres;
let schema: typeof import('../../schema/index.js');
let repo: typeof import('../orderRepository.js');
let access: typeof import('../../../services/orders/order-access.service.js');
let orderBuyerOf: typeof import('../../../services/orders/order-buyer.js').orderBuyerOf;
let ensureGuestCheckout: typeof import('../../guests/guestCheckoutRepository.js').ensureGuestCheckout;

const createdOrderIds: string[] = [];
const createdGroupIds: string[] = [];

beforeAll(async () => {
  const postgres = await import('../../postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  schema = await import('../../schema/index.js');
  repo = await import('../orderRepository.js');
  access = await import('../../../services/orders/order-access.service.js');
  ({ orderBuyerOf } = await import('../../../services/orders/order-buyer.js'));
  ({ ensureGuestCheckout } = await import('../../guests/guestCheckoutRepository.js'));
}, 120_000);

afterAll(async () => {
  if (createdOrderIds.length > 0) {
    await db.delete(schema.orders).where(inArray(schema.orders.id, createdOrderIds));
  }
  if (createdGroupIds.length > 0) {
    await db
      .delete(schema.guestCheckouts)
      .where(inArray(schema.guestCheckouts.checkoutGroupId, createdGroupIds));
  }
  await closePostgres();
});

/**
 * Assert a Postgres rejection whose text names a constraint or a trigger.
 *
 * The `guest-checkout.realdb.test.ts` shape, and it exists because drizzle
 * wraps the driver error: the top-level `message` is `Failed query: …` and the
 * constraint name lives on `cause`. Matching only the outer message would pass
 * for ANY failed statement — a check that cannot tell success from failure is
 * worse than no check.
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

/** The minimum `orders` row the CHECKs care about; money is irrelevant here. */
function orderValues(overrides: Record<string, unknown>): Record<string, unknown> {
  const dual = (prefix: string) => ({
    [`${prefix}ShopAmount`]: 0,
    [`${prefix}ShopCurrency`]: 'FAIR',
    [`${prefix}PresentmentAmount`]: 0,
    [`${prefix}PresentmentCurrency`]: 'FAIR',
  });
  return {
    orderNumber: `MRC-C${RUN}-${Math.floor(Math.random() * 1_000_000)}`,
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

/** Insert an order, remembering its id for teardown. */
async function insertRawOrder(overrides: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(schema.orders)
    .values(orderValues(overrides) as never)
    .returning({ id: schema.orders.id });
  createdOrderIds.push(row.id);
  return row.id;
}

/** A guest contact row for a fresh group, remembered for teardown. */
async function makeGuestContact(): Promise<{ id: string; checkoutGroupId: string }> {
  const checkoutGroupId = uuidv7();
  createdGroupIds.push(checkoutGroupId);
  const row = await ensureGuestCheckout(db, {
    checkoutGroupId,
    guestSessionId: `gs-${RUN}`,
    emailCiphertext: `v1:iv:tag:ct-${RUN}`,
    emailHash: `hash-${RUN}-${checkoutGroupId.slice(0, 8)}`,
    emailRedacted: 'j***@example.com',
    marketingOptIn: false,
  });
  return { id: row.id, checkoutGroupId };
}

describe('the WIDENED orders_buyer_identity_check (ADR 0003 D6)', () => {
  it('refuses a claim on an OXY order — it already has an owner', async () => {
    await expectPgRejection(
      db.insert(schema.orders).values(
        orderValues({
          buyerOrigin: 'oxy',
          buyerOxyUserId: `buyer-${RUN}`,
          claimedByOxyUserId: `claimant-${RUN}`,
          claimedAt: NOW,
        }) as never,
      ),
      /orders_buyer_identity_check/,
    );
  });

  it('refuses a claim on an EXTERNAL import — its buyer is another platform’s', async () => {
    await expectPgRejection(
      db.insert(schema.orders).values(
        orderValues({
          buyerOrigin: 'external',
          buyerOxyUserId: `ext:shopify:${RUN}`,
          claimedByOxyUserId: `claimant-${RUN}`,
          claimedAt: NOW,
        }) as never,
      ),
      /orders_buyer_identity_check/,
    );
  });

  it('refuses HALF a claim pair on a guest order', async () => {
    const contact = await makeGuestContact();
    await expectPgRejection(
      db.insert(schema.orders).values(
        orderValues({
          buyerOrigin: 'guest',
          buyerGuestCheckoutId: contact.id,
          claimedByOxyUserId: `claimant-${RUN}`,
        }) as never,
      ),
      /orders_buyer_identity_check/,
    );
    await expectPgRejection(
      db.insert(schema.orders).values(
        orderValues({
          buyerOrigin: 'guest',
          buyerGuestCheckoutId: contact.id,
          claimedAt: NOW,
        }) as never,
      ),
      /orders_buyer_identity_check/,
    );
  });

  it('ACCEPTS a claimed guest order — and it is still a GUEST order', async () => {
    // The vacuity guard for the three refusals above: a CHECK that refused
    // everything would satisfy them all. It is also invariant I7 at the storage
    // layer — `buyer_oxy_user_id` stays NULL through the claim.
    const contact = await makeGuestContact();
    const orderId = await insertRawOrder({
      buyerOrigin: 'guest',
      buyerGuestCheckoutId: contact.id,
      checkoutGroupId: contact.checkoutGroupId,
      claimedByOxyUserId: `claimant-${RUN}`,
      claimedAt: NOW,
    });

    const record = await repo.findOrderById(orderId);
    expect(record?.buyerOrigin).toBe('guest');
    expect(record?.buyerOxyUserId).toBeNull();
    expect(record && orderBuyerOf(record)).toEqual({
      origin: 'guest',
      guestCheckoutId: contact.id,
      claimedByOxyUserId: `claimant-${RUN}`,
      claimedAt: NOW.toISOString(),
    });
  });
});

describe('the widened immutability trigger — a claim is not a rewrite (D6/D14/I7)', () => {
  it('PERMITS NULL → value (a claim) and value → NULL (an audited unclaim)', async () => {
    const contact = await makeGuestContact();
    const orderId = await insertRawOrder({
      buyerOrigin: 'guest',
      buyerGuestCheckoutId: contact.id,
      checkoutGroupId: contact.checkoutGroupId,
    });

    await db
      .update(schema.orders)
      .set({ claimedByOxyUserId: `claimant-${RUN}`, claimedAt: NOW })
      .where(eq(schema.orders.id, orderId));
    expect((await repo.findOrderById(orderId))?.claimedByOxyUserId).toBe(`claimant-${RUN}`);

    await db
      .update(schema.orders)
      .set({ claimedByOxyUserId: null, claimedAt: null })
      .where(eq(schema.orders.id, orderId));
    expect((await repo.findOrderById(orderId))?.claimedByOxyUserId).toBeNull();
  });

  it('REFUSES value → value — a mis-claim is corrected by unclaim + re-claim', async () => {
    // ADR 0003 D14's conflict resolution, made structural: a second account
    // claiming an already-claimed group cannot overwrite the incumbent even if
    // the service forgot to answer 409.
    const contact = await makeGuestContact();
    const orderId = await insertRawOrder({
      buyerOrigin: 'guest',
      buyerGuestCheckoutId: contact.id,
      checkoutGroupId: contact.checkoutGroupId,
      claimedByOxyUserId: `first-${RUN}`,
      claimedAt: NOW,
    });

    await expectPgRejection(
      db
        .update(schema.orders)
        .set({ claimedByOxyUserId: `second-${RUN}` })
        .where(eq(schema.orders.id, orderId)),
      /cannot be reassigned/,
    );
  });

  it('still refuses rewriting the ORIGIN — the CREATE OR REPLACE kept every rule', async () => {
    // The regression this file exists to prevent: `0030` replaces the whole
    // function body, so a rule dropped there is a rule silently retired. All
    // three of `0023`'s are re-asserted here.
    const contact = await makeGuestContact();
    const guestOrderId = await insertRawOrder({
      buyerOrigin: 'guest',
      buyerGuestCheckoutId: contact.id,
      checkoutGroupId: contact.checkoutGroupId,
    });
    await expectPgRejection(
      db.update(schema.orders).set({ buyerOrigin: 'oxy' }).where(eq(schema.orders.id, guestOrderId)),
      /buyer_origin is immutable/,
    );
    await expectPgRejection(
      db
        .update(schema.orders)
        .set({ buyerGuestCheckoutId: null })
        .where(eq(schema.orders.id, guestOrderId)),
      /buyer_guest_checkout_id is immutable/,
    );

    const oxyOrderId = await insertRawOrder({
      buyerOrigin: 'oxy',
      buyerOxyUserId: `buyer-${RUN}`,
    });
    await expectPgRejection(
      db
        .update(schema.orders)
        .set({ buyerOxyUserId: `someone-else-${RUN}` })
        .where(eq(schema.orders.id, oxyOrderId)),
      /buyer_oxy_user_id cannot be reassigned/,
    );
  });
});

describe('order_status_history_actor_check — invariant I1 in an audit row (D16)', () => {
  /**
   * Assert the server refuses one actor-column combination.
   *
   * The insert is issued INSIDE the assertion rather than returned from a
   * helper: an `async` helper that returns a rejecting promise has already
   * adopted it, so awaiting the helper rejects before `expectPgRejection` can
   * catch anything — which reads as a test failure rather than as the passing
   * refusal it is.
   */
  async function expectActorRejection(values: Record<string, unknown>): Promise<void> {
    const contact = await makeGuestContact();
    const orderId = await insertRawOrder({
      buyerOrigin: 'guest',
      buyerGuestCheckoutId: contact.id,
      checkoutGroupId: contact.checkoutGroupId,
    });
    await expectPgRejection(
      db
        .insert(schema.orderStatusHistory)
        .values({ orderId, status: 'pending_payment', at: NOW, ...values } as never),
      /order_status_history_actor_check/,
    );
  }

  it('refuses an oxy actor with no account id', async () => {
    await expectActorRejection({ actorKind: 'oxy' });
  });

  it('refuses a GUEST actor wearing an Oxy id — the whole point of the CHECK', async () => {
    await expectActorRejection({ actorKind: 'guest', byOxyUserId: `smuggled-${RUN}` });
  });

  it('refuses a guest actor with no session id, and a SYSTEM actor with any id', async () => {
    await expectActorRejection({ actorKind: 'guest' });
    await expectActorRejection({ actorKind: 'system', actorGuestSessionId: `gs-${RUN}` });
  });

  it('ACCEPTS each legal shape, and withholds the session id from the read', async () => {
    // The vacuity guard, plus the `PROTECTED_COLUMNS` guarantee asserted
    // against the SQL the repository actually issues: `withChildren` selects
    // `PUBLIC_STATUS_EVENT_COLUMNS`, so the guest session id is absent from
    // every order DTO's status trail — which is what stops a merchant response
    // carrying a guest correlation key.
    const contact = await makeGuestContact();
    const orderId = await insertRawOrder({
      buyerOrigin: 'guest',
      buyerGuestCheckoutId: contact.id,
      checkoutGroupId: contact.checkoutGroupId,
    });
    await db.insert(schema.orderStatusHistory).values([
      { orderId, status: 'pending_payment', at: NOW, actorKind: 'guest', actorGuestSessionId: `gs-${RUN}` },
      { orderId, status: 'paid', at: NOW, actorKind: 'oxy', byOxyUserId: `staff-${RUN}` },
      { orderId, status: 'processing', at: NOW, actorKind: 'system' },
    ] as never);

    const record = await repo.findOrderById(orderId);
    expect(record?.statusHistory.map((event) => event.actorKind).sort()).toEqual([
      'guest',
      'oxy',
      'system',
    ]);
    for (const event of record?.statusHistory ?? []) {
      expect(Object.keys(event)).not.toContain('actorGuestSessionId');
    }

    // …and it IS in the table — otherwise the assertion above would pass for a
    // column that was never written, which is the vacuous version of it.
    const [stored] = await db
      .select({ id: schema.orderStatusHistory.actorGuestSessionId })
      .from(schema.orderStatusHistory)
      .where(eq(schema.orderStatusHistory.actorKind, 'guest'))
      .limit(1);
    expect(stored?.id).toBe(`gs-${RUN}`);
  });
});

describe('two representations of buyer access, driven through both (ADR 0003 D7)', () => {
  it('the SQL scope and the pure decision agree on every order shape', async () => {
    const claimant = `claimant-${RUN}`;
    const contactA = await makeGuestContact();
    const contactB = await makeGuestContact();

    const boughtId = await insertRawOrder({
      buyerOrigin: 'oxy',
      buyerOxyUserId: claimant,
      checkoutGroupId: uuidv7(),
    });
    const claimedId = await insertRawOrder({
      buyerOrigin: 'guest',
      buyerGuestCheckoutId: contactA.id,
      checkoutGroupId: contactA.checkoutGroupId,
      claimedByOxyUserId: claimant,
      claimedAt: NOW,
    });
    const unclaimedId = await insertRawOrder({
      buyerOrigin: 'guest',
      buyerGuestCheckoutId: contactB.id,
      checkoutGroupId: contactB.checkoutGroupId,
    });
    const somebodyElsesId = await insertRawOrder({
      buyerOrigin: 'oxy',
      buyerOxyUserId: `other-${RUN}`,
      checkoutGroupId: uuidv7(),
    });

    // (1) The SQL predicate: what the buyer's own order list returns.
    const { rows } = await repo.findOrdersPage(
      { buyerOrClaimantOxyUserId: claimant },
      1,
      50,
    );
    const visible = new Set(rows.map((row) => row.id));
    expect(visible.has(boughtId)).toBe(true);
    expect(visible.has(claimedId)).toBe(true);
    expect(visible.has(unclaimedId)).toBe(false);
    expect(visible.has(somebodyElsesId)).toBe(false);

    // (2) The pure decision, over the SAME four rows.
    const subject: OrderAccessSubject = { kind: 'oxy_account', oxyUserId: claimant };
    for (const orderId of [boughtId, claimedId, unclaimedId, somebodyElsesId]) {
      const record = await repo.findOrderById(orderId);
      expect(record).not.toBeNull();
      if (!record) continue;
      const facts: OrderAccessFacts = {
        id: record.id,
        buyer: orderBuyerOf(record),
        checkoutGroupId: record.checkoutGroupId,
        sellerType: record.sellerType,
        sellerOxyUserId: record.sellerOxyUserId,
        storeId: record.storeId,
      };
      const decision = access.authorizeOrderAccess(subject, facts, NOW);
      // THE assertion: the two spellings of "may this account see it" answer
      // the same for every row. A drift between them is what would make a
      // claimed order listable and unreadable, or the reverse.
      expect(decision.allowed, `${orderId} disagreed`).toBe(visible.has(orderId));
    }
  });

  it('the ORIGIN-only filter still answers the narrower question', async () => {
    // `buyerOxyUserId` and `buyerOrClaimantOxyUserId` are kept as two filters
    // because two different questions are asked. This is the one that must NOT
    // widen: a claimed purchase is not an order this account PLACED.
    const claimant = `origin-only-${RUN}`;
    const contact = await makeGuestContact();
    const claimedId = await insertRawOrder({
      buyerOrigin: 'guest',
      buyerGuestCheckoutId: contact.id,
      checkoutGroupId: contact.checkoutGroupId,
      claimedByOxyUserId: claimant,
      claimedAt: NOW,
    });

    const { rows } = await repo.findOrdersPage({ buyerOxyUserId: claimant }, 1, 50);
    expect(rows.map((row) => row.id)).not.toContain(claimedId);
  });
});

describe('the buyer-identity consistency probes (#106 migration rule 10)', () => {
  it('finds a PARTIALLY claimed group and a MIXED-origin group', async () => {
    const contactA = await makeGuestContact();
    const contactB = await makeGuestContact();
    const splitGroup = uuidv7();

    // Two siblings of one group, one claimed and one not — the state ADR 0003
    // D14's group-atomic claim makes impossible and no CHECK can observe.
    await insertRawOrder({
      buyerOrigin: 'guest',
      buyerGuestCheckoutId: contactA.id,
      checkoutGroupId: splitGroup,
      claimedByOxyUserId: `claimant-${RUN}`,
      claimedAt: NOW,
    });
    await insertRawOrder({
      buyerOrigin: 'guest',
      buyerGuestCheckoutId: contactB.id,
      checkoutGroupId: splitGroup,
    });

    // A group whose siblings disagree about who bought them.
    const mixedGroup = uuidv7();
    const contactC = await makeGuestContact();
    await insertRawOrder({
      buyerOrigin: 'guest',
      buyerGuestCheckoutId: contactC.id,
      checkoutGroupId: mixedGroup,
    });
    await insertRawOrder({
      buyerOrigin: 'oxy',
      buyerOxyUserId: `buyer-${RUN}`,
      checkoutGroupId: mixedGroup,
    });

    // And a misclassified connector import — M4's discriminating count.
    await insertRawOrder({ buyerOrigin: 'oxy', buyerOxyUserId: `ext:shopify:${RUN}` });

    const report = await repo.readBuyerIdentityConsistency(db);
    expect(report.partiallyClaimedGroups.sample).toContain(splitGroup);
    expect(report.mixedOriginGroups.sample).toContain(mixedGroup);
    expect(report.legacyExternalMisclassified.count).toBeGreaterThan(0);
    // The counts are the WHOLE count, not the sample length — the window
    // function runs before the LIMIT.
    expect(report.partiallyClaimedGroups.count).toBeGreaterThanOrEqual(
      report.partiallyClaimedGroups.sample.length,
    );
  });

  it('finds an ORPHANED guest contact — the direction the FK cannot state', async () => {
    // `orders.buyer_guest_checkout_id` is `RESTRICT`, so an order pointing at a
    // missing contact is unrepresentable; a contact with no order is not, and
    // it is a person's email retained for nothing.
    const orphan = await makeGuestContact();
    const report = await repo.readBuyerIdentityConsistency(db);
    expect(report.orphanedGuestCheckouts.sample).toContain(orphan.id);
  });
});

describe('the index the claim-aware read is built for', () => {
  it('orders_claimed_by_created_at_idx exists and is PARTIAL', async () => {
    // A gate against `pg_indexes`, the #105 discipline: the predicate above is
    // only two indexed scans if the second index is actually there, and a
    // non-partial one would be almost entirely NULLs.
    const rows = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes
           where tablename = 'orders' and indexname = 'orders_claimed_by_created_at_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toMatch(/claimed_by_oxy_user_id IS NOT NULL/);
  });
});
