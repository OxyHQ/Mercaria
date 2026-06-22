/**
 * Unit tests for `collection.service` — collection membership materialization.
 *
 * `mongodb-memory-server` is unavailable, so the `Collection`/`Listing`/
 * `ProductVariant` models' static methods are mocked with `vi.fn()`. These tests
 * assert the EXACT Mongo predicates and `updateMany`/`updateOne` shapes the service
 * emits: building an automated filter from a `tag contains 'sale'` rule, the two-step
 * `materializeMembership` reconciliation (`$addToSet` over matched ids + `$pull` over
 * the rest), per-listing automated recompute (manual ids preserved), manual
 * `setCollectionProducts` order/validation, and the handle-uniqueness conflict.
 * Every test is deterministic and offline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const collectionFind = vi.fn();
const collectionFindOne = vi.fn();
const collectionCreate = vi.fn();
const collectionDeleteOne = vi.fn();
const listingFind = vi.fn();
const listingFindById = vi.fn();
const listingExists = vi.fn();
const listingUpdateMany = vi.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
const listingUpdateOne = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
const listingCountDocuments = vi.fn().mockResolvedValue(0);
const variantFind = vi.fn();

vi.mock('../../models/collection.js', () => ({
  Collection: {
    find: (...args: unknown[]) => collectionFind(...args),
    findOne: (...args: unknown[]) => collectionFindOne(...args),
    create: (...args: unknown[]) => collectionCreate(...args),
    deleteOne: (...args: unknown[]) => collectionDeleteOne(...args),
  },
}));

vi.mock('../../models/listing.js', () => ({
  Listing: {
    find: (...args: unknown[]) => listingFind(...args),
    findById: (...args: unknown[]) => listingFindById(...args),
    exists: (...args: unknown[]) => listingExists(...args),
    updateMany: (...args: unknown[]) => listingUpdateMany(...args),
    updateOne: (...args: unknown[]) => listingUpdateOne(...args),
    countDocuments: (...args: unknown[]) => listingCountDocuments(...args),
  },
}));

vi.mock('../../models/product-variant.js', () => ({
  ProductVariant: {
    find: (...args: unknown[]) => variantFind(...args),
  },
}));

import {
  buildAutomatedFilter,
  materializeMembership,
  recomputeAutomatedMembershipForListing,
  setCollectionProducts,
  createCollection,
} from '../collection.service.js';
import type { ICollection } from '../../models/collection.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const STORE_ID = '000000000000000000000040';
const COLLECTION_ID = '000000000000000000000060';
const LISTING_A = '000000000000000000000070';
const LISTING_B = '000000000000000000000071';

/** A `Listing.find(...).select(...).lean()` chain resolving the given _id docs. */
function listingSelectLean(ids: string[]): unknown {
  return {
    select: () => ({ lean: () => Promise.resolve(ids.map((id) => ({ _id: id }))) }),
  };
}

/** A `Collection.find(...).lean()` chain resolving the given collections. */
function collectionLean(docs: ICollection[]): unknown {
  return { lean: () => Promise.resolve(docs) };
}

/** A `Listing.findById(...).select(...).lean()` chain resolving a partial listing. */
function listingFindByIdLean(doc: unknown): unknown {
  return { select: () => ({ lean: () => Promise.resolve(doc) }) };
}

/** Build a minimal automated collection doc. */
function automatedCollection(
  id: string,
  value: string,
  overrides: Partial<ICollection> = {},
): ICollection {
  return {
    _id: id as unknown as ICollection['_id'],
    storeId: STORE_ID,
    title: 'On Sale',
    handle: 'on-sale',
    type: 'automated',
    productIds: [],
    rules: { appliesDisjunctively: false, conditions: [{ field: 'tag', operator: 'contains', value }] },
    sortOrder: 'price_asc',
    isPublished: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  collectionFind.mockReset();
  collectionFindOne.mockReset();
  collectionCreate.mockReset();
  collectionDeleteOne.mockReset();
  listingFind.mockReset();
  listingFindById.mockReset();
  listingExists.mockReset();
  listingUpdateMany.mockClear();
  listingUpdateOne.mockClear();
  listingCountDocuments.mockClear();
  variantFind.mockReset();
});

