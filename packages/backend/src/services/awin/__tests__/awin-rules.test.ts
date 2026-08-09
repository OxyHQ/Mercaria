/**
 * The pure rules of the Awin source (#66).
 *
 * Everything here is a function of its arguments, so every case is a fact about
 * the rule rather than about a fixture. The four that repay attention are the
 * ones whose failure mode is SILENT: a tracking host that looks right and is
 * not, a feed-list row that is dropped instead of seen (which closes a live
 * programme), a contradictory availability that gets repaired instead of
 * counted, and a transaction window chunker that loses a day at every boundary.
 */

import { describe, expect, it } from 'vitest';
import type { CatalogSourceRightsVerdict } from '@mercaria/shared-types';
import {
  AWIN_MAPPING_VERSION,
  AWIN_PUBLISHER_API_MAX_WINDOW_DAYS,
} from '@mercaria/shared-types';
import { readAwinFeedList, awinFeedNeedsDownload } from '../feed-list.js';
import {
  assessAwinTrackingLink,
  destinationHost,
  destinationMatchesAdvertiser,
  isAwinTrackingHost,
  withAssessedAwinTracking,
} from '../tracking.js';
import { buildAwinMapping, declaredAwinColumns } from '../mapping.js';
import {
  createAwinQualityMeter,
  observeAwinRecord,
  readAwinQualityCounts,
} from '../quality.js';
import { resolveAwinCredential } from '../credential.js';
import { splitAwinTransactionWindows } from '../reconciliation.js';
import { awinFeedListUrl, awinFeedDownloadUrl } from '../constants.js';
import type { FeedRawRecord } from '../../feed-import/parse/index.js';
import type { MappedFeedRecord } from '../../feed-import/mapping.js';

const ALL_RIGHTS: CatalogSourceRightsVerdict = {
  store: true,
  cache: true,
  display_price: true,
  display_media: true,
  outbound_link: true,
  affiliate_params: true,
  index: true,
  automated_refresh: true,
  extraction: false,
};

function bytesOf(text: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(text);
    },
  };
}

