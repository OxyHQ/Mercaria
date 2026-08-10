/**
 * The walls around merchant demand analytics (#86), asserted STRUCTURALLY.
 *
 * Six properties, each a scan or a type rather than a fixture, because "cannot"
 * is a stronger statement than "did not in this case":
 *
 *  1. **Acquisition scoring cannot reach organic ranking, in either
 *     direction.** No module in this domain may reach ranking, search or the
 *     feed; and no ranking, search or feed module may reach this domain. The
 *     second half is the one that matters — a score an ordering could READ is a
 *     score that would eventually be one — and it is why the scan runs over the
 *     other domains' directories too.
 *  2. **This domain defines no second authority.** No freshness rule, no
 *     eligibility verdict, no save floor and no TTL of its own: #68, #57, #80
 *     and #77 own those, and this reads them.
 *  3. **Nothing here sends anything** (#86 acquisition 8). No transport, no
 *     mailer, no notification service, no outbound HTTP client.
 *  4. **No column and no DTO field holds a contact.** Asserted against the real
 *     drizzle tables, not against the declaration.
 *  5. **A sales word can never be rendered beside a click.** The count-noun
 *     vocabulary has no sales member, and the preview list has no conversion
 *     metric.
 *  6. **The operator surface is READ plus the closed write set.** No route that
 *     sets a claim state, a score or a figure, and no delete of a record.
 *
 * Every scanner carries the metro-gate defences: a vacuity floor so a moved file
 * fails the gate instead of silently shrinking it, and a mutation self-test so a
 * rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import {
  MERCHANT_DEMAND_COUNT_NOUNS,
  MERCHANT_DEMAND_PREVIEW_METRIC_KEYS,
} from '@mercaria/shared-types';
import {
  merchantAcquisitionAudits,
  merchantAcquisitionCandidates,
  merchantAcquisitionContactSources,
  merchantAcquisitionOutreach,
  merchantDemandMetrics,
  merchantDemandProducts,
  merchantDemandSnapshots,
} from '../../../db/schema/merchantDemand.js';
import { requireMerchantDemandMetric } from '../metrics.js';
import { acquisitionFactsFrom } from '../acquisition.service.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOMAIN_DIR = join(SRC_ROOT, 'services/merchant-demand');

/** Every non-test module in the domain, read from the real directory. */
function domainSources(): { relative: string; source: string }[] {
  return readdirSync(DOMAIN_DIR)
    .filter((entry) => entry.endsWith('.ts'))
    .filter((entry) => statSync(join(DOMAIN_DIR, entry)).isFile())
    .map((entry) => ({
      relative: `services/merchant-demand/${entry}`,
      source: readFileSync(join(DOMAIN_DIR, entry), 'utf8'),
    }));
}

/** The rest of the domain — the surfaces outside `services/merchant-demand/`. */
const OUTER_PATHS = [
  'db/merchantDemand/merchantDemandFactsRepository.ts',
  'db/merchantDemand/merchantDemandSnapshotRepository.ts',
  'db/merchantDemand/merchantAcquisitionRepository.ts',
  'db/schema/merchantDemand.ts',
  'controllers/merchant-demand.controller.ts',
  'controllers/merchant-acquisition.controller.ts',
  'routes/merchant-demand.ts',
  'routes/internal-merchant-demand.ts',
  'middleware/merchant-demand-schemas.ts',
];

/** Every file this domain owns, inside and outside the service directory. */
function allDomainFiles(): { relative: string; source: string }[] {
  return [
    ...domainSources(),
    ...OUTER_PATHS.map((relative) => ({
      relative,
      source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
    })),
  ];
}

/** Comment-stripped source: these modules DOCUMENT what they refuse to do. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Reaching an ORDERING, from any direction.
 *
 * Matched on the bare `<domain>/` path segment as well as the `services/` form,
 * because an import from a sibling directory is written `../ranking/…` and the
 * longer form alone would miss it.
 */
const RANKING_REFERENCE =
  /\branking\/|\bsearch\/|rankOffers|rankOfferComparison|rankingPolicyVersions|ranking_policy_versions|OfferRankingFacts|SEARCH_RELEVANCE|relevanceFor|scoreEntityRelevance|offer-ranking|offer-comparison/;

/** Reaching the DEMAND domain from an ordering. The reverse direction. */
const MERCHANT_DEMAND_REFERENCE =
  /merchant-demand\/|merchantDemand\/|merchant_demand_|merchant_acquisition_|scoreMerchantAcquisition|MerchantAcquisitionFacts|MERCHANT_ACQUISITION_|MERCHANT_DEMAND_/;

