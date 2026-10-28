import { expect, it } from 'vitest';
import { MAX_FEATURED_COLLECTIONS, type Collection } from '@mercaria/shared-types';
import { addFeaturedCollection, moveFeaturedCollection } from '../featured-collections';
import { queryKeys } from '../queryKeys';

const collection = {
  id: 'one',
  storeId: 'store-a',
  type: 'manual',
  isPublished: true,
} as Collection;
it('adds only published manual collections from the active store, once, within the shared bound', () => {
  expect(addFeaturedCollection([], collection, 'store-a')).toEqual(['one']);
  expect(addFeaturedCollection(['one'], collection, 'store-a')).toEqual(['one']);
  expect(addFeaturedCollection([], collection, 'store-b')).toEqual([]);
  expect(addFeaturedCollection([], { ...collection, type: 'automated' }, 'store-a')).toEqual([]);
  expect(addFeaturedCollection([], { ...collection, isPublished: false }, 'store-a')).toEqual([]);
  const full = Array.from({ length: MAX_FEATURED_COLLECTIONS }, (_, index) => String(index));
  expect(addFeaturedCollection(full, collection, 'store-a')).toEqual(full);
});
it('moves only existing selections within bounds without mutating saved server order', () => {
  const original = ['one', 'two', 'three'];
  expect(moveFeaturedCollection(original, 'two', -1)).toEqual(['two', 'one', 'three']);
  expect(moveFeaturedCollection(original, 'two', 1)).toEqual(['one', 'three', 'two']);
  expect(moveFeaturedCollection(original, 'one', -1)).toEqual(original);
  expect(moveFeaturedCollection(original, 'three', 1)).toEqual(original);
  expect(moveFeaturedCollection(original, 'missing', 1)).toEqual(original);
  expect(original).toEqual(['one', 'two', 'three']);
});
it('keeps selections in their originating store cache without colliding with a collection id', () => {
  expect(queryKeys.collections.featured('a')).not.toEqual(queryKeys.collections.featured('b'));
  expect(queryKeys.collections.featured('a')).not.toEqual(
    queryKeys.collections.detail('a', 'featured'),
  );
});
