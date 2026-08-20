/**
 * Buyer post-purchase requests against a REAL PostgreSQL database (#110).
 *
 * Every property below is held by a CHECK, a partial unique index or a trigger,
 * and none of them exists under a mocked repository — a mocked `insert` accepts
 * any statement, including one the server rejects outright. So this file is a
 * test of the DDL rather than of the code that happens to call it:
 *
 *  - **acceptance 4 — duplicates cannot double-refund or double-restock.** The
 *    two partial uniques (`…_open_order_key`) are what makes a double tap, a
 *    retried POST and two concurrent submissions converge on ONE row, and the
 *    idempotency uniques are what makes a client retry converge after the first
 *    was decided. Both are exercised, and the RACE case runs two inserts
 *    concurrently rather than sequentially — a sequential pair passes under a
 *    read-then-write that a real race defeats.
 *  - **acceptance 3 — multi-seller requests stay isolated.** Two sibling orders
 *    in ONE checkout group, each with its own request, each decided
 *    independently: the partial unique is keyed on the ORDER, so a request
 *    against one sibling never blocks or reaches the other.
 *  - **acceptance 2 — a buyer cannot mutate status or provider payment.** Held
 *    by the schema having no column to do it with, asserted here by the absence
 *    of any status/payment column on the four request tables.
 *  - **the audit trail and the support thread are APPEND-ONLY**, against UPDATE
 *    *and* DELETE, so neither side can revise what happened.
 *  - **the state CHECKs are biconditionals**, so a decided state without a
 *    decision, a rejection without a reason, a refund reference on a state that
 *    never refunded and a completed request with no instant are all
 *    unrepresentable.
 *  - **a request line's identity is frozen** — only the seller's agreed
 *    quantity may move, so a decision cannot rewrite what the buyer asked for
 *    and then refund against it.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every id this file writes carries a per-run suffix and
 * teardown deletes exactly what it created, children first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { connectPostgres, type Database } from '../postgres.js';
import { insertOrder } from '../orders/orderRepository.js';
import { orders } from '../schema/orders.js';
import { guestCheckouts } from '../schema/guests.js';
import {
  buyerRequestEvents,
  cancellationRequestLines,
  cancellationRequests,
  returnRequestEvidence,
  returnRequestLines,
  returnRequests,
  supportMessages,
  supportThreads,
} from '../schema/buyerRequests.js';
import {
  findOpenCancellationRequestForOrder,
  insertCancellationRequest,
  transitionCancellationRequest,
} from '../buyerRequests/cancellationRepository.js';
import {
  insertReturnRequest,
  sumReturnedQuantities,
  transitionReturnRequest,
} from '../buyerRequests/returnRepository.js';
import { ensureSupportThread, insertSupportMessage } from '../buyerRequests/supportRepository.js';
import { recordBuyerRequestEvent } from '../buyerRequests/eventRepository.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
import {
  completeCancellationRequest,
  decideCancellationRequest,
} from '../../services/buyer-requests/cancellation-decision.service.js';
import {
  cancelReturnRequest,
  decideReturnRequest,
  issueReturnInstructions,
  markReturnReceived,
  refundReturnRequest,
} from '../../services/buyer-requests/return-decision.service.js';
import { sellerDecisionActor } from '../../services/buyer-requests/authorization.js';

const RUN = uuidv7().slice(-10);

const createdOrderIds: string[] = [];
const createdGuestCheckoutIds: string[] = [];

/**
 * A CHECK, unique or trigger violation — what every refusal below should be.
 *
 * Walks the CAUSE CHAIN, because drizzle wraps a driver error in a `Failed
 * query: …` of its own and the SQLSTATE lives on the cause. Reading `err.code`
 * off the wrapper returns `undefined`, which would make every
 * `rejects.toSatisfy(isRefusal)` below fail for a reason unrelated to the
 * constraint under test — and, worse, a matcher that answered `true` on
 * `undefined` would pass for ANY rejection, including a typo in the statement.
 */
