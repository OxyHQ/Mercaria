/**
 * The referral EDGE's structural boundaries (#143), asserted by SCAN rather
 * than by fixture.
 *
 * Each of these is a claim about what the edge CANNOT reach, and a behavioural
 * test can only ever say "it did not this time". That is the argument
 * `cart-merge-isolation.test.ts` makes for the cart and
 * `guest-claim-isolation.test.ts` makes for claiming, and this scanner carries
 * the same two defences: a vacuity floor (a moved or emptied file fails the
 * gate instead of shrinking it silently) and a mutation self-test (each
 * detector runs against a seeded positive, so a broken regex cannot pass by
 * matching nothing).
 *
 * The walls, and the rule behind each:
 *
 *  1. **No payment rail.** A referral is acquisition history. The moment the
 *     edge could reach a PaymentIntent or the ledger is the moment attribution
 *     could refuse, delay or re-price a purchase (ADR 0005 I2/I4).
 *  2. **No ranking.** #74's own gate already forbids the reverse direction —
 *     "no module under `services/ranking/` may reference the referral domain" —
 *     and a measured partner is one join from a commission-weighted ordering,
 *     which ADR 0005 D20/I1 forbids by name.
 *  3. **No forbidden identity signal.** ADR 0005 A2 and #143 guest rules 7 and
 *     10: email, hash, phone, address, card, payment method, Stripe customer,
 *     Link identity, IP, user agent fingerprint, device fingerprint,
 *     advertising id. Named as VALUES in shared-types precisely so a gate can
 *     measure them.
 *  4. **No guest commerce session is created.** ADR 0003 T10 — a page view
 *     never mints a row — is the reason the carrier exists at all, so an edge
 *     module learning to call `issueGuestActor` would undo the whole design.
 *  5. **No commerce write path.** Cart, checkout, order and claim are walled
 *     off from referral by their OWN gates; this is the same wall from this
 *     side, so neither list can quietly become one-directional.
 *  6. **No analytics emission.** #143 privacy rule 8: referral tokens, guest
 *     credentials and contact must never reach general analytics, and the
 *     strongest form is that this domain emits nothing at all.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REFERRAL_ACTOR_KINDS,
  REFERRAL_DESTINATION_TYPES,
  REFERRAL_FORBIDDEN_IDENTITY_SIGNALS,
  REFERRAL_FORBIDDEN_REDIRECT_INPUTS,
  REFERRAL_SUBJECT_KINDS,
  REFERRAL_DEFERRED_DEEP_LINK_SUPPORT,
} from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A directory entry, as `readdirSync(..., { withFileTypes: true })` reports one. */
type DirectoryEntry = { name: string; isDirectory: () => boolean; isFile: () => boolean };
type DirectoryReader = (relative: string) => DirectoryEntry[];

const readDirectory: DirectoryReader = (relative) =>
  readdirSync(join(SRC_ROOT, relative), { withFileTypes: true });

/**
 * Every `.ts` under `relative`, RECURSIVELY, excluding the domain's own tests.
 *
 * Takes its reader so the positive controls below can ask "would the derivation
 * get a module that does not exist yet?" of the REAL derivation rather than of a
 * re-spelling of it.
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

/** Anything whose name carries this domain. */
const DOMAIN_NAMED = /referral/i;

/**
 * The directories this domain OWNS outright, walked whole.
 *
 * The three `db/` sub-domain directories and `services/referral-pilot/` joined
 * this list in #460: measured, all nineteen of the modules added here are clean
 * against every wall in this file, so leaving them out was a gap rather than a
 * decision.
 */
const REFERRAL_OWNED_DIRECTORIES = [
  'services/referrals',
  'services/referral-pilot',
  'db/referrals',
  'db/referralEarnings',
  'db/referralIntegrity',
  'db/referralPilot',
] as const;

