/**
 * Unit tests for `fx.service` — the conversion + caching boundary.
 *
 * `mongodb-memory-server` and a live FairCoin Explorer are unavailable offline,
 * so `config` is mocked with a deterministic `fx` block, `lib/redis` is mocked
 * (toggleable Redis client), and the global `fetch` is stubbed. These tests
 * assert: provider fetch → cache write (`setex`) on a miss, cache hit serving
 * without re-fetching, last-good `stale` fallback on provider failure, static
 * `stale` fallback when no cache exists, that `getRates` NEVER throws, that every
 * result NAMES the source that produced it, and the `convert`/`pairRate` rounding
 * and fail-closed behaviour.
 *
 * The PROVIDER-NEUTRALITY cases are the point of the suite rather than a corner
 * of it: `convert` reads both sides against the rate map's own base, so a rate
 * set that contains no FAIR entry at all converts correctly. FAIR appearing
 * everywhere else here is a property of the CONFIGURED providers (both publish
 * "per 1 FAIR"), not of the contract.
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
      staticRates: { USD: 0.49, EUR: 0.45, GBP: 0.39, CAD: 0.67, AUD: 0.75, JPY: 73.5 },
    },
  },
}));

vi.mock('../../lib/redis.js', () => ({
  getRedisClient: () => getRedisClient(),
  withRedisTimeout: (p: Promise<unknown>) => p,
  REDIS_TIMEOUT_MS: 1_000,
}));

import { MAX_MONEY_MINOR_UNITS, type CurrencyCode, type FxRates } from '@mercaria/shared-types';
import {
  getRates,
  convert,
  pairRate,
  toDualMoney,
  __resetFxCacheForTests,
} from '../fx.service.js';
import { config } from '../../config/index.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

/** The mutable static-rates map of the mocked config (typed for the test). */
const mockStaticRates = config.fx.staticRates as Record<string, number>;
const defaultStaticRates = { ...mockStaticRates };

/**
 * A resolved rate set to convert against, as a caller would hold one. `base`
 * defaults to FAIR because that is what the configured providers quote in — the
 * cases that pass a different base are asserting that nothing requires it.
 */
function rateSet(rates: Record<string, number>, base: CurrencyCode = 'FAIR'): FxRates {
  return {
    base,
    rates,
    provider: 'static',
    asOf: '2026-06-22T00:00:00.000Z',
    stale: false,
    ttlSeconds: 300,
  };
}

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
      provider: 'faircoin_explorer',
      asOf: '2026-06-22T00:00:00.000Z',
      ttlSeconds: 300,
    });
    getRedisClient.mockReturnValue({ get: vi.fn().mockResolvedValue(cached), setex: vi.fn() });
    vi.mocked(fetch).mockRejectedValue(new Error('provider down'));

    const result = await getRates('FAIR', ['USD', 'EUR']);

    expect(result.stale).toBe(true);
    expect(result.rates.USD).toBe(0.5);
    expect(result.asOf).toBe('2026-06-22T00:00:00.000Z');
    // The cached rates keep the attribution they were fetched under — a snapshot
    // taken from them must not claim they came from wherever we are now.
    expect(result.provider).toBe('faircoin_explorer');
  });

  it('DISCARDS a cached entry that names no provider rather than serving it anonymously', async () => {
    // The shape written before rate provenance existed. Serving it would put an
    // unattributable rate on an order snapshot, so it is treated as a cache miss.
    const legacy = JSON.stringify({
      rates: { USD: 0.5 },
      asOf: '2026-06-22T00:00:00.000Z',
      ttlSeconds: 300,
    });
    getRedisClient.mockReturnValue({ get: vi.fn().mockResolvedValue(legacy), setex: vi.fn() });
    vi.mocked(fetch).mockRejectedValue(new Error('provider down'));

    const result = await getRates('FAIR', ['USD']);

    expect(result.provider).toBe('static');
    expect(result.rates.USD).toBe(0.49);
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

describe('getRates — provenance', () => {
  it('names the CONFIGURED provider on a fresh fetch', async () => {
    getRedisClient.mockReturnValue(null);
    vi.mocked(fetch).mockResolvedValue(priceResponse(0.49) as unknown as Response);

    const result = await getRates('FAIR', ['USD']);

    expect(result.provider).toBe('faircoin_explorer');
    expect(result.stale).toBe(false);
  });

  it("names 'static' when the configured provider failed and the static map served", async () => {
    getRedisClient.mockReturnValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    const result = await getRates('FAIR', ['USD']);

    expect(result.provider).toBe('static');
    expect(result.stale).toBe(true);
  });

  it('returns an EMPTY map — never a fabricated rate — when no source has the pair', async () => {
    getRedisClient.mockReturnValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));
    // Empty the static map so even the last-resort source has nothing for a fiat
    // quote. It still ANSWERS (with nothing), so it is still the attributed
    // source; what must not happen is a rate appearing from somewhere.
    for (const key of Object.keys(mockStaticRates)) {
      delete mockStaticRates[key];
    }

    const result = await getRates('FAIR', ['USD']);

    expect(result.rates).toEqual({});
    expect(result.provider).toBe('static');
    // And a conversion against it fails closed rather than defaulting to 1:1.
    expect(() => convert({ amount: 100, currency: 'FAIR' }, 'USD', result)).toThrow();
  });

  it('carries the provenance through to a derived (non-provider) base', async () => {
    getRedisClient.mockReturnValue(null);
    vi.mocked(fetch).mockResolvedValue(priceResponse(0.49) as unknown as Response);

    const result = await getRates('EUR', ['USD']);

    expect(result.base).toBe('EUR');
    expect(result.provider).toBe('faircoin_explorer');
  });
});

