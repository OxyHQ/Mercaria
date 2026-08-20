/**
 * The walls around the price-signal domain, as SCANS rather than conventions
 * (#82 statistical policy 10, §"Recommendations", acceptance 5 and 6).
 *
 * Seven directions, each with the two defences `~/Oxy/AGENTS.md` requires of a
 * gate: a VACUITY FLOOR (every scanned file must exist and be non-trivial, so a
 * moved or emptied file fails the gate instead of passing it by having nothing to
 * match) and a MUTATION SELF-TEST (each detector is run against a seeded positive
 * and a seeded negative, so a regex that rotted cannot pass by matching nothing).
 *
 * The reachability detectors scan COMMENT-STRIPPED source, because these modules
 * document what they refuse to do in exactly the vocabulary the detectors look
 * for. The FairCoin/OxyPay detector is the exception and scans RAW source, COPY
 * included: a hard-coded currency name in a comment or a string is how a
 * currency-generic domain acquires a favourite.
 *
 * ## The direction that matters most is the REVERSE one
 *
 * #82 acceptance 6: "price signals do not alter organic ranking except through
 * the separately defined, transparent policy in #74". #74 already forbids its own
 * modules reaching fees, referrals, plans and commissions; this extends that wall
 * to competitiveness, because a merchant's measured position is one join from
 * "merchants who price aggressively rank higher" — an undocumented ranking input
 * wearing the name of a dashboard metric.
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
  MERCHANT_COMPETITIVENESS_FORBIDDEN_FIELDS,
  PRICE_SIGNAL_FORBIDDEN_INPUTS,
  PRICE_SIGNAL_FORBIDDEN_RECOMMENDATIONS,
  PRICE_SIGNAL_INPUTS,
  PRICE_SIGNAL_RECOMMENDATION_KINDS,
} from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The domain's OWN directories, walked whole. */
const DOMAIN_DIRECTORIES = ['services/price-signals', 'db/priceSignals'];

/** The shared directories, where this domain sits beside every other domain's. */
const OUTER_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'];

/**
 * What a file BELONGING to this domain is called, wherever it lives.
 *
 * `merchant-competitiveness` is the second spelling: the merchant-facing half of
 * this domain is routed under its own name, so a pattern of only `price-signal`
 * would drop it — which is why the shape is a pattern the derivation self-test
 * pins rather than a bare substring somebody guessed.
 */
const DOMAIN_NAME_PATTERN = /price-?signals?|merchant-competitiveness/i;

/**
 * Read one scanned file, asserting it is a real file first.
 *
 * A DERIVED population is only as honest as the assertion that every member
 * resolves; a `readdirSync` served from a stale cache would otherwise hand every
 * scan below names that no longer exist, which reads as a clean run.
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
 * The domain directories were always walked; the six files in the SHARED
 * directories were pushed by name and are now selected by name PATTERN, so a
 * route or schema module added tomorrow is scanned the moment it exists (#460).
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
 * MEASURED: 12 under `services/price-signals`, 4 under `db/priceSignals`, 6 in
 * the shared directories. Per shape because one total lets a directory collapse
 * to nothing behind another's count.
 */
const MINIMUM_DOMAIN_DIRECTORY_FILES = 16;
const MINIMUM_OUTER_FILES = 6;

/** Every module of #74's ranking domain — the REVERSE direction. */
function enumerateRanking(): string[] {
  return filesIn('services/ranking');
}

const MINIMUM_RANKING_FILES = 10;

/** Strip comments, so a module that DESCRIBES what it refuses is not read as doing it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * A commercial term reaching a calculation — statistical policy 10.
 *
 * The `\.\./(fees|referrals|retail-pricing)/` alternatives are the specifiers a
 * module in `services/price-signals/` actually writes: each of those domains is
 * one `../` away, so the absolute-looking `services/fees/` form never sees the
 * import somebody here would type. One alternative per domain covers every
 * depth, because however many `../` segments precede it the last always abuts
 * the directory name.
 */
