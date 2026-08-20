/**
 * The walls around referral integrity (#148, ADR 0005 D7/D17/A2).
 *
 * Static scans, following `reward-funding-isolation.test.ts`: each wall names
 * what must be unreachable, is applied to a real file set with an anti-vacuity
 * floor, and is MUTATION-TESTED against a synthetic source that genuinely
 * contains what it forbids — so a detector that stopped matching fails HERE
 * rather than passing silently forever.
 *
 * ## What the walls are FOR, stated once
 *
 * #148's boundary 2 is that email, card fingerprint, phone, Stripe Customer,
 * Link identity, IP and device data *"cannot become a durable general user
 * graph"*. A fraud domain is exactly where that pressure arrives: catching a
 * cheat is the most sympathetic reason anybody will ever have for joining two
 * strangers by their IP address. So the prohibition is a list of VALUES, the
 * facts type has no field for one, the CHECK renders the permitted tuple — and
 * this file makes the ABSENCE checkable by reading a list rather than by
 * reasoning about behaviour.
 *
 * ## The vocabularies, and why they are asserted here rather than beside them
 *
 * Four disjointness properties and two derivations. Every one of them is a
 * relationship between two constants that live in `@mercaria/shared-types`, and
 * a test in the package that CONSUMES them is what catches a member added to
 * one list and forgotten in the other — the exact failure
 * `REFERRAL_LEDGER_ACCOUNTS`' partition test exists for, one domain over.
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
  REFERRAL_BASES_PERMITTING_FORFEITURE,
  REFERRAL_ENFORCEMENT_ACTIONS,
  REFERRAL_ENFORCEMENT_ACTION_EFFECTS,
  REFERRAL_ENFORCEMENT_BASES,
  REFERRAL_ENFORCEMENT_FINANCIAL_EFFECTS,
  REFERRAL_FINANCIAL_RETENTION_CLASSES,
  REFERRAL_FORBIDDEN_IDENTITY_SIGNALS,
  REFERRAL_FORBIDDEN_RISK_SIGNALS,
  REFERRAL_FORBIDDEN_RISK_SIGNAL_LABELS,
  REFERRAL_FORBIDDEN_SELF_REFERRAL_EVIDENCE,
  REFERRAL_FORFEITING_ENFORCEMENT_ACTIONS,
  REFERRAL_PROHIBITED_CONDUCT_KINDS,
  REFERRAL_RETENTION_CLASSES,
  REFERRAL_RETENTION_POLICY,
  REFERRAL_RISK_SIGNAL_KINDS,
  REFERRAL_SELF_REFERRAL_EVIDENCE_KINDS,
  REFERRAL_SELF_REFERRAL_EVIDENCE_STRENGTH,
  REFERRAL_SWEPT_RETENTION_CLASSES,
} from '@mercaria/shared-types';
import { assertEachOf } from '../../../../__tests__/assert-each-of.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..', '..', '..', '..');
const INTEGRITY_DIR = join(HERE, '..');

/**
 * What a module of THIS sub-domain is called.
 *
 * `services/referrals/` hosts four sub-domains with four gates, so a bare
 * `referral` would pull all 118 referral modules into a population of fifteen.
 * Both spellings the tree uses: the directory segment and the camelCase
 * `referralIntegrity`.
 */
const INTEGRITY_NAME_PATTERN = /referral-?integrity|referrals\/integrity/i;

/** The two directories this sub-domain owns outright. */
const OWNED_DIRECTORIES = ['services/referrals/integrity', 'db/referralIntegrity'] as const;

/** The flat directories a module of this sub-domain lives in under its own NAME. */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/**
 * Every module of the integrity sub-domain, RELATIVE to `src/`.
 *
 * It was the two owned directories and nothing else (#460), so TWO modules sat
 * behind none of the walls below: `controllers/referral-integrity.controller.ts`
 * — the operator surface that raises and lifts an enforcement — and
 * `db/schema/referralIntegrity.ts`, where the risk-signal, policy and
 * enforcement tables and their CHECKs are DECLARED. Those are the two places a
 * forbidden identity signal would arrive first.
 */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, INTEGRITY_NAME_PATTERN, readDir),
  ];
}

