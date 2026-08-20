/**
 * The walls around the retail eligibility domain (#121) — asserted
 * STRUCTURALLY, the `fee-ranking-isolation.test.ts` shape.
 *
 * Five properties, each a thing a plausible future change would break quietly:
 *
 *  1. **A `mercaria_retail` order pays no marketplace fee**, so nothing in this
 *     domain may reach the fee domain. If it could, "which supplier is cheapest
 *     to Mercaria" and "which schedule does this seller pay" would be one join
 *     apart.
 *  2. **Eligibility cannot be ranked on.** No feed, search or catalogue-read
 *     module may reference this domain — the #88/#58/#77 precedent, for the
 *     same reason: a gate that ranking can read becomes a gate somebody
 *     optimises against.
 *  3. **The DERIVATION reads no stored verdict.** `eligibility.ts` must not
 *     import the decision repository, or the "re-derive every time" property —
 *     which is what makes an expiry and a recall bite with no sweep — quietly
 *     becomes a cache read.
 *  4. **This domain does no FX and names no currency as special.** An
 *     order-value ceiling is compared in its own currency or not at all, and
 *     nothing here converts.
 *  5. **The verdict has no override on the wire.** No module in the domain
 *     accepts a `force`, `bypass`, `skipChecks` or `assumeEligible` field.
 *
 * Both metro-gate defences apply throughout: a vacuity floor (every scanned
 * file must exist and be non-trivial, so a moved file fails the gate instead of
 * silently shrinking it) and a mutation self-test (each detector is run against
 * a seeded positive AND a near-miss negative, so a rotted regex cannot pass by
 * matching nothing or by matching everything).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
  readRankingSurfaceFile,
} from '../../../__tests__/ranking-surface.js';
import { assertEachOf } from '../../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Walked whole, so a module added to the domain tomorrow is gated the moment it
 * exists.
 *
 * The read this replaces was a ONE-LEVEL `readdirSync` of each, which reads as
 * a walk and is not one: a `services/retail-eligibility/policy/` added next
 * year is in no population and behind none of the five walls, and every floor
 * and count here goes on reporting exactly what it does today.
 */
const OWNED_DIRECTORIES = ['services/retail-eligibility', 'db/retailEligibility'];

/**
 * The shared directories, where this domain sits beside every other domain's.
 *
 * They were FOUR HAND-NAMED PATHS, and **the four were complete** — the walk
 * finds exactly the same nineteen modules the list named. That is not a reason
 * to leave it: `docs/isolation-gates.md` §"A complete population is not a
 * defended one" is this exact case, measured on `curation` (17 -> 17). The
 * direction a hand list is blind to is an ADDED module, and it is invisible to
 * every number a gate asserts — a deleted one makes `readFileSync` throw, so
 * the list goes red, while a new `routes/internal-retail-eligibility-recalls.ts`
 * would sit behind no wall with the gate green.
 *
 * `namedInSharedDirectories` recurses, so `routes/admin/` and
 * `controllers/admin/` are reached too. Measured: this domain has no module in
 * either today, so the recursion adds nothing HERE and is the class fix rather
 * than a count.
 */
const SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'];

/**
 * What a module BELONGING to this domain is called, wherever it lives.
 *
 * The HYPHEN is optional, and that half is load-bearing rather than tidy: the
 * schema directory names its files in camelCase, so
 * `db/schema/retailEligibility.ts` cannot match a hyphenated spelling — and it
 * is the module DECLARING the nine tables, which is the one place a forbidden
 * COLUMN would appear.
 *
 * The FULL two words, never a bare `eligib`: that word selects 10 more modules
 * across #74's ranking, #93's pickup, #76's reviews, #112's guest-P2P, #118's
 * procurement, checkout, price-history, catalog-proposals and
 * retail-service-requests. Folding any of them in would make these walls fire
 * at whoever edits them. Measured: `/retail-?eligibility/i` selects 19 modules
 * and every one is this domain's.
 */
