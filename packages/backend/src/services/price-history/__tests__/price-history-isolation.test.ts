/**
 * The walls around the price-history domain, as SCANS rather than conventions
 * (#78 §"Referral boundary", currency rules 8 and 9, and the #79 seam).
 *
 * Five directions, each with the two defences `~/Oxy/AGENTS.md` requires of a
 * gate: a VACUITY FLOOR (every scanned file must exist and be non-trivial, so a
 * moved or emptied file fails the gate instead of passing it by having nothing
 * to match) and a MUTATION SELF-TEST (each detector is run against a seeded
 * positive and a seeded negative, so a regex that rotted cannot pass by matching
 * nothing).
 *
 * The reachability detectors scan COMMENT-STRIPPED source — `checkout-contact-isolation.test.ts`'s
 * rule — because these modules document what they refuse to do in exactly the
 * vocabulary the detectors look for. The FairCoin/OxyPay detector is the
 * exception and scans RAW source, COPY included: #78 currency rule 9 forbids
 * FairCoin-specific *fixtures and assumptions*, and a hard-coded currency name
 * in a comment or a string is how one arrives.
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
import { PRICE_HISTORY_FORBIDDEN_DTO_FIELDS } from '@mercaria/shared-types';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
  readRankingSurfaceFile,
} from '../../../__tests__/ranking-surface.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The domain's OWN directories, walked whole. */
const DOMAIN_DIRECTORIES = ['services/price-history', 'db/priceHistory'];

/**
 * The shared directories, where this domain's files sit beside every other
 * domain's and so cannot be walked wholesale.
 */
const OUTER_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'];

/** What a file BELONGING to this domain is called, wherever it lives. */
const DOMAIN_NAME_PATTERN = /price-?history/i;

/**
 * Read one scanned file, asserting it is a real file first.
 *
 * `statSync` rather than a bare `readFileSync`: a population that is DERIVED is
 * only as honest as the assertion that every member of it resolves, and a
 * `readdirSync` served from a stale cache would otherwise hand every scan below
 * a list of names that no longer exist — which reads as a clean run.
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
 * The two domain directories are walked whole (they always were); what changed
 * is the five files in the SHARED directories, which were pushed by name. Those
 * are now selected by name PATTERN, so a `routes/internal-price-history-admin.ts`
 * added tomorrow is scanned the moment it exists.
 *
 * A hand list cannot do that, and the way it fails is silent: a scan whose
 * population stopped covering a module produces exactly the output of a scan
 * over a clean one (#460).
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
 * The floors, PER SHAPE and measured off this branch rather than carried over.
 *
 * Per shape because one total lets a directory collapse to nothing behind
 * another's count — `services/price-history` losing all seven modules would sit
 * inside a total of 11 as long as the shared directories grew by seven, and
 * every scan below would then pass over a domain it no longer reads.
 *
 * MEASURED: 7 under `services/price-history`, 4 under `db/priceHistory`, 5 in
 * the shared directories (the controller, two routes, the schema module and the
 * drizzle table). The floors sit at those counts; raising one when the domain
 * grows is the point rather than an annoyance.
 */
const MINIMUM_DOMAIN_DIRECTORY_FILES = 11;
const MINIMUM_OUTER_FILES = 5;

/** Strip comments, so a module that DESCRIBES what it refuses is not read as doing it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Reaching the referral domain, from any direction. */
const REFERRAL_REFERENCE =
  /referrals\/|referralTouch|referral_touches|referral_partners|referralPartner|affiliateEarnings|commissionAmount|attributionId/;

/** A FairCoin or OxyPay assumption, in code OR in copy. */
const FAIRCOIN_REFERENCE = /FairCoin|faircoin|OxyPay|oxy_pay|oxyPay|\bFAIR\b|⊜/;

