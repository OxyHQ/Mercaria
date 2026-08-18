/**
 * The walls around the eBay source (#65), asserted STRUCTURALLY.
 *
 * Five properties, each a scan or a type read rather than a fixture, because
 * "cannot" is a stronger statement than "did not in this case". Every detector
 * carries `~/Oxy/AGENTS.md`'s three defences: a vacuity floor (an empty or moved
 * file fails the gate instead of passing it by having nothing to match), an
 * ENUMERATION floor read off the real directory, and a mutation self-test, so a
 * rotted regex cannot pass by matching nothing.
 *
 *  1. **Mercaria never composes or mutates an EPN link.** #64 §6's eBay rule 3
 *     and the EPN Network Agreement: commission attribution lives entirely in
 *     the parameters eBay put in that URL, and a rebuilt link is
 *     indistinguishable from a working one until a month of revenue is missing.
 *  2. **The adapter reaches nothing.** #62's write boundary, restated for this
 *     directory — the shared `ingestion-isolation.test.ts` already scans it, and
 *     this adds the eBay-specific one: no reach into the commerce graph through
 *     a service either.
 *  3. **No access token is ever written down.** Nothing in the domain persists
 *     one, and there is no column that could hold it.
 *  4. **A minted marketplace seller grants nothing.** No relationship (#55), no
 *     native-store link (#84), no claim (#83), no native checkout.
 *  5. **Nothing here ranks anything** (#74's), performs #37's redirect, or
 *     reaches the retail domain (#116/#121).
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EBAY_FORBIDDEN_LINK_OPERATIONS,
  EBAY_OUTBOUND_DESTINATION_KINDS,
} from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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
 * The flat directories a module of this domain lives in under a domain NAME.
 *
 * `db/schema` was missing until #460's schema batch, and the omission is not
 * this gate's invention: the same four-name list — `routes`, `controllers`,
 * `middleware`, sometimes `routes/admin` — was copied from gate to gate, and
 * from `scripts/isolation-gate-census.ts`, whose own bag-directory list carried
 * exactly this gap until #600. **A walked population whose DIRECTORY list is
 * hand-written is still a hand list**, and it fails the way hand lists fail:
 * silently, with every floor and count green. `db/schema/ebay.ts` — the three
 * tables this domain owns — was behind none of the walls below.
 *
 * The sweep at the end of this file is what stops the next omission being
 * silent, and it is the general remedy rather than this one entry.
 */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/**
 * The three modules this domain shares with #62's framework.
 *
 * They are not eBay's — `seller-identity.ts` and `marketplaceSellerRepository`
 * are the per-record seller identity #65 opted into and #62 owns, and the
 * adapter lives in the framework's `adapters/` directory by the write-boundary
 * rule. They are scanned here because the eBay walls have to hold ACROSS them:
 * the deletion obligation, the attribution loss detector and the "no local
 * TTL" rule are all properties of what an eBay pass may conclude, and a pass
 * runs through all three. EXACT, so a fourth borrowed module is a decision.
 */
const BORROWED_FRAMEWORK_MODULES = [
  'services/ingestion/adapters/ebay.ts',
  'services/ingestion/seller-identity.ts',
  'db/ingestion/marketplaceSellerRepository.ts',
] as const;

/**
 * Every module of the eBay domain — services, repositories, route, operator
 * controller, request schemas. WALKED and FILTERED, never listed.
 *
 * This was eighteen hand-written paths under a comment claiming exactly that,
 * and the claim was false: the entire `/internal/ebay/*` operator surface —
 * `routes/internal-ebay.ts`, `controllers/ebay-operator.controller.ts` and
 * `middleware/ebay-schemas.ts` — was behind no wall at all (#460). The list's
 * stated reason for staying explicit was "so a MOVED file fails the gate",
 * which a walk plus the per-shape floors below gives without also failing to
 * cover a file nobody moved.
 *
 * `ebay` is unambiguous in the shared flat directories — no other domain has
 * taken the token — so this needs no exclusion list.
 */
