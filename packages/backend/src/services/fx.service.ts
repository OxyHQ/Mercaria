/**
 * FX (foreign-exchange) service — the single source of currency conversion.
 *
 * FairCoin (`FAIR`, ⊜) is the CANONICAL currency: EVERYTHING is STORED in FAIR.
 * This service exists for the two conversion boundaries only:
 *
 *  - WRITE-side (`convertToFair`): a store/seller MAY submit a price in a fiat
 *    currency; we convert it to FAIR and persist FAIR. The fiat amount is never
 *    stored. This path FAILS CLOSED — if no rate is available it THROWS, so we
 *    never silently persist a wrong amount.
 *
 *  - DISPLAY-side (`getRates`/`convert`): a presentation-only conversion of a
 *    stored FAIR amount into a viewer's fiat for dual-currency display. This path
 *    NEVER throws: `getRates` always returns an `FxRates` (fresh, last-good, or
 *    static fallback) so a transient provider/Redis outage can't break rendering.
 *
 * Rates are cached in Redis (when configured) plus a tiny in-process last-good
 * map so display keeps working without Redis and the upstream provider is not
 * hammered.
 */

import { z } from 'zod';
import type { CurrencyCode, FxRates, Money } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { getRedisClient, withRedisTimeout } from '../lib/redis.js';
import { log } from '../lib/logger.js';
import { validationError } from '../lib/errors/error-codes.js';
import { minorUnitsPerMajor, roundMinorUnits } from '../utils/money.js';

/**
 * A rate provider. `getRates` returns a `quote code → units of quote per 1 base`
 * map (i.e. `1 base = rate fiat`). A provider MAY omit quotes it cannot serve;
 * the `getRates` caching layer fills any gaps from the static rates.
 */
export interface FxProvider {
  getRates(base: CurrencyCode, quotes: CurrencyCode[]): Promise<Record<string, number>>;
}

/** Redis key prefix for cached rate sets, keyed by base currency. */
const CACHE_KEY_PREFIX = 'fx:rates:';

/** The cached payload shape persisted in Redis (rates + provenance). */
const cachedRatesSchema = z.object({
  rates: z.record(z.string(), z.number()),
  asOf: z.string(),
  ttlSeconds: z.number(),
});

type CachedRates = z.infer<typeof cachedRatesSchema>;

/** The FairCoin Explorer `/api/price` response (only the fields we consume). */
const explorerPriceSchema = z.object({
  /** 1 FAIR in USD (sourced from the WFAIR/USDC pool). */
  price: z.number().finite().positive(),
  /** ISO timestamp the price was computed; optional in older responses. */
  updatedAt: z.string().optional(),
});

/**
 * In-process last-good cache, keyed by base currency. Survives a missing/failing
 * Redis so the display path always has something to serve. Process-local by
 * design — Redis is the cross-instance cache.
 */
const inProcessLastGood = new Map<string, CachedRates>();

/**
 * Live FairCoin Explorer provider.
 *
 * SINGLE-FIAT LIMITATION: the Explorer's `/api/price` endpoint returns ONLY a
 * FAIR→USD price — it ignores any `?currency=`/`?vs=` query param (verified
 * against the live endpoint). So this provider can populate ONLY the `USD` quote
 * for a FAIR base. Any other requested quote (EUR/GBP) is simply omitted; the
 * `getRates` layer fills those from `config.fx.staticRates`. Only a FAIR base is
 * supported (B1 needs nothing else); a non-FAIR base throws.
 */
class FaircoinExplorerFxProvider implements FxProvider {
  async getRates(base: CurrencyCode, quotes: CurrencyCode[]): Promise<Record<string, number>> {
    if (base !== 'FAIR') {
      throw new Error(`FaircoinExplorer provider only supports a FAIR base, received ${base}`);
    }

    const url = `${config.fx.faircoinExplorerBaseUrl}/api/price`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(config.fx.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`FairCoin Explorer returned HTTP ${response.status}`);
    }

