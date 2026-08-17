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

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Directories walked whole. */
const SCANNED_DIRECTORIES = ['services/search', 'db/search'];

/** The shared directories, where this domain sits beside every other domain's. */
const OUTER_DIRECTORIES = ['controllers', 'routes', 'middleware'];

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
const NOT_THIS_DOMAIN_PATTERN = /search-intent/i;

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
function outerPaths(): string[] {
  return OUTER_DIRECTORIES.flatMap((directory) =>
    readdirSync(join(SRC_ROOT, directory))
      .filter((entry) => entry.endsWith('.ts'))
      .filter((entry) => DOMAIN_NAME_PATTERN.test(entry) && !NOT_THIS_DOMAIN_PATTERN.test(entry))
      .sort()
      .map((entry) => {
        const absolute = join(SRC_ROOT, directory, entry);
        expect(statSync(absolute).isFile(), `${absolute} is not a file — did it move?`).toBe(true);
        return absolute;
      }),
  );
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
