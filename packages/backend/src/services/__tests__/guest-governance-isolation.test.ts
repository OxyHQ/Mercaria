/**
 * The guest-governance domain's structural boundaries (#111), asserted by SCAN
 * and by TUPLE rather than by fixture.
 *
 * Each is a claim about what this domain CANNOT do, and a behavioural test can
 * only ever say "it did not this time". A module that cannot read a user agent
 * cannot fingerprint a device; a domain with no `ranking_demotion` measure
 * cannot demote anybody; a lever nothing durable reads cannot strand a paid
 * order. `fee-ranking-isolation.test.ts` is the precedent and the scanner
 * carries the same two defences: a vacuity FLOOR, so a moved or emptied file
 * fails the gate instead of shrinking it silently, and a mutation SELF-TEST, so
 * a broken regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GUEST_ABUSE_AXES,
  GUEST_ABUSE_POLICIES,
  GUEST_FEATURE_GATE_REGISTER,
  GUEST_FORBIDDEN_ABUSE_SIGNALS,
  GUEST_FORBIDDEN_FRICTION_MEASURES,
  GUEST_FRICTION_MEASURES,
  GUEST_LAUNCH_GATE_REGISTER,
  GUEST_LAUNCH_GATES,
  GUEST_RETENTION_CLASSES,
  GUEST_RETENTION_SCHEDULE,
  GUEST_SECURITY_SIGNAL_REGISTER,
  GUEST_SECURITY_SIGNALS,
} from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The whole domain — scanned as a DIRECTORY, so the walls hold for modules nobody has written yet. */
const DOMAIN_DIRS = ['services/guest-governance', 'db/guestGovernance'];

/** The modules outside those directories that are still part of the domain. */
const DOMAIN_FILES = [
  'controllers/guest-governance.controller.ts',
  'routes/internal-guest-governance.ts',
  'db/schema/guestGovernance.ts',
];

/**
 * Reading a DEVICE (#111 abuse control 1: "layered controls that avoid device
 * fingerprinting").
 *
 * The prohibition is about what this domain may be GIVEN, so the detector looks
 * for the reads rather than for a word: a user agent, a fingerprint of any
 * kind, a canvas or font signature, and screen metrics. A raw IP address is on
 * the list too — `networkRangeOf` truncates before anything is hashed, and a
 * module that stored `req.ip` directly would have defeated that.
 */
const DEVICE_REFERENCE =
  /user-?agent|userAgent|fingerprint|canvasHash|fontList|screenWidth|screenHeight|deviceId|req\.ip\b/i;

/**
 * Reaching the RANKING, FEE or REFERRAL domains (#111 acceptance 6, abuse
 * controls 12 and 13).
 *
 * "Guest status alone does not reduce service, ranking or merchant visibility"
 * is not something a behavioural test can establish. What can be established is
 * that no module here can reach the code that would do it — and that no
 * commercial relationship can enter an abuse decision, which is the same wall
 * the ranking domain already has in the other direction.
 */
const COMMERCIAL_REFERENCE =
  /services\/ranking|rankOffers|ranking_policy|services\/fees|fee_schedules|services\/referrals|referral_attributions|commissionBps/;

/**
 * Reading a PROVIDER IDENTITY (#111 abuse controls 8 and 13, acceptance 12).
 *
 * Stripe groups payments for its own purposes and those groupings are not
 * Mercaria identity. Reusing a per-payment risk OUTCOME is permitted and is a
 * different thing; a Customer, a Link identity, a wallet or a card fingerprint
 * is what may never become a subject.
 */
const PROVIDER_IDENTITY_REFERENCE =
  /stripeCustomer|customer_id|paymentMethodFingerprint|cardFingerprint|walletIdentity|linkIdentity/i;

/** Every file in the domain, with its path, for the floor and the scans. */
function domainSources(): readonly { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const dir of DOMAIN_DIRS) {
    const absolute = join(SRC_ROOT, dir);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      files.push({
        path: `${dir}/${entry.name}`,
        text: readFileSync(join(absolute, entry.name), 'utf8'),
      });
    }
  }
  for (const path of DOMAIN_FILES) {
    files.push({ path, text: readFileSync(join(SRC_ROOT, path), 'utf8') });
  }
  return files;
}