    const parsed = explorerPriceSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(`FairCoin Explorer response failed validation: ${parsed.error.message}`);
    }

    // The Explorer's own timestamp is logged for observability; `getRates` uses
    // the fetch time as `asOf` (the provider interface yields rates only).
    log.general.info(
      { price: parsed.data.price, providerUpdatedAt: parsed.data.updatedAt },
      'FairCoin Explorer FAIR→USD price fetched',
    );

    // FAIR→USD is the only derivable quote here.
    const result: Record<string, number> = {};
    if (quotes.includes('USD')) {
      result.USD = parsed.data.price;
    }
    return result;
  }
}

/** Static (dev/last-resort) provider: serves `config.fx.staticRates`. */
class StaticFxProvider implements FxProvider {
  async getRates(base: CurrencyCode, quotes: CurrencyCode[]): Promise<Record<string, number>> {
    if (base !== 'FAIR') {
      throw new Error(`Static provider only supports a FAIR base, received ${base}`);
    }
    const result: Record<string, number> = {};
    for (const quote of quotes) {
      if (quote === 'FAIR') {
        result.FAIR = 1;
        continue;
      }
      const rate = config.fx.staticRates[quote];
      if (rate !== undefined) {
        result[quote] = rate;
      }
    }
    return result;
  }
}

/** Resolve the configured provider strategy. */
function selectProvider(): FxProvider {
  return config.fx.provider === 'faircoin_explorer'
    ? new FaircoinExplorerFxProvider()
    : new StaticFxProvider();
}

/** Fill any quotes the provider omitted from the static rates (FAIR base). */
function fillFromStatic(base: CurrencyCode, quotes: CurrencyCode[], rates: Record<string, number>): void {
  for (const quote of quotes) {
    if (rates[quote] !== undefined) {
      continue;
    }
    if (quote === 'FAIR' && base === 'FAIR') {
      rates.FAIR = 1;
      continue;
    }
    if (base === 'FAIR') {
      const staticRate = config.fx.staticRates[quote as Exclude<CurrencyCode, 'FAIR'>];
      if (staticRate !== undefined) {
        rates[quote] = staticRate;
      }
    }
  }
}

/** Read the last-good cached rates for `base` (Redis first, then in-process). */
async function readLastGood(base: CurrencyCode): Promise<CachedRates | null> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const raw = await withRedisTimeout(redis.get(`${CACHE_KEY_PREFIX}${base}`));
      if (raw) {
        const parsed = cachedRatesSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          return parsed.data;
        }
        log.general.warn({ base }, 'Cached FX rates failed validation; ignoring');
      }
    } catch (err) {
      log.general.warn({ err, base }, 'Failed to read FX rates from Redis cache');
    }
  }
  return inProcessLastGood.get(base) ?? null;
}

/** Persist resolved rates to Redis (best-effort) + the in-process last-good map. */
async function writeCache(base: CurrencyCode, payload: CachedRates): Promise<void> {
  inProcessLastGood.set(base, payload);
  const redis = getRedisClient();
  if (!redis) {
    return;
  }
  try {
    await withRedisTimeout(
      redis.setex(`${CACHE_KEY_PREFIX}${base}`, payload.ttlSeconds, JSON.stringify(payload)),
    );
  } catch (err) {
    log.general.warn({ err, base }, 'Failed to write FX rates to Redis cache');
  }
}

/**
 * Resolve FX rates for `base` against `quotes`. NEVER throws — the display path
 * depends on always getting an `FxRates`:
 *  1. Fresh provider fetch → cached (Redis + in-process) → `stale: false`.
 *  2. Provider failure → last-good cache (Redis, then in-process) → `stale: true`.
 *  3. No cache anywhere → `StaticFxProvider` rates → `stale: true`.
 *  4. Even static failing (should never happen) → empty rates → `stale: true`.
 */
