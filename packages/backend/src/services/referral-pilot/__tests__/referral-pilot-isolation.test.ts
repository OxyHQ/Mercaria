/**
 * What the bounded referral pilot may NOT reach, and who may NOT reach it
 * (#149 acceptance 5, and the ranking/payment walls every referral domain
 * carries).
 *
 * Two directions, and the second is the one #149 actually turns on:
 *
 *  - **Outward:** the pilot decides how much of the programme runs. It never
 *    prices, ranks, moves money or reads a buyer, so it may not import the
 *    payment rail, the ledger, the reward accrual, the ranking domain or any
 *    forbidden identity signal.
 *  - **Inward:** `evaluateReferralPilotAdmission` has ONE caller. That is what
 *    makes "a stop pauses ENTRY and nothing else" a property of the CALL GRAPH
 *    rather than a rule in a handler — a reward, payout, vesting, enforcement
 *    or ranking module that started calling it could pause settlement, which
 *    acceptance 5 forbids by name.
 *
 * Every wall carries a MUTATION SELF-TEST: a probe containing exactly what the
 * pattern forbids, asserted to match. A wall whose pattern is wrong reports the
 * same clean zero as a wall with nothing to find.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';
import {
  REFERRAL_FORBIDDEN_IDENTITY_SIGNALS,
  REFERRAL_PILOT_ADMISSION_REFUSALS,
  REFERRAL_PILOT_STOP_METRICS,
  REFERRAL_PILOT_STOP_SCOPES,
} from '@mercaria/shared-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, '../../..');

/**
 * What a module of this domain is called, wherever it lives.
 *
 * The hyphen is optional because `db/referralPilot/` and
 * `db/schema/referralPilot.ts` are camelCase. Measured over the whole of
 * `src/`, this selects nine modules and every one is this domain's.
 */
const PILOT_NAME_PATTERN = /referral-?pilot/i;

/** The two directories this domain owns outright. */
const OWNED_DIRECTORIES = ['services/referral-pilot', 'db/referralPilot'] as const;

/** The flat directories a module of this domain lives in under a domain NAME. */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/**
 * Every module of the referral-pilot domain, as paths RELATIVE to `src/`.
 *
 * It was the two owned directories and nothing else (#460), which left THREE
 * modules behind none of the six walls: the operator controller — the surface
 * that RAISES a pilot stop — the request schemas, and
 * `db/schema/referralPilot.ts`, which is where the stop scopes, the metric CHECK
 * and the measurement shape are declared.
 */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, PILOT_NAME_PATTERN, readDir),
  ];
}

/** Every `.ts` under a directory, excluding `__tests__`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...sourceFiles(path));
      continue;
    }
    if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * Comment-stripped source.
 *
 * Load-bearing: every module here documents what it refuses to do in exactly
 * the vocabulary the detectors match, so a raw scan would flag the prose that
 * explains the rule.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const DOMAIN_FILES = domainRelativePaths().map((relative) => join(SRC_DIR, relative));

interface Wall {
  readonly name: string;
  readonly pattern: RegExp;
  /** A source that genuinely contains what the pattern forbids. */
  readonly probe: string;
}

