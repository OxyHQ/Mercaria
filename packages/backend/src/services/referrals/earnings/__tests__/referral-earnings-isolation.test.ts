/**
 * The walls around the referral EARNINGS ledger (#145).
 *
 * #144's `reward-funding-isolation.test.ts` states the funding invariant over
 * SOURCES — what a rule may compute a base from. This states it over ACCOUNTS,
 * which is where money would actually be taken from the wrong place, plus the
 * import graph of the domain that moves it.
 *
 * Four independent mechanisms, and this file measures all four:
 *
 *  1. **The vocabulary.** `REFERRAL_LEDGER_ACCOUNTS` and
 *     `REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS` are DISJOINT and their union is
 *     EXACTLY `LEDGER_ACCOUNTS` — so a fourteenth account added to Mercaria's
 *     chart fails the build here until somebody decides which side of the
 *     referral boundary it is on. That is the `merge-plan-census.test.ts`
 *     device: finding fewer accounts looks identical to there BEING fewer, so
 *     the check is an exact partition rather than a containment.
 *  2. **The signature.** No posting builder takes an account, so a forbidden one
 *     is unrepresentable at the call site rather than refused.
 *  3. **The scan.** Nothing in the domain names a forbidden account, imports the
 *     retail, procurement, fee, pricing or ranking domains, or reaches FX.
 *  4. **The runtime walk.** Every one of the four builders is EXECUTED and its
 *     real entries are walked through `assertReferralPosting`, and a forged
 *     retail entry is confirmed to be refused. The #92 two-gate rule — a scanned
 *     gate plus a walk of a genuinely emitted value — applied to a chart of
 *     accounts.
 *
 * Every detector carries an anti-vacuity floor and a MUTATION SELF-TEST against
 * a source that genuinely contains what it forbids, so a pattern that stopped
 * matching fails HERE rather than passing silently forever.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../../__tests__/domain-population.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEDGER_ACCOUNTS,
  LEDGER_TRANSACTION_KINDS,
  REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS,
  REFERRAL_FORBIDDEN_LEDGER_ACCOUNT_LABELS,
  REFERRAL_LEDGER_ACCOUNTS,
  REFERRAL_LEDGER_POSTING_KINDS,
  REFERRAL_REWARD_STATES,
  REFERRAL_REWARD_STATE_ELSEWHERE,
} from '@mercaria/shared-types';
import {
  assertReferralPosting,
  ForbiddenReferralLedgerAccountError,
  isReferralLedgerAccount,
  REFERRAL_PAYABLE_OWNER_TYPE,
} from '../accounts.js';
import {
  InvalidReferralPostingAmountError,
  payoutSettledPosting,
  recoveryReceivedPosting,
  rewardAccruedPosting,
  rewardReversedPosting,
} from '../ledger-postings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..', '..', '..', '..');

/**
 * What a module of THIS sub-domain is called.
 *
 * `services/referrals/` hosts four sub-domains with four gates, so a bare
 * `referral` would pull all 118 referral modules into a population of
 * seventeen. Both spellings the tree actually uses: the directory segment and
 * the camelCase `referralEarnings`.
 */
const EARNINGS_NAME_PATTERN = /referral-?earnings|referrals\/earnings/i;

/** The two directories this sub-domain owns outright. */
const OWNED_DIRECTORIES = ['services/referrals/earnings', 'db/referralEarnings'] as const;

/** The flat directories a module of this sub-domain lives in under its own NAME. */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/**
 * Every module of the earnings sub-domain, RELATIVE to `src/`.
 *
 * It was the two owned directories and nothing else (#460), so
 * `db/schema/referralEarnings.ts` — where the partner balance, the payout batch
 * and the ledger-posting tables and their CHECKs are DECLARED — sat behind none
 * of the walls below.
 */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, EARNINGS_NAME_PATTERN, readDir),
  ];
}

/**
 * Source with comments stripped.
 *
 * Load-bearing rather than tidy: these modules DOCUMENT which accounts they
 * refuse to touch, by name. A scan over raw source would fire on the docblock
 * explaining why `retail_cost_recovery` is unreachable, and the "fix" would be
 * to delete the explanation.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const DOMAIN_FILES = domainRelativePaths().map((relative) => join(SRC_ROOT, relative));

interface Wall {
  name: string;
  pattern: RegExp;
  /** A source that genuinely contains what the pattern forbids. */
  probe: string;
  /** Scan RAW source rather than comment-stripped — for the copy walls. */
  raw?: boolean;
}

