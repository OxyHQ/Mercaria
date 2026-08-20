/**
 * The walls around the feed importer (#63 security 4 and 6), asserted
 * STRUCTURALLY.
 *
 * Five separate properties, each a scan or a type read rather than a fixture,
 * because "cannot" is a stronger statement than "did not in this case":
 *
 * 1. **Nothing in this domain evaluates anything.** No `eval`, no
 *    `new Function`, no `vm`, no template engine, no source-supplied pattern —
 *    which is issue security 4, and the reason `feed_field_mappings` has no
 *    column that could hold one.
 * 2. **The transform vocabulary and the prohibition are DISJOINT**, so a
 *    plausible future addition that happens to be an evaluator fails the build.
 *    The `RetailCostComponentKind` device (#120), applied to a mapping.
 * 3. **The importer writes into the commerce graph nowhere.** No module here
 *    imports a canonical write service, the offer domain, the matcher's write
 *    path, the payment domain or the retail domain.
 * 4. **A merchant's feed cannot reach another store**, which is one function
 *    and is named.
 * 5. **The credential columns are PROTECTED and no projection names them.**
 *
 * The scanner follows the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor, an ENUMERATION floor read off the real directory, and a mutation
 * self-test on every detector, so a rotted regex cannot pass by matching
 * nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';
import { getTableColumns } from 'drizzle-orm';
import {
  FEED_FIELD_TRANSFORMS,
  FEED_FORBIDDEN_TRANSFORM_KINDS,
  FEED_COMPRESSIONS,
  FEED_FORBIDDEN_CONTAINERS,
  FEED_TOKEN_BEARING_ISSUE_CODES,
  FEED_RECORD_ISSUE_CODES,
} from '@mercaria/shared-types';
import { PROTECTED_COLUMNS } from '../../../db/protectedColumns.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * What a module of this domain is called, wherever it lives.
 *
 * The hyphen is OPTIONAL, and that widening is the point rather than tidiness.
 * The pattern read `/feed-import/i`, which cannot match `db/schema/feedImport.ts`
 * — the seven tables this domain owns, in the one directory whose files are
 * named in camelCase. So the entry that closes the `db/schema` gap below is
 * unreachable to the old spelling, and adding the directory alone would have
 * changed NOTHING while looking exactly like a fix.
 *
 * Widening a pattern is the PERMISSIVE direction and owes its own measurement,
 * so here it is: `/feed-?import/i` over the whole of `src/` selects 32 modules,
 * all of them this domain's — the 27 under `services/feed-import/`, the two
 * repositories, the schema module and the two HTTP modules. It admits nothing
 * that is not already here. `feedback`, `feed.ts` and `routes/admin/feeds.ts`
 * do not match it, which is why the last of those is still listed in
 * `UNDERIVABLE_MODULES` rather than derived.
 */
const FEED_IMPORT_NAME_PATTERN = /feed-?import/i;

/**
 * The flat directories a module of this domain lives in under a domain NAME.
 *
 * `db/schema` was missing, inherited from the three-name list copied from gate
 * to gate and from `scripts/isolation-gate-census.ts`'s own bag-directory list.
 * The sweep at the end of this file is what stops the next omission being
 * silent, and it is the general remedy rather than this one entry.
 */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/**
 * The modules no filename rule reaches, each with the reason it is here.
 *
 * `product-feed.ts` is #62's adapter directory rather than this domain's, and
 * lives there by the write-boundary rule — but every wall in this file has to
 * hold across it, since it is the module that turns a merchant's rows into
 * source records. `routes/admin/feeds.ts` is the merchant surface, named after
 * the resource under `/admin/stores/:storeId/feeds` rather than after the
 * domain, so `feed-import` does not match it and a bare `feed` rule would sweep
 * in `routes/feed.ts` and `routes/feedback.ts`, which are two other domains.
 *
 * EXACT, not a floor: an excusing list without a count is a predicate, and this
 * one is the residual a walk cannot derive — precisely the place a third
 * differently-named module would quietly join and never be scanned (#448).
 */
