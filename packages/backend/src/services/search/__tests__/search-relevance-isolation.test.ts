/**
 * #70's ranking boundary, asserted STRUCTURALLY: organic entity relevance
 * cannot read a commercial payment.
 *
 * The issue lists seven signals that may never influence relevance — affiliate
 * commission, marketplace fee, referral reward, merchant Pro plan, FAIR
 * acceptance, Mercaria-retail cost variance, sponsored payment — and a
 * behavioural fixture cannot prove their absence: it can only show that today's
 * code does not USE one. A module that cannot REACH the data cannot rank by it,
 * which is the stronger statement, and it is the one `fee-ranking-isolation.ts`
 * established for the listing feed. This is that gate widened to all seven and
 * pointed at the canonical search path.
 *
 * ## It scans DIRECTORIES, so it covers modules nobody has written yet
 *
 * `services/search/` and `db/search/` are walked whole (the
 * `ingestion-isolation.test.ts` device), plus the controller and route that
 * serve them. A file added to the domain tomorrow is gated the moment it exists
 * — where a fixed list would silently stop covering the domain the first time
 * somebody split a module.
 *
 * ## Comments are STRIPPED before scanning
 *
 * Every module here documents what it refuses to do, in the same vocabulary the
 * detectors look for — "nothing in this module reads a fee, a commission, a
 * referral" is a sentence that would trip its own gate. The
 * `checkout-contact-isolation.test.ts` precedent: strip comments, scan code.
 *
 * ## The defences that make a green run mean something
 *
 * - A **vacuity floor** on the number of files scanned AND on each file's size,
 *   so a moved module or a broken walk fails loudly instead of passing by
 *   matching nothing.
 * - A **mutation self-test** per detector: each pattern is run against a seeded
 *   positive and a seeded negative, so a regex that rotted cannot pass the scan
 *   above by never matching anything.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEARCH_FORBIDDEN_RELEVANCE_SIGNALS,
  SEARCH_RELEVANCE_SIGNALS,
} from '@mercaria/shared-types';
import { RANKING_SURFACE_PATHS } from '../../../__tests__/ranking-surface.js';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  sweepSrcTreeForDomain,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Directories walked whole. */
const SCANNED_DIRECTORIES = ['services/search', 'db/search'];

/**
 * The shared directories, where this domain sits beside every other domain's.
 *
 * `db/schema` was missing, inherited from the three-name list copied from gate
 * to gate. #70 owns no table today, so it adds no module HERE — stated because
 * the alternative is a PR body that implies it found one — and it is added so
 * that a `db/schema/search.ts` written tomorrow is behind these seven detectors
 * the moment it exists rather than whenever somebody remembers this file.
 *
 * The sweep is also RECURSIVE now and matches the PATH rather than the
 * FILENAME. Both were live defects elsewhere (`routes/admin/` holds 23 modules
 * and a one-level `isFile()` sweep reaches none of them); measured here, this
 * domain has no module under `routes/admin/` or `controllers/admin/` today, so
 * the recursion is the class fix rather than a count. Matching the path is free
 * for these four directories because none of them carries a domain token.
 */
const OUTER_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'];

/**
 * What a file BELONGING to this domain is called — and what it is NOT.
 *
 * The exclusion is load-bearing. `search-intent` is a DIFFERENT domain with its
 * own gate (`search-intent-isolation.test.ts`) and its five files all contain
 * the substring `search`; folding them in here would make this wall fire at
 * whoever edits #95, and a gate that cries wolf is the one somebody deletes.
 *
 * MEASURED: the hand list this replaces named four files and MISSED
 * `middleware/search-schemas.ts` — the module that validates every parameter
 * reaching canonical retrieval, and therefore the natural place for a filter
 * keyed on a commercial signal to be accepted. It sat behind no wall, and
 * nothing failed, because a scan whose population never included a file reports
 * exactly what a clean one does (#460).
 */
const DOMAIN_NAME_PATTERN = /search/i;