export async function getRates(base: CurrencyCode, quotes: CurrencyCode[]): Promise<FxRates> {
  const ttlSeconds = config.fx.cacheTtlSeconds;

  try {
    const providerRates = await selectProvider().getRates(base, quotes);
    const rates: Record<string, number> = { ...providerRates };
    if (quotes.includes('FAIR') && base === 'FAIR') {
      rates.FAIR = 1;
    }
    fillFromStatic(base, quotes, rates);

    const asOf = new Date().toISOString();
    await writeCache(base, { rates, asOf, ttlSeconds });
    return { base, rates, asOf, stale: false, ttlSeconds };
  } catch (err) {
    log.general.warn({ err, base }, 'FX provider failed; serving last-good or static rates');

    const lastGood = await readLastGood(base);
    if (lastGood) {
      return { base, rates: lastGood.rates, asOf: lastGood.asOf, stale: true, ttlSeconds };
    }

    try {
      const staticRates = await new StaticFxProvider().getRates(base, quotes);
      return { base, rates: staticRates, asOf: new Date().toISOString(), stale: true, ttlSeconds };
    } catch (staticErr) {
      log.general.error({ err: staticErr, base }, 'Static FX fallback failed; returning empty rates');
      return { base, rates: {}, asOf: new Date().toISOString(), stale: true, ttlSeconds };
    }
  }
}

/**
 * Convert `money` to `target` using `rates` (whose base is FAIR). ONLY FAIR↔fiat
 * is supported — one side MUST be FAIR. A `rate` for currency X means `1 FAIR =
 * rate X`. Returns an integer-minor-unit `Money` in `target` (half-even rounded).
 * Throws `validationError` when neither side is FAIR or the needed rate is absent.
 */
export function convert(money: Money, target: CurrencyCode, rates: FxRates): Money {
  if (money.currency === target) {
    return money;
  }

  if (money.currency === 'FAIR') {
    const rate = rates.rates[target];
    if (rate === undefined || !(rate > 0)) {
      throw validationError(`No exchange rate available from FAIR to ${target}`);
    }
    const majorFair = money.amount / minorUnitsPerMajor('FAIR');
    const majorTarget = majorFair * rate;
    return { amount: roundMinorUnits(majorTarget * minorUnitsPerMajor(target)), currency: target };
  }

  if (target === 'FAIR') {
    const rate = rates.rates[money.currency];
    if (rate === undefined || !(rate > 0)) {
      throw validationError(`No exchange rate available from ${money.currency} to FAIR`);
    }
    const majorSource = money.amount / minorUnitsPerMajor(money.currency);
    const majorFair = majorSource / rate;
    return { amount: roundMinorUnits(majorFair * minorUnitsPerMajor('FAIR')), currency: 'FAIR' };
  }

  throw validationError(
    `Unsupported conversion ${money.currency}→${target}: one side must be FAIR`,
  );
}

/**
 * WRITE-side conversion: normalize any submitted price `money` to FAIR for
 * storage. FAIR input is returned UNCHANGED (byte-identical, no rounding). For a
 * fiat input this fetches the FAIR rate and converts X→FAIR.
 *
 * FAILS CLOSED: unlike the display path, if no FAIR exchange rate is available
 * for the fiat currency this THROWS `validationError` — we must never silently
 * persist a wrong FAIR amount.
 */
export async function convertToFair(money: Money): Promise<Money> {
  if (money.currency === 'FAIR') {
    return money;
  }

  const fx = await getRates('FAIR', [money.currency]);
  const rate = fx.rates[money.currency];
  if (rate === undefined || !(rate > 0)) {
    throw validationError(`No FAIR exchange rate available for ${money.currency}`);
  }

  const majorSource = money.amount / minorUnitsPerMajor(money.currency);
  const majorFair = majorSource / rate;
  return { amount: roundMinorUnits(majorFair * minorUnitsPerMajor('FAIR')), currency: 'FAIR' };
}

/**
 * Test-only: clear the in-process last-good cache between cases so tests don't
 * leak resolved rates into one another. Not used by production code paths.
 */
export function __resetFxCacheForTests(): void {
  inProcessLastGood.clear();
}
