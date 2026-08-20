/**
 * The walls around the price-alert domain, as SCANS rather than conventions.
 *
 * Six directions, each with the two defences `~/Oxy/AGENTS.md` requires of a
 * gate: a VACUITY FLOOR (every scanned file must exist and be non-trivial, so a
 * moved or emptied file fails the gate instead of passing it by having nothing
 * to match) and a MUTATION SELF-TEST (each detector is run against a seeded
 * positive and a seeded negative, so a regex that rotted cannot pass by matching
 * nothing).
 *
 * The reachability detectors scan COMMENT-STRIPPED source — `checkout-contact-isolation.test.ts`'s
 * rule — because these modules document what they refuse to do in exactly the
 * vocabulary the detectors look for. The FairCoin/OxyPay detector is the
 * exception and scans RAW source, COPY included, for #78's reason: a hard-coded
 * currency name in a comment or a string is how one arrives.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DirectoryReader,
  assertDirectoriesAreFlat,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';
import {
  PRICE_ALERT_FORBIDDEN_NOTIFICATION_FIELDS,
  PRICE_ALERT_FORBIDDEN_SCOPES,
  PRICE_ALERT_SELLER_SCOPES,
  PRICE_ALERT_AVAILABILITY_REQUIREMENTS,
  PRICE_ALERT_PROXIMITY_SCOPES,
  PRICE_ALERT_COMPARISON_BASES,
} from '@mercaria/shared-types';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
  readRankingSurfaceFile,
} from '../../../__tests__/ranking-surface.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The domain's OWN directories, walked whole. */
const DOMAIN_DIRECTORIES = ['services/price-alerts', 'db/priceAlerts'];

/** The shared directories, where this domain sits beside every other domain's. */
const OUTER_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'];

/** What a file BELONGING to this domain is called, wherever it lives. */
const DOMAIN_NAME_PATTERN = /price-?alerts?/i;

/**
 * Read one scanned file, asserting it is a real file first.
 *
 * `statSync` rather than a bare `readFileSync`: a DERIVED population is only as
 * honest as the assertion that every member resolves, and a `readdirSync` served
 * from a stale cache would hand every scan below names that no longer exist —
 * which reads as a clean run.
 */
function readScanned(absolute: string): string {
  expect(statSync(absolute).isFile(), `${absolute} is not a file — did it move?`).toBe(true);
  return readFileSync(absolute, 'utf8');
}

/** Every `.ts` directly under one directory, sorted. */
function filesIn(relative: string, matching?: RegExp): string[] {
  return readdirSync(join(SRC_ROOT, relative))
    .filter((entry) => entry.endsWith('.ts'))
    .filter((entry) => matching === undefined || matching.test(entry))
    .sort()
    .map((entry) => join(SRC_ROOT, relative, entry));
}

/**
 * Every file of the domain, DERIVED from disk rather than listed.
 *
 * The two domain directories were always walked; the five files in the SHARED
 * directories were pushed BY NAME and are now selected by name PATTERN, so a
 * route or schema module added tomorrow is scanned the moment it exists. A hand
 * list is complete on the day it is written and silently incomplete the day
 * somebody adds a module — and what it then skips is exactly the module nobody
 * has reviewed (#460).
 */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    // BOTH halves recurse now. `filesIn` read one directory level, so a
    // sub-directory of the domain's own service directory was outside every
    // wall, and the shared-directory sweep could reach neither `routes/admin/`
    // nor `controllers/admin/` (#460). The shared half also matches the PATH
    // rather than the filename, because a module inside a directory named for
    // the domain names it nowhere in its own name.
    ...DOMAIN_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(OUTER_DIRECTORIES, DOMAIN_NAME_PATTERN, readDir),
  ];
}

function enumerateDomain(): string[] {
  return domainRelativePaths().map((relative) => join(SRC_ROOT, relative));
}

/**
 * The floors, PER SHAPE and measured off this branch.
 *
 * Per shape because one total lets a directory collapse to nothing behind
 * another's count. MEASURED: 10 under `services/price-alerts`, 5 under
 * `db/priceAlerts`, 5 in the shared directories.
 */
