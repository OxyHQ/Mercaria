/**
 * A P2P seller is an OXY ACCOUNT — asserted STRUCTURALLY (#92, #26).
 *
 * Three walls, and every one of them is a scan rather than a promise in a
 * comment, because the failure they prevent is unrecoverable by construction:
 *
 *  1. **No Mercaria person kind, anywhere.** A `follow_targets` row carries ONE
 *     kind and `ensureFollowTarget` is idempotent on the URI, so whoever
 *     registers a URI first fixes its kind FOREVER. A person registered under
 *     `mercaria.*` at a `mercaria.co` URI has their followers split from the
 *     identity every other Oxy app already follows, and there is no repair
 *     short of a data migration. This is the one wall that has to hold on the
 *     FIRST commit, which is why it is a build failure and not a review note.
 *  2. **No Mercaria follow storage.** Follow state, counts and optimistic UI
 *     belong to Oxy's graph. A Mercaria table, endpoint or DTO field carrying
 *     them would be a second, staler copy of somebody else's authority — and a
 *     follower LIST would publish shopping behaviour Oxy never agreed to
 *     publish (#26 follow rule 8, #92 privacy rule 4).
 *  3. **No payment, contact or precise-location data in the public seller
 *     domain.** #92 public-route rule 10 and privacy rule 3.
 *
 * The scanner carries the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor on every scanned file (a moved file fails the gate instead of silently
 * shrinking it), a floor on the number of files scanned, and a mutation
 * self-test for every detector — a regex that rotted would otherwise pass every
 * assertion here by matching nothing.
 *
 * It deliberately scans the STOREFRONT as well as the backend. `registerFollowKind`
 * is a client call — the capability comes from the signed-in user's session, so
 * it cannot run on a server — which means the one file that could commit this
 * mistake lives in a package with no test runner of its own. A gate that only
 * scanned this package would be watching the wrong building.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SELLER_FOLLOW_KIND,
  SELLER_FORBIDDEN_FOLLOW_KINDS,
  SELLER_PROFILE_FORBIDDEN_FIELDS,
  OXY_USER_URI_ORIGIN,
} from '@mercaria/shared-types';

/** `packages/`, from this file. */
const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

/**
 * ## Why this gate does NOT use `__tests__/domain-population.ts` (#460)
 *
 * The shared helper resolves every path against `packages/backend/src`, and
 * both populations here are CROSS-PACKAGE: `registerFollowKind` is a client
 * call — the capability comes from the signed-in user's session, so it cannot
 * run on a server — which means the one file that could commit this mistake
 * lives in a package the helper cannot see. `sweepSrcTreeForDomain` would
 * report a clean tree for a `mercaria.seller` kind in
 * `packages/frontend/lib/follow-graph.ts`, which is the whole subject of wall 1.
 *
 * The second population cannot use it either, for a different and more
 * interesting reason. `assertNothingOutsideDomainPopulation` sweeps for a NAME,
 * and this domain's name is the commonest word in a marketplace backend:
 * `/seller/i` over `packages/backend/src` selects **19** modules, of which
 * **12** belong to eight other domains (#62 ingestion, moderation, #47
 * payments, #71 product-page, the buyers repository, and the seller's own
 * MANAGEMENT surface `routes/seller.ts` and its four controllers, which #92
 * §"`/sellers` (plural) is public; `/seller` (singular) is the seller's own"
 * puts outside this domain deliberately). A whole-tree assertion here would
 * therefore carry a twelve-entry exclusion list that every unrelated domain has
 * to maintain — a `services/payments/seller-payout.ts` added tomorrow would
 * fail a gate about Oxy follow identity — and a gate that cries wolf is the one
 * somebody deletes.
 *
 * And an ANCHORED pattern (`^backend/src/(services/sellers/|controllers/public-sellers|…)`)
 * cannot be handed to the helper either: the sweep would then match exactly the
 * paths the population is built from, so `toEqual([])` would hold by
 * construction. That is `expect(scanned).toBe(LIST.length)` wearing a different
 * shape.
 *
 * So the remedy #460 asks for is applied HERE, in the form this gate can carry:
 * the populations are DERIVED from a recursive walk of every package this
 * repository owns, the follow-surface one by CONTENT, and the wall that a
 * content predicate could not reach is pointed at the whole corpus instead. See
 * {@link LOCAL_FOLLOW_STORAGE}'s scan below for the hole that found.
 */

