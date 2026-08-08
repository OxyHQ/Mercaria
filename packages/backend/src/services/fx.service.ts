/**
 * FX (foreign-exchange) service — the single source of currency conversion.
 *
 * The public contract is PROVIDER-NEUTRAL and names no privileged currency:
 * `getRates(base, quotes)` quotes any base against any quotes, `convert` and
 * `pairRate` handle any pair, and `toDualMoney` builds the presentment side of a
 * transacted amount. Nothing here settles anything — which currency a payment
 * settles in belongs to the payment domain and its provider.
 *
 * FAIR's role is twofold and both parts are deliberate:
 *  - A PRODUCT default: it is the presentment currency a buyer gets when they
 *    have chosen none, and the display default. That is policy, stated where the
 *    policy lives (`user-preference.service`), not an invariant of this module.
 *  - An IMPLEMENTATION DETAIL of the currently configured providers: both the
 *    FairCoin Explorer and the static fallback publish their rates "per 1 FAIR",
 *    so this service pivots through FAIR to serve an arbitrary pair. A provider
 *    that quotes pairs directly would satisfy the same `FxProvider` interface
 *    with no caller change — the pivot is not part of the contract, and callers
 *    must never assume a FAIR rate exists.
 *
 * `getRates` NEVER throws: it always returns an `FxRates` (fresh, last-good, or
 * static fallback) so a transient provider/Redis outage can't break rendering.
 * A pair no source can serve is OMITTED, never fabricated; `convert`/`pairRate`
 * then throw rather than invent a number. Every `FxRates` names the source that
 * produced it (`provider`), which is what a persisted `FxRateSnapshot` records.
 *
 * Rates are cached in Redis (when configured) plus a tiny in-process last-good
 * map so display keeps working without Redis and the upstream provider is not
 * hammered.
 */

import { z } from 'zod';
import {
  assertSafeMoneyAmount,
  type CurrencyCode,
  type DualMoney,
  type FxRates,
  type Money,
} from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { getRedisClient, withRedisTimeout } from '../lib/redis.js';
import { log } from '../lib/logger.js';
import { validationError } from '../lib/errors/error-codes.js';
import { minorUnitsPerMajor, roundMinorUnits } from '../utils/money.js';

/**
 * A rate provider. `getRates` returns a `quote code → units of quote per 1 base`
 * map (i.e. `1 base = rate quote`). A provider MAY omit quotes it cannot serve —
 * an omission is the honest answer and the caller degrades accordingly; it MUST
 * NOT substitute a default. A provider MAY also refuse a base it cannot quote
 * against, by throwing.
 */
export interface FxProvider {
  getRates(base: CurrencyCode, quotes: CurrencyCode[]): Promise<Record<string, number>>;
}

/**
 * The `FxRates.provider` value used when the configured provider failed AND no
 * cached rates existed, so the static fallback served the request. It is the
 * attribution even when the static map has nothing for the requested quote: the
 * source answered, and an empty answer is still that source's answer.
 */
const STATIC_PROVIDER_ID = 'static';

/**
 * The `FxRates.provider` value for the defensive last resort — the static
 * fallback itself throwing, which it does not do for any base this module asks
 * it for. It exists because that branch must still attribute the empty result to
 * SOMETHING, and claiming the static source produced it would be false.
 */
const NO_PROVIDER_ID = 'none';

/**
 * The currency the configured providers publish their rates against.
 *
 * This is an IMPLEMENTATION DETAIL of `FaircoinExplorerFxProvider` and
 * `StaticFxProvider` — both quote "units of X per 1 FAIR" — and is used to
 * derive an arbitrary pair from them. It is deliberately private: no exported
 * function takes it, returns it, or requires a caller to know it, so swapping in
 * a provider that quotes pairs directly is a change to this file alone.
 */
const PROVIDER_PIVOT_CURRENCY: CurrencyCode = 'FAIR';

/** Redis key prefix for cached rate sets, keyed by base currency. */
const CACHE_KEY_PREFIX = 'fx:rates:';

/**
 * The cached payload shape persisted in Redis (rates + provenance). `provider`
 * is required: a cached rate whose source is unknown could not be attributed on
 * a snapshot, so an entry written before this field existed fails validation and
 * is discarded rather than served anonymously — harmless, since the cache is a
 * minutes-long fallback and the next fetch repopulates it.
 */