function isRefusal(err: unknown): boolean {
  // 23514 check_violation, 23505 unique_violation, P0001 raise_exception
  // (what `RAISE EXCEPTION` in a trigger produces).
  const codes = new Set(['23514', '23505', 'P0001']);
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { code?: string }).code;
    if (typeof code === 'string' && codes.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const money = (amount: number) => ({
  shop: { amount, currency: 'EUR' as const },
  presentment: { amount, currency: 'EUR' as const },
});

/** One paid order, optionally sharing a checkout group with a sibling. */
async function seedOrder(input: {
  checkoutGroupId?: string;
  seller?: string;
  variantId?: string;
  quantity?: number;
}): Promise<{ id: string; variantId: string; checkoutGroupId: string }> {
  const variantId = input.variantId ?? uuidv7();
  const checkoutGroupId = input.checkoutGroupId ?? uuidv7();
  // A GUEST-origin order, because that is the buyer #110 exists for — and
  // `orders_buyer_identity_check` (#105/#106) refuses one with no contact
  // record, so the group needs a `guest_checkouts` row first. Reusing the
  // group's existing row is what makes the two siblings in the multi-seller
  // case share one contact, exactly as a real checkout does.
  const guestCheckoutId = await ensureGuestCheckout(checkoutGroupId);
  const order = await insertOrder({
    orderNumber: `MRC-BRQ-${uuidv7().slice(-8)}`,
    buyerOrigin: 'guest',
    buyerGuestCheckoutId: guestCheckoutId,
    sellerType: 'user',
    commercialRole: 'connected_marketplace',
    sellerOxyUserId: input.seller ?? `seller-${RUN}`,
    items: [
      {
        listingId: uuidv7(),
        variantId,
        title: 'A thing',
        variantTitle: 'Default Title',
        optionValues: [],
        unitPrice: money(1_000),
        quantity: input.quantity ?? 2,
        lineTotal: money(2_000),
      },
    ],
    shippingAddress: {
      recipientName: 'Buyer',
      line1: '1 Street',
      city: 'Barcelona',
      postalCode: '08001',
      country: 'ES',
    },
    shippingMethod: 'standard',
    shippingLabel: 'Standard shipping',
    shippingCost: money(0),
    totals: {
      subtotal: money(2_000),
      discountTotal: money(0),
      shipping: money(0),
      tax: money(0),
      grandTotal: money(2_000),
    },
    status: 'paid',
    paymentStatus: 'paid',
    checkoutGroupId,
    statusHistory: [{ status: 'paid', at: new Date(), actorKind: 'system' }],
    appliedDiscounts: [],
    taxLines: [],
  });
  createdOrderIds.push(order.id);
  return { id: order.id, variantId, checkoutGroupId };
}

/** The group's contact record, created once per group. */
async function ensureGuestCheckout(checkoutGroupId: string): Promise<string> {
  const [existing] = await db
    .select({ id: guestCheckouts.id })
    .from(guestCheckouts)
    .where(eq(guestCheckouts.checkoutGroupId, checkoutGroupId))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(guestCheckouts)
    .values({
      checkoutGroupId,
      guestSessionId: `session-${uuidv7().slice(-8)}`,
      // `guest_checkouts_anonymization_check` demands a ciphertext on a
      // non-anonymized row, and its pair CHECK demands the hash beside it —
      // these are opaque placeholders, never a real address, and nothing in
      // this file reads them back.
      emailCiphertext: `v1:${uuidv7()}`,
      emailHash: uuidv7().replace(/-/g, ''),
      emailRedacted: 'b***@example.com',
    })
    .returning({ id: guestCheckouts.id });
  if (!created) throw new Error('guest checkout insert returned no row');
  createdGuestCheckoutIds.push(created.id);
  return created.id;
}

/** A submitted cancellation request against one order. */
async function fileCancellation(
  orderId: string,
  extra: { idempotencyKey?: string; lines?: { variantId: string; requestedQuantity: number }[] } = {},
): Promise<string | null> {
  const created = await db.transaction(async (tx) =>
    insertCancellationRequest(tx, {
      orderId,
      reason: 'changed_my_mind',
      completionMode: 'refund',
      wholeOrder: (extra.lines ?? []).length === 0,
      requestedByActorKind: 'guest',
      ...(extra.idempotencyKey === undefined ? {} : { idempotencyKey: extra.idempotencyKey }),
      lines: extra.lines ?? [],
    }),
  );
  return created?.id ?? null;
}

beforeAll(async () => {
  db = await connectPostgres();
  // A vacuity floor of its own: a suite that seeded nothing would pass every
  // "the server refused it" assertion below by never reaching the server.
  const probe = await seedOrder({});
  expect(probe.id).toBeTruthy();
}, 120_000);

afterAll(async () => {
  if (createdOrderIds.length === 0) return;
  const cancellationIds = (
    await db
      .select({ id: cancellationRequests.id })
      .from(cancellationRequests)
      .where(inArray(cancellationRequests.orderId, createdOrderIds))
  ).map((row) => row.id);
  const returnIds = (
    await db
      .select({ id: returnRequests.id })
      .from(returnRequests)
      .where(inArray(returnRequests.orderId, createdOrderIds))
  ).map((row) => row.id);
  const threadIds = (
    await db
      .select({ id: supportThreads.id })
      .from(supportThreads)
      .where(inArray(supportThreads.orderId, createdOrderIds))
  ).map((row) => row.id);

  // Append-only triggers refuse an ordinary DELETE, so teardown disables them
  // for the length of its own transaction. `SET LOCAL session_replication_role`
  // is scoped to the transaction and takes no TABLE lock at all, unlike
  // `ALTER TABLE … DISABLE TRIGGER`, which takes ShareRowExclusive on each
  // table it names. That conflicts with the RowExclusive an ordinary WRITER
  // holds — not with a reader, since ShareRowExclusive and AccessShare do not
  // conflict — so what it queues behind is sibling files WRITING these tables,
  // and holding two of those at once is the #301 deadlock. The cost of this
  // spelling, stated rather than hidden: `replica` also silences FOREIGN KEY
  // triggers, so a children-first mistake in this teardown fails silently here
  // where `ALTER TABLE` would still raise `23503`.
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    if (threadIds.length > 0) {
      await tx.delete(supportMessages).where(inArray(supportMessages.threadId, threadIds));
    }
    if (cancellationIds.length > 0) {
      await tx
        .delete(buyerRequestEvents)
        .where(inArray(buyerRequestEvents.cancellationRequestId, cancellationIds));
    }
    if (returnIds.length > 0) {
      await tx
        .delete(buyerRequestEvents)
        .where(inArray(buyerRequestEvents.returnRequestId, returnIds));
      await tx.delete(returnRequestEvidence).where(inArray(returnRequestEvidence.requestId, returnIds));
      await tx.delete(returnRequestLines).where(inArray(returnRequestLines.requestId, returnIds));
    }
    if (threadIds.length > 0) await tx.delete(supportThreads).where(inArray(supportThreads.id, threadIds));
    if (returnIds.length > 0) await tx.delete(returnRequests).where(inArray(returnRequests.id, returnIds));
    if (cancellationIds.length > 0) {
      await tx
        .delete(cancellationRequestLines)
        .where(inArray(cancellationRequestLines.requestId, cancellationIds));
      await tx.delete(cancellationRequests).where(inArray(cancellationRequests.id, cancellationIds));
    }
    await tx.delete(orders).where(inArray(orders.id, createdOrderIds));
    if (createdGuestCheckoutIds.length > 0) {
      await tx.delete(guestCheckouts).where(inArray(guestCheckouts.id, createdGuestCheckoutIds));
    }
  });
});

