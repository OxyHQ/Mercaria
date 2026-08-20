/**
 * The claim path's structural boundaries (#109), asserted by SCAN rather than
 * by fixture.
 *
 * Each of these is a claim about what the path CANNOT reach, and a behavioural
 * test can only ever say "it did not this time". A module that cannot import
 * the referral domain cannot create, replace, extend or transfer an
 * attribution; a module with no email parameter and no hash lookup cannot link
 * an account to a purchase because the addresses match; a module that cannot
 * read a feature flag cannot make an ownership record disappear when somebody
 * flips one. That is the argument `cart-merge-isolation.test.ts` makes for the
 * cart and `fees/__tests__/fee-ranking-isolation.test.ts` makes for ranking,
 * and the scanner carries the same two defences from `~/Oxy/AGENTS.md`: a
 * vacuity floor (a moved or emptied file fails the gate instead of shrinking
 * it silently) and a mutation self-test (each detector runs against a seeded
 * positive, so a broken regex cannot pass by matching nothing).
 */

import { describe, expect, it } from 'vitest';
import { assertDirectoriesAreFlat } from '../../__tests__/domain-population.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEachOf } from '../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `packages/`, so the scan can reach the STOREFRONT — see {@link CLAIM_UI_PATHS}. */
const PACKAGES_ROOT = join(SRC_ROOT, '..', '..');

/** The storefront's translation bundles — where #435b moved the copy. */
const LOCALES_ROOT = join(PACKAGES_ROOT, 'frontend', 'lib', 'i18n', 'locales');

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
const DOMAIN_NAMED = /guest-claim|guestClaims?/i;

/**
 * The shared flat directories a claim module lives in under a domain NAME.
 *
 * `db/schema` joined this list in #460: the domain owns `db/schema/guestClaims.ts`
 * — the three tables, the partial unique that makes a second claimant a DISPUTE
 * rather than a replacement, and the CHECK behind it — and it was scanned by
 * nothing here.
 */
const CLAIM_SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'] as const;

/**
 * Every claim-NAMED module in a shared flat directory, whoever owns it.
 *
 * RECURSES, via `walk`. It was `readdirSync(...).filter(entry.isFile())` — ONE
 * level — sitting fifteen lines below a `walk` that recurses, so the file read as
 * though it recursed throughout and it did not. Measured across the tree (#460):
 * 27 gates carry that exact asymmetry, and it is live rather than latent —
 * `routes/admin/merchant-activation.ts` is the module it dropped in a sibling
 * gate. Nothing of this domain sits in a subdirectory today, so this half adds no
 * module; it stops a `routes/admin/guest-claims.ts` being invisible on the day
 * somebody writes one.
 */
function claimNamedSharedModules(readDir: DirectoryReader = readDirectory): string[] {
  return CLAIM_SHARED_DIRECTORIES.flatMap((directory) =>
    walk(directory, readDir).filter((path) => DOMAIN_NAMED.test(path.split('/').pop() ?? '')),
  );
}

/**
 * Every module in the BACKEND tree whose PATH names this domain — the assertion
 * that closes the population against the NEXT mechanism, not only these two.
 *
 * A gate can be walk-only, with no hand list anywhere, and still miss a module,
 * because the miss lives in the DIRECTORY list the walk reads. Two mechanisms
 * produced misses here (a non-recursing shared sweep and an unscanned
 * `db/schema`) and this one assertion covers both, plus whatever is found next.
 *
 * Matched on the PATH, not the filename: a module inside `services/guest-claims/`
 * names the domain nowhere in its own name, so a filename sweep reports a
 * fraction of the domain and an empty "outside" set — which reads exactly like a
 * clean pass. Scoped to `src/`; the STOREFRONT half of this gate is derived
 * separately by `claimScreens()` against a different root.
 */
function domainNamedModules(readDir: DirectoryReader = readDirectory): string[] {
  return walk('', readDir).filter((path) => DOMAIN_NAMED.test(path));
}

/**
 * The claim path, end to end. WALKED and DERIVED, never listed.
 *
 * This was nine hand-written paths under a comment saying "a new module in this
 * path belongs on the list — the vacuity floor is what forces whoever adds one
 * to look here." A floor cannot force that: a floor of nine is met by nine, and
 * a tenth module lands outside all six walls without moving any number this file
 * asserts (#460). The two owned directories are walked whole, so the walls hold
 * for modules nobody has written yet.
 */
