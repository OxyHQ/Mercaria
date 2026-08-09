/**
 * `guest_checkouts` and the buyer-origin widening on `orders`, against a REAL
 * Postgres server (#105, ADR 0003 D4/D6).
 *
 * Every property asserted here IS a database property and has no mocked
 * counterpart — the blind spot `AGENTS.md` names: a mocked `insert` accepts any
 * statement, including one the server rejects outright. A partial unique index,
 * a multi-column CHECK, an `ON CONFLICT … DO NOTHING` that must be a genuine
 * no-op, a `restrict` foreign key and two BEFORE-UPDATE triggers do not exist
 * without a server.
 *
 * Rows are scoped by a per-run id suffix rather than truncated: sibling test
 * files share this database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';

const RUN = Math.random().toString(36).slice(2, 10);

let db: import('../../postgres.js').Database;
let closePostgres: typeof import('../../postgres.js').closePostgres;
let schema: typeof import('../../schema/index.js');
let ensureGuestCheckout: typeof import('../guestCheckoutRepository.js').ensureGuestCheckout;
let findGuestCheckoutByGroup: typeof import('../guestCheckoutRepository.js').findGuestCheckoutByGroup;
let setGuestCheckoutVerificationStage: typeof import('../guestCheckoutRepository.js').setGuestCheckoutVerificationStage;

const createdGroupIds: string[] = [];
const createdOrderIds: string[] = [];

beforeAll(async () => {
  const postgres = await import('../../postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  schema = await import('../../schema/index.js');
  ({ ensureGuestCheckout, findGuestCheckoutByGroup, setGuestCheckoutVerificationStage } =
    await import('../guestCheckoutRepository.js'));
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
 * The shape `fee-schedules.realdb.test.ts` established, and it exists because
 * drizzle wraps the driver error: the top-level `message` is
 * `Failed query: …` and the constraint name lives on `cause`. Matching only the
 * outer message would pass for ANY failed statement — a check that cannot tell
 * success from failure is worse than no check.
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

/** A contact row input; every field is fake ciphertext, never a real key. */
function contactInput(checkoutGroupId: string, email = 'j***@example.com') {
  createdGroupIds.push(checkoutGroupId);
  return {
    checkoutGroupId,
    guestSessionId: `gs-${RUN}`,
    emailCiphertext: `v1:iv:tag:ct-${RUN}`,
    emailHash: `hash-${RUN}-${checkoutGroupId.slice(0, 8)}`,
    emailRedacted: email,
    marketingOptIn: false,
  };
}

describe('one contact identity per checkout GROUP', () => {
  it('creates the row and converges on a repeat instead of rewriting it', async () => {
    const groupId = uuidv7();
    const first = await ensureGuestCheckout(db, contactInput(groupId));
    expect(first.checkoutGroupId).toBe(groupId);

    // A retry carrying a DIFFERENT email must not replace the contact a placed
    // order was made with. `ON CONFLICT … DO NOTHING` plus a read is what makes
    // that structural rather than a rule.
    const [{ xmin: xminBefore }] = await db
      .select({ xmin: sql<string>`${schema.guestCheckouts}.xmin::text` })
      .from(schema.guestCheckouts)
      .where(eq(schema.guestCheckouts.id, first.id));

    const second = await ensureGuestCheckout(db, {
      ...contactInput(groupId),
      emailCiphertext: 'v1:iv:tag:DIFFERENT',
      emailRedacted: 'z***@elsewhere.test',
    });
    expect(second.id).toBe(first.id);
    expect(second.emailCiphertext).toBe(first.emailCiphertext);
    expect(second.emailRedacted).toBe(first.emailRedacted);

    // The row version did not move: the repeat wrote NOTHING at all — no tuple
    // version, no timestamp, no lock. `updated_at` alone would not catch a
    // `DO UPDATE` careful enough to leave every column the same; `xmin` would.
    const [{ xmin: xminAfter }] = await db
      .select({ xmin: sql<string>`${schema.guestCheckouts}.xmin::text` })
      .from(schema.guestCheckouts)
      .where(eq(schema.guestCheckouts.id, first.id));
    expect(xminAfter).toBe(xminBefore);
  });

  it('refuses a SECOND row for the same group through the unique index', async () => {
    const groupId = uuidv7();
    await ensureGuestCheckout(db, contactInput(groupId));
    await expectPgRejection(db.insert(schema.guestCheckouts).values({
        checkoutGroupId: groupId,
        guestSessionId: `gs-other-${RUN}`,
        emailCiphertext: 'v1:iv:tag:other',
        emailHash: `hash-other-${RUN}`,
        emailRedacted: 'o***@example.com',
      }), /guest_checkouts_checkout_group_id_key/);
  });
});