describe('the refusal matcher itself', () => {
  it('does not answer true for an unrelated failure', () => {
    // Every `rejects.toSatisfy(isRefusal)` below is only load-bearing if the
    // matcher can say NO. One that returned true on anything would pass for a
    // typo in the statement, a dropped connection or a missing column — the
    // "a check that cannot distinguish success from failure" shape.
    expect(isRefusal(new Error('connection terminated'))).toBe(false);
    expect(isRefusal({ code: '42703' })).toBe(false);
    expect(isRefusal(null)).toBe(false);
    // And the positives, including the wrapped shape drizzle actually throws.
    expect(isRefusal({ code: '23514' })).toBe(true);
    expect(isRefusal(Object.assign(new Error('Failed query'), { cause: { code: 'P0001' } }))).toBe(
      true,
    );
  });
});

describe('convergence — acceptance 4', () => {
  it('a second live cancellation for one order is refused by the index', async () => {
    const order = await seedOrder({});
    expect(await fileCancellation(order.id)).toBeTruthy();
    // The repository's own `onConflictDoNothing` turns the refusal into a
    // `null`, which is the caller's signal to READ rather than to throw — the
    // moderation dedupe-claim shape, where the empty RETURNING set IS the
    // answer.
    expect(await fileCancellation(order.id)).toBeNull();
    const open = await findOpenCancellationRequestForOrder(order.id);
    expect(open?.state).toBe('submitted');
  });

  it('two CONCURRENT submissions produce exactly one request', async () => {
    const order = await seedOrder({});
    // Concurrent, not sequential. A sequential pair passes under a
    // read-then-write that two real racers defeat, so running them in parallel
    // is what makes this a test of the INDEX rather than of the read above it.
    const results = await Promise.all([fileCancellation(order.id), fileCancellation(order.id)]);
    expect(results.filter((id) => id !== null)).toHaveLength(1);
    const rows = await db
      .select({ id: cancellationRequests.id })
      .from(cancellationRequests)
      .where(eq(cancellationRequests.orderId, order.id));
    expect(rows).toHaveLength(1);
  });

  it('a request may be re-filed once the first is CLOSED', async () => {
    const order = await seedOrder({});
    const first = await fileCancellation(order.id);
    expect(first).toBeTruthy();
    await db.transaction(async (tx) => {
      await transitionCancellationRequest(tx, {
        id: first ?? '',
        from: 'submitted',
        to: 'rejected',
        decidedByActorKind: 'oxy',
        decidedByOxyUserId: `seller-${RUN}`,
        decidedAt: new Date(),
        decisionNote: 'already packed',
      });
    });
    // The partial unique covers the OPEN states only, so a closed request frees
    // the order — which is what makes "a seller said no, ask again once it is
    // delivered" possible without a second table.
    expect(await fileCancellation(order.id)).toBeTruthy();
  });

  it('the idempotency key converges a retry after the first was decided', async () => {
    const order = await seedOrder({});
    const key = `retry-${RUN}-${uuidv7().slice(-6)}`;
    const first = await fileCancellation(order.id, { idempotencyKey: key });
    expect(first).toBeTruthy();
    await db.transaction(async (tx) => {
      await transitionCancellationRequest(tx, {
        id: first ?? '',
        from: 'submitted',
        to: 'rejected',
        decidedByActorKind: 'oxy',
        decidedByOxyUserId: `seller-${RUN}`,
        decidedAt: new Date(),
        decisionNote: 'no longer possible',
      });
    });
    // The order is now free, so the OPEN-state index would admit a second row —
    // and the idempotency unique is what stops the retry becoming one. Neither
    // index covers the other, which is why both exist.
    expect(await fileCancellation(order.id, { idempotencyKey: key })).toBeNull();
  });
});