const CLAIM_PATHS = [
  ...walk('services/guest-claims'),
  ...walk('db/guestClaims'),
  ...claimNamedSharedModules(),
];

/**
 * The claim UX, in the STOREFRONT — scanned from here because the storefront
 * has no test runner of its own (the `seller-identity-isolation.test.ts`
 * device, #92).
 *
 * These are the files acceptance 13's COPY half is actually about: "do not
 * mention FairCoin or OxyPay as available or coming-soon benefits" is a rule
 * about what a buyer reads, and the only place a buyer reads anything is a
 * screen. A backend-only scan would pass while the review screen listed a
 * wallet nobody built.
 *
 * The screen half is WALKED. Listing it missed `recover.tsx`, the third screen
 * in the same directory — which is the guest-orders screen a buyer reaches when
 * they cannot find their purchase, so it is if anything the likeliest of the
 * three to grow a "sign up and get your FairCoin balance" line.
 *
 * The two `lib/` modules stay NAMED and are asserted to exist: they have no
 * directory of their own, and `frontend/lib/` is ninety-odd files of which these
 * two are the claim client.
 */
const CLAIM_UI_LIB_PATHS = ['frontend/lib/api/guest-claim.ts', 'frontend/lib/hooks/use-guest-claim.ts'];

/**
 * The claim SCREENS — RECURSIVELY (#668).
 *
 * This read one level. `frontend/app/(app)/guest-orders` is an **Expo route
 * directory**, and a route directory can grow a subdirectory at any time — a
 * nested route, a route group, a `[param]/` segment. So unlike every other
 * one-level read left in the gate corpus, asserting this one is flat would be a
 * BET rather than a fact, and the honest fix is to recurse.
 *
 * A screen inside such a subdirectory was outside every wall below, which is the
 * set that includes "the claim path reaches no referral module" — a wall whose
 * whole point is that it holds for screens nobody has written yet.
 */
/** A reader of one directory RELATIVE to `packages/`, injected so the seeded
 * control below drives THIS function rather than a copy of it. */
type PackagesReader = (relative: string) => DirectoryEntry[];
const readPackagesDirectory: PackagesReader = (relative) =>
  readdirSync(join(PACKAGES_ROOT, relative), { withFileTypes: true });

function claimScreens(readDir: PackagesReader = readPackagesDirectory): string[] {
  const directory = join('frontend', 'app', '(app)', 'guest-orders');
  const walk = (relative: string): string[] =>
    readDir(relative).flatMap((entry) => {
      if (entry.name === '__tests__') return [];
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) return walk(child);
      return entry.name.endsWith('.tsx') ? [child] : [];
    });
  return walk(directory);
}

const CLAIM_UI_PATHS = [...claimScreens(), ...CLAIM_UI_LIB_PATHS];

/**
 * #109 acceptance 13, and `AGENTS.md`'s standing exclusion: no OxyPay and no
 * FairCoin provider, benefit copy, placeholder, flag or dependency anywhere in
 * this work — "do not mention OxyPay or FairCoin as a current claim benefit",
 * and forbidden effect 11 is that a claim creates neither a wallet, a balance,
 * a provider record nor a payment option.
 *
 * `FAIR` the CURRENCY CODE is excluded from the pattern deliberately: it is the
 * preferred presentment currency of the whole marketplace. What is forbidden is
 * FairCoin as a payment rail or a benefit, which is what these spellings name.
 */
const OXYPAY_OR_FAIRCOIN_REFERENCE = /oxy_?[Pp]ay|OxyPay|[Ff]air[Cc]oin/;

/**
 * The REFERRAL BOUNDARY (#109 referral rules 1-10, claim-transaction rules 13
 * and 14, forbidden effects 9 and 10).
 *
 * A claim changes ORDER ACCESS, not acquisition history. It cannot create,
 * replace, extend or transfer an attribution, cannot recalculate a commission,
 * and referral status can neither authorize nor block order access — and the
 * way to make all of that true at once is for this path to have no code route
 * into the referral domain in either direction.
 */
const REFERRAL_REFERENCE =
  /referrals?\/|referralAttribution|referral_attributions|referral_touches|referral_conversions|partnerId|attributeTouch/;