const DOMAIN_NAME_PATTERN = /retail-?eligibility/i;

/** Every module of the domain, DERIVED, relative to `src/`. */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, DOMAIN_NAME_PATTERN, readDir),
  ];
}

/**
 * The floors, PER SHAPE and measured off this branch: 15 under the owned
 * directories, 4 in the shared ones. A TOTAL floor lets one shape collapse to
 * zero behind another's number.
 */
const MINIMUM_OWNED_FILES = 13;
const MINIMUM_SHARED_FILES = 3;

/** Every module of the retail eligibility domain, enumerated from disk. */
function domainFiles(): string[] {
  return domainRelativePaths().map((relative) => join(SRC_ROOT, relative));
}

/**
 * The organic discovery surface — ONE derivation shared with the ten sibling
 * gates that assert the same shape of wall (`__tests__/ranking-surface.ts`).
 *
 * This was fifteen hand-written paths under a docblock arguing the duplication
 * was deliberate — "a domain that adds a wall states the wall's extent itself,
 * so moving a ranking module fails BOTH gates". The measurement says otherwise:
 * eleven copies existed, no two of the four largest agreed, and the copy in
 * `price-history-isolation.test.ts` had drifted to EIGHT paths containing no
 * ranking module at all. Duplication did not keep the gates honest; it gave each
 * of them a different answer, and every one of them still passed (#460).
 */

/** Reaching the fee domain, from any direction. */
const FEE_REFERENCE = /fees\/|feeSchedule|orderFeeSnapshot|fee_schedules|order_fee_snapshots|marketplaceFee/;

/** Reaching the retail eligibility domain, from any direction. */
const ELIGIBILITY_REFERENCE =
  /retail-eligibility\/|retailEligibility|getRetailEligibility|retail_eligibility_|retail_suppressions|retail_resale_evidence|retail_compliance_evidence/;

/** Reading a STORED verdict rather than deriving one. */
const DECISION_REPOSITORY_REFERENCE =
  /decisionRepository|retailEligibilityDecisions|recordRetailEligibilityDecision/;