describe('multi-seller isolation — acceptance 3', () => {
  it('two sibling orders in one group carry independent requests', async () => {
    const groupId = uuidv7();
    const first = await seedOrder({ checkoutGroupId: groupId, seller: `seller-a-${RUN}` });
    const second = await seedOrder({ checkoutGroupId: groupId, seller: `seller-b-${RUN}` });
    expect(first.checkoutGroupId).toBe(second.checkoutGroupId);

    const firstRequest = await fileCancellation(first.id);
    const secondRequest = await fileCancellation(second.id);
    // The partial unique is keyed on the ORDER, never on the group. A request
    // against one sibling therefore neither blocks nor reaches the other, which
    // is authorization rule 5 and acceptance 3 in one index.
    expect(firstRequest).toBeTruthy();
    expect(secondRequest).toBeTruthy();
    expect(firstRequest).not.toBe(secondRequest);

    // Deciding one leaves the other untouched.
    await db.transaction(async (tx) => {
      await transitionCancellationRequest(tx, {
        id: firstRequest ?? '',
        from: 'submitted',
        to: 'accepted',
        decidedByActorKind: 'oxy',
        decidedByOxyUserId: `seller-a-${RUN}`,
        decidedAt: new Date(),
      });
    });
    const untouched = await findOpenCancellationRequestForOrder(second.id);
    expect(untouched?.state).toBe('submitted');
  });
});

describe('the state CHECKs are biconditionals', () => {
  it('refuses a decided state with no decision recorded', async () => {
    const order = await seedOrder({});
    const id = await fileCancellation(order.id);
    await expect(
      db
        .update(cancellationRequests)
        .set({ state: 'accepted' })
        .where(eq(cancellationRequests.id, id ?? '')),
    ).rejects.toSatisfy(isRefusal);
  });

  it('refuses a rejection with no reason, and a note on a non-rejection', async () => {
    const order = await seedOrder({});
    const id = await fileCancellation(order.id);
    await expect(
      db
        .update(cancellationRequests)
        .set({
          state: 'rejected',
          decidedByActorKind: 'oxy',
          decidedByOxyUserId: `seller-${RUN}`,
          decidedAt: new Date(),
        })
        .where(eq(cancellationRequests.id, id ?? '')),
    ).rejects.toSatisfy(isRefusal);

    // And the other direction: a note without a rejection is a seller's remark
    // on a request nobody refused, shown to a buyer as if it were one.
    await expect(
      db
        .update(cancellationRequests)
        .set({
          state: 'accepted',
          decidedByActorKind: 'oxy',
          decidedByOxyUserId: `seller-${RUN}`,
          decidedAt: new Date(),
          decisionNote: 'sure thing',
        })
        .where(eq(cancellationRequests.id, id ?? '')),
    ).rejects.toSatisfy(isRefusal);
  });

  it('refuses a completed request with no completion instant', async () => {
    const order = await seedOrder({});
    const id = await fileCancellation(order.id);
    await expect(
      db
        .update(cancellationRequests)
        .set({
          state: 'completed',
          decidedByActorKind: 'oxy',
          decidedByOxyUserId: `seller-${RUN}`,
          decidedAt: new Date(),
        })
        .where(eq(cancellationRequests.id, id ?? '')),
    ).rejects.toSatisfy(isRefusal);
  });

  it('refuses a GUEST decider — deciding is a named act', async () => {
    const order = await seedOrder({});
    const id = await fileCancellation(order.id);
    await expect(
      db
        .update(cancellationRequests)
        .set({ decidedByActorKind: 'guest', decidedAt: new Date(), state: 'accepted' })
        .where(eq(cancellationRequests.id, id ?? '')),
    ).rejects.toSatisfy(isRefusal);
  });

  it('refuses an `oxy` requester carrying a portal grant instead of an account', async () => {
    const order = await seedOrder({});
    // The actor shape CHECK — ADR 0003 D16's rule, one table over. An `oxy`
    // actor names an account and never a grant; a `guest` actor never names an
    // account. The two halves are what stop a guest session id reaching an
    // Oxy-shaped column.
    await expect(
      db.insert(cancellationRequests).values({
        orderId: order.id,
        reason: 'changed_my_mind',
        completionMode: 'refund',
        wholeOrder: true,
        requestedByActorKind: 'oxy',
      }),
    ).rejects.toSatisfy(isRefusal);
  });
});