/**
 * The PAYMENT domain (#109 forbidden effects 5 and 11).
 *
 * "Change the transaction currency or rail" and "save a Stripe payment method
 * automatically" are both structurally impossible when the claim path cannot
 * reach a payment module at all. It also keeps the claim off the money path
 * entirely, which is why a claim on a group with a pending payment is safe: it
 * has nothing to say to the rail.
 */
const PAYMENT_REFERENCE =
  /payments\/|paymentRepository|payment_provider_events|PaymentIntent|stripe|Stripe|setupIntent/;

/**
 * Contact-based buyer lookup (#109 reject rule 1, ADR 0003 I6).
 *
 * "Matching Oxy and checkout email" is insufficient, and the strongest form of
 * that is a path with no email, no hash and no lookup by either. The claim
 * service takes a grant and an account id; there is nothing here that could
 * find a purchase from an address.
 */
const CONTACT_LOOKUP_REFERENCE =
  /emailHash|email_hash|emailCiphertext|email_ciphertext|findGuestCheckoutsByEmailHash|normalizeEmail|decryptGuestPii/;

/**
 * Automatic account benefits a claim may not confer (#109 forbidden effects 1,
 * 2 and 3).
 *
 * No saved address, no saved payment method, no marketing subscription. Each is
 * a WRITE into a table this path has no business touching, and none of the
 * three has an import here to make it with.
 */
const AUTOMATIC_BENEFIT_REFERENCE =
  /insertAddress|updateAddress|addressRepository|marketingOptIn|marketing_opt_in|subscribeToMarketing|savePaymentMethod/;

/**
 * The modules that must not read a claim FLAG (#109's own levers).
 *
 * A claim is an ownership record: turning a lever off must never make an
 * already-claimed order stop belonging to the account that claimed it, stop
 * appearing in its history, or stop being readable by an operator. So the read
 * paths, the projection and the operator surface read no lever — the WRITE
 * path (`claim.service.ts`) and the LOOP (`claim-outbox.service.ts`) do, which
 * is why they are absent from this list rather than exempted inside it.
 */
const FLAG_READING_CLAIM_MODULES = [
  {
    path: 'services/guest-claims/claim.service.ts',
    reads: /config\.guest\.claim\.enabled/,
    why: 'the WRITE path — `GUEST_CLAIM_ENABLED` refuses a NEW claim and never hides a stored one',
  },
  {
    path: 'services/guest-claims/claim-outbox.service.ts',
    reads: /config\.guest\.claim\.projectionEnabled/,
    why: 'the LOOP — `GUEST_CLAIM_PROJECTION_ENABLED` gates the dispatcher, never the durable row',
  },
  {
    path: 'services/guest-claims/revocation.service.ts',
    reads: /config\.guest\.claim\.fourEyesRequired/,
    why:
      'the four-eyes POLICY, and it is SNAPSHOTTED onto the request at creation — the lever ' +
      'decides how many approvers a NEW revocation needs, once, and is then a stored column. ' +
      'It cannot hide, gate or unread a claim that already exists',
  },
] as const;

/**
 * Derived by SUBTRACTION, which is the direction that matters.
 *
 * The claim half used to be two named modules, which meant a new read path,
 * projection or operator module defaulted to being outside this wall — the one
 * wall whose failure is invisible, because a lever read in a read path shows no
 * symptom until somebody flips it and an ownership record disappears. Now every
 * module of the domain is IN unless it is one of the two below, each of which
 * carries the assertion that justifies it rather than a sentence: it must still
 * READ a lever, checked below against the real source. An exemption that stopped
 * being true would otherwise go on excusing a module that no longer needs it.
 *
 * The two `services/orders/` modules stay NAMED: they belong to #106, sit flat
 * among forty unrelated modules, and no rule derives them without deriving
 * things that are not claim read paths.
 */
const NO_FLAG_PATHS = [
  ...walk('services/guest-claims').filter(
    (path) => !FLAG_READING_CLAIM_MODULES.some((module) => module.path === path),
  ),
  'services/orders/order-access.service.ts',
  'services/orders/order-buyer.ts',
];

/** Reading a guest feature lever. */
const GUEST_FLAG_REFERENCE = /config\.guest|GUEST_CLAIM_ENABLED|GUEST_COMMERCE_ENABLED/;

