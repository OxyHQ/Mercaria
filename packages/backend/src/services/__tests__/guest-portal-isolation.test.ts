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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every `.ts` under `relative`, recursively, excluding the test tree. */
function walk(relative: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(SRC_ROOT, relative), { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(child));
    else if (entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
}

/**
 * The portal's HTTP surface, derived from the filename convention these flat
 * directories already follow (#472's device): the router, its middleware and
 * the operator controller.
 */
function httpSurface(): string[] {
  return ['controllers', 'routes', 'middleware'].flatMap((directory) =>
    readdirSync(join(SRC_ROOT, directory), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .filter((entry) => /^guest-(portal|orders)/.test(entry.name))
      .map((entry) => `${directory}/${entry.name}`),
  );
}

/**
 * Every module a portal REQUEST passes through, WALKED rather than listed
 * (#460).
 *
 * The list this replaces named 17 modules and the walk finds 18: it omitted
 * `controllers/guest-portal-operator.controller.ts`, so the operator surface —
 * the one place a Mercaria employee touches a buyer's portal — was behind none
 * of the walls below. That is #472's `ebay-isolation` finding again, and it is
 * the reason a list whose comment claims completeness is worse than no comment.
 */
const PORTAL_PATHS = [...walk('services/guest-portal'), ...walk('db/guestPortal'), ...httpSurface()];

/**
 * The READ path — the modules that must keep serving a placed guest order when
 * guest commerce is switched off (#108 acceptance 10, ADR 0003 M8).
 *
 * DERIVED as the whole domain, which is a widening: the list this replaces named
 * four modules of eighteen. No module in the domain reads one of the four levers
 * (measured), so the stronger statement — *nothing in the portal is gated by a
 * guest lever* — is the one that holds today, and a module added tomorrow is
 * held to it by default rather than landing outside every wall.
 *
 * The distinction the detector draws is still levers versus portal CONFIGURATION:
 * `routes/guest-orders.ts` reads `config.guest.portal.magicLinkBaseUrl` for its
 * base-URL accessor, which is a setting rather than a switch. A ban on the whole
 * `config.guest` namespace would be a gate nobody could satisfy without moving
 * the portal's own settings somewhere arbitrary, so `GUEST_LEVER_REFERENCE`
 * names the four switches individually.
 *
 * The fifth lever, `GUEST_PORTAL_MESSAGE_DELIVERY_ENABLED`, gates the dispatcher
 * LOOP and never a row, and is deliberately not among the four.
 */
const PORTAL_READ_PATHS = PORTAL_PATHS;

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
    // Vacuity floors PER SHAPE rather than one on the total: the three sources
    // break independently, and one total would let a walk collapse to zero while
    // the others carried the number. Each is today's count, so a SHRINK stops
    // the build.
    const from = (prefix: string) => PORTAL_PATHS.filter((path) => path.startsWith(prefix)).length;
    expect(from('services/guest-portal/'), 'the service walk found nothing').toBeGreaterThanOrEqual(9);
    expect(from('db/guestPortal/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(6);
    expect(httpSurface().length, 'the HTTP surface derivation found nothing').toBeGreaterThanOrEqual(3);
    expect(PORTAL_PATHS.length).toBeGreaterThanOrEqual(18);

    // The walk really reads the disk, and no test file enters the scanned set.
    for (const path of PORTAL_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }
    expect(PORTAL_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);

    // The one permitted decrypt must still BE in the domain: an exemption naming
    // a module the walk no longer finds excuses nothing while looking like a
    // decision.
    expect(PORTAL_PATHS, `${DECRYPT_ALLOWED} is exempted but is not in the domain`).toContain(
      DECRYPT_ALLOWED,
    );
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
