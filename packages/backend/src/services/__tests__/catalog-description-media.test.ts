import { beforeEach, describe, expect, it, vi } from 'vitest';
const { storeImages, accountImages } = vi.hoisted(() => ({ storeImages: vi.fn(), accountImages: vi.fn() }));
vi.mock('../catalog-media/sync.js', () => ({
  CatalogMediaSyncError: class CatalogMediaSyncError extends Error {},
  synchronizeStoreImages: storeImages, synchronizeAccountImages: accountImages,
}));
vi.mock('../../middleware/auth.js', () => ({ oxyClient: {
  cloudURL: 'https://cloud.oxy.so',
  assets: { publicUrl: (id: string, variant?: string) => `https://cloud.oxy.so/${id}${variant ? `?variant=${variant}` : ''}` },
} }));
import { assertDescriptionImagesStored, descriptionNeedsMediaImport, synchronizeAccountDescription, synchronizeStoreDescription } from '../catalog-media/description.js';

beforeEach(() => {
  vi.resetAllMocks();
  storeImages.mockImplementation(async (_store: string, sources: string[]) => sources.map((_, i) => `stored-${i}`));
  accountImages.mockImplementation(async (_owner: string, sources: string[]) => sources.map((_, i) => `stored-${i}`));
});

describe('description media import', () => {
  it('preserves plain copy and already synchronized HTML exactly without storage calls', async () => {
    for (const description of ['Cotton & silk', '<p>Fit &amp; care</p>', '<img src="https://cloud.oxy.so/existing?variant=full" alt="Care">']) {
      expect(await synchronizeStoreDescription('store', description)).toBe(description);
      expect(descriptionNeedsMediaImport(description)).toBe(false);
    }
    expect(storeImages).not.toHaveBeenCalled();
  });

  it('imports unique decoded HTTPS sources in content order and removes external responsive alternatives', async () => {
    const html = '<p>Care &amp; sizing</p><picture><source srcset="https://supplier.test/large.jpg 2x"><img src="//supplier.test/care.jpg?a=1&amp;b=2" srcset="https://supplier.test/small.jpg 1x" sizes="50vw" alt="Care"></picture><img src="https://supplier.test/care.jpg?a=1&amp;b=2"><img src="https://supplier.test/chart.jpg">';
    const result = await synchronizeStoreDescription('persisted-store', html);
    expect(storeImages).toHaveBeenCalledExactlyOnceWith('persisted-store', ['https://supplier.test/care.jpg?a=1&b=2', 'https://supplier.test/chart.jpg']);
    expect(result).toContain('<p>Care &amp; sizing</p>');
    expect(result.match(/src="https:\/\/cloud.oxy.so\/stored-0"/g)).toHaveLength(2);
    expect(result).toContain('src="https://cloud.oxy.so/stored-1"');
    expect(result).toContain('alt="Care"');
    expect(result).not.toMatch(/supplier\.test|srcset|sizes=|<source/);
    expect(() => assertDescriptionImagesStored(result)).not.toThrow();
  });

  it('does not fetch hidden script/template images', async () => {
    const html = '<template><img src="https://hidden.test/a"></template><script>"<img src=https://hidden.test/b>"</script><p>Visible</p>';
    expect(await synchronizeStoreDescription('store', html)).toBe(html);
    expect(storeImages).not.toHaveBeenCalled();
  });

  it('normalizes picture candidates even when the fallback image is already stored', async () => {
    const fallback = '<img src="https://cloud.oxy.so/existing">';
    const html = `<picture><source srcset="https://supplier.test/large.jpg 2x">${fallback}</picture>`;
    expect(descriptionNeedsMediaImport(html)).toBe(true);
    expect(() => assertDescriptionImagesStored(html)).toThrow(/synchronized/);
    const result = await synchronizeStoreDescription('store', html);
    expect(result).toBe(`<picture>${fallback}</picture>`);
    expect(descriptionNeedsMediaImport(result)).toBe(false);
    expect(storeImages).not.toHaveBeenCalled();
  });

  it('refuses a picture without a fallback instead of silently dropping its content', async () => {
    await expect(synchronizeStoreDescription('store', '<picture><source srcset="https://supplier.test/large.jpg 2x"></picture>')).rejects.toThrow(/fallback source/);
    expect(storeImages).not.toHaveBeenCalled();
  });

  it('forwards canonical ownership to the same importer and never invents an account', async () => {
    await synchronizeAccountDescription(undefined, '<img src="https://supplier.test/chart.jpg">');
    expect(accountImages).toHaveBeenCalledWith(undefined, ['https://supplier.test/chart.jpg']);
    expect(storeImages).not.toHaveBeenCalled();
  });

  it('rejects external description images at transactional write boundaries', () => {
    expect(() => assertDescriptionImagesStored('<img src="https://supplier.test/chart.jpg">')).toThrow(/synchronized/);
    expect(storeImages).not.toHaveBeenCalled();
  });

  it('propagates an import failure without returning a partially rewritten description', async () => {
    storeImages.mockRejectedValue(new Error('Storage unavailable'));
    await expect(synchronizeStoreDescription('store', '<img src="https://supplier.test/chart.jpg">')).rejects.toThrow('Storage unavailable');
  });

  it.each([[], ['https://supplier.test/not-a-file-id']])('refuses incomplete or invalid importer responses', async ids => {
    storeImages.mockResolvedValue(ids);
    await expect(synchronizeStoreDescription('store', '<img src="https://supplier.test/chart.jpg">')).rejects.toThrow();
  });

  it('refuses unsupported source-set-only images rather than leaving supplier hotlinks', async () => {
    await expect(synchronizeStoreDescription('store', '<img srcset="https://supplier.test/chart.jpg 2x">')).rejects.toThrow(/HTTPS source/);
    expect(storeImages).not.toHaveBeenCalled();
  });

  it('bounds work before uploading any bytes', async () => {
    await expect(synchronizeStoreDescription('store', '<img src="https://supplier.test/a">'.repeat(65))).rejects.toThrow(/Too many/);
    expect(storeImages).not.toHaveBeenCalled();
  });
});