/** Read a path in the claim set, refusing an empty or moved file. */
function readClaimSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * The same source with comments removed — what the REACHABILITY detectors scan.
 *
 * Not a convenience. Every detector below asserts that the path cannot REACH
 * something, and these modules document what they refuse to do in exactly the
 * vocabulary those detectors look for — `claim.service.ts`'s own header lists
 * "a referral link, code, touch, partner or beneficiary cannot claim". Scanning
 * prose would make every honest explanation a violation and the gate would be
 * disabled by whoever hit it next, which is the failure `~/Oxy/AGENTS.md` names
 * outright: fix a scanner's known false positives BEFORE it becomes a gate.
 *
 * The OxyPay/FairCoin detector deliberately does NOT use this: #109 acceptance
 * 13 excludes benefit COPY as well as code, so a comment naming either is
 * exactly what it must catch.
 */
function readClaimCode(relative: string): string {
  const stripped = readClaimSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // A vacuity floor on the STRIPPED text too: a stripper that ate the file
  // would make every reachability assertion pass against nothing.
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(200);
  return stripped;
}

/** Read a storefront path, refusing an empty or moved file. */
function readClaimUiSource(relative: string): string {
  const source = readFileSync(join(PACKAGES_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * Every translated string the storefront ships, in EVERY locale.
 *
 * The OxyPay/FairCoin prohibition is explicitly a scan of COPY rather than only
 * of code — acceptance 13 is about what a buyer READS, and a "coming soon", a
 * disabled wallet row and a conversion teaser are all STRINGS. #435b moved
 * exactly those strings out of the screens above and into these bundles:
 * measured on `origin/main` at 81448ac6, `claim.tsx` makes 27 `t(` calls,
 * `portal.tsx` 21 and `recover.tsx` 12, so the sentences this wall exists to
 * forbid are no longer in the files it was reading. The screens still exist and
 * still have bytes, so every assertion and every floor here went on passing —
 * the silent-green half of #460, arriving through a copy extraction rather than
 * through a new module.
 *
 * All twelve locales, not just `en`: a wallet teaser is as forbidden in
 * Portuguese. Enumerated from disk so a locale added later is covered without an
 * edit here (#396 and #434 keep adding them). A parse failure THROWS rather than
 * being skipped, because an unreadable bundle is the "scanned nothing" state.
 *
 * #499 gave `commercial-presentation-isolation.test.ts` this treatment for the
 * same prohibition on the checkout surface; this is the claim surface, which its
 * census did not reach.
 */
function localeBundles(): {
  readonly locale: string;
  readonly source: string;
  readonly leaves: readonly { readonly key: string; readonly value: string }[];
}[] {
  return readdirSync(LOCALES_ROOT)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const source = readFileSync(join(LOCALES_ROOT, name), 'utf8');
      // An unreadable bundle THROWS rather than being skipped: that is the
      // "scanned nothing" state, and it is the one way this must never be green.
      const leaves: { readonly key: string; readonly value: string }[] = [];
      const collect = (node: unknown, path: string): void => {
        if (typeof node === 'string') leaves.push({ key: path, value: node });
        else if (node !== null && typeof node === 'object')
          for (const [key, value] of Object.entries(node))
            collect(value, path === '' ? key : `${path}.${key}`);
      };
      collect(JSON.parse(source), '');
      return { locale: name.slice(0, -'.json'.length), source, leaves };
    });
}

/**
 * The keys where FairCoin may legitimately be NAMED, because it is the
 * PRESENTMENT CURRENCY there and not a claim benefit.
 *
 * `AGENTS.md` makes FAIR the preferred presentment and display currency. What
 * #109 acceptance 13 forbids is FairCoin as a payment RAIL or a BENEFIT of
 * claiming — "claim your order and get your FairCoin balance", a wallet row, a
 * conversion teaser. A currency picker saying which currency prices are shown in
 * is none of those, and this file's own detector comment already draws that line
 * for `FAIR` the code. #504 ruled on exactly this string in
 * `commercial-presentation-isolation.test.ts`; the same key is excused here for
 * the same reason rather than a second answer being invented for it.
 *
 * Scoped by KEY rather than by phrase, and the excused key must STILL match in
 * every locale — asserted below — so a reworded or renamed key fails as stale
 * instead of quietly excusing nothing.
 */
const CURRENCY_NAME_KEYS: readonly string[] = ['settings.currency.description'];

/**
 * The vacuity floors, PER SHAPE rather than one on the total.
 *
 * Called by every scan below. The five sources break independently, and one
 * total lets a walk collapse to zero while the others carry its number — which
 * is what a single `expect(scanned).toBe(LIST.length)` could never see either,
 * since that compares the loop's own counter to the list the loop just iterated
 * and is satisfied by any list, an empty one included.
 *
 * Each number is today's count, so a module REMOVED goes red rather than
 * silently narrowing six walls at once.
 */
function assertClaimPopulationIsWhole(): void {
  const from = (prefix: string) => CLAIM_PATHS.filter((path) => path.startsWith(prefix)).length;
  expect(from('services/guest-claims/'), 'the claim service walk found too few modules').toBeGreaterThanOrEqual(5);
  expect(from('db/guestClaims/'), 'the claim repository walk found too few modules').toBeGreaterThanOrEqual(3);
  expect(claimNamedSharedModules().length, 'no claim-named shared module was derived').toBeGreaterThanOrEqual(2);
  expect(from('db/schema/'), 'the schema module left the population').toBeGreaterThanOrEqual(1);
  expect(claimScreens().length, 'the guest-orders screen walk found too few screens').toBeGreaterThanOrEqual(3);
  expect(CLAIM_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
  for (const path of CLAIM_PATHS) {
    expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
  }
  for (const path of CLAIM_UI_PATHS) {
    expect(statSync(join(PACKAGES_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
  }
}

describe('the guest claim path cannot reach what it must not', () => {
  it('no claim-named module anywhere in src/ sits outside the population', () => {
    // #460's whole-tree assertion. A walked population whose DIRECTORY list is
    // hand-written is still a hand list, and it failed the same silent way here:
    // the list carried `controllers`, `routes` and `middleware` and not
    // `db/schema`, so every wall below ran over 9 of the domain's 10 modules.
    //
    // So the exclusion is derived rather than the inclusion — sweep the tree for
    // modules NAMED for this domain and require each to be in the population or
    // in a counted, justified exclusion.
    const swept = domainNamedModules();

    // The sweep's OWN vacuity floor first: a traversal that reached nothing
    // reports no module outside the population, which is the same answer a
    // complete population gives. MEASURED at 10.
    expect(
      swept.length,
      'the whole-tree sweep found almost nothing; it cannot report a module outside the ' +
        'population if it never reached one',
    ).toBeGreaterThanOrEqual(8);

    // EXACT and empty, and empty because it was MEASURED empty rather than
    // guessed: every claim-named module in the backend tree is a module of this
    // domain. One owned by somebody else goes here WITH its reason, and the
    // count moves in the same edit (#448).
    const population = new Set(CLAIM_PATHS);
    expect(
      swept.filter((path) => !population.has(path)),
      'names the claim domain but sits outside the population every wall below scans — add its ' +
        'directory to CLAIM_SHARED_DIRECTORIES, or excuse it here with a reason and move the count',
    ).toEqual([]);

    // THE POSITIVE CONTROL, and without it the assertion above cannot fail: an
    // empty expected set is satisfied by a sweep that reached nothing as well as
    // by a correct tree. The same sweep runs against a reader reporting a
    // claim-named module in a directory the population does NOT draw from, and
    // it must come back OUTSIDE.
    const planted = 'lib/guest-claim-cache.ts';
    const seeded = domainNamedModules((relative) =>
      relative === 'lib'
        ? [...readDirectory(relative), { name: 'guest-claim-cache.ts', isDirectory: () => false, isFile: () => true }]
        : readDirectory(relative),
    );
    expect(seeded, 'the sweep did not reach a planted module').toContain(planted);
    expect(
      seeded.filter((path) => !population.has(path)),
      'a module the population does not cover was NOT reported outside it — the empty result ' +
        'above is a probe that cannot fail rather than a measurement',
    ).toEqual([planted]);
    expect(domainNamedModules()).not.toContain(planted);

    // And the POPULATION is still NARROW — the third world `toEqual([])` admits,
    // and the one the plant cannot see: a population that swallowed the tree
    // empties the set above too, and a plant absent from the real sweep is
    // reported outside such a population exactly as it is outside a correct one.
    // (Measured on `analytics-ranking-isolation.test.ts`, whose comment claims
    // its shared comparison closes this: mutating that wall's population to
    // `new Set(swept)` leaves all ten of its tests green.)
    assertEachOf([
      'controllers/orders.controller.ts',
      'routes/cart.ts',
      'db/schema/orders.ts',
      'middleware/auth.ts',
    ], 4, (foreign) => {
      expect(CLAIM_PATHS, `${foreign} belongs to another domain`).not.toContain(foreign);
      expect(
        statSync(join(SRC_ROOT, foreign)).isFile(),
        `${foreign} no longer exists, so excluding it proves nothing`,
      ).toBe(true);
    });
  });

  it('a module ADDED to the domain is scanned — the direction a hand list is blind in', () => {
    // The probe that justifies the conversion, kept as a test rather than as a
    // claim that one was run once. Written against the DERIVATION rather than
    // the filesystem: seeding a real file would mutate a tree shared with every
    // parallel suite.
    const seededWith = (directory: string, added: string): string[] =>
      claimNamedSharedModules((relative) =>
        relative === directory
          ? [...readDirectory(relative), { name: added, isDirectory: () => false, isFile: () => true }]
          : readDirectory(relative),
      );

    expect(
      seededWith('db/schema', 'guestClaimArchive.ts'),
      'a new claim schema module does not enter the population',
    ).toContain('db/schema/guestClaimArchive.ts');
    // … and ONLY by name, or this wall starts firing at whoever edits an order.
    expect(
      seededWith('routes', 'orders.ts'),
      'a foreign route entered the population; the name rule has stopped narrowing',
    ).not.toContain('routes/orders.ts');

    // And the RECURSION, the other half of the #460 repair: a module in a
    // SUBDIRECTORY of a shared directory must be admitted. The one-level
    // `readdirSync` this replaced could not see one.
    expect(
      claimNamedSharedModules((relative) =>
        relative === 'routes'
          ? [...readDirectory(relative), { name: 'admin', isDirectory: () => true, isFile: () => false }]
          : relative === 'routes/admin'
            ? [{ name: 'guest-claims.ts', isDirectory: () => false, isFile: () => true }]
            : readDirectory(relative),
      ),
      'a module in a SUBDIRECTORY of a shared directory is not admitted; the sweep beside the ' +
        'recursive walk is still one level deep',
    ).toContain('routes/admin/guest-claims.ts');
  });

  it('no claim module names OxyPay or FairCoin, in code or in copy', () => {
    assertClaimPopulationIsWhole();
    for (const relative of CLAIM_PATHS) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readClaimSource(relative)),
        `${relative} names OxyPay or FairCoin; #109 acceptance 13 excludes both outright`,
      ).toBe(false);
    }
    for (const relative of CLAIM_UI_PATHS) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readClaimUiSource(relative)),
        `${relative} names OxyPay or FairCoin as a claim benefit; #109 UX rule 11`,
      ).toBe(false);
    }

    // …and in the BUNDLES, which is where the sentences actually live now.
    // Without this the screens above stay clean while `en.json` carries
    // "Claim your order and get your FairCoin balance" and every assertion and
    // every floor in this file still passes.
    const bundles = localeBundles();
    expect(
      bundles.length,
      'the storefront ships twelve locales; a shorter list means the bundles moved and this ' +
        'prohibition is no longer scanning the copy',
    ).toBeGreaterThanOrEqual(12);
    for (const bundle of bundles) {
      // A bundle emptied to `{}` would scan clean; the floor is what tells that
      // apart from a bundle that genuinely says nothing forbidden.
      expect(
        bundle.source.length,
        `${bundle.locale}.json looks empty — an empty bundle passes this vacuously`,
      ).toBeGreaterThan(500);
      expect(
        bundle.leaves.length,
        `${bundle.locale}.json produced no strings — check the leaf walk`,
      ).toBeGreaterThan(100);

      // Scanned per LEAF so the currency-name exception can be scoped to a KEY.
      const excused: string[] = [];
      for (const leaf of bundle.leaves) {
        if (CURRENCY_NAME_KEYS.includes(leaf.key)) {
          if (OXYPAY_OR_FAIRCOIN_REFERENCE.test(leaf.value)) excused.push(leaf.key);
          continue;
        }
        expect(
          OXYPAY_OR_FAIRCOIN_REFERENCE.test(leaf.value),
          `${bundle.locale}.json → ${leaf.key} names OxyPay or FairCoin as a claim benefit; ` +
            '#109 acceptance 13 and UX rule 11 exclude both outright',
        ).toBe(false);
      }
      // The exception is only safe while it is still true: every excused key
      // must still be PRESENT and still be NAMING the currency, in every
      // locale, or a reworded key would go on being excused for nothing.
      expect(
        excused.sort(),
        `${bundle.locale}.json: the currency-name exceptions no longer match — ` +
          'a renamed or reworded key excuses nothing while looking like a decision',
      ).toEqual([...CURRENCY_NAME_KEYS].sort());
    }
  });

  it('the claim UX never names a referral partner, its earnings or a conflict', () => {
    // #109 UX rule 12: none of that may be shown to the buyer unless a separate
    // transparent product requirement exists, and none does. The screens have
    // no code route to any of it.
    assertClaimPopulationIsWhole();
    for (const relative of CLAIM_UI_PATHS) {
      expect(
        REFERRAL_REFERENCE.test(readClaimUiSource(relative)),
        `${relative} names the referral domain; the buyer is never shown a partner (UX rule 12)`,
      ).toBe(false);
    }
  });

  it('claiming can never touch referral attribution or conversion', () => {
    assertClaimPopulationIsWhole();
    for (const relative of CLAIM_PATHS) {
      expect(
        REFERRAL_REFERENCE.test(readClaimCode(relative)),
        `${relative} reaches the referral domain; a claim changes ACCESS, not acquisition history`,
      ).toBe(false);
    }
  });

  it('claiming can never reach the payment domain', () => {
    assertClaimPopulationIsWhole();
    for (const relative of CLAIM_PATHS) {
      expect(
        PAYMENT_REFERENCE.test(readClaimCode(relative)),
        `${relative} reaches the payment domain; a claim changes no currency, rail or method`,
      ).toBe(false);
    }
  });

  it('no claim module can find a purchase from a contact', () => {
    assertClaimPopulationIsWhole();
    for (const relative of CLAIM_PATHS) {
      expect(
        CONTACT_LOOKUP_REFERENCE.test(readClaimCode(relative)),
        `${relative} reaches a contact value; a matching email can never authorize a claim (I6)`,
      ).toBe(false);
    }
  });

  it('claiming confers no automatic address, payment method or marketing consent', () => {
    assertClaimPopulationIsWhole();
    for (const relative of CLAIM_PATHS) {
      expect(
        AUTOMATIC_BENEFIT_REFERENCE.test(readClaimCode(relative)),
        `${relative} writes an automatic account benefit; #109 forbidden effects 1, 2 and 3`,
      ).toBe(false);
    }
  });

  it('no lever can hide an ownership record that already exists', () => {
    // An EXACT count on the exemptions, never a floor: a list of excuses that
    // may grow is the wall switching itself off a defensible module at a time.
    expect(FLAG_READING_CLAIM_MODULES.length, 'a fourth module was excused from the flag wall').toBe(
      3,
    );
    expect(NO_FLAG_PATHS.length, 'the flag wall covers too few modules').toBeGreaterThanOrEqual(4);

    for (const relative of NO_FLAG_PATHS) {
      expect(
        GUEST_FLAG_REFERENCE.test(readClaimCode(relative)),
        `${relative} reads a guest lever; a stored claim must survive every flag`,
      ).toBe(false);
    }
  });

  /**
   * The other half of the subtraction, and the reason it is safe rather than
   * merely stated: each excused module must STILL read a lever. A stale
   * exemption excuses nothing while looking like a decision, and here it would
   * hold a real read path outside the only wall that protects a stored claim.
   */
  it('every module excused from the flag wall reads THAT lever and no enablement lever', () => {
    for (const { path, reads, why } of FLAG_READING_CLAIM_MODULES) {
      const code = readClaimCode(path);
      expect(
        reads.test(code),
        `${path} was excused from the flag wall as ${why}, and no longer reads that lever`,
      ).toBe(true);
      expect(NO_FLAG_PATHS, `${path} is both excused and scanned`).not.toContain(path);
      // The half that makes the exception SAFE rather than merely justified:
      // the levers it reads must be the ones it was excused for. `revocation`
      // reading a POLICY is why it is here; `revocation` learning to read an
      // enablement flag would be the exact defect this wall exists to catch,
      // and an exemption keyed on the module rather than on the lever would
      // swallow it silently.
      const levers = [...code.matchAll(/config\.guest\.[A-Za-z.]+/gu)].map((match) => match[0]);
      expect(levers.length, `${path} matched the flag detector but reads no named lever`).toBeGreaterThan(
        0,
      );
      for (const lever of levers) {
        expect(
          reads.test(lever) || /\.(job[A-Za-z]*|pollIntervalMs|leaseMs|batchSize|maxAttempts)$/u.test(lever),
          `${path} reads ${lever}, which is not the lever it was excused for`,
        ).toBe(true);
      }
    }
  });

  /**
   * The mutation self-test. Every detector above runs against text that SHOULD
   * trip it, so a regex broken into matching nothing fails here rather than
   * passing every scan silently.
   */
  it('each detector actually detects (mutation self-test)', () => {
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("provider: 'oxy_pay'")).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('// FairCoin balance on claim, coming soon')).toBe(
      true,
    );
    expect(REFERRAL_REFERENCE.test('await attributeTouch(touchId);')).toBe(true);
    expect(REFERRAL_REFERENCE.test("import { x } from '../referrals/conversion.service.js';")).toBe(
      true,
    );
    expect(PAYMENT_REFERENCE.test("import { openCheckoutPayment } from '../payments/x.js';")).toBe(
      true,
    );
    expect(CONTACT_LOOKUP_REFERENCE.test('where(eq(guestCheckouts.emailHash, hash))')).toBe(true);
    expect(AUTOMATIC_BENEFIT_REFERENCE.test('await insertAddress(oxyUserId, snapshot);')).toBe(
      true,
    );
    expect(AUTOMATIC_BENEFIT_REFERENCE.test('marketingOptIn: true,')).toBe(true);
    expect(GUEST_FLAG_REFERENCE.test('if (!config.guest.claim.enabled) return null;')).toBe(true);
    // …and the things that must NOT trip a detector: FAIR the currency code,
    // which the marketplace names everywhere, and the word "claim" itself,
    // which this whole domain is about.
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("const currency: CurrencyCode = 'FAIR';")).toBe(false);
    expect(REFERRAL_REFERENCE.test('const claim = await insertCompletedClaim(tx, input);')).toBe(
      false,
    );
    expect(GUEST_FLAG_REFERENCE.test('const claim = await findClaimById(db, id);')).toBe(false);
  });
});

