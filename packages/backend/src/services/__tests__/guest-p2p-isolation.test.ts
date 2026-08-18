/**
 * The guest-P2P domain's structural boundaries (#112), asserted by SCAN.
 *
 * Each is a claim about what this policy CANNOT reach, and a behavioural test
 * can only ever say "it did not this time". A derivation that cannot import a
 * repository cannot quietly acquire a second source of truth; a policy with no
 * route to a buyer cannot decide a seller's eligibility from a card
 * fingerprint, an email domain or a session; a domain that cannot reach ranking
 * cannot let guest status cost a seller organic placement; and a domain with no
 * account-creation call cannot manufacture eligibility by turning the buyer
 * into an account holder behind their back.
 *
 * Both defences from `~/Oxy/AGENTS.md` are here: a vacuity floor (a moved or
 * emptied file fails the gate rather than shrinking it silently) and a mutation
 * self-test (each detector runs against a seeded positive, so a regex broken
 * into matching nothing fails HERE instead of passing every scan).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

/** Anything whose name carries this domain, in either spelling. */
const DOMAIN_NAMED = /guest-p2p|guestP2P/i;

/**
 * The shared flat directories a module of this domain lives in under a domain
 * NAME.
 *
 * `db/schema` is deliberately NOT here, and that is a decision rather than the
 * omission #460 found in this gate's siblings. #112's answer was NO-GO and the
 * domain owns no table at all — so there is nothing to scan, a floor over it
 * could only ever be zero, and listing it would make a `db/schema/guestP2p.ts`
 * appearing one day slide silently into the population. The whole-tree
 * assertion below reports one instead, which for THIS domain is the right
 * failure: a table means somebody built durable guest-P2P state, and that is a
 * decision a person should be made to take.
 */
const P2P_SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware'] as const;

/**
 * Every module in the tree whose PATH names this domain — the assertion that
 * closes the population against the NEXT mechanism, not only this one.
 *
 * Matched on the PATH, not the filename: the five modules under
 * `services/guest-p2p/` name the domain nowhere in their own names, so a
 * filename sweep reports a fraction of the domain and an empty "outside" set,
 * which reads exactly like a clean pass.
 */
function domainNamedModules(readDir: DirectoryReader = readDirectory): string[] {
  return walk('', readDir).filter((path) => DOMAIN_NAMED.test(path));
}

/**
 * The domain's HTTP surface, from the filename convention (#472's device).
 *
 * RECURSES, via `walk`. It was `readdirSync(...).filter(entry.isFile())` — ONE
 * level — sitting ten lines below a `walk` that recurses, so the file read as
 * though it recursed throughout and it did not. #460 measured that asymmetry in
 * 27 gates; it is live rather than latent, `routes/admin/merchant-activation.ts`
 * being the module it dropped in a sibling gate. Nothing of this domain sits in
 * a subdirectory today, so this adds no module — it closes the mechanism.
 */
function httpSurface(readDir: DirectoryReader = readDirectory): string[] {
  return P2P_SHARED_DIRECTORIES.flatMap((directory) =>
    walk(directory, readDir).filter((path) => DOMAIN_NAMED.test(path.split('/').pop() ?? '')),
  );
}

/**
 * Every module of the domain, WALKED rather than listed (#460).
 *
 * The list this replaces named the same six modules and the walk finds the same
 * six: converted for DURABILITY, and it found no gap. That is a complete result
 * rather than a wasted one — a list is complete on the day it is written and
 * silently incomplete the day somebody adds a module, and this domain's whole
 * point is that no configuration, operator action or service bug can enable
 * guest P2P checkout. A seventh module invisible to these walls is exactly how
 * that stops being true.
 */
const GUEST_P2P_PATHS = [...walk('services/guest-p2p'), ...httpSurface()];

/**
 * The two files that must stay PURE: the policy and the derivation.
 *
 * `getRetailEligibility`'s rule (#121), and the reason is the same. The moment
 * a derivation can read a row it acquires a second input nobody stated, and the
 * criteria stop being reviewable by reading one file. `facts.ts` is the module
 * that reads, and it is absent from this list rather than exempted inside it.
 */
const PURE_PATHS = ['services/guest-p2p/policy.ts', 'services/guest-p2p/eligibility.ts'];

