import { describe, expect, it } from 'vitest';
import { createCollectionSchema, updateCollectionSchema } from '../schemas.js';

const base = { title: 'Collection', handle: 'collection', type: 'manual' };

describe('collection media request boundaries', () => {
  it('accepts opaque file IDs and leaves image-free requests valid', () => {
    expect(createCollectionSchema.safeParse(base).success).toBe(true);
    expect(createCollectionSchema.safeParse({ ...base, imageFileId: 'oxy-file_123' }).success).toBe(
      true,
    );
    expect(updateCollectionSchema.safeParse({ imageFileId: 'oxy-file_123' }).success).toBe(true);
  });
  it.each([
    'https://supplier.example/image.jpg',
    'https://cloud.oxy.so/oxy-file_123',
    'data:image/png;base64,AAAA',
    '//supplier.example/image',
    '',
  ])('does not accept a URL/empty value in imageFileId: %s', (imageFileId) => {
    expect(createCollectionSchema.safeParse({ ...base, imageFileId }).success).toBe(false);
    expect(updateCollectionSchema.safeParse({ imageFileId }).success).toBe(false);
  });
});