const WALLS: Wall[] = [
  {
    // #145 "Zero-profit retail protection" 1–3 and 5, as an import graph. The
    // way a referral would eat a retail cost, a supplier payable or a #128
    // customer adjustment is by reaching the domain that holds one.
    name: 'the retail, procurement or supplier domain',
    pattern:
      /from\s+['"][^'"]*(retail-checkout|retail-pricing|retail-fulfilment|retail-pilot|retail-reconciliation|supplier-orders|supplier-preflight|schema\/retail|schema\/supplier|db\/retail|db\/supplier)[^'"]*['"]/,
    probe: "import { recordRetailCostVariance } from '../../retail-checkout/variance.service.js';",
  },
  {
    // ADR 0005 I2/I3. A payout changes no buyer price and no merchant fee, and
    // the strongest form of that is having no path to either.
    name: 'the marketplace fee domain or the pricing engine',
    pattern:
      /from\s+['"][^'"]*(services\/fees|\.\.\/fees\/|db\/fees|schema\/fees|pricing\.service|order-fees)[^'"]*['"]/,
    probe: "import { calculateTotals } from '../../../pricing.service.js';",
  },
  {
    // ADR 0005 I1. What a partner earned, and what they are owed, cannot enter
    // organic ranking. Repeated from the ranking side in
    // `offer-ranking-isolation.test.ts`.
    name: 'ranking, search, discovery or a feed',
    pattern:
      /from\s+['"][^'"]*(services\/ranking|\.\.\/ranking\/|services\/search|\.\.\/search\/|feed\.service|merchandising|schema\/ranking)[^'"]*['"]/,
    probe: "import { rankOfferComparison } from '../../../ranking/rank.js';",
  },
  {
    // No conversion, anywhere. A payout is denominated in the currency the
    // reward was accrued in, and a batch is per currency by construction; an FX
    // call here would let a rate move between accrual and payout change what a
    // partner is paid against terms ADR 0005 D19 fixes at attribution.
    name: 'the FX service',
    pattern: /from\s+['"][^'"]*(fx\.service|services\/fx|\.\.\/fx\/)[^'"]*['"]/,
    probe: "import { convert } from '../../../fx.service.js';",
  },
  {
    // ADR 0004 D11 and the standing rule across every money-adjacent domain in
    // this repo: nothing may NAME them, comments included.
    name: 'OxyPay or FairCoin, anywhere in the earnings domain',
    pattern: /oxy[_\s-]?pay|oxypay|faircoin|fair[_\s-]coin/i,
    probe: 'const rail = "oxy_pay";',
    raw: true,
  },
  {
    // The card rail is #146's, and a Stripe import here would put a buyer's
    // charge and a partner's payout in one module. The rail arrives through
    // `payout-rail.port.ts`, which is a function type and a registry.
    name: 'a payment rail client',
    pattern: /from\s+['"](stripe|@stripe\/[^'"]*)['"]|services\/payments\/(provider|stripe)/,
    probe: "import Stripe from 'stripe';",
  },
];

describe('referral earnings isolation (static)', () => {
  it('scans a non-trivial number of files', () => {
    // The anti-vacuity floor. A broken traversal scans nothing and every wall
    // below passes, which is exactly what a BROKEN scan produces.
    // Per SHAPE, through the SAME traversal the population uses — a second
    // spelling of a walk is a second thing to keep in step, and #460 deleted the
    // local `sourceFiles` rather than leaving both.
    expect(walkOwnedDirectory('services/referrals/earnings').length).toBeGreaterThanOrEqual(8);
    expect(walkOwnedDirectory('db/referralEarnings').length).toBeGreaterThanOrEqual(4);
    expect(DOMAIN_FILES.length).toBeGreaterThanOrEqual(12);
    // …and a KNOWN-PRESENT file is genuinely in the set, so the traversal is
    // reading what it claims to read.
    expect(DOMAIN_FILES.map((path) => path.split('/').pop())).toContain('posting.service.ts');
  });

  for (const wall of WALLS) {
    it(`does not reach ${wall.name}`, () => {
      const offenders = DOMAIN_FILES.filter((path) =>
        wall.pattern.test(wall.raw === true ? readFileSync(path, 'utf8') : code(path)),
      );
      expect(offenders.map((path) => path.split('/').pop())).toEqual([]);
    });

    it(`would CATCH a reference to ${wall.name}`, () => {
      expect(wall.pattern.test(wall.probe)).toBe(true);
    });
  }

  it('names no forbidden ledger account in any module', () => {
    // The sharp one. Every account outside the referral boundary, scanned by
    // NAME over comment-stripped source — so a module that learned to compose an
    // entry against a retail cost account fails here even if it never imported
    // the retail domain to do it.
    const offenders: string[] = [];
    for (const path of DOMAIN_FILES) {
      const source = code(path);
      for (const account of REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS) {
        if (source.includes(`'${account}'`) || source.includes(`"${account}"`)) {
          offenders.push(`${path.split('/').pop() ?? path}:${account}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The mutation self-test: the same scan against a seeded positive fires.
    const seeded = "  { account: 'retail_cost_recovery', currency, amountMinor },";
    expect(
      REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS.some((account) => seeded.includes(`'${account}'`)),
    ).toBe(true);
  });
});

describe('the referral account boundary (vocabulary)', () => {
  it('partitions Mercaria’s whole chart of accounts, exactly', () => {
    // DISJOINT…
    const overlap = REFERRAL_LEDGER_ACCOUNTS.filter((account) =>
      REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS.includes(account),
    );
    expect(overlap).toEqual([]);
    // …and EXHAUSTIVE. A fourteenth account fails here until somebody decides
    // which side it is on, which is the whole point of an exact partition.
    expect([...REFERRAL_LEDGER_ACCOUNTS, ...REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS].sort()).toEqual(
      [...LEDGER_ACCOUNTS].sort(),
    );
    // A floor, so an empty pair of tuples cannot satisfy the two assertions
    // above by describing nothing.
    expect(LEDGER_ACCOUNTS.length).toBeGreaterThanOrEqual(15);
  });

  it('explains every prohibition it names', () => {
    for (const account of REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS) {
      const label = REFERRAL_FORBIDDEN_LEDGER_ACCOUNT_LABELS[account];
      expect(label, `no label for ${account}`).toBeTruthy();
      expect((label ?? '').length).toBeGreaterThan(20);
    }
    // …and it explains NOTHING it does not forbid, so the map cannot drift into
    // a second, wider list.
    expect(Object.keys(REFERRAL_FORBIDDEN_LEDGER_ACCOUNT_LABELS).sort()).toEqual(
      [...REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS].sort(),
    );
  });

  it('keeps one posting kind per referral ledger transaction kind', () => {
    const referralKinds = LEDGER_TRANSACTION_KINDS.filter((kind) => kind.startsWith('referral_'));
    expect(referralKinds).toHaveLength(REFERRAL_LEDGER_POSTING_KINDS.length);
    expect(REFERRAL_LEDGER_POSTING_KINDS.length).toBe(4);
  });

  it('keeps the three unmodelled reward states OUT of the machine', () => {
    // #145's issue lists `pending`, `payable` and `reversed`; none is a member
    // of ADR 0005's machine and each is named with where its fact actually
    // lives. Disjointness is what makes adding one later fail the build until
    // this map goes with it.
    const elsewhere = Object.keys(REFERRAL_REWARD_STATE_ELSEWHERE);
    expect(elsewhere.sort()).toEqual(['payable', 'pending', 'reversed']);
    for (const state of elsewhere) {
      expect(REFERRAL_REWARD_STATES).not.toContain(state);
      expect(REFERRAL_REWARD_STATE_ELSEWHERE[state as 'pending'].length).toBeGreaterThan(40);
    }
  });
});

describe('the referral account boundary (runtime walk)', () => {
  const base = {
    partnerId: 'partner-1',
    amountMinor: 2_500n,
    currency: 'EUR' as const,
    description: 'test',
  };

  const postings = [
    rewardAccruedPosting({ ...base, rewardId: 'reward-1' }),
    rewardReversedPosting({ ...base, rewardId: 'reward-1', adjustmentId: 'adj-1' }),
    payoutSettledPosting({ ...base, payoutBatchId: 'batch-1' }),
    recoveryReceivedPosting({ ...base, recoveryRef: 'bank-ref-1' }),
  ];

  it('emits only accounts inside the boundary, from every builder', () => {
    // A REAL emitted value, not a description of one.
    expect(postings).toHaveLength(4);
    for (const posting of postings) {
      expect(posting.entries.length).toBeGreaterThanOrEqual(2);
      for (const entry of posting.entries) {
        expect(isReferralLedgerAccount(entry.account), entry.account).toBe(true);
      }
      // …and the whole set passes the assertion the ONE writer runs.
      expect(() => assertReferralPosting(posting.entries, 'test')).not.toThrow();
    }
  });

  it('balances every posting to zero, per currency', () => {
    for (const posting of postings) {
      const total = posting.entries.reduce((sum, entry) => sum + entry.amountMinor, 0n);
      expect(total).toBe(0n);
    }
  });

  it('names the partner on every referral_payable leg', () => {
    for (const posting of postings) {
      for (const entry of posting.entries) {
        if (entry.account !== 'referral_payable') continue;
        expect(entry.ownerType).toBe(REFERRAL_PAYABLE_OWNER_TYPE);
        expect(entry.ownerId).toBe('partner-1');
      }
    }
  });

  it('REFUSES a forged entry against a retail cost account', () => {
    // The mutation self-test on the runtime half: the assertion the writer runs
    // is confirmed to fire on the exact shape it exists to stop.
    expect(() =>
      assertReferralPosting(
        [
          { account: 'referral_expense', currency: 'EUR', amountMinor: 100n },
          { account: 'retail_cost_recovery', currency: 'EUR', amountMinor: -100n },
        ],
        'forged',
      ),
    ).toThrow(ForbiddenReferralLedgerAccountError);
  });

  it('REFUSES a payable leg that names nobody', () => {
    expect(() =>
      assertReferralPosting(
        [
          { account: 'referral_expense', currency: 'EUR', amountMinor: 100n },
          { account: 'referral_payable', currency: 'EUR', amountMinor: -100n },
        ],
        'ownerless',
      ),
    ).toThrow(ForbiddenReferralLedgerAccountError);
  });

  it('REFUSES a builder handed a signed amount', () => {
    // The direction is the builder's, never the caller's: a reversal handed a
    // positive delta would credit a partner for a refund.
    expect(() =>
      rewardAccruedPosting({ ...base, amountMinor: -100n, rewardId: 'reward-1' }),
    ).toThrow(InvalidReferralPostingAmountError);
    expect(() => payoutSettledPosting({ ...base, amountMinor: 0n, payoutBatchId: 'b' })).toThrow(
      InvalidReferralPostingAmountError,
    );
  });
});


describe('the population every wall above is applied to (#460)', () => {
  it('nothing naming this sub-domain sits outside it', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: EARNINGS_NAME_PATTERN,
      // Deliberately empty, and the assertion is what makes that a measurement:
      // every module the whole-tree sweep finds under this sub-domain's own name
      // is this sub-domain's.
      notThisDomain: [],
      // Below today's 17 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 13,
      plantIn: 'lib',
      plantName: 'referral-earnings-cache.ts',
    });
  });

  it('the module the owned-directory population could not reach is in it', () => {
    // An identity assertion, not a floor. A floor set below 17 is met without
    // it.
    const population = domainRelativePaths();
    for (const named of ['db/schema/referralEarnings.ts']) {
      expect(population, `${named} is outside every wall again`).toContain(named);
      expect(
        statSync(join(SRC_ROOT, named)).isFile(),
        `${named} no longer exists, so naming it proves nothing`,
      ).toBe(true);
    }
  });

  it('the SIBLING sub-domains stay out — `services/referrals/` hosts four', () => {
    // The hazard this narrow pattern exists for. A bare `referral` matches 118
    // modules across four sub-domains, each with its own gate and its own walls,
    // and a population that swallowed them would apply THIS gate's walls to code
    // three other issues own. Each sibling is asserted to exist, so the
    // exclusion cannot go vacuous on a rename.
    const population = domainRelativePaths();
    for (const sibling of ['services/referrals/integrity/effects.ts', 'services/referrals/rewards/funding.ts', 'services/referrals/dashboard/disclosure.ts']) {
      expect(
        statSync(join(SRC_ROOT, sibling)).isFile(),
        `${sibling} no longer exists, so excluding it proves nothing`,
      ).toBe(true);
      expect(EARNINGS_NAME_PATTERN.test(sibling), `${sibling} matches this sub-domain's name`).toBe(false);
      expect(population, `${sibling} belongs to a sibling sub-domain`).not.toContain(sibling);
    }
    // …and the vacuity floor on the loop itself.
    expect(['services/referrals/integrity/effects.ts', 'services/referrals/rewards/funding.ts', 'services/referrals/dashboard/disclosure.ts'].length).toBeGreaterThanOrEqual(3);
  });

  it('floors PER SHAPE, because the sources break independently', () => {
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    const shared = namedInSharedDirectories(SHARED_DIRECTORIES, EARNINGS_NAME_PATTERN);
    expect(owned.length, 'the owned-directory walk reached nothing').toBeGreaterThanOrEqual(13);
    expect(shared.length, 'the shared-directory name sweep reached nothing').toBeGreaterThanOrEqual(
      1,
    );
  });
});
