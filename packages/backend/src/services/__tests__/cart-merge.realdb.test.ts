/**
 * The guest→Oxy cart merge, against a REAL PostgreSQL server (#104).
 *
 * Every property this file pins IS a database behaviour, and a mocked drizzle
 * can see none of them: a `FOR UPDATE` lock that actually serializes, a unique
 * index that actually refuses the second merge, a `LEAST(existing + incoming,
 * ceiling)` evaluated at WRITE time against a row another connection inserted,
 * a CHECK that actually refuses an ownerless cart, an append-only TRIGGER, and
 * a transaction that actually rolls the whole thing back. A suite built only on
 * mocks would stay green while the first two concurrent sign-ins doubled a
 * buyer's quantities.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres serves the whole suite and vitest runs files in
 * parallel workers. Every row this file creates is tracked and deleted in
 * `afterEach`, and no assertion counts a whole table.
 *
 * ## Env is set BEFORE any import of the code under test
 *
 * `config/index.ts` reads the environment once at module load and freezes it,
 * and `issueGuestSession` refuses when guest commerce is off — so everything is
 * imported dynamically after `beforeAll` sets the M8 variables.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { isCheckViolation } from '@oxyhq/db';

let db: import('../../db/postgres.js').Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let schema: typeof import('../../db/schema/index.js');
let cartRepo: typeof import('../../db/buyers/cartRepository.js');
let mergeRepo: typeof import('../../db/guests/cartMergeRepository.js');
let sessionRepo: typeof import('../../db/guests/guestSessionRepository.js');
let guestService: typeof import('../guest-session.service.js');
let mergeService: typeof import('../cart-merge.service.js');

const listingIds: string[] = [];
const sessionIds: string[] = [];
const cartIds: string[] = [];
const oxyUserIds: string[] = [];

/** A unique-per-run suffix so parallel workers never collide on an id. */
const RUN = Math.random().toString(36).slice(2, 10);

/**
 * The append-only trigger's refusal, recognised by SQLSTATE rather than text.
 *
 * `isCheckViolation` reads the driver error drizzle carries as `cause`; the
 * trigger raises `ERRCODE = 'check_violation'` deliberately, which is what
 * makes a refusal by trigger indistinguishable at the wire from a refusal by
 * CHECK — and therefore what a caller can rely on.
 */
function isAppendOnlyRefusal(error: unknown): boolean {
  return isCheckViolation(error);
}

beforeAll(async () => {
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'cart-merge-realdb-pii-key';
  process.env.GUEST_EMAIL_HASH_KEY = 'cart-merge-realdb-email-hash-key';
  // Explicit, not assumed: vitest may run several files in one worker thread,
  // and a sibling file sets this to 'false' — env leaks, configs do not.
  process.env.GUEST_SESSION_ISSUANCE_ENABLED = 'true';
  process.env.GUEST_CART_ENABLED = 'true';

  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  schema = await import('../../db/schema/index.js');
  cartRepo = await import('../../db/buyers/cartRepository.js');
  mergeRepo = await import('../../db/guests/cartMergeRepository.js');
  sessionRepo = await import('../../db/guests/guestSessionRepository.js');
  guestService = await import('../guest-session.service.js');
  mergeService = await import('../cart-merge.service.js');
}, 120_000);

afterEach(async () => {
  // Order matters: carts reference sessions, items reference carts and
  // listings. Deleting a listing takes its variants and every cart line with
  // them.
  //
  // `cart_merges` is deliberately NOT cleaned up, and cannot usefully be: the
  // append-only trigger refuses DELETE and the only way to empty the table is
  // TRUNCATE, a TABLE-level statement that would take a sibling file's rows
  // with it under vitest's parallel workers (the `ledger.realdb.test.ts`
  // lesson, learned there the hard way). Every assertion below is instead
  // SCOPED to this run's ids, which is the stronger form anyway — a count over
  // the whole table is one another file can break.
  const sessions = sessionIds.splice(0);
  const carts = cartIds.splice(0);
  const listings = listingIds.splice(0);
  const users = oxyUserIds.splice(0);
  if (carts.length > 0) {
    await db.delete(schema.carts).where(inArray(schema.carts.id, carts));
  }
  if (users.length > 0) {
    // Carts the MERGE created (`ensureCart` on a buyer the test never seeded)
    // have no id the test could have tracked.
    await db.delete(schema.carts).where(inArray(schema.carts.oxyUserId, users));
  }
  if (sessions.length > 0) {
    await db.delete(schema.guestSessions).where(inArray(schema.guestSessions.id, sessions));
  }
  if (listings.length > 0) {
    await db.delete(schema.listings).where(inArray(schema.listings.id, listings));
  }
});

