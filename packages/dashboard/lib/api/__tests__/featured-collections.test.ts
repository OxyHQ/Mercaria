import { beforeEach, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('../client', () => ({ default: transport }));
import { fetchFeaturedCollections, setFeaturedCollections } from '../collections';

beforeEach(() => vi.resetAllMocks());
it('preserves seller order through the canonical envelope and sends an explicit empty replacement', async () => {
  const selection = { collectionIds: ['second', 'first'] };
  transport.get.mockResolvedValueOnce({ data: { success: true, data: selection } });
  expect(await fetchFeaturedCollections('store-a')).toEqual(selection);
  expect(transport.get).toHaveBeenCalledWith('/admin/stores/store-a/collections/featured');
  transport.put.mockResolvedValueOnce({ data: { success: true, data: { collectionIds: [] } } });
  expect(await setFeaturedCollections('store-b', { collectionIds: [] })).toEqual({
    collectionIds: [],
  });
  expect(transport.put).toHaveBeenCalledWith('/admin/stores/store-b/collections/featured', {
    collectionIds: [],
  });
});
it('keeps authorization and invalid-selection failures as errors, never fabricating an empty selection', async () => {
  const denied = new Error('refused');
  transport.get.mockRejectedValueOnce(denied);
  transport.put.mockRejectedValueOnce(denied);
  await expect(fetchFeaturedCollections('store')).rejects.toBe(denied);
  await expect(setFeaturedCollections('store', { collectionIds: ['withdrawn'] })).rejects.toBe(
    denied,
  );
});