const UNDERIVABLE_MODULES = [
  'services/ingestion/adapters/product-feed.ts',
  'routes/admin/feeds.ts',
] as const;

/**
 * Every module of the feed-import domain, plus the adapter and the surface.
 * WALKED and FILTERED, never listed.
 *
 * This was thirty-three hand-written paths under exactly that claim, and it
 * happened to be true on the day it was measured — which is the whole problem
 * (#460): a list is complete when it is written and silently incomplete the day
 * somebody adds a file, and what the gate then skips is precisely the module
 * nobody has reviewed. The walk is recursive, so `parse/` needs no second
 * entry and a third parser directory needs no edit here at all.
 */
function domainPaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...walkOwnedDirectory('services/feed-import', readDir),
    ...walkOwnedDirectory('db/feedImport', readDir),
    ...UNDERIVABLE_MODULES,
    ...namedInSharedDirectories(SHARED_DIRECTORIES, FEED_IMPORT_NAME_PATTERN, readDir),
  ];
}

const DOMAIN_PATHS = domainPaths();

/**
 * The enumeration floor, per SHAPE.
 *
 * Each number is the count on the day it was written: these directories only
 * grow, and a SHRINK is the event that should stop the build rather than
 * quietly narrowing every wall in this file. `parse/` gets its own, because it
 * is the one a non-recursive walk would silently drop while every other number
 * stayed right.
 */