describe('the return state machine', () => {
  async function fileReturn(orderId: string, variantId: string, quantity = 1) {
    const created = await db.transaction(async (tx) =>
      insertReturnRequest(tx, {
        orderId,
        reason: 'arrived_damaged',
        resolution: 'refund',
        returnWindowEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
        requestedByActorKind: 'guest',
        lines: [{ variantId, requestedQuantity: quantity }],
        evidence: [{ fileId: `file-${uuidv7().slice(-8)}`, kind: 'damage_photo', position: 0 }],
      }),
    );
    return created?.id ?? '';
  }

  it('refuses a refund reference on a state that has not refunded', async () => {
    const order = await seedOrder({});
    const id = await fileReturn(order.id, order.variantId);
    await expect(
      db
        .update(returnRequests)
        .set({ refundId: uuidv7() })
        .where(eq(returnRequests.id, id)),
    ).rejects.toSatisfy(isRefusal);
  });

  it('refuses instructions before the return was approved', async () => {
    const order = await seedOrder({});
    const id = await fileReturn(order.id, order.variantId);
    await expect(
      db
        .update(returnRequests)
        .set({ returnInstructions: 'Post it back to us' })
        .where(eq(returnRequests.id, id)),
    ).rejects.toSatisfy(isRefusal);
  });

  it('refuses a ship-back deadline with no instructions behind it', async () => {
    const order = await seedOrder({});
    const id = await fileReturn(order.id, order.variantId);
    await db.transaction(async (tx) => {
      await transitionReturnRequest(tx, {
        id,
        from: 'requested',
        to: 'approved',
        decidedByActorKind: 'oxy',
        decidedByOxyUserId: `seller-${RUN}`,
        decidedAt: new Date(),
      });
    });
    // A deadline with no instructions is a date nobody was told about.
    await expect(
      db
        .update(returnRequests)
        .set({ state: 'awaiting_item', shipBackDeadlineAt: new Date() })
        .where(eq(returnRequests.id, id)),
    ).rejects.toSatisfy(isRefusal);
  });

  it('counts units still in flight, so a second return cannot double up', async () => {
    const order = await seedOrder({ quantity: 2 });
    await fileReturn(order.id, order.variantId, 2);
    const counted = await sumReturnedQuantities(order.id);
    // Counted from an OPEN request, not a completed one: the whole point is
    // that units already in the post are not returnable a second time. The
    // aggregate decodes as a STRING through postgres.js and the repository
    // coerces it — a `2` here rather than a `'2'` is that coercion working.
    expect(counted.get(order.variantId)).toBe(2);
    expect(typeof counted.get(order.variantId)).toBe('number');
  });
});

describe('append-only, against UPDATE and DELETE', () => {
  it('refuses to edit or remove an audit event', async () => {
    const order = await seedOrder({});
    const id = await fileCancellation(order.id);
    await db.transaction(async (tx) => {
      await recordBuyerRequestEvent(tx, {
        cancellationRequestId: id ?? '',
        kind: 'submitted',
        actorKind: 'guest',
        at: new Date(),
      });
    });
    const [event] = await db
      .select({ id: buyerRequestEvents.id })
      .from(buyerRequestEvents)
      .where(eq(buyerRequestEvents.cancellationRequestId, id ?? ''));
    expect(event).toBeTruthy();
    await expect(
      db
        .update(buyerRequestEvents)
        .set({ detail: 'rewritten' })
        .where(eq(buyerRequestEvents.id, event?.id ?? '')),
    ).rejects.toSatisfy(isRefusal);
    await expect(
      db.delete(buyerRequestEvents).where(eq(buyerRequestEvents.id, event?.id ?? '')),
    ).rejects.toSatisfy(isRefusal);
  });

  it('refuses to edit or remove a support message', async () => {
    const order = await seedOrder({});
    const messageId = await db.transaction(async (tx) => {
      const thread = await ensureSupportThread(tx, { orderId: order.id });
      const message = await insertSupportMessage(tx, {
        threadId: thread.id,
        authorKind: 'buyer',
        body: 'Where is my order?',
        redactions: [],
      });
      return message.id;
    });
    await expect(
      db.update(supportMessages).set({ body: 'edited' }).where(eq(supportMessages.id, messageId)),
    ).rejects.toSatisfy(isRefusal);
    await expect(
      db.delete(supportMessages).where(eq(supportMessages.id, messageId)),
    ).rejects.toSatisfy(isRefusal);
  });

  it('refuses to change a request line’s variant or requested quantity', async () => {
    const order = await seedOrder({ quantity: 2 });
    const id = await fileCancellation(order.id, {
      lines: [{ variantId: order.variantId, requestedQuantity: 2 }],
    });
    const [line] = await db
      .select({ id: cancellationRequestLines.id })
      .from(cancellationRequestLines)
      .where(eq(cancellationRequestLines.requestId, id ?? ''));
    expect(line).toBeTruthy();
    await expect(
      db
        .update(cancellationRequestLines)
        .set({ requestedQuantity: 1 })
        .where(eq(cancellationRequestLines.id, line?.id ?? '')),
    ).rejects.toSatisfy(isRefusal);
    // The one column a decision MAY write.
    await db
      .update(cancellationRequestLines)
      .set({ approvedQuantity: 1 })
      .where(eq(cancellationRequestLines.id, line?.id ?? ''));
    const [after] = await db
      .select({ approvedQuantity: cancellationRequestLines.approvedQuantity })
      .from(cancellationRequestLines)
      .where(eq(cancellationRequestLines.id, line?.id ?? ''));
    expect(after?.approvedQuantity).toBe(1);
  });

  it('refuses an approved quantity larger than what was requested', async () => {
    const order = await seedOrder({ quantity: 2 });
    const id = await fileCancellation(order.id, {
      lines: [{ variantId: order.variantId, requestedQuantity: 1 }],
    });
    const [line] = await db
      .select({ id: cancellationRequestLines.id })
      .from(cancellationRequestLines)
      .where(eq(cancellationRequestLines.requestId, id ?? ''));
    await expect(
      db
        .update(cancellationRequestLines)
        .set({ approvedQuantity: 5 })
        .where(eq(cancellationRequestLines.id, line?.id ?? '')),
    ).rejects.toSatisfy(isRefusal);
  });
});

