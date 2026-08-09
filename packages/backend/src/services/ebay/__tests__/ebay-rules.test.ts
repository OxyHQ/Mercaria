/**
 * The pure rules of the eBay Browse source (#65) — everything decidable without
 * a network or a database.
 *
 * The cases are chosen against `~/Oxy/AGENTS.md`'s fixture law: a suite whose
 * fixtures all sit on the same side of a distinction cannot tell the strict
 * reading from the loose one. So every parser here is given at least one input
 * in the shape it exists to REFUSE — a price with more decimal places than its
 * currency has, a localized condition name where an id belongs, an availability
 * word eBay does not publish — and not merely one it accepts.
 */

import { describe, expect, it } from 'vitest';
import {
  CONDITION_MAPPING_CONFIDENCE_FLOOR,
  CONDITION_MAPPING_PROVIDER_IDS,
  CONNECTOR_PROVIDER_IDS,
  EBAY_CONDITION_IDS,
  EBAY_FORBIDDEN_LINK_OPERATIONS,
  EBAY_MARKETPLACE_COUNTRY,
  EBAY_MARKETPLACE_HOST,
  EBAY_MARKETPLACE_IDS,
  EBAY_OUTBOUND_DESTINATION_KINDS,
  EBAY_RECOMMENDED_CONDITION_RULES,
  ITEM_CONDITION_KEYS,
  MAX_MONEY_MINOR_UNITS,
} from '@mercaria/shared-types';
import {
  EBAY_PRODUCED_DESTINATION_KINDS,
  buildEndUserContext,
  chooseEbayDestination,
  isValidEbayCampaignId,
  pageLostAttribution,
} from '../attribution.js';
import {
  EBAY_INITIAL_CURSOR,
  mayClaimCompleteEnumeration,
  parseEbayCursor,
  serializeEbayCursor,
} from '../cursor.js';
import { classifyEbayResponse, readEbayErrorIds, readRetryAfterMs } from '../errors.js';
import { normalizeEbayItem, parseEbayAvailability, parseEbayMoney } from '../normalize.js';
import { classifyReconciliation } from '../reconciliation.js';
import { marketplaceSellerSlugSegment } from '../../ingestion/seller-identity.js';

const NOW = new Date('2026-08-09T10:00:00.000Z');

describe('the marketplace tuple is complete in every direction', () => {
  it('names a country and a public host for every marketplace', () => {
    for (const marketplace of EBAY_MARKETPLACE_IDS) {
      expect(EBAY_MARKETPLACE_COUNTRY[marketplace]).toMatch(/^[A-Z]{2}$/u);
      expect(EBAY_MARKETPLACE_HOST[marketplace]).toMatch(/^www\.ebay\./u);
    }
    // The vacuity floor: an empty tuple would satisfy every assertion above.
    expect(EBAY_MARKETPLACE_IDS.length).toBeGreaterThanOrEqual(5);
  });
});

