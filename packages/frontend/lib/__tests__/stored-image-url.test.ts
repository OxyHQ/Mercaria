import { describe, expect, it, vi } from 'vitest';
import { resolveCatalogImage, resolveStoredImageUrl } from '../../../ui/src/lib/stored-image-url';

const resolveImage = (id: string, variant?: string) =>
  `https://cloud.oxy.so/${id}${variant ? `?variant=${encodeURIComponent(variant)}` : ''}`;

describe('persisted marketplace image URLs', () => {
  it.each(['file-1', 'file_2?variant=thumb'])('retains an actual resolver URL: %s', (suffix) => {
    const url = `https://cloud.oxy.so/${suffix}`;
    expect(resolveStoredImageUrl(url, resolveImage)).toBe(url);
  });

  it.each([
    'https://supplier.example/file-1',
    'https://cloud.oxy.so.evil.test/file-1',
    'https://user:secret@cloud.oxy.so/file-1',
    'http://cloud.oxy.so/file-1',
    'https://cloud.oxy.so/other/file-1',
    'https://cloud.oxy.so/file-1?variant=thumb&variant=full',
    'https://cloud.oxy.so/file-1?redirect=https://supplier.example',
    'https://cloud.oxy.so/file-1#fragment',
    'https://cloud.oxy.so/https%3A%2F%2Fsupplier.example',
    'file-1',
    'data:image/png;base64,AAAA',
  ])('refuses stale or foreign media without rewriting it: %s', (value) => {
    expect(resolveStoredImageUrl(value, resolveImage)).toBeUndefined();
  });

  it('uses the configured resolver namespace rather than hardcoding a cloud host', () => {
    const resolve = vi.fn((id: string) => `https://assets.example.test/media/${id}`);
    expect(resolveStoredImageUrl('https://assets.example.test/media/file-1', resolve)).toBe(
      'https://assets.example.test/media/file-1',
    );
    expect(resolve).toHaveBeenCalledWith('file-1', undefined);
    expect(resolveStoredImageUrl('https://cloud.oxy.so/file-1', resolve)).toBeUndefined();
  });

  it('withholds media when no resolver or rendition is available', () => {
    expect(resolveStoredImageUrl('https://cloud.oxy.so/file-1', null)).toBeUndefined();
    expect(resolveStoredImageUrl('https://cloud.oxy.so/file-1', () => undefined)).toBeUndefined();
  });
});

describe('catalog image IDs', () => {
  it('resolves the ID with the requested rendition instead of the legacy URL', () => {
    const resolver = vi.fn(resolveImage);
    expect(
      resolveCatalogImage('new-file', 'https://supplier.example/photo.jpg', resolver, 'thumb'),
    ).toBe('https://cloud.oxy.so/new-file?variant=thumb');
    expect(resolver).toHaveBeenCalledWith('new-file', 'thumb');
  });

  it.each(['', 'https://cloud.oxy.so/file-1', 'https://supplier.example/photo.jpg', '/photo.jpg'])(
    'refuses a malformed present ID even when the old URL is valid: %s',
    (fileId) => {
      const resolver = vi.fn(resolveImage);
      expect(resolveCatalogImage(fileId, resolveImage('old-file'), resolver)).toBeUndefined();
      expect(resolver).not.toHaveBeenCalled();
    },
  );

  it('supports old persisted DTOs only within the current resolver namespace', () => {
    expect(resolveCatalogImage(undefined, resolveImage('old-file'), resolveImage)).toBe(
      resolveImage('old-file'),
    );
    expect(
      resolveCatalogImage(undefined, 'https://supplier.example/photo.jpg', resolveImage),
    ).toBeUndefined();
  });

  it('withholds an ID when its provider or rendition is unavailable', () => {
    expect(resolveCatalogImage('file-1', undefined, null)).toBeUndefined();
    expect(resolveCatalogImage('file-1', undefined, () => undefined)).toBeUndefined();
  });
});