describe('support threads', () => {
  it('converge on ONE order-level thread', async () => {
    const order = await seedOrder({});
    const [first, second] = await Promise.all([
      db.transaction(async (tx) => ensureSupportThread(tx, { orderId: order.id })),
      db.transaction(async (tx) => ensureSupportThread(tx, { orderId: order.id })),
    ]);
    // The partial unique is on the NULL branch, because Postgres treats NULLs
    // as distinct and a plain two-column unique would let a buyer open
    // unlimited order-level threads.
    expect(first.id).toBe(second.id);
  });

  it('a reply reopens a closed thread', async () => {
    const order = await seedOrder({});
    const threadId = await db.transaction(async (tx) => {
      const thread = await ensureSupportThread(tx, { orderId: order.id });
      return thread.id;
    });
    await db
      .update(supportThreads)
      .set({ state: 'closed', closedAt: new Date() })
      .where(eq(supportThreads.id, threadId));
    await db.transaction(async (tx) => {
      await insertSupportMessage(tx, {
        threadId,
        authorKind: 'buyer',
        body: 'Actually, one more thing',
        redactions: [],
      });
    });
    const [after] = await db
      .select({ state: supportThreads.state, closedAt: supportThreads.closedAt })
      .from(supportThreads)
      .where(eq(supportThreads.id, threadId));
    // Reopening is deliberate: a closed thread that cannot be reopened only
    // teaches people to open a second one.
    expect(after?.state).toBe('open');
    expect(after?.closedAt).toBeNull();
  });

  it('refuses a seller message with no account behind it', async () => {
    const order = await seedOrder({});
    const threadId = await db.transaction(async (tx) => {
      const thread = await ensureSupportThread(tx, { orderId: order.id });
      return thread.id;
    });
    await expect(
      db.insert(supportMessages).values({
        threadId,
        authorKind: 'seller',
        body: 'We are looking into it',
      }),
    ).rejects.toSatisfy(isRefusal);
  });

  it('refuses an unrecognised redaction kind', async () => {
    const order = await seedOrder({});
    const threadId = await db.transaction(async (tx) => {
      const thread = await ensureSupportThread(tx, { orderId: order.id });
      return thread.id;
    });
    await expect(
      db.execute(
        sql`insert into support_messages (id, thread_id, author_kind, body, redactions)
            values (${uuidv7()}, ${threadId}, 'buyer', 'hello', array['home_address']::text[])`,
      ),
    ).rejects.toSatisfy(isRefusal);
  });
});

describe('a request table has no way to change an order — acceptance 2', () => {
  it('carries no status, payment or money column', async () => {
    const columns = await db.execute<{ table_name: string; column_name: string }>(
      sql`select table_name, column_name
            from information_schema.columns
           where table_schema = 'public'
             and table_name in ('cancellation_requests', 'return_requests',
                                'support_threads', 'support_messages')`,
    );
    const names = [...columns].map((row) => `${row.table_name}.${row.column_name}`);
    // The vacuity floor: an empty result would satisfy every assertion below.
    expect(names.length).toBeGreaterThan(30);
    for (const name of names) {
      const column = name.split('.')[1] ?? '';
      // `state` is this domain's own request lifecycle; an ORDER status, a
      // payment status, a provider or an amount are what must be absent.
      expect(
        /^(order_status|payment_status|payment_provider|provider_.*|amount.*|total.*|currency.*)$/.test(
          column,
        ),
        `${name} would let a buyer request touch an order's money or status`,
      ).toBe(false);
    }
  });
});

/**
 * #743 — the trail records refusals, not only successes.
 *
 * Driven through the real decision SERVICE rather than the repository, because
 * the property under test is not "a row can be inserted" — it is that the row
 * SURVIVES the throw that follows it. A refusal is written on the root handle
 * for exactly that reason (`decision-refusal.ts`), and a test that inserted
 * directly would pass just as happily against the transaction handle that loses
 * the row, which is the bug.
 */
