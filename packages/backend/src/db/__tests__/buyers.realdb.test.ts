/**
 * The buyer-domain repositories — `addresses`, `reviews`, `user_preferences` —
 * against a REAL Postgres database.
 *
 * `address.service.test.ts`, `review.service.test.ts` and
 * `user-preference.service.test.ts` mock these repositories, which is right for
 * what they test: which error a miss becomes, which fields a DTO carries, which
 * values the service derived. It is also blind to everything below, and the
 * blindness is total — a mocked repository accepts any argument and returns
 * whatever the test says, so a constraint that does not exist, a transaction that
 * is not one, and an aggregate correlated against the wrong column all look
 * identical to a passing suite.
 *
 * Each block here covers something only a server can answer:
 *
 *  - the single-default ADDRESS invariant is a partial unique index now, not a
 *    convention two statements politely observed — and the test asserts the
 *    REFUSAL as well as the happy path, because a repository that simply never
 *    wrote a second default would pass the happy path against no index at all;
 *  - the index is scoped per BUYER, so two buyers holding their own default
 *    simultaneously is permitted — an index written `.on(isDefault)` by mistake
 *    would pass every single-buyer assertion and fail only this one;
 *  - `reviews_target_exclusivity_check` refuses a review naming two targets, an
 *    invariant the Mongoose model stated in prose and enforced nowhere;
 *  - `recomputeAggregate` averages the right ROWS. Two assertions, because
 *    neither catches the other's bug: a target WITH published reviews must not
 *    read as 0 (which is what a query returning nothing produces — drizzle's
 *    bare-column trap, which shipped in a sibling Oxy port), and a target whose
 *    reviews are ALL hidden must read as 0 (which is what a query missing its
 *    status filter gets wrong). A single positive assertion passes the first bug;
 *    a single zero assertion passes the second.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';

/**
 * `recomputeAggregate` lives in `review.service`, whose module graph reaches the
 * queue producers. Nothing in this file enqueues anything, and an unmocked
 * producer would try to reach a Redis this file has no reason to open.
 */
vi.mock('../../queue/producers.js', () => ({
  enqueueRecomputeAggregate: vi.fn(async () => undefined),
  enqueueOrderEvent: vi.fn(async () => undefined),
  enqueueFulfillmentPush: vi.fn(async () => undefined),
  enqueueLowInventoryAlert: vi.fn(async () => undefined),
}));

import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { addresses, sellerProfiles, userPreferences } from '../schema/buyers.js';
import { reviews } from '../schema/reviews.js';
import { listings } from '../schema/catalog.js';
import { deleteTestStores } from './store-teardown.js';
import {
  deleteAddress,
  findAddressesByUser,
  insertAddress,
  updateAddress,
} from '../buyers/addressRepository.js';
import {
  findPublishedReviewTargets,
  insertReview,
  setReviewStatusIfIn,
  type ReviewTarget,
} from '../reviews/reviewRepository.js';
import { upsertUserPreference } from '../buyers/userPreferenceRepository.js';
import { insertStore } from '../stores/storeRepository.js';
import { recomputeAggregate } from '../../services/review.service.js';

let db: Database;

/** Everything this file seeded, dropped after each test — the database is shared. */
const createdStoreIds: string[] = [];
const createdListingIds: string[] = [];
/** Oxy account ids this file invented: address owners, review authors, sellers. */
const createdUserIds: string[] = [];

/** The nine address fields, with only the two the tests vary left to the caller. */
function addressInput(recipientName: string) {
  return {
    recipientName,
    line1: '1 Main St',
    city: 'Town',
    postalCode: '12345',
    country: 'US',
  };
}

/** A fresh Oxy account id, registered for cleanup. */
function makeUserId(role: string): string {
  const id = `realdb-${role}-${uuidv7()}`;
  createdUserIds.push(id);
  return id;
}

/** A P2P listing owned by a freshly-minted seller — no store required. */
async function makeListing(): Promise<string> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: makeUserId('seller'),
      title: 'Realdb reviewed thing',
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
    })
    .returning({ id: listings.id });
  createdListingIds.push(listing.id);
  return listing.id;
}

/** A store, for the one case that needs a real `stores.id` to point at. */
async function makeStore(): Promise<string> {
  // The WHOLE uuid, not a prefix: v7 is time-ordered, so two ids minted in the
  // same millisecond share their leading characters and a truncated suffix
  // collides with `stores_handle_key`.
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `realdb-buyers-${suffix}`,
      name: 'Realdb store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: makeUserId('owner'), role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  return store.id;
}

