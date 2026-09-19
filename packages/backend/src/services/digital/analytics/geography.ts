/**
 * Revenue by place of supply, with a cohort floor — #1015 W6 requirement 9:
 * *"geographic revenue summaries must not expose buyer identities"*.
 *
 * ## The threat, concretely
 *
 * A creator sells a €25 commercial licence. One sale this month came from
 * Luxembourg. A geographic summary that says so tells them, to within a month, that
 * a specific person in a country of 660 000 bought that specific licence — and a
 * creator who talks to their customers already knows who that was. Nothing in the
 * row is a name, an email or an IP; the row is still an identification, because a
 * small cohort plus what the creator already knows IS the identity.
 *
 * That is exactly the reasoning `merchant-analytics.service.ts` records for the
 * sibling domain: *"on a store with one product and one visitor a day, 'under 10'
 * plus a timestamp is a person"*.
 *
 * ## The floor, and why it is the sibling's number
 *
 * {@link DIGITAL_GEOGRAPHIC_MIN_COHORT} is `ANALYTICS_MERCHANT_MIN_COHORT` — ten —
 * imported rather than retyped. One number, because a creator who finds that one
 * Mercaria surface discloses at ten and another at five has been given a
 * differencing oracle across two endpoints, and because a second constant drifts.
 *
 * **It counts SALES, not revenue.** A country with one €500 sale is a cohort of
 * one however large the amount is, and a threshold on money would disclose the
 * smallest cohorts in the catalogue — the expensive commercial licences — while
 * suppressing the large anonymous ones.
 *
 * ## It suppresses, it does not round
 *
 * The sibling domain's rule, for the sibling's reason: *"rounding a 3 to 'under 10'
 * still tells a merchant somebody was there"*. A country below the floor is not
 * named at all. Its money is POOLED into one unnamed bucket with every other
 * below-floor country, and that bucket discloses amounts only when it is itself a
 * cohort — at least ten sales spread over at least two countries. With one
 * withheld country the pool IS that country, so disclosing the pool would name it
 * by elimination.
 *
 * ## What this does NOT protect against, stated rather than implied
 *
 * A creator legitimately knows their own total revenue — it is their own business,
 * and `summariseCreatorSales` reports it. So `total − Σ(named countries)` bounds
 * the withheld pool from outside this summary, and no floor inside it can prevent
 * that. What the floor does prevent is ATTRIBUTION: the residual cannot be assigned
 * to a country, and a country is the only geographic fact this domain holds (ADR
 * 0010 D10 — a digital supply establishes a country and nothing narrower, and
 * `FORBIDDEN_DIGITAL_SUPPLY_EVIDENCE_KINDS` forbids deriving anything from an IP).
 *
 * This summary therefore publishes **no grand total of its own**, so the
 * subtraction is at least not performed for the reader by the privacy-sensitive
 * surface. That is mitigation and it is labelled as mitigation.
 *
 * **At launch almost everything will be pooled**, and that is the correct default
 * for a surface whose failure mode is identifying a buyer. A creator with forty
 * sales across twelve countries sees one pool and no map. The alternative — a floor
 * low enough to draw a map in month one — is the attack above, shipped.
 */

import { ANALYTICS_MERCHANT_MIN_COHORT, type CurrencyCode } from '@mercaria/shared-types';
import type { DigitalSaleFact } from './facts.js';

/**
 * The smallest number of sales in one country before the country may be named.
 *
 * Derived from `ANALYTICS_MERCHANT_MIN_COHORT`, never retyped — see the docblock.
 */
export const DIGITAL_GEOGRAPHIC_MIN_COHORT = ANALYTICS_MERCHANT_MIN_COHORT;

/**
 * The smallest number of distinct countries the withheld pool must cover before
 * its amounts are disclosed.
 *
 * Two, because with one the pool IS that country and publishing its money names it
 * by elimination from the named list — the differencing attack the floor exists to
 * stop, arriving through the suppression mechanism itself.
 *
 * **Today this condition is IMPLIED and cannot fire on its own**, and saying so is
 * better than leaving a reader to assume it is load-bearing. Every country in the
 * pool has fewer than `DIGITAL_GEOGRAPHIC_MIN_COHORT` sales by construction, so a
 * one-country pool holds at most `COHORT − 1` = 9 sales and fails the pool's own
 * sale floor first. It is kept for the case the two floors diverge — a pool floor
 * set lower than the per-country one is an obvious future "improvement", and it is
 * exactly the change that would make a single withheld country discloseable. The
 * guard is the thing that stops that change being silent.
 */
export const DIGITAL_GEOGRAPHIC_MIN_POOLED_COUNTRIES = 2;

/** Money in one currency. Minor units, never converted. */
export interface DigitalCurrencyAmount {
  readonly currency: CurrencyCode;
  readonly grossAmount: number;
  readonly creatorEarningsAmount: number;
}

