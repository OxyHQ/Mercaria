import { describe, expect, it, vi } from 'vitest';
import { resolveStoredImageUrl } from '../../../ui/src/lib/stored-image-url';

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
    expect(resolveStoredImageUrl('https://assets.example.test/media/file-1', resolve))
      .toBe('https://assets.example.test/media/file-1');
    expect(resolve).toHaveBeenCalledWith('file-1', undefined);
    expect(resolveStoredImageUrl('https://cloud.oxy.so/file-1', resolve)).toBeUndefined();
  });

  it('withholds media when no resolver or rendition is available', () => {
    expect(resolveStoredImageUrl('https://cloud.oxy.so/file-1', null)).toBeUndefined();
    expect(resolveStoredImageUrl('https://cloud.oxy.so/file-1', () => undefined)).toBeUndefined();
  });
});