const COMMERCIAL_REFERENCE =
  /services\/fees\/|\.\.\/fees\/|services\/referrals\/|\.\.\/referrals\/|services\/retail-pricing\/|\.\.\/retail-pricing\/|db\/fees\/|db\/ledger|ledger_entries|ledgerRepository|feeSchedule|fee_schedules|commissionAmount|commissionRate|merchantPlan|planTier|affiliateEarnings|sponsoredPlacement/;

/** A FairCoin or OxyPay assumption, in code OR in copy. */
const FAIRCOIN_REFERENCE = /FairCoin|faircoin|OxyPay|oxy_pay|oxyPay|\bFAIR\b|⊜/;

/**
 * A catalogue WRITE — "do not automatically change merchant prices".
 *
 * The `catalog-write.service` import is the one that matters; the rest are the
 * spellings a later reader would reach for first.
 */
const CATALOG_WRITE_REFERENCE =
  /catalog-write\.service|updateListing\(|updateVariant\(|setVariantPrice|applyPriceChange|repriceOffer/;

/**
 * A BUYER-side measurement — a click, a conversion, an order, a session.
 *
 * This domain reads what SELLERS published and nothing about who bought. That is
 * why #77's suppress-below-ten posture has nothing here to apply to, and it is
 * why the `demand_without_native_offer` seam refuses rather than reaching for a
 * save count.
 */
const BUYER_MEASUREMENT_REFERENCE =
  /analytics_events|analyticsEvents|recordAnalyticsEvent|emitAnalyticsEvent|readTopQueries|product_save_aggregates|productSaveAggregates|db\/orders\/|orderRepository|conversionRate/;

/**
 * The ranking modules this domain may NOT import.
 *
 * The admission half — `eligibility.ts`, `facts.ts`, `money.ts` — is deliberately
 * permitted and is the whole point of the narrowing: eligibility is #74's single
 * authority over "may this offer appear", and a second spelling here would be
 * wrong for exactly as long as the two disagreed. What must stay unreachable is
 * the POLICY, the SCORE, the LABELS and the dominance detector — anything that
 * decides an ORDER. #74 narrowed #55's gate to one module for the same reason.
 */
const RANKING_SCORING_REFERENCE =
  /ranking\/policy(\.service)?\.js|ranking\/ranking\.js|ranking\/labels\.js|ranking\/dominance\.js|ranking\/comparison\.service\.js|rankOffers|rankOfferComparison|resolveRankingPolicy|BUILTIN_RANKING_POLICY/;

/** The price-signal domain, seen from anywhere else. */
const PRICE_SIGNAL_REFERENCE =
  /price-signals\/|priceSignals\/|price_signal_evaluations|priceSignalEvaluations|derivePriceSignals|readMerchantCompetitiveness|competitiveness/i;

/** Reading the RECORDING as though it were a serving cache. */
const EVALUATION_READ_REFERENCE =
  /listEvaluationsForSubject|priceSignalEvaluations|price_signal_evaluations/;

/**
 * The modules that are ALLOWED to touch a recorded evaluation, by name.
 *
 * The rule is "a read path must derive and never select a recorded verdict", and
 * it was previously stated as a list of the four read paths — an INCLUSION,
 * which covers the modules somebody remembered. Stated as an EXCLUSION it covers
 * the modules nobody has written yet: every module of the domain must not read
 * an evaluation EXCEPT the sweep that records them.
 *
 * Measured on this branch, that widens the scan from 4 files to 11 — the seven
 * it gains (`recommendations`, `sample`, `statistics`, `metrics.service`,
 * `feedback.service`, `seams`, `sweep-dispatcher`) were behind no wall at all,
 * and a new `services/price-signals/summary.service.ts` reading the recording
 * would have been invisible to the list.
 *
 * `db/priceSignals/priceSignalRunRepository.ts` is the OTHER legitimate reader
 * and is a repository rather than a read path; the exclusion is applied to the
 * service directory, so it is out of scope by construction rather than by name.
 */
const EVALUATION_READERS: readonly string[] = [];

/**
 * MEASURED: 12, the WHOLE service directory.
 *
 * The exclusion list is EMPTY, and that is a finding rather than an oversight.
 * `sweep.service.ts` was excused when this was written — it is the module that
 * records evaluations — and the stale-excuse test below failed on its first run,
 * because the sweep only ever calls `insertPriceSignalEvaluations`: its single
 * match on the read detector is a sentence in its header comment saying nothing
 * serves a shopper from that table, and the scan strips comments.
 *
 * So no module in this domain reads a recorded evaluation, and the wall covers
 * the directory with no exceptions. The mechanism is kept because an exclusion
 * that has to prove itself is what stops the next one being taken on trust.
 */
const MINIMUM_LIVE_READ_PATHS = 12;

/** Every module that must NOT read a recorded evaluation. */
function liveReadPaths(): string[] {
  return filesIn('services/price-signals').filter(
    (absolute) => !EVALUATION_READERS.includes(absolute.split('/').pop() ?? ''),
  );
}

describe('the price-signal domain cannot reach what it must not', () => {
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
      'services/price-signals + db/priceSignals shrank; a walk that lost a module scans clean',
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

  it('reads no fee, referral, retail-margin, ledger, plan or commission', () => {
    for (const file of files) {
      expect(
        COMMERCIAL_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches a commercial term; statistical policy 10 forbids one entering a signal`,
      ).toBe(false);
    }
  });

  it('names no FairCoin or OxyPay assumption, in code or in copy', () => {
    for (const file of files) {
      expect(
        FAIRCOIN_REFERENCE.test(readFileSync(file, 'utf8')),
        `${file} names FairCoin or OxyPay; a signal names the currency its CALLER asked for`,
      ).toBe(false);
    }
  });

  it('writes no catalogue price — a recommendation is informational', () => {
    for (const file of files) {
      expect(
        CATALOG_WRITE_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches a catalogue write; "do not automatically change merchant prices"`,
      ).toBe(false);
    }
  });

  it('reads no buyer-side measurement — no click, conversion, order or save', () => {
    for (const file of files) {
      expect(
        BUYER_MEASUREMENT_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reads buyer behaviour; this domain measures what SELLERS published`,
      ).toBe(false);
    }
  });

  it('reaches #74 only through the ADMISSION half, never the score', () => {
    for (const file of files) {
      expect(
        RANKING_SCORING_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches #74's scoring; only eligibility.ts, facts.ts and money.ts are permitted`,
      ).toBe(false);
    }
  });

  it('serves no read from the recorded evaluations — they are evidence, not a cache', () => {
    const paths = liveReadPaths();
    // A FLOOR, never `toBe(LIST.length)`: comparing a counter against the list
    // the loop just iterated is satisfied by any list including an empty one.
    expect(
      paths.length,
      'the price-signal service directory shrank; the recording could now be served as a cache',
    ).toBeGreaterThanOrEqual(MINIMUM_LIVE_READ_PATHS);
    for (const file of paths) {
      const source = readScanned(file);
      expect(source.length, `${file} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        EVALUATION_READ_REFERENCE.test(stripComments(source)),
        `${file} reads a recorded evaluation; a cached "good price" survives the ` +
          `moderation restriction that should have withdrawn it`,
      ).toBe(false);
    }
  });

  it('nothing is excused from the recorded-evaluation wall, and an excuse must earn itself', () => {
    // The wall covers the WHOLE service directory: the exclusion list is empty,
    // pinned here so that emptiness is a stated fact rather than a coincidence
    // somebody could quietly change.
    expect(
      EVALUATION_READERS,
      'a module was excused from the recorded-evaluation wall; it must justify itself below',
    ).toEqual([]);
    expect(liveReadPaths().length + EVALUATION_READERS.length).toBe(
      filesIn('services/price-signals').length,
    );

    // An exclusion list rots in the DANGEROUS direction: rename an excused file
    // and the excuse stops excusing anything, which is loud — but add a second
    // reader and the excused name silently covers a module nobody reviewed. So
    // whenever somebody adds one, it must still EXIST and must still match the
    // detector it is excused from. An excuse for a file that does not read an
    // evaluation is a hole with a comment over it, and it fails here.
    for (const name of EVALUATION_READERS) {
      const source = readScanned(join(SRC_ROOT, 'services/price-signals', name));
      expect(
        EVALUATION_READ_REFERENCE.test(stripComments(source)),
        `${name} is excused from the recorded-evaluation wall but does not read one — ` +
          'the excuse is stale and is now hiding a module nobody reviewed',
      ).toBe(true);
    }
  });

  it('the domain-name derivation selects the real files and not their neighbours', () => {
    const outer = OUTER_DIRECTORIES.flatMap((relative) =>
      filesIn(relative, DOMAIN_NAME_PATTERN),
    ).map((absolute) => absolute.slice(SRC_ROOT.length + 1));
    for (const expected of [
      'controllers/price-signals.controller.ts',
      'routes/price-signals.ts',
      'routes/merchant-competitiveness.ts',
      'routes/internal-price-signals.ts',
      'middleware/price-signal-schemas.ts',
      'db/schema/priceSignals.ts',
    ]) {
      expect(outer, `the derivation stopped selecting ${expected}`).toContain(expected);
    }
    // The merchant-facing half is routed under its OWN name — the case a bare
    // `price-signal` pattern silently drops.
    expect(DOMAIN_NAME_PATTERN.test('merchant-competitiveness.ts')).toBe(true);
    expect(DOMAIN_NAME_PATTERN.test('internal-price-signals.ts')).toBe(true);
    expect(DOMAIN_NAME_PATTERN.test('priceSignals.ts')).toBe(true);
    // …and must not drag in a sibling price domain.
    expect(DOMAIN_NAME_PATTERN.test('price-history.ts')).toBe(false);
    expect(DOMAIN_NAME_PATTERN.test('price-alerts.ts')).toBe(false);
  });
});

describe('a competitiveness score can never become a ranking input (acceptance 6)', () => {
  const rankingFiles = enumerateRanking();

  it('scans a ranking domain that has not silently shrunk', () => {
    expect(rankingFiles.length).toBeGreaterThanOrEqual(MINIMUM_RANKING_FILES);
    for (const file of rankingFiles) {
      expect(
        readFileSync(file, 'utf8').length,
        `${file} looks empty — did it move?`,
      ).toBeGreaterThan(200);
    }
  });

  it('no ranking module references the price-signal domain', () => {
    for (const file of rankingFiles) {
      expect(
        PRICE_SIGNAL_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} references price signals; a measured position is one join from ` +
          `"merchants who price aggressively rank higher"`,
      ).toBe(false);
    }
  });
});

describe('the prohibitions are stated as VALUES a test can walk', () => {
  it('the forbidden inputs are disjoint from the allowed ones, and neither is empty', () => {
    expect(PRICE_SIGNAL_INPUTS.length).toBeGreaterThanOrEqual(8);
    expect(PRICE_SIGNAL_FORBIDDEN_INPUTS.length).toBeGreaterThanOrEqual(8);
    const allowed = new Set<string>(PRICE_SIGNAL_INPUTS);
    for (const forbidden of PRICE_SIGNAL_FORBIDDEN_INPUTS) {
      expect(allowed.has(forbidden)).toBe(false);
    }
  });

  it('the forbidden recommendations are disjoint from the allowed ones', () => {
    expect(PRICE_SIGNAL_RECOMMENDATION_KINDS.length).toBeGreaterThanOrEqual(4);
    expect(PRICE_SIGNAL_FORBIDDEN_RECOMMENDATIONS.length).toBeGreaterThanOrEqual(4);
    const allowed = new Set<string>(PRICE_SIGNAL_RECOMMENDATION_KINDS);
    for (const forbidden of PRICE_SIGNAL_FORBIDDEN_RECOMMENDATIONS) {
      expect(allowed.has(forbidden)).toBe(false);
    }
  });

  it('the competitiveness DTO declares none of the forbidden fields', () => {
    const source = readFileSync(
      join(SRC_ROOT, '..', '..', 'shared-types', 'src', 'price-signals.ts'),
      'utf8',
    );
    expect(source.length).toBeGreaterThan(2_000);
    expect(MERCHANT_COMPETITIVENESS_FORBIDDEN_FIELDS.length).toBeGreaterThanOrEqual(12);
    for (const field of MERCHANT_COMPETITIVENESS_FORBIDDEN_FIELDS) {
      // The list itself is the one legitimate mention, so the check is on the
      // FIELD DECLARATION shape rather than on the bare name — otherwise the
      // prohibition would trip over stating itself.
      const declaration = new RegExp(`readonly\\s+${field}\\s*[?:]`);
      expect(declaration.test(source), `price-signals.ts declares \`${field}\``).toBe(false);
    }
  });

  it('the forbidden field list is disjoint from what the domain DOES emit', () => {
    // A vacuity floor on the list itself: a prohibition that accidentally named
    // an emitted field would fail every response walk instead of catching a leak.
    const emitted = ['kind', 'state', 'subject', 'sample', 'value', 'reason', 'offerId'];
    // #723: the loop below is its only reader, so emptying this list makes it a no-op and
    // nothing goes red. The floor is today's count: an addition passes it freely, while a
    // REMOVAL has to move this number in the same diff.
    expect(
      emitted.length,
      'emitted shrank without this floor moving — the assertion below now defends less than it did',
    ).toBeGreaterThanOrEqual(7);
    for (const field of emitted) {
      expect(MERCHANT_COMPETITIVENESS_FORBIDDEN_FIELDS).not.toContain(field);
    }
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('the commercial detector sees a fee import and not an innocent one', () => {
    // The relative specifier. This read `.toBe(false)` until #454 — the gate's
    // own self-test recording the hole as intended behaviour, which is what kept
    // it green. It is the spelling a module in `services/price-signals/` would
    // actually write, `services/fees` being one `../` away.
    expect(
      COMMERCIAL_REFERENCE.test("import { planFees } from '../fees/fee.service.js';"),
    ).toBe(true);
    expect(
      COMMERCIAL_REFERENCE.test("import { planFees } from '../../services/fees/fee.service.js';"),
    ).toBe(true);
    // The other two sibling domains, at the depths they would be written.
    expect(
      COMMERCIAL_REFERENCE.test("import { attribute } from '../referrals/attribution.js';"),
    ).toBe(true);
    expect(
      COMMERCIAL_REFERENCE.test("import { compose } from '../../retail-pricing/compose.js';"),
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('const commissionRate = 0.1;')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('const merchantPlan = readPlan();')).toBe(true);
    // The negative half: FX is NOT a commercial term, and a neighbour that
    // merely shares a prefix is not the fee domain.
    expect(COMMERCIAL_REFERENCE.test("import { getRates } from '../fx.service.js';")).toBe(false);
    expect(COMMERCIAL_REFERENCE.test("import { fmt } from '../fees-display/format.js';")).toBe(
      false,
    );
  });

  it('the FairCoin detector sees the code name, the symbol and the copy', () => {
    expect(FAIRCOIN_REFERENCE.test("const base: CurrencyCode = 'FAIR';")).toBe(true);
    expect(FAIRCOIN_REFERENCE.test('// FairCoin prices are labelled first')).toBe(true);
    expect(FAIRCOIN_REFERENCE.test('label: `⊜ 12.00`')).toBe(true);
    expect(FAIRCOIN_REFERENCE.test("const base: CurrencyCode = 'EUR';")).toBe(false);
    // `FAIRLY` and `AFFAIR` are not the currency — a bare substring test would
    // fail the build on ordinary prose.
    expect(FAIRCOIN_REFERENCE.test('a fairly ordinary comparison')).toBe(false);
  });

  it('the catalogue-write detector sees a reprice and not the word price', () => {
    expect(
      CATALOG_WRITE_REFERENCE.test("import { updateListing } from '../catalog-write.service.js';"),
    ).toBe(true);
    expect(CATALOG_WRITE_REFERENCE.test('await setVariantPrice(variantId, 1000);')).toBe(true);
    expect(CATALOG_WRITE_REFERENCE.test('const itemPrice = entry.amount;')).toBe(false);
  });

  it('the buyer-measurement detector sees an analytics read and not a sample count', () => {
    expect(BUYER_MEASUREMENT_REFERENCE.test('await readTopQueries({ storeId });')).toBe(true);
    expect(BUYER_MEASUREMENT_REFERENCE.test('select * from analytics_events')).toBe(true);
    expect(BUYER_MEASUREMENT_REFERENCE.test('const observations = kept.length;')).toBe(false);
  });

  it('the ranking-scoring detector sees the score and PERMITS the admission half', () => {
    expect(
      RANKING_SCORING_REFERENCE.test("import { rankOffers } from '../ranking/ranking.js';"),
    ).toBe(true);
    expect(
      RANKING_SCORING_REFERENCE.test("import { resolveRankingPolicy } from '../ranking/policy.service.js';"),
    ).toBe(true);
    // The three permitted modules must NOT trip it, or the narrowing would be a
    // prohibition on the thing this domain is required to reuse.
    expect(
      RANKING_SCORING_REFERENCE.test("import { selectEligibleOffers } from '../ranking/eligibility.js';"),
    ).toBe(false);
    expect(
      RANKING_SCORING_REFERENCE.test("import { buildOfferRankingFacts } from '../ranking/facts.js';"),
    ).toBe(false);
    expect(
      RANKING_SCORING_REFERENCE.test("import { convertOfferMoney } from '../ranking/money.js';"),
    ).toBe(false);
  });

  it('the reverse detector sees a price-signal import from a ranking module', () => {
    expect(
      PRICE_SIGNAL_REFERENCE.test(
        "import { derivePriceSignals } from '../price-signals/signals.js';",
      ),
    ).toBe(true);
    expect(PRICE_SIGNAL_REFERENCE.test('const competitivenessBoost = 0.2;')).toBe(true);
    expect(PRICE_SIGNAL_REFERENCE.test("import { listOffers } from '../offers/offer.service.js';")).toBe(
      false,
    );
  });

  it('the evaluation-read detector sees a select and not a write', () => {
    expect(EVALUATION_READ_REFERENCE.test('await listEvaluationsForSubject(key, 10);')).toBe(true);
    expect(EVALUATION_READ_REFERENCE.test('select * from price_signal_evaluations')).toBe(true);
    expect(EVALUATION_READ_REFERENCE.test('const signals = derivePriceSignals(input);')).toBe(false);
  });

  it('the comment stripper does not hide a real reference on the same line', () => {
    // The stripper is itself load-bearing: if it removed too much, every scan
    // above would pass vacuously.
    const stripped = stripComments(
      "import { x } from '../../services/fees/y.js'; // a note",
    );
    expect(COMMERCIAL_REFERENCE.test(stripped)).toBe(true);
    expect(stripComments('/* services/fees/ */').trim()).toBe('');
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
 * The one price-signal-NAMED module that is not this domain's is excused EXACTLY, with
 * its reason — a directory-shaped exclusion would excuse everything in that
 * directory forever, including whatever is added there next.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  const NOT_THIS_DOMAIN = [
    {
      path: 'services/comparison/price-signal.ts',
      why: "#42's basket comparison reads a signal through this module; it is that domain's",
    },
  ] as const;

  it('every price-signal-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: DOMAIN_NAME_PATTERN,
      notThisDomain: NOT_THIS_DOMAIN,
      expectedExclusions: 1,
      // Below today's count so a routine deletion does not fail the build, and
      // far enough above zero that a traversal which reached nothing does.
      sweepFloor: 16,
      plantIn: 'lib',
      plantName: 'price-signals-cache.ts',
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
          ? [{ name: 'price-signals-admin.ts', isDirectory: () => false, isFile: () => true }]
          : readSrcDirectory(relative);
    const planted = `routes/admin/${'price-signals-admin.ts'}`;
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
    assertDirectoriesAreFlat(['services/price-signals', 'db/priceSignals', 'services/ranking']);
  });
});