describe('buildAutomatedFilter', () => {
  it('translates `tag contains "sale"` into a store-scoped array-membership predicate', async () => {
    const filter = await buildAutomatedFilter(STORE_ID, {
      appliesDisjunctively: false,
      conditions: [{ field: 'tag', operator: 'contains', value: 'sale' }],
    });

    expect(filter).toEqual({
      ownerType: 'store',
      storeId: STORE_ID,
      status: 'active',
      $and: [{ tags: 'sale' }],
    });
  });

  it('uses `$or` when the rules apply disjunctively', async () => {
    const filter = await buildAutomatedFilter(STORE_ID, {
      appliesDisjunctively: true,
      conditions: [
        { field: 'vendor', operator: 'equals', value: 'Paloma Wool' },
        { field: 'productType', operator: 'equals', value: 'Knitwear' },
      ],
    });

    expect(filter).toEqual({
      ownerType: 'store',
      storeId: STORE_ID,
      status: 'active',
      $or: [{ vendor: 'Paloma Wool' }, { productType: 'Knitwear' }],
    });
  });

  it('matches NOTHING when no condition is translatable (never includes the whole store)', async () => {
    const filter = await buildAutomatedFilter(STORE_ID, {
      appliesDisjunctively: false,
      // starts_with on an array field is unsupported → skipped → no surviving condition.
      conditions: [{ field: 'tag', operator: 'starts_with', value: 'x' }],
    });

    expect(filter).toEqual({
      ownerType: 'store',
      storeId: STORE_ID,
      status: 'active',
      _id: { $exists: false },
    });
  });
});

describe('materializeMembership (automated)', () => {
  it('ADDs the collection id to matched ids and PULLs it from the rest', async () => {
    // The automated filter query resolves listings A + B as the matched set.
    listingFind.mockReturnValueOnce(listingSelectLean([LISTING_A, LISTING_B]));

    await materializeMembership(automatedCollection(COLLECTION_ID, 'sale'));

    expect(listingUpdateMany).toHaveBeenCalledTimes(2);
    const [addFilter, addUpdate] = listingUpdateMany.mock.calls[0];
    expect(addFilter).toEqual({
      _id: { $in: [LISTING_A, LISTING_B] },
      collectionIds: { $ne: COLLECTION_ID },
    });
    expect(addUpdate).toEqual({ $addToSet: { collectionIds: COLLECTION_ID } });

    const [removeFilter, removeUpdate] = listingUpdateMany.mock.calls[1];
    expect(removeFilter).toEqual({
      storeId: STORE_ID,
      collectionIds: COLLECTION_ID,
      _id: { $nin: [LISTING_A, LISTING_B] },
    });
    expect(removeUpdate).toEqual({ $pull: { collectionIds: COLLECTION_ID } });
  });

  it('editing the rule re-materializes against the NEW matched set', async () => {
    // First materialize: A matches.
    listingFind.mockReturnValueOnce(listingSelectLean([LISTING_A]));
    await materializeMembership(automatedCollection(COLLECTION_ID, 'sale'));
    expect(listingUpdateMany.mock.calls[0][0]).toEqual({
      _id: { $in: [LISTING_A] },
      collectionIds: { $ne: COLLECTION_ID },
    });
    expect(listingUpdateMany.mock.calls[1][0]).toEqual({
      storeId: STORE_ID,
      collectionIds: COLLECTION_ID,
      _id: { $nin: [LISTING_A] },
    });

    // Edit the rule → second materialize: B matches now (A removed, B added).
    listingFind.mockReturnValueOnce(listingSelectLean([LISTING_B]));
    await materializeMembership(automatedCollection(COLLECTION_ID, 'clearance'));
    expect(listingUpdateMany.mock.calls[2][0]).toEqual({
      _id: { $in: [LISTING_B] },
      collectionIds: { $ne: COLLECTION_ID },
    });
    expect(listingUpdateMany.mock.calls[3][0]).toEqual({
      storeId: STORE_ID,
      collectionIds: COLLECTION_ID,
      _id: { $nin: [LISTING_B] },
    });
  });
});