/**
 * …and what it is NOT — with the HYPHEN now OPTIONAL, which is load-bearing.
 *
 * #95 spells itself three ways: `services/search-intent/`, `db/searchIntent/`
 * and `db/schema/searchIntent.ts`. The hyphen-only spelling excluded the first
 * and NEITHER of the other two. That cost nothing while this sweep matched
 * FILENAMES inside three directories #95's camelCase modules do not live in —
 * and costs exactly three modules the moment the sweep matches PATHS and
 * `db/schema` joins the list above. Measured: without `-?`,
 * `db/schema/searchIntent.ts`, `db/searchIntent/benchmarkRepository.ts` and
 * `db/searchIntent/searchIntentRepository.ts` are reported as #70 modules
 * sitting outside its population, and the whole-tree assertion below goes red
 * naming three files belonging to a domain this gate must not police.
 *
 * This is `search-intent-isolation.test.ts`'s own `/search-?intent/i` pointed
 * the other way. Widening an EXCLUSION is the restrictive direction and still
 * owes a measurement: `/search-?intent/i` over the whole of `src/` selects 25
 * modules and every one of them is #95's.
 */
const NOT_THIS_DOMAIN_PATTERN = /search-?intent/i;

/**
 * The pair above as ONE regex, because `assertNothingOutsideDomainPopulation`
 * takes a single pattern.
 *
 * Two spellings of one question can disagree, and the disagreement would be
 * silent — so `the composed sweep pattern agrees with the pair` below runs BOTH
 * over every module in `src/` and requires the same verdict on every path. The
 * PAIR stays the authority a reader edits; this cannot drift away from it
 * without failing the build.
 */
const DOMAIN_SWEEP_PATTERN = /search(?!-?intent)/i;

/**
 * This gate is the FORWARD wall over #70's domain, and is deliberately NOT the
 * shared discovery surface.
 *
 * A census flagged the four-entry list this derivation replaced because all four
 * entries also appear in `__tests__/ranking-surface.ts`, which derives to 42
 * modules — the shape three real copies of that surface took under three
 * different names. It is worth stating why this one is not a fourth, because the
 * overlap is genuine and the next census will flag it again.
 *
 * The two walls run in opposite directions. `RANKING_SURFACE_PATHS` is the
 * REVERSE population: every gate that uses it asks "does the discovery surface
 * reference MY domain", and each carries a test named for exactly that. This
 * file has no such test. It asks the FORWARD question — "can #70's own modules
 * reach a commercial payment" — so its population is #70's domain: two
 * directories walked whole plus the HTTP surface serving them, which is the same
 * shape `price-history` and `price-alerts` use for their own outer files and
 * which nobody calls a ranking copy.
 *
 * MEASURED, and this is what settles it rather than the reasoning above:
 * substituting the shared surface would scan 42 modules, of which 13 are
 * search-domain, and would DROP `middleware/search-schemas.ts` — the one file
 * this branch proved was a live hole (a `marketplaceFee` read there passed on
 * `origin/main`). A straight swap would reopen it while widening by 28 modules
 * other gates already own. Scanning all 42 with these seven detectors was also
 * measured and produces zero violations, so the swap would have been GREEN: the
 * decision cannot be made by running it.
 *
 * The one search module in the surface and not here is `services/search.service.ts`,
 * the legacy listing-first engine. That is not a gap — `fee-ranking-isolation.test.ts`
 * runs the same commercial prohibition over the whole surface, so it is covered
 * there. {@link SURFACE_RELATIONSHIP} asserts both halves so neither can drift
 * in silence.
 */
const SURFACE_RELATIONSHIP = {
  /** Covered HERE and by no surface-derived gate; a substitution would lose it. */
  onlyCoveredHere: 'middleware/search-schemas.ts',
  /** A search module covered by the SURFACE instead, deliberately not by this gate. */
  coveredBySurfaceInstead: 'services/search.service.ts',
} as const;