describe('the tracking link is ADMITTED by a closed host set (adapter rule 6)', () => {
  it('admits the network’s own redirectors and nothing else', () => {
    expect(isAwinTrackingHost('www.awin1.com')).toBe(true);
    expect(isAwinTrackingHost('AWIN1.COM')).toBe(true);
    expect(isAwinTrackingHost('zenaps.com')).toBe(true);
    // THE case this set exists for: a look-alike that a suffix test admits.
    expect(isAwinTrackingHost('awin1.com.evil.example')).toBe(false);
    expect(isAwinTrackingHost('notawin1.com')).toBe(false);
    expect(isAwinTrackingHost('example.com')).toBe(false);
  });

  it('names WHICH thing a refused link got wrong', () => {
    const base = { membershipStatus: 'joined' as const, rights: ALL_RIGHTS };

    expect(
      assessAwinTrackingLink({
        ...base,
        candidate: 'https://www.awin1.com/cread.php?awinmid=1&awinaffid=2&p=x',
      }),
    ).toEqual({
      verdict: 'approved',
      url: 'https://www.awin1.com/cread.php?awinmid=1&awinaffid=2&p=x',
    });

    expect(assessAwinTrackingLink({ ...base, candidate: undefined }).verdict).toBe('absent');
    expect(assessAwinTrackingLink({ ...base, candidate: '   ' }).verdict).toBe('absent');
    expect(assessAwinTrackingLink({ ...base, candidate: 'not a url' }).verdict).toBe(
      'rejected_shape',
    );
    expect(
      assessAwinTrackingLink({ ...base, candidate: 'http://www.awin1.com/cread.php' }).verdict,
    ).toBe('rejected_scheme');
    expect(
      assessAwinTrackingLink({ ...base, candidate: 'https://awin1.com.evil.example/cread.php' })
        .verdict,
    ).toBe('rejected_host');
  });

  it('checks MERCARIA’s own decisions before it looks at the provider’s string', () => {
    // A deployment that withheld affiliate parameters gets `rights_withheld`
    // rather than a verdict about a URL it was never going to use — "we decided
    // not to" and "their feed is broken" lead to different people.
    expect(
      assessAwinTrackingLink({
        candidate: 'https://awin1.com.evil.example/x',
        membershipStatus: 'joined',
        rights: { ...ALL_RIGHTS, affiliate_params: false },
      }).verdict,
    ).toBe('rights_withheld');

    // And a programme Mercaria has not joined attributes to nobody, whatever
    // the URL says.
    expect(
      assessAwinTrackingLink({
        candidate: 'https://www.awin1.com/cread.php',
        membershipStatus: 'pending',
        rights: ALL_RIGHTS,
      }).verdict,
    ).toBe('not_commissionable');
    for (const membership of ['not_joined', 'declined', 'suspended', 'left'] as const) {
      expect(
        assessAwinTrackingLink({
          candidate: 'https://www.awin1.com/cread.php',
          membershipStatus: membership,
          rights: ALL_RIGHTS,
        }).verdict,
      ).toBe('not_commissionable');
    }
  });

  it('WITHHOLDS a refused URL from the record and never touches the destination', () => {
    const record = {
      title: 'Widget',
      sourceUrl: 'https://retailer.example/p/1',
      affiliateUrl: 'https://awin1.com.evil.example/x',
    };
    const kept = withAssessedAwinTracking(record, {
      verdict: 'approved',
      url: 'https://www.awin1.com/cread.php?p=1',
    });
    expect(kept.affiliateUrl).toBe('https://www.awin1.com/cread.php?p=1');
    expect(kept.sourceUrl).toBe('https://retailer.example/p/1');

    const withheld = withAssessedAwinTracking(record, { verdict: 'rejected_host' });
    // ABSENT, not `undefined`: #62's redactor composes the stored payload from
    // the keys that are PRESENT, so an explicit `undefined` would serialize
    // differently and change the content hash for no change in the fact.
    expect('affiliateUrl' in withheld).toBe(false);
    expect(withheld.sourceUrl).toBe('https://retailer.example/p/1');
  });

  it('reads a destination host label-wise, so `notapple.com` is not `apple.com`', () => {
    expect(destinationHost('https://shop.apple.com/x')).toBe('shop.apple.com');
    expect(destinationHost('nonsense')).toBeNull();
    expect(destinationHost(undefined)).toBeNull();

    expect(
      destinationMatchesAdvertiser({ host: 'shop.apple.com', declaredHost: 'apple.com' }),
    ).toBe(true);
    expect(destinationMatchesAdvertiser({ host: 'apple.com', declaredHost: 'apple.com' })).toBe(
      true,
    );
    expect(destinationMatchesAdvertiser({ host: 'notapple.com', declaredHost: 'apple.com' })).toBe(
      false,
    );
    // An advertiser with no declared host is reported as NOTHING, never as a
    // mismatch: Mercaria has no expectation to compare against, and inventing
    // one from the feed's own contents would make the check circular.
    expect(destinationMatchesAdvertiser({ host: 'apple.com', declaredHost: null })).toBeNull();
    expect(destinationMatchesAdvertiser({ host: null, declaredHost: 'apple.com' })).toBeNull();
  });
});

