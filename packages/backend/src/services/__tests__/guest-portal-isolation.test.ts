/**
 * The guest order portal's structural boundaries (#108), asserted by SCAN
 * rather than by fixture.
 *
 * Each of these is a claim about what the portal path CANNOT do, and a
 * behavioural test can only ever say "it did not this time". A module that
 * cannot read a feature flag cannot be switched off by one; a module that
 * cannot reach the plaintext-decrypt function cannot leak an address; a router
 * with no scope field cannot be handed one. That is the argument
 * `cart-merge-isolation.test.ts` and `checkout-contact-isolation.test.ts` make,
 * and this scanner carries the same two defences from `~/Oxy/AGENTS.md`: a
 * VACUITY FLOOR (a moved or emptied file fails the gate instead of shrinking it
 * silently) and a MUTATION SELF-TEST (each detector runs against a seeded
 * positive, so a broken regex cannot pass by matching nothing).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every module a portal REQUEST passes through. A new module in this path
 * belongs on the list — the vacuity floor is what forces whoever adds one to
 * look here.
 */
const PORTAL_PATHS = [
  'routes/guest-orders.ts',
  'middleware/guest-portal.ts',
  'services/guest-portal/grant.service.ts',
  'services/guest-portal/grant-token.ts',
  'services/guest-portal/scopes.ts',
  'services/guest-portal/portal.service.ts',
  'services/guest-portal/recovery.service.ts',
  'services/guest-portal/templates.ts',
  'services/guest-portal/transport.ts',
  'services/guest-portal/message.service.ts',
  'services/guest-portal/operator.service.ts',
  'db/guestPortal/grantRepository.ts',
  'db/guestPortal/messageRepository.ts',
  'db/guestPortal/suppressionRepository.ts',
  'db/guestPortal/recoveryAttemptRepository.ts',
  'db/guestPortal/operatorActionRepository.ts',
  'db/guestPortal/contactRoutingRepository.ts',
];

/**
 * The READ path specifically — the modules that must keep serving a placed
 * guest order when guest commerce is switched off (#108 acceptance 10,
 * ADR 0003 M8).
 *
 * `routes/guest-orders.ts` is deliberately EXCLUDED: it reads
 * `config.guest.portal.magicLinkBaseUrl` for its exported base-URL accessor,
 * which is portal configuration and not a guest LEVER. The distinction the gate
 * enforces is the levers, named individually below, rather than the whole
 * `config.guest` namespace — a namespace ban would be a gate nobody could
 * satisfy without moving the portal's own settings somewhere arbitrary.
 */
const PORTAL_READ_PATHS = [
  'middleware/guest-portal.ts',
  'services/guest-portal/grant.service.ts',
  'services/guest-portal/portal.service.ts',
  'services/guest-portal/recovery.service.ts',
];

/**
 * The four guest LEVERS. None of them may gate a portal read.
 *
 * `GUEST_COMMERCE_ENABLED` off must stop new sessions and new guest checkouts
 * and must NOT strand a person who already paid — which is the exact moment
 * they would be trying to find their order.
 */
const GUEST_LEVER_REFERENCE =
  /guest\.enabled|guest\.issuanceEnabled|guest\.cartEnabled|guest\.inlineDestinationEnabled/;

/**
 * The plaintext decrypt. Permitted in exactly ONE module — the send path — and
 * forbidden everywhere else, so "who can read a guest's address" stays a
 * question answered by grepping one function name (`lib/guest-pii.ts`'s own
 * docblock makes that promise; this is what keeps it true).
 */
const DECRYPT_REFERENCE = /decryptGuestPii/;

/** The one module that may decrypt, because sending is what decryption is for. */
const DECRYPT_ALLOWED = 'services/guest-portal/message.service.ts';

/**
 * A client-supplied SCOPE. #108 magic-link rule 7 asks that scope be bound
 * server-side "rather than trusting URL parameters", and the strongest form is
 * having nowhere for one to arrive — no request schema, query read or body
 * field anywhere in the path may mention one.
 */
const CLIENT_SCOPE_REFERENCE =
  /req\.(?:body|query|params)\s*\.\s*scopes?\b|scopes:\s*z\.|scope:\s*z\./;

/**
 * A caller-supplied DESTINATION for a message. ADR 0003 T15 and #108 recovery
 * rule 4: a re-send goes to the stored contact and a caller may never replace
 * it, which is unrepresentable rather than refused.
 */
const CALLER_DESTINATION_REFERENCE =
  /req\.(?:body|query)\s*\.\s*(?:to|destination|recipient|sendTo|deliverTo)\b/;

/**
 * The forbidden ecosystem spellings this repo excludes twice over. `FAIR` the
 * CURRENCY CODE is not in the pattern: it is the marketplace's preferred
 * presentment currency and appears legitimately wherever money does.
 */
const OXYPAY_OR_FAIRCOIN_REFERENCE = /oxy_?[Pp]ay|OxyPay|[Ff]air[Cc]oin/;

/**
 * The referral domain. Attribution belongs to #141/#143 entirely: reading an
 * order through a magic link creates none, resolves none and extends no window.
 */