afterAll(async () => {
  await closePostgres();
});

/** A live guest session, tracked for cleanup. */
async function seedSession(): Promise<string> {
  const { session } = await guestService.issueGuestSession({
    clientClass: 'other',
    now: new Date(),
  });
  sessionIds.push(session.id);
  return session.id;
}

/** An Oxy user id, tracked so its merge audit rows are cleaned up. */
function seedOxyUser(label: string): string {
  const id = `merge-buyer-${RUN}-${label}`;
  oxyUserIds.push(id);
  return id;
}

/**
 * An active store-owned listing with one tracked variant.
 *
 * Inserted through the tables rather than a service, so the column defaults
 * apply: this fixture cares about the status, the price and the stock, and
 * spelling out thirty columns it never reads would break whenever the catalogue
 * gains one.
 */
async function seedListing(input: {
  label: string;
  available?: number;
  status?: 'active' | 'draft';
}): Promise<{ listingId: string; variantId: string }> {
  const [listing] = await db
    .insert(schema.listings)
    .values({
      ownerType: 'user',
      oxyUserId: `merge-seller-${RUN}-${input.label}`,
      title: `Merge fixture ${input.label}`,
      description: '',
      condition: 'used_good',
      conditionAssertion: 'seller_declared',
      status: input.status ?? 'active',
    })
    .returning();
  listingIds.push(listing.id);

  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      listingId: listing.id,
      title: 'Default',
      priceAmount: 1_000,
      priceCurrency: 'FAIR',
      inventoryTracked: true,
      inventoryAvailable: input.available ?? 50,
      position: 0,
    })
    .returning();

  return { listingId: listing.id, variantId: variant.id };
}

/** A cart for an owner, with the given lines, tracked for cleanup. */
async function seedCart(
  owner: import('../../db/buyers/cartRepository.js').CartOwner,
  lines: { listingId: string; variantId: string; quantity: number; addedAt?: Date }[],
  pendingDiscountCodes: string[] = [],
): Promise<string> {
  const cart = await cartRepo.ensureCart(owner);
  cartIds.push(cart.id);
  for (const line of lines) {
    await db.insert(schema.cartItems).values({
      cartId: cart.id,
      listingId: line.listingId,
      variantId: line.variantId,
      quantity: line.quantity,
      addedAt: line.addedAt ?? new Date(),
    });
  }
  if (pendingDiscountCodes.length > 0) {
    await cartRepo.setPendingDiscountCodes(cart.id, pendingDiscountCodes);
  }
  return cart.id;
}

/** The target cart's lines, oldest first. */
async function oxyCartLines(oxyUserId: string) {
  const cart = await cartRepo.findCartByOwner({ kind: 'oxy_user', oxyUserId });
  return cart?.items ?? [];
}