/**
 * Comment-stripped source.
 *
 * These modules DOCUMENT what they refuse to do, in the same vocabulary the
 * detectors look for — `subject.ts` explains at length that it never takes a
 * user agent — so a scan over raw text would fail on the explanation. The
 * `checkout-contact-isolation.test.ts` decision, for its reason.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the guest-governance domain cannot fingerprint, rank or correlate (#111)', () => {
  const sources = domainSources();

  it('scans a real, non-trivial set of files (vacuity floor)', () => {
    // Fourteen at the time of writing. The floor is what makes a moved or
    // emptied module fail the gate instead of shrinking it silently — a scan
    // over zero files passes every assertion below.
    expect(sources.length).toBeGreaterThanOrEqual(10);
    expect(sources.every((source) => source.text.length > 200)).toBe(true);
  });

  it('reads no device signal anywhere', () => {
    const offenders = sources
      .filter((source) => DEVICE_REFERENCE.test(withoutComments(source.text)))
      .map((source) => source.path);
    expect(offenders).toEqual([]);
  });

  it('cannot reach the ranking, fee or referral domains', () => {
    const offenders = sources
      .filter((source) => COMMERCIAL_REFERENCE.test(withoutComments(source.text)))
      .map((source) => source.path);
    expect(offenders).toEqual([]);
  });

  it('cannot read a provider identity', () => {
    const offenders = sources
      .filter((source) => PROVIDER_IDENTITY_REFERENCE.test(withoutComments(source.text)))
      .map((source) => source.path);
    expect(offenders).toEqual([]);
  });

  /**
   * The mutation self-test. Every detector above is run against text that
   * genuinely contains what it looks for, so a regex broken into matching
   * nothing cannot pass three assertions by finding no offenders.
   */
  it('each detector actually detects (mutation self-test)', () => {
    expect(DEVICE_REFERENCE.test('const ua = req.headers["user-agent"];')).toBe(true);
    expect(DEVICE_REFERENCE.test('const key = deviceId;')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { rankOffers } from '../ranking/rank.js';")).toBe(
      true,
    );
    expect(PROVIDER_IDENTITY_REFERENCE.test('const subject = stripeCustomerId;')).toBe(true);
    // And a NEGATIVE control: the ordinary vocabulary of this domain must not
    // trip any of them, or the gate is one somebody disables the first time
    // they hit it.
    expect(DEVICE_REFERENCE.test('const subjectHash = abuseSubjectHash({ scope, axis, value });')).toBe(
      false,
    );
    expect(COMMERCIAL_REFERENCE.test('const verdict = await checkGuestAbuse(input);')).toBe(false);
  });
});

describe('the abuse vocabulary makes the forbidden signals unrepresentable (#111)', () => {
  it('permitted axes and forbidden signals are DISJOINT', () => {
    const overlap = GUEST_ABUSE_AXES.filter((axis) =>
      (GUEST_FORBIDDEN_ABUSE_SIGNALS as readonly string[]).includes(axis),
    );
    expect(overlap).toEqual([]);
  });

  it('permitted friction and forbidden responses are DISJOINT', () => {
    const overlap = GUEST_FRICTION_MEASURES.filter((measure) =>
      (GUEST_FORBIDDEN_FRICTION_MEASURES as readonly string[]).includes(measure),
    );
    expect(overlap).toEqual([]);
  });

  it('names the four signals #111 forbids by NAME, so a future addition fails here', () => {
    // Rules 11, 12 and 13 name these specifically. A tuple that quietly lost one
    // would leave the disjointness assertions above passing while the thing they
    // exist to forbid became permitted.
    for (const signal of [
      'guest_status',
      'stripe_customer_grouping',
      'affiliate_commission',
      'merchant_plan',
    ]) {
      expect(GUEST_FORBIDDEN_ABUSE_SIGNALS).toContain(signal);
    }
  });

  it('every abuse policy keys on a permitted axis and applies a permitted measure', () => {
    for (const policy of GUEST_ABUSE_POLICIES) {
      expect(GUEST_ABUSE_AXES).toContain(policy.axis);
      expect(GUEST_FRICTION_MEASURES).toContain(policy.measure);
      expect(policy.threshold).toBeGreaterThan(0);
      expect(policy.windowSeconds).toBeGreaterThan(0);
      expect(policy.rationale.length).toBeGreaterThan(40);
    }
  });

  it('the recovery policy is keyed on the NETWORK, never on an inbox', () => {
    // #108 answers every recovery request with the same 202 whether or not an
    // inbox matched. A counter keyed on `email_hash` here would rebuild the
    // enumeration oracle that uniform answer exists to close, because the
    // COUNT would differ for an address that exists.
    const recovery = GUEST_ABUSE_POLICIES.find((policy) => policy.pattern === 'recovery_spraying');
    expect(recovery?.axis).toBe('network_range');
  });
});

