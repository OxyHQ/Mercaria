/**
 * Unit tests for `collection.service` — collection membership materialization.
 *
 * The repositories are mocked, so what is under test is the SERVICE's decisions:
 * which membership write a collection's TYPE selects, that a per-listing recompute
 * touches only the store's AUTOMATED collections (leaving hand-picked memberships
 * alone), that a manual set preserves the caller's order and validates its ids,
 * and that a duplicate handle becomes a CONFLICT.
 *
 * What is deliberately NOT here any more: the old suite asserted the exact Mongo
 * predicates (`$addToSet`/`$pull` filter shapes) that materialization emitted.
 * Those are SQL now, and asserting a rendered predicate against a mock proves
 * only that the string did not change. The rule translator and the set-diff are
 * checked against a REAL server in `db/__tests__/catalog.realdb.test.ts`, where a
 * predicate that matches nothing fails instead of passing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findCollectionById = vi.fn();
const findCollectionsByStore = vi.fn();
const findAutomatedCollections = vi.fn();
const insertCollection = vi.fn();
const updateCollectionRow = vi.fn();
const deleteCollectionRow = vi.fn();
const replaceManualMembership = vi.fn().mockResolvedValue(undefined);
const reconcileAutomatedMembership = vi.fn().mockResolvedValue(undefined);
const setListingAutomatedMemberships = vi.fn().mockResolvedValue(undefined);
const findManualMemberIds = vi.fn().mockResolvedValue([]);
const findManualMemberIdsByCollection = vi.fn().mockResolvedValue(new Map());
const findCollectionProductsPage = vi.fn();

const findListingById = vi.fn();
const findStoreListingIdsMatching = vi.fn();
const findUnknownStoreListingIds = vi.fn();
const listingMatchesRules = vi.fn();

vi.mock('../../db/merchandising/collectionRepository.js', () => ({
  findCollectionById: (...a: unknown[]) => findCollectionById(...a),
  findCollectionsByStore: (...a: unknown[]) => findCollectionsByStore(...a),
  findCollectionByHandle: vi.fn(),
  findAutomatedCollections: (...a: unknown[]) => findAutomatedCollections(...a),
  insertCollection: (...a: unknown[]) => insertCollection(...a),
  updateCollection: (...a: unknown[]) => updateCollectionRow(...a),
  deleteCollection: (...a: unknown[]) => deleteCollectionRow(...a),
  replaceManualMembership: (...a: unknown[]) => replaceManualMembership(...a),
  reconcileAutomatedMembership: (...a: unknown[]) => reconcileAutomatedMembership(...a),
  setListingAutomatedMemberships: (...a: unknown[]) => setListingAutomatedMemberships(...a),
  findManualMemberIds: (...a: unknown[]) => findManualMemberIds(...a),
  findManualMemberIdsByCollection: (...a: unknown[]) => findManualMemberIdsByCollection(...a),
  findCollectionProductsPage: (...a: unknown[]) => findCollectionProductsPage(...a),
}));

vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingById: (...a: unknown[]) => findListingById(...a),
  findStoreListingIdsMatching: (...a: unknown[]) => findStoreListingIdsMatching(...a),
  findUnknownStoreListingIds: (...a: unknown[]) => findUnknownStoreListingIds(...a),
  listingMatchesRules: (...a: unknown[]) => listingMatchesRules(...a),
}));

import {
  createCollection,
  materializeMembership,
  recomputeAutomatedMembershipForListing,
  setCollectionProducts,
  type Collection,
} from '../collection.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const STORE_ID = '000000000000000000000040';
const COLLECTION_ID = '000000000000000000000050';
const LISTING_A = '000000000000000000000001';
const LISTING_B = '000000000000000000000002';

/** A collection row as the repository returns it — the row PLUS its rule set. */
function collection(overrides: Partial<Collection> = {}): Collection {
  return {
    id: COLLECTION_ID,
    storeId: STORE_ID,
    title: "Editor's Picks",
    handle: 'editors-picks',
    description: null,
    imageFileId: null,
    type: 'manual',
    rulesAppliesDisjunctively: false,
    sortOrder: 'manual',
    seoTitle: null,
    seoDescription: null,
    isPublished: true,
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    rules: [],
    ...overrides,
  };
}

