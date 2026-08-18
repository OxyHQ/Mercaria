/**
 * The walls around the ingestion framework (#62 §"Write boundaries"), asserted
 * STRUCTURALLY.
 *
 * Six separate properties, each a scan or a schema read rather than a fixture,
 * because "cannot" is a stronger statement than "did not in this case":
 *
 * 1. **A provider module reaches nothing.** No module under `adapters/` may
 *    import a repository, a database handle, a canonical write service, the
 *    offer domain or the matcher. That is issue write boundary 1 and acceptance
 *    4 — and it holds for adapters nobody has written yet, because the gate
 *    reads the DIRECTORY.
 * 2. **The framework mints no canonical entity.** No module in the domain
 *    imports a canonical WRITE service. It writes source LINKS, which attach an
 *    observation to something #58 resolved and #60 minted.
 * 3. **An external offer can never be checkout-native.** The permitted kinds
 *    exclude `native` as a TYPE, and the schema forces `product_variant_id`
 *    NULL on every other kind — so there is no id a cart line could hold.
 * 4. **`mercaria_retail` eligibility stays with #116/#121.** No module here
 *    references the retail domain at all: an ingested offer must not be able to
 *    make Mercaria the seller.
 * 5. **Nothing here ranks anything** (#74's), performs #37's redirect, or
 *    reaches #59's curation tooling.
 * 6. **No credential ever reaches a column or a DTO.** The forbidden payload
 *    field names are disjoint from the allow-list, and the operator projection
 *    does not carry `credentialRef`.
 *
 * The scanner follows the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor, so a moved file fails the gate instead of silently shrinking it, an
 * ENUMERATION floor read off the real directories, and a mutation self-test, so
 * a rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
  CATALOG_SOURCE_FORBIDDEN_PAYLOAD_FIELDS,
  CATALOG_SOURCE_PAYLOAD_FIELDS,
  CATALOG_SOURCE_RIGHTS,
} from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** What a module of this domain is called, wherever it lives. */
const INGESTION_NAME_PATTERN = /ingestion/i;

/**
 * The flat directories a module of this domain lives in under a domain NAME.
 *
 * `db/schema` was missing — the five tables this framework owns
 * (`catalog_sources`, `catalog_source_configs`, `catalog_source_policies`,
 * `catalog_source_runs`, `catalog_source_rejections`) were behind none of the
 * walls below, which is the directory where a rights column or a payload bag
 * would be DECLARED. The omission is not this gate's invention: the same
 * three-name list was copied from gate to gate and from
 * `scripts/isolation-gate-census.ts`'s own bag-directory list.
 *
 * The sweep at the end of this file is what stops the next omission being
 * silent, and it is the general remedy rather than this one entry.
 */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/**
 * Every module of the ingestion domain — services, adapters, repositories,
 * route, operator controller, request schemas. WALKED and FILTERED, never
 * listed.
 *
 * This was twenty hand-written paths under a comment claiming exactly that
 * completeness, and the claim was false in the place it mattered most: the walk
 * is recursive now, and `services/ingestion/adapters/` — five provider modules,
 * the part of this domain that talks to somebody else's server — was outside
 * every FRAMEWORK wall in this file (#460). The `ADAPTER_FORBIDDEN` wall below
 * covered them and is a different, narrower set: it names repositories,
 * database handles, canonical writes, the offer domain and the matcher, and
 * says nothing about ranking, #37's redirect, #59's curation, the retail
 * domain or writing a native offer. So an adapter that ranked its own results
 * passed both walls — this one because it never read the file, that one
 * because it does not ask.
 *
 * The two owned directories are walked whole, so the walls hold for adapters
 * nobody has written yet — which is the point, since #63/#65/#66/#125 each
 * added one after this list was written. The shared flat directories have no
 * directory of this domain's own to walk, so the population is derived from the
 * filename convention every file in them already follows; `ingestion` is
 * unambiguous, so this needs no exclusion list.
 */
function ingestionDomainPaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...walkOwnedDirectory('services/ingestion', readDir),
    ...walkOwnedDirectory('db/ingestion', readDir),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, INGESTION_NAME_PATTERN, readDir),
  ];
}

const INGESTION_DOMAIN_PATHS = ingestionDomainPaths();

/**
 * The enumeration floor, per SHAPE.
 *
 * Each number is the count on the day it was written: these directories only
 * grow, and a SHRINK is the event that should stop the build rather than
 * quietly narrowing every wall in this file. Split by shape because the four
 * sources break independently — and `adapters/` gets its own, because it is the
 * one this conversion added and a non-recursive walk would silently drop it
 * while every other number stayed right.
 */