const cachedRatesSchema = z.object({
  rates: z.record(z.string(), z.number()),
  provider: z.string(),
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
 * resolution layer fills those from `config.fx.staticRates`. This provider
 * quotes only against FAIR — the base it publishes prices in — and throws for
 * any other base; deriving an arbitrary pair from that is the caller's job.
 */
class FaircoinExplorerFxProvider implements FxProvider {
  async getRates(base: CurrencyCode, quotes: CurrencyCode[]): Promise<Record<string, number>> {
    if (base !== PROVIDER_PIVOT_CURRENCY) {
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

/**
 * Static (dev/last-resort) provider: serves `config.fx.staticRates`, which are
 * likewise published per 1 FAIR, so it quotes only against that base.
 */
class StaticFxProvider implements FxProvider {
  async getRates(base: CurrencyCode, quotes: CurrencyCode[]): Promise<Record<string, number>> {
    if (base !== PROVIDER_PIVOT_CURRENCY) {
      throw new Error(`Static provider only supports a FAIR base, received ${base}`);
    }
    const result: Record<string, number> = {};
    for (const quote of quotes) {
      if (quote === PROVIDER_PIVOT_CURRENCY) {
        result[PROVIDER_PIVOT_CURRENCY] = 1;
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

/**
 * Fill quotes the configured provider omitted from the static rates. The live
 * provider serves a single fiat (see `FaircoinExplorerFxProvider`), so this is
 * the ordinary path rather than an error case — the result is still attributed
 * to the configured provider, which declares the static map as its gap-fill.
 */
function fillFromStatic(quotes: CurrencyCode[], rates: Record<string, number>): void {
  for (const quote of quotes) {
    if (rates[quote] !== undefined) {
      continue;
    }
    if (quote === PROVIDER_PIVOT_CURRENCY) {
      rates[quote] = 1;
      continue;
    }
    const staticRate = config.fx.staticRates[quote as Exclude<CurrencyCode, 'FAIR'>];
    if (staticRate !== undefined) {
      rates[quote] = staticRate;
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
 * Resolve rates against the base the configured providers publish in
 * (`PROVIDER_PIVOT_CURRENCY`). NEVER throws — the display path depends on always
 * getting an `FxRates`:
 *  1. Fresh provider fetch → cached (Redis + in-process) → `stale: false`.
 *  2. Provider failure → last-good cache (Redis, then in-process) → `stale: true`.
 *  3. No cache anywhere → `StaticFxProvider` rates → `stale: true`.
 *  4. Even static failing (should never happen) → empty rates → `stale: true`.
 *
 * This is the SINGLE cached base (`fx:rates:FAIR`); every other base is DERIVED
 * from these rates (`resolveDerivedBaseRates`) rather than cached separately, so
 * there is one cache authority regardless of how many bases callers ask for.
 */
async function resolveProviderBaseRates(quotes: CurrencyCode[]): Promise<FxRates> {
  const ttlSeconds = config.fx.cacheTtlSeconds;
  const base = PROVIDER_PIVOT_CURRENCY;

  try {
    const providerRates = await selectProvider().getRates(base, quotes);
    const rates: Record<string, number> = { ...providerRates };
    fillFromStatic(quotes, rates);

    const provider = config.fx.provider;
    const asOf = new Date().toISOString();
    await writeCache(base, { rates, provider, asOf, ttlSeconds });
    return { base, rates, provider, asOf, stale: false, ttlSeconds };
  } catch (err) {
    log.general.warn({ err, base }, 'FX provider failed; serving last-good or static rates');

    const lastGood = await readLastGood(base);
    if (lastGood) {
      return {
        base,
        rates: lastGood.rates,
        provider: lastGood.provider,
        asOf: lastGood.asOf,
        stale: true,
        ttlSeconds,
      };
    }

    try {
      const staticRates = await new StaticFxProvider().getRates(base, quotes);
      return {
        base,
        rates: staticRates,
        provider: STATIC_PROVIDER_ID,
        asOf: new Date().toISOString(),
        stale: true,
        ttlSeconds,
      };
    } catch (staticErr) {
      log.general.error({ err: staticErr, base }, 'Static FX fallback failed; returning empty rates');
      return {
        base,
        rates: {},
        provider: NO_PROVIDER_ID,
        asOf: new Date().toISOString(),
        stale: true,
        ttlSeconds,
      };
    }
  }
}

/**
 * Resolve rates for a base the providers do NOT publish in, by deriving them
 * from the provider base. With every rate quoted per 1 pivot unit, a
 * `base→quote` rate is `(pivot→quote) / (pivot→base)`:
 *
 *   1 base = (1 / (pivot→base)) pivot = ((pivot→quote) / (pivot→base)) quote
 *
 * The pivot-based rates come from `resolveProviderBaseRates`, so this inherits
 * its never-throws / last-good / stale semantics, its provider attribution and
 * its single Redis cache authority — derived rates are never cached separately.
 * A quote is OMITTED (never fabricated) when a rate it needs is missing: if the
 * `pivot→base` rate itself is unavailable NO derived rate can be formed and the
 * result is empty; `quote === base` is always 1 and needs no rate.
 */
async function resolveDerivedBaseRates(base: CurrencyCode, quotes: CurrencyCode[]): Promise<FxRates> {
  // Everything derives from `pivot→base` and `pivot→quote`, so request the pivot
  // rate for the base plus each distinct non-pivot, non-base quote.
  const pivotQuotes: CurrencyCode[] = [base];
  for (const quote of quotes) {
    if (quote !== PROVIDER_PIVOT_CURRENCY && quote !== base && !pivotQuotes.includes(quote)) {
      pivotQuotes.push(quote);
    }
  }

  const pivot = await resolveProviderBaseRates(pivotQuotes);
  const pivotToBase = pivot.rates[base];
  const rates: Record<string, number> = {};

  for (const quote of quotes) {
    if (quote === base) {
      rates[quote] = 1;
      continue;
    }
    if (pivotToBase === undefined || !(pivotToBase > 0)) {
      // No pivot→base rate → nothing can be derived; omit rather than fabricate.
      continue;
    }
    if (quote === PROVIDER_PIVOT_CURRENCY) {
      rates[quote] = 1 / pivotToBase;
      continue;
    }
    const pivotToQuote = pivot.rates[quote];
    if (pivotToQuote !== undefined && pivotToQuote > 0) {
      rates[quote] = pivotToQuote / pivotToBase;
    }
  }

  return {
    base,
    rates,
    provider: pivot.provider,
    asOf: pivot.asOf,
    stale: pivot.stale,
    ttlSeconds: pivot.ttlSeconds,
  };
}

/**
 * Resolve FX rates for `base` against `quotes`. NEVER throws, and requires
 * nothing of `base` — any supported currency may be the base. Whether the
 * configured provider serves that base directly or the rates are derived from
 * the one it publishes in is internal; callers see only `base→quote` multipliers
 * and `base→base = 1`. A pair no source can serve is omitted from `rates`.
 */
export async function getRates(base: CurrencyCode, quotes: CurrencyCode[]): Promise<FxRates> {
  return base === PROVIDER_PIVOT_CURRENCY
    ? resolveProviderBaseRates(quotes)
    : resolveDerivedBaseRates(base, quotes);
}

/**
 * The rate of `currency` against the base `rates` is quoted in — 1 for the base
 * itself, otherwise its entry in the map. Throws `validationError` when the
 * entry is missing: a rate is never fabricated, and a conversion that cannot be
 * quoted must fail rather than produce a wrong amount.
 */
function rateAgainstBase(currency: CurrencyCode, rates: FxRates): number {
  if (currency === rates.base) {
    return 1;
  }
  const rate = rates.rates[currency];
  if (rate === undefined || !(rate > 0)) {
    throw validationError(`No exchange rate available for ${currency} (per 1 ${rates.base})`);
  }
  return rate;
}

/**
 * Convert `money` to `target` using `rates`. Any pair is supported: both sides
 * are read against the rate map's own base, so the conversion is
 * `source → base → target`. An equal pair short-circuits and returns the input
 * object itself — byte-identical, with no rounding. Rounding to integer minor
 * units (half-even) happens ONCE, at the final step, so a cross conversion never
 * double-rounds, and the result is asserted representable before it is returned.
 *
 * Throws `validationError` when either side has no rate — a conversion is never
 * completed with a fabricated number.
 */
export function convert(money: Money, target: CurrencyCode, rates: FxRates): Money {
  if (money.currency === target) {
    assertSafeMoneyAmount(money.amount, `fx.convert(${money.currency})`);
    return money;
  }

  const sourcePerBase = rateAgainstBase(money.currency, rates);
  const targetPerBase = rateAgainstBase(target, rates);

  const majorSource = money.amount / minorUnitsPerMajor(money.currency);
  const majorBase = majorSource / sourcePerBase;
  const majorTarget = majorBase * targetPerBase;
  const amount = roundMinorUnits(majorTarget * minorUnitsPerMajor(target));
  assertSafeMoneyAmount(amount, `fx.convert(${money.currency}→${target})`);
  return { amount, currency: target };
}

/**
 * The exchange rate to apply to convert ONE unit of `from` into `to` under
 * `rates` (units of `to` per 1 `from`), i.e. `(to per 1 base) / (from per 1
 * base)`. An equal pair is exactly 1. Throws `validationError` when either side
 * has no rate — never fabricated.
 */
export function pairRate(from: CurrencyCode, to: CurrencyCode, rates: FxRates): number {
  if (from === to) {
    return 1;
  }
  return rateAgainstBase(to, rates) / rateAgainstBase(from, rates);
}

/**
 * Form a `DualMoney` from a SHOP-currency `Money`: the `shop` side is `shop`
 * as-is, and the `presentment` side is `shop` converted into
 * `presentmentCurrency` via `convert` (a same-currency pair is byte-identical, no
 * rounding). Every order/refund money field is built through here so the two
 * sides always describe the same value at the captured rates, and both sides are
 * asserted representable.
 */
export function toDualMoney(
  shop: Money,
  presentmentCurrency: CurrencyCode,
  rates: FxRates,
): DualMoney {
  assertSafeMoneyAmount(shop.amount, `fx.toDualMoney(shop ${shop.currency})`);
  return { shop, presentment: convert(shop, presentmentCurrency, rates) };
}

/**
 * Test-only: clear the in-process last-good cache between cases so tests don't
 * leak resolved rates into one another. Not used by production code paths.
 */
export function __resetFxCacheForTests(): void {
  inProcessLastGood.clear();
}