describe('ownership is enforced by the database, not by convention', () => {
  it('refuses a cart with two owners and a cart with none', async () => {
    const guestSessionId = await seedSession();

    const twoOwners = db
      .insert(schema.carts)
      .values({ oxyUserId: seedOxyUser('two-owners'), guestSessionId })
      .returning();
    await expect(twoOwners).rejects.toSatisfy(isCheckViolation);

    // `num_nonnulls(...) = 1` is what refuses this one, and it is worth its own
    // assertion: a CHECK written `<= 1` would pass the case above and fail here.
    const noOwner = db.insert(schema.carts).values({}).returning();
    await expect(noOwner).rejects.toSatisfy(isCheckViolation);
  });

  it('allows one cart per owner of EACH kind, and refuses a second', async () => {
    const oxyUserId = seedOxyUser('one-per-owner');
    const guestSessionId = await seedSession();

    const first = await cartRepo.ensureCart({ kind: 'oxy_user', oxyUserId });
    cartIds.push(first.id);
    const guest = await cartRepo.ensureCart({ kind: 'guest_session', guestSessionId });
    cartIds.push(guest.id);

    // `ensureCart` CONVERGES rather than raising — the partial unique index is
    // what makes the `ON CONFLICT` arbiter resolvable at all, and the whole
    // reason the conflict target repeats the index predicate.
    expect((await cartRepo.ensureCart({ kind: 'oxy_user', oxyUserId })).id).toBe(first.id);
    expect((await cartRepo.ensureCart({ kind: 'guest_session', guestSessionId })).id).toBe(guest.id);

    // …and the index really refuses a raw second insert, which is the property
    // `ensureCart` converging would otherwise hide.
    await expect(
      db.insert(schema.carts).values({ oxyUserId }).returning(),
    ).rejects.toThrow();
  });

  it('cascades a guest cart away with its session — retention is schema, not sweep code', async () => {
    const guestSessionId = await seedSession();
    const { listingId, variantId } = await seedListing({ label: 'cascade' });
    const cartId = await seedCart({ kind: 'guest_session', guestSessionId }, [
      { listingId, variantId, quantity: 2 },
    ]);

    await db.delete(schema.guestSessions).where(eq(schema.guestSessions.id, guestSessionId));

    const carts = await db.select().from(schema.carts).where(eq(schema.carts.id, cartId));
    const items = await db.select().from(schema.cartItems).where(eq(schema.cartItems.cartId, cartId));
    expect(carts).toHaveLength(0);
    expect(items).toHaveLength(0);
  });
});

describe('an existing Oxy cart is untouched by the ownership migration', () => {
  it('round-trips its item ids, quantities and pending discount codes unchanged', async () => {
    const oxyUserId = seedOxyUser('legacy');
    const { listingId, variantId } = await seedListing({ label: 'legacy' });
    const cartId = await seedCart(
      { kind: 'oxy_user', oxyUserId },
      [{ listingId, variantId, quantity: 4 }],
      ['SAVE10'],
    );

    const cart = await cartRepo.findCartByOwner({ kind: 'oxy_user', oxyUserId });
    expect(cart?.id).toBe(cartId);
    expect(cart?.guestSessionId).toBeNull();
    expect(cart?.pendingDiscountCodes).toEqual(['SAVE10']);
    expect(cart?.items).toHaveLength(1);
    expect(cart?.items[0].quantity).toBe(4);
    // The line carries no review flag: nothing merged into this cart, and a
    // default other than NULL would flag every legacy line in production.
    expect(cart?.items[0].mergeReviewReason).toBeNull();
  });
});

