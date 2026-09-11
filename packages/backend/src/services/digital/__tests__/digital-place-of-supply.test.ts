/**
 * The place of supply is chosen PER LINE — #1015 Workstream 11, ADR 0010 D10.
 *
 * ## What this file is guarding against, stated first because it is subtle
 *
 * `docs/commerce-types.md` named the wall #1015 had to take down more precisely
 * than a summary would: *"`rateMatchesRegion` reads the shipping country, region
 * and postal code and nothing else"* — the place-of-supply rule for GOODS, and
 * structurally the wrong one for an electronically supplied service.
 *
 * Reusing it would not have failed loudly. A digital-only order carries no address
 * (ADR 0010 D8), so every region-scoped rate would simply have failed to match and
 * the order would have been taxed at zero: a green build, a plausible invoice and
 * an under-collection per sale. So the cases below are all about a figure being
 * RIGHT rather than about an error being raised, and the mixed-cart case is the
 * one that can only be got right by a per-line rule.
 *
 * Driven through the shipped `calculateTotals` with the three repositories mocked,
 * which is `pricing.service.test.ts`'s arrangement — a re-implementation of the
 * selector here would measure the re-implementation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findActiveDiscounts = vi.fn();
const findActiveTaxRates = vi.fn();
const findStoreRow = vi.fn();

vi.mock('../../../db/merchandising/discountRepository.js', () => ({
  findActiveDiscounts: (...args: unknown[]) => findActiveDiscounts(...args),
}));
vi.mock('../../../db/stores/taxRateRepository.js', () => ({
  findActiveTaxRates: (...args: unknown[]) => findActiveTaxRates(...args),
}));
vi.mock('../../../db/stores/storeRepository.js', () => ({
  findStoreRow: (...args: unknown[]) => findStoreRow(...args),
}));

import {
  DIGITAL_SUPPLY_EVIDENCE_KINDS,
  FORBIDDEN_DIGITAL_SUPPLY_EVIDENCE_KINDS,
  type FxRates,
} from '@mercaria/shared-types';
import { calculateTotals, type PricingLine } from '../../pricing.service.js';
import type { TaxRateRecord } from '../../../db/stores/taxRateRepository.js';
import type { StoreRow } from '../../../db/stores/storeRepository.js';

const FAIR_RATES: FxRates = {
  base: 'FAIR',
  rates: { FAIR: 1 },
  provider: 'static',
  asOf: '2026-01-01T00:00:00.000Z',
  stale: false,
  ttlSeconds: 300,
};

const STORE_ID = '000000000000000000000040';

/** A rate scoped however the case needs; everything else is the engine's default. */
function rate(overrides: {
  name: string;
  rateBps: number;
  regionCountry?: string | null;
  regionRegion?: string | null;
  regionPostalCodePattern?: string | null;
}): TaxRateRecord {
  return {
    name: overrides.name,
    rateBps: overrides.rateBps,
    regionCountry: overrides.regionCountry ?? null,
    regionRegion: overrides.regionRegion ?? null,
    regionPostalCodePattern: overrides.regionPostalCodePattern ?? null,
    appliesToShipping: false,
    productTypeScope: null,
    priority: 0,
  } as TaxRateRecord;
}

