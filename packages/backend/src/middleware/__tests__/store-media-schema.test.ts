import { describe, expect, it } from 'vitest';
import { createStoreSchema, updateStoreSchema } from '../schemas.js';

const base = { name: 'Store' };

describe('store artwork request boundaries', () => {
  it('accepts opaque file IDs and leaves artwork-free requests valid', () => {
    expect(createStoreSchema.safeParse(base).success).toBe(true);
    expect(createStoreSchema.safeParse({ ...base, logoFileId: 'oxy-file_123', coverFileId: 'oxy-file_456' }).success).toBe(true);
    expect(updateStoreSchema.safeParse({ logoFileId: 'oxy-file_123' }).success).toBe(true);
    expect(updateStoreSchema.safeParse({ coverFileId: 'oxy-file_456' }).success).toBe(true);
  });
  it.each(['https://supplier.example/logo.png', 'https://cloud.oxy.so/oxy-website/store/logo.png', 'data:image/png;base64,AAAA', '//supplier.example/logo', ''])('does not accept a URL/empty value as store artwork: %s', fileId => {
    for (const field of ['logoFileId', 'coverFileId']) {
      expect(createStoreSchema.safeParse({ ...base, [field]: fileId }).success).toBe(false);
      expect(updateStoreSchema.safeParse({ [field]: fileId }).success).toBe(false);
    }
  });
});
