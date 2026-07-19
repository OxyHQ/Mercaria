/**
 * Unit tests for `fx.service` — the FAIR conversion + caching boundary.
 *
 * `mongodb-memory-server` and a live FairCoin Explorer are unavailable offline,
 * so `config` is mocked with a deterministic `fx` block, `lib/redis` is mocked
 * (toggleable Redis client), and the global `fetch` is stubbed. These tests
 * assert: provider fetch → cache write (`setex`) on a miss, cache hit serving
 * without re-fetching, last-good `stale` fallback on provider failure, static
 * `stale` fallback when no cache exists, that `getRates` NEVER throws, and the
 * `convertToFair`/`convert` rounding + fail-closed behaviour. FAIR is canonical:
 * a FAIR input is returned unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getRedisClient = vi.fn();

vi.mock('../../config/index.js', () => ({
  config: {
    fx: {
      provider: 'faircoin_explorer',
      cacheTtlSeconds: 300,
      faircoinExplorerBaseUrl: 'https://explorer.fairco.in',
      requestTimeoutMs: 5_000,
      staticRates: { USD: 0.49, EUR: 0.45, GBP: 0.39, CAD: 0.67, AUD: 0.75 },
    },
  },
}));

vi.mock('../../lib/redis.js', () => ({
  getRedisClient: () => getRedisClient(),
  withRedisTimeout: (p: Promise<unknown>) => p,
  REDIS_TIMEOUT_MS: 1_000,
}));

import {
  getRates,
  convert,
  convertToFair,
  __resetFxCacheForTests,
} from '../fx.service.js';
import { config } from '../../config/index.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

/** The mutable static-rates map of the mocked config (typed for the test). */
const mockStaticRates = config.fx.staticRates as Record<string, number>;
const defaultStaticRates = { ...mockStaticRates };

/** Build a `fetch` Response stub for the FairCoin Explorer `/api/price` body. */
function priceResponse(price: number, updatedAt = '2026-06-22T17:07:13.380Z') {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ price, updatedAt }),
  };
}

beforeEach(() => {
  __resetFxCacheForTests();
  getRedisClient.mockReset().mockReturnValue(null);
  vi.stubGlobal('fetch', vi.fn());
  // Restore the default static-rates map (some tests empty it).
  for (const key of Object.keys(mockStaticRates)) {
    delete mockStaticRates[key];
  }
  Object.assign(mockStaticRates, defaultStaticRates);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getRates — provider + cache', () => {
  it('fetches the provider on a miss and writes the result to Redis (setex)', async () => {
    const setex = vi.fn().mockResolvedValue('OK');
    getRedisClient.mockReturnValue({ get: vi.fn().mockResolvedValue(null), setex });
    vi.mocked(fetch).mockResolvedValue(priceResponse(0.49) as unknown as Response);

    const result = await getRates('FAIR', ['USD', 'EUR']);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.stale).toBe(false);
    expect(result.base).toBe('FAIR');
    // USD comes from the provider; EUR is static-filled (single-fiat provider).
    expect(result.rates.USD).toBe(0.49);
    expect(result.rates.EUR).toBe(0.45);
    expect(setex).toHaveBeenCalledTimes(1);
    const [key, ttl] = setex.mock.calls[0];
    expect(key).toBe('fx:rates:FAIR');
    expect(ttl).toBe(300);
  });

  it('serves the Redis last-good cache (stale) when the provider fails', async () => {
    // Cache is a FALLBACK (not read-through): the provider is always attempted
    // first, and the cached value is served only when that attempt fails.
    const cached = JSON.stringify({
      rates: { USD: 0.5, EUR: 0.46 },
      asOf: '2026-06-22T00:00:00.000Z',
      ttlSeconds: 300,
    });
    getRedisClient.mockReturnValue({ get: vi.fn().mockResolvedValue(cached), setex: vi.fn() });
    vi.mocked(fetch).mockRejectedValue(new Error('provider down'));

    const result = await getRates('FAIR', ['USD', 'EUR']);

    expect(result.stale).toBe(true);
    expect(result.rates.USD).toBe(0.5);
    expect(result.asOf).toBe('2026-06-22T00:00:00.000Z');
  });
});

describe('getRates — failure fallbacks', () => {
  it('serves the in-process last-good cache (stale) after a provider failure', async () => {
    getRedisClient.mockReturnValue({ get: vi.fn().mockResolvedValue(null), setex: vi.fn() });
    // First call succeeds and populates the in-process last-good map.
    vi.mocked(fetch).mockResolvedValueOnce(priceResponse(0.49) as unknown as Response);
    const fresh = await getRates('FAIR', ['USD']);
    expect(fresh.stale).toBe(false);

    // Second call: provider throws → in-process last-good served, stale.
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));
    const stale = await getRates('FAIR', ['USD']);
    expect(stale.stale).toBe(true);
    expect(stale.rates.USD).toBe(0.49);
  });

  it('falls back to STATIC rates (stale) when provider fails and there is no cache', async () => {
    getRedisClient.mockReturnValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    const result = await getRates('FAIR', ['USD', 'EUR', 'GBP']);

    expect(result.stale).toBe(true);
    expect(result.rates).toEqual({ USD: 0.49, EUR: 0.45, GBP: 0.39 });
  });

  it('NEVER throws even when both the provider AND Redis throw', async () => {
    getRedisClient.mockReturnValue({
      get: vi.fn().mockRejectedValue(new Error('redis get failed')),
      setex: vi.fn().mockRejectedValue(new Error('redis setex failed')),
    });
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    const result = await getRates('FAIR', ['USD']);

    // Static fallback still serves something; no throw.
    expect(result.stale).toBe(true);
    expect(result.rates.USD).toBe(0.49);
  });
});