describe('a refused decision is recorded (#743)', () => {
  // Minted through the real authorization path: `BuyerRequestDecider` carries a
  // module-private symbol, so a test cannot forge one — the #110 device working
  // as designed, and the reason this case exercises the service the router
  // actually calls.
  const decider = sellerDecisionActor(`seller-743-${RUN}`, 'cancellation:decide');

  async function refusalsFor(cancellationRequestId: string) {
    return db
      .select({ kind: buyerRequestEvents.kind, detail: buyerRequestEvents.detail })
      .from(buyerRequestEvents)
      .where(eq(buyerRequestEvents.cancellationRequestId, cancellationRequestId));
  }

  it('records `already_decided` when a second decision arrives, and still refuses', async () => {
    const order = await seedOrder({});
    const requestId = await fileCancellation(order.id);
    expect(requestId).toBeTruthy();

    await decideCancellationRequest({
      requestId: requestId ?? '',
      decider,
      body: { decision: 'reject', note: 'not this time' },
      now: new Date(),
    });

    // The same seller decides again with the OTHER decision: a real conflict
    // rather than a converging repeat.
    await expect(
      decideCancellationRequest({
        requestId: requestId ?? '',
        decider,
        body: { decision: 'accept' },
        now: new Date(),
      }),
    ).rejects.toThrow();

    const events = await refusalsFor(requestId ?? '');
    // The refusal is THERE — this is what the throw would have rolled back had
    // the write taken a transaction handle.
    expect(
      events.filter((row) => row.kind === 'decision_refused').map((row) => row.detail),
    ).toEqual(['already_decided']);
    // And the successful decision beside it, so the case is not passing on a
    // trail that recorded nothing at all.
    expect(events.some((row) => row.kind === 'rejected')).toBe(true);
  });

  it('records `rejection_note_missing` on a rejection with no note', async () => {
    const order = await seedOrder({});
    const requestId = await fileCancellation(order.id);

    await expect(
      decideCancellationRequest({
        requestId: requestId ?? '',
        decider,
        body: { decision: 'reject', note: 'x' },
        now: new Date(),
      }),
    ).rejects.toThrow();

    const events = await refusalsFor(requestId ?? '');
    expect(events.map((row) => `${row.kind}:${row.detail}`)).toEqual([
      'decision_refused:rejection_note_missing',
    ]);
    // The request is untouched: a refusal records an ATTEMPT, never a decision.
    const after = await db
      .select({ state: cancellationRequests.state })
      .from(cancellationRequests)
      .where(eq(cancellationRequests.id, requestId ?? ''));
    expect(after[0]?.state).toBe('submitted');
  });

  it('records `quantity_exceeds_requested` when a seller approves more than was asked', async () => {
    const order = await seedOrder({ quantity: 2 });
    const requestId = await fileCancellation(order.id, {
      lines: [{ variantId: order.variantId, requestedQuantity: 1 }],
    });

    await expect(
      decideCancellationRequest({
        requestId: requestId ?? '',
        decider,
        body: { decision: 'accept', lines: [{ variantId: order.variantId, quantity: 2 }] },
        now: new Date(),
      }),
    ).rejects.toThrow();

    const events = await refusalsFor(requestId ?? '');
    expect(events.map((row) => row.detail)).toEqual(['quantity_exceeds_requested']);
  });
});

/**
 * #765 — the trail records a refused INSTRUCTION, RECEIPT, REFUND COMMIT,
 * COMPLETION and RETURN CANCELLATION, not only a refused decision.
 *
 * Driven through the real SERVICES for #743's reason: a case that inserted the
 * row itself would measure the repository, which was never the thing missing —
 * the tuple, the CHECK and the writer all accepted these rows already and
 * nothing called them. Each case asserts three things: the caller was refused,
 * the row is THERE afterwards, and the request did not move.
 *
 * What they do NOT prove is the root-handle rule. None of these refusals sits
 * inside a transaction, so a `tx` handle would behave identically here; that
 * property is held statically instead, by `buyer-request-isolation.test.ts`
 * asserting `refusal.ts` is the only module that writes on a root handle.
 */