const WALLS: readonly Wall[] = [
  {
    name: 'the payment rail, the ledger or a payout',
    // Both spellings: a sibling domain is one `../` away, so a detector
    // anchored on the absolute-looking form would miss the import somebody
    // would actually write (#125's finding, and #67 repeated it).
    pattern:
      /from\s+['"][^'"]*(services\/payments|\.\.\/payments\/|db\/payments|schema\/payments|schema\/ledger|referralEarnings|referral-payouts)[^'"]*['"]/,
    probe: "import { insertLedgerTransaction } from '../../db/payments/ledgerRepository.js';",
  },
  {
    name: 'the reward accrual, the reversal path or the reward repository',
    // The reward SCHEMA is exempt for one named file (see the exemption test
    // below): the report's realized-base figure is `referral_rewards`'
    // immutable `funding_amount_minor`, which #144's accrual recorded from the
    // ledger. Reading the row is not calling the accrual, and re-deriving the
    // base here would be a SECOND answer to what a partner was paid on.
    pattern:
      /from\s+['"][^'"]*(referrals\/rewards|\.\.\/rewards\/|db\/referrals\/rewardRepository|db\/referrals\/campaignBudgetRepository)[^'"]*['"]/,
    probe: "import { accrueRewardForConversion } from '../referrals/rewards/reward.service.js';",
  },
  {
    name: 'ranking, search, discovery or a feed',
    pattern: /from\s+['"][^'"]*(services\/ranking|\.\.\/ranking\/|services\/search|schema\/ranking)[^'"]*['"]/,
    probe: "import { rankOffers } from '../ranking/score.js';",
  },
  {
    name: 'the retail, procurement or supplier domains',
    pattern:
      /from\s+['"][^'"]*(retail-pilot|retail-pricing|retail-checkout|supplier-preflight|supplier-orders|schema\/procurement)[^'"]*['"]/,
    probe: "import { deriveRetailPilotAdmission } from '../retail-pilot/admission.js';",
  },
  {
    name: 'OxyPay or FairCoin',
    // Scanned on RAW source, copy included: a rail named in a comment is one a
    // later reader treats as planned.
    pattern: /\b(oxy[_\s-]?pay|oxypay|faircoin|FAIR_?COIN)\b/i,
    probe: 'const rail = "oxy_pay";',
  },
];

/**
 * The identity signals ADR 0005 A2 forbids, as a scan.
 *
 * #143 named fourteen and #148 extended them; a pilot BOUND is exactly the
 * shape somebody would reach for one in — "stop partners whose referred buyers
 * share a card" is a sentence that sounds like fraud control and is an identity
 * rule the ADR forbids.
 */
const IDENTITY_PATTERN = new RegExp(
  `\\b(${REFERRAL_FORBIDDEN_IDENTITY_SIGNALS.map((signal) => signal.replace(/_/g, '[_ ]?')).join(
    '|',
  )})\\b`,
  'i',
);

/** Modules that must never call the pilot gate — acceptance 5, inward. */
const SETTLEMENT_DIRS = [
  join(SRC_DIR, 'services/referrals/rewards'),
  join(SRC_DIR, 'services/referrals/earnings'),
  join(SRC_DIR, 'services/referrals/integrity'),
  join(SRC_DIR, 'services/referrals/dashboard'),
  join(SRC_DIR, 'services/ranking'),
];

describe('the pilot reaches nothing that moves money or ranks anything', () => {
  it('scans a non-trivial number of files', () => {
    // A broken traversal scans nothing and every wall below passes, which is
    // exactly what a BROKEN scan produces.
    expect(DOMAIN_FILES.length).toBeGreaterThanOrEqual(5);
  });

  for (const wall of WALLS) {
    it(`does not reach ${wall.name}`, () => {
      const offenders = DOMAIN_FILES.filter((path) => {
        const source = wall.name.includes('OxyPay') ? readFileSync(path, 'utf8') : code(path);
        return wall.pattern.test(source);
      });
      expect(offenders.map((path) => path.split('/').pop())).toEqual([]);
    });

    it(`would CATCH a reference to ${wall.name}`, () => {
      expect(wall.pattern.test(wall.probe)).toBe(true);
    });
  }

  it('reads the reward SCHEMA from exactly one named file', () => {
    // An exemption list needs its own EXACT-count assertion, not a floor: a
    // list that only ever grows is a wall switching itself off one defensible
    // line at a time.
    const readers = DOMAIN_FILES.filter((path) =>
      /from\s+['"][^'"]*schema\/referralRewards[^'"]*['"]/.test(code(path)),
    ).map((path) => path.split('/').pop());
    expect(readers).toEqual(['measurementRepository.ts']);
  });

  it('names no forbidden identity signal', () => {
    const offenders = DOMAIN_FILES.filter((path) => IDENTITY_PATTERN.test(code(path)));
    expect(offenders.map((path) => path.split('/').pop())).toEqual([]);
  });

  it('would CATCH a forbidden identity signal', () => {
    expect(IDENTITY_PATTERN.test('const key = cardFingerprint;')).toBe(true);
    expect(IDENTITY_PATTERN.test('const key = device_fingerprint;')).toBe(true);
    expect(REFERRAL_FORBIDDEN_IDENTITY_SIGNALS.length).toBeGreaterThanOrEqual(14);
  });
});

describe('the pilot gate has ONE caller, and it is attribution', () => {
  const CALL = /evaluateReferralPilotAdmission|referral-pilot\/pilot\.service/;

  it('is called from `attributeTouch` and from nowhere in the settlement path', () => {
    for (const dir of SETTLEMENT_DIRS) {
      const offenders = sourceFiles(dir).filter((path) => CALL.test(code(path)));
      expect(offenders.map((path) => path.split('/').pop()), dir).toEqual([]);
    }
  });

  it('IS wired into `attributeTouch`, so the gate is not green and inert', () => {
    // The other half of the same claim. "Nobody calls it" is also what a wall
    // reports when the mechanism was never connected at all.
    const attribution = code(join(SRC_DIR, 'services/referrals/attribution.service.ts'));
    expect(CALL.test(attribution)).toBe(true);
    expect(attribution).toContain("reason: 'pilot_not_admitted'");
  });

  it('would CATCH a settlement module that started calling it', () => {
    expect(CALL.test("import { evaluateReferralPilotAdmission } from '../referral-pilot/x.js';")).toBe(
      true,
    );
  });
});

describe('the vocabulary is closed and its counts are exact', () => {
  it('names the twelve stop metrics #149 lists, and no thirteenth', () => {
    expect(REFERRAL_PILOT_STOP_METRICS).toHaveLength(12);
    expect(new Set(REFERRAL_PILOT_STOP_METRICS).size).toBe(12);
  });

  it('names three stop scopes, none of which can pause settlement', () => {
    expect(REFERRAL_PILOT_STOP_SCOPES).toEqual(['pilot', 'partner', 'market']);
    // There is deliberately no `payout`, `reward` or `settlement` scope: a stop
    // halts ENTRY, and a vocabulary able to express more would make acceptance
    // 5 a convention rather than a shape.
    for (const forbidden of ['payout', 'reward', 'settlement', 'appeal', 'vesting']) {
      expect(REFERRAL_PILOT_STOP_SCOPES as readonly string[]).not.toContain(forbidden);
    }
  });

  it('names one admission refusal per bound', () => {
    expect(REFERRAL_PILOT_ADMISSION_REFUSALS).toHaveLength(9);
  });
});

describe('the test fixture is not production code', () => {
  it('is imported by nothing outside a test file', () => {
    // `pilot-fixture.ts` publishes bounds. A production module reaching for it
    // would be a code path that could admit a partner nobody approved.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
        if (path.includes('/__tests__/')) continue;
        if (readFileSync(path, 'utf8').includes('pilot-fixture')) offenders.push(path);
      }
    };
    walk(SRC_DIR);
    expect(offenders).toEqual([]);
  });
});

describe('the population the six walls above are applied to (#460)', () => {
  it('nothing naming this domain sits outside it', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: PILOT_NAME_PATTERN,
      // Deliberately empty, and the assertion is what makes that a measurement:
      // all nine modules the whole-tree sweep finds are this domain's.
      notThisDomain: [],
      // Below today's 9 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 7,
      plantIn: 'lib',
      plantName: 'referral-pilot-cache.ts',
    });
  });

  it('the three modules the two-directory population could not reach are in it', () => {
    // An identity assertion, not a floor. The operator controller is the surface
    // that RAISES a stop, and `db/schema/referralPilot.ts` is where the stop
    // scopes, the metric CHECK and the measurement shape are declared — the two
    // places an identity signal or a ledger read would arrive first.
    const population = domainRelativePaths();
    for (const named of [
      'controllers/referral-pilot-operator.controller.ts',
      'db/schema/referralPilot.ts',
      'middleware/referral-pilot-schemas.ts',
    ]) {
      expect(population, `${named} is outside all six walls again`).toContain(named);
      expect(
        statSync(join(SRC_DIR, named)).isFile(),
        `${named} no longer exists, so naming it proves nothing`,
      ).toBe(true);
    }
  });

  it('floors PER SHAPE, because the two sources break independently', () => {
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    const shared = namedInSharedDirectories(SHARED_DIRECTORIES, PILOT_NAME_PATTERN);
    expect(owned.length, 'the owned-directory walk reached nothing').toBeGreaterThanOrEqual(5);
    expect(shared.length, 'the shared-directory name sweep reached nothing').toBeGreaterThanOrEqual(
      2,
    );
  });

  it('the optional hyphen is load-bearing', () => {
    const camelCase = 'db/schema/referralPilot.ts';
    expect(PILOT_NAME_PATTERN.test(camelCase)).toBe(true);
    expect(/referral-pilot/.test(camelCase), 'the hyphenated spelling already matched').toBe(false);
    expect(domainRelativePaths()).toContain(camelCase);
  });
});
