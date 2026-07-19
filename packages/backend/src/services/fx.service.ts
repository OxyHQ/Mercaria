/**
 * FX (foreign-exchange) service — the single source of currency conversion.
 *
 * FairCoin (`FAIR`, ⊜) is the CANONICAL SETTLEMENT currency. Catalog prices are
 * now stored in their NATIVE currency (multi-currency, presentment + shop); FAIR
 * conversion happens only at the settlement boundary. This service covers:
 *
 *  - SETTLEMENT-side (`convertToFair`): at the `paid` transition an order's SHOP
 *    grand total is converted to FAIR for payout. This path FAILS CLOSED — if no
 *    rate is available it THROWS, so we never settle a wrong amount. This is the
 *    ONLY remaining FAIR-conversion write path (the catalog no longer converts).
 *
 *  - PRICING/DISPLAY-side (`getRates`/`convert`/`toDualMoney`/`pairRate`): a
 *    presentation conversion between any pair of currencies (source → FAIR →
 *    target) used to form the presentment side of order/refund `DualMoney` and
 *    currencies for dual-currency display. Every rate is quoted "per 1 FAIR", so
 *    FAIR is the universal pivot: `getRates` serves ANY base (FAIR directly, a
 *    non-FAIR base derived as `(FAIR→quote)/(FAIR→base)`) and `convert` handles
 *    any pair (source → FAIR → target). `getRates` NEVER throws: it always
 *    returns an `FxRates` (fresh, last-good, or static fallback) so a transient
 *    provider/Redis outage can't break rendering.
 *
 * Rates are cached in Redis (when configured) plus a tiny in-process last-good
 * map so display keeps working without Redis and the upstream provider is not
 * hammered.
 */

import { z } from 'zod';
import type { CurrencyCode, DualMoney, FxRates, Money } from '@mercaria/shared-types';
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
 * Resolve FAIR-based FX rates against `quotes`. NEVER throws — the display path
 * depends on always getting an `FxRates`:
 *  1. Fresh provider fetch → cached (Redis + in-process) → `stale: false`.
 *  2. Provider failure → last-good cache (Redis, then in-process) → `stale: true`.
 *  3. No cache anywhere → `StaticFxProvider` rates → `stale: true`.
 *  4. Even static failing (should never happen) → empty rates → `stale: true`.
 *
 * FAIR is the SINGLE cached base (`fx:rates:FAIR`): every rate the providers and
 * static config expose is quoted "per 1 FAIR", so a non-FAIR base is derived
 * from these rates (`resolveCrossBaseRates`) rather than cached separately.
 */
