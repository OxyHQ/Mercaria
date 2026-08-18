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

/** A directory entry, as `readdirSync(..., { withFileTypes: true })` reports one. */
type DirectoryEntry = { name: string; isDirectory: () => boolean; isFile: () => boolean };
type DirectoryReader = (relative: string) => DirectoryEntry[];

const readDirectory: DirectoryReader = (relative) =>
  readdirSync(join(SRC_ROOT, relative), { withFileTypes: true });

/**
 * Every `.ts` under `relative`, recursively, excluding the test tree.
 *
 * Takes its reader so the positive controls below can ask "would the derivation
 * get a module that does not exist yet?" of the REAL derivation rather than of a
 * re-spelling of it. Walking `''` yields paths with no leading slash, which is
 * what makes the whole-tree sweep comparable with the population.
 */
function walk(relative: string, readDir: DirectoryReader = readDirectory): string[] {
  const found: string[] = [];
  for (const entry of readDir(relative)) {
    if (entry.name === '__tests__') continue;
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(child, readDir));
    else if (entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
}

/** Anything whose name carries this domain, in either spelling. */
const DOMAIN_NAMED = /guest-portal|guestPortal|guest-orders|guestOrders/i;

/**
 * The shared flat directories a portal module lives in under a domain NAME.
 *
 * `db/schema` joined this list in #460: the domain owns `db/schema/guestPortal.ts`
 * — five tables including the credential table whose two CHECKs carry the whole
 * verification model — and it was scanned by nothing here.
 */
const PORTAL_SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'] as const;

/**
 * The portal's HTTP surface and schema module, derived from the filename
 * convention these flat directories already follow (#472's device).
 *
 * RECURSES, via `walk`. It was `readdirSync(...).filter(entry.isFile())` — ONE
 * level — sitting fifteen lines below a `walk` that recurses, so the file read as
 * though it recursed throughout and it did not. Measured across the tree (#460):
 * 27 gates carry that exact asymmetry, and it is live rather than latent —
 * `routes/admin/merchant-activation.ts` is the module it dropped in a sibling
 * gate. Nothing of this domain sits in a subdirectory TODAY, so this half of the
 * repair adds no module; what it does is stop `routes/admin/guest-orders.ts` from
 * being invisible on the day somebody writes it. The whole-tree assertion below
 * is what would report such a module in the meantime.
 */
function sharedSurface(readDir: DirectoryReader = readDirectory): string[] {
  return PORTAL_SHARED_DIRECTORIES.flatMap((directory) =>
    walk(directory, readDir).filter((path) => DOMAIN_NAMED.test(path.split('/').pop() ?? '')),
  );
}

/**
 * Every module a portal REQUEST passes through, WALKED rather than listed
 * (#460).
 *
 * The list this replaces named 17 modules and the walk found 18: it omitted
 * `controllers/guest-portal-operator.controller.ts`, so the operator surface —
 * the one place a Mercaria employee touches a buyer's portal — was behind none
 * of the walls below. That is #472's `ebay-isolation` finding again, and it is
 * the reason a list whose comment claims completeness is worse than no comment.
 *
 * It is now **19**: `db/schema/guestPortal.ts` was outside every wall, found by
 * the whole-tree assertion below rather than by anybody reading the list.
 */
const PORTAL_PATHS = [
  ...walk('services/guest-portal'),
  ...walk('db/guestPortal'),
  ...sharedSurface(),
];

/**
 * Every module in the tree whose PATH names this domain — the assertion that
 * closes the population against the NEXT mechanism rather than only these two.
 *
 * A gate can be walk-only, with no hand list anywhere, and still miss a module,
 * because the miss lives in the DIRECTORY list the walk reads. Two different
 * mechanisms produced misses in this file (a non-recursing shared sweep and an
 * unscanned `db/schema`) and this one assertion covers both, plus whatever is
 * found next.
 *
 * Matched on the PATH, not the filename: a module inside `services/guest-portal/`
 * names the domain nowhere in its own name, so a filename sweep would report a
 * fraction of the domain and an empty "outside" set — which reads exactly like a
 * clean pass.
 */
function domainNamedModules(readDir: DirectoryReader = readDirectory): string[] {
  return walk('', readDir).filter((path) => DOMAIN_NAMED.test(path));
}

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
    expect(sharedSurface().length, 'the shared-directory derivation found nothing').toBeGreaterThanOrEqual(4);
    expect(from('db/schema/'), 'the schema module left the population').toBeGreaterThanOrEqual(1);
    expect(PORTAL_PATHS.length).toBeGreaterThanOrEqual(19);

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

  it('no portal-named module anywhere in src/ sits outside the population', () => {
    // #460's whole-tree assertion. A walked population whose DIRECTORY list is
    // hand-written is still a hand list, and it fails the same silent way: this
    // gate's list carried `controllers`, `routes` and `middleware` and not
    // `db/schema`, so the wall shipped over 18 of the domain's 19 modules with
    // no floor, count or walk able to see it.
    //
    // So the exclusion is derived rather than the inclusion. Sweep the whole
    // source tree for modules NAMED for this domain and require each to be in
    // the population or in a counted, justified exclusion — and a new bag
    // directory brings its modules under the wall with no edit here.
    const swept = domainNamedModules();

    // The sweep's OWN vacuity floor, first: a traversal that reached nothing
    // reports no module outside the population, which is the same answer a
    // complete population gives. MEASURED at 19.
    expect(
      swept.length,
      'the whole-tree sweep found almost nothing; it cannot report a module outside the ' +
        'population if it never reached one',
    ).toBeGreaterThanOrEqual(15);

    // ONE comparison, shared by the wall and by its positive control below. Two
    // spellings would let the control pass while the wall went vacuous —
    // measured in #609: with the control re-deriving the population itself,
    // mutating the wall's to contain everything left every test green.
    const outsidePopulation = (paths: readonly string[]): string[] => {
      const population = new Set(PORTAL_PATHS);
      return paths.filter((path) => !population.has(path));
    };
    // EXACT and empty, and empty because it was MEASURED empty rather than
    // guessed: every guest-portal-named and guest-orders-named module in the
    // tree is a module of this domain. A future `guest-orders` module owned by
    // somebody else goes here WITH its reason, and the count moves in the same
    // edit (#448).
    expect(
      outsidePopulation(swept),
      'names the guest portal but sits outside the population every wall above scans — add its ' +
        'directory to PORTAL_SHARED_DIRECTORIES, or excuse it here with a reason and move the count',
    ).toEqual([]);

    // THE POSITIVE CONTROL, and without it the assertion above cannot fail. An
    // empty expected set is satisfied by a sweep that reaches nothing, by a
    // population that contains everything, and by a correct tree — three
    // different worlds. So the same sweep runs against a reader reporting a
    // portal-named module in a directory the population does NOT draw from, and
    // it must come back OUTSIDE.
    const planted = 'lib/guest-portal-cache.ts';
    const seeded = domainNamedModules((relative) =>
      relative === 'lib'
        ? [...readDirectory(relative), { name: 'guest-portal-cache.ts', isDirectory: () => false, isFile: () => true }]
        : readDirectory(relative),
    );
    expect(seeded, 'the sweep did not reach a planted module').toContain(planted);
    expect(
      outsidePopulation(seeded),
      'a module the population does not cover was NOT reported outside it — the empty result ' +
        'above is a probe that cannot fail rather than a measurement',
    ).toEqual([planted]);
    // …and the plant is not on disk, or the control asserts about the tree
    // rather than about the sweep.
    expect(domainNamedModules()).not.toContain(planted);

    // And the POPULATION is still NARROW. This is the clause the plant above
    // cannot supply, and it is here rather than trusted to the shared
    // comparison because that device does not do what it is documented to do:
    // an empty "outside" set is also what a population that swallowed the tree
    // produces, and a plant absent from the real sweep is reported outside a
    // population built FROM the real sweep exactly as it is outside a correct
    // one. MEASURED against `analytics-ranking-isolation.test.ts`, whose own
    // comment claims the shared comparison closes this: replacing its wall's
    // population with `new Set(swept)` leaves all TEN of its tests green.
    //
    // What does bite is naming modules that EXIST and belong to somebody else,
    // so a widening broad enough to empty the set above fails here instead.
    // Mutation-tested: `...walk('')` added to the population fails this clause
    // naming `controllers/orders.controller.ts`.
    for (const foreign of [
      'controllers/orders.controller.ts',
      'routes/cart.ts',
      'db/schema/orders.ts',
      'middleware/auth.ts',
    ]) {
      expect(PORTAL_PATHS, `${foreign} belongs to another domain`).not.toContain(foreign);
      expect(
        statSync(join(SRC_ROOT, foreign)).isFile(),
        `${foreign} no longer exists, so excluding it proves nothing`,
      ).toBe(true);
    }
  });

  it('a module ADDED to the domain is scanned — the direction a hand list is blind in', () => {
    // The probe that justifies the conversion, kept as a test rather than as a
    // claim that one was run once. A population that is COMPLETE today passes
    // every floor and every count it carries; the only way it fails is a module
    // nobody adds to it. Written against the DERIVATION rather than the
    // filesystem, because seeding a real file would mutate a tree shared with
    // every parallel suite.
    const seededWith = (directory: string, added: string): string[] =>
      sharedSurface((relative) =>
        relative === directory
          ? [...readDirectory(relative), { name: added, isDirectory: () => false, isFile: () => true }]
          : readDirectory(relative),
      );

    // A shared directory admits a new module BY NAME …
    expect(
      seededWith('routes', 'guest-orders-support.ts'),
      'a new guest-orders route does not enter the population; it would sit behind no wall',
    ).toContain('routes/guest-orders-support.ts');
    expect(
      seededWith('db/schema', 'guestPortalArchive.ts'),
      'a new portal schema module does not enter the population',
    ).toContain('db/schema/guestPortalArchive.ts');
    // … and ONLY by name, or this wall starts firing at whoever edits an order.
    expect(
      seededWith('routes', 'orders.ts'),
      'a foreign route entered the population; the name rule has stopped narrowing',
    ).not.toContain('routes/orders.ts');

    // And the RECURSION, which is the other half of the #460 repair: a module in
    // a SUBDIRECTORY of a shared directory must be admitted. The one-level
    // `readdirSync` this replaced could not see one, and that is how
    // `routes/admin/merchant-activation.ts` ended up behind no wall in a sibling
    // gate.
    expect(
      sharedSurface((relative) =>
        relative === 'routes'
          ? [...readDirectory(relative), { name: 'admin', isDirectory: () => true, isFile: () => false }]
          : relative === 'routes/admin'
            ? [{ name: 'guest-orders.ts', isDirectory: () => false, isFile: () => true }]
            : readDirectory(relative),
      ),
      'a module in a SUBDIRECTORY of a shared directory is not admitted; the sweep beside the ' +
        'recursive walk is still one level deep',
    ).toContain('routes/admin/guest-orders.ts');
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
