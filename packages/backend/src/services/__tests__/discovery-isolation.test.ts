/**
 * The wall between the discovery domain's popularity counts and offer ranking,
 * asserted STRUCTURALLY rather than promised.
 *
 * `OFFER_FORBIDDEN_RANKING_SIGNALS` (`@mercaria/shared-types`) names eleven
 * things that may never influence organic OFFER rank, and `merchant_popularity`
 * and `brand_popularity` are two of them. `db/schema/ranking.ts` makes that
 * structural on the ranking side — there is no column that could hold one.
 * Discovery is the domain that COUNTS exactly those things: units sold and page
 * views, per listing and per store, for "what should we show on a shelf". That
 * is a legitimate and different question from "which seller wins this product",
 * and what must never happen is the first quietly becoming an input to the
 * second. A comment cannot enforce that; this gate is the enforcement.
 *
 * Five properties:
 *
 * 1. **No file under `services/offer*`, `services/ranking*`, `db/offer*` or
 *    `db/ranking*` imports `db/discovery/` or `services/discovery/`.** Both
 *    roots use the SAME prefix glob for the same name — `offer` reaches
 *    `services/offers`, `services/offer-freshness`, `db/offers` AND
 *    `db/offerFreshness` alike — so the wall's coverage cannot depend on which
 *    of two equivalent spellings a brief happened to use for a given root.
 *    `observation_freshness` is one of the eleven allowed
 *    `OFFER_RANKING_SIGNALS`, so offer freshness is squarely this domain and
 *    belongs behind the same wall as the rest of it. Merchant and brand
 *    popularity have nowhere to be read from if the ranking and offer domains
 *    cannot reach the module that computes them.
 * 2. **The reverse direction too.** No file under `services/discovery/` or
 *    `db/discovery/` imports `db/offers/`, `services/offer*` or
 *    `db/schema/ranking.js`. A shelf one join from a weighted ordering is a
 *    sponsored-placement surface nobody decided to build.
 * 3. **`discovery_signals` carries no `score`, `weight` or `rank` column** —
 *    walked from the REAL drizzle table, not read out of the file. One column
 *    per shelf, named by the shelf (`unitsSold`, `viewCount`).
 * 4. **`discovery_signals` carries no `rating` or `review_count` column** —
 *    `review_aggregates` is the single rating authority and `listings.rating`
 *    is already its projection; a third copy is a third place to disagree.
 * 5. **The vacuity floor:** `services/discovery` and `db/discovery` each
 *    contain at least one scanned file, so a rename that empties the scan fails
 *    instead of passing.
 *
 * Every scanner carries the house defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor so a moved file fails the gate instead of silently shrinking it,
 * comment stripping because these modules DOCUMENT what they refuse to do in
 * the detectors' own vocabulary (`discoveryReadRepository.ts` and
 * `feed.service.ts` both use the bare English word "ranking" in a comment —
 * see the mutation self-tests below, which are seeded from those exact
 * lines), and a mutation self-test so a rotted regex cannot pass by matching
 * nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import {
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
  type DirectoryReader,
} from '../../__tests__/domain-population.js';
import { assertEachOf } from '../../__tests__/assert-each-of.js';
import { discoverySignals } from '../../db/schema/discovery.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every directory directly under `parent` whose name STARTS WITH `prefix`.
 *
 * `services/offer*` and `services/ranking*` in the brief are GLOBS, not
 * hand-named directories, and the coverage they buy must not depend on
 * whichever spelling the brief happened to use for a given root. Applied to
 * BOTH `services/` and `db/`: `services/offers`, `services/offer-freshness`
 * and `services/ranking` qualify today on the services side, and
 * `db/offers`, `db/offerFreshness` and `db/ranking` qualify on the db side —
 * `db/offerFreshness/` was originally left out because the brief spelled the
 * db paths as two exact strings, and that was an inconsistency in how the
 * brief was typed rather than a decision that offer freshness (#68,
 * `observation_freshness` — one of the eleven allowed `OFFER_RANKING_SIGNALS`)
 * sits outside the offer domain. A fourth `db/offer-…` or `services/ranking-…`
 * directory added tomorrow falls under this wall with no edit here.
 */
function directoriesStartingWith(parent: string, prefix: string, readDir: DirectoryReader): string[] {
  return readDir(parent)
    .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => `${parent}/${entry.name}`);
}

/**
 * The offer- and ranking-owned directories this wall applies to.
 *
 * ONE prefix per name, applied to BOTH roots — `offer` on `services/` reaches
 * `services/offers` and `services/offer-freshness`, and the same `offer` on
 * `db/` reaches `db/offers` and `db/offerFreshness`. Two prefixes, not four
 * hand-picked strings, so the services and db sides cannot drift back apart.
 */