/**
 * Source with block and line comments removed.
 *
 * Every module here DOCUMENTS what it refuses to do, in the same vocabulary the
 * detectors match — a prose-inclusive scan would implicate the safest files in
 * the domain and the safety helper hardest of all. #105's
 * `checkout-contact-isolation.test.ts` states the same rule.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

const FILES = domainRelativePaths().map((relative) => join(SRC_ROOT, relative));

interface Wall {
  name: string;
  pattern: RegExp;
  /**
   * Source fragments the pattern MUST match — the mutation self-test.
   *
   * A LIST rather than one string, because a wall usually forbids a class of
   * import with several spellings and one example proves only the spelling it
   * happens to carry. WALL 2 shipped with a single directory-shaped positive
   * and silently admitted three other shapes for exactly that reason.
   */
  positive: readonly string[];
  /** Fragments it must NOT match: things this domain legitimately does. */
  negative: readonly string[];
}

const WALLS: readonly Wall[] = [
  {
    name: 'a device, network or contact identifier',
    // The one class #148 boundary 2 forbids and a fraud detector most wants.
    pattern:
      /\b(ipAddress|ip_address|remoteAddress|userAgent|user_agent|deviceFingerprint|device_fingerprint|canvasFingerprint|tlsFingerprint|advertisingIdentifier|cardFingerprint|card_fingerprint|stripeCustomerId|stripe_customer_id|paymentMethodId|emailHash|email_hash|phoneNumber|phone_number)\b/,
    positive: ['const key = buildKey(request.ipAddress, request.userAgent);'],
    negative: ['const facts = { merchantMembershipOverlap: true, capRefusalCount: 3 };'],
  },
  {
    name: 'the payment domain',
    // A path SEGMENT, never a `services/`-anchored prefix: every module here
    // would write the RELATIVE `'../../payments/x.js'`, which an anchored
    // pattern never sees. #125's isolation gate shipped that gap and its own
    // mutation self-test caught it; this one caught the same thing on its first
    // run, which is the whole argument for having the self-test.
    //
    // It then shipped a SECOND gap of the same family, found while #344 was
    // being scoped and fixed here. The pattern required a trailing `/`, so it
    // matched payment DIRECTORIES and missed every payment MODULE — including
    // `db/schema/payments.js`, which is where `provider_accounts` lives and
    // therefore the single import somebody wiring a risk producer would reach
    // for. It also missed `db/schema/ledger.js` and a bare `from 'stripe'`.
    // Three shapes, all passing a gate whose entire purpose is to refuse them,
    // which is worse than no gate because it certifies.
    //
    // The lesson is the one the `positive` list now encodes: a wall proved by
    // ONE example is proved only for that example's spelling.
    pattern:
      /\bfrom\s+['"](?:[^'"]*\/)?(?:(?:services\/)?payments\/|db\/payments\/|db\/schema\/(?:payments|ledger)\.|stripe(?:['"]|\/))/,
    positive: [
      "import { x } from '../payments/ledger.js';",
      "import { y } from '../../db/payments/ledgerRepository.js';",
      "import { z } from '../../services/payments/redact.js';",
      // The three the previous pattern admitted.
      "import { providerAccounts } from '../../../db/schema/payments.js';",
      "import { ledgerEntries } from '../../../db/schema/ledger.js';",
      "import Stripe from 'stripe';",
    ],
    negative: [
      "import { y } from '../../../db/referrals/partnerRepository.js';",
      // The neighbours this domain legitimately reads, and the ones a widened
      // pattern would most plausibly catch by accident.
      "import { referralConversions } from '../../../db/schema/referrals.js';",
      "import { storeMembers } from '../../../db/schema/stores.js';",
      "import { merchantClaims } from '../../../db/schema/merchantClaims.js';",
      "import { getDb } from '../../../db/postgres.js';",
    ],
  },
  {
    name: 'the payout JOIN, which is how the payment domain arrives TRANSITIVELY',
    // WALL 2 above scans TEXT, so it sees `db/schema/payments.js` and cannot
    // see `services/referral-payouts/risk-payment-facts.js` — a module whose
    // whole job is to read the payment domain. Importing it from here would
    // defeat WALL 2 completely while reading as clean, and it is the single
    // most plausible mistake now that #344's join exists and is one directory
    // away: somebody wanting `disputeRateBps` reaches for the function that
    // computes it rather than for the port that asks for it.
    //
    // The direction is the whole design. `payment-facts.port.ts` is a function
    // type and a registry and imports nothing but the logger; the JOIN imports
    // the port. Every edge runs join → domain, and this wall is what keeps the
    // arrow from reversing.
    pattern: /from\s+['"][^'"]*[/']referral-payouts\//,
    positive: [
      "import { readReferralRiskPartnerPaymentFacts } from '../../referral-payouts/risk-payment-facts.js';",
      "import { readPartnerPayoutReadiness } from '../../../referral-payouts/readiness.js';",
      "import { referralPayoutAccountOwner } from '../../referral-payouts/beneficiary.js';",
    ],
    negative: [
      // The port itself, which is what this domain is supposed to import.
      "import { readReferralRiskPaymentFacts } from './payment-facts.port.js';",
      "import { getDb } from '../../../db/postgres.js';",
    ],
  },
  {
    name: 'ranking, search, discovery or a feed',
    pattern: /from\s+['"][^'"]*[/']((services\/)?(ranking|search|offers|feed-import))\//,
    positive: ["import { rankOffers } from '../../ranking/score.js';"],
    negative: ["import { getDb } from '../../../db/postgres.js';"],
  },
  {
    name: 'the retail, procurement or supplier domain',
    pattern:
      /from\s+['"][^'"]*[/'](retail-pricing|retail-checkout|retail-pilot|retail-eligibility|supplier-preflight|supplier-orders|procurement)\//,
    positive: ["import { z } from '../../retail-pricing/compose.js';"],
    negative: ["import { conflict } from '../../../lib/errors/error-codes.js';"],
  },
  {
    name: 'OxyPay or FairCoin, anywhere in the integrity domain',
    // RAW source rather than comment-stripped: a claim in a comment is a
    // sentence somebody pastes into a screen next week (#81's reasoning).
    pattern: /\b(oxy_?pay|oxypay|faircoin|FAIR_?COIN)\b/i,
    positive: ['const rail = "oxypay";'],
    negative: ['const currency = reward.currency;'],
  },
  {
    name: 'an outbound HTTP call',
    // A fraud domain reaching a third-party reputation or identity service is
    // the cross-product graph arriving through somebody else's API.
    pattern: /\b(safeFetch|fetch\s*\(|axios|got\s*\(|https?\.request)\b/,
    positive: ['const res = await safeFetch(url);'],
    negative: ['const rows = await findLiveEnforcementActions(db, partnerId);'],
  },
];

describe('referral integrity isolation (static)', () => {
  it('scans a non-trivial number of files', () => {
    // The anti-vacuity floor. A broken path, a renamed directory or a moved
    // module would otherwise make every wall below pass by reading nothing.
    expect(FILES.length).toBeGreaterThanOrEqual(10);
  });

  for (const wall of WALLS) {
    const raw = wall.name.includes('OxyPay');
    it(`does not reach ${wall.name}`, () => {
      const offenders = FILES.filter((path) => {
        const source = readFileSync(path, 'utf8');
        return wall.pattern.test(raw ? source : stripComments(source));
      });
      expect(offenders.map((path) => path.split('/').pop())).toEqual([]);
    });

    it(`would CATCH ${wall.name}`, () => {
      // The mutation self-test, in BOTH directions: the detector fires on the
      // thing it forbids and does NOT fire on what this domain legitimately
      // does. A detector that matches everything passes the first half.
      expect(wall.positive.length).toBeGreaterThan(0);
      expect(wall.negative.length).toBeGreaterThan(0);
      for (const fragment of wall.positive) {
        expect(wall.pattern.test(fragment), `should CATCH: ${fragment}`).toBe(true);
      }
      for (const fragment of wall.negative) {
        expect(wall.pattern.test(fragment), `should NOT catch: ${fragment}`).toBe(false);
      }
    });
  }

  it('the self-referral EVALUATION reads no repository at all', () => {
    // The `getRetailEligibility` (#121) and `guest-p2p/eligibility.ts` (#112)
    // rule: the pure decision must stay testable against every combination of
    // facts, including the ones that are hard to construct in a database.
    const source = stripComments(readFileSync(join(INTEGRITY_DIR, 'self-referral.ts'), 'utf8'));
    expect(source).not.toMatch(/from\s+['"][^'"]*(db\/|Repository|postgres)[^'"]*['"]/);
    // The positive control: the file EXISTS and imports something, so an empty
    // read cannot be what this pass looks like.
    expect(source).toMatch(/from\s+'@mercaria\/shared-types'/);
  });

  it('the payment PORT is load-bearing: its implementation could not live here', () => {
    // The property #344 is about, asserted against the real file rather than
    // asserted about. `services/referral-payouts/risk-payment-facts.ts` answers
    // this domain's port, and WALL 2 fires on its imports — so the port is not
    // ceremony around an import that would have been allowed anyway, and the
    // day somebody "simplifies" it by inlining the queries, WALL 2 catches them
    // rather than this case going quietly true.
    const joinPath = join(HERE, '..', '..', '..', 'referral-payouts', 'risk-payment-facts.ts');
    const join_ = stripComments(readFileSync(joinPath, 'utf8'));
    // The vacuity floor: a moved or emptied file must not read as "no forbidden
    // import found".
    expect(join_.length).toBeGreaterThan(500);
    expect(join_).toMatch(/registerReferralRiskPaymentFactsReader|ReferralRiskPaymentSubject/);

    const paymentWall = WALLS.find((wall) => wall.name === 'the payment domain');
    expect(paymentWall).toBeDefined();
    expect(paymentWall?.pattern.test(join_)).toBe(true);

    // And the port this domain DOES import reaches nothing: a function type and
    // a registry, so no transitive path from here to the payment domain exists.
    const port = stripComments(readFileSync(join(INTEGRITY_DIR, 'payment-facts.port.ts'), 'utf8'));
    expect(port).toMatch(/export type ReferralRiskPaymentFactsReader/);
    const portImports = [...port.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(portImports).toEqual(['../../../lib/logger.js']);
  });

  it('the risk THRESHOLDS module is pure — no database, no clock, no config', () => {
    const source = stripComments(readFileSync(join(INTEGRITY_DIR, 'risk-thresholds.ts'), 'utf8'));
    expect(source).not.toMatch(/from\s+['"][^'"]*(db\/|config|postgres)[^'"]*['"]/);
    expect(source).not.toMatch(/\bnew Date\(|Date\.now\(/);
    expect(source).toMatch(/export function deriveRiskSignals/);
  });
});

describe('the integrity vocabularies partition and derive correctly', () => {
  it('permitted and forbidden RISK SIGNALS are disjoint', () => {
    const permitted = new Set<string>(REFERRAL_RISK_SIGNAL_KINDS);
    const overlap = REFERRAL_FORBIDDEN_RISK_SIGNALS.filter((kind) => permitted.has(kind));
    expect(overlap).toEqual([]);
    // Floors on BOTH sides: two empty tuples are also disjoint.
    expect(REFERRAL_RISK_SIGNAL_KINDS.length).toBe(14);
    expect(REFERRAL_FORBIDDEN_RISK_SIGNALS.length).toBeGreaterThanOrEqual(18);
  });

  it('the forbidden set is a strict SUPERSET of #143s fourteen', () => {
    // #148 EXTENDS #143's prohibition rather than forking it. Two lists
    // describing one prohibition disagree eventually, and the direction they
    // disagree in is always the permissive one.
    const forbidden = new Set<string>(REFERRAL_FORBIDDEN_RISK_SIGNALS);
    for (const signal of REFERRAL_FORBIDDEN_IDENTITY_SIGNALS) {
      expect(forbidden.has(signal)).toBe(true);
    }
    expect(REFERRAL_FORBIDDEN_RISK_SIGNALS.length).toBeGreaterThan(
      REFERRAL_FORBIDDEN_IDENTITY_SIGNALS.length,
    );
  });

  it('every forbidden signal states WHY, exhaustively', () => {
    for (const signal of REFERRAL_FORBIDDEN_RISK_SIGNALS) {
      expect(REFERRAL_FORBIDDEN_RISK_SIGNAL_LABELS[signal]).toBeTruthy();
    }
    expect(Object.keys(REFERRAL_FORBIDDEN_RISK_SIGNAL_LABELS)).toHaveLength(
      REFERRAL_FORBIDDEN_RISK_SIGNALS.length,
    );
  });

  it('admissible and forbidden SELF-REFERRAL evidence are disjoint', () => {
    const admissible = new Set<string>(REFERRAL_SELF_REFERRAL_EVIDENCE_KINDS);
    const overlap = REFERRAL_FORBIDDEN_SELF_REFERRAL_EVIDENCE.filter((kind) =>
      admissible.has(kind),
    );
    expect(overlap).toEqual([]);
    expect(REFERRAL_SELF_REFERRAL_EVIDENCE_KINDS.length).toBe(6);
    expect(REFERRAL_FORBIDDEN_SELF_REFERRAL_EVIDENCE.length).toBe(6);
  });

  it('exactly ADR 0005 D7s two evidence kinds are deterministic', () => {
    const deterministic = REFERRAL_SELF_REFERRAL_EVIDENCE_KINDS.filter(
      (kind) => REFERRAL_SELF_REFERRAL_EVIDENCE_STRENGTH[kind] === 'deterministic',
    );
    // D7 admits exactly two facts as final: the same Oxy actor, and store
    // membership. Everything else "freezes and routes to manual review".
    expect(deterministic).toEqual(['same_oxy_actor', 'partner_administers_referred_merchant']);
  });

  it('every evidence kind has a strength, exhaustively', () => {
    expect(Object.keys(REFERRAL_SELF_REFERRAL_EVIDENCE_STRENGTH)).toHaveLength(
      REFERRAL_SELF_REFERRAL_EVIDENCE_KINDS.length,
    );
  });

  it('the forfeiting set is DERIVED from the effect table, not written twice', () => {
    const derived = REFERRAL_ENFORCEMENT_ACTIONS.filter(
      (action) => REFERRAL_ENFORCEMENT_FINANCIAL_EFFECTS[action] === 'forfeits',
    );
    expect([...REFERRAL_FORFEITING_ENFORCEMENT_ACTIONS]).toEqual(derived);
    // A floor: an empty derived set would make the forfeiture CHECK vacuous.
    expect(REFERRAL_FORFEITING_ENFORCEMENT_ACTIONS.length).toBeGreaterThan(0);
  });

  it('`risk_signal` is the ONE basis excluded from forfeiture', () => {
    expect([...REFERRAL_BASES_PERMITTING_FORFEITURE]).toEqual(
      REFERRAL_ENFORCEMENT_BASES.filter((basis) => basis !== 'risk_signal'),
    );
    expect(REFERRAL_BASES_PERMITTING_FORFEITURE).not.toContain('risk_signal');
    expect(REFERRAL_BASES_PERMITTING_FORFEITURE.length).toBe(3);
  });

  it('every action has a financial effect AND an effect list, exhaustively', () => {
    expect(Object.keys(REFERRAL_ENFORCEMENT_FINANCIAL_EFFECTS)).toHaveLength(
      REFERRAL_ENFORCEMENT_ACTIONS.length,
    );
    expect(Object.keys(REFERRAL_ENFORCEMENT_ACTION_EFFECTS)).toHaveLength(
      REFERRAL_ENFORCEMENT_ACTIONS.length,
    );
    expect(REFERRAL_ENFORCEMENT_ACTIONS.length).toBe(12);
  });

  it('the three suspensions are INDEPENDENT effects — #148 acceptance 2', () => {
    // The property the whole issue turns on: no single action raises two of the
    // three gates, EXCEPT termination, which is meant to raise all of them.
    expect(REFERRAL_ENFORCEMENT_ACTION_EFFECTS.new_attribution_suspension).toEqual([
      'newAttributionSuspended',
    ]);
    expect(REFERRAL_ENFORCEMENT_ACTION_EFFECTS.new_link_suspension).toEqual([
      'newLinksSuspended',
    ]);
    expect(REFERRAL_ENFORCEMENT_ACTION_EFFECTS.payout_hold).toEqual(['payoutHeld']);
    expect(REFERRAL_ENFORCEMENT_ACTION_EFFECTS.partner_termination).toContain('payoutHeld');
    expect(REFERRAL_ENFORCEMENT_ACTION_EFFECTS.partner_termination).toContain('terminated');
  });

  it('sixteen prohibited conduct kinds, exactly the issues list', () => {
    expect(REFERRAL_PROHIBITED_CONDUCT_KINDS.length).toBe(16);
    expect(new Set(REFERRAL_PROHIBITED_CONDUCT_KINDS).size).toBe(16);
  });
});

describe('retention: raw evidence expires before financial records', () => {
  it('every class has a rule, exhaustively', () => {
    expect(Object.keys(REFERRAL_RETENTION_POLICY)).toHaveLength(REFERRAL_RETENTION_CLASSES.length);
    expect(REFERRAL_RETENTION_CLASSES.length).toBe(12);
  });

  it('the swept and financial classes PARTITION the twelve', () => {
    expect(
      REFERRAL_SWEPT_RETENTION_CLASSES.length + REFERRAL_FINANCIAL_RETENTION_CLASSES.length,
    ).toBe(REFERRAL_RETENTION_CLASSES.length);
    const swept = new Set<string>(REFERRAL_SWEPT_RETENTION_CLASSES);
    expect(REFERRAL_FINANCIAL_RETENTION_CLASSES.filter((cls) => swept.has(cls))).toEqual([]);
    // Both halves non-empty: a partition where one side is empty says nothing.
    expect(REFERRAL_SWEPT_RETENTION_CLASSES.length).toBeGreaterThan(0);
    expect(REFERRAL_FINANCIAL_RETENTION_CLASSES.length).toBeGreaterThan(0);
  });

  it('#148 acceptance 5: raw touch expires EARLIER than every swept class', () => {
    const raw = REFERRAL_RETENTION_POLICY.raw_touch.sweptAfterDays;
    expect(raw).not.toBeNull();
    for (const cls of REFERRAL_SWEPT_RETENTION_CLASSES) {
      if (cls === 'raw_touch') continue;
      expect(REFERRAL_RETENTION_POLICY[cls].sweptAfterDays).toBeGreaterThan(raw as number);
    }
    // And the financial classes are not swept at all, which is the other half
    // of "separate implemented retention policies".
    expect(REFERRAL_FINANCIAL_RETENTION_CLASSES).toContain('commission_and_ledger');
    expect(REFERRAL_RETENTION_POLICY.commission_and_ledger.sweptAfterDays).toBeNull();
  });

  it('every rule states its BASIS', () => {
    for (const cls of REFERRAL_RETENTION_CLASSES) {
      expect(REFERRAL_RETENTION_POLICY[cls].basis.length).toBeGreaterThan(20);
    }
  });
});


describe('the population every wall above is applied to (#460)', () => {
  it('nothing naming this sub-domain sits outside it', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: INTEGRITY_NAME_PATTERN,
      // Deliberately empty, and the assertion is what makes that a measurement:
      // every module the whole-tree sweep finds under this sub-domain's own name
      // is this sub-domain's.
      notThisDomain: [],
      expectedExclusions: 0,
      // Below today's 15 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 12,
      plantIn: 'lib',
      plantName: 'referral-integrity-cache.ts',
    });
  });

  it('the modules the owned-directory population could not reach are in it', () => {
    // An identity assertion, not a floor. A floor set below 15 is met without
    // either.
    const population = domainRelativePaths();
    for (const named of [
      'controllers/referral-integrity.controller.ts',
      'db/schema/referralIntegrity.ts',
    ]) {
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
    assertEachOf(['services/referrals/earnings/posting.service.ts', 'services/referrals/rewards/funding.ts', 'services/referrals/dashboard/disclosure.ts'], 3, (sibling) => {
      expect(
        statSync(join(SRC_ROOT, sibling)).isFile(),
        `${sibling} no longer exists, so excluding it proves nothing`,
      ).toBe(true);
      expect(INTEGRITY_NAME_PATTERN.test(sibling), `${sibling} matches this sub-domain's name`).toBe(false);
      expect(population, `${sibling} belongs to a sibling sub-domain`).not.toContain(sibling);
    });
    // …and the vacuity floor on the loop itself.
    expect(['services/referrals/earnings/posting.service.ts', 'services/referrals/rewards/funding.ts', 'services/referrals/dashboard/disclosure.ts'].length).toBeGreaterThanOrEqual(3);
  });

  it('floors PER SHAPE, because the sources break independently', () => {
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    const shared = namedInSharedDirectories(SHARED_DIRECTORIES, INTEGRITY_NAME_PATTERN);
    expect(owned.length, 'the owned-directory walk reached nothing').toBeGreaterThanOrEqual(11);
    expect(shared.length, 'the shared-directory name sweep reached nothing').toBeGreaterThanOrEqual(
      1,
    );
  });
});