/** A review row written straight to the table — the status is the point of most of them. */
async function seedReview(values: {
  target: ReviewTarget;
  rating: number;
  status: 'published' | 'hidden';
}): Promise<void> {
  const { target } = values;
  await db.insert(reviews).values({
    authorOxyUserId: makeUserId('buyer'),
    targetType: target.targetType,
    listingId: target.targetType === 'listing' ? target.targetId : null,
    storeId: target.targetType === 'store' ? target.targetId : null,
    sellerOxyUserId: target.targetType === 'seller' ? target.targetId : null,
    rating: values.rating,
    status: values.status,
  });
}

/** How many of this buyer's addresses carry `is_default`. */
async function defaultCount(oxyUserId: string): Promise<number> {
  const rows = await findAddressesByUser(oxyUserId);
  return rows.filter((row) => row.isDefault).length;
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  const userIds = createdUserIds.splice(0);
  if (userIds.length > 0) {
    await db.delete(addresses).where(inArray(addresses.oxyUserId, userIds));
    await db.delete(reviews).where(inArray(reviews.authorOxyUserId, userIds));
    await db.delete(sellerProfiles).where(inArray(sellerProfiles.oxyUserId, userIds));
    await db.delete(userPreferences).where(inArray(userPreferences.oxyUserId, userIds));
  }
  const listingIds = createdListingIds.splice(0);
  if (listingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, listingIds));
  }
  for (const storeId of createdStoreIds.splice(0)) {
    // `listings.store_id` is RESTRICT, so any store listing goes first.
    await db.delete(listings).where(eq(listings.storeId, storeId));
    await deleteTestStores(db, [storeId]);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('the single-default address invariant', () => {
  it('promotes a second address and leaves EXACTLY ONE default', async () => {
    const buyer = makeUserId('buyer');

    const first = await insertAddress(buyer, addressInput('First'));
    const second = await insertAddress(buyer, addressInput('Second'));

    // The buyer's FIRST address is their default; the next one is not.
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    const promoted = await updateAddress(buyer, second.id, { isDefault: true });
    expect(promoted?.isDefault).toBe(true);

    // If the demote and the promote were two independent statements, the partial
    // unique index would have refused this promotion outright — and if the demote
    // ran without the promote, the count would be 0 rather than 1.
    expect(await defaultCount(buyer)).toBe(1);
    const [top] = await findAddressesByUser(buyer);
    expect(top.id).toBe(second.id);
  });

  it('REFUSES two defaults written naively', async () => {
    // The assertion the happy path above cannot make: a repository that simply
    // never wrote a second default would pass it against no index at all. This
    // bypasses the repository and writes the row the old Mongo path could
    // produce, and the index has to be what stops it.
    const buyer = makeUserId('buyer');
    await insertAddress(buyer, addressInput('First'));

    let caught: unknown;
    try {
      await db.insert(addresses).values({
        oxyUserId: buyer,
        ...addressInput('Naive second default'),
        isDefault: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(isUniqueViolation(caught, 'addresses_oxy_user_id_default_key')).toBe(true);
    expect(await defaultCount(buyer)).toBe(1);
  });

  it('lets two buyers each hold their own default simultaneously', async () => {
    // The index is partial on `(oxy_user_id) WHERE is_default`. One written
    // `.on(isDefault)` instead would pass every assertion above and fail here,
    // which is the only reason this case exists.
    const one = makeUserId('buyer');
    const other = makeUserId('buyer');

    const a = await insertAddress(one, addressInput('One'));
    const b = await insertAddress(other, addressInput('Other'));

    expect(a.isDefault).toBe(true);
    expect(b.isDefault).toBe(true);
    expect(await defaultCount(one)).toBe(1);
    expect(await defaultCount(other)).toBe(1);
  });

  it('promotes the newest survivor when the default is deleted', async () => {
    const buyer = makeUserId('buyer');
    const first = await insertAddress(buyer, addressInput('First'));
    const second = await insertAddress(buyer, addressInput('Second'));

    const result = await deleteAddress(buyer, first.id);

    expect(result).toEqual({ deleted: true, promotedId: second.id });
    expect(await defaultCount(buyer)).toBe(1);
  });

  it('does NOT strip the buyer’s default when the promoted address is not theirs', async () => {
    // The clear has to precede the promote (the index refuses the other order),
    // which puts a destructive statement in front of the guard. Without the
    // `SELECT … FOR UPDATE` that answers "is this the buyer's" first, this
    // request clears their default and then matches nothing — leaving them with
    // none, for asking about an address they do not own.
    const buyer = makeUserId('buyer');
    const stranger = makeUserId('buyer');
    await insertAddress(buyer, addressInput('Mine'));
    const theirs = await insertAddress(stranger, addressInput('Theirs'));

    expect(await updateAddress(buyer, theirs.id, { isDefault: true })).toBeNull();

    expect(await defaultCount(buyer)).toBe(1);
    expect(await defaultCount(stranger)).toBe(1);
  });

  it('reports a miss rather than deleting another buyer’s address', async () => {
    const owner = makeUserId('buyer');
    const stranger = makeUserId('buyer');
    const address = await insertAddress(owner, addressInput('Owned'));

    expect(await deleteAddress(stranger, address.id)).toEqual({
      deleted: false,
      promotedId: null,
    });
    expect(await findAddressesByUser(owner)).toHaveLength(1);
  });
});

describe('the review target-exclusivity CHECK', () => {
  it('refuses a review naming both a listing and a store', async () => {
    const listingId = await makeListing();
    const storeId = await makeStore();

    let caught: unknown;
    try {
      await db.insert(reviews).values({
        authorOxyUserId: makeUserId('buyer'),
        targetType: 'listing',
        listingId,
        storeId,
        rating: 5,
      });
    } catch (error) {
      caught = error;
    }

    // Mongoose stated this in prose and enforced it nowhere, so a row naming two
    // targets was accepted and then read back by whichever query reached it first.
    expect(isCheckViolation(caught)).toBe(true);
  });

  it('refuses a review naming NO target at all', async () => {
    let caught: unknown;
    try {
      await db.insert(reviews).values({
        authorOxyUserId: makeUserId('buyer'),
        targetType: 'store',
        rating: 5,
      });
    } catch (error) {
      caught = error;
    }
    expect(isCheckViolation(caught)).toBe(true);
  });

  it('accepts each of the three single-target shapes', async () => {
    // Non-vacuity for the two refusals above: a CHECK that rejected EVERYTHING
    // would satisfy both of them, and this is what tells the two apart.
    const listingId = await makeListing();
    const storeId = await makeStore();
    const sellerId = makeUserId('seller');

    const written = await Promise.all([
      insertReview({
        authorOxyUserId: makeUserId('buyer'),
        targetType: 'listing',
        targetId: listingId,
        rating: 5,
        verification: 'unverified',
        incentiveDisclosure: 'none',
        classificationState: 'unclassified',
      }),
      insertReview({
        authorOxyUserId: makeUserId('buyer'),
        targetType: 'store',
        targetId: storeId,
        rating: 4,
        verification: 'unverified',
        incentiveDisclosure: 'none',
        classificationState: 'unclassified',
      }),
      insertReview({
        authorOxyUserId: makeUserId('buyer'),
        targetType: 'seller',
        targetId: sellerId,
        rating: 3,
        verification: 'unverified',
        incentiveDisclosure: 'none',
        classificationState: 'unclassified',
      }),
    ]);

    // Each row names its own target and NULLs the other two — the shape the
    // repository is responsible for producing, read back off the server.
    expect(written.map((row) => [row.listingId, row.storeId, row.sellerOxyUserId])).toEqual([
      [listingId, null, null],
      [null, storeId, null],
      [null, null, sellerId],
    ]);
    // `status` comes from the column DEFAULT, which the service stopped passing.
    expect(written.every((row) => row.status === 'published')).toBe(true);
  });
});

describe('recomputeAggregate', () => {
  it('averages only the PUBLISHED reviews of THIS target', async () => {
    const listingId = await makeListing();
    const otherListingId = await makeListing();
    const target: ReviewTarget = { targetType: 'listing', targetId: listingId };

    await seedReview({ target, rating: 5, status: 'published' });
    await seedReview({ target, rating: 4, status: 'published' });
    await seedReview({ target, rating: 4, status: 'published' });
    // A hidden review on the SAME target: counted, the average is 3.5 over 4.
    await seedReview({ target, rating: 1, status: 'hidden' });
    // A published review on a DIFFERENT target: counted, the average moves again.
    await seedReview({
      target: { targetType: 'listing', targetId: otherListingId },
      rating: 1,
      status: 'published',
    });

    const result = await recomputeAggregate('listing', listingId);

    // NON-VACUOUS in three directions at once. 13/3 = 4.3333… → 4.3. A query
    // whose correlation renders as a bare column returns nothing and yields
    // `{rating: 0, reviewCount: 0}` with no error at all; one missing the status
    // filter yields 3.5 over 4; one missing the target filter yields 3 over 5.
    expect(result).toEqual({ rating: 4.3, reviewCount: 3 });

    // …and it was PERSISTED, not merely returned.
    const [row] = await db
      .select({ rating: listings.rating, reviewCount: listings.reviewCount })
      .from(listings)
      .where(eq(listings.id, listingId));
    expect(row).toEqual({ rating: 4.3, reviewCount: 3 });
  });

  it('zeroes a target whose reviews are ALL hidden', async () => {
    const listingId = await makeListing();
    const target: ReviewTarget = { targetType: 'listing', targetId: listingId };

    await seedReview({ target, rating: 5, status: 'published' });
    const rated = await recomputeAggregate('listing', listingId);
    // The starting point is deliberately NON-zero: without it, a recompute that
    // never wrote anything would be indistinguishable from one that wrote 0.
    expect(rated).toEqual({ rating: 5, reviewCount: 1 });

    await db
      .update(reviews)
      .set({ status: 'hidden' })
      .where(eq(reviews.listingId, listingId));

    const hidden = await recomputeAggregate('listing', listingId);

    expect(hidden).toEqual({ rating: 0, reviewCount: 0 });
    const [row] = await db
      .select({ rating: listings.rating, reviewCount: listings.reviewCount })
      .from(listings)
      .where(eq(listings.id, listingId));
    expect(row).toEqual({ rating: 0, reviewCount: 0 });
  });

  it('reaches the seller profile, creating it if the review is the first thing to', async () => {
    // The seller branch is the only one that UPSERTS: a seller's first review can
    // arrive before anything else has created their profile.
    const sellerId = makeUserId('seller');
    const target: ReviewTarget = { targetType: 'seller', targetId: sellerId };
    await seedReview({ target, rating: 4, status: 'published' });
    await seedReview({ target, rating: 5, status: 'published' });

    expect(await recomputeAggregate('seller', sellerId)).toEqual({
      rating: 4.5,
      reviewCount: 2,
    });

    const [profile] = await db
      .select({ rating: sellerProfiles.rating, reviewCount: sellerProfiles.reviewCount })
      .from(sellerProfiles)
      .where(eq(sellerProfiles.oxyUserId, sellerId));
    expect(profile).toEqual({ rating: 4.5, reviewCount: 2 });
  });
});

describe('findPublishedReviewTargets — the drift sweep’s work list', () => {
  it('names each target type by the column that holds it, and skips hidden-only ones', async () => {
    const listingId = await makeListing();
    const storeId = await makeStore();
    const sellerId = makeUserId('seller');
    const hiddenOnlyListingId = await makeListing();

    await seedReview({
      target: { targetType: 'listing', targetId: listingId },
      rating: 5,
      status: 'published',
    });
    // Two published reviews on one target must yield ONE entry, not two.
    await seedReview({
      target: { targetType: 'listing', targetId: listingId },
      rating: 3,
      status: 'published',
    });
    await seedReview({
      target: { targetType: 'store', targetId: storeId },
      rating: 4,
      status: 'published',
    });
    await seedReview({
      target: { targetType: 'seller', targetId: sellerId },
      rating: 2,
      status: 'published',
    });
    await seedReview({
      target: { targetType: 'listing', targetId: hiddenOnlyListingId },
      rating: 1,
      status: 'hidden',
    });

    // The database is shared with every other realdb file, so this filters to the
    // targets this test seeded rather than asserting on the whole table.
    const mine = new Set([listingId, storeId, sellerId, hiddenOnlyListingId]);
    const found = (await findPublishedReviewTargets()).filter((t) => mine.has(t.targetId));

    expect([...found].sort((a, b) => a.targetType.localeCompare(b.targetType))).toEqual([
      { targetType: 'listing', targetId: listingId },
      { targetType: 'seller', targetId: sellerId },
      { targetType: 'store', targetId: storeId },
    ]);
  });
});

describe('user_preferences', () => {
  it('upserts on the buyer key and writes a clear as NULL, not an empty string', async () => {
    const buyer = makeUserId('buyer');

    const created = await upsertUserPreference(buyer, {});
    // The column DEFAULTS are what a first-time buyer gets — `setDefaultsOnInsert`
    // has no counterpart here and needs none.
    expect(created.preferredCurrency).toBeNull();
    expect(created.secondaryCurrency).toBeNull();
    expect(created.dualDisplayEnabled).toBe(true);

    const set = await upsertUserPreference(buyer, { secondaryCurrency: 'EUR' });
    // Idempotent under the unique key: the second call updated the SAME row.
    expect(set.id).toBe(created.id);
    expect(set.secondaryCurrency).toBe('EUR');

    const cleared = await upsertUserPreference(buyer, { secondaryCurrency: null });
    expect(cleared.secondaryCurrency).toBeNull();
    // An empty string would satisfy neither the currency CHECK nor any consumer
    // reading "not chosen", so the distinction is asserted rather than assumed.
    expect(cleared.secondaryCurrency).not.toBe('');
  });
});

/**
 * `setReviewStatusIfIn` — the CAS moderation enforcement is built on.
 *
 * This block exists because the property it pins was, until it was written,
 * entirely untested: rewriting the single `UPDATE … WHERE … RETURNING` as a
 * read-then-write left all 793 tests green. That is the shape of a check that
 * cannot fail, and it sat under the one function whose return value decides
 * whether an enforcement row is claimed.
 *
 * The reviews side is where this had to be caught rather than the listing side.
 * `catalog-write.service.updateListing` refuses to move a listing out of
 * `restricted`, so the listing CAS has a second guard behind it; `review.service`
 * has no update path at all, which means this function is the ONLY thing standing
 * between two deliveries of one decision and two recorded enforcements.
 */
describe('setReviewStatusIfIn — the review enforcement CAS', () => {
  /** A published review of a fresh listing, by a fresh author. */
  async function makePublishedReview(): Promise<string> {
    const review = await insertReview({
      authorOxyUserId: makeUserId('buyer'),
      targetType: 'listing',
      targetId: await makeListing(),
      rating: 4,
      verification: 'unverified',
      incentiveDisclosure: 'none',
      classificationState: 'unclassified',
    });
    return review.id;
  }

  it('lets exactly ONE of two concurrent hides win', async () => {
    const reviewId = await makePublishedReview();

    // Two genuinely concurrent calls, which is the only thing that can tell a
    // conditional UPDATE from a read-then-write: both reads see `published`, so
    // the read-then-write form has both callers proceed and both return true.
    // The single statement locks the row, and the loser's predicate is re-checked
    // against the winner's write.
    const [first, second] = await Promise.all([
      setReviewStatusIfIn(reviewId, 'hidden', ['published']),
      setReviewStatusIfIn(reviewId, 'hidden', ['published']),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.status).toBe('hidden');
  });

  it('refuses a redelivered hide, so enforcement is not recorded twice', async () => {
    const reviewId = await makePublishedReview();

    expect(await setReviewStatusIfIn(reviewId, 'hidden', ['published'])).toBe(true);
    // The sequential redelivery — a webhook arriving again days later. `false`
    // is what tells the caller it was NOT the one that acted.
    expect(await setReviewStatusIfIn(reviewId, 'hidden', ['published'])).toBe(false);
  });

  it('restores a hidden review, and refuses to restore one that is not hidden', async () => {
    const reviewId = await makePublishedReview();
    await setReviewStatusIfIn(reviewId, 'hidden', ['published']);

    // The correction path: an accepted appeal puts the review back. This is the
    // direction that matters most — a restore that cannot fire leaves a
    // wrongly-hidden review down forever, with the case saying it was fine.
    expect(await setReviewStatusIfIn(reviewId, 'published', ['hidden'])).toBe(true);

    const [restored] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(restored.status).toBe('published');

    // And a second restore refuses, for the same reason the second hide does.
    expect(await setReviewStatusIfIn(reviewId, 'published', ['hidden'])).toBe(false);
  });

  it('refuses a review whose current status is outside allowedCurrent', async () => {
    const reviewId = await makePublishedReview();

    // `allowedCurrent` is the guard that makes `restrict` and `restore` different
    // operations rather than a toggle. Without it a redelivered `restore` would
    // happily hide-then-unhide whatever state it found.
    expect(await setReviewStatusIfIn(reviewId, 'published', ['hidden'])).toBe(false);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.status).toBe('published');
  });

  it('returns false for a review that does not exist', async () => {
    // Not an error: enforcement runs against objects a seller may have deleted,
    // and "there was nothing to act on" is recorded as evidence rather than
    // retried forever.
    expect(await setReviewStatusIfIn(uuidv7(), 'hidden', ['published'])).toBe(false);
  });
});
