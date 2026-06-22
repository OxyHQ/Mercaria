/**
 * Unit tests for `user-preference.service` — the consumer dual-display
 * preference lifecycle.
 *
 * `mongodb-memory-server` is unavailable, so the `UserPreference` model's static
 * methods are mocked. These tests assert: `getOrCreate` upserts defaults
 * (`dualDisplayEnabled: true`, `secondaryCurrency: null`) and projects the DTO,
 * and `update` sets only the provided fields — including setting a value and
 * explicitly clearing `secondaryCurrency` to `null`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findOneAndUpdate = vi.fn();

vi.mock('../../models/user-preference.js', () => ({
  UserPreference: {
    findOneAndUpdate: (...args: unknown[]) => findOneAndUpdate(...args),
  },
}));

import { getOrCreate, update } from '../user-preference.service.js';

const USER = 'shopper-1';

/** A `findOneAndUpdate(...).lean()` chain resolving to `doc`. */
function leanOf(doc: unknown): unknown {
  return { lean: () => Promise.resolve(doc) };
}

beforeEach(() => {
  findOneAndUpdate.mockReset();
});

describe('getOrCreate', () => {
  it('upserts defaults and returns the display-only DTO', async () => {
    findOneAndUpdate.mockReturnValueOnce(
      leanOf({
        oxyUserId: USER,
        secondaryCurrency: null,
        dualDisplayEnabled: true,
      }),
    );

    const result = await getOrCreate(USER);

    expect(result).toEqual({ secondaryCurrency: null, dualDisplayEnabled: true });
    const [filter, , options] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ oxyUserId: USER });
    expect(options).toMatchObject({ upsert: true, setDefaultsOnInsert: true });
  });
});

describe('update', () => {
  it('sets a secondary currency and toggles dual display', async () => {
    findOneAndUpdate.mockReturnValueOnce(
      leanOf({ oxyUserId: USER, secondaryCurrency: 'EUR', dualDisplayEnabled: false }),
    );

    const result = await update(USER, { secondaryCurrency: 'EUR', dualDisplayEnabled: false });

    expect(result).toEqual({ secondaryCurrency: 'EUR', dualDisplayEnabled: false });
    const [, updateDoc] = findOneAndUpdate.mock.calls[0];
    expect(updateDoc).toMatchObject({
      $set: { secondaryCurrency: 'EUR', dualDisplayEnabled: false },
    });
  });

  it('clears the secondary currency when explicitly set to null', async () => {
    findOneAndUpdate.mockReturnValueOnce(
      leanOf({ oxyUserId: USER, secondaryCurrency: null, dualDisplayEnabled: true }),
    );

    const result = await update(USER, { secondaryCurrency: null });

    expect(result.secondaryCurrency).toBeNull();
    const [, updateDoc] = findOneAndUpdate.mock.calls[0];
    // `secondaryCurrency: null` is present in $set (an explicit clear), and
    // `dualDisplayEnabled` is untouched (absent from the patch).
    expect(updateDoc.$set).toEqual({ secondaryCurrency: null });
  });
});