/** A second authority over freshness, eligibility, save floors or a TTL. */
const SECOND_AUTHORITY_REFERENCE =
  /TTL_SECONDS|ttlSeconds|isStale\(|STALE_AFTER|FRESHNESS_SECONDS|freshnessTtl|deriveNativeCheckoutEligibility|SAVE_COUNT_FLOOR|saveDisclosureFloor|buildPriceSignalContext|buildSample|derivePriceSignals/;

/** Anything that could SEND. */
const TRANSPORT_REFERENCE =
  /nodemailer|@aws-sdk\/client-ses|sendMail|sendEmail|registerGuestMessageTransport|registerPriceAlertEmailTransport|notification\.service|notifications\/|safeFetch|axios|node-fetch|\bfetch\(/;

/** A contact value, by column or field name. */
const CONTACT_FIELD = /email|phone|mobile|contact_name|contactName|contact_value|contactValue|address|postal|recipient/i;

describe('the merchant demand domain has real modules — the vacuity floor', () => {
  it('scans a domain that exists and is not empty', () => {
    const domain = domainSources();
    // A renamed directory or a moved module must fail here rather than make
    // every scan below pass against an empty list.
    expect(domain.length).toBeGreaterThanOrEqual(7);
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
    for (const relative of OUTER_PATHS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });
});

describe('WALL 1: acquisition scoring and organic ranking cannot see each other', () => {
  it('no module in this domain reaches ranking, search or a comparison', () => {
    let scanned = 0;
    for (const file of allDomainFiles()) {
      expect(
        RANKING_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches an ordering; a score that can read a rank is a rank that can be sold`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(16);
  });

  it('no ranking, search or feed module reaches this domain — the REVERSE direction', () => {
    // The direction #86 actually names ("scoring cannot affect organic offer
    // ranking"), and the one a one-way scan would miss: the damage is done by
    // an ORDERING reading a score, not by a score reading an ordering.
    const orderingDirs = [
      join(SRC_ROOT, 'services/ranking'),
      join(SRC_ROOT, 'services/search'),
      join(SRC_ROOT, 'services/offers'),
    ];
    let scanned = 0;
    for (const dir of orderingDirs) {
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.ts')) continue;
        if (!statSync(join(dir, entry)).isFile()) continue;
        const source = readFileSync(join(dir, entry), 'utf8');
        expect(
          MERCHANT_DEMAND_REFERENCE.test(withoutComments(source)),
          `${dir}/${entry} reaches merchant demand; an ordering that can read an acquisition score would eventually order by it`,
        ).toBe(false);
        scanned += 1;
      }
    }
    expect(scanned, 'the reverse scan found no ordering modules at all').toBeGreaterThanOrEqual(20);
  });

  it('both detectors actually detect — the mutation self-test', () => {
    expect(RANKING_REFERENCE.test("import { rankOffers } from '../ranking/rank.js';")).toBe(true);
    expect(RANKING_REFERENCE.test("import { x } from '../../db/ranking/rankingPolicyRepository.js';")).toBe(true);
    expect(RANKING_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
    expect(
      MERCHANT_DEMAND_REFERENCE.test(
        "import { scoreMerchantAcquisition } from '@mercaria/shared-types';",
      ),
    ).toBe(true);
    expect(
      MERCHANT_DEMAND_REFERENCE.test("import { x } from '../merchant-demand/metrics.js';"),
    ).toBe(true);
    expect(MERCHANT_DEMAND_REFERENCE.test("import { merchants } from '../schema/merchants.js';")).toBe(
      false,
    );
  });
});

describe('WALL 1b: reading #82 is a READ, and never a scoring input', () => {
  it('the scorer’s facts carry no comparison figure at all', () => {
    // `subjects_with_a_price_comparison` is measured by #82's own aggregation
    // and rendered on the dashboard. It must not become a SCORE input: an
    // acquisition score that rose because a merchant's products are easy to
    // compare would be a commercial signal entering a ranking-adjacent number
    // through the one door this domain leaves open — a legitimate read of
    // another domain.
    const fields = Object.keys(
      acquisitionFactsFrom({
        offers: [],
        canonicalProductIds: [],
        nativeProductIds: new Set<string>(),
        offerImpressions: 0,
        productPageViews: 0,
        perProductViews: new Map<string, number>(),
        perProductImpressions: new Map<string, number>(),
        freshnessByOffer: new Map(),
        freshOfferCount: 0,
        saveCounts: new Map<string, number>(),
        nativeStoreId: undefined,
        nativePaidOrders: undefined,
        nativeGrossMinor: undefined,
        nativeCurrency: undefined,
        dataFreshAsOf: new Date(),
        collectionEnabled: false,
        comparableSubjects: { subjectsExamined: 10, subjectsComparable: 9 },
      }),
    );
    // The floor: a builder returning `{}` would pass every assertion below.
    expect(fields.length).toBeGreaterThanOrEqual(6);
    expect(
      fields.filter((name) => /comparable|comparison|competitive|coverage|price/i.test(name)),
      'a price-comparison figure acquired a scoring field',
    ).toEqual([]);
  });
});

describe('WALL 2: this domain defines no second authority', () => {
  it('no module declares a TTL, a staleness rule, an eligibility verdict or a save floor', () => {
    let scanned = 0;
    for (const file of allDomainFiles()) {
      expect(
        SECOND_AUTHORITY_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} declares a rule #68, #57 or #80 owns; a second authority does not ` +
          'announce itself, it silently wins wherever it is consulted',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(16);
  });

  it('the second-authority detector actually detects — the mutation self-test', () => {
    expect(SECOND_AUTHORITY_REFERENCE.test('const MERCHANT_DEMAND_TTL_SECONDS = 3600;')).toBe(true);
    expect(SECOND_AUTHORITY_REFERENCE.test('if (isStale(offer)) return;')).toBe(true);
    expect(SECOND_AUTHORITY_REFERENCE.test('const SAVE_COUNT_FLOOR = 10;')).toBe(true);
    expect(SECOND_AUTHORITY_REFERENCE.test('const floor = MERCHANT_DEMAND_PRODUCT_MIN_COUNT;')).toBe(
      false,
    );
  });
});

describe('WALL 3: nothing here sends anything (#86 acquisition 8)', () => {
  it('no module imports a transport, a mailer, a notifier or an HTTP client', () => {
    let scanned = 0;
    for (const file of allDomainFiles()) {
      expect(
        TRANSPORT_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} can send. #86 acquisition 8 is "no automatic email or messaging", and ` +
          'the outreach LOG is a record of what a person did outside Mercaria',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(16);
  });

  it('the transport detector actually detects — the mutation self-test', () => {
    expect(TRANSPORT_REFERENCE.test("import nodemailer from 'nodemailer';")).toBe(true);
    expect(TRANSPORT_REFERENCE.test('await sendEmail({ to, subject });')).toBe(true);
    expect(TRANSPORT_REFERENCE.test("await safeFetch('https://example.test');")).toBe(true);
    expect(TRANSPORT_REFERENCE.test('const outreach = await recordOutreach(input);')).toBe(false);
  });
});

describe('WALL 4: no column in this domain can hold a contact', () => {
  const TABLES = [
    { name: 'merchant_demand_snapshots', table: merchantDemandSnapshots },
    { name: 'merchant_demand_metrics', table: merchantDemandMetrics },
    { name: 'merchant_demand_products', table: merchantDemandProducts },
    { name: 'merchant_acquisition_candidates', table: merchantAcquisitionCandidates },
    { name: 'merchant_acquisition_contact_sources', table: merchantAcquisitionContactSources },
    { name: 'merchant_acquisition_outreach', table: merchantAcquisitionOutreach },
    { name: 'merchant_acquisition_audits', table: merchantAcquisitionAudits },
  ];

  it('walks the REAL drizzle tables and finds no contact-shaped column', () => {
    let columnsScanned = 0;
    for (const entry of TABLES) {
      const columns = Object.keys(getTableColumns(entry.table));
      expect(columns.length, `${entry.name} looks empty`).toBeGreaterThan(4);
      const suspicious = columns.filter((name) => CONTACT_FIELD.test(name));
      expect(
        suspicious,
        `${entry.name} acquired a contact column; #86 privacy 7 is held by there being nowhere ` +
          'for a value to land, not by a rule about where it came from',
      ).toEqual([]);
      columnsScanned += columns.length;
    }
    // The vacuity floor: a table list that resolved to nothing would pass.
    expect(columnsScanned).toBeGreaterThanOrEqual(60);
  });

  it('no table in the domain carries a `total`, `sum` or `revenue` column', () => {
    // #86's "keep affiliate commission, external order value, native GMV and
    // inferred demand as separately labelled metrics": an addition across kinds
    // has nowhere to be written down.
    const forbidden = /^(total|sum|combined|revenue|gross_total|allTotal)$/i;
    for (const entry of TABLES) {
      const suspicious = Object.keys(getTableColumns(entry.table)).filter((name) =>
        forbidden.test(name),
      );
      expect(suspicious, `${entry.name} acquired a cross-kind total`).toEqual([]);
    }
  });

  it('the contact detector actually detects — the mutation self-test', () => {
    expect(CONTACT_FIELD.test('contactEmail')).toBe(true);
    expect(CONTACT_FIELD.test('phone')).toBe(true);
    expect(CONTACT_FIELD.test('billingAddress')).toBe(true);
    expect(CONTACT_FIELD.test('sourceUrl')).toBe(false);
    expect(CONTACT_FIELD.test('locatorNote')).toBe(false);
  });
});

describe('WALL 5: a click can never be rendered with a sales word', () => {
  it('the count-noun vocabulary has no sales member', () => {
    const salesWord = /sale|sold|conversion|purchase|revenue|gmv/i;
    const offending = MERCHANT_DEMAND_COUNT_NOUNS.filter((noun) => salesWord.test(noun));
    expect(offending, 'a sales noun entered the count vocabulary').toEqual([]);
    expect(MERCHANT_DEMAND_COUNT_NOUNS.length).toBeGreaterThanOrEqual(6);
  });

  it('the outbound-click metric is an interaction, never a conversion', () => {
    expect(requireMerchantDemandMetric('human_outbound_clicks').kind).toBe('observed_interaction');
    expect(requireMerchantDemandMetric('network_reported_conversions').kind).toBe(
      'affiliate_conversion',
    );
    // Two different KINDS, so nothing can add them — #86 acceptance 2 held by
    // the vocabulary rather than by whoever writes the next summary line.
    expect(requireMerchantDemandMetric('human_outbound_clicks').noun).toBe('visits');
  });

  it('the preview shows no conversion metric at all', () => {
    for (const key of MERCHANT_DEMAND_PREVIEW_METRIC_KEYS) {
      expect(requireMerchantDemandMetric(key).kind).toBe('observed_interaction');
    }
  });
});

describe('WALL 6: the operator surface is read plus a CLOSED write set', () => {
  const router = readFileSync(join(SRC_ROOT, 'routes/internal-merchant-demand.ts'), 'utf8');

  it('registers exactly the routes it declares, and nothing that sets a fact', () => {
    const registered = [...router.matchAll(/router\.(get|post|delete|patch|put)\(\s*'([^']+)'/g)].map(
      (match) => `${match[1]} ${match[2]}`,
    );
    // The floor AND the enumeration: a route added without a reviewer noticing
    // fails here, and an empty match set fails here too.
    expect(registered.sort()).toEqual(
      [
        'delete /candidates/:merchantId/exclude',
        'get /candidates',
        'get /candidates/:merchantId',
        'get /candidates/:merchantId/outreach-context',
        'get /candidates/:merchantId/snapshots',
        'get /health',
        'post /candidates/:merchantId/assign',
        'post /candidates/:merchantId/contact-sources',
        'post /candidates/:merchantId/do-not-contact',
        'post /candidates/:merchantId/exclude',
        'post /candidates/:merchantId/next-action',
        'post /candidates/:merchantId/outreach',
        'post /candidates/:merchantId/rescore',
      ].sort(),
    );
  });

  /**
   * A quoted string on ONE line.
   *
   * `[^'"\n]` rather than `[^'"]` is load-bearing: a JavaScript character class
   * matches a newline, so the obvious spelling treats everything between the
   * first quote in an import and the next quote three hundred lines later as one
   * "string" and matches almost any word in the file. It fired on the first run
   * of this gate, on `sendSuccess` — an identifier that is not in a string at
   * all.
   */
  const forbiddenPath =
    /['"][^'"\n]*(set-claim|claim-state|verify-claim|set-score|override|send|notify|message|delete-outreach|purge)[^'"\n]*['"]/i;

  it('has no claim, score-override, send or delete-a-record path anywhere', () => {
    for (const file of [
      { relative: 'routes/internal-merchant-demand.ts', source: router },
      {
        relative: 'controllers/merchant-acquisition.controller.ts',
        source: readFileSync(join(SRC_ROOT, 'controllers/merchant-acquisition.controller.ts'), 'utf8'),
      },
    ]) {
      expect(
        forbiddenPath.test(withoutComments(file.source)),
        `${file.relative} exposes a way to set a fact another domain owns`,
      ).toBe(false);
    }
  });

  it('the path detector actually detects — the mutation self-test', () => {
    expect(forbiddenPath.test("router.post('/candidates/:id/set-claim', handler);")).toBe(true);
    expect(forbiddenPath.test("router.post('/candidates/:id/send', handler);")).toBe(true);
    expect(forbiddenPath.test("router.post('/candidates/:id/rescore', handler);")).toBe(false);
    // The newline guard itself: two quoted strings on two lines must not be
    // read as one string spanning the word between them.
    expect(forbiddenPath.test("import { sendSuccess } from 'x';\nconst a = 'b';")).toBe(false);
  });
});