async function resolveFairBaseRates(quotes: CurrencyCode[]): Promise<FxRates> {
  const ttlSeconds = config.fx.cacheTtlSeconds;
  const base: CurrencyCode = 'FAIR';

  try {
    const providerRates = await selectProvider().getRates(base, quotes);
    const rates: Record<string, number> = { ...providerRates };
    if (quotes.includes('FAIR')) {
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
 * Resolve display rates for a NON-FAIR `base` by pivoting through FAIR. Every
 * rate the providers/static config expose is quoted "per 1 FAIR", so a
 * `base→quote` rate is `(FAIR→quote) / (FAIR→base)`:
 *
 *   1 base = (1 / (FAIR→base)) FAIR = ((FAIR→quote) / (FAIR→base)) quote
 *
 * The FAIR-based rates come from `resolveFairBaseRates`, so this inherits its
 * never-throws / last-good / stale semantics and its single Redis cache
 * authority (keyed on FAIR — cross rates are derived, never cached separately).
 * A quote is OMITTED (never fabricated) when its pivot rate is missing: if the
 * `FAIR→base` rate itself is unavailable NO cross rate can be formed and the
 * result is empty; `quote === base` is always 1 and needs no rate.
 */
async function resolveCrossBaseRates(base: CurrencyCode, quotes: CurrencyCode[]): Promise<FxRates> {
  // Everything derives from `FAIR→base` and `FAIR→quote`, so request the FAIR
  // rate for the base plus each distinct non-FAIR, non-base quote.
  const fairQuotes: CurrencyCode[] = [base];
  for (const quote of quotes) {
    if (quote !== 'FAIR' && quote !== base && !fairQuotes.includes(quote)) {
      fairQuotes.push(quote);
    }
  }

  const fair = await resolveFairBaseRates(fairQuotes);
  const fairToBase = fair.rates[base];
  const rates: Record<string, number> = {};

  for (const quote of quotes) {
    if (quote === base) {
      rates[quote] = 1;
      continue;
    }
    if (fairToBase === undefined || !(fairToBase > 0)) {
      // No FAIR→base rate → no pivot is possible; omit rather than fabricate.
      continue;
    }
    if (quote === 'FAIR') {
      rates.FAIR = 1 / fairToBase;
      continue;
    }
    const fairToQuote = fair.rates[quote];
    if (fairToQuote !== undefined && fairToQuote > 0) {
      rates[quote] = fairToQuote / fairToBase;
    }
  }

  return { base, rates, asOf: fair.asOf, stale: fair.stale, ttlSeconds: fair.ttlSeconds };
}

/**
 * Resolve FX rates for `base` against `quotes`. NEVER throws. Supports ANY base:
 * FAIR uses the cached provider/static path directly; a non-FAIR base is derived
 * by pivoting through FAIR (every rate is quoted "per 1 FAIR"). `FAIR→FAIR = 1`
 * and `base→base = 1`.
 */
export async function getRates(base: CurrencyCode, quotes: CurrencyCode[]): Promise<FxRates> {
  return base === 'FAIR' ? resolveFairBaseRates(quotes) : resolveCrossBaseRates(base, quotes);
}

/**
 * The "units of `currency` per 1 FAIR" rate used to pivot through FAIR. FAIR is
 * 1 by definition; any other currency reads its `per 1 FAIR` rate from `rates`.
 * Throws `validationError` when a non-FAIR currency has no rate — a rate is
 * never fabricated.
 */
function fairPivotRate(currency: CurrencyCode, rates: FxRates): number {
  if (currency === 'FAIR') {
    return 1;
  }
  const rate = rates.rates[currency];
  if (rate === undefined || !(rate > 0)) {
    throw validationError(`No exchange rate available for ${currency} (per 1 FAIR)`);
  }
  return rate;
}

/**
 * Convert `money` to `target` using `rates`. Every rate in `rates` is quoted
 * "per 1 FAIR" (`rates.rates[X]` = units of X per 1 FAIR), so FAIR is the
 * universal pivot: source → FAIR → target. Any currency pair is supported —
 * FAIR↔fiat and cross fiat↔fiat alike. Rounding to integer minor units
 * (half-even) happens ONCE, at the final step, so a cross conversion never
 * double-rounds. Returns a `Money` in `target`.
 *
 * Throws `validationError` when a non-FAIR side has no `per 1 FAIR` rate.
 */
export function convert(money: Money, target: CurrencyCode, rates: FxRates): Money {
  if (money.currency === target) {
    return money;
  }

  const sourcePerFair = fairPivotRate(money.currency, rates);
  const targetPerFair = fairPivotRate(target, rates);

  const majorSource = money.amount / minorUnitsPerMajor(money.currency);
  const majorFair = majorSource / sourcePerFair;
  const majorTarget = majorFair * targetPerFair;
  return { amount: roundMinorUnits(majorTarget * minorUnitsPerMajor(target)), currency: target };
}

/**
 * The exchange rate to apply to convert ONE unit of `from` into `to` under
 * `rates` (units of `to` per 1 `from`). FAIR is the universal pivot, so this is
 * `(to per 1 FAIR) / (from per 1 FAIR)`; an equal pair is exactly 1. Throws
 * `validationError` when either side has no `per 1 FAIR` rate — never fabricated.
 */
export function pairRate(from: CurrencyCode, to: CurrencyCode, rates: FxRates): number {
  if (from === to) {
    return 1;
  }
  return fairPivotRate(to, rates) / fairPivotRate(from, rates);
}

/**
 * Form a `DualMoney` from a SHOP-currency `Money`: the `shop` side is `shop`
 * as-is, and the `presentment` side is `shop` converted into
 * `presentmentCurrency` via `convert` (a same-currency pair is byte-identical, no
 * rounding). Every order/refund money field is built through here so the two
 * sides always describe the same value at the captured rates.
 */
export function toDualMoney(
  shop: Money,
  presentmentCurrency: CurrencyCode,
  rates: FxRates,
): DualMoney {
  return { shop, presentment: convert(shop, presentmentCurrency, rates) };
}

/**
 * SETTLEMENT-side conversion: convert a SHOP-currency `money` to FAIR for payout
 * at the `paid` transition. FAIR input is returned UNCHANGED (byte-identical, no
 * rounding). For a non-FAIR input this fetches the FAIR rate and converts X→FAIR.
 * This is the ONLY remaining FAIR-conversion write path — the catalog stores
 * native currency and never converts.
 *
 * FAILS CLOSED: unlike the display path, if no FAIR exchange rate is available
 * for the shop currency this THROWS `validationError` — we must never settle a
 * wrong FAIR amount.
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