describe('the feed list: an unreadable row is SEEN, not skipped', () => {
  const HEADER =
    'Advertiser ID,Advertiser Name,Feed ID,Feed Name,Membership Status,Primary Region,Language,Currency,Vertical,No of products,Last Imported\n';

  it('reads a well-formed row into a listing', async () => {
    const result = await readAwinFeedList(
      bytesOf(
        `${HEADER}1001,"Retailer, Inc",42,Main feed,joined,ES,es,EUR,Fashion,"12,345",2026-08-09T10:00:00Z\n`,
      ),
    );
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry?.kind).toBe('listing');
    if (entry?.kind !== 'listing') throw new Error('expected a listing');
    expect(entry.listing).toMatchObject({
      advertiserId: '1001',
      // The quoted comma survived, which is the whole reason this goes through
      // #63's CSV reader rather than a split.
      advertiserName: 'Retailer, Inc',
      feedId: '42',
      membershipStatus: 'joined',
      primaryRegion: 'ES',
      currency: 'EUR',
      productCount: 12_345,
      lastImported: '2026-08-09T10:00:00.000Z',
    });
  });

  it('reports a membership word it does not recognise as UNREADABLE, with the ids', async () => {
    // THE case: dropping this row would make the advertiser read as absent, and
    // absence is what closure is inferred from — so a word Awin added last week
    // would close a live programme and retire its catalogue.
    const result = await readAwinFeedList(
      bytesOf(`${HEADER}1002,Other Ltd,43,Feed,brand-new-status,GB,en,GBP,Home,10,\n`),
    );
    const entry = result.entries[0];
    expect(entry?.kind).toBe('unreadable');
    if (entry?.kind !== 'unreadable') throw new Error('expected an unreadable entry');
    expect(entry).toMatchObject({
      advertiserId: '1002',
      feedId: '43',
      reason: 'unknown_membership',
      observedToken: 'brand-new-status',
    });
  });

  it('reads headers case- and punctuation-insensitively', async () => {
    const result = await readAwinFeedList(
      bytesOf('advertiser_id,feed_id,membership\n7,8,Joined\n'),
    );
    const entry = result.entries[0];
    expect(entry?.kind).toBe('listing');
    if (entry?.kind !== 'listing') throw new Error('expected a listing');
    expect(entry.listing.membershipStatus).toBe('joined');
    // No name in the feed: a stable synthetic one rather than an empty string,
    // which the display-name CHECK would refuse.
    expect(entry.listing.advertiserName).toBe('Awin advertiser 7');
  });

  it('a row with no identifiers is unreadable rather than attributed to nobody', async () => {
    const result = await readAwinFeedList(bytesOf(`${HEADER},Nameless,,,joined,,,,,,\n`));
    const entry = result.entries[0];
    expect(entry?.kind).toBe('unreadable');
    if (entry?.kind !== 'unreadable') throw new Error('expected an unreadable entry');
    expect(entry.reason).toBe('missing_identifier');
  });
});

describe('the cheap staleness detector answers `true` on silence', () => {
  it('downloads when the list moved past what was consumed', () => {
    expect(
      awinFeedNeedsDownload({
        listedLastImported: '2026-08-09T12:00:00Z',
        importedLastImported: new Date('2026-08-09T10:00:00Z'),
      }),
    ).toBe(true);
  });

  it('skips when the list has not moved', () => {
    expect(
      awinFeedNeedsDownload({
        listedLastImported: '2026-08-09T10:00:00Z',
        importedLastImported: new Date('2026-08-09T10:00:00Z'),
      }),
    ).toBe(false);
  });

  it('downloads when either side is unknown', () => {
    // A provider that stopped publishing a timestamp has told Mercaria NOTHING
    // about freshness, and reading silence as "unchanged" would freeze a
    // catalogue at whatever it was the day the column disappeared.
    expect(
      awinFeedNeedsDownload({ listedLastImported: null, importedLastImported: new Date() }),
    ).toBe(true);
    expect(
      awinFeedNeedsDownload({ listedLastImported: '2026-08-09T10:00:00Z', importedLastImported: null }),
    ).toBe(true);
    expect(
      awinFeedNeedsDownload({ listedLastImported: 'not a date', importedLastImported: new Date() }),
    ).toBe(true);
  });
});