describe('the contact CHECKs', () => {
  it('refuses a ciphertext with no hash (the pair travels together)', async () => {
    await expectPgRejection(db.insert(schema.guestCheckouts).values({
        checkoutGroupId: uuidv7(),
        guestSessionId: `gs-${RUN}`,
        emailCiphertext: 'v1:iv:tag:ct',
        emailRedacted: 'j***@example.com',
      }), /guest_checkouts_email_pair_check/);
  });

  it('refuses an anonymized stamp beside a readable contact', async () => {
    await expectPgRejection(db.insert(schema.guestCheckouts).values({
        checkoutGroupId: uuidv7(),
        guestSessionId: `gs-${RUN}`,
        emailCiphertext: 'v1:iv:tag:ct',
        emailHash: 'h',
        emailRedacted: 'j***@example.com',
        anonymizedAt: new Date(),
      }), /guest_checkouts_anonymization_check/);
  });

  it('refuses an unknown verification stage', async () => {
    await expectPgRejection(db.insert(schema.guestCheckouts).values({
        checkoutGroupId: uuidv7(),
        guestSessionId: `gs-${RUN}`,
        emailCiphertext: 'v1:iv:tag:ct',
        emailHash: 'h',
        emailRedacted: 'j***@example.com',
        contactVerificationStage: 'verified_by_vibes' as never,
      }), /guest_checkouts_contact_verification_stage_check/);
  });
});

describe('the immutability trigger (ADR 0003 D4)', () => {
  it('refuses re-pointing a placed group at another inbox', async () => {
    const groupId = uuidv7();
    const row = await ensureGuestCheckout(db, contactInput(groupId));
    await expectPgRejection(db
        .update(schema.guestCheckouts)
        .set({ emailCiphertext: 'v1:iv:tag:ATTACKER' })
        .where(eq(schema.guestCheckouts.id, row.id)), /contact may only change to NULL/);
  });

  it('refuses moving the row to another group or another session', async () => {
    const groupId = uuidv7();
    const row = await ensureGuestCheckout(db, contactInput(groupId));
    await expectPgRejection(db
        .update(schema.guestCheckouts)
        .set({ checkoutGroupId: uuidv7() })
        .where(eq(schema.guestCheckouts.id, row.id)), /checkout_group_id is immutable/);
    await expectPgRejection(db
        .update(schema.guestCheckouts)
        .set({ guestSessionId: 'gs-someone-else' })
        .where(eq(schema.guestCheckouts.id, row.id)), /guest_session_id is immutable/);
  });

  it('PERMITS the anonymization transition and the verification stage move', async () => {
    const groupId = uuidv7();
    const row = await ensureGuestCheckout(db, contactInput(groupId));

    const staged = await setGuestCheckoutVerificationStage(
      db,
      groupId,
      'verified_before_payment',
    );
    expect(staged?.contactVerificationStage).toBe('verified_before_payment');

    await db
      .update(schema.guestCheckouts)
      .set({
        emailCiphertext: null,
        emailHash: null,
        phoneCiphertext: null,
        phoneRedacted: null,
        emailRedacted: 'deleted',
        anonymizedAt: new Date(),
      })
      .where(eq(schema.guestCheckouts.id, row.id));

    const after = await findGuestCheckoutByGroup(db, groupId);
    expect(after?.emailCiphertext).toBeNull();
    expect(after?.emailRedacted).toBe('deleted');
    expect(after?.anonymizedAt).not.toBeNull();
  });
});

