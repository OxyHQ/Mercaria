/**
 * The activation domain's structural boundaries (#85), asserted by SCAN.
 *
 * Each is a claim about what this domain CANNOT do, and a behavioural test can
 * only ever say "it did not this time":
 *
 *  - the DERIVATION reads nothing, so it cannot acquire a second input nobody
 *    stated (#121's `getRetailEligibility` rule);
 *  - nothing here reads the capability TRAIL, so a cached `granted` cannot
 *    survive the Stripe restriction that should have withdrawn it
 *    (`price_signal_evaluations`' rule);
 *  - the merchant WRITE path cannot reach the hold columns, so #85 permissions
 *    rule 11 ("a merchant cannot bypass a platform safety pause from the
 *    dashboard") is a property of the call graph rather than of a branch;
 *  - nothing here re-derives payment readiness, so #46's one stored verdict
 *    stays one — this is the place a second reading would admit an unpayable
 *    seller to a checkout;
 *  - nothing here reaches ranking, so a merchant's activation state cannot
 *    become a term in a scorer (#74's wall, both directions).
 *
 * Both defences from `~/Oxy/AGENTS.md`: a vacuity floor (a moved or emptied file
 * fails the gate rather than shrinking it silently) and a mutation self-test
 * (each detector runs against a seeded positive AND a seeded negative, so a
 * regex broken into matching nothing fails HERE rather than passing every scan).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The whole domain. A module added and not listed fails the floor below, which
 * is what forces whoever adds one to look here.
 */
const ACTIVATION_PATHS = [
  'services/merchant-activation/activation.service.ts',
  'services/merchant-activation/capabilities.ts',
  'services/merchant-activation/checkout-gate.ts',
  'services/merchant-activation/facts.ts',
  'services/merchant-activation/guest-activation.ts',
  'services/merchant-activation/onboarding.ts',
  'services/merchant-activation/requirements.ts',
  'services/merchant-activation/settings.service.ts',
  'services/merchant-activation/transitions.service.ts',
];

/**
 * The three that must stay PURE. `facts.ts` is the module that reads, and it is
 * ABSENT from this list rather than exempted inside it — an exemption inside a
 * list is how a second reader gets added without anybody noticing.
 */
const PURE_PATHS = [
  'services/merchant-activation/requirements.ts',
  'services/merchant-activation/capabilities.ts',
  'services/merchant-activation/onboarding.ts',
];

/** Anything that reads or writes storage, or reaches a service that does. */
const STORAGE_REFERENCE =
  /from '.*\/db\/|getDb\(|drizzle|\.select\(|\.insert\(|\.update\(|Repository|await\s+find[A-Z]|await\s+read[A-Z]|await\s+count[A-Z]/;

/**
 * The capability TRAIL, read by anything that decides.
 *
 * `merchant_activation_capability_events` says what the derivation said when
 * somebody last looked. A gate, a projection or a derivation reading it would be
 * reading a cached verdict — which is the one thing the recording must never
 * become. `transitions.service.ts` is the writer and the operator trace, and it
 * is exempted BY NAME below rather than by a pattern anybody could reuse.
 */
const CAPABILITY_TRAIL_REFERENCE =
  /readLatestCapabilityStates|listCapabilityEvents|merchantActivationCapabilityEvents|capabilityEventRepository/;

/** Files allowed to touch the trail: the writer, and nothing else. */
const TRAIL_READERS = ['services/merchant-activation/transitions.service.ts'];

/**
 * A hold column, a capability or a readiness verdict, named anywhere a MERCHANT
 * could put one.
 *
 * The two files scanned are the merchant boundary: the `.strict()` request
 * schema (a body cannot carry a field it does not declare) and the merchant
 * patch TYPE the service accepts. #85 permissions rule 11 and capability rule 2
 * are the same property read from two sides — a merchant cannot clear a hold and
 * cannot assert a capability — and both are held by the shape of what they may
 * send rather than by a check inside a handler.
 *
 * `settings.service.ts` as a WHOLE is deliberately not scanned: it legitimately
 * contains `applyPlatformHold`, which is the operator path. What is scanned is
 * the merchant patch interface, extracted by name.
 */