function offerRankingOwnedDirectories(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...directoriesStartingWith('services', 'offer', readDir),
    ...directoriesStartingWith('services', 'ranking', readDir),
    ...directoriesStartingWith('db', 'offer', readDir),
    ...directoriesStartingWith('db', 'ranking', readDir),
  ];
}

/** Every module of the offer and ranking domains, with its source. */
function offerRankingSources(): { relative: string; source: string }[] {
  return offerRankingOwnedDirectories()
    .flatMap((directory) => walkOwnedDirectory(directory))
    .map((relative) => ({ relative, source: readFileSync(join(SRC_ROOT, relative), 'utf8') }));
}

const DISCOVERY_OWNED_DIRECTORIES = ['services/discovery', 'db/discovery'] as const;

/** Every module of the discovery domain, with its source. */
function discoverySources(): { relative: string; source: string }[] {
  return DISCOVERY_OWNED_DIRECTORIES.flatMap((directory) => walkOwnedDirectory(directory)).map(
    (relative) => ({ relative, source: readFileSync(join(SRC_ROOT, relative), 'utf8') }),
  );
}

/** What a module of the discovery domain is called, wherever it lives. */
const DISCOVERY_NAMED = /discovery/i;

const DISCOVERY_SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/**
 * Discovery-named modules OUTSIDE `services/discovery/` and `db/discovery/`
 * that belong to ANOTHER domain, made explicit rather than by silence.
 *
 * `discovery` is as overloaded a token in this tree as `offer` is in
 * `offer-isolation.test.ts`: eBay's advertiser cohort (#65), Awin's advertiser
 * and feed pass (#66), and P2P's proximity search (#93) each use the word for
 * something this issue never touches. Measured on this branch: a whole-tree
 * sweep for `/discovery/i` selects 15 modules (via `sweepSrcTreeForDomain`,
 * `../../__tests__/domain-population.js`), and five of them are these.
 */
const SIBLING_DOMAIN_MODULES = [
  {
    path: 'controllers/seller-local-discovery.controller.ts',
    why: "#93's P2P proximity settings for a seller's own listing; it reaches services/pickup/local-discovery.service.js and never this domain's feed or repositories.",
  },
  {
    path: 'services/pickup/local-discovery.service.ts',
    why: "#93's P2P proximity search over rounded location cells; it reaches db/pickup/localDiscoveryRepository.js and never this domain's feed or repositories.",
  },
  {
    path: 'db/pickup/localDiscoveryRepository.ts',
    why: "#93's P2P seller-area cell-index table for pickup proximity; it never reaches this domain's feed or signal repositories.",
  },
  {
    path: 'services/awin/discovery.service.ts',
    why: "#66's Awin affiliate connector advertiser/feed discovery pass; it never reaches this domain's feed or repositories.",
  },
  {
    path: 'db/ebay/ebayDiscoveryRepository.ts',
    why: "#65's eBay connector advertiser/query cohort table for its Browse API sweep; it never reaches this domain's feed or signal repositories.",
  },
] as const;

/**
 * Every module of the discovery domain — services, repositories, and its HTTP
 * surface under the shared directories — WALKED and FILTERED, never listed.
 */
function discoveryPopulation(readDir: DirectoryReader = readSrcDirectory): string[] {
  const siblingPaths = new Set<string>(SIBLING_DOMAIN_MODULES.map((entry) => entry.path));
  return [
    ...DISCOVERY_OWNED_DIRECTORIES.flatMap((directory) => walkOwnedDirectory(directory, readDir)),
    ...namedInSharedDirectories(DISCOVERY_SHARED_DIRECTORIES, DISCOVERY_NAMED, readDir).filter(
      (path) => !siblingPaths.has(path),
    ),
  ];
}

/** Comment-stripped source: these modules DOCUMENT what they refuse to do. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Reaching the discovery domain, from any direction.
 *
 * Anchored on the `/discovery/` PATH SEGMENT (with slashes on both sides)
 * rather than the bare word, so it fires on `'../../db/discovery/x.js'` and
 * `'../discovery/feed.service.js'` alike but not on a docblock that merely
 * discusses "a discovery surface" — measured against
 * `comparison.service.ts:2`, which does exactly that. The symbol list is the
 * backstop for a relative import whose path segment a future refactor could
 * still avoid while keeping the identifier.
 */