describe('the mapping is built in memory and names only Awin’s columns', () => {
  it('maps the sale price onto the payable role and the shelf price onto the list one', () => {
    const mapping = buildAwinMapping({
      declared: ['product_name', 'search_price', 'store_price', 'currency', 'aw_product_id'],
      defaultCurrency: 'EUR',
      defaultCountry: 'ES',
      defaultLanguage: 'es',
    });
    // #63's engine puts `sale_price` on the payable side and `price` on
    // `compareAtPrice`, so mapping Awin's `search_price` (what a buyer pays)
    // onto `sale_price` is what makes a discounted product show its discount.
    expect(mapping.fieldMappings.get('sale_price')?.sourceField).toBe('search_price');
    expect(mapping.fieldMappings.get('price')?.sourceField).toBe('store_price');
    expect(mapping.identityKeyFields).toEqual(['aw_product_id']);
    expect(mapping.defaultCurrency).toBe('EUR');
  });

  it('keeps the destination and the tracked link as two different roles', () => {
    const mapping = buildAwinMapping({
      declared: ['merchant_deep_link', 'aw_deep_link'],
      defaultCurrency: null,
      defaultCountry: null,
      defaultLanguage: null,
    });
    expect(mapping.fieldMappings.get('destination_url')?.sourceField).toBe('merchant_deep_link');
    expect(mapping.fieldMappings.get('affiliate_url')?.sourceField).toBe('aw_deep_link');
  });

  it('supplies an option AXIS name only where the value column exists', () => {
    const withColour = buildAwinMapping({
      declared: ['colour'],
      defaultCurrency: null,
      defaultCountry: null,
      defaultLanguage: null,
    });
    expect(withColour.fieldMappings.get('option_name_1')?.constantValue).toBe('Colour');
    expect(withColour.fieldMappings.get('option_value_1')?.sourceField).toBe('colour');

    const without = buildAwinMapping({
      declared: ['product_name'],
      defaultCurrency: null,
      defaultCountry: null,
      defaultLanguage: null,
    });
    // An axis name with no values is an option nobody can complete, and #63's
    // engine would drop the pair anyway.
    expect(without.fieldMappings.has('option_name_1')).toBe(false);
  });

  it('translates Awin’s 1/0 stock flag, which #63’s own synonyms do not carry', () => {
    const mapping = buildAwinMapping({
      declared: ['in_stock'],
      defaultCurrency: null,
      defaultCountry: null,
      defaultLanguage: null,
    });
    expect(mapping.valueMappings.get('availability:1')).toBe('in_stock');
    expect(mapping.valueMappings.get('availability:0')).toBe('out_of_stock');
  });

  it('recognises only Awin’s own column names, in the tuple’s order', () => {
    expect(
      declaredAwinColumns(['Search_Price', 'product_name', 'not_an_awin_column', 'AW_DEEP_LINK']),
    ).toEqual(['aw_deep_link', 'product_name', 'search_price']);
  });
});