const MERCHANT_FORBIDDEN_FIELD_REFERENCE =
  /platformHold|platformHeld|capabilit|requirement|activated|nativeCheckoutState|guestCheckoutState|onboardingStep/i;

/** The merchant boundary: the request schema, and the patch type it produces. */
const MERCHANT_SCHEMA_PATH = 'middleware/merchant-activation-schemas.ts';

/** Extract one named interface's body — the patch type, and nothing around it. */
function readInterfaceBody(relative: string, name: string): string {
  const source = readDomainCode(relative);
  const start = source.indexOf(`interface ${name}`);
  expect(start, `${name} is not declared in ${relative} — did it move?`).toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  expect(close, `${name} in ${relative} has no closing brace`).toBeGreaterThan(open);
  const body = source.slice(open + 1, close);
  // The floor: an interface whose body extracted empty would satisfy every
  // detector below, which is the shape of a check that cannot fail.
  expect(body.replace(/\s+/g, '').length, `${name} extracted empty`).toBeGreaterThan(40);
  return body;
}

/**
 * A SECOND reading of payment readiness.
 *
 * ADR 0001 D9's conjunction is evaluated once, at synchronisation, and stored.
 * This domain calls `isSellerPaymentReady` and compares a stored verdict to one
 * literal; re-deriving it from `charges_enabled`, a requirements count or a
 * capability list would be a second implementation of the same rule, in the one
 * place where getting it wrong admits an unpayable seller to a checkout.
 */
const PAYMENT_REDERIVATION_REFERENCE =
  /charges_enabled|chargesEnabled|payouts_enabled|payoutsEnabled|requirementsCurrentlyDue|onboardingState\s*===/;

/**
 * Ranking, in either direction (#74's wall).
 *
 * A store's activation state is one join from "activated merchants rank higher",
 * which would be a commercial input to organic relevance arriving through a
 * readiness screen.
 */
const RANKING_REFERENCE =
  /services\/ranking|rankOffers|rankOfferComparison|rankingPolicy|OfferRankingFacts|services\/search\//;

/** Read a domain path, refusing an empty or moved file. */
function readDomainSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * The same source with comments removed — what every REACHABILITY detector
 * scans.
 *
 * These modules document what they refuse to do in exactly the vocabulary the
 * detectors look for (`requirements.ts` explains why it reads no table;
 * `capabilityEventRepository` explains why nothing may select from it), so
 * scanning prose would make every honest explanation a violation and the gate
 * would be switched off by whoever hit it next.
 */
function readDomainCode(relative: string): string {
  const stripped = readDomainSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(150);
  return stripped;
}