describe('the merge itself', () => {
  it('sums a shared variant, keeps the earliest addedAt, revokes and converts the session', async () => {
    const oxyUserId = seedOxyUser('sum');
    const guestSessionId = await seedSession();
    const { listingId, variantId } = await seedListing({ label: 'sum', available: 50 });

    const early = new Date('2026-01-01T00:00:00.000Z');
    const late = new Date('2026-02-01T00:00:00.000Z');
    cartIds.push(await seedCart({ kind: 'guest_session', guestSessionId }, [
      { listingId, variantId, quantity: 3, addedAt: early },
    ]));
    cartIds.push(await seedCart({ kind: 'oxy_user', oxyUserId }, [
      { listingId, variantId, quantity: 2, addedAt: late },
    ]));

    const result = await mergeService.mergeGuestCart({ guestSessionId, oxyUserId });

    expect(result.merged).toBe(true);
    expect(result.linesCombined).toBe(1);
    expect(result.linesAdded).toBe(0);
    expect(result.linesClamped).toBe(0);

    const lines = await oxyCartLines(oxyUserId);
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(5);
    // The EARLIEST of the two, so the merged cart's order is stable however the
    // two carts interleaved.
    expect(lines[0].addedAt.toISOString()).toBe(early.toISOString());

    // The guest cart is GONE, not emptied — an empty cart still pointing at a
    // converted session is exactly the inconsistency the operator check hunts.
    expect(await cartRepo.findCartByOwner({ kind: 'guest_session', guestSessionId })).toBeNull();

    const session = await sessionRepo.findGuestSessionById(db, guestSessionId);
    expect(session?.convertedAt).not.toBeNull();
    expect(session?.convertedToOxyUserId).toBe(oxyUserId);
    // Sign-in REVOKES rather than upgrading (ADR 0003 D3), and the CHECK makes
    // a converted-but-live session unrepresentable.
    expect(session?.revokedAt).not.toBeNull();

    expect(await sessionRepo.findConvertedSessionsWithCarts(db, 10)).toEqual([]);
  });

  it('clamps to live stock and FLAGS the line rather than silently shrinking it', async () => {
    const oxyUserId = seedOxyUser('clamp');
    const guestSessionId = await seedSession();
    const { listingId, variantId } = await seedListing({ label: 'clamp', available: 4 });

    cartIds.push(await seedCart({ kind: 'guest_session', guestSessionId }, [
      { listingId, variantId, quantity: 3 },
    ]));
    cartIds.push(await seedCart({ kind: 'oxy_user', oxyUserId }, [
      { listingId, variantId, quantity: 3 },
    ]));

    const result = await mergeService.mergeGuestCart({ guestSessionId, oxyUserId });

    expect(result.linesClamped).toBe(1);
    expect(result.linesFlagged).toBe(1);
    expect(result.reasons).toContain('quantity_clamped_to_stock');

    const lines = await oxyCartLines(oxyUserId);
    // 3 + 3 = 6, clamped to the live 4 — and the flag is the DATABASE's verdict,
    // written by the same expression that applied the clamp.
    expect(lines[0].quantity).toBe(4);
    expect(lines[0].mergeReviewReason).toBe('quantity_clamped_to_stock');
  });

  it('KEEPS an out-of-stock line as one flagged unit rather than dropping it', async () => {
    const oxyUserId = seedOxyUser('oos');
    const guestSessionId = await seedSession();
    const { listingId, variantId } = await seedListing({ label: 'oos', available: 0 });

    cartIds.push(await seedCart({ kind: 'guest_session', guestSessionId }, [
      { listingId, variantId, quantity: 2 },
    ]));

    const result = await mergeService.mergeGuestCart({ guestSessionId, oxyUserId });

    expect(result.linesAdded).toBe(1);
    expect(result.reasons).toContain('listing_unavailable');

    const lines = await oxyCartLines(oxyUserId);
    // The whole point of #104 acceptance 6: no item disappears silently. A zero
    // quantity is unrepresentable, so the line survives as one flagged unit —
    // which hydration marks `stale` and checkout refuses, so nothing oversells.
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(1);
    expect(lines[0].mergeReviewReason).toBe('listing_unavailable');
  });

  it('carries a line whose listing is no longer sellable, flagged', async () => {
    const oxyUserId = seedOxyUser('draft');
    const guestSessionId = await seedSession();
    const { listingId, variantId } = await seedListing({ label: 'draft', status: 'draft' });

    cartIds.push(await seedCart({ kind: 'guest_session', guestSessionId }, [
      { listingId, variantId, quantity: 1 },
    ]));

    await mergeService.mergeGuestCart({ guestSessionId, oxyUserId });

    const lines = await oxyCartLines(oxyUserId);
    expect(lines).toHaveLength(1);
    expect(lines[0].mergeReviewReason).toBe('listing_unavailable');
  });

  it('drops a guest discount code that no longer applies, and says so', async () => {
    const oxyUserId = seedOxyUser('discount');
    const guestSessionId = await seedSession();
    const { listingId, variantId } = await seedListing({ label: 'discount' });

    cartIds.push(await seedCart(
      { kind: 'guest_session', guestSessionId },
      [{ listingId, variantId, quantity: 1 }],
      ['NOSUCHCODE'],
    ));

    const result = await mergeService.mergeGuestCart({ guestSessionId, oxyUserId });

    // The fixture's listing is P2P (`ownerType: 'user'`), so there is no store
    // for a code to belong to — the conservative answer is to drop it with a
    // reason rather than carry an intent checkout would refuse.
    expect(result.discountCodesAdded).toBe(0);
    expect(result.discountCodesDropped).toBe(1);
    expect(result.reasons).toContain('discount_code_dropped');

    const cart = await cartRepo.findCartByOwner({ kind: 'oxy_user', oxyUserId });
    expect(cart?.pendingDiscountCodes).toEqual([]);
  });

  it('records ONE audit row with the counts, and refuses to let it be edited', async () => {
    const oxyUserId = seedOxyUser('audit');
    const guestSessionId = await seedSession();
    const { listingId, variantId } = await seedListing({ label: 'audit' });

    cartIds.push(await seedCart({ kind: 'guest_session', guestSessionId }, [
      { listingId, variantId, quantity: 2 },
    ]));

    await mergeService.mergeGuestCart({ guestSessionId, oxyUserId });

    const row = await mergeRepo.findCartMergeByGuestSession(db, guestSessionId);
    expect(row?.linesAdded).toBe(1);
    expect(row?.oxyUserId).toBe(oxyUserId);

    // Append-only, by TRIGGER — so a counter cannot be quietly corrected and any
    // aggregate over these rows stays recomputable from the events themselves.
    //
    // Asserted on the `check_violation` SQLSTATE the trigger raises rather than
    // on its message: drizzle wraps a driver error in its own `Failed query: …`
    // and the original is the `cause`, so a `toThrow(/append-only/)` here
    // passes only by accident of which layer happens to stringify. The code is
    // what the trigger actually promises.
    await expect(
      db
        .update(schema.cartMerges)
        .set({ linesAdded: 99 })
        .where(eq(schema.cartMerges.guestSessionId, guestSessionId)),
    ).rejects.toSatisfy(isAppendOnlyRefusal);
    await expect(
      db.delete(schema.cartMerges).where(eq(schema.cartMerges.guestSessionId, guestSessionId)),
    ).rejects.toSatisfy(isAppendOnlyRefusal);

    // The row is untouched by both attempts.
    const after = await mergeRepo.findCartMergeByGuestSession(db, guestSessionId);
    expect(after?.linesAdded).toBe(1);
  });
});