function expectEveryShapeFoundSomething(): void {
  const from = (prefix: string) => DOMAIN_PATHS.filter((path) => path.startsWith(prefix)).length;
  expect(
    from('services/feed-import/parse/'),
    'the parser walk found nothing — is the walk still recursive?',
  ).toBeGreaterThanOrEqual(7);
  expect(from('services/feed-import/'), 'the service walk found nothing').toBeGreaterThanOrEqual(26);
  expect(from('db/feedImport/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(2);
  expect(UNDERIVABLE_MODULES.length, 'the underivable set changed').toBe(2);
  expect(from('routes/internal-feed-imports'), 'no feed route was derived').toBe(1);
  expect(from('controllers/'), 'no feed-import controller was derived').toBeGreaterThanOrEqual(1);
  expect(from('middleware/'), 'no feed-import request schema was derived').toBeGreaterThanOrEqual(
    1,
  );
  expect(from('db/schema/'), 'no feed-import schema module was derived').toBeGreaterThanOrEqual(1);
  expect(DOMAIN_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
}

/** Anything that would EXECUTE a value. Issue security 4. */
const EVALUATION_REFERENCE =
  /\beval\s*\(|new\s+Function\s*\(|node:vm|require\(['"]vm['"]\)|\bvm\.runIn|Function\s*\(\s*['"`]|handlebars|mustache|liquidjs|ejs\.render|jsonata|jmespath/;

/** The canonical WRITE services — minting, renaming or re-pointing an entity. */
const CANONICAL_WRITE_REFERENCE =
  /canonical-product\.service|canonical-variant\.service|product-family\.service|brand\.service|organization\.service|product-identifier\.service/;

/** The offer domain. #57 owns an offer; this importer produces observations. */
const OFFER_WRITE_REFERENCE = /offers\/offer\.service|offerRepository|recordExternalOffer/;

/** #58's matcher write path. A dry run reads identifiers and decides nothing. */
const MATCHER_WRITE_REFERENCE = /matching\/match\.service|runMatch\(/;

/** The payment and retail domains. A feed cannot make Mercaria the seller. */
const COMMERCE_MONEY_REFERENCE =
  /services\/payments\/|\.\.\/payments\/|services\/retail-pricing\/|\.\.\/retail-pricing\/|services\/retail-eligibility\/|\.\.\/retail-eligibility\/|mercaria_retail/;

/** #74's ranking. A feed's contents are not a ranking input. */
const RANKING_REFERENCE = /rankOffers|offerRanking|services\/ranking\/|\.\.\/ranking\//;

function readDomainFile(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  // The vacuity floor: an empty or moved file must fail here, not pass the scan
  // by having nothing to match.
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * Strip comments before a reachability test.
 *
 * These modules DOCUMENT what they refuse to do in the same vocabulary the
 * detectors use — "there is no `eval` here", "#57 owns the offer" — so a scan
 * over raw source would fail on the prose that exists to explain the boundary.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

describe('the importer executes nothing a feed or a mapping supplies (security 4)', () => {
  it('no module evaluates an expression, a template or a script', () => {
    let scanned = 0;
    for (const relative of DOMAIN_PATHS) {
      const source = withoutComments(readDomainFile(relative));
      expect(EVALUATION_REFERENCE.test(source), `${relative} evaluates something`).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(DOMAIN_PATHS.length);
  });

  it('the transform vocabulary and the prohibition are DISJOINT', () => {
    const allowed = new Set<string>(FEED_FIELD_TRANSFORMS);
    const overlap = FEED_FORBIDDEN_TRANSFORM_KINDS.filter((kind) => allowed.has(kind));
    expect(overlap, 'an evaluator joined the transform set').toEqual([]);
    // Vacuity floors on both tuples: an emptied list satisfies disjointness
    // without protecting anything.
    expect(FEED_FIELD_TRANSFORMS.length).toBeGreaterThanOrEqual(8);
    expect(FEED_FORBIDDEN_TRANSFORM_KINDS.length).toBeGreaterThanOrEqual(12);
  });

  it('a mapping row has nowhere to PUT a program', async () => {
    const { feedFieldMappings } = await import('../../../db/schema/feedImport.js');
    const columns = Object.keys(getTableColumns(feedFieldMappings));
    for (const column of columns) {
      expect(
        /expression|template|script|formula|pattern|regex|code|eval/i.test(column),
        `feed_field_mappings.${column} could hold a program`,
      ).toBe(false);
    }
    // …and the three that DO exist are the three the design names.
    expect(columns).toContain('sourceField');
    expect(columns).toContain('constantValue');
    expect(columns).toContain('transform');
  });
});

describe('the importer writes into the commerce graph nowhere', () => {
  it('mints no canonical entity, writes no offer, runs no matcher, moves no money', () => {
    for (const relative of DOMAIN_PATHS) {
      const source = withoutComments(readDomainFile(relative));
      expect(CANONICAL_WRITE_REFERENCE.test(source), `${relative} mints a canonical entity`).toBe(
        false,
      );
      expect(OFFER_WRITE_REFERENCE.test(source), `${relative} writes an offer`).toBe(false);
      expect(MATCHER_WRITE_REFERENCE.test(source), `${relative} runs the matcher`).toBe(false);
      expect(COMMERCE_MONEY_REFERENCE.test(source), `${relative} reaches a money domain`).toBe(
        false,
      );
      expect(RANKING_REFERENCE.test(source), `${relative} ranks something`).toBe(false);
    }
  });

  it('walks the domain rather than listing it, and every shape found something', () => {
    expectEveryShapeFoundSomething();

    // And the walk really reads the disk rather than returning a stale or empty
    // result: every path it produced resolves to a real file.
    for (const path of DOMAIN_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }
  });
});

describe('tenant ownership (security 6)', () => {
  it('one function is the ONLY path from a route parameter to a merchant’s feed', () => {
    const controller = readDomainFile('controllers/feed-import.controller.ts');
    expect(controller).toContain('async function assertConfigurationBelongsToStore(');
    // Every merchant handler goes through it. A handler that read the
    // configuration itself would be a second answer to "may this store see this
    // feed", and the second answer is the one that gets it wrong.
    const merchantHandlers = controller.match(/export async function \w*Store\w+Handler/gu) ?? [];
    expect(merchantHandlers.length).toBeGreaterThanOrEqual(10);
    const withoutTheGate = controller
      .split(/export async function /u)
      .filter((body) => /^\w*Store\w+Handler/u.test(body))
      .filter((body) => !body.includes('assertConfigurationBelongsToStore'))
      // The two collection routes take no `:configurationId` at all.
      .filter((body) => !body.startsWith('listStoreFeedsHandler') && !body.startsWith('createStoreFeedHandler'));
    expect(withoutTheGate.map((body) => body.slice(0, 40))).toEqual([]);
  });

  it('every merchant route demands `channels:write`', () => {
    const router = readDomainFile('routes/admin/feeds.ts');
    const routes = router.match(/router\.(get|post)\(/gu) ?? [];
    const permissions = router.match(/requireStorePermission\('channels:write'\)/gu) ?? [];
    expect(routes.length).toBeGreaterThanOrEqual(14);
    expect(permissions.length).toBe(routes.length);
  });
});

describe('no credential can be stored, projected or logged (security 5)', () => {
  it('both credential columns are registered as PROTECTED', () => {
    const registered = PROTECTED_COLUMNS.feed_configuration_versions;
    expect(registered).toContain('feedUrl');
    expect(registered).toContain('authCiphertext');
  });

  it('the version projection names neither', () => {
    const controller = readDomainFile('controllers/feed-import.controller.ts');
    const start = controller.indexOf('function toVersionDTO(');
    expect(start, 'toVersionDTO has moved; this gate reads its body').toBeGreaterThan(0);
    const end = controller.indexOf('\n}', start);
    const projection = controller.slice(start, end);
    // A vacuity floor on the slice: an empty body satisfies the assertions
    // below without protecting anything.
    expect(projection.length).toBeGreaterThan(400);
    expect(projection).toContain('deliveryMode:');
    expect(/feedUrl|authCiphertext|authSecret/.test(projection)).toBe(false);
  });

  it('the ONE function that reads a credential is named as such', () => {
    const repository = readDomainFile('db/feedImport/feedConfigurationRepository.ts');
    expect(repository).toContain('export async function readFeedVersionSecrets(');
    const readers = DOMAIN_PATHS.filter((relative) =>
      withoutComments(readDomainFile(relative)).includes('readFeedVersionSecrets'),
    );
    // Its callers: the repository that defines it, the resolver (which decrypts
    // for a fetch) and the revert path (which re-encrypts under the current key
    // without the value leaving the backend). A fourth would be worth reviewing.
    expect(readers.sort()).toEqual([
      'db/feedImport/feedConfigurationRepository.ts',
      'services/feed-import/configuration.service.ts',
      'services/feed-import/resolve.ts',
    ]);
  });
});

describe('the vocabularies are closed and their prohibitions disjoint', () => {
  it('a forbidden container can never be an accepted compression', () => {
    const accepted = new Set<string>(FEED_COMPRESSIONS);
    expect(FEED_FORBIDDEN_CONTAINERS.filter((container) => accepted.has(container))).toEqual([]);
    expect(FEED_FORBIDDEN_CONTAINERS.length).toBeGreaterThanOrEqual(6);
  });

  it('the token-bearing issue codes are a strict SUBSET of the issue codes', () => {
    const all = new Set<string>(FEED_RECORD_ISSUE_CODES);
    for (const code of FEED_TOKEN_BEARING_ISSUE_CODES) expect(all.has(code)).toBe(true);
    // Three, and they are the three whose values come from a closed external
    // vocabulary. A fourth would need the CHECK's alphabet re-argued.
    expect(FEED_TOKEN_BEARING_ISSUE_CODES).toHaveLength(3);
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('each regex matches a seeded positive and rejects an ordinary line', () => {
    expect(EVALUATION_REFERENCE.test('const f = new Function("return 1");')).toBe(true);
    expect(EVALUATION_REFERENCE.test("const out = eval(mapping.expression);")).toBe(true);
    expect(EVALUATION_REFERENCE.test("import vm from 'node:vm';")).toBe(true);
    expect(EVALUATION_REFERENCE.test('const evaluated = transforms.length;')).toBe(false);
    expect(EVALUATION_REFERENCE.test('function applyFeedTransform(value) {}')).toBe(false);

    expect(
      CANONICAL_WRITE_REFERENCE.test("import { x } from '../canonical/canonical-product.service.js';"),
    ).toBe(true);
    expect(CANONICAL_WRITE_REFERENCE.test('canonicalVariantId')).toBe(false);

    expect(OFFER_WRITE_REFERENCE.test("import { recordExternalOffer } from '../offers/offer.service.js';")).toBe(true);
    expect(OFFER_WRITE_REFERENCE.test('const offers = [];')).toBe(false);

    expect(MATCHER_WRITE_REFERENCE.test('const decision = await runMatch(subject);')).toBe(true);
    expect(MATCHER_WRITE_REFERENCE.test('const matched = 0;')).toBe(false);

    expect(COMMERCE_MONEY_REFERENCE.test("from '../services/payments/provider.js'")).toBe(true);
    expect(COMMERCE_MONEY_REFERENCE.test('const price = 1999;')).toBe(false);

    expect(RANKING_REFERENCE.test('const ordered = rankOffers(rows);')).toBe(true);
    expect(RANKING_REFERENCE.test('.orderBy(asc(feedImportReports.createdAt))')).toBe(false);
  });

  it('the comment stripper removes prose without removing code', () => {
    const stripped = withoutComments(
      ['/** never eval() anything */', "import { x } from './y.js'; // eval", 'const z = safe(a);'].join('\n'),
    );
    expect(EVALUATION_REFERENCE.test(stripped)).toBe(false);
    expect(stripped).toContain('const z = safe(a);');
    expect(withoutComments("const u = 'https://example.com/x';")).toContain('https://example.com/x');
  });

  it('the domain directories really are where the gate thinks they are', () => {
    expectEveryShapeFoundSomething();
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
  it('COMMERCE_MONEY_REFERENCE sees a sibling-relative import', () => {
    expect(
      COMMERCE_MONEY_REFERENCE.test("import { helper } from '../payments/thing.service.js';"),
      "a module here reaches payments as '../payments/…' and that must not pass",
    ).toBe(true);
    expect(COMMERCE_MONEY_REFERENCE.test("import { helper } from '../../services/payments/thing.service.js';")).toBe(true);
    expect(
      COMMERCE_MONEY_REFERENCE.test("import { helper } from '../retail-pricing/thing.service.js';"),
      "a module here reaches retail-pricing as '../retail-pricing/…' and that must not pass",
    ).toBe(true);
    expect(COMMERCE_MONEY_REFERENCE.test("import { helper } from '../../services/retail-pricing/thing.service.js';")).toBe(true);
    expect(
      COMMERCE_MONEY_REFERENCE.test("import { helper } from '../retail-eligibility/thing.service.js';"),
      "a module here reaches retail-eligibility as '../retail-eligibility/…' and that must not pass",
    ).toBe(true);
    expect(COMMERCE_MONEY_REFERENCE.test("import { helper } from '../../services/retail-eligibility/thing.service.js';")).toBe(true);
    // The negative half, or the widening would fire on ordinary imports.
    expect(COMMERCE_MONEY_REFERENCE.test("import { helper } from '../payments-display/format.js';")).toBe(false);
    expect(COMMERCE_MONEY_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });

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
 * list above is the last derived hand list in this gate, and hand lists fail
 * silently — every floor and count stayed green while the seven tables this
 * domain owns sat outside every wall.
 *
 * The two `UNDERIVABLE_MODULES` are in the POPULATION and so are covered; they
 * simply do not match the name pattern, which is why they were listed in the
 * first place. The sweep only has to report what nothing covers.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  it('every feed-import-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: domainPaths,
      pattern: FEED_IMPORT_NAME_PATTERN,
      notThisDomain: [],
      expectedExclusions: 0,
      // Below today's 32 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 25,
      plantIn: 'lib',
      plantName: 'feed-import-cache.ts',
    });
  });
});