describe('quality is MEASURED and nothing is repaired', () => {
  function rawRecord(fields: Record<string, string>, index = 0): FeedRawRecord {
    return { index, fields: new Map(Object.entries(fields)) };
  }

  function mapped(
    index: number,
    externalId: string | null,
    normalized: MappedFeedRecord['normalized'],
    issues: MappedFeedRecord['issues'] = [],
  ): MappedFeedRecord {
    return { index, externalId, normalized, issues, sourceValues: new Map(), sourceUpdatedAt: null };
  }

  it('counts a partition that ADDS UP, which is what the CHECK enforces', () => {
    const meter = createAwinQualityMeter();
    observeAwinRecord(meter, {
      raw: rawRecord({}),
      mapped: mapped(0, 'a', {
        title: 'A',
        identifiers: [{ scheme: 'ean', value: '5012345678900' }],
        options: [],
        media: ['https://img.example/a.jpg'],
        brandHint: 'Acme',
        price: { amount: 1_000, currency: 'EUR' },
      }),
      tracking: { verdict: 'approved', url: 'https://www.awin1.com/cread.php' },
    });
    observeAwinRecord(meter, {
      raw: rawRecord({}, 1),
      mapped: mapped(1, null, null, [
        { code: 'missing_required_field', severity: 'error', recordIndex: 1, role: 'title' },
      ]),
      tracking: { verdict: 'absent' },
    });

    const counts = readAwinQualityCounts(meter);
    expect(counts.scanned).toBe(counts.mapped + counts.rejected);
    expect(counts).toMatchObject({
      scanned: 2,
      mapped: 1,
      rejected: 1,
      withGtin: 1,
      withBrand: 1,
      withImage: 1,
      withPrice: 1,
      trackingApproved: 1,
      // `absent` is NOT a rejection: an advertiser publishing no deep link at
      // all is a legitimate state, and counting it beside a link that pointed at
      // the wrong host would make the metric useless on every such feed.
      trackingRejected: 0,
    });
  });

  it('counts a duplicate external id and a duplicate GTIN separately', () => {
    const meter = createAwinQualityMeter();
    const record = {
      title: 'A',
      identifiers: [{ scheme: 'ean' as const, value: '5012345678900' }],
      options: [],
      media: [],
    };
    observeAwinRecord(meter, {
      raw: rawRecord({}),
      mapped: mapped(0, 'sku-1', record),
      tracking: { verdict: 'absent' },
    });
    observeAwinRecord(meter, {
      raw: rawRecord({}, 1),
      mapped: mapped(1, 'sku-1', record),
      tracking: { verdict: 'absent' },
    });
    const counts = readAwinQualityCounts(meter);
    expect(counts.duplicateExternalIds).toBe(1);
    expect(counts.duplicateGtins).toBe(1);
  });

  it('tells a currency Mercaria does not list from an unreadable amount', () => {
    const meter = createAwinQualityMeter();
    observeAwinRecord(meter, {
      raw: rawRecord({}),
      mapped: mapped(0, 'a', { title: 'A', identifiers: [], options: [], media: [] }, [
        { code: 'unsupported_currency', severity: 'warning', recordIndex: 0, role: 'price' },
      ]),
      tracking: { verdict: 'absent' },
    });
    observeAwinRecord(meter, {
      raw: rawRecord({}, 1),
      mapped: mapped(1, 'b', { title: 'B', identifiers: [], options: [], media: [] }, [
        { code: 'unparseable_number', severity: 'warning', recordIndex: 1, role: 'price' },
      ]),
      tracking: { verdict: 'absent' },
    });
    // An unreadable `stock_quantity` raises the SAME code on a different role,
    // and counting it as a price fault would send somebody to the wrong column.
    observeAwinRecord(meter, {
      raw: rawRecord({}, 2),
      mapped: mapped(2, 'c', { title: 'C', identifiers: [], options: [], media: [] }, [
        {
          code: 'unparseable_number',
          severity: 'warning',
          recordIndex: 2,
          role: 'available_quantity',
        },
      ]),
      tracking: { verdict: 'absent' },
    });
    const counts = readAwinQualityCounts(meter);
    expect(counts.rejectedCurrency).toBe(1);
    expect(counts.rejectedPrice).toBe(1);
  });

  it('counts a contradictory availability and repairs nothing', () => {
    const meter = createAwinQualityMeter();
    const normalized = { title: 'A', identifiers: [], options: [], media: [] };
    observeAwinRecord(meter, {
      raw: rawRecord({ in_stock: '1', stock_quantity: '0' }),
      mapped: mapped(0, 'a', normalized),
      tracking: { verdict: 'absent' },
    });
    observeAwinRecord(meter, {
      raw: rawRecord({ in_stock: '1', is_for_sale: '0' }, 1),
      mapped: mapped(1, 'b', normalized),
      tracking: { verdict: 'absent' },
    });
    // The REVERSE is not a contradiction: a retailer reporting out of stock
    // with stock on the shelf is withholding a sale, which is their decision.
    observeAwinRecord(meter, {
      raw: rawRecord({ in_stock: '0', stock_quantity: '25' }, 2),
      mapped: mapped(2, 'c', normalized),
      tracking: { verdict: 'absent' },
    });
    expect(readAwinQualityCounts(meter).contradictoryAvailability).toBe(2);
  });
});

describe('a credential locator resolves, or says exactly why not', () => {
  it('reads `env:` and tells an absent variable from an empty one', () => {
    process.env.AWIN_RULES_TEST_KEY = 'secret-value';
    process.env.AWIN_RULES_TEST_EMPTY = '   ';
    try {
      expect(resolveAwinCredential('env:AWIN_RULES_TEST_KEY')).toEqual({
        kind: 'resolved',
        secret: 'secret-value',
      });
      // A variable set to nothing is the shape a PLACEHOLDER secret takes, and
      // telling it apart from "nobody configured this" is what sends somebody
      // to the right place.
      expect(resolveAwinCredential('env:AWIN_RULES_TEST_EMPTY')).toMatchObject({
        kind: 'unavailable',
        reason: 'empty_value',
      });
      expect(resolveAwinCredential('env:AWIN_RULES_TEST_ABSENT')).toMatchObject({
        kind: 'unavailable',
        reason: 'empty_value',
      });
    } finally {
      delete process.env.AWIN_RULES_TEST_KEY;
      delete process.env.AWIN_RULES_TEST_EMPTY;
    }
  });

  it('refuses a scheme it does not implement rather than falling back', () => {
    expect(resolveAwinCredential('ssm:/oxy/mercaria/AWIN_FEED_API_KEY')).toMatchObject({
      kind: 'unavailable',
      reason: 'unsupported_scheme',
      detail: 'ssm',
    });
    expect(resolveAwinCredential(null)).toMatchObject({
      kind: 'unavailable',
      reason: 'not_configured',
    });
  });

  it('never reports the VALUE, only the scheme or the variable name', () => {
    process.env.AWIN_RULES_TEST_EMPTY2 = '';
    try {
      const resolution = resolveAwinCredential('env:AWIN_RULES_TEST_EMPTY2');
      if (resolution.kind !== 'unavailable') throw new Error('expected unavailable');
      expect(resolution.detail).toBe('AWIN_RULES_TEST_EMPTY2');
    } finally {
      delete process.env.AWIN_RULES_TEST_EMPTY2;
    }
  });
});