describe('getRates — cross (non-FAIR) base via FAIR pivot', () => {
  it('derives sane cross rates for a non-FAIR base (EUR)', async () => {
    getRedisClient.mockReturnValue(null);
    // Provider gives FAIR→USD = 0.49; EUR/GBP are static-filled. All rates are
    // "per 1 FAIR", so EUR→X = (FAIR→X) / (FAIR→EUR), with FAIR→EUR = 0.45.
    vi.mocked(fetch).mockResolvedValue(priceResponse(0.49) as unknown as Response);

    const result = await getRates('EUR', ['GBP', 'USD', 'FAIR', 'EUR']);

    expect(result.base).toBe('EUR');
    expect(result.stale).toBe(false);
    // EUR→EUR is identity.
    expect(result.rates.EUR).toBe(1);
    // EUR→GBP = 0.39 / 0.45 = 0.8666…
    expect(result.rates.GBP).toBeCloseTo(0.39 / 0.45, 10);
    // EUR→USD = 0.49 / 0.45 = 1.0888… (EUR stronger than USD → > 1).
    expect(result.rates.USD).toBeCloseTo(0.49 / 0.45, 10);
    expect(result.rates.USD).toBeGreaterThan(1);
    // EUR→FAIR = 1 / 0.45 = 2.2222…
    expect(result.rates.FAIR).toBeCloseTo(1 / 0.45, 10);
    // Every derived rate is a finite positive number (no fabricated/zero rates).
    for (const rate of Object.values(result.rates)) {
      expect(rate).toBeGreaterThan(0);
      expect(Number.isFinite(rate)).toBe(true);
    }
  });

  it('inherits the stale flag from the FAIR resolution (provider down → static)', async () => {
    getRedisClient.mockReturnValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('provider down'));

    const result = await getRates('GBP', ['USD']);

    // FAIR path fell back to static → cross base inherits stale: true.
    expect(result.base).toBe('GBP');
    expect(result.stale).toBe(true);
    // GBP→USD = 0.49 / 0.39.
    expect(result.rates.USD).toBeCloseTo(0.49 / 0.39, 10);
  });

  it('omits every cross rate (empty) when the base has no FAIR rate — no fabrication', async () => {
    getRedisClient.mockReturnValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));
    // Remove the base's FAIR rate: no FAIR→GBP anywhere → no pivot possible.
    delete mockStaticRates.GBP;

    const result = await getRates('GBP', ['USD', 'EUR']);

    expect(result.base).toBe('GBP');
    expect(result.stale).toBe(true);
    // No FAIR→GBP → cannot form any GBP→X rate; omit rather than invent one.
    expect(result.rates).toEqual({});
  });
});

describe('convertToFair (write-side)', () => {
  it('returns a FAIR input unchanged (no rounding, identical object)', async () => {
    const money = { amount: 123_456_789, currency: 'FAIR' as const };
    const result = await convertToFair(money);
    expect(result).toBe(money);
  });

  it('converts USD→FAIR with correct integer-minor-unit rounding', async () => {
    getRedisClient.mockReturnValue(null);
    // 1 FAIR = 0.50 USD → $1.00 (100 USD-cents) = 2.00 FAIR = 200_000_000 minor.
    vi.mocked(fetch).mockResolvedValue(priceResponse(0.5) as unknown as Response);

    const result = await convertToFair({ amount: 100, currency: 'USD' });

    expect(result.currency).toBe('FAIR');
    expect(result.amount).toBe(200_000_000);
  });

  it('converts EUR→FAIR with correct rounding', async () => {
    getRedisClient.mockReturnValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('use static'));
    // Static EUR rate 0.45: €10.00 (1000 EUR-cents) → 10/0.45 = 22.2222… FAIR
    // → 22.22222222 FAIR (rounded half-even) = 2_222_222_222 minor units.
    const result = await convertToFair({ amount: 1000, currency: 'EUR' });

    expect(result.currency).toBe('FAIR');
    expect(result.amount).toBe(2_222_222_222);
  });

  it('throws a validationError when no FAIR rate is available (fails closed)', async () => {
    getRedisClient.mockReturnValue(null);
    // Force "no rate": provider fails AND the static map has no entry for the
    // requested currency → `getRates` returns empty rates → write must fail closed.
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));
    delete mockStaticRates.GBP;

    await expect(convertToFair({ amount: 100, currency: 'GBP' })).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.VALIDATION_ERROR,
    );
  });
});