/** Anything that reads or writes storage, or reaches a service that does. */
const STORAGE_REFERENCE =
  /from '.*\/db\/|getDb\(|drizzle|\.select\(|\.insert\(|\.update\(|Repository|await\s+find[A-Z]|await\s+read[A-Z]|await\s+count[A-Z]/;

/**
 * A BUYER, in any form (#112 identity rules 1–8, ADR 0003 I2).
 *
 * The eligibility of a seller and a listing is decided from the seller and the
 * listing. Nothing about the person buying may enter it — not their session id,
 * not their contact, not their address, not a card, not a device. The absence
 * IS the enforcement: there is no parameter these modules could read one from,
 * and this scan is what keeps it that way.
 *
 * The actor's KIND is deliberately not in the pattern, and the distinction is
 * the whole design rather than an exemption: `gate.ts` must know whether the
 * caller is a guest — that is what "server-authoritative" means here — and a
 * discriminant naming a CLASS of caller identifies nobody. What it must never
 * hold is a value that identifies ONE buyer, which is what every member below
 * is. The mutation self-test pins both sides.
 */
const BUYER_REFERENCE =
  /guestSessionId|guest_sessions\b|emailHash|email_hash|emailCiphertext|email_ciphertext|buyerEmail|cardFingerprint|card_fingerprint|deviceId|ipAddress|userAgent|portalGrant|guest_order_access_grants/;

/**
 * Creating or implying an Oxy account (#112 default state 5, acceptance 3).
 *
 * "No hidden automatic account creation is used to bypass the gate", and "a
 * guest is never turned into a fake Oxy buyer". A domain with no call that
 * could mint, register or convert an identity cannot do it by accident.
 */
const ACCOUNT_CREATION_REFERENCE =
  /createUser|registerUser|signUp|createOxyAccount|convertGuest|convertSession|claimGuest|mergeGuestCart|issueGuestActor/;

/**
 * Ranking, fees and referrals (#112 seller eligibility's closing sentence).
 *
 * "Guest status alone cannot be used to worsen the seller's organic ranking",
 * and eligibility may not be bought. The `fee-ranking-isolation.test.ts`
 * precedent, applied in the direction that matters here: this policy has no
 * route into a scorer, so it cannot become a term in one, and no route into the
 * fee or referral domains, so a commission cannot become a criterion.
 */
const RANKING_OR_COMMERCIAL_REFERENCE =
  /services\/ranking|rankOffers|rankingPolicy|OfferRankingFacts|services\/fees|feeSchedule|commission|services\/referrals|referralAttribution/;

/**
 * Silent defaulting (#112's "unknown is never zero and never a soft yes").
 *
 * `facts.ts` is the one module that could turn an absent record into a value,
 * and the discipline is that it never does: every absence becomes `unknown(…)`
 * naming who would supply it. A `??` on a fact is how that discipline is lost,
 * and it is lost invisibly — the code still compiles and the criterion still
 * "passes".
 *
 * The pattern deliberately allows `?? []` and `?? 0` NOWHERE in the fact
 * assembly. `salesCount ?? 0` is the one exception the detector must not catch
 * blindly, so it is narrowed to coalescing on the SIGNAL constructors' inputs
 * rather than on any expression — see the mutation self-test for both sides.
 */