describe('materializeMembership (manual)', () => {
  it('uses the hand-picked productIds as the membership set', async () => {
    const manual: ICollection = {
      _id: COLLECTION_ID as unknown as ICollection['_id'],
      storeId: STORE_ID,
      title: "Editor's Picks",
      handle: 'editors-picks',
      type: 'manual',
      productIds: [LISTING_A, LISTING_B],
      sortOrder: 'manual',
      isPublished: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await materializeMembership(manual);

    // No automated query — productIds drive membership directly.
    expect(listingFind).not.toHaveBeenCalled();
    expect(listingUpdateMany.mock.calls[0][0]).toEqual({
      _id: { $in: [LISTING_A, LISTING_B] },
      collectionIds: { $ne: COLLECTION_ID },
    });
  });
});

describe('recomputeAutomatedMembershipForListing', () => {
  it('adds the matched automated collection id and PRESERVES manual ids', async () => {
    const MANUAL_ID = '000000000000000000000099';
    // Listing currently carries a manual collection id + a stale automated id.
    listingFindById.mockReturnValueOnce(
      listingFindByIdLean({
        ownerType: 'store',
        storeId: STORE_ID,
        collectionIds: [MANUAL_ID, COLLECTION_ID],
      }),
    );
    // The store has ONE automated collection.
    collectionFind.mockReturnValueOnce(collectionLean([automatedCollection(COLLECTION_ID, 'sale')]));
    // This listing matches that automated collection's filter.
    listingExists.mockResolvedValueOnce({ _id: LISTING_A });

    await recomputeAutomatedMembershipForListing(LISTING_A);

    expect(listingUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = listingUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: LISTING_A });
    // Manual id preserved; automated id reconciled (still present because it matched).
    expect(update).toEqual({ $set: { collectionIds: [MANUAL_ID, COLLECTION_ID] } });
  });

  it('removes a no-longer-matching automated id while keeping manual ids', async () => {
    const MANUAL_ID = '000000000000000000000099';
    listingFindById.mockReturnValueOnce(
      listingFindByIdLean({
        ownerType: 'store',
        storeId: STORE_ID,
        collectionIds: [MANUAL_ID, COLLECTION_ID],
      }),
    );
    collectionFind.mockReturnValueOnce(collectionLean([automatedCollection(COLLECTION_ID, 'sale')]));
    // This listing NO LONGER matches the automated filter.
    listingExists.mockResolvedValueOnce(null);

    await recomputeAutomatedMembershipForListing(LISTING_A);

    const [, update] = listingUpdateOne.mock.calls[0];
    // Automated id dropped; manual id survives.
    expect(update).toEqual({ $set: { collectionIds: [MANUAL_ID] } });
  });

  it('is a no-op for a non-store-owned listing', async () => {
    listingFindById.mockReturnValueOnce(
      listingFindByIdLean({ ownerType: 'user', collectionIds: [] }),
    );

    await recomputeAutomatedMembershipForListing(LISTING_A);

    expect(collectionFind).not.toHaveBeenCalled();
    expect(listingUpdateOne).not.toHaveBeenCalled();
  });
});

describe('setCollectionProducts', () => {
  it('preserves the given order and re-materializes', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const collectionDoc = {
      _id: COLLECTION_ID,
      storeId: STORE_ID,
      type: 'manual',
      productIds: [] as string[],
      save,
      toObject(): ICollection {
        return {
          _id: COLLECTION_ID as unknown as ICollection['_id'],
          storeId: STORE_ID,
          title: "Editor's Picks",
          handle: 'editors-picks',
          type: 'manual',
          productIds: this.productIds,
          sortOrder: 'manual',
          isPublished: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    };
    collectionFindOne.mockResolvedValueOnce(collectionDoc);
    // Both ids are known store-owned listings.
    listingFind.mockReturnValueOnce(listingSelectLean([LISTING_B, LISTING_A]));

    const result = await setCollectionProducts(STORE_ID, COLLECTION_ID, [LISTING_B, LISTING_A]);

    expect(collectionDoc.productIds).toEqual([LISTING_B, LISTING_A]);
    expect(save).toHaveBeenCalled();
    expect(result.productIds).toEqual([LISTING_B, LISTING_A]);
    // Materialized over the manual productIds (in order).
    expect(listingUpdateMany.mock.calls[0][0]).toEqual({
      _id: { $in: [LISTING_B, LISTING_A] },
      collectionIds: { $ne: COLLECTION_ID },
    });
  });

  it('rejects setting products on an AUTOMATED collection (conflict)', async () => {
    collectionFindOne.mockResolvedValueOnce({
      _id: COLLECTION_ID,
      storeId: STORE_ID,
      type: 'automated',
      save: vi.fn(),
    });

    await expect(setCollectionProducts(STORE_ID, COLLECTION_ID, [LISTING_A])).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );
  });

  it('rejects unknown product ids (validation error)', async () => {
    collectionFindOne.mockResolvedValueOnce({
      _id: COLLECTION_ID,
      storeId: STORE_ID,
      type: 'manual',
      productIds: [],
      save: vi.fn(),
    });
    // Known set is empty → every requested id is unknown.
    listingFind.mockReturnValueOnce(listingSelectLean([]));

    await expect(setCollectionProducts(STORE_ID, COLLECTION_ID, [LISTING_A])).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.VALIDATION_ERROR,
    );
  });
});

describe('createCollection handle uniqueness', () => {
  it('maps a Mongo 11000 duplicate-key error to a conflict', async () => {
    collectionCreate.mockRejectedValueOnce({ code: 11000 });

    await expect(
      createCollection(STORE_ID, { title: 'On Sale', handle: 'on-sale', type: 'manual' }),
    ).rejects.toSatisfy((err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT);
  });
});