const EBAY_DOMAIN_PATHS = [
  ...walk('services/ebay'),
  ...walk('db/ebay'),
  ...BORROWED_FRAMEWORK_MODULES,
  ...SHARED_DIRECTORIES.flatMap((directory) =>
    readdirSync(join(SRC_ROOT, directory), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .filter((entry) => /ebay/i.test(entry.name))
      .map((entry) => `${directory}/${entry.name}`),
  ),
];

/**
 * The enumeration floor, per SHAPE.
 *
 * Each number is the count on the day it was written: these directories only
 * grow, and a SHRINK is the event that should stop the build rather than
 * quietly narrowing every wall in this file. Split by shape because the four
 * sources break independently, and one total would let a walk collapse to zero
 * while the others carried the number.
 */
function expectEveryShapeFoundSomething(): void {
  const from = (prefix: string) =>
    EBAY_DOMAIN_PATHS.filter((path) => path.startsWith(prefix)).length;
  expect(from('services/ebay/'), 'the service walk found nothing').toBeGreaterThanOrEqual(11);
  expect(from('db/ebay/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(4);
  expect(BORROWED_FRAMEWORK_MODULES.length, 'the borrowed set changed').toBe(3);
  expect(from('routes/'), 'no eBay route was derived').toBeGreaterThanOrEqual(1);
  expect(from('controllers/'), 'no eBay controller was derived').toBeGreaterThanOrEqual(1);
  expect(from('middleware/'), 'no eBay request schema was derived').toBeGreaterThanOrEqual(1);
  expect(EBAY_DOMAIN_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
}

/**
 * COMPOSING a URL against an eBay host.
 *
 * The shape that matters is a template or a concatenation producing an
 * `ebay.` address, or a mutation of an existing one's parameters. Requesting an
 * API endpoint is not that — `browse.ts` legitimately builds
 * `https://api.ebay.com/buy/browse/...` — so the detectors are written against
 * the ITEM-page hosts and against parameter surgery, which is what the
 * prohibition is actually about.
 */
const LINK_COMPOSITION = [
  {
    name: 'a composed eBay item-page URL',
    /**
     * Keyed on the `/itm` PATH, independently of how the host is spelled.
     *
     * This read `/['"`]https?:\/\/(www\.)?ebay\.[a-z.]+\/itm/i`, which required a
     * LITERAL host immediately after the opening quote. So it saw
     * `` `https://www.ebay.es/itm/${id}` `` and missed
     * `` `https://${host}/itm/${id}` `` — and it missed the permitted
     * `` `https://${EBAY_API_HOST[env]}${PATH}` `` for the SAME structural
     * reason, which is why its negative control looked like a control and was
     * really a description of the blind spot.
     *
     * That is not theoretical here: composing a URL from an interpolated host is
     * already the house style in this exact directory (`token.ts:133`,
     * `browse.ts:167` and `:224`). None of those composes an item link, so
     * nothing evades the prohibition today — but an item-link version would look
     * entirely ordinary beside them and would have passed.
     *
     * `/itm` appears NOWHERE in this domain outside a test, so keying on the
     * path costs no legitimate spelling: the Browse API paths are
     * `/buy/browse/v1/…`. The composed API URL therefore stays legal, which it
     * must — the fix could not be to delete the negative control.
     */
    pattern: /['"`][^'"`]*\/itm(?:\/|\$\{)/i,
  },
  {
    name: 'an EPN campaign parameter written by Mercaria',
    pattern: /(campid|mkcid|mkrid|toolid|customid|mkevt)\s*[=:]/i,
  },
  {
    name: 'surgery on a destination URLs parameters',
    pattern: /searchParams\.(set|append|delete)\s*\(\s*['"`](campid|mkcid|customid|mkevt)/i,
  },
] as const;

/** #55's relationship layer, #83's claiming and #84's native-store linkage. */
const GRANT_REFERENCE =
  /relationship\.service|relationshipRepository|commerce_relationships|nativeStoreLink|native_store_links|merchant-claims|merchantClaims/;

/** #74's ranking. */
const RANKING_REFERENCE = /rankOffers|offerRanking|services\/ranking\/|\.\.\/ranking\//;

/** #37's outbound redirect. This domain models routing metadata and never routes. */
const REDIRECT_REFERENCE = /outboundRedirect|redirect\.service|buildAffiliateUrl|services\/outbound\//;

/** #116/#121's retail domain. An ingested offer must not make Mercaria the seller. */
const RETAIL_REFERENCE = /retail-eligibility|retail-pricing|retailEligibility|retailPricing|mercaria_retail/;

/** Persisting a bearer token. There is no column that could hold one and no code that tries. */
const TOKEN_PERSISTENCE =
  /insert\([a-zA-Z]*[Tt]oken|accessToken:\s*(sql|text\(\))|\.set\(\{[^}]*accessToken/;

function readDomainFile(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  // The vacuity floor: an empty or moved file must FAIL here rather than pass
  // the scan by having nothing to match.
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * Strip comments before a reachability test.
 *
 * These modules DOCUMENT what they refuse to do in the same vocabulary the
 * detectors use — "never hand-construct an EPN link", "#74 owns ranking" — so a
 * scan over raw source would fail on the prose that exists to explain the
 * boundary.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

describe('Mercaria never composes or mutates an EPN link (#64 §6 rule 3)', () => {
  it('reaches for no eBay item-page URL and no campaign parameter', () => {
    for (const relative of EBAY_DOMAIN_PATHS) {
      const source = withoutComments(readDomainFile(relative));
      for (const { name, pattern } of LINK_COMPOSITION) {
        expect(pattern.test(source), `${relative} contains ${name}`).toBe(false);
      }
    }
    // The enumeration floor: a domain that shrank to nothing would pass.
    expectEveryShapeFoundSomething();
  });

  it('the link detectors actually detect — the mutation self-test', () => {
    const positives = [
      "const url = `https://www.ebay.es/itm/${itemId}`;",
      "const tracked = `${base}?campid=${campaignId}`;",
      "parsed.searchParams.set('campid', campaignId);",
    ];
    positives.forEach((line, index) => {
      const detector = LINK_COMPOSITION[index];
      expect(detector, `no detector at index ${index}`).toBeDefined();
      expect(detector?.pattern.test(line), `detector ${index} missed its own positive`).toBe(true);
    });
    // The item-link detector, fed the spellings a module in THIS directory would
    // actually reach for. Composing a URL from an interpolated host is already
    // the house style here (`token.ts:133`, `browse.ts:167`, `browse.ts:224`),
    // so an item-link version would look entirely ordinary beside them — and the
    // literal-host pattern this replaced missed every one of these.
    const itemLink = LINK_COMPOSITION[0];
    expect(itemLink, 'the item-link detector moved out of index 0').toBeDefined();
    const composed = [
      'const url = `https://${host}/itm/${itemId}`;',
      'const url = `https://${EBAY_ITEM_HOST[env]}/itm/${itemId}`;',
      'const url = `${itemBase}/itm/${itemId}`;',
      "const url = 'https://www.ebay.co.uk/itm/' + itemId;",
    ];
    for (const line of composed) {
      expect(itemLink?.pattern.test(line), `the item-link detector misses: ${line}`).toBe(true);
    }

    // And an ordinary line in this domain trips none of them.
    //
    // This control is NOT redundant with the widening and could not be deleted
    // to make room for it: a composed API URL must stay legal, because that is
    // how every real call in this domain is built. It used to pass for the same
    // structural reason the composed item link evaded the detector — both lack a
    // literal host after the quote — so the control and the blind spot shared
    // one cause. Keying on the `/itm` PATH separates them: this line has no
    // `/itm` segment, and `/itm` appears nowhere in the domain outside a test.
    const ordinary = "const url = `https://${EBAY_API_HOST[env]}${EBAY_BROWSE_SEARCH_PATH}?${params}`;";
    for (const { name, pattern } of LINK_COMPOSITION) {
      expect(pattern.test(ordinary), `${name} detector fires on an ordinary API URL`).toBe(false);
    }
    // The three real composed-host lines in the shipped domain, read from disk
    // rather than retyped, so this control cannot drift away from the code it
    // claims to protect.
    for (const relative of ['services/ebay/token.ts', 'services/ebay/browse.ts']) {
      const source = withoutComments(readDomainFile(relative));
      expect(
        itemLink?.pattern.test(source),
        `${relative} trips the item-link detector; a composed API URL must stay legal`,
      ).toBe(false);
    }
  });

  it('keeps the destination kinds and the forbidden operations DISJOINT', () => {
    const destinations = new Set<string>(EBAY_OUTBOUND_DESTINATION_KINDS);
    const overlap = EBAY_FORBIDDEN_LINK_OPERATIONS.filter((entry) => destinations.has(entry));
    expect(overlap).toEqual([]);
    expect(EBAY_OUTBOUND_DESTINATION_KINDS.length).toBeGreaterThanOrEqual(2);
    expect(EBAY_FORBIDDEN_LINK_OPERATIONS.length).toBeGreaterThanOrEqual(6);
  });
});

describe('no access token is ever written down', () => {
  it('persists no token in any module of the domain', () => {
    for (const relative of EBAY_DOMAIN_PATHS) {
      const source = withoutComments(readDomainFile(relative));
      expect(TOKEN_PERSISTENCE.test(source), `${relative} persists an access token`).toBe(false);
    }
  });

  it('the token-persistence detector actually detects', () => {
    expect(TOKEN_PERSISTENCE.test('await db.insert(ebayTokens).values({ value })')).toBe(true);
    expect(TOKEN_PERSISTENCE.test('accessToken: text()')).toBe(true);
    // The real token cache, which is a `Map`, trips nothing.
    expect(TOKEN_PERSISTENCE.test('cache.set(key, entry);')).toBe(false);
  });
});

describe('an eBay ingestion grants nothing and ranks nothing', () => {
  it('reaches no relationship, claim, native-store link, ranking, redirect or retail module', () => {
    for (const relative of EBAY_DOMAIN_PATHS) {
      const source = withoutComments(readDomainFile(relative));
      expect(GRANT_REFERENCE.test(source), `${relative} reaches a grant`).toBe(false);
      expect(RANKING_REFERENCE.test(source), `${relative} reaches ranking`).toBe(false);
      expect(REDIRECT_REFERENCE.test(source), `${relative} reaches the redirect`).toBe(false);
      expect(RETAIL_REFERENCE.test(source), `${relative} reaches the retail domain`).toBe(false);
    }
  });

  it('the grant, ranking, redirect and retail detectors actually detect', () => {
    expect(
      GRANT_REFERENCE.test("import { assertRelationship } from '../commerce-graph/relationship.service.js';"),
    ).toBe(true);
    expect(RANKING_REFERENCE.test("import { rankOffers } from '../ranking/rank.js';")).toBe(true);
    expect(REDIRECT_REFERENCE.test("import { buildAffiliateUrl } from '../outbound/x.js';")).toBe(
      true,
    );
    expect(RETAIL_REFERENCE.test("import { getRetailEligibility } from '../retail-eligibility/x.js';")).toBe(
      true,
    );
    const ordinary = "const offer = await recordExternalOffer(observation, now);";
    expect(GRANT_REFERENCE.test(ordinary)).toBe(false);
    expect(RANKING_REFERENCE.test(ordinary)).toBe(false);
  });
});

describe('the adapter directory holds only adapters that reach nothing', () => {
  const adaptersDir = join(SRC_ROOT, 'services/ingestion/adapters');

  it('has an eBay adapter and it reaches no repository, database or commerce service', () => {
    const files = readdirSync(adaptersDir)
      .filter((entry) => entry.endsWith('.ts'))
      .filter((entry) => statSync(join(adaptersDir, entry)).isFile());
    // The enumeration floor, read off the real directory.
    expect(files).toContain('ebay.ts');
    expect(files.length).toBeGreaterThanOrEqual(2);

    const source = readFileSync(join(adaptersDir, 'ebay.ts'), 'utf8');
    expect(source.length).toBeGreaterThan(200);
    const stripped = withoutComments(source);
    // #62's own five, restated so a change to this adapter is caught by ITS
    // suite rather than only by the framework's.
    expect(/db\/[a-zA-Z-]+\/[a-zA-Z]+Repository/.test(stripped)).toBe(false);
    expect(/db\/postgres|getDb\(|drizzle-orm/.test(stripped)).toBe(false);
    expect(/offers\/offer\.service|offerRepository|recordExternalOffer/.test(stripped)).toBe(false);
    expect(/matching\/match\.service|runMatch/.test(stripped)).toBe(false);
    // And the eBay-specific one: an adapter must not reach its own composition
    // root, which is where the ports are bound to real repositories.
    expect(/ebay\/register\.js/.test(stripped)).toBe(false);
  });
});

/**
 * The SIXTH wall: freshness and retirement have ONE authority each, and it is
 * not this domain.
 *
 * #68 owns how long an offer is worth showing (a per-source policy, its
 * derivation, its outage grace) and #62 owns what may retire one
 * (`CATALOG_SOURCE_RETIRING_OUTCOMES` plus the adapter's `complete` flag, or an
 * explicit `AdapterRemoval`). #65 consumes both and defines neither.
 *
 * The gate exists because the tempting bug is a LOCAL one: this domain knows
 * eBay prices move hourly, so a private `EBAY_OFFER_TTL_SECONDS` or a
 * `isStale(offer)` helper reads as diligence rather than as a second authority.
 * A second TTL does not announce itself — it silently wins wherever it is
 * consulted, and the source's own reviewed policy stops meaning anything.
 *
 * The ONE lifetime this domain legitimately owns is the OAuth access token's,
 * in `token.ts`. That is a CREDENTIAL's expiry, not content freshness, and the
 * allowance is narrowed to that file rather than to a pattern anyone could
 * reuse elsewhere.
 */
describe('freshness and retirement stay #68s and #62s (#65 consumes, never redefines)', () => {
  /** A content lifetime of this domain's own. */
  const LOCAL_TTL =
    /(TTL|LIFETIME|MAX_AGE|FRESH_FOR|STALE_AFTER)_?[A-Z_]*\s*=|(ttlSeconds|staleAfterSeconds|freshnessSeconds|maxAgeSeconds)\s*[=:]/;

  /** A staleness verdict derived here rather than read from #68. */
  const LOCAL_STALENESS =
    /function\s+(is|derive|assess|compute)[A-Za-z]*(Stale|Fresh|Freshness)|\b(isStale|isFresh|assessFreshness|deriveFreshness)\s*\(/;

  /** An outage-grace rule of this domain's own. */
  const LOCAL_GRACE = /(grace|GRACE)_?[A-Za-z_]*\s*[=:]\s*[0-9]/;

  /**
   * A retirement DECISION taken here.
   *
   * Emitting an `AdapterRemoval` is not one — the adapter reports what eBay
   * said and #68's `applyExplicitRemovals` decides — so the detector is written
   * against retiring, expiring or the retirement vocabulary of the tables, not
   * against the word appearing at all.
   */
  const LOCAL_RETIREMENT =
    /retireSourceObject|retireLapsedExternalOffers|declareOffersUnavailable|retirementKind\s*[=:]|retirementReason\s*[=:]|\.set\(\{[^}]*status:\s*['"`]retired/;

  it('defines no TTL, staleness rule, grace window or retirement decision', () => {
    let scanned = 0;
    for (const relative of EBAY_DOMAIN_PATHS) {
      const stripped = withoutComments(readDomainFile(relative));
      scanned += 1;
      expect(LOCAL_STALENESS.test(stripped), `${relative} derives its own staleness`).toBe(false);
      expect(LOCAL_GRACE.test(stripped), `${relative} defines its own outage grace`).toBe(false);
      expect(LOCAL_RETIREMENT.test(stripped), `${relative} decides a retirement`).toBe(false);
      // `token.ts` owns the ACCESS TOKEN's lifetime, which is a credential's and
      // not an offer's. Narrowed to that one file on purpose.
      if (relative !== 'services/ebay/token.ts') {
        expect(LOCAL_TTL.test(stripped), `${relative} defines its own content TTL`).toBe(false);
      }
    }
    // The vacuity floor: a broken enumeration must not pass by scanning nothing.
    expect(scanned).toBe(EBAY_DOMAIN_PATHS.length);
    expectEveryShapeFoundSomething();
  });

  it('the TTL, staleness, grace and retirement detectors actually detect', () => {
    expect(LOCAL_TTL.test('const EBAY_OFFER_TTL_SECONDS = 3_600;')).toBe(true);
    expect(LOCAL_TTL.test('const config = { ttlSeconds: 3600 };')).toBe(true);
    expect(LOCAL_STALENESS.test('function isStaleOffer(offer) { return true; }')).toBe(true);
    expect(LOCAL_STALENESS.test('if (isStale(offer)) return null;')).toBe(true);
    expect(LOCAL_GRACE.test('const OUTAGE_GRACE_MS = 900_000;')).toBe(true);
    expect(LOCAL_RETIREMENT.test('await retireSourceObject(db, { id, kind, now });')).toBe(true);
    expect(LOCAL_RETIREMENT.test(".set({ status: 'retired' })")).toBe(true);
    // And it does NOT fire on what this domain legitimately does: report what
    // eBay said, and let #68 decide.
    expect(LOCAL_RETIREMENT.test('const removals = result.removedIds.map(...)')).toBe(false);
    expect(LOCAL_TTL.test('const lifetimeMs = expiresIn * 1_000;')).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* #454: the detector must match the IDIOM, not one spelling of it            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * These detectors named each forbidden domain by its `services/<domain>/` path
 * only, which is not the specifier a module inside this domain writes: a
 * sibling directory is one `../` away, so the real import is `'../<domain>/…'`
 * and it passed the wall untouched. MEASURED on `origin/main` by executing each
 * pattern against that spelling.
 *
 * One relative alternative per domain covers EVERY depth, because however many
 * `../` segments precede it the last always abuts the directory name.
 *
 * The probes below are written from the IDIOM rather than from the regex — a
 * self-test derived from the pattern can only confirm the pattern matches
 * itself. The imported SYMBOL is deliberately neutral in each: the sibling
 * probe in `freshness-isolation.test.ts` imported `rankOffers`, which its
 * pattern matches by function NAME, so it passed without ever exercising the
 * path alternative it appeared to cover.
 */
describe('#454: a relative import cannot walk around these detectors', () => {
  it('RANKING_REFERENCE sees a sibling-relative import', () => {
    expect(
      RANKING_REFERENCE.test("import { helper } from '../ranking/thing.service.js';"),
      "a module here reaches ranking as '../ranking/…' and that must not pass",
    ).toBe(true);
    expect(RANKING_REFERENCE.test("import { helper } from '../../services/ranking/thing.service.js';")).toBe(true);
    // The negative half, or the widening would fire on ordinary imports.
    expect(RANKING_REFERENCE.test("import { helper } from '../ranking-display/format.js';")).toBe(false);
    expect(RANKING_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });

});

/**
 * The population's own defence, and the general form of the `db/schema` fix.
 *
 * Adding one directory closes today's gap; this closes the class. The DIRECTORY
 * list above is the last hand list in this gate, and hand lists fail silently —
 * `db/schema` was missing from it, inherited from a census list carrying the
 * same gap (#593/#600), and the wall ran over a population that excluded the
 * three tables this domain owns with every floor and count green.
 *
 * So: sweep the whole tree for paths NAMING this domain and require each to be
 * in the derived population or in a counted exclusion. A new bag directory
 * brings its modules under the wall with no edit here.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  const sweepTree = (
    readDir: (relative: string) => { name: string; isDirectory(): boolean; isFile(): boolean }[],
  ): string[] => {
    const found: string[] = [];
    const walkAll = (relative: string): void => {
      for (const entry of readDir(relative)) {
        if (entry.name === '__tests__') continue;
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) walkAll(child);
        else if (entry.name.endsWith('.ts') && /ebay/i.test(child)) found.push(child);
      }
    };
    walkAll('');
    return found;
  };
  const realReader = (relative: string) =>
    readdirSync(join(SRC_ROOT, relative), { withFileTypes: true });

  /**
   * The one ebay-NAMED module that is not an eBay-domain module, EXACT.
   *
   * `services/outbound/reconciliation/ebay.ts` belongs to #37's outbound
   * redirect domain — it is that domain's eBay-specific reconciliation, not
   * this domain's. It cannot join the population: `REDIRECT_REFERENCE` above
   * forbids every module here from reaching `services/outbound/`, so admitting
   * it would make this gate fire on itself. A sweep that closed its own row by
   * widening the population would have built a false wall, which is the failure
   * this exclusion exists to avoid rather than an inconvenience.
   *
   * EXACT rather than a prefix, and asserted in both directions below: a
   * directory-shaped exclusion excuses everything in it forever.
   */
  const NOT_THIS_DOMAIN = ['services/outbound/reconciliation/ebay.ts'] as const;

  // ONE comparison, shared by the wall and its control below: two spellings
  // would let the control pass while the wall went vacuous.
  const outsidePopulation = (paths: readonly string[]): string[] => {
    const population = new Set([...EBAY_DOMAIN_PATHS, ...NOT_THIS_DOMAIN]);
    return paths.filter((relative) => !population.has(relative));
  };

  it('every ebay-named module in src/ is inside the population', () => {
    const swept = sweepTree(realReader);
    // A vacuity floor: a traversal that reached nothing reports no module
    // outside the population, which is what a correct tree also reports.
    expect(
      swept.length,
      'the whole-tree sweep found almost nothing — it cannot report a module outside the ' +
        'population if it never reached one',
    ).toBeGreaterThanOrEqual(8);
    expect(
      outsidePopulation(swept),
      'an ebay-named module sits outside the scanned population, so none of the walls above ' +
        'covers it — add its directory to SHARED_DIRECTORIES, or excuse it in NOT_THIS_DOMAIN ' +
        'with a reason and move its count',
    ).toEqual([]);
    // The exclusion's own count, in BOTH directions (#448). One entry, and it
    // must still be a module the sweep actually reaches — an exemption pointing
    // at a path the sweep never produces excuses nothing while looking like a
    // decision.
    expect(NOT_THIS_DOMAIN.length, 'the exclusion set changed').toBe(1);
    for (const excused of NOT_THIS_DOMAIN) {
      expect(swept, `${excused} is excused but the sweep never reaches it`).toContain(excused);
      expect(
        EBAY_DOMAIN_PATHS,
        `${excused} is excused AND in the population — the exclusion is doing nothing`,
      ).not.toContain(excused);
    }
  });

  it('the empty result is a measurement, not a probe that cannot fail', () => {
    // Without this, `toEqual([])` is satisfied by a correct tree, by a sweep
    // that reached nothing, AND by a population containing everything. The
    // floor covers the second; only a planted module covers the third.
    const planted = 'lib/ebay-cache.ts';
    const seeded = sweepTree((relative) =>
      relative === 'lib'
        ? [
            ...realReader(relative),
            { name: 'ebay-cache.ts', isDirectory: () => false, isFile: () => true },
          ]
        : realReader(relative),
    );
    expect(seeded, 'the sweep did not reach the planted module').toContain(planted);
    expect(
      outsidePopulation(seeded),
      'a module the population does not cover was NOT reported outside it',
    ).toEqual([planted]);
    // …and the plant is not on disk, or this asserts about the tree.
    expect(sweepTree(realReader)).not.toContain(planted);
  });
});