/**
 * The shared flat directories a referral module lives in under a domain NAME.
 *
 * `db/schema` joined this list in #460 — five referral schema modules were
 * scanned by nothing here — and `routes/admin` LEFT it, which is not a
 * narrowing: the sweep now recurses, so `walk('routes')` reaches it. That entry
 * was a hand-patch of exactly this defect in one gate, and it covers the one
 * subdirectory somebody thought of and no other.
 */
const REFERRAL_SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'] as const;

/**
 * Every referral-NAMED module in a flat shared directory.
 *
 * RECURSES, via `walk`. It was `readdirSync(...).filter(entry.isFile())` — ONE
 * level — sitting ten lines below a `walk` that recurses, so the file read as
 * though it recursed throughout and it did not. #460 measured that asymmetry in
 * 27 gates, and this file carried the hand-patched evidence of it.
 */
function referralNamed(directory: string, readDir: DirectoryReader = readDirectory): string[] {
  return walk(directory, readDir).filter((path) => DOMAIN_NAMED.test(path.split('/').pop() ?? ''));
}

/**
 * Every module in the tree whose PATH names this domain — the assertion that
 * closes the population against the NEXT mechanism, not only these two.
 *
 * Matched on the PATH, not the filename: the sixty modules under
 * `services/referrals/` name the domain nowhere in their own names, so a
 * filename sweep reports a fraction of the domain and an empty "outside" set,
 * which reads exactly like a clean pass.
 */
function domainNamedModules(readDir: DirectoryReader = readDirectory): string[] {
  return walk('', readDir).filter((path) => DOMAIN_NAMED.test(path));
}

/**
 * #344's partner PAYOUT rail — a referral-named sub-domain deliberately OUTSIDE
 * this population, with an EXACT count (#448).
 *
 * Measured rather than assumed: three of its five modules trip the payment
 * detector below, because reaching the payment rail is what a payout IS. So the
 * choice was between admitting them and widening `LEDGER_POSTING_DIRECTORY` —
 * this file's most sensitive exemption, and the one thing its own docblock says
 * must be narrowed explicitly rather than by choosing a smaller population — or
 * naming the sub-domain here. Widening an exemption to cover a directory also
 * covers whatever is added to that directory next, so the exclusion is named.
 *
 * Asserted in BOTH directions below: the sweep must still reach each, and the
 * population must not have absorbed it.
 */
const PAYOUT_RAIL_PATHS = [
  'services/referral-payouts/beneficiary.ts',
  'services/referral-payouts/rail.ts',
  'services/referral-payouts/readiness.ts',
  'services/referral-payouts/register.ts',
  'services/referral-payouts/risk-payment-facts.ts',
];

/**
 * The whole referral domain. WALKED, never listed — and WIDER than the edge
 * these walls used to be asserted over.
 *
 * This was thirteen hand-written paths called "the referral EDGE", with #142's
 * model services "deliberately NOT scanned: they are the model rather than the
 * edge". Measured on `origin/main` at 4b30d5a2, the domain is 94 modules, and
 * this gate plus `referral-enrollment-isolation.test.ts` covered 28 of them
 * between them. Sixty-six modules — the whole of `earnings/`, `integrity/`,
 * `dashboard/` and `rewards/`, fourteen repositories, three controllers and two
 * schema modules — were behind neither wall.
 *
 * The scope split was defensible when written and had stopped being checkable:
 * "which modules are the edge" is a judgement nobody re-makes, so what it
 * actually produced was a wall around the thirteen files somebody remembered
 * (#460). Every wall below now runs over the whole domain, which is where each
 * of them was always TRUE — measured, not assumed: ranking, guest issuance,
 * commerce writes, analytics emission, request-derived destinations and all
 * fourteen forbidden identity signals trip on ZERO of the 94.
 *
 * The one wall that genuinely cannot span the domain is the payment rail, and it
 * is narrowed explicitly below rather than by choosing a smaller population.
 */