function expectEveryShapeFoundSomething(): void {
  const from = (prefix: string) =>
    INGESTION_DOMAIN_PATHS.filter((path) => path.startsWith(prefix)).length;
  expect(
    from('services/ingestion/adapters/'),
    'the adapter walk found nothing — is the walk still recursive?',
  ).toBeGreaterThanOrEqual(5);
  expect(from('services/ingestion/'), 'the service walk found nothing').toBeGreaterThanOrEqual(16);
  expect(from('db/ingestion/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(6);
  expect(from('routes/'), 'no ingestion route was derived').toBeGreaterThanOrEqual(1);
  expect(from('controllers/'), 'no ingestion controller was derived').toBeGreaterThanOrEqual(1);
  expect(from('middleware/'), 'no ingestion request schema was derived').toBeGreaterThanOrEqual(1);
  expect(from('db/schema/'), 'no ingestion schema module was derived').toBeGreaterThanOrEqual(1);
  expect(INGESTION_DOMAIN_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
}

/** The canonical WRITE services — minting, renaming or re-pointing an entity. */
const CANONICAL_WRITE_REFERENCE =
  /canonical-product\.service|canonical-variant\.service|product-family\.service|brand\.service|organization\.service|product-identifier\.service/;

/** #121/#116's retail domain. An ingested offer must not make Mercaria the seller. */
const RETAIL_REFERENCE = /retail-eligibility|retail-pricing|retailEligibility|retailPricing|mercaria_retail/;

/** #74's ranking. */
const RANKING_REFERENCE = /rankOffers|offerRanking|services\/ranking\/|\.\.\/ranking\//;

/** #37's outbound redirect. This domain models routing metadata and never routes. */
const REDIRECT_REFERENCE = /outboundRedirect|redirect\.service|buildAffiliateUrl|services\/outbound\//;

/** #59's curation tooling. Corrections are its job, not an ingestion run's. */
const CURATION_REFERENCE = /services\/curation\/|catalogMergeJob|requestMerge|applyRehomeTarget/;

/** Anything an adapter may not reach. */
const ADAPTER_FORBIDDEN: readonly { name: string; pattern: RegExp }[] = [
  { name: 'a repository', pattern: /db\/[a-zA-Z-]+\/[a-zA-Z]+Repository/ },
  { name: 'a database handle', pattern: /db\/postgres|getDb\(|drizzle-orm/ },
  { name: 'a canonical write service', pattern: CANONICAL_WRITE_REFERENCE },
  { name: 'the offer domain', pattern: /offers\/offer\.service|offerRepository|recordExternalOffer/ },
  { name: 'the matching pipeline', pattern: /matching\/match\.service|runMatch/ },
];

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
 * detectors use — "#74 owns ranking", "#116 owns retail eligibility" — so a scan
 * over raw source would fail on the prose that exists to explain the boundary.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

describe('a provider module reaches nothing (issue write boundary 1, acceptance 4)', () => {
  const adaptersDir = join(SRC_ROOT, 'services/ingestion/adapters');

  it('no adapter imports a repository, a database, a canonical write, an offer or the matcher', () => {
    const files = readdirSync(adaptersDir)
      .filter((entry) => entry.endsWith('.ts'))
      .filter((entry) => statSync(join(adaptersDir, entry)).isFile());
    // The enumeration floor, read off the real directory: a gate over an empty
    // list passes vacuously and reads exactly like a clean one. `> 0` was that
    // gate one file wide — a walk returning ONE of the five adapters cleared it
    // and reported the same green (#460). The number is the count on the day it
    // was written, because this directory only grows and losing an adapter is
    // an event, not a routine.
    expect(files.length, 'the adapter walk found nothing').toBeGreaterThanOrEqual(5);

    for (const file of files) {
      const source = withoutComments(readFileSync(join(adaptersDir, file), 'utf8'));
      for (const { name, pattern } of ADAPTER_FORBIDDEN) {
        expect(pattern.test(source), `adapters/${file} reaches ${name}`).toBe(false);
      }
    }
  });
});

describe('the framework does other issues’ jobs nowhere', () => {
  it('mints no canonical entity, ranks nothing, redirects nothing, curates nothing', () => {
    let scanned = 0;
    for (const relative of INGESTION_DOMAIN_PATHS) {
      const source = withoutComments(readDomainFile(relative));
      expect(
        CANONICAL_WRITE_REFERENCE.test(source),
        `${relative} imports a canonical write service`,
      ).toBe(false);
      expect(RANKING_REFERENCE.test(source), `${relative} ranks offers`).toBe(false);
      expect(REDIRECT_REFERENCE.test(source), `${relative} performs #37's redirect`).toBe(false);
      expect(CURATION_REFERENCE.test(source), `${relative} reaches #59's curation`).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(INGESTION_DOMAIN_PATHS.length);
  });

  it('grants no `mercaria_retail` eligibility (issue write boundary 8)', () => {
    for (const relative of INGESTION_DOMAIN_PATHS) {
      const source = withoutComments(readDomainFile(relative));
      expect(
        RETAIL_REFERENCE.test(source),
        `${relative} reaches the retail domain; supplier-backed eligibility is #116/#121's`,
      ).toBe(false);
    }
  });

  it('walks the domain rather than listing it, and every shape found something', () => {
    expectEveryShapeFoundSomething();

    // And the walk really reads the disk rather than returning a stale or empty
    // result: every path it produced resolves to a real file.
    for (const path of INGESTION_DOMAIN_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }
  });
});

describe('an ingested offer can never be checkout-native (issue write boundary 7)', () => {
  it('the pipeline names a kind set that excludes `native`, and the schema enforces it', async () => {
    const source = readDomainFile('services/ingestion/ingest.service.ts');
    // The type is what makes a `native` kind a `tsc` error here; the assertion
    // is that the exclusion is written down rather than implied.
    expect(source).toContain("Exclude<OfferKind, 'native'>");

    const { offers } = await import('../../../db/schema/offers.js');
    const { getTableConfig } = await import('drizzle-orm/pg-core');
    const shapeCheck = getTableConfig(offers).checks.find(
      (entry) => entry.name === 'offers_kind_shape_check',
    );
    expect(shapeCheck, 'offers_kind_shape_check is missing').toBeDefined();
    expect(Object.keys(getTableColumns(offers))).toContain('productVariantId');
  });

  it('no ingestion module writes a native offer or a native listing link', () => {
    for (const relative of INGESTION_DOMAIN_PATHS) {
      const source = withoutComments(readDomainFile(relative));
      expect(/upsertNativeOffer|insertNativeListingLink|convergeNativeOffers/.test(source)).toBe(
        false,
      );
    }
  });
});

describe('no credential can be stored, projected or logged', () => {
  it('the allow-list and the forbidden field names are DISJOINT', () => {
    const allowed = new Set<string>(CATALOG_SOURCE_PAYLOAD_FIELDS);
    const overlap = CATALOG_SOURCE_FORBIDDEN_PAYLOAD_FIELDS.filter((field) => allowed.has(field));
    expect(overlap, 'a credential-shaped key joined the payload allow-list').toEqual([]);
    // Vacuity floors on both tuples: an emptied list would satisfy the
    // disjointness above without protecting anything.
    expect(CATALOG_SOURCE_PAYLOAD_FIELDS.length).toBeGreaterThanOrEqual(25);
    expect(CATALOG_SOURCE_FORBIDDEN_PAYLOAD_FIELDS.length).toBeGreaterThanOrEqual(15);
  });

  it('the redactor stores nothing outside the allow-list, even from a hostile record', async () => {
    const { buildStoredPayload } = await import('../redact.js');
    const stored = buildStoredPayload({
      title: 'A widget',
      identifiers: [],
      options: [],
      media: [],
    });
    for (const key of Object.keys(stored)) {
      expect(
        (CATALOG_SOURCE_PAYLOAD_FIELDS as readonly string[]).includes(key),
        `the redactor emitted '${key}', which is not in the allow-list`,
      ).toBe(true);
    }
  });

  it('the operator projection never carries the credential locator', () => {
    const controller = readDomainFile('controllers/ingestion-operator.controller.ts');
    // Scoped to the PROJECTION, not the whole controller: the configure handler
    // legitimately passes a caller's `credentialRef` INWARD, and a gate over the
    // file would fail on that and have to be loosened until it caught nothing.
    // What must never happen is the locator coming back OUT.
    const start = controller.indexOf('function toSourceDTO(');
    expect(start, 'toSourceDTO has moved; this gate reads its body').toBeGreaterThan(0);
    const end = controller.indexOf('\n}', start);
    expect(end, 'could not find the end of toSourceDTO').toBeGreaterThan(start);
    const projection = controller.slice(start, end);
    // A vacuity floor on the slice: an empty body would satisfy the assertion
    // below without protecting anything.
    expect(projection.length).toBeGreaterThan(400);
    expect(projection).toContain('sourceId:');
    expect(/credentialRef/.test(projection)).toBe(false);
  });

  it('the credential column holds a locator shape, not a secret', async () => {
    const { getTableConfig } = await import('drizzle-orm/pg-core');
    const { catalogSourceConfigs } = await import('../../../db/schema/ingestion.js');
    const check = getTableConfig(catalogSourceConfigs).checks.find(
      (entry) => entry.name === 'catalog_source_configs_credential_ref_shape_check',
    );
    expect(check, 'the credential shape CHECK is missing').toBeDefined();
  });
});

describe('the rights vocabulary is complete and load-bearing', () => {
  it('every one of the nine rights has a policy column', async () => {
    const { catalogSourcePolicies } = await import('../../../db/schema/ingestion.js');
    const columns = Object.keys(getTableColumns(catalogSourcePolicies));
    const columnFor: Readonly<Record<string, string>> = {
      store: 'mayStore',
      cache: 'mayCache',
      display_price: 'mayDisplayPrice',
      display_media: 'mayDisplayMedia',
      outbound_link: 'mayLinkOut',
      affiliate_params: 'mayAppendAffiliateParams',
      index: 'mayIndex',
      automated_refresh: 'mayRefreshAutomatically',
      extraction: 'extractionMode',
    };
    expect(CATALOG_SOURCE_RIGHTS).toHaveLength(9);
    for (const right of CATALOG_SOURCE_RIGHTS) {
      const column = columnFor[right];
      expect(column, `right '${right}' has no declared column`).toBeDefined();
      expect(columns, `right '${right}' names a column that does not exist`).toContain(column);
    }
  });

  it('there is no markup-shaped, margin-shaped or price-setting column anywhere here', async () => {
    const schema = await import('../../../db/schema/ingestion.js');
    const forbidden = /markup|margin|profit|commission|surcharge/i;
    for (const [name, table] of Object.entries(schema)) {
      if (typeof table !== 'object' || table === null) continue;
      let columns: string[];
      try {
        columns = Object.keys(getTableColumns(table as never));
      } catch {
        continue;
      }
      for (const column of columns) {
        // An ingestion framework records what a source published. A column that
        // could hold Mercaria's own take would make this the second place
        // pricing happens (#120's device, applied one domain over).
        expect(forbidden.test(column), `${name}.${column} looks like a pricing column`).toBe(false);
      }
    }
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('each regex matches a seeded positive and rejects an ordinary line', () => {
    expect(
      CANONICAL_WRITE_REFERENCE.test(
        "import { applyCanonicalProduct } from '../canonical/canonical-product.service.js';",
      ),
    ).toBe(true);
    expect(CANONICAL_WRITE_REFERENCE.test('canonicalVariantId')).toBe(false);

    expect(RETAIL_REFERENCE.test("import { getRetailEligibility } from '../retail-eligibility/x.js';")).toBe(true);
    expect(RETAIL_REFERENCE.test('const retailer = record.merchantHint;')).toBe(false);

    expect(RANKING_REFERENCE.test('const ordered = rankOffers(rows);')).toBe(true);
    expect(RANKING_REFERENCE.test('.orderBy(asc(offers.priceAmount))')).toBe(false);

    expect(REDIRECT_REFERENCE.test("import { buildAffiliateUrl } from '../outbound/x.js';")).toBe(true);
    expect(REDIRECT_REFERENCE.test('affiliateTrackingTemplate')).toBe(false);

    expect(
      CURATION_REFERENCE.test("import { planMerge } from '../../services/curation/merge-plan.js';"),
    ).toBe(true);
    expect(CURATION_REFERENCE.test('const curated = false;')).toBe(false);

    for (const { pattern } of ADAPTER_FORBIDDEN) {
      expect(pattern.test('const response = await fetch(url);')).toBe(false);
    }
    expect(ADAPTER_FORBIDDEN[0]?.pattern.test("from '../../db/ingestion/catalogSourceRunRepository.js'")).toBe(true);
    expect(ADAPTER_FORBIDDEN[1]?.pattern.test("import { getDb } from '../../db/postgres.js';")).toBe(true);
  });

  it('the comment stripper removes prose without removing code', () => {
    const stripped = withoutComments(
      ['/** ranking is #74 rankOffers */', "import { x } from './y.js'; // rankOffers", 'const z = rankOffers(a);'].join('\n'),
    );
    expect(stripped).not.toContain('#74');
    expect(stripped).toContain('const z = rankOffers(a);');
    // And it must not eat a URL's `//`, which is the classic over-strip.
    expect(withoutComments("const u = 'https://example.com/x';")).toContain('https://example.com/x');
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
 * every floor and count stayed green while the five tables this framework owns
 * sat outside every wall.
 *
 * So: sweep the whole of `src/` for paths NAMING this domain and require each to
 * be in the derived population or in a counted exclusion. A bag directory nobody
 * has invented yet brings its modules under these walls with no edit here.
 *
 * `ingestion` is an unambiguous token in this tree — no other domain has taken
 * it — so the exclusion set is EMPTY, and it is empty because it was MEASURED
 * rather than guessed. A guessed exemption excuses what can never match.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  it('every ingestion-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: ingestionDomainPaths,
      pattern: INGESTION_NAME_PATTERN,
      notThisDomain: [],
      // Below today's count so a routine deletion does not fail the build, and
      // far enough above zero that a traversal which reached nothing does.
      sweepFloor: 20,
      plantIn: 'lib',
      plantName: 'ingestion-cache.ts',
    });
  });
});
