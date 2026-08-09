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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
 * Every file that decides how a follow target is named, in EITHER package.
 *
 * A new follow surface belongs on this list — the floor below is what forces
 * whoever adds one to look here.
 */
const FOLLOW_SURFACE_PATHS = [
  'frontend/lib/follow-graph.ts',
  'frontend/lib/hooks/use-store-follow.ts',
  'frontend/lib/hooks/use-seller-follow.ts',
  'frontend/components/store/StoreFollowButton.tsx',
  'frontend/components/seller/SellerFollowButton.tsx',
  'frontend/components/seller/SellerLinkCard.tsx',
  'frontend/app/(app)/sellers/[oxyUserId].tsx',
];

/** The whole public-seller domain on the API side. */
const SELLER_DOMAIN_PATHS = [
  'backend/src/services/sellers/public-seller-profile.service.ts',
  'backend/src/services/sellers/seller-visibility.ts',
  'backend/src/services/sellers/seller-trust.ts',
  'backend/src/services/sellers/viewer-oxy-client.ts',
  'backend/src/controllers/public-sellers.controller.ts',
  'backend/src/routes/public-sellers.ts',
  'backend/src/middleware/seller-schemas.ts',
];

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
    expect(scanned).toBeGreaterThanOrEqual(7);
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
  it('no follow surface holds a count, a list or a relationship', () => {
    let scanned = 0;
    for (const relative of [...FOLLOW_SURFACE_PATHS, ...SELLER_DOMAIN_PATHS]) {
      const code = stripComments(read(relative));
      expect(
        LOCAL_FOLLOW_STORAGE.test(code),
        `${relative} holds follow state; the Oxy graph is the only authority`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(FOLLOW_SURFACE_PATHS.length + SELLER_DOMAIN_PATHS.length);
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