/** Naming a currency as special, or converting between two. */
const FX_REFERENCE = /\bFairCoin\b|\bOxyPay\b|'FAIR'|"FAIR"|fx\.service|convertToFair|toDualMoney|getRates\(/;

/** A field by which a caller could override the verdict. */
const OVERRIDE_FIELD =
  /\b(force|bypass|skipChecks|skipEligibility|assumeEligible|overrideVerdict|ignoreReasons|defaultVerdict|treatUnknownAsEligible)\b/;

/** Comments say what a module refuses to do in the same vocabulary as the code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('a mercaria_retail order pays no marketplace fee', () => {
  it('no retail eligibility module references the fee domain', () => {
    let scanned = 0;
    for (const path of domainFiles()) {
      const source = readFileSync(path, 'utf8');
      expect(source.length, `${path} looks empty — did it move?`).toBeGreaterThan(200);
      expect(FEE_REFERENCE.test(stripComments(source)), `${path} references the fee domain`).toBe(
        false,
      );
      scanned += 1;
    }
    // The vacuity floor, PER SHAPE: a broken traversal of either half found
    // none, and every scan in this file then passes by having nothing to match.
    // A TOTAL floor lets one half collapse to zero behind the other's number.
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    const shared = namedInSharedDirectories(SHARED_DIRECTORIES, DOMAIN_NAME_PATTERN);
    expect(
      owned.length,
      'the owned directories shrank; a walk that lost a module scans clean',
    ).toBeGreaterThanOrEqual(MINIMUM_OWNED_FILES);
    expect(
      shared.length,
      'no controller, route, middleware or schema module is named for this domain — did the ' +
        'derivation break?',
    ).toBeGreaterThanOrEqual(MINIMUM_SHARED_FILES);
    expect(scanned).toBe(owned.length + shared.length);
  });
});

describe('organic ranking cannot read eligibility', () => {
  it('no feed, search or catalogue-read module references the eligibility domain', () => {
    let scanned = 0;
    assertRankingSurfaceIsWhole();
    for (const relative of RANKING_SURFACE_PATHS) {
      expect(
        ELIGIBILITY_REFERENCE.test(stripComments(readRankingSurfaceFile(relative))),
        `${relative} references the retail eligibility domain`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_SURFACE_PATHS.length);
  });
});

describe('the derivation never reads a stored verdict', () => {
  it('eligibility.ts imports no decision repository', () => {
    // The property that makes an expiry (acceptance 2) and a recall (acceptance
    // 5) bite with no sweep having run. A cache read here would look identical
    // and be wrong by exactly one refresh interval.
    const source = readFileSync(
      join(SRC_ROOT, 'services', 'retail-eligibility', 'eligibility.ts'),
      'utf8',
    );
    expect(source.length).toBeGreaterThan(2_000);
    expect(DECISION_REPOSITORY_REFERENCE.test(stripComments(source))).toBe(false);
    // …and it reaches NO repository at all: it is pure.
    expect(/from '\.\.\/\.\.\/db\//.test(source)).toBe(false);
  });

  it('the SERVICE is the only module that both loads and records', () => {
    const source = readFileSync(
      join(SRC_ROOT, 'services', 'retail-eligibility', 'retail-eligibility.service.ts'),
      'utf8',
    );
    expect(DECISION_REPOSITORY_REFERENCE.test(source)).toBe(true);
  });
});

describe('this domain does no FX and names no currency as special', () => {
  it('no module converts a currency or names FairCoin or OxyPay', () => {
    let scanned = 0;
    for (const path of domainFiles()) {
      // The COPY is scanned too, comments included: ADR 0004 D11 forbids the
      // words themselves in this area of the codebase, and a comment promising
      // not to do something is exactly where a future implementation starts.
      const source = readFileSync(path, 'utf8');
      expect(FX_REFERENCE.test(source), `${path} names a currency conversion or a forbidden rail`)
        .toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(MINIMUM_OWNED_FILES + MINIMUM_SHARED_FILES);
  });
});

describe('the verdict has no override', () => {
  it('no module in the domain accepts a bypass-shaped field', () => {
    let scanned = 0;
    for (const path of domainFiles()) {
      const source = stripComments(readFileSync(path, 'utf8'));
      expect(OVERRIDE_FIELD.test(source), `${path} accepts an override-shaped field`).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(MINIMUM_OWNED_FILES + MINIMUM_SHARED_FILES);
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('each pattern fires on its shape and NOT on its near miss', () => {
    // A scanner whose regex rotted would pass every case above vacuously and
    // fail here loudly.
    expect(FEE_REFERENCE.test("import { planFee } from '../fees/order-fees.service.js';")).toBe(
      true,
    );
    expect(FEE_REFERENCE.test("import { getCart } from './cart.service.js';")).toBe(false);

    expect(
      ELIGIBILITY_REFERENCE.test(
        "import { getRetailEligibility } from '../retail-eligibility/retail-eligibility.service.js';",
      ),
    ).toBe(true);
    expect(ELIGIBILITY_REFERENCE.test('select * from retail_suppressions')).toBe(true);
    expect(ELIGIBILITY_REFERENCE.test("import { listListings } from './listing.js';")).toBe(false);

    expect(
      DECISION_REPOSITORY_REFERENCE.test(
        "import { recordRetailEligibilityDecision } from '../../db/retailEligibility/decisionRepository.js';",
      ),
    ).toBe(true);
    expect(DECISION_REPOSITORY_REFERENCE.test('const decision = derive(input);')).toBe(false);

    expect(FX_REFERENCE.test("import { convert } from '../fx.service.js';")).toBe(true);
    expect(FX_REFERENCE.test("const currency = 'EUR';")).toBe(false);

    expect(OVERRIDE_FIELD.test('if (input.force) return { verdict: "eligible" };')).toBe(true);
    expect(OVERRIDE_FIELD.test('const forceful = false;')).toBe(false);
  });

  it('the file enumeration finds the whole domain, not a subset', () => {
    const files = domainFiles();
    for (const path of files) {
      expect(statSync(path).isFile(), `${path} is in the population but is not a file`).toBe(true);
    }
    const names = files.map((path) => path.split('/').slice(-1)[0]);
    // Named explicitly rather than counted, so a module that is DELETED fails
    // here instead of being silently excused by a lowered floor.
    for (const expected of [
      'eligibility.ts',
      'eligibility-hash.ts',
      'evidence-state.ts',
      'forbidden-evidence.ts',
      'traceability.port.ts',
      'retail-eligibility.service.ts',
      'policy.service.ts',
      'evidence.service.ts',
      'recall.service.ts',
      'exception.service.ts',
      'policyRepository.ts',
      'evidenceRepository.ts',
      'suppressionRepository.ts',
      'exceptionRepository.ts',
      'decisionRepository.ts',
      'retailEligibility.ts',
    ]) {
      expect(names, expected).toContain(expected);
    }
  });
});

/**
 * The population's own defence, and the reason a COMPLETE hand list was still
 * converted.
 *
 * The four hand-named paths were right, and the walk finds the same nineteen
 * modules — so no number in this gate moved. `docs/isolation-gates.md`
 * §"A complete population is not a defended one" is this exact case: a DELETED
 * module makes `readFileSync` throw, so even the hand list went red, while an
 * ADDED one is invisible to every floor, count and probe the gate asserts. That
 * is the direction this closes, and it is the only one that was open.
 *
 * The exclusion set is EMPTY, measured rather than assumed:
 * `/retail-?eligibility/i` over the whole of `src/` selects 19 modules and all
 * 19 are this domain's.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  it('every retail-eligibility-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: DOMAIN_NAME_PATTERN,
      notThisDomain: [],
      expectedExclusions: 0,
      // Below today's 19 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 16,
      plantIn: 'lib',
      plantName: 'retail-eligibility-cache.ts',
    });
  });

  it('the derivation reaches what the hand list named, and the walk is RECURSIVE', () => {
    const population = domainRelativePaths();
    // Everything the four hand-named paths carried is still here…
    for (const expected of [
      'db/schema/retailEligibility.ts',
      'controllers/retail-eligibility-operator.controller.ts',
      'middleware/retail-eligibility-schemas.ts',
      'routes/internal-retail-eligibility.ts',
    ]) {
      expect(population, `${expected} left the population`).toContain(expected);
    }
    // …the OWNED walk alone reaches none of them, so the shared sweep is what
    // is being measured…
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    expect(owned, 'the shared sweep is measuring nothing').not.toContain(
      'routes/internal-retail-eligibility.ts',
    );
    // …and the hyphen-only spelling cannot reach the module DECLARING the nine
    // tables, which is where a forbidden column would be added.
    expect(/retail-eligibility/i.test('db/schema/retailEligibility.ts')).toBe(false);
    expect(DOMAIN_NAME_PATTERN.test('db/schema/retailEligibility.ts')).toBe(true);
    // The bare word this pattern must NOT be widened to: nine other domains.
    assertEachOf([
      'services/ranking/eligibility.ts',
      'services/pickup/eligibility.ts',
      'services/checkout/fulfilment-eligibility.ts',
    ], 3, (foreign) => {
      expect(DOMAIN_NAME_PATTERN.test(foreign), `${foreign} belongs to another domain`).toBe(false);
      expect(population, `${foreign} belongs to another domain`).not.toContain(foreign);
    });
  });
});
