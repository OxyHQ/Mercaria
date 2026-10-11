import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../client', () => ({ default: client }));
import { fetchProductSave, saveProduct, unsaveProduct } from '../saves';

describe('canonical product save state', () => {
  beforeEach(() => vi.resetAllMocks());

  it('reads an explicit unsaved state without mistaking it for a missing response', async () => {
    client.get.mockResolvedValue({ data: { success: true, data: { saved: false } } });
    await expect(fetchProductSave('product-a')).resolves.toEqual({ saved: false });
    expect(client.get).toHaveBeenCalledWith('/product-saves/product-a');
  });

  it('keeps saved state and the owner’s stored preferences', async () => {
    const save = { id: 'save-a', preferredCanonicalVariantId: 'variant-a' };
    client.get.mockResolvedValue({ data: { success: true, data: { saved: true, save } } });
    await expect(fetchProductSave('product-a')).resolves.toEqual({ saved: true, save });
  });

  it('does not convert failed or incomplete reads into an unsaved state', async () => {
    client.get.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchProductSave('product-a')).rejects.toThrow('offline');
    client.get.mockResolvedValueOnce({ data: { success: false, error: 'AUTH_REQUIRED' } });
    await expect(fetchProductSave('product-a')).rejects.toThrow('AUTH_REQUIRED');
    client.get.mockResolvedValueOnce({ data: { success: true } });
    await expect(fetchProductSave('product-a')).rejects.toThrow(
      'Failed to read that saved product',
    );
  });

  it('keeps save and remove as explicit idempotent operations on the canonical id', async () => {
    const input = { canonicalProductId: 'product-a', sourceContext: 'product_page' as const };
    client.post.mockResolvedValue({ data: { success: true, data: { save: { id: 'save-a' } } } });
    await saveProduct(input);
    await unsaveProduct(input.canonicalProductId);
    expect(client.post).toHaveBeenCalledWith('/product-saves', input);
    expect(client.delete).toHaveBeenCalledWith('/product-saves/product-a');
  });
});