const MINIMUM_DOMAIN_DIRECTORY_FILES = 15;
const MINIMUM_OUTER_FILES = 5;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The fee, referral and plan domains — what may never decide whose price a buyer hears about. */
const COMMERCIAL_REFERENCE =
  /\/fees\/|fee_schedules|\/referrals\/|referral_touches|commissionAmount|merchant_plans?\b|sponsored|\/ledger|ledger_entries/;

/** A FairCoin or OxyPay assumption, in code OR in copy. */
const FAIRCOIN_REFERENCE = /FairCoin|faircoin|OxyPay|oxy_pay|oxyPay|\bFAIR\b|⊜/;

/** A CONTACT of any kind. The transactional channel is Oxy's own feed. */
const CONTACT_REFERENCE =
  /guest_checkouts|emailHash|email_hash|encryptEmail|decryptEmail|recipientEmail|toAddress|smtp|nodemailer|@aws-sdk\/client-ses|push_tokens|web_push_subscriptions/;

/** An outbound destination — notification 3's "now-unvalidated destination". */
const DESTINATION_REFERENCE =
  /destinationUrl|destination_url|affiliateTrackingTemplate|affiliate_tracking_template|buildAffiliateUrl|services\/outbound\//;

/**
 * The DELIVERY path may not evaluate a price (acceptance 6).
 *
 * Scanned over the two delivery modules only: everywhere else in the domain
 * legitimately reaches the comparison.
 */