/**
 * The floors, PER SHAPE and measured off this branch.
 *
 * One TOTAL floor was the previous spelling, and a total lets one shape collapse
 * to zero behind another's number: `db/search` losing both repositories sits
 * comfortably inside a total of 10 as long as `services/search` still has nine,
 * and every detector below then runs over a domain missing its data layer.
 *
 * MEASURED: 7 under `services/search`, 2 under `db/search`, 5 in the shared
 * directories.
 */
const MINIMUM_DIRECTORY_FILES = 9;
const MINIMUM_OUTER_FILES = 5;

/** What reaching each prohibited signal looks like, from any direction. */
const FORBIDDEN_REFERENCES: readonly { signal: string; pattern: RegExp }[] = [
  {
    signal: 'affiliate_commission',
    pattern: /commission|affiliate_reports|affiliateReport|awin_transactions|awinTransaction/i,
  },
  {
    // `fees/` unanchored, matching `fee-ranking-isolation.test.ts`'s own
    // detector rather than a stricter respelling of it: a search module would
    // reach the fee domain by a RELATIVE import (`../fees/…`), which a pattern
    // anchored on `services/fees/` does not match — a hole this test found in
    // its own first draft.
    signal: 'marketplace_fee',
    pattern: /fees\/|feeSchedule|orderFeeSnapshot|fee_schedules|order_fee_snapshots|marketplaceFee/i,
  },
  {
    signal: 'referral_reward',
    pattern: /referrals\/|referral_|referralReward|referralAttribution/i,
  },
  {
    signal: 'merchant_pro_plan',
    pattern: /proPlan|pro_plan|merchantPlan|subscriptionTier|billingPlan/i,
  },
  { signal: 'fair_acceptance', pattern: /faircoin|oxypay|oxy_pay|acceptsFair/i },
  {
    signal: 'retail_cost_variance',
    pattern: /retail-pricing\/|retail_cost|retailCost|costVariance|retail_cost_variance|absorption_cap/i,
  },
  { signal: 'sponsored_payment', pattern: /sponsor|promotedPlacement|paidPlacement|adSlot/i },
];

/**
 * Strip block and line comments.
 *
 * Deliberately simple, and the simplification is safe in the direction that
 * matters: a string literal containing `//` would lose its tail, which can only
 * make the scan see LESS code and therefore only produce a false PASS on that
 * one line — never a false failure that somebody would disable the gate to
 * silence. No module in this domain contains such a literal, and the mutation
 * self-test below is what proves the detectors still fire on real code.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      // The domain's own tests name the prohibitions in order to test for them.
      if (entry === '__tests__') continue;
      files.push(...walk(full));
      continue;
    }
    if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

/**
 * The files serving this domain from the SHARED directories, DERIVED by name.
 *
 * `statSync` on every entry, so a `readdirSync` served from a stale cache cannot
 * hand the scan a list of names that no longer resolve — which would read as a
 * clean run.
 */
function outerRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  // RECURSIVE, and matching the PATH rather than the filename (#460).
  return namedInSharedDirectories(OUTER_DIRECTORIES, DOMAIN_NAME_PATTERN, readDir).filter(
    (relative) => !NOT_THIS_DOMAIN_PATTERN.test(relative),
  );
}

function outerPaths(): string[] {
  return outerRelativePaths().map((relative) => {
    const absolute = join(SRC_ROOT, relative);
    expect(statSync(absolute).isFile(), `${absolute} is not a file — did it move?`).toBe(true);
    return absolute;
  });
}

/** Every module of the domain, DERIVED, relative to `src/`. */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...SCANNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...outerRelativePaths(readDir),
  ];
}

function scannedPaths(): string[] {
  return [
    ...SCANNED_DIRECTORIES.flatMap((relative) => walk(join(SRC_ROOT, relative))),
    ...outerPaths(),
  ];
}