describe('exactly once, under concurrent retries (acceptance 4)', () => {
  it('merges once when two requests race, and the loser converges on the same result', async () => {
    const oxyUserId = seedOxyUser('race');
    const guestSessionId = await seedSession();
    const { listingId, variantId } = await seedListing({ label: 'race', available: 50 });

    cartIds.push(await seedCart({ kind: 'guest_session', guestSessionId }, [
      { listingId, variantId, quantity: 3 },
    ]));

    const [a, b] = await Promise.all([
      mergeService.mergeGuestCart({ guestSessionId, oxyUserId }),
      mergeService.mergeGuestCart({ guestSessionId, oxyUserId }),
    ]);

    // EXACTLY one did the work. Mutation-tested rather than assumed: removing
    // BOTH `FOR UPDATE` locks (the session row and the guest cart row) makes
    // this assertion fail with a quantity of 6 where 3 is correct, because the
    // two transactions then both read `converted_at` as NULL and both move the
    // lines. Removing only ONE leaves it green — the locks are independently
    // sufficient here — which is why the service's docblock says so out loud
    // rather than claiming a single load-bearing lock.
    expect([a.merged, b.merged].filter(Boolean)).toHaveLength(1);

    const lines = await oxyCartLines(oxyUserId);
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(3);

    // Both callers see the same counts — "a repeated merge request returns the
    // same result", asserted on the numbers rather than on the flag.
    expect(a.linesAdded).toBe(b.linesAdded);
    expect(a.linesCombined).toBe(b.linesCombined);
    // …and exactly one audit row exists for the session.
    expect(await mergeRepo.findCartMerges({ guestSessionId }, 10)).toHaveLength(1);
  });

  it('a THIRD attempt after the credential is revoked still converges, changing nothing', async () => {
    const oxyUserId = seedOxyUser('third');
    const guestSessionId = await seedSession();
    const { listingId, variantId } = await seedListing({ label: 'third', available: 50 });

    cartIds.push(await seedCart({ kind: 'guest_session', guestSessionId }, [
      { listingId, variantId, quantity: 2 },
    ]));

    const first = await mergeService.mergeGuestCart({ guestSessionId, oxyUserId });
    const retry = await mergeService.mergeGuestCart({ guestSessionId, oxyUserId });

    expect(first.merged).toBe(true);
    expect(retry.merged).toBe(false);
    expect(retry.reasons).toContain('already_converted');
    expect(retry.linesAdded).toBe(first.linesAdded);

    const lines = await oxyCartLines(oxyUserId);
    expect(lines[0].quantity).toBe(2);
    expect(await mergeRepo.findCartMerges({ guestSessionId }, 10)).toHaveLength(1);
  });

  it('a revoked guest session cannot go on owning a mutable cart (acceptance 7)', async () => {
    const oxyUserId = seedOxyUser('revoked');
    const guestSessionId = await seedSession();
    const { listingId, variantId } = await seedListing({ label: 'revoked' });

    cartIds.push(await seedCart({ kind: 'guest_session', guestSessionId }, [
      { listingId, variantId, quantity: 1 },
    ]));

    await mergeService.mergeGuestCart({ guestSessionId, oxyUserId });

    // Two halves, and neither implies the other. The credential no longer
    // resolves, so the resolver cannot even produce a guest actor for it…
    const session = await sessionRepo.findGuestSessionById(db, guestSessionId);
    expect(session && guestService.guestSessionStatus(session, new Date())).toBe('converted');
    // …and the cart it owned does not exist, so a caller who somehow held a
    // live credential would still find nothing to mutate.
    expect(await cartRepo.findCartByOwner({ kind: 'guest_session', guestSessionId })).toBeNull();
  });
});