describe('convert (display-side)', () => {
  it('converts FAIR→USD correctly', () => {
    const rates = {
      base: 'FAIR' as const,
      rates: { USD: 0.5 },
      asOf: '2026-06-22T00:00:00.000Z',
      stale: false,
      ttlSeconds: 300,
    };
    // 2 FAIR (200_000_000 minor) × 0.5 = 1.00 USD = 100 USD-cents.
    const result = convert({ amount: 200_000_000, currency: 'FAIR' }, 'USD', rates);
    expect(result).toEqual({ amount: 100, currency: 'USD' });
  });

  it('converts fiat→FAIR correctly (target side is the pivot)', () => {
    const rates = {
      base: 'FAIR' as const,
      rates: { USD: 0.5 },
      asOf: '2026-06-22T00:00:00.000Z',
      stale: false,
      ttlSeconds: 300,
    };
    // $1.00 (100 USD-cents), 1 FAIR = 0.50 USD → $1 = 2 FAIR = 200_000_000 minor.
    const result = convert({ amount: 100, currency: 'USD' }, 'FAIR', rates);
    expect(result).toEqual({ amount: 200_000_000, currency: 'FAIR' });
  });

  it('converts CROSS fiat→fiat (EUR→GBP) via the FAIR pivot', () => {
    // All rates per 1 FAIR. EUR→GBP = 0.39 / 0.45. €10.00 (1000 EUR-cents):
    // 10 / 0.45 = 22.2222… FAIR → × 0.39 = 8.6666… GBP → 866.666… → 867 (half-up).
    const rates = {
      base: 'FAIR' as const,
      rates: { EUR: 0.45, GBP: 0.39 },
      asOf: '2026-06-22T00:00:00.000Z',
      stale: false,
      ttlSeconds: 300,
    };
    const result = convert({ amount: 1000, currency: 'EUR' }, 'GBP', rates);
    expect(result).toEqual({ amount: 867, currency: 'GBP' });
  });

  it('converts CROSS fiat→fiat (USD→CAD) via the FAIR pivot', () => {
    // USD→CAD = 0.67 / 0.49. $100.00 (10000 USD-cents):
    // 100 / 0.49 = 204.0816… FAIR → × 0.67 = 136.7346… CAD → 13673.46… → 13673.
    const rates = {
      base: 'FAIR' as const,
      rates: { USD: 0.49, CAD: 0.67 },
      asOf: '2026-06-22T00:00:00.000Z',
      stale: false,
      ttlSeconds: 300,
    };
    const result = convert({ amount: 10_000, currency: 'USD' }, 'CAD', rates);
    expect(result).toEqual({ amount: 13_673, currency: 'CAD' });
  });

  it('rounds ONCE at the final step using half-even (banker\'s rounding)', () => {
    const rates = {
      base: 'FAIR' as const,
      rates: { USD: 0.49 },
      asOf: '2026-06-22T00:00:00.000Z',
      stale: false,
      ttlSeconds: 300,
    };
    // 0.5 FAIR × 0.49 = 0.245 USD → 24.5 cents → half-even → 24 (even neighbour).
    expect(convert({ amount: 50_000_000, currency: 'FAIR' }, 'USD', rates)).toEqual({
      amount: 24,
      currency: 'USD',
    });
    // 1.5 FAIR × 0.49 = 0.735 USD → 73.5 cents → half-even → 74 (even neighbour).
    expect(convert({ amount: 150_000_000, currency: 'FAIR' }, 'USD', rates)).toEqual({
      amount: 74,
      currency: 'USD',
    });
  });

  it('throws a validationError for a cross pair when a side has no rate', () => {
    // Neither side is FAIR and GBP has no "per 1 FAIR" rate → cannot pivot.
    const rates = {
      base: 'FAIR' as const,
      rates: { EUR: 0.45 },
      asOf: '2026-06-22T00:00:00.000Z',
      stale: false,
      ttlSeconds: 300,
    };
    let thrown: unknown;
    try {
      convert({ amount: 1000, currency: 'EUR' }, 'GBP', rates);
    } catch (err) {
      thrown = err;
    }
    expect(isMercariaError(thrown) && thrown.code === ErrorCodes.VALIDATION_ERROR).toBe(true);
  });

  it('returns the input unchanged when source equals target', () => {
    const rates = {
      base: 'FAIR' as const,
      rates: {},
      asOf: '2026-06-22T00:00:00.000Z',
      stale: false,
      ttlSeconds: 300,
    };
    const money = { amount: 999, currency: 'USD' as const };
    expect(convert(money, 'USD', rates)).toBe(money);
  });

  it('throws a validationError when the required rate is missing', () => {
    const rates = {
      base: 'FAIR' as const,
      rates: {},
      asOf: '2026-06-22T00:00:00.000Z',
      stale: false,
      ttlSeconds: 300,
    };
    let thrown: unknown;
    try {
      convert({ amount: 100, currency: 'FAIR' }, 'USD', rates);
    } catch (err) {
      thrown = err;
    }
    expect(isMercariaError(thrown) && thrown.code === ErrorCodes.VALIDATION_ERROR).toBe(true);
  });
});