describe('no feature gate reaches a placed order (#111 acceptance 7 and 13)', () => {
  it('every registered gate declares that it cannot affect a placed order', () => {
    for (const gate of GUEST_FEATURE_GATE_REGISTER) {
      expect(gate.affectsPlacedOrders).toBe(false);
    }
  });

  it('the four STRUCTURAL gates name no lever, and every other names one', () => {
    const structural = GUEST_FEATURE_GATE_REGISTER.filter((gate) => gate.lever === null);
    expect(structural.map((gate) => gate.gate).sort()).toEqual([
      'order_portal',
      'p2p',
      'pickup',
      'stripe_client_path',
    ]);
    for (const gate of structural) {
      // A structural absence must EXPLAIN itself. A gate with no lever and no
      // stated reason is indistinguishable from one somebody forgot to wire.
      expect(gate.whenOff).toContain('STRUCTURAL');
    }
    for (const gate of GUEST_FEATURE_GATE_REGISTER.filter((entry) => entry.lever !== null)) {
      expect(gate.lever).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  it('the rollback order is defined for every gate', () => {
    for (const gate of GUEST_FEATURE_GATE_REGISTER) {
      expect(gate.rollbackOrder).toBeGreaterThan(0);
    }
    // Issuance goes off FIRST — it is the only lever that stops the population
    // growing, and every other lever is more useful while it is off.
    const issuance = GUEST_FEATURE_GATE_REGISTER.find((gate) => gate.gate === 'session_issuance');
    expect(issuance?.rollbackOrder).toBe(1);
  });
});

describe('the registers are complete and self-consistent (#111)', () => {
  it('every retention class has exactly one schedule entry', () => {
    expect(GUEST_RETENTION_SCHEDULE.map((entry) => entry.retentionClass).sort()).toEqual(
      [...GUEST_RETENTION_CLASSES].sort(),
    );
  });

  it('a class that is never deleted carries NO figure', () => {
    for (const entry of GUEST_RETENTION_SCHEDULE) {
      // The IMPLICATION the CHECK states, and not a biconditional — the
      // correction the first run of this test forced. A `none` mechanism
      // carrying a TTL is a contradiction whichever half a reader believes; a
      // SWEEP with no fixed offset is legitimate and common, because the
      // deadline may already be stamped on the row (`expiryTargets.ts`'s
      // `retentionSeconds: 0`) or the row may leave by CASCADE with its parent.
      if (entry.mechanism === 'none') expect(entry.retentionSeconds).toBeNull();
      expect(entry.rationale.length).toBeGreaterThan(40);
      expect(entry.clock.length).toBeGreaterThan(3);
    }
  });

  it('the three classes with a sweep and NO fixed offset each explain why', () => {
    // The fixture that exercises the distinction the check above exists to
    // make. Without it the implication is satisfied vacuously by a schedule in
    // which every sweep happens to carry a figure — which is precisely the
    // tidy-fixture failure `~/Oxy/AGENTS.md` (E) describes, and which is how
    // the biconditional survived being written in the first place.
    const offsetless = GUEST_RETENTION_SCHEDULE.filter(
      (entry) => entry.mechanism !== 'none' && entry.retentionSeconds === null,
    );
    expect(offsetless.map((entry) => entry.retentionClass).sort()).toEqual([
      'abandoned_cart',
      'access_grant_and_portal_session',
      'aggregated_analytics',
    ]);
    for (const entry of offsetless) {
      expect(entry.clock).not.toBe('none');
    }
  });

  it('the transaction records are exempt from every sweep, deliberately', () => {
    // #111 retention rule 3. An entry that acquired a figure would put a cart
    // TTL in front of a statutory record, which is the failure the rule names.
    const transaction = GUEST_RETENTION_SCHEDULE.find(
      (entry) => entry.retentionClass === 'transaction_record',
    );
    expect(transaction?.mechanism).toBe('none');
    expect(transaction?.retentionSeconds).toBeNull();
  });

  it('a lookup hash never outlives the value it digests', () => {
    // #111 retention rule 5: a hash is not anonymous while it can still support
    // lookup. Equal retentions are what make "it leaves with the ciphertext"
    // true rather than approximately true.
    const hash = GUEST_RETENTION_SCHEDULE.find((entry) => entry.retentionClass === 'lookup_hash');
    const contact = GUEST_RETENTION_SCHEDULE.find(
      (entry) => entry.retentionClass === 'plaintext_equivalent_contact',
    );
    expect(hash?.retentionSeconds).toBe(contact?.retentionSeconds);
  });

  it('every security signal has a definition and safe handles only', () => {
    expect(GUEST_SECURITY_SIGNAL_REGISTER.map((entry) => entry.signal).sort()).toEqual(
      [...GUEST_SECURITY_SIGNALS].sort(),
    );
    for (const entry of GUEST_SECURITY_SIGNAL_REGISTER) {
      expect(entry.correlationKinds.length).toBeGreaterThan(0);
      expect(entry.meaning.length).toBeGreaterThan(40);
    }
  });

  it('every signal RESOLVES to a real runbook section', () => {
    // A slug asserted only for its SHAPE is the same failure as no slug at all,
    // arriving later and looking fine — an on-call engineer follows it to a 404
    // during the incident it was written for. This reads the file.
    const runbook = readFileSync(
      join(SRC_ROOT, '..', '..', '..', 'docs', 'runbooks', '60-guest-commerce-signals.md'),
      'utf8',
    );
    // Vacuity floor: an empty or truncated file would satisfy nothing below,
    // but a file that failed to READ would throw rather than pass — which is
    // the behaviour wanted, and the floor covers the case where it reads and is
    // a stub.
    expect(runbook.length).toBeGreaterThan(4000);
    const missing: string[] = [];
    for (const entry of GUEST_SECURITY_SIGNAL_REGISTER) {
      const [file, anchor] = entry.runbook.split('#');
      expect(file, `${entry.signal} names no runbook file`).toBe('guest-commerce-signals');
      if (anchor === undefined || !runbook.includes(`## \`${anchor}\``)) {
        missing.push(entry.signal);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the runbook anchor check actually detects a missing section (mutation self-test)', () => {
    const runbook = '# a runbook\n\n## `guest_token_verification_failure`\n\nwords\n';
    expect(runbook.includes('## `guest_token_verification_failure`')).toBe(true);
    expect(runbook.includes('## `cleanup_lag`')).toBe(false);
  });

  it('every launch gate has a definition, and every automated one names a criterion', () => {
    expect(GUEST_LAUNCH_GATE_REGISTER.map((entry) => entry.gate).sort()).toEqual(
      [...GUEST_LAUNCH_GATES].sort(),
    );
    for (const entry of GUEST_LAUNCH_GATE_REGISTER) {
      expect(entry.criterion.length).toBeGreaterThan(30);
    }
  });

  it('the two gates blocked by an unbuilt dependency SAY SO', () => {
    // Honesty rule: a gate that cannot be satisfied on any deployment today
    // must name what blocks it, or somebody signs it off to make the dashboard
    // green. Mercaria has no outbound mail transport and no #85 activation
    // state, and both are recorded rather than quietly satisfiable.
    const blocked = GUEST_LAUNCH_GATE_REGISTER.filter((entry) => entry.blockedBy !== undefined);
    expect(blocked.map((entry) => entry.gate).sort()).toEqual([
      'merchant_readiness_includes_guest',
      'transactional_sender_authenticated',
    ]);
  });
});
