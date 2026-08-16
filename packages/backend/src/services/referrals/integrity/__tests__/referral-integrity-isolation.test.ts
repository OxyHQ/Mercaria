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
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

const HERE = dirname(fileURLToPath(import.meta.url));
const INTEGRITY_DIR = join(HERE, '..');
const INTEGRITY_DB_DIR = join(HERE, '..', '..', '..', '..', 'db', 'referralIntegrity');

/** Every `.ts` under a directory, excluding its own tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...sourceFiles(path));
      continue;
    }
    if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
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

const FILES = [...sourceFiles(INTEGRITY_DIR), ...sourceFiles(INTEGRITY_DB_DIR)];

interface Wall {
  name: string;
  pattern: RegExp;
  /** A source fragment the pattern MUST match — the mutation self-test. */
  positive: string;
  /** A fragment it must NOT match: something this domain legitimately does. */
  negative: string;
}

const WALLS: readonly Wall[] = [
  {
    name: 'a device, network or contact identifier',
    // The one class #148 boundary 2 forbids and a fraud detector most wants.
    pattern:
      /\b(ipAddress|ip_address|remoteAddress|userAgent|user_agent|deviceFingerprint|device_fingerprint|canvasFingerprint|tlsFingerprint|advertisingIdentifier|cardFingerprint|card_fingerprint|stripeCustomerId|stripe_customer_id|paymentMethodId|emailHash|email_hash|phoneNumber|phone_number)\b/,
    positive: 'const key = buildKey(request.ipAddress, request.userAgent);',
    negative: 'const facts = { merchantMembershipOverlap: true, capRefusalCount: 3 };',
  },
  {
    name: 'the payment domain',
    // A path SEGMENT, never a `services/`-anchored prefix: every module here
    // would write the RELATIVE `'../../payments/x.js'`, which an anchored
    // pattern never sees. #125's isolation gate shipped that gap and its own
    // mutation self-test caught it; this one caught the same thing on its first
    // run, which is the whole argument for having the self-test.
    pattern: /from\s+['"][^'"]*[/']((services\/)?payments|db\/payments|stripe)\//,
    positive: "import { x } from '../payments/ledger.js';",
    negative: "import { y } from '../../../db/referrals/partnerRepository.js';",
  },
  {
    name: 'ranking, search, discovery or a feed',
    pattern: /from\s+['"][^'"]*[/']((services\/)?(ranking|search|offers|feed-import))\//,
    positive: "import { rankOffers } from '../../ranking/score.js';",
    negative: "import { getDb } from '../../../db/postgres.js';",
  },
  {
    name: 'the retail, procurement or supplier domain',
    pattern:
      /from\s+['"][^'"]*[/'](retail-pricing|retail-checkout|retail-pilot|retail-eligibility|supplier-preflight|supplier-orders|procurement)\//,
    positive: "import { z } from '../../retail-pricing/compose.js';",
    negative: "import { conflict } from '../../../lib/errors/error-codes.js';",
  },
  {
    name: 'OxyPay or FairCoin, anywhere in the integrity domain',
    // RAW source rather than comment-stripped: a claim in a comment is a
    // sentence somebody pastes into a screen next week (#81's reasoning).
    pattern: /\b(oxy_?pay|oxypay|faircoin|FAIR_?COIN)\b/i,
    positive: 'const rail = "oxypay";',
    negative: 'const currency = reward.currency;',
  },
  {
    name: 'an outbound HTTP call',
    // A fraud domain reaching a third-party reputation or identity service is
    // the cross-product graph arriving through somebody else's API.
    pattern: /\b(safeFetch|fetch\s*\(|axios|got\s*\(|https?\.request)\b/,
    positive: 'const res = await safeFetch(url);',
    negative: 'const rows = await findLiveEnforcementActions(db, partnerId);',
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
      expect(wall.pattern.test(wall.positive)).toBe(true);
      expect(wall.pattern.test(wall.negative)).toBe(false);
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