const EVALUATION_REFERENCE =
  /qualifyAlert|evaluatePriceAlertsForProduct|insertPriceAlertTrigger|buildAlertComparison|selectEligibleOffers\(/;

/** The domain must not re-derive freshness, staleness or a TTL of its own (#68). */
const LOCAL_FRESHNESS_REFERENCE =
  /const\s+\w*(TTL|Ttl|StaleSeconds|FRESHNESS_SECONDS)\w*\s*=|function\s+isStale|OFFER_TTL_SECONDS/;


const ALERT_DOMAIN_REFERENCE =
  /price-alerts\/|priceAlerts\/|price_alerts\b|price_alert_triggers|priceAlertTriggers|qualifyAlert/;

/** The three levers, none of which may gate a durable record. */
const LEVER_REFERENCE = /config\.priceAlerts\.(enabled|evaluationEnabled|notificationsEnabled)/;

/**
 * The modules that write the durable records a lever must never reach.
 *
 * DERIVED as the whole of `db/priceAlerts/` plus the one service that writes
 * through it, rather than the four repositories somebody listed. The hand list
 * MISSED `observedPriceVersionRepository.ts` — measured on this branch: five
 * repositories exist and four were named — so the observed-price-version write,
 * which is the row a trigger's identity key is built on, sat behind no lever
 * wall at all. Nothing failed, because a scan over a population that never
 * included a file reports exactly what a clean one does.
 *
 * Every repository in that directory writes a durable record by construction,
 * so the directory IS the rule; naming four of them was a snapshot of it.
 */
function durableWriters(): string[] {
  return [
    ...filesIn('db/priceAlerts'),
    join(SRC_ROOT, 'services/price-alerts/evaluation.service.ts'),
  ];
}

/** MEASURED: 5 repositories + the evaluation service. */
const MINIMUM_DURABLE_WRITERS = 6;

/**
 * The DELIVERY modules, derived by name from the domain's own directory.
 *
 * Four today (`delivery.service`, `delivery-dispatcher`, `notification`,
 * `transport`). A fifth delivery module would join the scan on its own, which
 * is the point: acceptance 6 is a property of the delivery PATH, not of the
 * four files that happened to make it up when the gate was written.
 */
const DELIVERY_NAME_PATTERN = /delivery|notification|transport/i;

/** MEASURED: 4. */
const MINIMUM_DELIVERY_FILES = 4;

describe('the price-alert domain cannot reach what it must not', () => {
  const files = enumerateDomain();

  it('scans a domain that has not silently shrunk', () => {
    // Both halves come from the SAME traversal the population uses (#668). They
    // were a one-level `filesIn` beside a recursive population — a second
    // spelling, and the identity below held only because `routes/admin/` and
    // `controllers/admin/` happen to hold no module named for this domain. The
    // first one added would have failed this assertion while blaming the
    // population rather than the floor.
    const inDomain = DOMAIN_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    const inOuter = namedInSharedDirectories(OUTER_DIRECTORIES, DOMAIN_NAME_PATTERN);
    expect(
      inDomain.length,
      'services/price-alerts + db/priceAlerts shrank; a walk that lost a module scans clean',
    ).toBeGreaterThanOrEqual(MINIMUM_DOMAIN_DIRECTORY_FILES);
    expect(
      inOuter.length,
      'no controller/route/middleware/schema is named for this domain — did the derivation break?',
    ).toBeGreaterThanOrEqual(MINIMUM_OUTER_FILES);
    expect(files.length).toBe(inDomain.length + inOuter.length);

    for (const file of files) {
      expect(readScanned(file).length, `${file} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('references no fee, referral, plan or ledger — a payment cannot decide whose price a buyer hears about', () => {
    for (const file of files) {
      expect(
        COMMERCIAL_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches a commercial domain; a commission must not decide which offer notifies somebody`,
      ).toBe(false);
    }
  });

  it('names no FairCoin or OxyPay assumption, in code or in copy', () => {
    for (const file of files) {
      expect(
        FAIRCOIN_REFERENCE.test(readFileSync(file, 'utf8')),
        `${file} names FairCoin or OxyPay; an alert names ONE currency and the caller supplies it`,
      ).toBe(false);
    }
  });

  it('stores and reads NO contact of any kind', () => {
    for (const file of files) {
      expect(
        CONTACT_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches a contact; the transactional channel is Oxy's own notification service`,
      ).toBe(false);
    }
  });

  it('composes no outbound destination — notification 3', () => {
    for (const file of files) {
      expect(
        DESTINATION_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches an outbound destination; a notification links to the canonical product and the offer`,
      ).toBe(false);
    }
  });

  it('defines no TTL, staleness rule or freshness lifetime of its own — that is #68', () => {
    for (const file of files) {
      expect(
        LOCAL_FRESHNESS_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} defines a local freshness rule; #68's per-source policy is the single authority`,
      ).toBe(false);
    }
  });

  it('the DELIVERY path cannot evaluate a price — acceptance 6', () => {
    // The property is an IMPORT-GRAPH fact rather than a rule somebody follows:
    // a retry re-reads the trigger row and never the offers it was derived from.
    const delivery = filesIn('services/price-alerts', DELIVERY_NAME_PATTERN);
    expect(
      delivery.length,
      'the delivery modules vanished from services/price-alerts; acceptance 6 now scans nothing',
    ).toBeGreaterThanOrEqual(MINIMUM_DELIVERY_FILES);
    for (const file of delivery) {
      const source = readScanned(file);
      expect(source.length, `${file} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        EVALUATION_REFERENCE.test(stripComments(source)),
        `${file} can evaluate a price; a delivery retry must never create a second trigger`,
      ).toBe(false);
    }
  });

  it('NO lever gates a durable record', () => {
    const writers = durableWriters();
    // A FLOOR, never `toBe(LIST.length)`. Comparing a loop's counter against the
    // list the loop just iterated is satisfied by any list including an empty
    // one: it catches a broken loop and never a shrunk population.
    expect(
      writers.length,
      'the durable-writer population shrank; a lever could now gate a row unwatched',
    ).toBeGreaterThanOrEqual(MINIMUM_DURABLE_WRITERS);
    for (const file of writers) {
      const source = readScanned(file);
      expect(source.length, `${file} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        LEVER_REFERENCE.test(stripComments(source)),
        `${file} reads a price-alert lever; a flag must stop a LOOP and never a row`,
      ).toBe(false);
    }
  });

  it('is not reachable FROM the organic ranking surface either', () => {
    let scanned = 0;
    assertRankingSurfaceIsWhole();
    for (const relative of RANKING_SURFACE_PATHS) {
      const source = readRankingSurfaceFile(relative);
      expect(
        ALERT_DOMAIN_REFERENCE.test(stripComments(source)),
        `${relative} references price alerts; how many people are waiting for a price is one join from ordering by it`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_SURFACE_PATHS.length);
  });
});

describe('the vocabularies are DISJOINT, so a forbidden scope has no value', () => {
  it('no forbidden scope appears in any alert vocabulary', () => {
    // A vacuity floor on the prohibition itself: an empty list passes every
    // check below while forbidding nothing.
    expect(PRICE_ALERT_FORBIDDEN_SCOPES.length).toBeGreaterThanOrEqual(8);
    const allowed = new Set<string>([
      ...PRICE_ALERT_SELLER_SCOPES,
      ...PRICE_ALERT_AVAILABILITY_REQUIREMENTS,
      ...PRICE_ALERT_PROXIMITY_SCOPES,
      ...PRICE_ALERT_COMPARISON_BASES,
    ]);
    for (const forbidden of PRICE_ALERT_FORBIDDEN_SCOPES) {
      expect(allowed.has(forbidden), `\`${forbidden}\` is both forbidden and allowed`).toBe(false);
    }
  });

  it('the schema declares no column for a forbidden scope', async () => {
    const { getTableColumns } = await import('drizzle-orm');
    const { priceAlerts } = await import('../../../db/schema/priceAlerts.js');
    const columns = Object.keys(getTableColumns(priceAlerts)).map((name) => name.toLowerCase());
    for (const forbidden of PRICE_ALERT_FORBIDDEN_SCOPES) {
      const collapsed = forbidden.replace(/_/g, '');
      expect(
        columns.some((column) => column.includes(collapsed)),
        `price_alerts has a column for the forbidden scope \`${forbidden}\``,
      ).toBe(false);
    }
  });
});

describe('the notification payload is an ALLOW-LIST, walked at runtime', () => {
  it('a REAL emitted payload carries none of the forbidden fields', async () => {
    const { priceAlertNotificationPayload } = await import('../notification.js');
    const payload = priceAlertNotificationPayload(
      {
        id: 'trigger-1',
        alertId: 'alert-1',
        offerId: 'offer-1',
        canonicalProductId: 'product-1',
        canonicalVariantId: 'variant-1',
        observedPriceVersion: 'snapshot-1',
        policyVersion: 'v1',
        basis: 'item_price',
        amount: { amount: 1_000, currency: 'EUR' },
        target: { amount: 2_000, currency: 'EUR' },
        nativeItemPrice: { amount: 1_000, currency: 'EUR' },
        quotes: [],
        offerKind: 'external',
        nativeCheckoutEligible: false,
        triggeredAt: new Date().toISOString(),
      },
      'es-ES',
    );
    // A static scan catches a DECLARED field; this catches one a serializer
    // spread in — the two gates #78 uses, for the same reason.
    expect(PRICE_ALERT_FORBIDDEN_NOTIFICATION_FIELDS.length).toBeGreaterThanOrEqual(8);
    for (const field of PRICE_ALERT_FORBIDDEN_NOTIFICATION_FIELDS) {
      expect(Object.keys(payload), `the payload carries \`${field}\``).not.toContain(field);
    }
    // The positive control: an empty payload would pass every assertion above.
    expect(Object.keys(payload).length).toBeGreaterThanOrEqual(9);
    expect(payload.canonicalProductId).toBe('product-1');
    expect(payload.offerId).toBe('offer-1');
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('the commercial detector sees a fee import and not an innocent one', () => {
    expect(
      COMMERCIAL_REFERENCE.test("import { planFee } from '../fees/fee-plan.service.js';"),
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('select * from fee_schedules')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { getRates } from '../fx.service.js';")).toBe(false);
  });

  it('the FairCoin detector sees the code name, the symbol and the copy', () => {
    expect(FAIRCOIN_REFERENCE.test("const base: CurrencyCode = 'FAIR';")).toBe(true);
    expect(FAIRCOIN_REFERENCE.test('// FairCoin alerts are shown first')).toBe(true);
    expect(FAIRCOIN_REFERENCE.test('label: `⊜ 12.00`')).toBe(true);
    expect(FAIRCOIN_REFERENCE.test("const base: CurrencyCode = 'EUR';")).toBe(false);
    expect(FAIRCOIN_REFERENCE.test('a fairly ordinary comparison')).toBe(false);
  });

  it('the contact detector sees a mail client and a push registration', () => {
    expect(CONTACT_REFERENCE.test("import { SESClient } from '@aws-sdk/client-ses';")).toBe(true);
    expect(CONTACT_REFERENCE.test('select * from push_tokens')).toBe(true);
    expect(CONTACT_REFERENCE.test('const email = contact.emailHash;')).toBe(true);
    expect(CONTACT_REFERENCE.test('const alert = await findPriceAlertById(id);')).toBe(false);
  });

  it('the destination detector sees an outbound URL and not the word offer', () => {
    expect(DESTINATION_REFERENCE.test('payload.destinationUrl = offer.destinationUrl;')).toBe(true);
    expect(DESTINATION_REFERENCE.test("import { compose } from '../outbound/redirect.js';")).toBe(
      false,
    );
    expect(DESTINATION_REFERENCE.test("import { x } from '../services/outbound/redirect.js';")).toBe(
      true,
    );
    expect(DESTINATION_REFERENCE.test('const offerId = trigger.offerId;')).toBe(false);
  });

  it('the evaluation detector sees a qualification call', () => {
    expect(EVALUATION_REFERENCE.test('const verdict = qualifyAlert({ alert, candidates });')).toBe(
      true,
    );
    expect(EVALUATION_REFERENCE.test('await insertPriceAlertTrigger(input, tx);')).toBe(true);
    expect(EVALUATION_REFERENCE.test('const trigger = await findPriceAlertTrigger(id);')).toBe(
      false,
    );
  });

  it('the local-freshness detector sees a private TTL', () => {
    expect(LOCAL_FRESHNESS_REFERENCE.test('const ALERT_OFFER_TTL_SECONDS = 3600;')).toBe(true);
    expect(LOCAL_FRESHNESS_REFERENCE.test('function isStale(offer) { return false; }')).toBe(true);
    expect(
      LOCAL_FRESHNESS_REFERENCE.test('if (!mayAppearInComparison(offer.freshness)) return false;'),
    ).toBe(false);
  });

  it('the lever detector sees a durable write reading a flag', () => {
    expect(LEVER_REFERENCE.test('if (!config.priceAlerts.enabled) return;')).toBe(true);
    expect(LEVER_REFERENCE.test('if (!config.priceAlerts.evaluationEnabled) return;')).toBe(true);
    expect(LEVER_REFERENCE.test('config.priceAlerts.evaluationBatchSize')).toBe(false);
  });

  it('the reverse detector sees a price-alert import', () => {
    expect(
      ALERT_DOMAIN_REFERENCE.test("import { qualifyAlert } from '../price-alerts/qualification.js';"),
    ).toBe(true);
    expect(ALERT_DOMAIN_REFERENCE.test('select count(*) from price_alerts')).toBe(true);
    expect(ALERT_DOMAIN_REFERENCE.test("import { listOffers } from './offers/offer.service.js';")).toBe(
      false,
    );
  });

  it('the derivations select the real files and not their neighbours', () => {
    // A derivation that replaced a hand list owes the same proof a detector
    // does: that it still selects everything the list named. Anything it stopped
    // selecting is a file that silently left the scan.
    const outer = OUTER_DIRECTORIES.flatMap((relative) =>
      filesIn(relative, DOMAIN_NAME_PATTERN),
    ).map((absolute) => absolute.slice(SRC_ROOT.length + 1));
    for (const expected of [
      'controllers/price-alerts.controller.ts',
      'routes/price-alerts.ts',
      'routes/internal-price-alerts.ts',
      'middleware/price-alert-schemas.ts',
      'db/schema/priceAlerts.ts',
    ]) {
      expect(outer, `the derivation stopped selecting ${expected}`).toContain(expected);
    }
    // Singular AND plural, and the un-anchored case a naive pattern misses.
    expect(DOMAIN_NAME_PATTERN.test('internal-price-alerts.ts')).toBe(true);
    expect(DOMAIN_NAME_PATTERN.test('price-alert-schemas.ts')).toBe(true);
    expect(DOMAIN_NAME_PATTERN.test('priceAlerts.ts')).toBe(true);
    // …and must not drag in a sibling price domain.
    expect(DOMAIN_NAME_PATTERN.test('price-history.ts')).toBe(false);
    expect(DOMAIN_NAME_PATTERN.test('price-signals.controller.ts')).toBe(false);

    // The durable-writer derivation covers the repository the hand list MISSED.
    const writers = durableWriters().map((absolute) => absolute.slice(SRC_ROOT.length + 1));
    expect(
      writers,
      'observedPriceVersionRepository writes the row a trigger identity is keyed on and was ' +
        'behind no lever wall while the list was hand-maintained',
    ).toContain('db/priceAlerts/observedPriceVersionRepository.ts');
    expect(writers).toContain('services/price-alerts/evaluation.service.ts');

    // The delivery derivation selects exactly the four the list named.
    const delivery = filesIn('services/price-alerts', DELIVERY_NAME_PATTERN).map((absolute) =>
      absolute.slice(SRC_ROOT.length + 1),
    );
    for (const expected of [
      'services/price-alerts/delivery.service.ts',
      'services/price-alerts/delivery-dispatcher.ts',
      'services/price-alerts/notification.ts',
      'services/price-alerts/transport.ts',
    ]) {
      expect(delivery, `the delivery derivation stopped selecting ${expected}`).toContain(expected);
    }
    // …and not the evaluation service, which legitimately evaluates.
    expect(delivery).not.toContain('services/price-alerts/evaluation.service.ts');
  });

  it('the comment stripper does not hide a real reference on the same line', () => {
    const stripped = stripComments("import { x } from '../fees/y.js'; // a note");
    expect(COMMERCIAL_REFERENCE.test(stripped)).toBe(true);
    expect(stripComments('/* fee_schedules */').trim()).toBe('');
  });
});

/**
 * The population's own defence.
 *
 * The DIRECTORY lists above are the last hand lists in this gate's derivation,
 * and hand lists fail silently. So: sweep the whole of `src/` for paths NAMING
 * this domain and require each to be in the population or in a counted
 * exclusion. A bag directory nobody has invented yet brings its modules under
 * these walls with no edit here.
 *
 * The exclusion set is EMPTY, and it is empty because it was MEASURED rather
 * than guessed. A guessed exemption excuses what can never match.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  const NOT_THIS_DOMAIN = [] as const;

  it('every price-alert-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: DOMAIN_NAME_PATTERN,
      notThisDomain: NOT_THIS_DOMAIN,
      expectedExclusions: 0,
      // Below today's count so a routine deletion does not fail the build, and
      // far enough above zero that a traversal which reached nothing does.
      sweepFloor: 15,
      plantIn: 'lib',
      plantName: 'price-alerts-cache.ts',
    });
  });

  it('the relative population really is the one the walls scan', () => {
    // Two spellings of one population can disagree, so this pins them together:
    // every absolute path the detectors run over has a relative twin here.
    expect(enumerateDomain().map((absolute) => absolute.slice(SRC_ROOT.length + 1)).sort()).toEqual(
      domainRelativePaths().sort(),
    );
  });
});

describe('#668 — the shared-directory sweep can tell a directory from a file', () => {
  it('sees a module inside a SEEDED subdirectory of `routes`', () => {
    // The acceptance #668 asks for, and the only thing that separates a fixed
    // traversal from a tree that happens to be flat. `routes/admin/` holds 23
    // modules and `controllers/admin/` 19 today; neither holds one named for
    // this domain, which is exactly why a test over the real tree cannot tell.
    const seeded: DirectoryReader = (relative) =>
      relative === 'routes'
        ? [
            ...readSrcDirectory(relative),
            { name: 'admin', isDirectory: () => true, isFile: () => false },
          ]
        : relative === 'routes/admin'
          ? [{ name: 'price-alerts-admin.ts', isDirectory: () => false, isFile: () => true }]
          : readSrcDirectory(relative);
    const planted = `routes/admin/${'price-alerts-admin.ts'}`;
    expect(domainRelativePaths(seeded), 'the shared sweep does not recurse').toContain(planted);
    // …and the half that makes it non-circular: the seeded module is absent from
    // the real tree, so this measures the traversal rather than the tree.
    expect(
      domainRelativePaths(),
      'the seeded control exists on disk, so this proves nothing',
    ).not.toContain(planted);
  });

  it('and the remaining one-level `filesIn` lists only directories that are FLAT', () => {
    // The latent half, stated rather than left implicit (#668). `filesIn` still
    // reads one level, and every directory it is now called with has no
    // subdirectory — asserted here, so the day one appears this goes red instead
    // of quietly listing less.
    // ONE implementation, shared (#668). It was this loop inline over an inline
    // array with NO floor on the array — emptying it left all 26 tests in this
    // file green, which is the exact shape #460 exists to remove.
    assertDirectoriesAreFlat(['services/price-alerts', 'db/priceAlerts', 'services/ranking']);
  });
});