const DISCOVERY_REFERENCE =
  /from\s+'[^']*\/discovery\/[^']*'|\b(?:discoverySignals|discoverySweepCursors|replaceWindow|getDiscoveryFeed|runDiscoverySweepOnce|startDiscoverySweep|stopDiscoverySweep|claimDiscoverySweepRun|completeDiscoverySweepRun|findListingsBySignal|findStoresBySignal|findStoresWithLiveDiscounts)\b/;

/**
 * Reaching the offer or ranking domain, from any direction, including
 * `db/schema/ranking.js` by name (the brief's third forbidden target).
 *
 * Same anchoring discipline: `/ranking/` and `/offers/` are path segments, not
 * the bare English words — measured against `discoveryReadRepository.ts:21`
 * ("require their own ranking column") and `feed.service.ts:199` ("reapply the
 * ranking"), both real comments in this domain that use "ranking" in prose.
 */
const OFFER_RANKING_REFERENCE =
  /from\s+'[^']*(?:\/offers\/|\/offer-freshness\/|\/ranking\/|schema\/ranking)[^']*'|\b(?:rankOffers|rankOfferComparison|evaluateOfferEligibility|selectEligibleOffers|resolveRankingPolicy|rankingPolicyVersions|offerRepository|nativeListingLinkRepository|offerOutboxRepository)\b/;

describe('the two populations are not vacuous', () => {
  it('the offer and ranking domains have real modules and they are not empty', () => {
    // The floor catches a renamed directory, which would otherwise make WALL 1
    // pass against an empty list.
    const domain = offerRankingSources();
    expect(domain.length, 'the offer/ranking walk found too few files').toBeGreaterThanOrEqual(25);
    const from = (prefix: string) => domain.filter((f) => f.relative.startsWith(prefix)).length;
    expect(from('services/offers/'), 'the offers service walk found nothing').toBeGreaterThanOrEqual(3);
    expect(
      from('services/offer-freshness/'),
      'the offer-freshness service walk found nothing',
    ).toBeGreaterThanOrEqual(5);
    expect(from('services/ranking/'), 'the ranking service walk found nothing').toBeGreaterThanOrEqual(
      6,
    );
    expect(from('db/offers/'), 'the offers repository walk found nothing').toBeGreaterThanOrEqual(2);
    expect(
      from('db/offerFreshness/'),
      'the offer-freshness repository walk found nothing',
    ).toBeGreaterThanOrEqual(4);
    expect(from('db/ranking/'), 'the ranking repository walk found nothing').toBeGreaterThanOrEqual(1);
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(50);
      expect(statSync(join(SRC_ROOT, file.relative)).isFile(), `${file.relative} is not a file`).toBe(
        true,
      );
    }
  });

  it('WALL 5 — the vacuity floor: services/discovery and db/discovery each hold real modules', () => {
    const domain = discoverySources();
    const from = (prefix: string) => domain.filter((f) => f.relative.startsWith(prefix)).length;
    // A rename that empties either directory must fail here rather than make
    // WALL 2 pass against an empty list.
    expect(from('services/discovery/'), 'the discovery service walk found nothing').toBeGreaterThanOrEqual(
      1,
    );
    expect(from('db/discovery/'), 'the discovery repository walk found nothing').toBeGreaterThanOrEqual(
      1,
    );
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(50);
      expect(statSync(join(SRC_ROOT, file.relative)).isFile(), `${file.relative} is not a file`).toBe(
        true,
      );
    }
  });
});