describe('a composed Awin URL carries the key in the PATH', () => {
  it('places the key where Awin documents it, and asks for a fixed column set', () => {
    expect(awinFeedListUrl('https://productdata.awin.com', 'k3y')).toBe(
      'https://productdata.awin.com/datafeed/list/apikey/k3y',
    );
    const download = awinFeedDownloadUrl({
      baseUrl: 'https://productdata.awin.com/',
      feedApiKey: 'k3y',
      feedId: '42',
      columns: ['aw_product_id', 'product_name'],
    });
    expect(download).toContain('/datafeed/download/apikey/k3y/');
    expect(download).toContain('fid=42');
    expect(download).toContain('compression=gzip');
    // EXPLICIT columns rather than "all": a network that adds a column tomorrow
    // changes neither the bytes Mercaria reads nor the digest they hash to.
    expect(download).toContain('columns=aw_product_id%2Cproduct_name');
  });
});

describe('the ≤31-day transaction window chunker (#67’s seam)', () => {
  const DAY_MS = 24 * 60 * 60 * 1_000;

  it('covers a range exactly, with no gap and no overlap', () => {
    // Randomized rather than by example, because the failure this exists to
    // prevent is a one-day gap at one boundary out of twelve — which every
    // hand-written example happens to miss.
    for (let trial = 0; trial < 200; trial += 1) {
      const days = Math.floor(Math.random() * 400);
      const from = new Date(Date.UTC(2026, 0, 1 + Math.floor(Math.random() * 300)));
      const to = new Date(from.getTime() + days * DAY_MS);

      const windows = splitAwinTransactionWindows(from, to);
      expect(windows.length).toBeGreaterThan(0);

      expect(new Date(windows[0]?.from ?? '').getTime()).toBe(from.getTime());
      expect(new Date(windows[windows.length - 1]?.to ?? '').getTime()).toBe(to.getTime());

      for (const window of windows) {
        const start = new Date(window.from).getTime();
        const end = new Date(window.to).getTime();
        expect(end).toBeGreaterThanOrEqual(start);
        // Both ends INCLUSIVE, so a 31-day window spans 30 day-steps. Writing
        // `max` rather than `max - 1` in the step is the off-by-one that
        // produces a 32-day request Awin refuses.
        const spannedDays = (end - start) / DAY_MS + 1;
        expect(spannedDays).toBeLessThanOrEqual(AWIN_PUBLISHER_API_MAX_WINDOW_DAYS);
      }
      for (let index = 1; index < windows.length; index += 1) {
        const previousEnd = new Date(windows[index - 1]?.to ?? '').getTime();
        const nextStart = new Date(windows[index]?.from ?? '').getTime();
        // Contiguous to the DAY: the next window starts the day after the last
        // one ended. A gap loses a day of commission; an overlap double-counts.
        expect(nextStart - previousEnd).toBe(DAY_MS);
      }
    }
  });

  it('answers an inverted range with nothing', () => {
    // A query Awin would accept for a backwards range turns a caller's bug into
    // a silently empty result.
    expect(
      splitAwinTransactionWindows(new Date('2026-08-09T00:00:00Z'), new Date('2026-08-01T00:00:00Z')),
    ).toEqual([]);
  });

  it('answers a single day with one window', () => {
    const day = new Date('2026-08-09T13:45:00Z');
    const windows = splitAwinTransactionWindows(day, day);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.from).toBe(windows[0]?.to);
  });
});

describe('the mapping version is a code constant', () => {
  it('is a positive integer nobody can publish through a table', () => {
    expect(Number.isInteger(AWIN_MAPPING_VERSION)).toBe(true);
    expect(AWIN_MAPPING_VERSION).toBeGreaterThanOrEqual(1);
  });
});