describe('the buyer identity on orders (ADR 0003 D6)', () => {
  /** The minimum `orders` row the CHECK cares about; money is irrelevant here. */
  function orderValues(overrides: Record<string, unknown>) {
    const money = { shop: 0, presentment: 0 };
    const dual = (prefix: string) => ({
      [`${prefix}ShopAmount`]: money.shop,
      [`${prefix}ShopCurrency`]: 'FAIR',
      [`${prefix}PresentmentAmount`]: money.presentment,
      [`${prefix}PresentmentCurrency`]: 'FAIR',
    });
    return {
      orderNumber: `MRC-T${RUN}-${Math.floor(Math.random() * 1_000_000)}`,
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

  it('refuses a guest order carrying an Oxy id (invariant I1 at the storage layer)', async () => {
    const groupId = uuidv7();
    const contact = await ensureGuestCheckout(db, contactInput(groupId));
    await expectPgRejection(db.insert(schema.orders).values(
        orderValues({
          buyerOrigin: 'guest',
          buyerGuestCheckoutId: contact.id,
          buyerOxyUserId: `smuggled-${RUN}`,
        }) as never,
      ), /orders_buyer_identity_check/);
  });

  it('refuses an oxy order carrying a guest contact', async () => {
    const groupId = uuidv7();
    const contact = await ensureGuestCheckout(db, contactInput(groupId));
    await expectPgRejection(db.insert(schema.orders).values(
        orderValues({
          buyerOrigin: 'oxy',
          buyerOxyUserId: `buyer-${RUN}`,
          buyerGuestCheckoutId: contact.id,
        }) as never,
      ), /orders_buyer_identity_check/);
  });

  it('refuses a guest order with NO contact record at all', async () => {
    await expectPgRejection(db.insert(schema.orders).values(orderValues({ buyerOrigin: 'guest' }) as never), /orders_buyer_identity_check/);
  });

  it('accepts a well-formed guest order and refuses deleting its contact', async () => {
    const groupId = uuidv7();
    const contact = await ensureGuestCheckout(db, contactInput(groupId));
    const [order] = await db
      .insert(schema.orders)
      .values(
        orderValues({ buyerOrigin: 'guest', buyerGuestCheckoutId: contact.id }) as never,
      )
      .returning({ id: schema.orders.id });
    createdOrderIds.push(order.id);

    // `ON DELETE restrict`: an order is the record of a sale and cannot be
    // orphaned from the contact it was placed with. Erasure is anonymization,
    // never a delete.
    await expectPgRejection(db.delete(schema.guestCheckouts).where(eq(schema.guestCheckouts.id, contact.id)), /orders_buyer_guest_checkout_id_guest_checkouts_id_fk/);
  });

  it('refuses rewriting a placed order origin, but allows an ordinary status update', async () => {
    const groupId = uuidv7();
    const contact = await ensureGuestCheckout(db, contactInput(groupId));
    const [order] = await db
      .insert(schema.orders)
      .values(
        orderValues({ buyerOrigin: 'guest', buyerGuestCheckoutId: contact.id }) as never,
      )
      .returning({ id: schema.orders.id });
    createdOrderIds.push(order.id);

    await expectPgRejection(db
        .update(schema.orders)
        .set({ buyerOrigin: 'oxy' })
        .where(eq(schema.orders.id, order.id)), /buyer_origin is immutable/);

    await expectPgRejection(db
        .update(schema.orders)
        .set({ buyerGuestCheckoutId: null })
        .where(eq(schema.orders.id, order.id)), /buyer_guest_checkout_id is immutable/);

    // The trigger must not break ordinary commerce: an order moves through its
    // lifecycle constantly, and a guard that blocked that would be discovered
    // in production rather than here.
    await db
      .update(schema.orders)
      .set({ status: 'cancelled' })
      .where(eq(schema.orders.id, order.id));
    const [after] = await db
      .select({ status: schema.orders.status, origin: schema.orders.buyerOrigin })
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    expect(after.status).toBe('cancelled');
    expect(after.origin).toBe('guest');
  });

  it('refuses reassigning a SET buyer_oxy_user_id on an ordinary order', async () => {
    const [order] = await db
      .insert(schema.orders)
      .values(
        orderValues({ buyerOrigin: 'oxy', buyerOxyUserId: `buyer-${RUN}` }) as never,
      )
      .returning({ id: schema.orders.id });
    createdOrderIds.push(order.id);

    await expectPgRejection(db
        .update(schema.orders)
        .set({ buyerOxyUserId: `attacker-${RUN}` })
        .where(eq(schema.orders.id, order.id)), /cannot be reassigned/);
  });
});