describe('canonical search cannot rank by a commercial payment', () => {
  it('no module on the search path references a prohibited signal', () => {
    // The vacuity floor for the gate itself, PER SHAPE: a walk that found
    // nothing produces zero violations, which is exactly what a healthy run
    // also produces.
    const inDirectories = SCANNED_DIRECTORIES.flatMap((relative) =>
      walk(join(SRC_ROOT, relative)),
    );
    const inOuter = outerPaths();
    expect(
      inDirectories.length,
      'services/search + db/search shrank; a walk that lost a module scans clean',
    ).toBeGreaterThanOrEqual(MINIMUM_DIRECTORY_FILES);
    expect(
      inOuter.length,
      'no controller/route/middleware is named for this domain — did the derivation break?',
    ).toBeGreaterThanOrEqual(MINIMUM_OUTER_FILES);

    const paths = scannedPaths();
    expect(paths.length).toBe(inDirectories.length + inOuter.length);

    const violations: string[] = [];
    for (const path of paths) {
      const raw = readFileSync(path, 'utf8');
      expect(raw.length, `${path} looks empty — did it move?`).toBeGreaterThan(200);
      const source = stripComments(raw);
      for (const reference of FORBIDDEN_REFERENCES) {
        const match = reference.pattern.exec(source);
        if (match !== null) {
          violations.push(`${path} reaches ${reference.signal}: ${match[0]}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('every detector actually detects — the mutation self-test', () => {
    // Break the thing each detector guards, in miniature, and confirm it sees
    // it. A detector whose regex rotted would pass the scan above vacuously by
    // matching nothing, and only this test can tell that apart from a clean
    // domain.
    const positives: Readonly<Record<string, string>> = {
      affiliate_commission: "const rate = await readAffiliateReport(offer).commission;",
      marketplace_fee: "import { planConnectedMarketplaceFee } from '../fees/order-fees.service.js';",
      referral_reward: "const boost = referralReward(candidate);",
      merchant_pro_plan: "if (merchant.subscriptionTier === 'pro') score += 0.2;",
      fair_acceptance: "if (merchant.acceptsFair) score += 0.1;",
      retail_cost_variance: "import { readRetailCostQuote } from '../retail-pricing/quote.js';",
      sponsored_payment: "const bid = await readSponsoredBid(productId);",
    };
    const negative =
      "import { listOffersForComparison } from '../../db/offers/offerRepository.js';";

    for (const reference of FORBIDDEN_REFERENCES) {
      const seeded = positives[reference.signal];
      expect(seeded, `no positive fixture for ${reference.signal}`).toBeDefined();
      expect(
        reference.pattern.test(seeded ?? ''),
        `the ${reference.signal} detector no longer fires on a real reference`,
      ).toBe(true);
      expect(
        reference.pattern.test(negative),
        `the ${reference.signal} detector fires on an ordinary offer read`,
      ).toBe(false);
    }
  });

  it('the domain-name derivation selects this domain and not #95', () => {
    // A derivation that replaced a hand list owes the same proof a detector
    // does: that it still selects everything the list named, plus what the list
    // missed, and nothing belonging to the neighbour it must not police.
    const outer = outerPaths().map((absolute) => absolute.slice(SRC_ROOT.length + 1));
    for (const expected of [
      'controllers/search.controller.ts',
      'controllers/search-operator.controller.ts',
      'routes/search.ts',
      'routes/internal-search.ts',
    ]) {
      expect(outer, `the derivation stopped selecting ${expected}`).toContain(expected);
    }
    // The one the hand list MISSED: every retrieval parameter is validated here,
    // so it is where a filter keyed on a commercial signal would be accepted.
    expect(
      outer,
      'middleware/search-schemas.ts validates every parameter reaching canonical retrieval and ' +
        'was behind no wall while this list was hand-maintained',
    ).toContain('middleware/search-schemas.ts');

    // …and #95's five files stay out, or this wall fires at whoever edits them.
    for (const foreign of [
      'controllers/search-intent.controller.ts',
      'controllers/internal-search-intent.controller.ts',
      'routes/search-intent.ts',
      'routes/internal-search-intent.ts',
      'middleware/search-intent-schemas.ts',
    ]) {
      expect(outer, `${foreign} belongs to #95 and has its own gate`).not.toContain(foreign);
    }
    expect(NOT_THIS_DOMAIN_PATTERN.test('internal-search-intent.controller.ts')).toBe(true);
    expect(NOT_THIS_DOMAIN_PATTERN.test('search-operator.controller.ts')).toBe(false);

    // …and #95's THREE camelCase spellings, which the hyphen-only exclusion
    // could not reach. This is the half that makes `-?` a measurement rather
    // than a tidy-up: with the sweep matching PATHS and `db/schema` in the
    // directory list, the narrow spelling drags three of #95's modules into
    // #70's population, and every count in this file stays where it is.
    for (const foreign of [
      'db/schema/searchIntent.ts',
      'db/searchIntent/benchmarkRepository.ts',
      'db/searchIntent/searchIntentRepository.ts',
    ]) {
      expect(
        /search-intent/i.test(foreign),
        `${foreign} is excluded without the optional hyphen`,
      ).toBe(false);
      expect(NOT_THIS_DOMAIN_PATTERN.test(foreign), `${foreign} belongs to #95`).toBe(true);
      expect(outerRelativePaths(), `${foreign} belongs to #95 and has its own gate`).not.toContain(
        foreign,
      );
    }
  });

  it('is the FORWARD wall over #70, and its relation to the shared surface holds', () => {
    // Not an exact count: this population is DERIVED so that a search module
    // added tomorrow is covered the moment it exists, and an exact count would
    // fail the build on exactly that — making "bump the number" the cheapest
    // green, which is how a floor stops meaning anything. What is pinned instead
    // is the RELATION, in both directions, because that is what a silent drift
    // would move.
    const mine = new Set(scannedPaths().map((path) => path.slice(SRC_ROOT.length + 1)));
    const surface = new Set<string>(RANKING_SURFACE_PATHS);

    // Both populations must be real, or every assertion below is vacuous.
    expect(surface.size, 'the shared ranking surface derived nothing').toBeGreaterThanOrEqual(30);
    expect(mine.size, 'this gate scans almost nothing').toBeGreaterThanOrEqual(
      MINIMUM_DIRECTORY_FILES + MINIMUM_OUTER_FILES,
    );
    // They genuinely overlap — if they stopped, one of the two walls has moved
    // off #70's domain and this whole comparison is measuring nothing.
    const overlap = [...mine].filter((path) => surface.has(path));
    expect(overlap.length, 'this gate and the shared surface no longer overlap').toBeGreaterThan(5);

    // HALF ONE: the file only this gate covers. If the shared surface ever
    // absorbs it, a substitution becomes safe and this assertion says so.
    expect(
      mine.has(SURFACE_RELATIONSHIP.onlyCoveredHere),
      `${SURFACE_RELATIONSHIP.onlyCoveredHere} left this gate's population; it is the module that ` +
        'validates every parameter reaching canonical retrieval and no surface-derived gate ' +
        'covers it',
    ).toBe(true);
    expect(
      surface.has(SURFACE_RELATIONSHIP.onlyCoveredHere),
      `${SURFACE_RELATIONSHIP.onlyCoveredHere} is now in the shared surface too. Replacing this ` +
        "gate's population with RANKING_SURFACE_PATHS no longer drops it — re-decide, and update " +
        'SURFACE_RELATIONSHIP rather than deleting this assertion',
    ).toBe(false);

    // HALF TWO: the search module this gate deliberately does NOT cover, which
    // is only acceptable while the surface still does.
    expect(
      mine.has(SURFACE_RELATIONSHIP.coveredBySurfaceInstead),
      `${SURFACE_RELATIONSHIP.coveredBySurfaceInstead} is the legacy engine and is not #70's domain`,
    ).toBe(false);
    expect(
      surface.has(SURFACE_RELATIONSHIP.coveredBySurfaceInstead),
      `${SURFACE_RELATIONSHIP.coveredBySurfaceInstead} left the shared ranking surface, so the ` +
        'commercial prohibition over the legacy search engine is now enforced NOWHERE — either ' +
        'restore it there or bring it into this gate',
    ).toBe(true);
  });

  it('the comment stripper does not hide code from the scan', () => {
    // The stripper is the one component that could make every detector above
    // silently vacuous, so it gets its own positive control: a real reference
    // must survive stripping, and a documented refusal must not.
    expect(stripComments('const x = readCommission();')).toContain('readCommission');
    expect(stripComments('// nothing here reads a commission\nconst x = 1;')).not.toContain(
      'commission',
    );
    expect(stripComments('/** reads no fee_schedules */\nconst x = 1;')).not.toContain(
      'fee_schedules',
    );
  });

  it('the permitted and prohibited signal vocabularies are DISJOINT', () => {
    // The vocabulary half of the same wall: a signal cannot be both rankable and
    // forbidden, so a future addition that reads like a plausible ranking input
    // fails the build rather than being quietly admitted.
    const permitted = new Set<string>(SEARCH_RELEVANCE_SIGNALS);
    const overlap = SEARCH_FORBIDDEN_RELEVANCE_SIGNALS.filter((signal) =>
      permitted.has(signal as string),
    );
    expect(overlap, `signals in both tuples: ${overlap.join(', ')}`).toEqual([]);
    // And neither is empty, so the disjointness above is not vacuous.
    expect(SEARCH_RELEVANCE_SIGNALS.length).toBeGreaterThanOrEqual(9);
    expect(SEARCH_FORBIDDEN_RELEVANCE_SIGNALS.length).toBe(7);
  });
});

/**
 * The population's own defence, and the general form of the fixes above.
 *
 * Adding `db/schema`, recursing, matching the path and widening the exclusion
 * close today's gaps; this closes the CLASS. The DIRECTORY list is the last
 * hand list in this gate, and hand lists fail silently.
 *
 * Unlike the other gates in this batch the exclusion set here is NOT empty, and
 * every entry was measured against this gate's OWN seven detectors before being
 * written down: **all five are CLEAN**. So the exclusions are about OWNERSHIP,
 * not about a wall that would fire — which also means the decision cannot be
 * made by running the gate, exactly as {@link SURFACE_RELATIONSHIP} already says
 * about substituting the shared ranking surface.
 */
const NOT_THIS_DOMAIN = [
  {
    path: 'db/analytics/searchQueryRepository.ts',
    why:
      "#77's discovery-analytics domain: it stores redacted query text under that domain's " +
      'retention rules and is covered by the analytics gates. Measured clean against all seven ' +
      "of this gate's detectors.",
  },
  {
    path: 'services/analytics/search-instrumentation.ts',
    why:
      "#77's emitter seam for search events — the one module #70 is allowed to call INTO, rather " +
      'than a module of #70. Covered by the analytics gates; measured clean here.',
  },
  {
    path: 'db/catalogAuthoring/canonicalSearchRepository.ts',
    why:
      "The catalog-authoring domain, and inside `catalog-authoring-isolation.test.ts`'s own " +
      "walked population (confirmed by that gate's owner). Measured clean here.",
  },
  {
    path: 'services/catalog-authoring/canonical-search.service.ts',
    why:
      "The catalog-authoring domain, in that gate's walked population for the same reason. " +
      'Measured clean against all seven detectors here.',
  },
  {
    path: 'services/search.service.ts',
    why:
      'The LEGACY listing-first engine, not #70. It is covered by the shared ranking surface ' +
      'through `fee-ranking-isolation.test.ts`, and SURFACE_RELATIONSHIP.coveredBySurfaceInstead ' +
      'asserts it is still IN that surface — so this exclusion cannot become a hole without that ' +
      'assertion going red first.',
  },
] as const;

describe('#460: nothing named for this domain sits outside the scanned population', () => {
  it('the composed sweep pattern agrees with the pair on every module in src/', () => {
    // `assertNothingOutsideDomainPopulation` takes ONE pattern and this gate's
    // authority is a PAIR, so the two spellings are pinned together rather than
    // trusted. Without this, a lookahead that stopped meaning what the pair
    // means would widen or narrow the sweep in silence.
    const all = walkOwnedDirectory('', readSrcDirectory);
    expect(all.length, 'the whole-tree walk found almost nothing').toBeGreaterThanOrEqual(1_500);
    const disagreements = all.filter(
      (relative) =>
        DOMAIN_SWEEP_PATTERN.test(relative) !==
        (DOMAIN_NAME_PATTERN.test(relative) && !NOT_THIS_DOMAIN_PATTERN.test(relative)),
    );
    expect(disagreements, `the two spellings disagree on: ${disagreements.join(', ')}`).toEqual([]);

    // …and the comparison is not vacuous in either direction: both halves
    // select real, non-empty, DISJOINT sets.
    const mine = all.filter((relative) => DOMAIN_SWEEP_PATTERN.test(relative));
    const theirs = all.filter((relative) => NOT_THIS_DOMAIN_PATTERN.test(relative));
    expect(mine.length, 'the domain half selects nothing').toBeGreaterThanOrEqual(15);
    expect(theirs.length, 'the exclusion half excludes nothing').toBeGreaterThanOrEqual(20);
    expect(mine.filter((relative) => theirs.includes(relative))).toEqual([]);
  });

  it('every search-named module in src/ is inside the population or excused', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: DOMAIN_SWEEP_PATTERN,
      notThisDomain: NOT_THIS_DOMAIN,
      // Below today's 19 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 16,
      plantIn: 'lib',
      plantName: 'search-cache.ts',
    });
  });

  it('the relative population really is the one the detectors scan', () => {
    // Two spellings of one population can disagree, so this pins them together:
    // every absolute path the seven detectors run over has a relative twin here.
    expect(domainRelativePaths(readSrcDirectory).sort()).toEqual(
      scannedPaths()
        .map((path) => path.slice(SRC_ROOT.length + 1))
        .sort(),
    );
  });

  it('the exclusions are about OWNERSHIP, and each is measured clean here', () => {
    // The reason this set is not empty, stated as a check rather than a claim.
    // A module that TRIPPED one of these detectors would need a different
    // treatment — it would be a violation somebody has to answer for, not a
    // module of another domain — so the day one of them stops being clean this
    // fails, rather than the exclusion quietly hiding it.
    for (const entry of NOT_THIS_DOMAIN) {
      const source = stripComments(readFileSync(join(SRC_ROOT, entry.path), 'utf8'));
      const hits = FORBIDDEN_REFERENCES.filter((reference) => reference.pattern.test(source));
      expect(
        hits.map((reference) => reference.signal),
        `${entry.path} is excused from this gate AND trips one of its detectors — the exclusion ` +
          'is no longer merely about which domain owns the file',
      ).toEqual([]);
    }
    // The positive control for the loop above: the detectors DO fire on a real
    // reference, so an empty result cannot mean the scan read nothing.
    expect(
      FORBIDDEN_REFERENCES.some((reference) =>
        reference.pattern.test("import { planFee } from '../fees/order-fees.service.js';"),
      ),
    ).toBe(true);
  });

  it('the sweep pattern still selects the modules #70 legitimately owns', () => {
    // The other direction of the same question: a lookahead that had gone too
    // far would exclude #70's own modules and report a clean, empty result.
    for (const mine of [
      'services/search/relevance.ts',
      'middleware/search-schemas.ts',
      'routes/internal-search.ts',
    ]) {
      expect(
        DOMAIN_SWEEP_PATTERN.test(mine),
        `${mine} is #70's and the sweep no longer selects it`,
      ).toBe(true);
    }
    const population = domainRelativePaths();
    for (const mine of ['services/search/relevance.ts', 'middleware/search-schemas.ts']) {
      expect(population).toContain(mine);
    }
    expect(sweepSrcTreeForDomain(DOMAIN_SWEEP_PATTERN).length).toBeGreaterThanOrEqual(16);
  });
});