/**
 * Every `.ts`/`.tsx` under one package, RECURSIVELY.
 *
 * Recursive rather than a directory listing, because the failure a flat read
 * has is silent: a follow surface added one level deeper than the walk reaches
 * is in no population and behind no wall, and the gate goes on reporting the
 * same count it always did.
 */
/**
 * Every package whose source this gate walks.
 *
 * `frontend` and `backend/src` were the two. The other three are added for the
 * same reason the walk is recursive: a follow surface added one level deeper —
 * or one PACKAGE over — is in no population and behind no wall, and the gate
 * goes on reporting the count it always did. Measured: `ui`, `dashboard` and
 * `pos` hold ZERO follow surfaces today, so no count moves; `@mercaria/ui` is
 * where a `FollowTargetButton` wrapper would most plausibly be written.
 *
 * `shared-types` is deliberately NOT walked: the contract module's whole job is
 * to write `followerIds` down as a PROHIBITION, so scanning it would fire on
 * the very list that enforces the rule — the reason already stated below for
 * excluding it from the storage detector.
 */
const SCANNED_PACKAGES = ['frontend', 'backend/src', 'ui', 'dashboard', 'pos'] as const;

function sourceFilesUnder(packageRelative: string): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      // Build output and vendored code are not this repository's source.
      if (['node_modules', '__tests__', '.expo', 'dist', 'android', 'ios'].includes(entry.name)) {
        continue;
      }
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        found.push(relative(PACKAGES_ROOT, absolute));
      }
    }
  };
  walk(join(PACKAGES_ROOT, packageRelative));
  return found.sort();
}

/**
 * What makes a file a FOLLOW SURFACE: it names the follow graph.
 *
 * The population is DERIVED from this predicate over a recursive walk of both
 * packages, and is deliberately not a list. A hand list of follow surfaces
 * fails in the one direction that matters — somebody adds an eighth and it is
 * in no list, so the wall that exists to stop a `mercaria.*` person kind never
 * looks at the file that introduces one.
 */
const FOLLOW_SYMBOL =
  /\b(ensureFollowTarget|registerFollowKind|FollowTargetButton|follow_?targets?|followKind|use[A-Z]\w*Follow|[A-Z]\w*FollowButton)\b/;

/**
 * Files the follow predicate matches that are NOT follow surfaces, each with
 * its reason.
 *
 * The EXCLUSION is what is written down, never the inclusion — a new file is in
 * the population by default and has to be argued OUT, which is the opposite of
 * the failure above. Every entry is asserted below to still MATCH the
 * predicate, so one that stops applying fails as STALE rather than quietly
 * excusing nothing (#448).
 */
const FOLLOW_SURFACE_EXCLUSIONS: readonly { readonly path: string; readonly why: string }[] = [];

/**
 * Every source file of every package this repository owns, read ONCE.
 *
 * Both derivations below are filters over this, so a file cannot be in one
 * corpus and not the other, and the storage scan costs no extra I/O.
 */
const CORPUS: readonly { readonly path: string; readonly source: string }[] =
  SCANNED_PACKAGES.flatMap((packageRelative) =>
    sourceFilesUnder(packageRelative).map((path) => ({
      path,
      source: readFileSync(join(PACKAGES_ROOT, path), 'utf8'),
    })),
  );

/** Every follow surface in any package, derived. */
const FOLLOW_SURFACE_PATHS: readonly string[] = CORPUS.filter((file) =>
  FOLLOW_SYMBOL.test(file.source),
)
  .map((file) => file.path)
  .filter((path) => !FOLLOW_SURFACE_EXCLUSIONS.some((excluded) => excluded.path === path));

/**
 * The whole public-seller domain on the API side, DERIVED the same way.
 *
 * By PATH rather than by content: this domain is defined by where a file lives
 * (`services/sellers/`) plus the three seam files that serve it, and a content
 * predicate would sweep in every module that merely mentions a seller — which
 * is most of a marketplace backend.
 */
const SELLER_DOMAIN_PATTERN = /^backend\/src\/(services\/sellers\/|controllers\/public-sellers|routes\/public-sellers|middleware\/seller-schemas)/;

const SELLER_DOMAIN_PATHS: readonly string[] = CORPUS.map((file) => file.path).filter((path) =>
  SELLER_DOMAIN_PATTERN.test(path),
);