const REFERRAL_DOMAIN_PATHS = [
  ...REFERRAL_OWNED_DIRECTORIES.flatMap((directory) => walk(directory)),
  ...REFERRAL_SHARED_DIRECTORIES.flatMap((directory) => referralNamed(directory)),
];

/**
 * #145's partner EARNINGS — the one sub-directory that may reach the ledger.
 *
 * A partner's commission is real money Mercaria owes and books, so these
 * modules post to `ledger_entries` by design. The wall they are excused from is
 * "a referral is acquisition history and must never be able to refuse, delay or
 * re-price a purchase" — which is about the BUYER's payment, and these touch
 * none of it.
 *
 * A DIRECTORY rather than three paths, so a fourth earnings module does not
 * arrive outside a wall; and with an EXACT count on what it actually excuses,
 * because a directory-shaped exemption with no count is a predicate that lets
 * any number of modules ride in behind it (#448). The positive control below is
 * what makes it safe rather than merely stated: each excused module must STILL
 * reach the ledger, or the exemption is stale and is excusing nothing while
 * looking like a decision.
 */
const LEDGER_POSTING_DIRECTORY = 'services/referrals/earnings/';

/** Read a path in the edge, refusing an empty or moved file. */
function readEdgeSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * The same source with comments removed — what the REACHABILITY detectors scan.
 *
 * Not a convenience. Every module here documents what it refuses to do in
 * exactly the vocabulary these detectors look for — `referral-schemas.ts` lists
 * the fields it cannot carry, `binding.service.ts` explains why no email can
 * reach it — and scanning prose would make every honest explanation a
 * violation. A gate with known false positives is one whoever hits it next
 * disables.
 */
function readEdgeCode(relative: string): string {
  const stripped = readEdgeSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // A vacuity floor on the STRIPPED text too: a stripper that ate the file
  // would make every reachability assertion pass against nothing.
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(100);
  return stripped;
}

const PAYMENT_REFERENCE =
  /services\/payments\/|paymentRepository|payment_provider_events|PaymentIntent|ledgerRepository|ledger_entries|openCheckoutPayment|stripe|Stripe/;
const RANKING_REFERENCE =
  /services\/ranking\/|rankOffers|rankOfferComparison|OfferRankingFacts|ranking_policy_versions|offer_impression/;
const GUEST_ISSUANCE_REFERENCE =
  /issueGuestActor|guestSessionRepository|insertGuestSession|rotateGuestSession|mgs_/;
const COMMERCE_WRITE_REFERENCE =
  /services\/checkout\/|services\/cart|cartRepository|placeOrders|orderRepository|insertOrder|claimGuestCheckoutGroup|guest-claims\//;
const ANALYTICS_EMISSION_REFERENCE = /recordAnalyticsEvent|emitAnalyticsEvent|analytics\/seams/;
/**
 * A URL, host or origin taken OUT of the request — acceptance 2's open
 * redirect. `req.headers.host`, `req.get('origin')`, `x-forwarded-host` and a
 * body/query destination are the four shapes it takes.
 *
 * The trailing `\b` on the body/query branch is load-bearing and was added
 * because this gate fired on a real false positive the first time it ran:
 * `body.redirectEnabled` is the operator LEVER, a boolean, and reading it is
 * the opposite of composing a destination from caller input. A gate with known
 * false positives is one whoever hits it next disables, so it is narrowed here
 * and both directions are pinned in the mutation self-test below.
 */