function line(id: string, amount: number, digital = false): PricingLine {
  return {
    listingId: id,
    variantId: `v-${id}`,
    unitPrice: { amount, currency: 'FAIR' },
    quantity: 1,
    ...(digital ? { digitalSupply: true } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findActiveDiscounts.mockResolvedValue([]);
  findStoreRow.mockResolvedValue({
    taxSettingsPricesIncludeTax: false,
    taxSettingsChargeTaxOnProducts: true,
  } as StoreRow);
});

describe('a DIGITAL line is taxed on the consumer country', () => {
  it('matches a country-scoped rate for the supply country, not the shipping one', async () => {
    findActiveTaxRates.mockResolvedValue([rate({ name: 'ES VAT', rateBps: 2100, regionCountry: 'ES' })]);
    const result = await calculateTotals({
      storeId: STORE_ID,
      lines: [line('l1', 1000, true)],
      currency: 'FAIR',
      presentmentCurrency: 'FAIR',
      rates: FAIR_RATES,
      digitalPlaceOfSupply: { country: 'ES' },
    });
    expect(result.tax.shop.amount).toBe(210);
    expect(result.taxLines.map((l) => l.name)).toEqual(['ES VAT']);
  });

  it('does NOT match a rate for a different country', async () => {
    findActiveTaxRates.mockResolvedValue([rate({ name: 'ES VAT', rateBps: 2100, regionCountry: 'ES' })]);
    const result = await calculateTotals({
      storeId: STORE_ID,
      lines: [line('l1', 1000, true)],
      currency: 'FAIR',
      presentmentCurrency: 'FAIR',
      rates: FAIR_RATES,
      digitalPlaceOfSupply: { country: 'DE' },
    });
    expect(result.tax.shop.amount).toBe(0);
  });

  it('IGNORES a rate scoped to a region or a postal code', async () => {
    // Nothing establishes either for an electronically supplied service, so such a
    // rate does not match rather than matching vacuously on a NULL — which is what
    // the goods rule would have done.
    findActiveTaxRates.mockResolvedValue([
      rate({ name: 'Canary Islands', rateBps: 700, regionCountry: 'ES', regionRegion: 'CN' }),
      rate({ name: 'Postcode rate', rateBps: 500, regionCountry: 'ES', regionPostalCodePattern: '^38' }),
    ]);
    const result = await calculateTotals({
      storeId: STORE_ID,
      lines: [line('l1', 1000, true)],
      currency: 'FAIR',
      presentmentCurrency: 'FAIR',
      rates: FAIR_RATES,
      digitalPlaceOfSupply: { country: 'ES' },
    });
    expect(result.tax.shop.amount).toBe(0);
  });

  it('matches NOTHING when no place of supply was established', async () => {
    // The loud failure, not a quiet fallback. A checkout that reached pricing
    // without establishing where a digital supply happened has a bug, and taxing it
    // at the shipping address would hide that bug behind a plausible invoice.
    findActiveTaxRates.mockResolvedValue([rate({ name: 'ES VAT', rateBps: 2100, regionCountry: 'ES' })]);
    const result = await calculateTotals({
      storeId: STORE_ID,
      lines: [line('l1', 1000, true)],
      currency: 'FAIR',
      presentmentCurrency: 'FAIR',
      rates: FAIR_RATES,
      shippingAddress: { country: 'ES', region: 'MD', postalCode: '28001' },
    });
    expect(result.tax.shop.amount).toBe(0);
  });
});

describe('a PHYSICAL line is taxed exactly as it was before #1015', () => {
  it('still matches on country, region and postal code', async () => {
    findActiveTaxRates.mockResolvedValue([
      rate({ name: 'Madrid', rateBps: 2100, regionCountry: 'ES', regionRegion: 'MD', regionPostalCodePattern: '^28' }),
    ]);
    const result = await calculateTotals({
      storeId: STORE_ID,
      lines: [line('l1', 1000)],
      currency: 'FAIR',
      presentmentCurrency: 'FAIR',
      rates: FAIR_RATES,
      shippingAddress: { country: 'ES', region: 'MD', postalCode: '28001' },
    });
    expect(result.tax.shop.amount).toBe(210);
  });

  it('does NOT borrow the digital supply country', async () => {
    // The mirror of the digital case, and the half a single order-level rule could
    // not hold: a physical line must not be taxed where the buyer says they are.
    findActiveTaxRates.mockResolvedValue([rate({ name: 'DE VAT', rateBps: 1900, regionCountry: 'DE' })]);
    const result = await calculateTotals({
      storeId: STORE_ID,
      lines: [line('l1', 1000)],
      currency: 'FAIR',
      presentmentCurrency: 'FAIR',
      rates: FAIR_RATES,
      shippingAddress: { country: 'ES' },
      digitalPlaceOfSupply: { country: 'DE' },
    });
    expect(result.tax.shop.amount).toBe(0);
  });
});

describe('a MIXED order taxes each half by its own rule', () => {
  it('applies the shipping country to the parcel and the supply country to the download', async () => {
    // The case that can only be got right per line. Two rates, two lines, and each
    // line matches exactly one of them.
    findActiveTaxRates.mockResolvedValue([
      rate({ name: 'ES goods', rateBps: 2100, regionCountry: 'ES' }),
      rate({ name: 'DE digital', rateBps: 1900, regionCountry: 'DE' }),
    ]);
    const result = await calculateTotals({
      storeId: STORE_ID,
      lines: [line('parcel', 1000), line('download', 2000, true)],
      currency: 'FAIR',
      presentmentCurrency: 'FAIR',
      rates: FAIR_RATES,
      shippingAddress: { country: 'ES' },
      digitalPlaceOfSupply: { country: 'DE' },
    });
    // 21% of 1000 on the parcel, 19% of 2000 on the download.
    expect(result.tax.shop.amount).toBe(210 + 380);
    // Per RATE, not just the total: the two halves are separately attributable,
    // which is what makes the sum above evidence rather than a coincidence. A
    // single order-level rule could produce 590 only by applying one rate to both
    // lines, and that would show here as one line of 630 or 570.
    expect(
      new Map(result.taxLines.map((l) => [l.name, l.amount.amount])),
    ).toEqual(new Map([['ES goods', 210], ['DE digital', 380]]));
  });

  it('taxes BOTH halves when one country covers both', async () => {
    // The control for the case above: with one rate and one country, both lines
    // match — so the per-line dispatch is not simply refusing everything it can.
    findActiveTaxRates.mockResolvedValue([rate({ name: 'ES VAT', rateBps: 2100, regionCountry: 'ES' })]);
    const result = await calculateTotals({
      storeId: STORE_ID,
      lines: [line('parcel', 1000), line('download', 1000, true)],
      currency: 'FAIR',
      presentmentCurrency: 'FAIR',
      rates: FAIR_RATES,
      shippingAddress: { country: 'ES' },
      digitalPlaceOfSupply: { country: 'ES' },
    });
    // ONE rate, applied to BOTH lines: 21% of 2000.
    expect(result.tax.shop.amount).toBe(420);
    expect(result.taxLines.map((l) => [l.name, l.amount.amount])).toEqual([['ES VAT', 420]]);
  });
});

describe('the evidence vocabulary admits nothing IP-derived', () => {
  it('keeps the accepted and forbidden sets DISJOINT', () => {
    // `FORBIDDEN_CONDITION_PHOTO_PROVENANCES`' device. The absence of
    // `ip_geolocation` from the accepted tuple is the decision; this is what makes
    // adding it a visible act rather than a quiet one.
    const accepted = new Set<string>(DIGITAL_SUPPLY_EVIDENCE_KINDS);
    expect(FORBIDDEN_DIGITAL_SUPPLY_EVIDENCE_KINDS.filter((kind) => accepted.has(kind))).toEqual([]);
    // Vacuity floors for both halves: an empty forbidden list would pass the
    // filter above for a reason that has nothing to do with disjointness.
    expect(FORBIDDEN_DIGITAL_SUPPLY_EVIDENCE_KINDS.length).toBeGreaterThanOrEqual(5);
    expect(DIGITAL_SUPPLY_EVIDENCE_KINDS.length).toBeGreaterThanOrEqual(4);
  });

  it('names the IP kinds explicitly, so the prohibition can be enumerated', () => {
    // A prohibition stated as data can be checked; one stated only in prose cannot.
    expect(FORBIDDEN_DIGITAL_SUPPLY_EVIDENCE_KINDS).toContain('ip_geolocation');
    expect(FORBIDDEN_DIGITAL_SUPPLY_EVIDENCE_KINDS).toContain('ip_address');
  });
});
