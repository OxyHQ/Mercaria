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
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every module of the retail eligibility domain, enumerated from disk. */
function domainFiles(): string[] {
  const service = join(SRC_ROOT, 'services', 'retail-eligibility');
  const repository = join(SRC_ROOT, 'db', 'retailEligibility');
  return [
    ...readdirSync(service)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(service, name)),
    ...readdirSync(repository)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(repository, name)),
    join(SRC_ROOT, 'db', 'schema', 'retailEligibility.ts'),
    join(SRC_ROOT, 'controllers', 'retail-eligibility-operator.controller.ts'),
    join(SRC_ROOT, 'middleware', 'retail-eligibility-schemas.ts'),
    join(SRC_ROOT, 'routes', 'internal-retail-eligibility.ts'),
  ];
}

/**
 * The organic discovery surface — the same list `fee-ranking-isolation.test.ts`
 * scans, and it is duplicated on purpose: a domain that adds a wall states the
 * wall's extent itself, so moving a ranking module fails BOTH gates rather than
 * silently leaving one of them scanning a file that no longer decides anything.
 */
const RANKING_PATHS = [
  'services/feed.service.ts',
  'services/search.service.ts',
  'services/catalog-hydration.service.ts',
  'controllers/feed.controller.ts',
  'controllers/listings.controller.ts',
  'routes/feed.ts',
  'routes/listings.ts',
  'db/catalog/listingRepository.ts',
];

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
    // The vacuity floor: the domain is thirteen modules and a broken traversal
    // that found none would otherwise pass this whole file.
    expect(scanned).toBeGreaterThanOrEqual(13);
  });
});

describe('organic ranking cannot read eligibility', () => {
  it('no feed, search or catalogue-read module references the eligibility domain', () => {
    let scanned = 0;
    for (const relative of RANKING_PATHS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        ELIGIBILITY_REFERENCE.test(stripComments(source)),
        `${relative} references the retail eligibility domain`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_PATHS.length);
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
    expect(scanned).toBeGreaterThanOrEqual(13);
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
    expect(scanned).toBeGreaterThanOrEqual(13);
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
