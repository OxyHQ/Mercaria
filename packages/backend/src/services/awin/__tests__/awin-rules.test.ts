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
  assessAwinDestination,
  assessAwinTrackingLink,
  destinationHost,
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

  /**
   * `destinationHost` answers one question — which host is this — and every
   * answer that is not a host is the SAME `null`. It had no production caller
   * until #589; `assessAwinDestination` is its first.
   */
  it('reads a host out of a URL, and nothing out of anything else', () => {
    expect(destinationHost('https://shop.apple.com/x')).toBe('shop.apple.com');
    // Lower-cased, so a host comparison cannot turn on how a feed shouted.
    expect(destinationHost('https://SHOP.APPLE.COM/x')).toBe('shop.apple.com');
    expect(destinationHost('nonsense')).toBeNull();
    expect(destinationHost('   ')).toBeNull();
    expect(destinationHost(undefined)).toBeNull();
  });
});

/**
 * The swapped-URL-columns detector (#589).
 *
 * `merchant_deep_link` is the DESTINATION and `aw_deep_link` is the TRACKED one
 * (`AWIN_COLUMN_ROLES`). Mapped to each other's roles the catalogue works
 * perfectly — right prices, right images, links that resolve — and the money
 * routes through a link nobody validated as the destination. This is the one
 * failure with no other signal, and it is answerable from the feed alone.
 */