describe('#668 — the traversals this gate does itself', () => {
  it('the claim SCREEN scan recurses, which a one-level read did not', () => {
    // Measured with a seeded reader, plus the half that makes it non-circular:
    // the same path is asserted ABSENT from the real tree, so this measures the
    // traversal rather than a directory that happens to be flat today.
    const directory = 'frontend/app/(app)/guest-orders';
    const seeded: PackagesReader = (relative) =>
      relative === directory
        ? [
            ...readPackagesDirectory(relative),
            { name: 'settings', isDirectory: () => true, isFile: () => false },
          ]
        : relative === `${directory}/settings`
          ? [{ name: 'index.tsx', isDirectory: () => false, isFile: () => true }]
          : readPackagesDirectory(relative);
    const planted = `${directory}/settings/index.tsx`;
    // The REAL function, handed the seeded reader. An earlier draft of this test
    // built its own `walk` over the seeded reader and asserted THAT recursed —
    // which measured the copy, not `claimScreens`. Mutation-proved: reverting
    // `claimScreens` to a one-level read left the test green.
    expect(claimScreens(seeded), 'the screen scan does not recurse').toContain(planted);
    expect(
      claimScreens(),
      'the seeded route directory exists on disk, so this proves nothing',
    ).not.toContain(planted);
    // …and the real scan still finds the screens it is there for.
    expect(claimScreens().length, 'the screen scan found nothing').toBeGreaterThanOrEqual(1);
  });

  it('the locale-bundle read lists a FLAT directory', () => {
    assertDirectoriesAreFlat(['frontend/lib/i18n/locales'], (relative) =>
      readdirSync(join(PACKAGES_ROOT, relative), { withFileTypes: true }),
    );
  });
});