describe('getRates — a base the providers do not publish in', () => {
  it('derives sane rates for a base the provider cannot quote (EUR)', async () => {
    getRedisClient.mockReturnValue(null);
    // Provider gives FAIR→USD = 0.49; EUR/GBP are static-filled. All provider
    // rates are "per 1 FAIR", so EUR→X = (FAIR→X) / (FAIR→EUR), FAIR→EUR = 0.45.
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

  it('inherits the stale flag from the underlying resolution (provider down → static)', async () => {
    getRedisClient.mockReturnValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('provider down'));

    const result = await getRates('GBP', ['USD']);

    // The provider-base path fell back to static → derived base inherits stale.
    expect(result.base).toBe('GBP');
    expect(result.stale).toBe(true);
    // GBP→USD = 0.49 / 0.39.
    expect(result.rates.USD).toBeCloseTo(0.49 / 0.39, 10);
  });

  it('omits every derived rate (empty) when the base itself has no rate — no fabrication', async () => {
    getRedisClient.mockReturnValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));
    // Remove the base's own rate: nothing relates GBP to the provider base.
    delete mockStaticRates.GBP;

    const result = await getRates('GBP', ['USD', 'EUR']);

    expect(result.base).toBe('GBP');
    expect(result.stale).toBe(true);
    // Nothing can be derived; omit rather than invent one.
    expect(result.rates).toEqual({});
  });

  it('still yields the identity rate for the base itself when nothing else resolves', async () => {
    // The single-currency case: a checkout whose shop, presentment and native
    // currencies are all GBP needs NO rate to complete, and must not be blocked
    // by an FX outage.
    getRedisClient.mockReturnValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));
    delete mockStaticRates.GBP;

    const result = await getRates('GBP', ['GBP']);

    expect(result.rates.GBP).toBe(1);
    expect(pairRate('GBP', 'GBP', result)).toBe(1);
  });
});