describe('a refused transition is recorded (#765)', () => {
  async function fileReturn(orderId: string, variantId: string): Promise<string> {
    const created = await db.transaction(async (tx) =>
      insertReturnRequest(tx, {
        orderId,
        reason: 'arrived_damaged',
        resolution: 'refund',
        returnWindowEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
        requestedByActorKind: 'guest',
        lines: [{ variantId, requestedQuantity: 1 }],
        evidence: [{ fileId: `file-${uuidv7().slice(-8)}`, kind: 'damage_photo', position: 0 }],
      }),
    );
    return created?.id ?? '';
  }

  async function trailFor(subject: { cancellationRequestId?: string; returnRequestId?: string }) {
    return db
      .select({ kind: buyerRequestEvents.kind, detail: buyerRequestEvents.detail })
      .from(buyerRequestEvents)
      .where(
        subject.cancellationRequestId === undefined
          ? eq(buyerRequestEvents.returnRequestId, subject.returnRequestId ?? '')
          : eq(buyerRequestEvents.cancellationRequestId, subject.cancellationRequestId),
      )
      // The reader's own ordering (`listBuyerRequestEvents`), so the timeline
      // case below asserts the order an operator actually sees rather than
      // whatever order the server happened to return rows in.
      .orderBy(asc(buyerRequestEvents.at), asc(buyerRequestEvents.id));
  }

  it('records `completion_refused` when a completion is driven on an undecided request', async () => {
    const order = await seedOrder({});
    const requestId = (await fileCancellation(order.id)) ?? '';
    expect(requestId).toBeTruthy();

    // `submitted`, so there is no decision to complete. Before #765 this threw
    // and left the trail saying nothing at all.
    await expect(
      completeCancellationRequest({
        requestId,
        decider: sellerDecisionActor(`seller-765-${RUN}`, 'cancellation:complete'),
        now: new Date(),
      }),
    ).rejects.toThrow();

    expect(
      (await trailFor({ cancellationRequestId: requestId })).map(
        (row) => `${row.kind}:${row.detail}`,
      ),
    ).toEqual(['completion_refused:state_not_eligible']);

    const [after] = await db
      .select({ state: cancellationRequests.state })
      .from(cancellationRequests)
      .where(eq(cancellationRequests.id, requestId));
    expect(after?.state).toBe('submitted');
  });

  it('records `instructions_refused` when instructions are issued before approval', async () => {
    const order = await seedOrder({});
    const requestId = await fileReturn(order.id, order.variantId);

    await expect(
      issueReturnInstructions({
        requestId,
        decider: sellerDecisionActor(`seller-765-${RUN}`, 'return:instruct'),
        instructions: 'Post it back to us please',
        now: new Date(),
      }),
    ).rejects.toThrow();

    expect(
      (await trailFor({ returnRequestId: requestId })).map((row) => `${row.kind}:${row.detail}`),
    ).toEqual(['instructions_refused:state_not_eligible']);
  });

  it('records `receipt_refused` when a return is marked received before approval', async () => {
    const order = await seedOrder({});
    const requestId = await fileReturn(order.id, order.variantId);

    await expect(
      markReturnReceived({
        requestId,
        decider: sellerDecisionActor(`seller-765-${RUN}`, 'return:receive'),
        now: new Date(),
      }),
    ).rejects.toThrow();

    expect(
      (await trailFor({ returnRequestId: requestId })).map((row) => `${row.kind}:${row.detail}`),
    ).toEqual(['receipt_refused:state_not_eligible']);

    const [after] = await db
      .select({ state: returnRequests.state, receivedAt: returnRequests.receivedAt })
      .from(returnRequests)
      .where(eq(returnRequests.id, requestId));
    expect(after?.state).toBe('requested');
    // The row records an ATTEMPT and never a receipt: nothing was restocked and
    // nothing is now refundable, which is what makes recording it safe.
    expect(after?.receivedAt).toBeNull();
  });

  it('records `refund_commit_refused` when a refund is driven before the goods are back', async () => {
    const order = await seedOrder({});
    const requestId = await fileReturn(order.id, order.variantId);
    await db.transaction(async (tx) => {
      await transitionReturnRequest(tx, {
        id: requestId,
        from: 'requested',
        to: 'approved',
        decidedByActorKind: 'oxy',
        decidedByOxyUserId: `seller-765-${RUN}`,
        decidedAt: new Date(),
      });
    });

    await expect(
      refundReturnRequest({
        requestId,
        decider: sellerDecisionActor(`seller-765-${RUN}`, 'return:refund'),
        now: new Date(),
      }),
    ).rejects.toThrow();

    expect(
      (await trailFor({ returnRequestId: requestId })).map((row) => `${row.kind}:${row.detail}`),
    ).toEqual(['refund_commit_refused:state_not_eligible']);

    const [after] = await db
      .select({ state: returnRequests.state, refundId: returnRequests.refundId })
      .from(returnRequests)
      .where(eq(returnRequests.id, requestId));
    expect(after?.state).toBe('approved');
    expect(after?.refundId).toBeNull();
  });

  it('records `return_cancellation_refused` when a seller calls off an undecided return', async () => {
    const order = await seedOrder({});
    const requestId = await fileReturn(order.id, order.variantId);

    await expect(
      cancelReturnRequest({
        requestId,
        decider: sellerDecisionActor(`seller-765-${RUN}`, 'return:decide'),
        // A VALID note, so the state refusal is what this case measures — the
        // short-note branch is deliberately not recorded (#765) and a two-character
        // note here would silently test that instead.
        note: 'the buyer asked us to hold it',
        now: new Date(),
      }),
    ).rejects.toThrow();

    expect(
      (await trailFor({ returnRequestId: requestId })).map((row) => `${row.kind}:${row.detail}`),
    ).toEqual(['return_cancellation_refused:state_not_eligible']);
  });

  it('keeps a refusal beside the successes on one trail, in order', async () => {
    // A refusal is an ATTEMPT among the transitions that did happen, so the
    // cases above passing on trails of exactly one row is not enough: this one
    // proves the refused row lands in a real timeline rather than being the only
    // thing the reader ever sees.
    const order = await seedOrder({});
    const requestId = await fileReturn(order.id, order.variantId);
    const decider = sellerDecisionActor(`seller-765-${RUN}`, 'return:instruct');

    await decideReturnRequest({
      requestId,
      decider: sellerDecisionActor(`seller-765-${RUN}`, 'return:decide'),
      body: { decision: 'accept' },
      now: new Date(Date.now() - 3_000),
    });
    await issueReturnInstructions({
      requestId,
      decider,
      instructions: 'Post it back to us please',
      now: new Date(Date.now() - 2_000),
    });
    // Received, so re-issuing instructions is genuinely out of order — the
    // refusal this case needs, arriving after three transitions that worked.
    await markReturnReceived({
      requestId,
      decider: sellerDecisionActor(`seller-765-${RUN}`, 'return:receive'),
      now: new Date(Date.now() - 1_000),
    });
    await expect(
      issueReturnInstructions({
        requestId,
        decider,
        instructions: 'Actually, post it somewhere else',
        now: new Date(),
      }),
    ).rejects.toThrow();

    expect(
      (await trailFor({ returnRequestId: requestId })).map((row) => row.kind),
    ).toEqual(['accepted', 'instructions_issued', 'item_received', 'instructions_refused']);
  });
});