const REFERRAL_REFERENCE =
  /referrals?\/|referralAttribution|referral_attributions|referral_touches|partnerId/;

/** Read a path in the portal set, refusing an empty or moved file. */
function readPortalSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * Source with comments stripped.
 *
 * These modules DOCUMENT what they refuse to do in the same vocabulary the
 * detectors use — `transport.ts` explains why no destination is accepted,
 * `scopes.ts` explains why no scope arrives from a client — so a scan over raw
 * text would fail on the prose that proves the rule is understood. The
 * `checkout-contact-isolation.test.ts` decision, verbatim.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('guest portal isolation (static)', () => {
  it('scans every module in the portal path', () => {
    // The vacuity floor. A gate that scanned nothing would pass every assertion
    // below, and the shape of that failure — a moved file, a renamed directory
    // — is exactly the one nobody notices.
    expect(PORTAL_PATHS.length).toBeGreaterThanOrEqual(16);
    for (const path of PORTAL_PATHS) {
      expect(readPortalSource(path).length).toBeGreaterThan(200);
    }
  });

  it('no portal READ path is gated by a guest feature lever', () => {
    // #108 acceptance 10 / ADR 0003 M8. Turning guest commerce off stops
    // issuance and new guest checkouts; a person who already paid keeps their
    // order, their link and their portal.
    for (const path of PORTAL_READ_PATHS) {
      expect(
        GUEST_LEVER_REFERENCE.test(stripComments(readPortalSource(path))),
        `${path} reads a guest feature lever; a placed guest order must stay reachable`,
      ).toBe(false);
    }
  });

  it('only the send path can decrypt a stored contact', () => {
    for (const path of PORTAL_PATHS) {
      if (path === DECRYPT_ALLOWED) continue;
      expect(
        DECRYPT_REFERENCE.test(stripComments(readPortalSource(path))),
        `${path} reaches the plaintext decrypt; only ${DECRYPT_ALLOWED} may`,
      ).toBe(false);
    }
    // The positive half: the one module that MAY decrypt actually does, so this
    // assertion cannot pass by the function having been renamed out of
    // existence everywhere.
    expect(DECRYPT_REFERENCE.test(readPortalSource(DECRYPT_ALLOWED))).toBe(true);
  });

  it('no request may supply a scope or a message destination', () => {
    for (const path of PORTAL_PATHS) {
      const source = stripComments(readPortalSource(path));
      expect(
        CLIENT_SCOPE_REFERENCE.test(source),
        `${path} reads a scope from a request; scope is bound server-side (#108 rule 7)`,
      ).toBe(false);
      expect(
        CALLER_DESTINATION_REFERENCE.test(source),
        `${path} reads a destination from a request; a message goes to the stored contact only`,
      ).toBe(false);
    }
  });

  it('the portal reaches neither OxyPay/FairCoin nor the referral domain', () => {
    for (const path of PORTAL_PATHS) {
      const source = readPortalSource(path);
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(source),
        `${path} mentions OxyPay or FairCoin`,
      ).toBe(false);
      expect(
        REFERRAL_REFERENCE.test(stripComments(source)),
        `${path} reaches the referral domain; attribution is #141/#143's entirely`,
      ).toBe(false);
    }
  });

  /**
   * The mutation self-test.
   *
   * Every detector above is run against a seeded POSITIVE. Without this, a
   * regex that matches nothing — a renamed symbol, a typo, a character class
   * that quietly excludes `_` — passes every assertion above and reports a
   * clean scan of a broken rule. `~/Oxy/AGENTS.md` (C): a check that cannot
   * distinguish success from failure is worse than no check.
   */
  it('every detector fires on a seeded positive', () => {
    expect(GUEST_LEVER_REFERENCE.test('if (config.guest.cartEnabled) return;')).toBe(true);
    expect(GUEST_LEVER_REFERENCE.test('if (config.guest.enabled) return;')).toBe(true);
    expect(DECRYPT_REFERENCE.test('const email = decryptGuestPii(row.emailCiphertext);')).toBe(
      true,
    );
    expect(CLIENT_SCOPE_REFERENCE.test('const s = req.body.scopes;')).toBe(true);
    expect(CLIENT_SCOPE_REFERENCE.test('const schema = z.object({ scopes: z.array(z.string()) });')).toBe(
      true,
    );
    expect(CALLER_DESTINATION_REFERENCE.test('const to = req.body.to;')).toBe(true);
    expect(CALLER_DESTINATION_REFERENCE.test('sendTo(req.query.destination);')).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('await oxyPay.charge()')).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('// FairCoin settlement')).toBe(true);
    expect(REFERRAL_REFERENCE.test("import { x } from '../referrals/attribution.js';")).toBe(true);
    // And the comment stripper really strips, so the "documented refusal"
    // exemption is a real mechanism rather than a hope.
    expect(stripComments('// decryptGuestPii is forbidden here\nconst x = 1;')).not.toMatch(
      DECRYPT_REFERENCE,
    );
    expect(stripComments('/** never decryptGuestPii */\nconst x = 1;')).not.toMatch(
      DECRYPT_REFERENCE,
    );
  });
});