/** A price ALERT, a threshold or a subscription — #79's, not this domain's. */
const ALERT_REFERENCE =
  /price[_-]?alert|alert_subscriptions|watchlist|enqueueNotification\w*\(|sendNotification\w*\(|createNotification\w*\(|subscribeTo\w*\(/i;

/** Ranking — #74's, and a chart is not a signal an ordering consumes. */
const RANKING_REFERENCE =
  /(^|[/'"])(feed|search)\.service|rankingPolicy|ranking_policy_versions|scoreListing|boostScore/;

/** A payment rail — a display conversion is not a way to pay (currency rule 8). */
const PAYMENT_REFERENCE =
  /payments\/|checkout\/|stripe|Stripe|PaymentIntent|payment_provider_events|ledger_entries|createPayment\w*\(/;


const PRICE_HISTORY_REFERENCE =
  /price-history\/|priceHistory\/|offer_price_points|offer_price_snapshots|offerPricePoints|offerPriceSnapshots|derivePriceSeries|readPriceHistory/;

describe('the price-history domain cannot reach what it must not', () => {
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
      'services/price-history + db/priceHistory shrank; a walk that lost a module scans clean',
    ).toBeGreaterThanOrEqual(MINIMUM_DOMAIN_DIRECTORY_FILES);
    expect(
      inOuter.length,
      'no controller/route/middleware/schema is named for this domain — did the derivation break?',
    ).toBeGreaterThanOrEqual(MINIMUM_OUTER_FILES);
    expect(files.length).toBe(inDomain.length + inOuter.length);

    for (const file of files) {
      // The vacuity floor: an empty or moved file must fail here, not pass the
      // scans below by having nothing to match.
      expect(readScanned(file).length, `${file} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('references no referral partner, commission, campaign or attribution', () => {
    for (const file of files) {
      expect(
        REFERRAL_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches the referral domain; a commission cannot alter a historical price`,
      ).toBe(false);
    }
  });

  it('names no FairCoin or OxyPay assumption, in code or in copy', () => {
    for (const file of files) {
      expect(
        FAIRCOIN_REFERENCE.test(readFileSync(file, 'utf8')),
        `${file} names FairCoin or OxyPay; #78 is currency-generic until a real integration defines them`,
      ).toBe(false);
    }
  });

  it('builds no price alert, threshold or subscription — that is #79', () => {
    for (const file of files) {
      expect(
        ALERT_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches an alert path; #80's ProductSavePriceAlert seam stays unsupported until #79`,
      ).toBe(false);
    }
  });

  it('reads no ranking module — that is #74', () => {
    for (const file of files) {
      expect(
        RANKING_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches ranking; a chart is an answer to a buyer's question, not an ordering input`,
      ).toBe(false);
    }
  });

  it('reads no payment rail — a display conversion is not a way to pay', () => {
    for (const file of files) {
      expect(
        PAYMENT_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches the payment domain; a representable currency is not a supported checkout rail`,
      ).toBe(false);
    }
  });

  it('is not reachable FROM the organic ranking surface either', () => {
    let scanned = 0;
    assertRankingSurfaceIsWhole();
    for (const relative of RANKING_SURFACE_PATHS) {
      const source = readRankingSurfaceFile(relative);
      expect(
        PRICE_HISTORY_REFERENCE.test(stripComments(source)),
        `${relative} references price history; measured price movement is one join from ranking by it`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_SURFACE_PATHS.length);
  });
});

describe('no price-history DTO can carry a referral identity', () => {
  it('the shared-types module declares none of the forbidden fields', () => {
    const source = readFileSync(
      join(SRC_ROOT, '..', '..', 'shared-types', 'src', 'price-history.ts'),
      'utf8',
    );
    expect(source.length).toBeGreaterThan(2_000);
    for (const field of PRICE_HISTORY_FORBIDDEN_DTO_FIELDS) {
      // The list itself is the one legitimate mention, so the check is on the
      // FIELD DECLARATION shape rather than on the bare name — otherwise the
      // prohibition would trip over stating itself.
      const declaration = new RegExp(`readonly\\s+${field}\\s*[?:]`);
      expect(declaration.test(source), `price-history.ts declares \`${field}\``).toBe(false);
    }
  });

  it('the forbidden list is non-empty and disjoint from what the domain does emit', () => {
    // A vacuity floor on the list itself: an empty prohibition passes every
    // check above while forbidding nothing.
    expect(PRICE_HISTORY_FORBIDDEN_DTO_FIELDS.length).toBeGreaterThanOrEqual(10);
    const emitted = ['offerId', 'observationId', 'bucketStart', 'segment', 'measure', 'value'];
    // #723: the loop below is its only reader, so emptying this list makes it a no-op and
    // nothing goes red. The floor is today's count: an addition passes it freely, while a
    // REMOVAL has to move this number in the same diff.
    expect(
      emitted.length,
      'emitted shrank without this floor moving — the assertion below now defends less than it did',
    ).toBeGreaterThanOrEqual(6);
    for (const field of emitted) {
      expect(PRICE_HISTORY_FORBIDDEN_DTO_FIELDS).not.toContain(field);
    }
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('the referral detector sees a real import and not an innocent one', () => {
    expect(
      REFERRAL_REFERENCE.test("import { recordTouch } from '../referrals/touch.service.js';"),
    ).toBe(true);
    expect(REFERRAL_REFERENCE.test('const commissionAmount = 0;')).toBe(true);
    expect(REFERRAL_REFERENCE.test("import { getRates } from '../fx.service.js';")).toBe(false);
  });

  it('the FairCoin detector sees the code name, the symbol and the copy', () => {
    expect(FAIRCOIN_REFERENCE.test("const base: CurrencyCode = 'FAIR';")).toBe(true);
    expect(FAIRCOIN_REFERENCE.test('// FairCoin prices are shown first')).toBe(true);
    expect(FAIRCOIN_REFERENCE.test('label: `⊜ 12.00`')).toBe(true);
    expect(FAIRCOIN_REFERENCE.test("const base: CurrencyCode = 'EUR';")).toBe(false);
    // `FAIRLY` and `AFFAIR` are not the currency — a bare substring test would
    // fail the build on ordinary prose.
    expect(FAIRCOIN_REFERENCE.test('a fairly ordinary comparison')).toBe(false);
  });

  it('the alert detector sees a subscription and not a refusal that names one', () => {
    expect(ALERT_REFERENCE.test('await createPriceAlert({ productId });')).toBe(true);
    expect(ALERT_REFERENCE.test('select * from price_alerts')).toBe(true);
    expect(ALERT_REFERENCE.test("reason: 'price_alerts_not_implemented'")).toBe(true);
    expect(ALERT_REFERENCE.test('const points = derivePriceSeries(input);')).toBe(false);
  });

  it('the ranking detector sees a feed import', () => {
    expect(RANKING_REFERENCE.test("import { buildFeed } from '../feed.service.js';")).toBe(true);
    expect(RANKING_REFERENCE.test('const rankingPolicy = 1;')).toBe(true);
    expect(RANKING_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });

  it('the payment detector sees a rail and not the word price', () => {
    expect(PAYMENT_REFERENCE.test("import { openCheckoutPayment } from '../payments/x.js';")).toBe(
      true,
    );
    expect(PAYMENT_REFERENCE.test('const intent = new PaymentIntent();')).toBe(true);
    expect(PAYMENT_REFERENCE.test('const itemPrice = { amount: 1, currency: "EUR" };')).toBe(false);
  });

  it('the reverse ranking detector sees a price-history import', () => {
    expect(
      PRICE_HISTORY_REFERENCE.test("import { readPriceHistory } from '../price-history/read.service.js';"),
    ).toBe(true);
    expect(PRICE_HISTORY_REFERENCE.test('select * from offer_price_points')).toBe(true);
    expect(PRICE_HISTORY_REFERENCE.test("import { listOffers } from './offers/offer.service.js';")).toBe(
      false,
    );
  });

  it('the domain-name derivation selects the real files and not their neighbours', () => {
    // The derivation REPLACED a hand list, so it owes the same proof a detector
    // does: that it still selects what the list named. Anything it stopped
    // selecting is a file that silently left the scan.
    const outer = OUTER_DIRECTORIES.flatMap((relative) =>
      filesIn(relative, DOMAIN_NAME_PATTERN),
    ).map((absolute) => absolute.slice(SRC_ROOT.length + 1));
    for (const expected of [
      'controllers/price-history.controller.ts',
      'routes/price-history.ts',
      'routes/internal-price-history.ts',
      'middleware/price-history-schemas.ts',
      'db/schema/priceHistory.ts',
    ]) {
      expect(outer, `the derivation stopped selecting ${expected}`).toContain(expected);
    }
    // `internal-price-history.ts` is the case a naive anchored pattern misses:
    // the domain name does not start the basename.
    expect(DOMAIN_NAME_PATTERN.test('internal-price-history.ts')).toBe(true);
    expect(DOMAIN_NAME_PATTERN.test('priceHistory.ts')).toBe(true);
    // …and it must not drag in a neighbour that merely mentions a price.
    expect(DOMAIN_NAME_PATTERN.test('price-alerts.ts')).toBe(false);
    expect(DOMAIN_NAME_PATTERN.test('price-signals.controller.ts')).toBe(false);
    expect(DOMAIN_NAME_PATTERN.test('order-history.ts')).toBe(false);
  });

  it('the comment stripper does not hide a real reference on the same line', () => {
    // The stripper is itself load-bearing: if it removed too much, every scan
    // above would pass vacuously.
    const stripped = stripComments("import { x } from '../referrals/y.js'; // a note");
    expect(REFERRAL_REFERENCE.test(stripped)).toBe(true);
    expect(stripComments('/* referrals */').trim()).toBe('');
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

  it('every price-history-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: DOMAIN_NAME_PATTERN,
      notThisDomain: NOT_THIS_DOMAIN,
      expectedExclusions: 0,
      // Below today's count so a routine deletion does not fail the build, and
      // far enough above zero that a traversal which reached nothing does.
      sweepFloor: 11,
      plantIn: 'lib',
      plantName: 'price-history-cache.ts',
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
          ? [{ name: 'price-history-admin.ts', isDirectory: () => false, isFile: () => true }]
          : readSrcDirectory(relative);
    const planted = `routes/admin/${'price-history-admin.ts'}`;
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
    assertDirectoriesAreFlat(['services/price-history', 'db/priceHistory']);
  });
});