/** An AUTOMATED collection carrying one `tag equals <value>` rule. */
function automated(value: string, id = COLLECTION_ID): Collection {
  return collection({
    id,
    type: 'automated',
    rules: [
      {
        id: `rule-${id}`,
        collectionId: id,
        field: 'tag',
        operator: 'equals',
        value,
        position: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  findUnknownStoreListingIds.mockResolvedValue([]);
  findStoreListingIdsMatching.mockResolvedValue([]);
  findManualMemberIds.mockResolvedValue([]);
  findManualMemberIdsByCollection.mockResolvedValue(new Map());
});

describe('materializeMembership (automated)', () => {
  it('reconciles to exactly the ids the rules matched', async () => {
    findStoreListingIdsMatching.mockResolvedValueOnce([LISTING_A, LISTING_B]);

    await materializeMembership(automated('sale'));

    expect(reconcileAutomatedMembership).toHaveBeenCalledWith(COLLECTION_ID, [
      LISTING_A,
      LISTING_B,
    ]);
    // An automated membership is NEVER written through the manual path — that
    // would stamp a hand-picked `position` onto a rules-derived row.
    expect(replaceManualMembership).not.toHaveBeenCalled();
  });

  it('editing the rule re-materializes against the NEW matched set', async () => {
    findStoreListingIdsMatching.mockResolvedValueOnce([LISTING_A]);
    await materializeMembership(automated('sale'));
    expect(reconcileAutomatedMembership).toHaveBeenLastCalledWith(COLLECTION_ID, [LISTING_A]);

    findStoreListingIdsMatching.mockResolvedValueOnce([LISTING_B]);
    await materializeMembership(automated('clearance'));
    expect(reconcileAutomatedMembership).toHaveBeenLastCalledWith(COLLECTION_ID, [LISTING_B]);
  });

  it('scopes the match to the collection OWN store', async () => {
    findStoreListingIdsMatching.mockResolvedValueOnce([]);
    await materializeMembership(automated('sale'));
    expect(findStoreListingIdsMatching.mock.calls[0][0]).toBe(STORE_ID);
  });
});

describe('materializeMembership (manual)', () => {
  it('writes the hand-picked ids, in order, through the manual path', async () => {
    await materializeMembership(collection(), [LISTING_B, LISTING_A]);

    // No rule evaluation at all — the hand-picked list IS the membership.
    expect(findStoreListingIdsMatching).not.toHaveBeenCalled();
    expect(replaceManualMembership).toHaveBeenCalledWith(COLLECTION_ID, [LISTING_B, LISTING_A]);
  });

  it('leaves the existing membership ALONE when the caller did not touch the list', async () => {
    // `undefined` is "this request did not mention productIds", which is a
    // different thing from an empty list. Rewriting from a re-read would churn
    // every row for nothing.
    await materializeMembership(collection());

    expect(replaceManualMembership).not.toHaveBeenCalled();
    expect(reconcileAutomatedMembership).not.toHaveBeenCalled();
  });
});

describe('recomputeAutomatedMembershipForListing', () => {
  it('reconciles ONLY the store automated collections, so manual ids survive', async () => {
    const OTHER_AUTOMATED = '000000000000000000000099';
    findListingById.mockResolvedValueOnce({
      id: LISTING_A,
      ownerType: 'store',
      storeId: STORE_ID,
    });
    findAutomatedCollections.mockResolvedValueOnce([
      automated('sale'),
      automated('clearance', OTHER_AUTOMATED),
    ]);
    listingMatchesRules.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await recomputeAutomatedMembershipForListing(LISTING_A);

    // The reconcile is BOUNDED to the automated ids and told which matched. A
    // hand-picked membership is not in that set, so it cannot be reached — which
    // is what the Mongo version achieved by filtering the array before writing it
    // back wholesale.
    expect(setListingAutomatedMemberships).toHaveBeenCalledWith(
      LISTING_A,
      [COLLECTION_ID, OTHER_AUTOMATED],
      [COLLECTION_ID],
    );
  });

  it('passes an EMPTY matched set when the listing matches nothing', async () => {
    findListingById.mockResolvedValueOnce({
      id: LISTING_A,
      ownerType: 'store',
      storeId: STORE_ID,
    });
    findAutomatedCollections.mockResolvedValueOnce([automated('sale')]);
    listingMatchesRules.mockResolvedValueOnce(false);

    await recomputeAutomatedMembershipForListing(LISTING_A);

    expect(setListingAutomatedMemberships).toHaveBeenCalledWith(LISTING_A, [COLLECTION_ID], []);
  });

  it('is a no-op for a non-store-owned listing', async () => {
    findListingById.mockResolvedValueOnce({
      id: LISTING_A,
      ownerType: 'user',
      storeId: null,
    });

    await recomputeAutomatedMembershipForListing(LISTING_A);

    expect(findAutomatedCollections).not.toHaveBeenCalled();
    expect(setListingAutomatedMemberships).not.toHaveBeenCalled();
  });

  it('writes nothing when the store has no automated collections', async () => {
    findListingById.mockResolvedValueOnce({
      id: LISTING_A,
      ownerType: 'store',
      storeId: STORE_ID,
    });
    findAutomatedCollections.mockResolvedValueOnce([]);

    await recomputeAutomatedMembershipForListing(LISTING_A);

    expect(setListingAutomatedMemberships).not.toHaveBeenCalled();
  });
});

describe('setCollectionProducts', () => {
  it('preserves the given order', async () => {
    findCollectionById.mockResolvedValueOnce(collection());

    await setCollectionProducts(STORE_ID, COLLECTION_ID, [LISTING_B, LISTING_A]);

    expect(replaceManualMembership).toHaveBeenCalledWith(COLLECTION_ID, [LISTING_B, LISTING_A]);
  });

  it('rejects setting products on an AUTOMATED collection (conflict)', async () => {
    findCollectionById.mockResolvedValueOnce(automated('sale'));

    await expect(setCollectionProducts(STORE_ID, COLLECTION_ID, [LISTING_A])).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );
    expect(replaceManualMembership).not.toHaveBeenCalled();
  });

  it('rejects unknown product ids BEFORE writing (validation error)', async () => {
    findCollectionById.mockResolvedValueOnce(collection());
    findUnknownStoreListingIds.mockResolvedValueOnce([LISTING_A]);

    await expect(setCollectionProducts(STORE_ID, COLLECTION_ID, [LISTING_A])).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.VALIDATION_ERROR,
    );
    // The write must not have been attempted: `listing_collections.listing_id` is
    // a real foreign key now, so an unchecked id is a 23503 rather than the
    // silent no-match Mongo produced.
    expect(replaceManualMembership).not.toHaveBeenCalled();
  });
});

describe('createCollection', () => {
  it('maps a unique-index violation on the handle to a conflict', async () => {
    // What postgres.js raises: SQLSTATE 23505, which `isUniqueViolation` reads.
    insertCollection.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint_name: 'collections_store_id_handle_key',
      }),
    );

    await expect(
      createCollection(STORE_ID, { title: 'On Sale', handle: 'on-sale', type: 'manual' }),
    ).rejects.toSatisfy((err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT);
  });

  it('validates hand-picked ids before creating, so the insert cannot 23503', async () => {
    findUnknownStoreListingIds.mockResolvedValueOnce([LISTING_A]);

    await expect(
      createCollection(STORE_ID, {
        title: 'On Sale',
        handle: 'on-sale',
        type: 'manual',
        productIds: [LISTING_A],
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.VALIDATION_ERROR,
    );
    expect(insertCollection).not.toHaveBeenCalled();
  });
});