/** One named country's revenue. Only appears at or above the cohort floor. */
export interface DigitalCountryRevenue {
  /** ISO-3166 alpha-2, as `orders.digital_supply_country` holds it. */
  readonly country: string;
  readonly saleCount: number;
  readonly amounts: readonly DigitalCurrencyAmount[];
}

/**
 * Everything below the floor, pooled.
 *
 * `amounts` is EMPTY rather than zeroed when the pool is not itself a cohort. An
 * empty list says "not disclosed"; a list of zeros would say "no money", and a
 * reader cannot tell those apart from a number.
 */
export interface DigitalWithheldRevenue {
  readonly countryCount: number;
  readonly saleCount: number;
  readonly disclosed: boolean;
  readonly amounts: readonly DigitalCurrencyAmount[];
}

/** The geographic summary. It carries no grand total, deliberately. */
export interface DigitalGeographicRevenueSummary {
  readonly cohortFloor: number;
  /** Named countries, most sales first, then alphabetically. */
  readonly countries: readonly DigitalCountryRevenue[];
  readonly withheld: DigitalWithheldRevenue;
  /**
   * Paid lines that established NO place of supply.
   *
   * Reported separately and never folded into the withheld pool, because it is not
   * a privacy suppression: it is the checkout bug ADR 0010 D10 deliberately makes
   * visible — *"a checkout that reached pricing without establishing where the
   * supply happened has a bug"*. Pooling it with withheld countries would hide an
   * under-collected tax behind a privacy control.
   */
  readonly withoutPlaceOfSupply: { readonly saleCount: number };
}

/**
 * Summarise paid sales by place of supply.
 *
 * Pure: facts in, summary out. No clock, no database, no configuration — so
 * `__tests__/geography.test.ts` can drive the floor at, below and across it rather
 * than illustrating one case.
 *
 * Free lines are excluded. A free claim moves no money, so it cannot appear in a
 * REVENUE summary, and including it would put a cohort of one in a country's count
 * without contributing anything a reader could see — inflating a cohort is the one
 * direction a floor must never be wrong in.
 */
export function summariseGeographicRevenue(
  sales: readonly DigitalSaleFact[],
): DigitalGeographicRevenueSummary {
  const paid = sales.filter((sale) => sale.priceClass === 'paid' && !sale.refunded);

  const withoutCountry = paid.filter((sale) => sale.supplyCountry === null);
  const byCountry = new Map<string, DigitalSaleFact[]>();
  for (const sale of paid) {
    if (sale.supplyCountry === null) continue;
    const bucket = byCountry.get(sale.supplyCountry) ?? [];
    bucket.push(sale);
    byCountry.set(sale.supplyCountry, bucket);
  }

  const named: DigitalCountryRevenue[] = [];
  const pooled: DigitalSaleFact[] = [];
  let pooledCountries = 0;
  for (const [country, bucket] of byCountry) {
    if (bucket.length >= DIGITAL_GEOGRAPHIC_MIN_COHORT) {
      named.push({ country, saleCount: bucket.length, amounts: amountsOf(bucket) });
      continue;
    }
    pooledCountries += 1;
    pooled.push(...bucket);
  }

  named.sort((left, right) =>
    right.saleCount !== left.saleCount
      ? right.saleCount - left.saleCount
      : left.country < right.country
        ? -1
        : 1,
  );

  const poolIsACohort =
    pooled.length >= DIGITAL_GEOGRAPHIC_MIN_COHORT &&
    pooledCountries >= DIGITAL_GEOGRAPHIC_MIN_POOLED_COUNTRIES;

  return {
    cohortFloor: DIGITAL_GEOGRAPHIC_MIN_COHORT,
    countries: named,
    withheld: {
      countryCount: pooledCountries,
      saleCount: pooled.length,
      disclosed: poolIsACohort,
      amounts: poolIsACohort ? amountsOf(pooled) : [],
    },
    withoutPlaceOfSupply: { saleCount: withoutCountry.length },
  };
}

/**
 * Totals per currency, alphabetical by code.
 *
 * Per currency because there is no conversion anywhere in this domain, and
 * alphabetical so two runs over one population produce one list — an unstable order
 * would make "the first row" mean something different on a refresh.
 */
function amountsOf(sales: readonly DigitalSaleFact[]): DigitalCurrencyAmount[] {
  const byCurrency = new Map<CurrencyCode, { gross: number; earnings: number }>();
  for (const sale of sales) {
    const entry = byCurrency.get(sale.currency) ?? { gross: 0, earnings: 0 };
    entry.gross += sale.grossAmount;
    entry.earnings += sale.creatorEarningsAmount;
    byCurrency.set(sale.currency, entry);
  }
  return [...byCurrency.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([currency, entry]) => ({
      currency,
      grossAmount: entry.gross,
      creatorEarningsAmount: entry.earnings,
    }));
}
