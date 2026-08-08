/**
 * Unit tests for `user-preference.service` — the consumer dual-display
 * preference lifecycle.
 *
 * `user_preferences` is Postgres now, so `db/buyers/userPreferenceRepository` is
 * mocked in place of the `UserPreference` model. These tests assert what the
 * service decides: `getOrCreate` asks for the row with an EMPTY patch (so the
 * column defaults are what a first-time buyer gets), `update` forwards only the
 * fields the caller named — including an explicit `null` clear, which must reach
 * the repository as `null` and never as `''` — and `resolvePresentmentCurrency`
 * is a pure read that falls back to FAIR.
 *
 * That `UNIQUE(oxy_user_id)` really makes the upsert idempotent, and that a NULL
 * currency round-trips as NULL, are properties of the server and belong in
 * `db/__tests__/buyers.realdb.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findPreferredCurrency = vi.fn();
const upsertUserPreference = vi.fn();

vi.mock('../../db/buyers/userPreferenceRepository.js', () => ({
  findPreferredCurrency: (...args: unknown[]) => findPreferredCurrency(...args),
  upsertUserPreference: (...args: unknown[]) => upsertUserPreference(...args),
}));

import { getOrCreate, resolvePresentmentCurrency, update } from '../user-preference.service.js';

const USER = 'shopper-1';

/** Every row fixture carries the same timestamps; none of them is asserted on. */
const AT = new Date('2026-01-01T00:00:00.000Z');

/** A `user_preferences` ROW as the repository returns it. */
function preferenceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pref-1',
    oxyUserId: USER,
    preferredCurrency: null,
    secondaryCurrency: null,
    dualDisplayEnabled: true,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOrCreate', () => {
  it('upserts with an EMPTY patch and returns the display-only DTO', async () => {
    upsertUserPreference.mockResolvedValue(preferenceRow());

    const result = await getOrCreate(USER);

    expect(result).toEqual({
      preferredCurrency: null,
      secondaryCurrency: null,
      dualDisplayEnabled: true,
    });
    // An empty patch is what makes the DDL's own defaults the answer for a
    // first-time buyer — the service must not substitute its own.
    expect(upsertUserPreference).toHaveBeenCalledWith(USER, {});
  });

  it('projects only the display fields, not the whole row', async () => {
    upsertUserPreference.mockResolvedValue(preferenceRow({ preferredCurrency: 'EUR' }));

    const result = await getOrCreate(USER);

    // `db.select()` returns EVERY column; the DTO is three fields and the row's
    // id and timestamps must not ride along on the wire.
    expect(Object.keys(result).sort()).toEqual([
      'dualDisplayEnabled',
      'preferredCurrency',
      'secondaryCurrency',
    ]);
  });
});

describe('resolvePresentmentCurrency', () => {
  it('returns the buyer’s chosen currency', async () => {
    findPreferredCurrency.mockResolvedValue('CAD');

    expect(await resolvePresentmentCurrency(USER)).toBe('CAD');
  });

  it('falls back to FAIR when the buyer has chosen none', async () => {
    // NULL means "not chosen" — the read must not create a row on the way past,
    // which is why this path uses the pure read and not the upsert.
    findPreferredCurrency.mockResolvedValue(null);

    expect(await resolvePresentmentCurrency(USER)).toBe('FAIR');
    expect(upsertUserPreference).not.toHaveBeenCalled();
  });
});

describe('update', () => {
  it('sets a secondary currency and toggles dual display', async () => {
    upsertUserPreference.mockResolvedValue(
      preferenceRow({ secondaryCurrency: 'EUR', dualDisplayEnabled: false }),
    );

    const result = await update(USER, { secondaryCurrency: 'EUR', dualDisplayEnabled: false });

    expect(result).toEqual({
      preferredCurrency: null,
      secondaryCurrency: 'EUR',
      dualDisplayEnabled: false,
    });
    expect(upsertUserPreference).toHaveBeenCalledWith(USER, {
      secondaryCurrency: 'EUR',
      dualDisplayEnabled: false,
    });
  });

  it('sets the primary preferred currency and leaves the rest alone', async () => {
    upsertUserPreference.mockResolvedValue(preferenceRow({ preferredCurrency: 'CAD' }));

    const result = await update(USER, { preferredCurrency: 'CAD' });

    expect(result.preferredCurrency).toBe('CAD');
    // Only the named field is forwarded: an absent key must stay absent, or the
    // upsert would write NULL over a currency the buyer never touched.
    expect(upsertUserPreference).toHaveBeenCalledWith(USER, { preferredCurrency: 'CAD' });
  });

  it('clears the secondary currency as NULL when explicitly set to null', async () => {
    upsertUserPreference.mockResolvedValue(preferenceRow());

    const result = await update(USER, { secondaryCurrency: null });

    expect(result.secondaryCurrency).toBeNull();
    // `null`, never `''`. An empty string is a real value: it satisfies neither
    // the column's currency CHECK nor any consumer reading "not chosen".
    const [, patch] = upsertUserPreference.mock.calls[0];
    expect(patch).toEqual({ secondaryCurrency: null });
    expect(patch.secondaryCurrency).toBeNull();
  });
});