describe('WALL 1: the offer and ranking domains cannot reach the discovery counts', () => {
  it('no file under services/offer*, services/ranking*, db/offer* or db/ranking* imports discovery', () => {
    let scanned = 0;
    for (const file of offerRankingSources()) {
      expect(
        DISCOVERY_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches the discovery domain; merchant_popularity and brand_popularity ` +
          'are in OFFER_FORBIDDEN_RANKING_SIGNALS, and this is the gate that keeps that true of ' +
          'modules nobody has written yet',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(25);
  });
});

describe('WALL 2: the discovery domain cannot reach offer or ranking', () => {
  it('no file under services/discovery/ or db/discovery/ imports offers, offer-freshness or ranking', () => {
    let scanned = 0;
    for (const file of discoverySources()) {
      expect(
        OFFER_RANKING_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches #74's ranking or #57's offer domain; a shelf one join from a ` +
          'weighted ordering is a sponsored-placement surface nobody decided to build',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(1);
  });
});

describe('WALL 3 and 4: discovery_signals has one column per shelf, and no rating', () => {
  it('carries no score, weight, rank, rating or review_count column', () => {
    // Walked from the REAL drizzle table, so a column added in a migration and
    // mirrored into the schema fails here rather than being described away.
    const columns = Object.keys(getTableColumns(discoverySignals));
    assertEachOf(['score', 'weight', 'rank', 'rating', 'reviewCount'], 5, (forbidden) => {
      expect(columns, `discovery_signals must not carry ${forbidden}`).not.toContain(forbidden);
    });
    // The positive control: the columns it DOES carry — one per shelf, named
    // by the shelf — are present, so a renamed or emptied table cannot pass
    // this by having no columns to check.
    expect(columns).toContain('unitsSold');
    expect(columns).toContain('orderCount');
    expect(columns).toContain('viewCount');
    expect(columns).toContain('categoryId');
    expect(columns.length).toBeGreaterThanOrEqual(10);
  });
});

/**
 * The mutation self-test.
 *
 * Every detector above is only worth having if it FIRES. A regex that has
 * rotted — a renamed module, a changed call shape — passes silently against
 * every file, which is the shape `~/Oxy/AGENTS.md` calls a check that cannot
 * distinguish success from failure. So each is run against a source that
 * genuinely contains what it forbids, AND against the prose this domain
 * legitimately contains.
 */
describe('the detectors themselves', () => {
  it('DISCOVERY_REFERENCE fires on a real import and not on prose naming the domain', () => {
    expect(
      DISCOVERY_REFERENCE.test("import { replaceWindow } from '../../db/discovery/discoverySignalRepository.js';"),
    ).toBe(true);
    expect(
      DISCOVERY_REFERENCE.test("import { getDiscoveryFeed } from '../discovery/feed.service.js';"),
    ).toBe(true);
    expect(DISCOVERY_REFERENCE.test('const rows = await findStoresBySignal(input);')).toBe(true);
    // The measured false positive it must NOT produce: `comparison.service.ts:2`'s
    // own docblock names the domain in prose, with no path segment around it —
    // quoted verbatim, not paraphrased, because this self-test's whole job is
    // to prove the stripper works against REAL text.
    expect(
      DISCOVERY_REFERENCE.test(
        'The offer comparison entry point (#74) — the ONE function a discovery surface',
      ),
    ).toBe(false);
    expect(DISCOVERY_REFERENCE.test("import { getDb } from '../postgres.js';")).toBe(false);
  });

  it('OFFER_RANKING_REFERENCE fires on a real import and not on prose using "ranking" as a word', () => {
    expect(OFFER_RANKING_REFERENCE.test("import { rankOffers } from '../ranking/ranking.js';")).toBe(
      true,
    );
    expect(
      OFFER_RANKING_REFERENCE.test("import { rankingPolicyVersions } from '../../db/schema/ranking.js';"),
    ).toBe(true);
    expect(
      OFFER_RANKING_REFERENCE.test("import { findOfferById } from '../../db/offers/offerRepository.js';"),
    ).toBe(true);
    expect(
      OFFER_RANKING_REFERENCE.test("import { freshness } from '../offer-freshness/freshness.js';"),
    ).toBe(true);
    // The measured false positives: two real comments in this domain use the
    // bare English word.
    expect(
      OFFER_RANKING_REFERENCE.test(
        '// require their own ranking column to be greater than zero: every counted',
      ),
    ).toBe(false);
    expect(OFFER_RANKING_REFERENCE.test('// carries no order of its own — reapply the ranking')).toBe(
      false,
    );
    expect(OFFER_RANKING_REFERENCE.test("import { getDb } from '../postgres.js';")).toBe(false);
  });

  it('the comment stripper removes a line comment and a block comment', () => {
    expect(withoutComments('// from "../discovery/feed.service.js"\nconst a = 1;')).not.toContain(
      "'../discovery/feed.service.js'",
    );
    expect(withoutComments('/* rankOffers( */\nconst a = 1;')).not.toContain('rankOffers(');
    // …and does NOT eat a URL inside a string, which would be a stripper that
    // silently blanks half the file it hands to a detector.
    expect(withoutComments("const u = 'https://example.test/x';")).toContain('example.test');
  });
});

/**
 * The discovery population's own defence — #460's discipline applied to the
 * side of this wall that is new enough to still be growing.
 *
 * The offer and ranking side is deliberately NOT swept the same way:
 * `offer-isolation.test.ts` already measured that `offer` alone is shared by
 * eight-plus domains and defers the whole-tree sweep for that reason, and
 * replicating that deferral here would duplicate a census that gate already
 * owns. `discovery` is scoped tightly enough on THIS side — two owned
 * directories plus its HTTP surface — that the sweep is worth doing directly.
 */
describe('#460: nothing named for the discovery domain sits outside the scanned population', () => {
  it('every discovery-named module in src/ is inside the population or a counted sibling', () => {
    assertNothingOutsideDomainPopulation({
      population: discoveryPopulation,
      pattern: DISCOVERY_NAMED,
      notThisDomain: SIBLING_DOMAIN_MODULES,
      expectedExclusions: 5,
      // Below today's 11 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 8,
      plantIn: 'lib',
      plantName: 'discovery-cache.ts',
    });
  });
});