const REQUEST_DERIVED_DESTINATION =
  /req\.(headers\.)?(host|hostname)\b|x-forwarded-host|req\.get\(\s*['"](host|origin|referer)|(body|query)\.(url|destination|redirect|returnTo|next)\b/i;

/**
 * The vacuity floors, PER SHAPE rather than one on the total.
 *
 * Called by every scan below. The six sources break independently, and a single
 * total lets one walk collapse to zero while the others carry its number. Each
 * is today's count, so a module REMOVED goes red rather than quietly narrowing
 * every wall in this file at once.
 *
 * This replaces `expect(scanned).toBe(EDGE_PATHS.length)`, which appeared seven
 * times and could not fail: it compared the loop's own counter to the list the
 * loop had just iterated, which holds for any list including an empty one. It
 * catches a broken loop and never a shrunk population — and the population was
 * the thing that was wrong.
 */
function assertReferralDomainIsWhole(): void {
  const from = (prefix: string) =>
    REFERRAL_DOMAIN_PATHS.filter((path) => path.startsWith(prefix)).length;
  expect(from('services/referrals/'), 'the referral service walk found too few modules').toBeGreaterThanOrEqual(48);
  expect(from('services/referral-pilot/'), 'the pilot walk found too few modules').toBeGreaterThanOrEqual(4);
  expect(from('db/referrals/'), 'the referral repository walk found too few modules').toBeGreaterThanOrEqual(17);
  expect(from('db/referralEarnings/'), 'the earnings repository walk found too few modules').toBeGreaterThanOrEqual(5);
  expect(from('db/referralIntegrity/'), 'the integrity repository walk found too few modules').toBeGreaterThanOrEqual(3);
  expect(from('db/referralPilot/'), 'the pilot repository walk found too few modules').toBeGreaterThanOrEqual(2);
  expect(from('controllers/'), 'no referral controller was derived').toBeGreaterThanOrEqual(7);
  expect(from('routes/'), 'no referral route was derived').toBeGreaterThanOrEqual(5);
  expect(from('middleware/'), 'no referral middleware module was derived').toBeGreaterThanOrEqual(5);
  expect(from('db/schema/'), 'no referral schema module was derived').toBeGreaterThanOrEqual(5);
  // No test file may enter the scanned set: a gate that scans its own probes
  // reports violations it wrote itself.
  expect(REFERRAL_DOMAIN_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
  // And the walk really reads the disk, rather than a `readdirSync` that has
  // silently started returning a cached or empty result.
  for (const path of REFERRAL_DOMAIN_PATHS) {
    expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
  }
}

describe('the referral edge cannot reach the money path', () => {
  it('no referral-named module anywhere in src/ sits outside the population', () => {
    // #460's whole-tree assertion. This gate's population was already a walk,
    // and it still missed twenty-four modules — because a walked population
    // whose DIRECTORY list is hand-written is still a hand list, and the miss
    // lives one level up. The evidence was sitting in the list itself: a
    // `referralNamed('routes/admin')` line beside `referralNamed('routes')`,
    // covering the one subdirectory somebody thought of.
    //
    // So the exclusion is derived rather than the inclusion. 94 -> 113, and the
    // nineteen added — three `db/` sub-domain directories, `services/referral-pilot/`
    // and five schema modules — are clean against every wall in this file, so
    // this is a widening rather than a false wall.
    const swept = domainNamedModules();

    // The sweep's OWN vacuity floor: a traversal that reached nothing reports no
    // module outside the population, the same answer a complete population
    // gives. MEASURED at 118.
    expect(
      swept.length,
      'the whole-tree sweep found almost nothing; it cannot report a module outside the ' +
        'population if it never reached one',
    ).toBeGreaterThanOrEqual(100);

    // EXACT, because an unbounded exclusion list lets any number of modules ride
    // in behind the five somebody justified (#448).
    expect(
      PAYOUT_RAIL_PATHS.length,
      'a sixth module was excused from this gate as payout-rail',
    ).toBe(5);

    const population = new Set(REFERRAL_DOMAIN_PATHS);
    const excluded = new Set(PAYOUT_RAIL_PATHS);
    expect(
      swept.filter((path) => !population.has(path) && !excluded.has(path)),
      'names the referral domain but sits outside BOTH the population and the exclusion — add ' +
        'its directory to REFERRAL_OWNED_DIRECTORIES or REFERRAL_SHARED_DIRECTORIES, or add it ' +
        'to PAYOUT_RAIL_PATHS with its reason and move the count',
    ).toEqual([]);

    // Every exclusion, asserted in BOTH directions. An exemption is only safe
    // while it is still TRUE, and it stops being true in two opposite ways: the
    // sweep no longer REACHES the module (so the entry excuses nothing while
    // looking like a decision), or the population has ABSORBED it (so the entry
    // silently subtracts a module from every wall in this file).
    for (const path of PAYOUT_RAIL_PATHS) {
      expect(swept, `${path} is excused but the sweep no longer reaches it`).toContain(path);
      expect(
        population.has(path),
        `${path} is excused but is ALSO in the population; the exclusion now subtracts a module ` +
          'the walls would otherwise scan',
      ).toBe(false);
      expect(
        statSync(join(SRC_ROOT, path)).isFile(),
        `${path} no longer exists, so excusing it proves nothing`,
      ).toBe(true);
    }

    // THE POSITIVE CONTROL: `toEqual([])` is also what a sweep that reached
    // nothing produces, so the same sweep runs against a reader reporting a
    // referral-named module in a directory neither the population nor the
    // exclusion covers, and it must come back OUTSIDE.
    const planted = 'lib/referral-cache.ts';
    const seeded = domainNamedModules((relative) =>
      relative === 'lib'
        ? [...readDirectory(relative), { name: 'referral-cache.ts', isDirectory: () => false, isFile: () => true }]
        : readDirectory(relative),
    );
    expect(seeded, 'the sweep did not reach a planted module').toContain(planted);
    expect(
      seeded.filter((path) => !population.has(path) && !excluded.has(path)),
      'a module neither covered nor excused was NOT reported — the empty result above is a ' +
        'probe that cannot fail rather than a measurement',
    ).toEqual([planted]);
    expect(domainNamedModules()).not.toContain(planted);

    // And the POPULATION is still NARROW — the third world `toEqual([])` admits
    // and the one the plant cannot see, since a plant absent from the real sweep
    // is reported outside a population built FROM that sweep exactly as it is
    // outside a correct one. It is what stops a widening satisfying the sweep by
    // absorbing the payout rail it was told to excuse.
    for (const foreign of [
      'services/referral-payouts/rail.ts',
      'controllers/orders.controller.ts',
      'db/schema/orders.ts',
      'middleware/auth.ts',
    ]) {
      expect(REFERRAL_DOMAIN_PATHS, `${foreign} belongs to another domain`).not.toContain(foreign);
      expect(
        statSync(join(SRC_ROOT, foreign)).isFile(),
        `${foreign} no longer exists, so excluding it proves nothing`,
      ).toBe(true);
    }
  });

  it('a module ADDED to the domain is scanned — the direction a hand list is blind in', () => {
    // Written against the DERIVATION rather than the filesystem: seeding a real
    // file would mutate a tree shared with every parallel suite.
    const seededWith = (directory: string, added: string): string[] =>
      referralNamed(directory, (relative) =>
        relative === directory
          ? [...readDirectory(relative), { name: added, isDirectory: () => false, isFile: () => true }]
          : readDirectory(relative),
      );

    expect(
      seededWith('db/schema', 'referralDisputes.ts'),
      'a new referral schema module does not enter the population',
    ).toContain('db/schema/referralDisputes.ts');
    expect(
      seededWith('controllers', 'referral-dispute.controller.ts'),
      'a new referral controller does not enter the population',
    ).toContain('controllers/referral-dispute.controller.ts');
    // … and ONLY by name, or these walls start firing at whoever edits an order.
    expect(
      seededWith('routes', 'orders.ts'),
      'a foreign route entered the population; the name rule has stopped narrowing',
    ).not.toContain('routes/orders.ts');

    // And the RECURSION, the other half of the #460 repair — the half this file
    // had hand-patched for `routes/admin` alone.
    expect(
      referralNamed('routes', (relative) =>
        relative === 'routes'
          ? [...readDirectory(relative), { name: 'internal', isDirectory: () => true, isFile: () => false }]
          : relative === 'routes/internal'
            ? [{ name: 'referral-audit.ts', isDirectory: () => false, isFile: () => true }]
            : readDirectory(relative),
      ),
      'a module in a SUBDIRECTORY of a shared directory is not admitted; the sweep beside the ' +
        'recursive walk is still one level deep',
    ).toContain('routes/internal/referral-audit.ts');
    // …and the real `routes/admin` module the hand-patched line used to cover is
    // still in the population, reached now by recursion rather than by name.
    expect(REFERRAL_DOMAIN_PATHS).toContain('routes/admin/referral-partner.ts');
  });

  it('names no payment module, rail or ledger', () => {
    assertReferralDomainIsWhole();
    for (const relative of REFERRAL_DOMAIN_PATHS) {
      if (relative.startsWith(LEDGER_POSTING_DIRECTORY)) continue;
      expect(
        PAYMENT_REFERENCE.test(readEdgeCode(relative)),
        `${relative} reaches the payment rail; a referral is acquisition history and must ` +
          'never be able to refuse, delay or re-price a purchase (ADR 0005 I2/I4)',
      ).toBe(false);
    }
  });

  /**
   * The other half of the earnings exemption, and what makes it safe rather
   * than merely justified.
   *
   * An exemption stated as a directory excuses everything in it forever. So:
   * the modules it actually excuses are counted EXACTLY, and each must STILL
   * reach the ledger. A module that stopped posting would go on being excused
   * for a reason that had stopped being true, which is how a real violation
   * ends up behind no wall while a comment says otherwise.
   */
  it('the earnings exemption excuses exactly the modules that really post', () => {
    const excused = REFERRAL_DOMAIN_PATHS.filter(
      (relative) =>
        relative.startsWith(LEDGER_POSTING_DIRECTORY) && PAYMENT_REFERENCE.test(readEdgeCode(relative)),
    );
    expect(
      excused.sort(),
      'the ledger-posting exemption no longer matches — a module that stopped posting is ' +
        'still being excused, or a fourth one started',
    ).toEqual([
      'services/referrals/earnings/accounts.ts',
      'services/referrals/earnings/ledger-postings.ts',
      'services/referrals/earnings/posting.service.ts',
    ]);
    // And the rest of `earnings/` is inside the wall like everything else: the
    // exemption is what a module DOES, not which directory it sits in.
    const inDirectory = REFERRAL_DOMAIN_PATHS.filter((relative) =>
      relative.startsWith(LEDGER_POSTING_DIRECTORY),
    );
    expect(inDirectory.length, 'the earnings walk found nothing').toBeGreaterThanOrEqual(11);
    expect(
      inDirectory.length,
      'every module of `earnings/` now posts to the ledger — the directory-shaped exemption ' +
        'has become a blanket one and should be re-read',
    ).toBeGreaterThan(excused.length);
  });

  it('names no ranking module or policy', () => {
    assertReferralDomainIsWhole();
    for (const relative of REFERRAL_DOMAIN_PATHS) {
      expect(
        RANKING_REFERENCE.test(readEdgeCode(relative)),
        `${relative} reaches ranking; #74 forbids the reverse direction and ADR 0005 D20/I1 ` +
          'forbids this one — a paid partner may not influence organic order',
      ).toBe(false);
    }
  });
});

describe('the referral edge cannot build an identity', () => {
  it('names none of the fourteen forbidden identity signals', () => {
    assertReferralDomainIsWhole();
    for (const relative of REFERRAL_DOMAIN_PATHS) {
      const code = readEdgeCode(relative).toLowerCase();
      for (const signal of REFERRAL_FORBIDDEN_IDENTITY_SIGNALS) {
        // The VALUE list itself is allowed to appear where it is declared, and
        // it is declared in shared-types rather than here.
        expect(
          code.includes(signal),
          `${relative} names the forbidden identity signal "${signal}" (ADR 0005 A2)`,
        ).toBe(false);
      }
    }
  });

  it('creates no guest commerce session', () => {
    assertReferralDomainIsWhole();
    for (const relative of REFERRAL_DOMAIN_PATHS) {
      expect(
        GUEST_ISSUANCE_REFERENCE.test(readEdgeCode(relative)),
        `${relative} mints or rotates a guest session; ADR 0003 T10 says a page view creates ` +
          'no row, which is the whole reason the referral carrier exists',
      ).toBe(false);
    }
  });

  it('writes no cart, checkout, order or claim', () => {
    assertReferralDomainIsWhole();
    for (const relative of REFERRAL_DOMAIN_PATHS) {
      expect(
        COMMERCE_WRITE_REFERENCE.test(readEdgeCode(relative)),
        `${relative} reaches a commerce write path; cart, checkout and claim each wall the ` +
          'referral domain off from THEIR side, and this is the same wall from this one',
      ).toBe(false);
    }
  });

  it('emits no analytics event', () => {
    assertReferralDomainIsWhole();
    for (const relative of REFERRAL_DOMAIN_PATHS) {
      expect(
        ANALYTICS_EMISSION_REFERENCE.test(readEdgeCode(relative)),
        `${relative} emits an analytics event; #143 privacy rule 8 keeps referral tokens, ` +
          'guest credentials and contact out of general analytics, and emitting nothing is ' +
          'the strongest form of that',
      ).toBe(false);
    }
  });
});

describe('the redirect target cannot come from the request', () => {
  it('derives no host, origin or destination from the caller', () => {
    assertReferralDomainIsWhole();
    for (const relative of REFERRAL_DOMAIN_PATHS) {
      expect(
        REQUEST_DERIVED_DESTINATION.test(readEdgeCode(relative)),
        `${relative} reads a host, origin or destination off the request; the redirect is ` +
          'composed from a configured allow-listed origin and a closed template (acceptance 2)',
      ).toBe(false);
    }
  });

  it('exactly two modules touch `new URL` at all, and each for a stated reason', () => {
    // `new URL(...)` is how a relative path becomes an absolute one, and over
    // the whole domain there are exactly two places that reach for it. EXACT,
    // never a floor: a third is a decision somebody takes rather than a module
    // that quietly starts composing destinations.
    //
    // `redirect.service.ts` COMPOSES, and is the one module that may — it is
    // the composer with the origin check and the loop guard around it.
    // `application-answers.ts` PARSES, to normalize a promotion URL an
    // applicant typed, which is the opposite of composing one and is why
    // `referral-enrollment-isolation.test.ts` pins the same module from its
    // side. Scoping this assertion to thirteen edge files hid the second one.
    const composers = REFERRAL_DOMAIN_PATHS.filter((relative) =>
      /new URL\(/.test(readEdgeCode(relative)),
    );
    expect(composers.sort()).toEqual([
      'services/referrals/application-answers.ts',
      'services/referrals/redirect.service.ts',
    ]);
  });
});

describe('the closed vocabularies are disjoint', () => {
  it('no forbidden identity signal is a representable actor or subject', () => {
    const representable = new Set<string>([...REFERRAL_ACTOR_KINDS, ...REFERRAL_SUBJECT_KINDS]);
    for (const signal of REFERRAL_FORBIDDEN_IDENTITY_SIGNALS) {
      expect(representable.has(signal), signal).toBe(false);
    }
    // A vacuity floor on the comparison: an empty prohibition list would make
    // the loop above pass by iterating nothing.
    expect(REFERRAL_FORBIDDEN_IDENTITY_SIGNALS.length).toBe(14);
    expect(representable.size).toBeGreaterThan(0);
  });

  it('no forbidden redirect input is a representable destination type', () => {
    const representable = new Set<string>(REFERRAL_DESTINATION_TYPES);
    for (const input of REFERRAL_FORBIDDEN_REDIRECT_INPUTS) {
      expect(representable.has(input), input).toBe(false);
    }
    expect(REFERRAL_FORBIDDEN_REDIRECT_INPUTS.length).toBe(8);
  });

  it('deferred deep linking has no member meaning supported', () => {
    // The `GuestP2PAuthorization` (#112) device: a single-member union, so no
    // configuration, operator action or service bug can turn a device
    // fingerprint into a deferred match. The mechanism arrives WITH the
    // reviewed provider, in the change that adds a second member — which is
    // precisely what happened to `GuestSellerActivation` (#107) when #324
    // supplied #85's capability and added `{state: 'activated'}` in the same
    // change.
    expect(REFERRAL_DEFERRED_DEEP_LINK_SUPPORT).toEqual(['unsupported']);
  });
});

/**
 * The mutation self-test. Every detector above runs against text that SHOULD
 * trip it, so a regex broken into matching nothing fails here rather than
 * passing every scan silently — and against text that must NOT, so a detector
 * widened into matching everything fails too.
 */
describe('each detector actually detects (mutation self-test)', () => {
  it('fires on the thing it forbids', () => {
    expect(PAYMENT_REFERENCE.test("import { openCheckoutPayment } from '../payments/x.js';")).toBe(
      true,
    );
    expect(RANKING_REFERENCE.test('const ranked = await rankOfferComparison(input);')).toBe(true);
    expect(GUEST_ISSUANCE_REFERENCE.test('const guest = await issueGuestActor(req, res);')).toBe(
      true,
    );
    expect(COMMERCE_WRITE_REFERENCE.test("import { placeOrders } from '../checkout/x.js';")).toBe(
      true,
    );
    expect(ANALYTICS_EMISSION_REFERENCE.test('recordAnalyticsEvent({ type: "x" });')).toBe(true);
    expect(REQUEST_DERIVED_DESTINATION.test('const to = req.headers.host;')).toBe(true);
    expect(REQUEST_DERIVED_DESTINATION.test("const to = req.get('origin');")).toBe(true);
    expect(REQUEST_DERIVED_DESTINATION.test('res.redirect(req.query.next);')).toBe(true);
    expect(REQUEST_DERIVED_DESTINATION.test("const h = req.headers['x-forwarded-host'];")).toBe(
      true,
    );
  });

  it('does NOT fire on the things this domain legitimately does', () => {
    // A referral link resolving to a Mercaria path, the classifier reading the
    // one header it may, and the actor union — none of which is a violation.
    expect(PAYMENT_REFERENCE.test("const path = referralDestinationPath(destination);")).toBe(
      false,
    );
    expect(RANKING_REFERENCE.test('const winner = await attributeTouch(touch.id);')).toBe(false);
    expect(GUEST_ISSUANCE_REFERENCE.test("return { kind: 'guest_session', ref: id };")).toBe(false);
    expect(COMMERCE_WRITE_REFERENCE.test('const claims = await findClaimsByClaimant(db, id, 50);')).toBe(
      false,
    );
    expect(ANALYTICS_EMISSION_REFERENCE.test('config.analytics.internalTrafficToken')).toBe(false);
    expect(REQUEST_DERIVED_DESTINATION.test("headerValue(req, 'user-agent')")).toBe(false);
    expect(REQUEST_DERIVED_DESTINATION.test('const origin = referralRedirectOrigin();')).toBe(
      false,
    );
    // The real false positive this gate produced on its first run: the
    // operator LEVER is a boolean and reading it is not composing a
    // destination. Pinned in both directions so a later widening of the
    // pattern re-breaks here rather than in whoever adds the next lever.
    expect(REQUEST_DERIVED_DESTINATION.test('body.redirectEnabled')).toBe(false);
    expect(REQUEST_DERIVED_DESTINATION.test('const { redirectEnabled } = req.body;')).toBe(false);
    expect(REQUEST_DERIVED_DESTINATION.test('res.redirect(302, outcome.location);')).toBe(false);
  });
});