const DEFAULTED_SIGNAL_REFERENCE = /known\([^)]*\?\?[^)]*\)\s*:\s*known\(|unknown\(\)\s*\?\?/;

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
 * detectors look for (`authorization.ts` explains why no account is created;
 * `eligibility.ts` explains why a card fingerprint is not an input), so
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

describe('the guest-P2P policy cannot reach what it must not', () => {
  it('scans the whole domain — a module added and not listed fails here', () => {
    // Vacuity floors PER SHAPE rather than one on the total: the two sources break
    // independently, and one total would let the walk collapse to zero while the
    // HTTP surface carried the number.
    expect(
      GUEST_P2P_PATHS.filter((path) => path.startsWith('services/guest-p2p/')).length,
      'the domain walk found nothing',
    ).toBeGreaterThanOrEqual(5);
    expect(httpSurface().length, 'the HTTP surface derivation found nothing').toBeGreaterThanOrEqual(1);
    expect(GUEST_P2P_PATHS.length).toBeGreaterThanOrEqual(6);
    for (const path of GUEST_P2P_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }
    expect(GUEST_P2P_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
    // EXACT: the pure set is an identity, not a predicate (#448).
    expect(PURE_PATHS.length, 'the pure-module list changed size').toBe(2);
    for (const path of PURE_PATHS) {
      expect(GUEST_P2P_PATHS, `${path} is held pure but is not in the domain`).toContain(path);
    }
    for (const relative of GUEST_P2P_PATHS) {
      expect(readDomainSource(relative).length).toBeGreaterThan(200);
    }
  });

  it('no guest-p2p-named module anywhere in src/ sits outside the population', () => {
    // #460's whole-tree assertion, and the reason this gate needed it even
    // though the conversion found NO gap: a walked population whose DIRECTORY
    // list is hand-written is still a hand list, and the miss lives one level
    // up, in the list of directories the walk reads. Nothing here is outside
    // the population TODAY — which is a complete result rather than a wasted
    // one, because the direction a list is blind in is the module somebody
    // adds next, and the plant below is what measures that.
    const swept = domainNamedModules();

    // The sweep's OWN vacuity floor: a traversal that reached nothing reports
    // no module outside the population, the same answer a complete population
    // gives. MEASURED at 6.
    expect(
      swept.length,
      'the whole-tree sweep found almost nothing; it cannot report a module outside the ' +
        'population if it never reached one',
    ).toBeGreaterThanOrEqual(5);

    // EXACT and empty, and empty because MEASURED empty rather than guessed.
    const population = new Set(GUEST_P2P_PATHS);
    expect(
      swept.filter((path) => !population.has(path)),
      'names guest P2P but sits outside the population every wall here scans — add its ' +
        'directory to P2P_SHARED_DIRECTORIES, or excuse it here with a reason and move the count',
    ).toEqual([]);

    // THE POSITIVE CONTROL, and the whole justification for converting a gate
    // whose population did not change: `toEqual([])` is also what a sweep that
    // reached nothing produces. A guest-p2p-named module is reported to the
    // real sweep in a directory the population does NOT draw from, and it must
    // come back OUTSIDE.
    const planted = 'db/schema/guestP2p.ts';
    const seeded = domainNamedModules((relative) =>
      relative === 'db/schema'
        ? [...readDirectory(relative), { name: 'guestP2p.ts', isDirectory: () => false, isFile: () => true }]
        : readDirectory(relative),
    );
    expect(seeded, 'the sweep did not reach a planted module').toContain(planted);
    expect(
      seeded.filter((path) => !population.has(path)),
      'a module the population does not cover was NOT reported outside it — the empty result ' +
        'above is a probe that cannot fail rather than a measurement',
    ).toEqual([planted]);
    // …and the plant is not on disk, or the control asserts about the tree
    // rather than about the sweep. It is deliberately the SCHEMA module #112
    // does not have: a table here would mean somebody built durable guest-P2P
    // state, and this is the assertion that would say so.
    expect(domainNamedModules()).not.toContain(planted);

    // And the POPULATION is still NARROW — the third world `toEqual([])` admits
    // and the one the plant cannot see, since a plant absent from the real
    // sweep is reported outside a population built FROM that sweep exactly as
    // it is outside a correct one.
    for (const foreign of [
      'controllers/checkout.controller.ts',
      'routes/cart.ts',
      'services/checkout.service.ts',
      'middleware/auth.ts',
    ]) {
      expect(GUEST_P2P_PATHS, `${foreign} belongs to another domain`).not.toContain(foreign);
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
      httpSurface((relative) =>
        relative === directory
          ? [...readDirectory(relative), { name: added, isDirectory: () => false, isFile: () => true }]
          : readDirectory(relative),
      );

    expect(
      seededWith('routes', 'guest-p2p.ts'),
      'a new guest-p2p route does not enter the population; it would sit behind no wall',
    ).toContain('routes/guest-p2p.ts');
    // … and ONLY by name, or this wall starts firing at whoever edits checkout.
    expect(
      seededWith('routes', 'checkout.ts'),
      'a foreign route entered the population; the name rule has stopped narrowing',
    ).not.toContain('routes/checkout.ts');

    // And the RECURSION, the other half of the #460 repair.
    expect(
      httpSurface((relative) =>
        relative === 'routes'
          ? [...readDirectory(relative), { name: 'admin', isDirectory: () => true, isFile: () => false }]
          : relative === 'routes/admin'
            ? [{ name: 'guest-p2p.ts', isDirectory: () => false, isFile: () => true }]
            : readDirectory(relative),
      ),
      'a module in a SUBDIRECTORY of a shared directory is not admitted; the sweep beside the ' +
        'recursive walk is still one level deep',
    ).toContain('routes/admin/guest-p2p.ts');
  });

  it('the policy and the derivation read nothing at all', () => {
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

  it('no module in the domain reads a buyer, in any form', () => {
    let scanned = 0;
    for (const relative of GUEST_P2P_PATHS) {
      expect(
        BUYER_REFERENCE.test(readDomainCode(relative)),
        `${relative} reads a buyer value; eligibility is decided from the SELLER and the LISTING`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(GUEST_P2P_PATHS.length);
  });

  it('nothing here can create, convert or imply an Oxy account', () => {
    let scanned = 0;
    for (const relative of GUEST_P2P_PATHS) {
      expect(
        ACCOUNT_CREATION_REFERENCE.test(readDomainCode(relative)),
        `${relative} could create or convert an identity; the gate may never be bypassed that way`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(GUEST_P2P_PATHS.length);
  });

  it('nothing here can reach ranking, fees or referrals', () => {
    let scanned = 0;
    for (const relative of GUEST_P2P_PATHS) {
      expect(
        RANKING_OR_COMMERCIAL_REFERENCE.test(readDomainCode(relative)),
        `${relative} reaches ranking or a commercial domain; guest status may not move a seller's rank`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(GUEST_P2P_PATHS.length);
  });

  it('the fact assembly never defaults an absent record into a value', () => {
    expect(
      DEFAULTED_SIGNAL_REFERENCE.test(readDomainCode('services/guest-p2p/facts.ts')),
      'facts.ts coalesces an absent record into a known value; unknown must stay unknown',
    ).toBe(false);
  });

  /**
   * The mutation self-test. Every detector above runs against text that SHOULD
   * trip it, and against text that must NOT — a scanner nobody has seen fail is
   * a scanner nobody knows works.
   */
  it('each detector actually detects (mutation self-test)', () => {
    expect(STORAGE_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(true);
    expect(STORAGE_REFERENCE.test('const rows = await findListingById(id);')).toBe(true);
    expect(BUYER_REFERENCE.test('if (actor.guestSessionId === session.id) return true;')).toBe(true);
    expect(BUYER_REFERENCE.test('where(eq(guestCheckouts.emailHash, hash))')).toBe(true);
    // The KIND is a class of caller and identifies nobody; the ID identifies
    // one person. The gate legitimately reads the first and never the second.
    expect(BUYER_REFERENCE.test("case 'guest_session':")).toBe(false);
    expect(ACCOUNT_CREATION_REFERENCE.test('await createOxyAccount(contact.email);')).toBe(true);
    expect(ACCOUNT_CREATION_REFERENCE.test('await issueGuestActor(req, res);')).toBe(true);
    expect(RANKING_OR_COMMERCIAL_REFERENCE.test("import { rankOffers } from '../ranking/rank.js';")).toBe(
      true,
    );
    expect(RANKING_OR_COMMERCIAL_REFERENCE.test('const fee = commission * bps;')).toBe(true);
    expect(DEFAULTED_SIGNAL_REFERENCE.test('x ? known(row.tier ?? "new") : known("new")')).toBe(true);

    // …and the things that must NOT trip a detector: the domain's own
    // vocabulary, and the one legitimate coalesce in `facts.ts` (a stored
    // counter that is NOT NULL in the schema and defaults to zero there).
    expect(STORAGE_REFERENCE.test('const verdict = deriveVerdict(criteria);')).toBe(false);
    expect(BUYER_REFERENCE.test("const sellerKey = `user:${sellerOxyUserId}`;")).toBe(false);
    expect(ACCOUNT_CREATION_REFERENCE.test('const authorization = readGuestP2PAuthorization();')).toBe(
      false,
    );
    expect(RANKING_OR_COMMERCIAL_REFERENCE.test('const scope = GUEST_P2P_BOUNDED_SCOPE;')).toBe(false);
    expect(DEFAULTED_SIGNAL_REFERENCE.test('known(profiles[0]?.salesCount ?? 0)')).toBe(false);
  });
});