describe('the destination detector is a CONJUNCTION', () => {
  const TRACKED = 'https://www.awin1.com/cread.php?awinmid=1&p=https%3A%2F%2Fretailer.example';
  const RETAILER = 'https://retailer.example/p/1';

  it('reads the ordinary feed as a retailer host', () => {
    expect(assessAwinDestination({ destination: RETAILER, deepLink: TRACKED })).toBe(
      'retailer_host',
    );
  });

  it('reports the SWAP when only the destination is tracked', () => {
    expect(assessAwinDestination({ destination: TRACKED, deepLink: RETAILER })).toBe(
      'tracking_host',
    );
    // zenaps is the other half of the set, and the `www` spellings are listed
    // rather than derived — a "strip an optional www." rule is one more thing
    // between a stranger's string and a redirect.
    expect(
      assessAwinDestination({ destination: 'https://zenaps.com/rclick.php', deepLink: RETAILER }),
    ).toBe('tracking_host');
    // Host comparison is case-insensitive, so a feed shouting cannot hide.
    expect(
      assessAwinDestination({ destination: 'https://WWW.AWIN1.COM/cread.php', deepLink: RETAILER }),
    ).toBe('tracking_host');
  });

  /**
   * THE FALSE POSITIVE THE SECOND ARM EXISTS FOR.
   *
   * An advertiser whose feed carries only tracked links has a tracking host in
   * both columns and nothing is wrong with it. A single test — "is the
   * destination a tracking host" — reports every such advertiser as broken,
   * which is a detector somebody turns off in its first week.
   */
  it('does NOT report a tracked-only feed as a swap', () => {
    expect(assessAwinDestination({ destination: TRACKED, deepLink: TRACKED })).toBe('tracked_only');
  });

  it('claims nothing when there is no destination to read', () => {
    expect(assessAwinDestination({ destination: undefined, deepLink: TRACKED })).toBe('unexamined');
    expect(assessAwinDestination({ destination: '   ', deepLink: TRACKED })).toBe('unexamined');
    expect(assessAwinDestination({ destination: 'not a url', deepLink: TRACKED })).toBe(
      'unexamined',
    );
  });

  /**
   * The suffix trap, from the detector's side. `isAwinTrackingHost` compares the
   * WHOLE host, so a destination on `awin1.com.evil.example` is a retailer host
   * as far as this detector is concerned — and is refused as a tracking link by
   * `assessAwinTrackingLink`, which is where that string is actually dangerous.
   */
  it('does not read an attacker-suffixed host as the network', () => {
    expect(
      assessAwinDestination({
        destination: 'https://awin1.com.evil.example/p/1',
        deepLink: TRACKED,
      }),
    ).toBe('retailer_host');
  });

  /**
   * An UNREADABLE deep link beside a tracked destination is still the swap.
   *
   * The destination is tracked and nothing establishes that the deep-link column
   * is doing its job. Reading an unparseable value as "probably tracked" would
   * let an advertiser suppress the detector by publishing garbage in the one
   * column the detector exists to check.
   */
  it('does not let an unreadable deep link suppress the finding', () => {
    expect(assessAwinDestination({ destination: TRACKED, deepLink: undefined })).toBe(
      'tracking_host',
    );
    expect(assessAwinDestination({ destination: TRACKED, deepLink: 'not a url' })).toBe(
      'tracking_host',
    );
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

  /**
   * THE DETECTOR IS WIRED, and this is the test that goes red when it is not.
   *
   * `assessAwinDestination` is exercised on its own above; what this case pins
   * is that `observeAwinRecord` CALLS it. Deleting the call from `quality.ts`
   * leaves both counters at zero and fails here — a tested mechanism with no
   * caller is the failure mode this whole issue is about.
   *
   * Note which URL it reads: the MAPPED `affiliateUrl`, not what leaves the
   * adapter. `withAssessedAwinTracking` deletes that key when the link is not
   * approved, and a rejected deep link is still evidence about which column is
   * which.
   */
  it('counts the swap detector on both arms of the conjunction', () => {
    const TRACKED = 'https://www.awin1.com/cread.php?awinmid=1';
    const RETAILER = 'https://retailer.example/p/1';
    const meter = createAwinQualityMeter();

    // Swapped: the destination is the network's, the deep link is the shop's.
    observeAwinRecord(meter, {
      raw: rawRecord({}),
      mapped: mapped(0, 'a', {
        title: 'A',
        identifiers: [],
        options: [],
        media: [],
        sourceUrl: TRACKED,
        affiliateUrl: RETAILER,
      }),
      // The tracking verdict is `rejected_host` on exactly this row, and it is
      // NOT what the detector reads: an advertiser publishing an untracked
      // `aw_deep_link` produces the same verdict with nothing swapped.
      tracking: { verdict: 'rejected_host' },
    });
    // Tracked-only: both columns are the network's. Nothing is wrong.
    observeAwinRecord(meter, {
      raw: rawRecord({}, 1),
      mapped: mapped(1, 'b', {
        title: 'B',
        identifiers: [],
        options: [],
        media: [],
        sourceUrl: TRACKED,
        affiliateUrl: TRACKED,
      }),
      tracking: { verdict: 'approved', url: TRACKED },
    });
    // Ordinary.
    observeAwinRecord(meter, {
      raw: rawRecord({}, 2),
      mapped: mapped(2, 'c', {
        title: 'C',
        identifiers: [],
        options: [],
        media: [],
        sourceUrl: RETAILER,
        affiliateUrl: TRACKED,
      }),
      tracking: { verdict: 'approved', url: TRACKED },
    });

    const counts = readAwinQualityCounts(meter);
    expect(counts.destinationTrackingHost).toBe(1);
    expect(counts.destinationTrackedOnly).toBe(1);
    // The CHECK the row carries, asserted here too: the two are disjoint
    // verdicts over MAPPED records, so their sum can never exceed `mapped`.
    expect(counts.destinationTrackingHost + counts.destinationTrackedOnly).toBeLessThanOrEqual(
      counts.mapped,
    );
  });

  /**
   * The VACUITY FLOOR for the counter above, and the reason
   * `destinationTrackedOnly` is a column rather than a comment.
   *
   * A feed with no swap and a feed where the conjunction could never fire both
   * report `destinationTrackingHost: 0`. Only the second counter tells them
   * apart, so this asserts the two readings really do differ.
   */
  it('distinguishes a clean feed from one where the swap could not have fired', () => {
    const TRACKED = 'https://www.awin1.com/cread.php?awinmid=1';
    const record = (
      index: number,
      sourceUrl: string,
    ): Parameters<typeof observeAwinRecord>[1] => ({
      raw: rawRecord({}, index),
      mapped: mapped(index, `r${String(index)}`, {
        title: 'R',
        identifiers: [],
        options: [],
        media: [],
        sourceUrl,
        affiliateUrl: TRACKED,
      }),
      tracking: { verdict: 'approved', url: TRACKED },
    });

    const clean = createAwinQualityMeter();
    observeAwinRecord(clean, record(0, 'https://retailer.example/p/1'));
    const trackedOnly = createAwinQualityMeter();
    observeAwinRecord(trackedOnly, record(0, TRACKED));

    expect(readAwinQualityCounts(clean).destinationTrackingHost).toBe(0);
    expect(readAwinQualityCounts(trackedOnly).destinationTrackingHost).toBe(0);
    // Identical on the swap counter, different on the control. Without the
    // second column these two feeds are indistinguishable in the snapshot.
    expect(readAwinQualityCounts(clean).destinationTrackedOnly).toBe(0);
    expect(readAwinQualityCounts(trackedOnly).destinationTrackedOnly).toBe(1);
  });

  /**
   * The EVIDENCE, and why it is stored rather than looked up on the offer.
   *
   * On exactly the rows the counter flags, the deep-link column holds a RETAILER
   * url, so `assessAwinTrackingLink` refuses it and `withAssessedAwinTracking`
   * withholds it — `offers.affiliate_tracking_template` is NULL and only the
   * tracked destination survives. The half an operator needs in order to tell a
   * swap from a deliberate configuration is the half that is removed.
   */
  it('keeps the FIRST flagged row’s two hosts and never overwrites them', () => {
    const meter = createAwinQualityMeter();
    const flagged = (index: number, deepLink: string): void => {
      observeAwinRecord(meter, {
        raw: rawRecord({}, index),
        mapped: mapped(index, `f${String(index)}`, {
          title: 'F',
          identifiers: [],
          options: [],
          media: [],
          sourceUrl: `https://www.awin1.com/cread.php?awinmid=${String(index)}`,
          affiliateUrl: deepLink,
        }),
        tracking: { verdict: 'rejected_host' },
      });
    };
    flagged(0, 'https://retailer.example/first');
    flagged(1, 'https://retailer.example/second');

    expect(readAwinQualityCounts(meter).destinationTrackingHost).toBe(2);
    // "The first one we saw" is a fact an operator can reason about; "the last
    // one before the pass ended" is not.
    expect(meter.swapExample).toEqual({
      destinationHost: 'www.awin1.com',
      deepLinkHost: 'retailer.example',
    });
  });

  /**
   * A deep link that will not parse leaves the destination host standing.
   *
   * That row is still the swap — the destination is the network's and nothing
   * establishes that the deep-link column is doing its job — so dropping the
   * whole example would remove the evidence for a finding that was made.
   */
  it('records the destination host even when the deep link is unreadable', () => {
    const meter = createAwinQualityMeter();
    observeAwinRecord(meter, {
      raw: rawRecord({}),
      mapped: mapped(0, 'a', {
        title: 'A',
        identifiers: [],
        options: [],
        media: [],
        sourceUrl: 'https://www.awin1.com/cread.php?awinmid=1',
        affiliateUrl: 'not a url',
      }),
      tracking: { verdict: 'rejected_shape' },
    });
    expect(readAwinQualityCounts(meter).destinationTrackingHost).toBe(1);
    expect(meter.swapExample).toEqual({
      destinationHost: 'www.awin1.com',
      deepLinkHost: null,
    });
  });

  it('keeps no example when nothing was flagged', () => {
    const meter = createAwinQualityMeter();
    observeAwinRecord(meter, {
      raw: rawRecord({}),
      mapped: mapped(0, 'a', {
        title: 'A',
        identifiers: [],
        options: [],
        media: [],
        sourceUrl: 'https://retailer.example/p/1',
        affiliateUrl: 'https://www.awin1.com/cread.php?awinmid=1',
      }),
      tracking: { verdict: 'approved', url: 'https://www.awin1.com/cread.php?awinmid=1' },
    });
    expect(meter.swapExample).toBeNull();
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