describe('the condition ruleset an operator publishes', () => {
  it('covers every eBay condition id exactly once', () => {
    const covered = EBAY_RECOMMENDED_CONDITION_RULES.map((rule) => rule.conditionId).sort();
    expect(covered).toEqual([...EBAY_CONDITION_IDS].sort());
  });

  it('maps only onto #90 taxonomy keys', () => {
    for (const rule of EBAY_RECOMMENDED_CONDITION_RULES) {
      expect(ITEM_CONDITION_KEYS).toContain(rule.conditionKey);
      expect(rule.confidence).toBeGreaterThan(0);
      expect(rule.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('puts the AMBIGUOUS ids below #90s floor and the unambiguous ones above it', () => {
    const byId = new Map(EBAY_RECOMMENDED_CONDITION_RULES.map((rule) => [rule.conditionId, rule]));
    // `1500` ("New other") and `2750` ("Like New") describe a RANGE of real
    // conditions, so #90 must record them as `review_pending` and no product
    // page may ever claim them. This is the fixture on the refusing side of the
    // floor — without it the assertion below could not tell a calibrated table
    // from one that simply set every confidence to 0.99.
    expect(byId.get('1500')?.confidence).toBeLessThan(CONDITION_MAPPING_CONFIDENCE_FLOOR);
    expect(byId.get('2750')?.confidence).toBeLessThan(CONDITION_MAPPING_CONFIDENCE_FLOOR);
    expect(byId.get('1000')?.confidence).toBeGreaterThanOrEqual(CONDITION_MAPPING_CONFIDENCE_FLOOR);
    expect(byId.get('3000')?.confidence).toBeGreaterThanOrEqual(CONDITION_MAPPING_CONFIDENCE_FLOOR);
  });

  it('widens the ruleset provider tuple rather than forking it', () => {
    // #65 widened `condition_mapping_rulesets.provider` from the connector set.
    // A SUPERSET is what makes it a widening: every existing ruleset, rule and
    // offer keeps its provider, and the CHECK the schema renders only ever
    // admits more.
    for (const provider of CONNECTOR_PROVIDER_IDS) {
      expect(CONDITION_MAPPING_PROVIDER_IDS).toContain(provider);
    }
    expect(CONDITION_MAPPING_PROVIDER_IDS).toContain('ebay_browse');
  });
});

describe('the outbound destination is one eBay minted, or nothing', () => {
  it('prefers the affiliate URL, falls back to the plain one, and invents neither', () => {
    expect(
      chooseEbayDestination({ affiliateWebUrl: 'https://ebay.es/a', itemWebUrl: 'https://ebay.es/p' }),
    ).toEqual({ kind: 'affiliate', url: 'https://ebay.es/a' });
    expect(chooseEbayDestination({ itemWebUrl: 'https://ebay.es/p' })).toEqual({
      kind: 'plain',
      url: 'https://ebay.es/p',
    });
    // NEITHER. The fixture on the refusing side: an item with no address at all
    // must produce `null`, because there is no third value that would not be a
    // URL Mercaria made up.
    expect(chooseEbayDestination({})).toBeNull();
    expect(chooseEbayDestination({ affiliateWebUrl: '  ', itemWebUrl: '' })).toBeNull();
  });

  it('makes a composed tracking URL unrepresentable', () => {
    // The two tuples are DISJOINT, so a plausible future addition to the
    // destination set that happens to be a construction fails the build.
    for (const forbidden of EBAY_FORBIDDEN_LINK_OPERATIONS) {
      expect(EBAY_OUTBOUND_DESTINATION_KINDS).not.toContain(forbidden as string);
    }
    // And this module produces exactly the destination kinds the tuple names —
    // no more, which is what stops a third branch appearing without the tuple
    // learning about it.
    expect([...EBAY_PRODUCED_DESTINATION_KINDS].sort()).toEqual(
      [...EBAY_OUTBOUND_DESTINATION_KINDS].sort(),
    );
    expect(EBAY_FORBIDDEN_LINK_OPERATIONS.length).toBeGreaterThanOrEqual(6);
  });

  it('sends the attribution header only when there is an attribution', () => {
    expect(buildEndUserContext(null)).toBeUndefined();
    expect(buildEndUserContext({ campaignId: '1234567890', reference: 'mercaria' })).toBe(
      'affiliateCampaignId=1234567890,affiliateReferenceId=mercaria',
    );
  });

  it('refuses a campaign id EPN could not have issued', () => {
    expect(isValidEbayCampaignId('1234567890')).toBe(true);
    // eBay IGNORES an unrecognised campaign id and answers with plain URLs, so
    // a typo would present as "attribution silently stopped working". These are
    // the fixtures that make the refusal real rather than incidental.
    expect(isValidEbayCampaignId('123456789')).toBe(false);
    expect(isValidEbayCampaignId('12345678901')).toBe(false);
    expect(isValidEbayCampaignId('123456789a')).toBe(false);
    expect(isValidEbayCampaignId('')).toBe(false);
  });

  it('reports a lost attribution only for a NON-EMPTY page that carried none', () => {
    expect(pageLostAttribution({ attributionRequested: true, itemCount: 5, affiliateUrlCount: 0 })).toBe(
      true,
    );
    // eBay legitimately omits the affiliate URL for individual items, so a
    // partial page is NOT a signal — an alarm on it would fire constantly.
    expect(pageLostAttribution({ attributionRequested: true, itemCount: 5, affiliateUrlCount: 1 })).toBe(
      false,
    );
    // An empty page says nothing, and an unattributed deployment cannot lose
    // what it never asked for.
    expect(pageLostAttribution({ attributionRequested: true, itemCount: 0, affiliateUrlCount: 0 })).toBe(
      false,
    );
    expect(
      pageLostAttribution({ attributionRequested: false, itemCount: 5, affiliateUrlCount: 0 }),
    ).toBe(false);
  });
});

describe('money is parsed exactly or refused', () => {
  it('reads a decimal string into the currency own minor units', () => {
    expect(parseEbayMoney({ value: '19.99', currency: 'EUR' })).toEqual({
      amount: 1_999,
      currency: 'EUR',
    });
    expect(parseEbayMoney({ value: '5', currency: 'EUR' })).toEqual({ amount: 500, currency: 'EUR' });
    expect(parseEbayMoney({ value: '19.9', currency: 'EUR' })).toEqual({
      amount: 1_990,
      currency: 'EUR',
    });
  });

  it('refuses rather than rounds a value with more precision than the currency has', () => {
    // THE fixture that distinguishes "refuses" from "truncates". `19.9999` in a
    // two-decimal currency is not `1999`; it is a value this integration cannot
    // read, and inventing a price for it is what #62 quarantines observations
    // over. A trailing-zero excess IS readable and is accepted.
    expect(parseEbayMoney({ value: '19.9999', currency: 'EUR' })).toBeUndefined();
    expect(parseEbayMoney({ value: '19.9900', currency: 'EUR' })).toEqual({
      amount: 1_999,
      currency: 'EUR',
    });
  });

  it('refuses a half pair, a negative, a non-numeric and an unknown currency', () => {
    expect(parseEbayMoney({ value: '19.99' })).toBeUndefined();
    expect(parseEbayMoney({ currency: 'EUR' })).toBeUndefined();
    expect(parseEbayMoney({ value: '-1.00', currency: 'EUR' })).toBeUndefined();
    expect(parseEbayMoney({ value: 'free', currency: 'EUR' })).toBeUndefined();
    // A currency with no precision in Mercaria's table has no minor units to
    // convert to, so the amount would be a number with no meaning.
    expect(parseEbayMoney({ value: '10.00', currency: 'ZZZ' })).toBeUndefined();
    expect(parseEbayMoney(undefined)).toBeUndefined();
  });

  it('refuses an amount above the money ceiling', () => {
    const huge = `${MAX_MONEY_MINOR_UNITS}0`;
    expect(parseEbayMoney({ value: huge, currency: 'EUR' })).toBeUndefined();
  });
});

describe('availability is eBays vocabulary or absence', () => {
  it('reads LIMITED_STOCK as in stock and an unknown word as absence', () => {
    expect(parseEbayAvailability('IN_STOCK')).toBe('in_stock');
    // Still buyable. Reading it as anything else would delist an item somebody
    // can buy.
    expect(parseEbayAvailability('LIMITED_STOCK')).toBe('in_stock');
    expect(parseEbayAvailability('OUT_OF_STOCK')).toBe('out_of_stock');
    // Absence, NEVER `in_stock` — the fixture on the refusing side.
    expect(parseEbayAvailability('SOMETHING_NEW')).toBeUndefined();
    expect(parseEbayAvailability(undefined)).toBeUndefined();
    expect(parseEbayAvailability(42)).toBeUndefined();
  });
});

describe('normalizing one eBay item', () => {
  const item = {
    itemId: 'v1|123|0',
    title: 'Sony WH-1000XM5',
    conditionId: '3000',
    condition: 'Usado',
    price: { value: '229.95', currency: 'EUR' },
    itemWebUrl: 'https://www.ebay.es/itm/123',
    itemAffiliateWebUrl: 'https://www.ebay.es/itm/123?mkcid=1&campid=5338000000',
    seller: { username: 'techdeals_es', feedbackPercentage: '99.5' },
    brand: 'Sony',
    gtin: '4548736132900',
    mpn: 'WH1000XM5B',
    image: { imageUrl: 'https://i.ebayimg.com/a.jpg' },
    itemLocation: { country: 'es', stateOrProvince: 'Madrid' },
    estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK', estimatedAvailableQuantity: 3 }],
  };

  it('maps the SELLER to the merchant hint and the marketplace to the storefront hint', () => {
    const result = normalizeEbayItem({ item, marketplaceId: 'EBAY_ES', now: NOW });
    expect(result).not.toBeNull();
    // Issue acceptance 2 depends on exactly this: the per-item seller is the
    // merchant hint, and the marketplace is a CHANNEL hint that resolves
    // nothing. Reversing them would attribute every seller's stock to eBay.
    expect(result?.record.merchantHint).toBe('techdeals_es');
    expect(result?.record.storefrontHint).toBe('EBAY_ES');
  });

  it('carries the condition ID and never the localized display name', () => {
    const result = normalizeEbayItem({ item, marketplaceId: 'EBAY_ES', now: NOW });
    // `condition` on this fixture is the Spanish "Usado" for the identical
    // `3000` that reads "Used" on EBAY_GB. A ruleset keyed on the display text
    // would need one rule per language per condition and would answer
    // `unmapped` for every market nobody wrote rules for.
    expect(result?.record.conditionLabel).toBe('3000');
    expect(result?.record.conditionLabel).not.toBe('Usado');
  });

  it('keeps the plain URL as the destination and the affiliate URL as routing metadata', () => {
    const result = normalizeEbayItem({ item, marketplaceId: 'EBAY_ES', now: NOW });
    expect(result?.record.sourceUrl).toBe('https://www.ebay.es/itm/123');
    expect(result?.record.affiliateUrl).toBe(
      'https://www.ebay.es/itm/123?mkcid=1&campid=5338000000',
    );
    expect(result?.hasAffiliateUrl).toBe(true);
  });

  it('takes identifiers at their declared scheme and never infers one', () => {
    const result = normalizeEbayItem({ item, marketplaceId: 'EBAY_ES', now: NOW });
    expect(result?.record.identifiers).toEqual([
      { scheme: 'gtin', value: '4548736132900' },
      { scheme: 'mpn', value: 'WH1000XM5B' },
    ]);
  });

  it('leaves an unpublished fact ABSENT rather than zero', () => {
    const bare = {
      itemId: 'v1|456|0',
      title: 'Unknown widget',
      price: { value: '10.00', currency: 'EUR' },
      itemWebUrl: 'https://www.ebay.es/itm/456',
    };
    const result = normalizeEbayItem({ item: bare, marketplaceId: 'EBAY_ES', now: NOW });
    // #57's rule reaching back up the pipeline: a delivery cost this function
    // could not read must not arrive at the offer as free delivery, and an item
    // with no quantity must not arrive as zero.
    expect(result?.record.delivery).toBeUndefined();
    expect(result?.record.availableQuantity).toBeUndefined();
    expect(result?.record.availability).toBeUndefined();
    expect(result?.record.merchantHint).toBeUndefined();
    expect(result?.hasAffiliateUrl).toBe(false);
  });

  it('refuses an item with no ID, and EMITS a titleless one so #62 can reject it', () => {
    // No id: nothing to attribute a rejection to, so there is nothing worth
    // emitting. This is the only refusal.
    expect(
      normalizeEbayItem({ item: { title: 'No id' }, marketplaceId: 'EBAY_ES', now: NOW }),
    ).toBeNull();

    // No TITLE is deliberately NOT a refusal here. The record is emitted with an
    // empty title and #62's intake rejects it as `missing_title` AGAINST ITS
    // EXTERNAL ID — a rejection an operator can trace back to a listing.
    // Dropping it in the adapter would leave a page whose counters silently
    // disagree with what eBay sent, which is exactly what
    // `catalog_source_runs_intake_total_check` exists to make impossible.
    const titleless = normalizeEbayItem({
      item: { itemId: 'v1|1|0' },
      marketplaceId: 'EBAY_ES',
      now: NOW,
    });
    expect(titleless?.externalId).toBe('v1|1|0');
    expect(titleless?.record.title).toBe('');

    // A brandless, priceless, imageless item is still an observation.
    expect(
      normalizeEbayItem({
        item: { itemId: 'v1|1|0', title: 'Bare' },
        marketplaceId: 'EBAY_ES',
        now: NOW,
      }),
    ).not.toBeNull();
  });
});

describe('the provider error taxonomy', () => {
  it('reads a quota refusal wearing a 403 as a rate limit, not an auth failure', () => {
    const failure = classifyEbayResponse({
      status: 403,
      body: JSON.stringify({ errors: [{ errorId: 11001, message: 'quota' }] }),
      now: NOW,
      context: 'test',
    });
    // Reading it as `auth_failure` would mark the source `failed` and page
    // somebody about a credential that is fine.
    expect(failure.kind).toBe('rate_limit');
    expect(failure.retryable).toBe(true);
  });

  it('reads an expired token wearing a 400 as a RETRYABLE auth failure', () => {
    const failure = classifyEbayResponse({
      status: 400,
      body: JSON.stringify({ errors: [{ errorId: 1001 }] }),
      now: NOW,
      context: 'test',
    });
    // Retryable because the very next attempt mints a fresh token — and NOT
    // `schema_drift`, which would quarantine a healthy feed.
    expect(failure.kind).toBe('auth_failure');
    expect(failure.retryable).toBe(true);
  });

  it('makes a real credential refusal NON-retryable, so the source stops safely', () => {
    const failure = classifyEbayResponse({ status: 401, body: '', now: NOW, context: 'test' });
    // Issue reliability 5. A revoked keyset answers identically on every
    // attempt, and retrying spends the daily budget re-asking.
    expect(failure.kind).toBe('auth_failure');
    expect(failure.retryable).toBe(false);
  });

  it('reads a 5xx as a retryable outage and a 400 as non-retryable drift', () => {
    expect(classifyEbayResponse({ status: 503, body: '', now: NOW, context: 't' }).kind).toBe(
      'source_outage',
    );
    expect(classifyEbayResponse({ status: 503, body: '', now: NOW, context: 't' }).retryable).toBe(
      true,
    );
    const drift = classifyEbayResponse({ status: 400, body: '{}', now: NOW, context: 't' });
    expect(drift.kind).toBe('schema_drift');
    expect(drift.retryable).toBe(false);
  });

  it('honours a Retry-After in both RFC forms and refuses a third', () => {
    expect(readRetryAfterMs('120', NOW)).toBe(120_000);
    expect(readRetryAfterMs(new Date(NOW.getTime() + 60_000).toUTCString(), NOW)).toBeGreaterThan(0);
    // The fixture on the refusing side: an unparseable header must not become a
    // zero backoff, which would be the loosest possible reading.
    expect(readRetryAfterMs('soon', NOW)).toBeUndefined();
    expect(readRetryAfterMs(undefined, NOW)).toBeUndefined();
  });

  it('never throws while reading an error body', () => {
    expect(readEbayErrorIds('not json')).toEqual([]);
    expect(readEbayErrorIds('<html>502</html>')).toEqual([]);
    expect(readEbayErrorIds(JSON.stringify({ errors: 'nope' }))).toEqual([]);
    expect(readEbayErrorIds(JSON.stringify({ errors: [{ errorId: 'x' }, { errorId: 7 }] }))).toEqual([
      7,
    ]);
  });
});

describe('the cursor and the completeness claim', () => {
  it('round-trips and restarts on anything unreadable', () => {
    const cursor = { ...EBAY_INITIAL_CURSOR, phase: 'verify' as const, truncated: true };
    expect(parseEbayCursor(serializeEbayCursor(cursor))).toEqual(cursor);
    // Every unreadable shape restarts the pass rather than throwing or
    // guessing: a restart costs one pass, and a guess could claim a
    // completeness nobody established.
    expect(parseEbayCursor(null)).toEqual(EBAY_INITIAL_CURSOR);
    expect(parseEbayCursor('{')).toEqual(EBAY_INITIAL_CURSOR);
    expect(parseEbayCursor(JSON.stringify({ v: 2, phase: 'verify' }))).toEqual(EBAY_INITIAL_CURSOR);
    expect(parseEbayCursor(JSON.stringify({ v: 1, phase: 'unknown' }))).toEqual(EBAY_INITIAL_CURSOR);
    expect(
      parseEbayCursor(JSON.stringify({ v: 1, phase: 'verify', targetIndex: -1, offset: 0 })),
    ).toEqual(EBAY_INITIAL_CURSOR);
  });

  it('grants completeness ONLY to an untruncated full verification pass', () => {
    const base = {
      phase: 'verify' as const,
      cohortExhausted: true,
      truncated: false,
      mayConclude: true,
    };
    expect(mayClaimCompleteEnumeration(base)).toBe(true);

    // Every one of the four ways this integration can fall short. Each must
    // land on `false`, and `false` is what makes #62 retire nothing.
    expect(mayClaimCompleteEnumeration({ ...base, phase: 'discovery' })).toBe(false);
    expect(mayClaimCompleteEnumeration({ ...base, cohortExhausted: false })).toBe(false);
    expect(mayClaimCompleteEnumeration({ ...base, truncated: true })).toBe(false);
    // #68's mode: `query_driven` and `targeted` both arrive here with
    // `mayConclude` false, because neither enumerates what a retirement acts on.
    expect(mayClaimCompleteEnumeration({ ...base, mayConclude: false })).toBe(false);
  });
});

describe('reconciliation severity', () => {
  const agreeing = {
    vanished: false,
    attributionRequested: false,
    providerAffiliateUrlPresent: false,
    storedPriceAmount: 100,
    providerPriceAmount: 100,
    storedPriceCurrency: 'EUR',
    providerPriceCurrency: 'EUR',
    storedAvailability: 'in_stock',
    providerAvailability: 'in_stock',
    storedCondition: '3000',
    providerCondition: '3000',
  };

  it('reports the MOST severe finding when several are true at once', () => {
    expect(classifyReconciliation(agreeing)).toBe('agrees');
    // A vanished item whose price also drifted is `vanished`: the severity rule
    // `deriveRetailCompleteness` states, applied to a reconciliation verdict.
    expect(classifyReconciliation({ ...agreeing, vanished: true, providerPriceAmount: 90 })).toBe(
      'vanished',
    );
    expect(classifyReconciliation({ ...agreeing, providerPriceAmount: 90 })).toBe('price_drift');
    expect(classifyReconciliation({ ...agreeing, providerAvailability: 'out_of_stock' })).toBe(
      'availability_drift',
    );
    expect(classifyReconciliation({ ...agreeing, providerCondition: '5000' })).toBe(
      'condition_drift',
    );
  });

  it('surfaces a lost attribution above a price comparison', () => {
    // It is not a catalogue problem, and it is the ONLY signal EPN approval has
    // lapsed. Burying it under a drift comparison would mean nobody ever saw it.
    expect(
      classifyReconciliation({
        ...agreeing,
        attributionRequested: true,
        providerAffiliateUrlPresent: false,
        providerPriceAmount: 90,
      }),
    ).toBe('affiliate_attribution_missing');
    expect(
      classifyReconciliation({
        ...agreeing,
        attributionRequested: true,
        providerAffiliateUrlPresent: true,
      }),
    ).toBe('agrees');
  });

  it('reports a currency change as drift even when the number is identical', () => {
    // A price that changed denomination is not a price that changed — #62's own
    // anomaly rule, and the fixture that tells a currency-aware comparison from
    // one that only reads the amount.
    expect(classifyReconciliation({ ...agreeing, providerPriceCurrency: 'USD' })).toBe(
      'price_drift',
    );
  });
});

describe('the marketplace seller slug', () => {
  it('folds a handle to a URL-safe segment and never to an empty one', () => {
    expect(marketplaceSellerSlugSegment('techdeals_es')).toBe('techdeals-es');
    expect(marketplaceSellerSlugSegment('Tech Deals ES!')).toBe('tech-deals-es');
    // The fixture on the refusing side: a handle that folds to nothing must not
    // produce `ebay--3`, which reads as a bug rather than as a slug.
    expect(marketplaceSellerSlugSegment('***')).toBe('seller');
    expect(marketplaceSellerSlugSegment('   ')).toBe('seller');
  });
});