/** A kind literal in Mercaria's own namespace naming a PERSON. */
const MERCARIA_PERSON_KIND = /mercaria\.(seller|user|person|buyer|account)\b/;

/** A call that DECLARES a kind — the only operation that can fix one forever. */
const REGISTER_KIND_CALL = /registerFollowKind\s*\(/;

/** A follow target URI built on a Mercaria host. */
const MERCARIA_FOLLOW_URI = /['"`]https:\/\/(?:[a-z0-9-]+\.)?mercaria\.co\/(?:users|sellers|people)\//;

/** Mercaria storing, serving or counting a follow relationship of its own. */
const LOCAL_FOLLOW_STORAGE =
  /\b(followers?Count|followerIds|followerList|sellerFollows?|follow_?relationships?|followTargets?Table)\b/;

/** The payment/onboarding domain, from any direction. */
const PAYMENT_REFERENCE =
  /payments\/|providerAccount|provider_accounts|onboardingState|stripe|chargesEnabled|payoutsEnabled/i;

/** Precise geography — the columns a listing may carry and a PERSON may not. */
const PRECISE_LOCATION_REFERENCE = /\b(latitude|longitude|st_dwithin|listings\.geo|coordinates)\b/i;

function read(relative: string): string {
  const source = readFileSync(join(PACKAGES_ROOT, relative), 'utf8');
  // The vacuity floor: an empty or moved file must fail HERE, not pass the scan
  // by having nothing to match.
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * Strip line and block comments.
 *
 * Load-bearing: every module in this domain DOCUMENTS what it refuses to do, in
 * exactly the vocabulary the detectors match. Scanning raw source would fail on
 * the prose explaining why the code is correct — the shape that gets a gate
 * disabled by whoever hits it next.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('no Mercaria person identity can be registered', () => {
  it('names no `mercaria.*` person kind in any follow surface', () => {
    let scanned = 0;
    for (const relative of FOLLOW_SURFACE_PATHS) {
      const code = stripComments(read(relative));
      expect(
        MERCARIA_PERSON_KIND.test(code),
        `${relative} names a Mercaria person follow kind; a person is 'oxy.user'`,
      ).toBe(false);
      expect(
        MERCARIA_FOLLOW_URI.test(code),
        `${relative} builds a mercaria.co follow URI for a person`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(FOLLOW_SURFACE_PATHS.length);
    // The scanned-file floor: a broken traversal cannot pass by scanning none.
    // TWELVE, measured, not the seven the hand list carried — the walk found
    // five surfaces that were in no list and behind no wall
    // (`products/[id]`, `stores/[handle]`, `StoreMenuSheet`, `storeLinkage`,
    // `merchant-pages/native-store`). A floor left at seven cannot notice five
    // of them disappearing again.
    expect(scanned).toBeGreaterThanOrEqual(12);
  });

  it('registers exactly ONE kind, and it is the STORE', () => {
    // `registerFollowKind` is what fixes a kind's meaning. Exactly one call
    // exists in the storefront, it lives in `follow-graph.ts`, and it registers
    // `mercaria.store` — a Mercaria-local shop with no Oxy account behind it.
    const registering = FOLLOW_SURFACE_PATHS.filter((relative) =>
      REGISTER_KIND_CALL.test(stripComments(read(relative))),
    );
    expect(registering).toEqual(['frontend/lib/follow-graph.ts']);

    const graph = stripComments(read('frontend/lib/follow-graph.ts'));
    expect(graph).toContain("'mercaria.store'");
    // And the seller hook registers NOTHING — `oxy.user` is a platform kind
    // owned by no application, and Oxy's registry would refuse the claim.
    const sellerHook = stripComments(read('frontend/lib/hooks/use-seller-follow.ts'));
    expect(REGISTER_KIND_CALL.test(sellerHook)).toBe(false);
    expect(sellerHook).not.toContain('claimFollowNamespace');
  });

  it('follows a seller as `oxy.user` at Oxy’s own origin', () => {
    const sellerHook = stripComments(read('frontend/lib/hooks/use-seller-follow.ts'));
    expect(sellerHook).toContain('SELLER_FOLLOW_KIND');
    expect(sellerHook).toContain('oxyUserFollowUri');
    // `localUserId` is the dedicated `follow_targets` column only `oxy.user`
    // targets populate, and it is what keeps Oxy's optimized account graph
    // authoritative for user-to-user queries (#26).
    expect(sellerHook).toContain('localUserId');
    expect(SELLER_FOLLOW_KIND).toBe('oxy.user');
    expect(OXY_USER_URI_ORIGIN).toBe('https://oxy.so');
  });

  it('every follow-surface EXCLUSION is still real, and there are exactly none', () => {
    // A list of exemptions needs its own exact-count assertion, or one arrives
    // in a later diff and nothing says so (#448). It is empty today: every file
    // the predicate matches IS a follow surface.
    expect(FOLLOW_SURFACE_EXCLUSIONS).toHaveLength(0);
    for (const excluded of FOLLOW_SURFACE_EXCLUSIONS) {
      // An entry that no longer matches is excusing nothing and is STALE —
      // it must fail here rather than sit in the file looking load-bearing.
      expect(
        FOLLOW_SYMBOL.test(readFileSync(join(PACKAGES_ROOT, excluded.path), 'utf8')),
        `${excluded.path} is excluded (${excluded.why}) but no longer names the follow graph`,
      ).toBe(true);
    }
  });

  it('the detectors actually detect — the mutation self-test', () => {
    // Break each thing the gate guards, in miniature, and confirm the gate sees
    // it. A scanner whose regex rotted would pass every assertion above
    // vacuously and fail here loudly.
    expect(MERCARIA_PERSON_KIND.test("kind: 'mercaria.seller'")).toBe(true);
    expect(MERCARIA_PERSON_KIND.test("kind: 'mercaria.user'")).toBe(true);
    expect(MERCARIA_PERSON_KIND.test("kind: 'mercaria.store'")).toBe(false);
    for (const kind of SELLER_FORBIDDEN_FOLLOW_KINDS) {
      expect(MERCARIA_PERSON_KIND.test(`kind: '${kind}'`)).toBe(true);
    }
    expect(REGISTER_KIND_CALL.test('await oxyServices.registerFollowKind({ kind })')).toBe(true);
    expect(REGISTER_KIND_CALL.test('await oxyServices.ensureFollowTarget({ kind })')).toBe(false);
    expect(MERCARIA_FOLLOW_URI.test("`https://mercaria.co/users/${id}`")).toBe(true);
    expect(MERCARIA_FOLLOW_URI.test("`https://oxy.so/users/${id}`")).toBe(false);
    // And the comment stripper does not eat code.
    expect(stripComments("const a = 1; // mercaria.seller\n")).not.toContain('mercaria.seller');
    expect(stripComments("const kind = 'mercaria.seller';\n")).toContain('mercaria.seller');
    expect(stripComments("const url = 'https://x/y';\n")).toContain('https://x/y');
  });
});

describe('Mercaria stores no follow state of its own', () => {
  it('NO module in any package holds a count, a list or a relationship', () => {
    // #460: this wall used to scan `FOLLOW_SURFACE_PATHS ∪ SELLER_DOMAIN_PATHS`
    // and that is not the population it needs, because the two vocabularies are
    // DISJOINT. `FOLLOW_SYMBOL` is about REACHING Oxy's graph
    // (`ensureFollowTarget`, `registerFollowKind`, `FollowTargetButton`); a
    // module that stores a follower COUNT of its own reaches Oxy's graph
    // nowhere, names none of those symbols, and need not sit in the public
    // seller domain either.
    //
    // DEMONSTRATED rather than argued: `export const sellerFollowerCount` with
    // a `followerCount` inside it, planted in the REAL
    // `db/buyers/sellerProfileRepository.ts` — the repository for
    // `seller_profiles`, which is exactly where somebody would put it — passed
    // this gate 10/10 GREEN before this change.
    //
    // So the population is the whole CORPUS. Measured: the storage vocabulary
    // matches ZERO files across all five packages today, so this costs no
    // exclusion list and no false wall.
    const offenders = CORPUS.filter((file) => LOCAL_FOLLOW_STORAGE.test(stripComments(file.source)));
    expect(
      offenders.map((file) => file.path),
      'a module holds Mercaria follow state; the Oxy graph is the only authority',
    ).toEqual([]);

    // The floors, PER SHAPE. A total lets one collapse behind another, and the
    // corpus floor is what stops a broken walk reporting a clean workspace.
    expect(CORPUS.length, 'the walk found almost no source').toBeGreaterThanOrEqual(1_800);
    expect(
      FOLLOW_SURFACE_PATHS.length,
      'the follow-surface derivation found nothing',
    ).toBeGreaterThanOrEqual(12);
    expect(
      SELLER_DOMAIN_PATHS.length,
      'the public-seller derivation found nothing',
    ).toBeGreaterThanOrEqual(7);
  });

  it('the corpus REACHES the module the widening exists for', () => {
    // NAMED rather than floored, and named on the file the plant above used: a
    // corpus floor of 1,800 is met with `db/buyers/` missing entirely, and the
    // module that made this wall vacuous is the one a floor cannot speak about.
    const victim = 'backend/src/db/buyers/sellerProfileRepository.ts';
    expect(
      CORPUS.map((file) => file.path),
      `${victim} is the seller_profiles repository and the scan no longer reaches it`,
    ).toContain(victim);

    // The half that makes this a measurement rather than an assertion about a
    // convenient tree: NEITHER of the two old populations contains it, so the
    // corpus is what is being measured.
    expect(FOLLOW_SURFACE_PATHS, 'the old wall would have reached it after all').not.toContain(
      victim,
    );
    expect(SELLER_DOMAIN_PATHS, 'the old wall would have reached it after all').not.toContain(
      victim,
    );

    // …and the detector genuinely fires on the planted shape, so the empty
    // result above cannot mean the vocabulary stopped matching.
    expect(LOCAL_FOLLOW_STORAGE.test('const followerCount = 0;')).toBe(true);
  });

  it('the corpus spans every package, not just the two it used to', () => {
    // A walk that lost a package reports a clean workspace exactly as a healthy
    // one does. Asserted per package rather than as a total.
    for (const packageRelative of SCANNED_PACKAGES) {
      const prefix = `${packageRelative}/`;
      expect(
        CORPUS.filter((file) => file.path.startsWith(prefix)).length,
        `${packageRelative} contributed no source — did the walk break?`,
      ).toBeGreaterThanOrEqual(50);
    }
    expect(SCANNED_PACKAGES.length).toBe(5);
  });

  it('names the follower family in the forbidden-field VALUE', () => {
    // The contract module itself is deliberately NOT scanned with the detector
    // above: its whole job is to write those words down as a prohibition, so a
    // source scan there would fire on the very list that enforces the rule —
    // the shape that gets a gate disabled by whoever hits it next.
    //
    // The value is the enforcement instead, and the RUNTIME half lives in
    // `public-seller-profile.service.test.ts`, which walks a real emitted
    // profile and asserts no key matches any of these.
    for (const field of ['followers', 'followerIds', 'followerIdentities'] as const) {
      expect(SELLER_PROFILE_FORBIDDEN_FIELDS).toContain(field);
    }
  });

  it('the detector detects', () => {
    expect(LOCAL_FOLLOW_STORAGE.test('const followerCount = 3;')).toBe(true);
    expect(LOCAL_FOLLOW_STORAGE.test('followerIds: string[]')).toBe(true);
    expect(LOCAL_FOLLOW_STORAGE.test('const followTargetId = target.id;')).toBe(false);
  });
});

describe('the public seller domain cannot reach payment or precise location', () => {
  it('imports no payment module and names no onboarding state', () => {
    let scanned = 0;
    for (const relative of SELLER_DOMAIN_PATHS) {
      const code = stripComments(read(relative));
      expect(
        PAYMENT_REFERENCE.test(code),
        `${relative} references the payment domain; a public profile must not carry onboarding data`,
      ).toBe(false);
      expect(
        PRECISE_LOCATION_REFERENCE.test(code),
        `${relative} references precise geography; coarse location belongs to a LISTING that opted in`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(SELLER_DOMAIN_PATHS.length);
    expect(scanned).toBeGreaterThanOrEqual(7);
  });

  it('the detectors detect', () => {
    expect(PAYMENT_REFERENCE.test("import { x } from '../payments/provider.js'")).toBe(true);
    expect(PAYMENT_REFERENCE.test('onboardingState: "complete"')).toBe(true);
    expect(PAYMENT_REFERENCE.test("import { getCart } from '../cart.service.js'")).toBe(false);
    expect(PRECISE_LOCATION_REFERENCE.test('latitude: 41.38')).toBe(true);
    expect(PRECISE_LOCATION_REFERENCE.test('st_dwithin(geo, point, radius)')).toBe(true);
    expect(PRECISE_LOCATION_REFERENCE.test('const country = "ES";')).toBe(false);
  });
});