describe('convert — pairs, precision and rounding', () => {
  it('converts FAIR→USD correctly', () => {
    // 2 FAIR (200_000_000 minor) × 0.5 = 1.00 USD = 100 USD-cents.
    const result = convert({ amount: 200_000_000, currency: 'FAIR' }, 'USD', rateSet({ USD: 0.5 }));
    expect(result).toEqual({ amount: 100, currency: 'USD' });
  });

  it('converts fiat→FAIR at FULL eight-decimal precision', () => {
    // $1.00 at 1 FAIR = 0.49 USD → 1/0.49 = 2.040816326530612… ⊜.
    // Quantized to FAIR's 1e-8 minor unit: 204_081_632.653… → 204_081_633.
    // A 2-decimal quantization would have produced 204_081_600 — the eight
    // decimals are the point of the case.
    const result = convert({ amount: 100, currency: 'USD' }, 'FAIR', rateSet({ USD: 0.49 }));
    expect(result).toEqual({ amount: 204_081_633, currency: 'FAIR' });
  });

  it('keeps a sub-minor-unit FAIR amount from inventing value in a 2-decimal currency', () => {
    // 1 FAIR minor unit (1e-8 ⊜) is worth 5e-9 USD — far below a cent, so the
    // conversion is 0 rather than a fabricated 1-cent charge.
    const result = convert({ amount: 1, currency: 'FAIR' }, 'USD', rateSet({ USD: 0.5 }));
    expect(result).toEqual({ amount: 0, currency: 'USD' });
  });

  it('treats a ZERO-DECIMAL currency (JPY) as having no minor unit', () => {
    const rates = rateSet({ USD: 0.49, JPY: 73.5 });
    // ¥1000 is 1000 minor units, NOT 100_000. 1000/73.5 = 13.6054… ⊜ ×0.49 =
    // 6.6666… USD → 666.67 cents → 667.
    expect(convert({ amount: 1000, currency: 'JPY' }, 'USD', rates)).toEqual({
      amount: 667,
      currency: 'USD',
    });
    // And back: $10.00 → 20.4081… ⊜ × 73.5 = ¥1500, expressed as 1500 minor units.
    expect(convert({ amount: 1000, currency: 'USD' }, 'JPY', rates)).toEqual({
      amount: 1500,
      currency: 'JPY',
    });
  });

  it('converts a cross fiat pair (EUR→GBP)', () => {
    // €10.00: 10 / 0.45 = 22.2222… ⊜ → × 0.39 = 8.6666… GBP → 866.666… → 867.
    const result = convert(
      { amount: 1000, currency: 'EUR' },
      'GBP',
      rateSet({ EUR: 0.45, GBP: 0.39 }),
    );
    expect(result).toEqual({ amount: 867, currency: 'GBP' });
  });

  it('converts a cross fiat pair (USD→CAD)', () => {
    // $100.00: 100 / 0.49 = 204.0816… ⊜ → × 0.67 = 136.7346… CAD → 13673.
    const result = convert(
      { amount: 10_000, currency: 'USD' },
      'CAD',
      rateSet({ USD: 0.49, CAD: 0.67 }),
    );
    expect(result).toEqual({ amount: 13_673, currency: 'CAD' });
  });

  it('rounds ONCE at the final step using half-even (banker\'s rounding)', () => {
    const rates = rateSet({ USD: 0.49 });
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

  it('returns the input unchanged when source equals target', () => {
    const money = { amount: 999, currency: 'USD' as const };
    expect(convert(money, 'USD', rateSet({}))).toBe(money);
  });

  it('throws a validationError when the required rate is missing', () => {
    let thrown: unknown;
    try {
      convert({ amount: 100, currency: 'FAIR' }, 'USD', rateSet({}));
    } catch (err) {
      thrown = err;
    }
    expect(isMercariaError(thrown) && thrown.code === ErrorCodes.VALIDATION_ERROR).toBe(true);
  });

  it('throws a validationError for a cross pair when a side has no rate', () => {
    let thrown: unknown;
    try {
      convert({ amount: 1000, currency: 'EUR' }, 'GBP', rateSet({ EUR: 0.45 }));
    } catch (err) {
      thrown = err;
    }
    expect(isMercariaError(thrown) && thrown.code === ErrorCodes.VALIDATION_ERROR).toBe(true);
  });
});

describe('convert — no currency is architecturally required', () => {
  it('converts against a NON-FAIR base with no FAIR rate present at all', () => {
    // A rate set a direct-quoting provider would return: EUR base, no FAIR entry
    // anywhere. Nothing here can pivot through FAIR, and the conversion is still
    // exact — which is what makes FAIR an implementation detail of the current
    // providers rather than part of the contract.
    const rates = rateSet({ EUR: 1, USD: 1.1, GBP: 0.85 }, 'EUR');
    expect(rates.rates.FAIR).toBeUndefined();

    // €10.00 → $11.00.
    expect(convert({ amount: 1000, currency: 'EUR' }, 'USD', rates)).toEqual({
      amount: 1100,
      currency: 'USD',
    });
    // And a cross pair neither of which is the base: $11.00 → £8.50.
    expect(convert({ amount: 1100, currency: 'USD' }, 'GBP', rates)).toEqual({
      amount: 850,
      currency: 'GBP',
    });
    expect(pairRate('EUR', 'USD', rates)).toBeCloseTo(1.1, 10);
  });

  it('reads the identity from the rate map\'s OWN base, not from FAIR', () => {
    // The base is 1 by definition even though the map lists no rate for it.
    const rates = rateSet({ USD: 1.1 }, 'EUR');
    expect(pairRate('EUR', 'USD', rates)).toBeCloseTo(1.1, 10);
    // FAIR is just another currency here, and an unquoted one fails closed.
    expect(() => pairRate('EUR', 'FAIR', rates)).toThrow();
  });
});

describe('convert / toDualMoney — amount safety', () => {
  it('accepts an amount at exactly the representable maximum', () => {
    const money = { amount: MAX_MONEY_MINOR_UNITS, currency: 'USD' as const };
    expect(convert(money, 'USD', rateSet({}))).toBe(money);
  });

  it('REFUSES an amount one minor unit past the maximum', () => {
    // 2^53 is still an integer, and still exactly representable as a double —
    // it is the ARITHMETIC above this point that silently loses units, which is
    // why the guard is a declared ceiling rather than an `Number.isInteger` check.
    expect(() =>
      convert({ amount: MAX_MONEY_MINOR_UNITS + 1, currency: 'USD' }, 'USD', rateSet({})),
    ).toThrow(RangeError);
  });

  it('REFUSES a conversion whose RESULT would exceed the maximum', () => {
    // $9e12 into FAIR at 0.49 USD per ⊜ is ~1.8e21 minor units. The inputs are
    // each fine; only the result is not, so the assertion has to be on the
    // output — which is where it is.
    expect(() =>
      convert({ amount: 900_000_000_000_000, currency: 'USD' }, 'FAIR', rateSet({ USD: 0.49 })),
    ).toThrow(RangeError);
  });

  it('names the conversion in the failure message', () => {
    expect(() =>
      convert({ amount: 900_000_000_000_000, currency: 'USD' }, 'FAIR', rateSet({ USD: 0.49 })),
    ).toThrow(/fx\.convert\(USD→FAIR\)/);
  });

  it('asserts BOTH sides of a DualMoney', () => {
    const rates = rateSet({ USD: 0.49 });
    expect(() =>
      toDualMoney({ amount: MAX_MONEY_MINOR_UNITS + 1, currency: 'USD' }, 'USD', rates),
    ).toThrow(/toDualMoney/);
    // A representable shop side whose presentment side overflows is caught too.
    expect(() =>
      toDualMoney({ amount: 900_000_000_000_000, currency: 'USD' }, 'FAIR', rates),
    ).toThrow(/fx\.convert\(USD→FAIR\)/);
  });

  it('builds a byte-identical DualMoney for an equal pair', () => {
    const shop = { amount: 12_345, currency: 'EUR' as const };
    const dual = toDualMoney(shop, 'EUR', rateSet({}, 'EUR'));
    expect(dual.presentment).toBe(shop);
    expect(dual.shop).toBe(shop);
  });
});