describe('a failed merge is recoverable (acceptance 8)', () => {
  it('rolls BOTH carts and the session back when the transaction fails', async () => {
    const oxyUserId = seedOxyUser('rollback');
    const guestSessionId = await seedSession();
    const { listingId, variantId } = await seedListing({ label: 'rollback' });

    const guestCartId = await seedCart({ kind: 'guest_session', guestSessionId }, [
      { listingId, variantId, quantity: 3 },
    ]);
    cartIds.push(guestCartId);
    cartIds.push(await seedCart({ kind: 'oxy_user', oxyUserId }, [
      { listingId, variantId, quantity: 1 },
    ]));

    // Fail the transaction at its LAST step by making the audit insert violate
    // its own reason CHECK — a realistic shape (a vocabulary drift) that lands
    // after every cart write has already happened, which is the only failure
    // point at which "both carts recoverable" is a non-trivial claim.
    await expect(
      db.transaction(async (tx) => {
        await cartRepo.deleteCart(guestCartId, tx);
        await tx.insert(schema.cartMerges).values({
          guestSessionId,
          oxyUserId,
          targetCartId: guestCartId,
          reasons: ['not_a_real_reason'],
        });
      }),
    ).rejects.toSatisfy(isCheckViolation);

    // Both carts survive with their lines, and the session is still LIVE — so
    // the person can simply sign in again and merge for real.
    const guestCart = await cartRepo.findCartByOwner({ kind: 'guest_session', guestSessionId });
    expect(guestCart?.items[0].quantity).toBe(3);
    expect((await oxyCartLines(oxyUserId))[0].quantity).toBe(1);

    const session = await sessionRepo.findGuestSessionById(db, guestSessionId);
    expect(session?.convertedAt).toBeNull();
    expect(session?.revokedAt).toBeNull();
    expect(await mergeRepo.findCartMergeByGuestSession(db, guestSessionId)).toBeUndefined();

    // And the real merge then works, which is what "recoverable" has to mean.
    const result = await mergeService.mergeGuestCart({ guestSessionId, oxyUserId });
    expect(result.merged).toBe(true);
    expect((await oxyCartLines(oxyUserId))[0].quantity).toBe(4);
  });
});

describe('a merge with nothing to merge', () => {
  it('still converts the session, and says why', async () => {
    const oxyUserId = seedOxyUser('nothing');
    const guestSessionId = await seedSession();

    const result = await mergeService.mergeGuestCart({ guestSessionId, oxyUserId });

    expect(result.merged).toBe(true);
    expect(result.reasons).toEqual(['no_guest_cart']);
    expect(result.cart.items).toEqual([]);

    // The session's purpose is over whether or not it held a cart, so it is
    // converted either way — otherwise a person who signed in with an empty
    // guest session would keep a live credential nothing will ever use.
    const session = await sessionRepo.findGuestSessionById(db, guestSessionId);
    expect(session?.convertedAt).not.toBeNull();

    // The target cart is ENSURED even with nothing to put in it, so the merge
    // has a cart id to record and the buyer's next add finds a row waiting.
    const cart = await cartRepo.findCartByOwner({ kind: 'oxy_user', oxyUserId });
    expect(cart).not.toBeNull();
    if (cart) cartIds.push(cart.id);
  });
});