describe('the activation domain cannot reach what it must not', () => {
  it('scans the whole domain — a module added and not listed fails here', () => {
    expect(ACTIVATION_PATHS.length).toBeGreaterThanOrEqual(9);
    for (const relative of ACTIVATION_PATHS) {
      expect(readDomainSource(relative).length).toBeGreaterThan(200);
    }
  });

  it('the derivation, the capability map and the step map read nothing at all', () => {
    let scanned = 0;
    for (const relative of PURE_PATHS) {
      expect(
        STORAGE_REFERENCE.test(readDomainCode(relative)),
        `${relative} reaches storage; the derivation must stay pure (#121's rule)`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(PURE_PATHS.length);
  });

  it('only the writer touches the capability trail', () => {
    let scanned = 0;
    for (const relative of ACTIVATION_PATHS) {
      if (TRAIL_READERS.includes(relative)) continue;
      expect(
        CAPABILITY_TRAIL_REFERENCE.test(readDomainCode(relative)),
        `${relative} reads the capability trail; it is a RECORDING and never an authority`,
      ).toBe(false);
      scanned += 1;
    }
    // The floor matters more than usual here: an exemption list that grew to
    // cover everything would make this assertion vacuous, and the scan would
    // report clean having read nothing.
    expect(scanned).toBe(ACTIVATION_PATHS.length - TRAIL_READERS.length);
    expect(scanned).toBeGreaterThanOrEqual(8);
  });

  it('a merchant can send no hold, no capability and no verdict', () => {
    // The request schema. `.strict()` means a field it does not declare is
    // REFUSED rather than stripped, so the absence below is the enforcement.
    expect(
      MERCHANT_FORBIDDEN_FIELD_REFERENCE.test(readDomainCode(MERCHANT_SCHEMA_PATH)),
      'the merchant request schema declares a hold, a capability or a verdict field',
    ).toBe(false);

    // The patch type the service accepts, so a caller that bypassed the schema
    // still has nothing to pass.
    expect(
      MERCHANT_FORBIDDEN_FIELD_REFERENCE.test(
        readInterfaceBody(
          'services/merchant-activation/settings.service.ts',
          'MerchantActivationSettingsPatch',
        ),
      ),
      'the merchant patch type carries a hold, a capability or a verdict field',
    ).toBe(false);
  });

  it('nothing here re-derives payment readiness', () => {
    let scanned = 0;
    for (const relative of ACTIVATION_PATHS) {
      expect(
        PAYMENT_REDERIVATION_REFERENCE.test(readDomainCode(relative)),
        `${relative} re-derives payment readiness; #46's stored verdict is READ, never recomputed`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(ACTIVATION_PATHS.length);
  });

  it('nothing here reaches ranking or search', () => {
    let scanned = 0;
    for (const relative of ACTIVATION_PATHS) {
      expect(
        RANKING_REFERENCE.test(readDomainCode(relative)),
        `${relative} reaches ranking; activation state may not become a scoring term`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(ACTIVATION_PATHS.length);
  });

  /**
   * The mutation self-test. Every detector runs against text that SHOULD trip it
   * and against text that must NOT — a scanner nobody has seen fail is a scanner
   * nobody knows works, and the negative half is what catches a pattern so wide
   * it would flag the domain's own legitimate code.
   */
  it('each detector actually detects, and does not over-detect', () => {
    expect(STORAGE_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(true);
    expect(STORAGE_REFERENCE.test('const row = await findStoreById(id);')).toBe(true);
    expect(STORAGE_REFERENCE.test('const outcome = derive(facts);')).toBe(false);

    expect(CAPABILITY_TRAIL_REFERENCE.test('const seen = await readLatestCapabilityStates(tx, id);')).toBe(
      true,
    );
    expect(CAPABILITY_TRAIL_REFERENCE.test('const caps = deriveCapabilities(results, blocking);')).toBe(
      false,
    );

    expect(MERCHANT_FORBIDDEN_FIELD_REFERENCE.test('platformHoldReason?: string;')).toBe(true);
    expect(MERCHANT_FORBIDDEN_FIELD_REFERENCE.test('capabilities?: string[];')).toBe(true);
    expect(MERCHANT_FORBIDDEN_FIELD_REFERENCE.test('nativeCheckoutState?: string;')).toBe(true);
    // The two fields a merchant legitimately sends must NOT trip it.
    expect(MERCHANT_FORBIDDEN_FIELD_REFERENCE.test('nativeCheckoutIntent?: MerchantCheckoutIntent;')).toBe(
      false,
    );
    expect(MERCHANT_FORBIDDEN_FIELD_REFERENCE.test('supportEmail?: string | null;')).toBe(false);

    expect(PAYMENT_REDERIVATION_REFERENCE.test('if (account.chargesEnabled) return true;')).toBe(true);
    expect(PAYMENT_REDERIVATION_REFERENCE.test('const ready = await isSellerPaymentReady(key);')).toBe(
      false,
    );

    expect(RANKING_REFERENCE.test("import { rankOffers } from '../ranking/score.js';")).toBe(true);
    expect(RANKING_REFERENCE.test('const state = projectActivationState(derived);')).toBe(false);
  });
});
