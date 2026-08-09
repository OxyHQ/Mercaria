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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const DOMAIN_DIR = join(SRC_ROOT, 'services/feed-import');

/** Every module of the feed-import domain, plus the adapter and the surface. */
const DOMAIN_PATHS = [
  'services/feed-import/auth.ts',
  'services/feed-import/bytes.ts',
  'services/feed-import/completion.ts',
  'services/feed-import/configuration.service.ts',
  'services/feed-import/errors.ts',
  'services/feed-import/external-id.ts',
  'services/feed-import/fetch.ts',
  'services/feed-import/mapping.ts',
  'services/feed-import/money.ts',
  'services/feed-import/open.ts',
  'services/feed-import/preview.service.ts',
  'services/feed-import/redact.ts',
  'services/feed-import/register.ts',
  'services/feed-import/report.service.ts',
  'services/feed-import/resolve.ts',
  'services/feed-import/staging.ts',
  'services/feed-import/suggest.ts',
  'services/feed-import/transforms.ts',
  'services/feed-import/upload.ts',
  'services/feed-import/parse/delimited.ts',
  'services/feed-import/parse/flatten.ts',
  'services/feed-import/parse/index.ts',
  'services/feed-import/parse/json.ts',
  'services/feed-import/parse/jsonl.ts',
  'services/feed-import/parse/types.ts',
  'services/feed-import/parse/xml.ts',
  'services/ingestion/adapters/product-feed.ts',
  'db/feedImport/feedConfigurationRepository.ts',
  'db/feedImport/feedImportReportRepository.ts',
  'controllers/feed-import.controller.ts',
  'middleware/feed-import-schemas.ts',
  'routes/admin/feeds.ts',
  'routes/internal-feed-imports.ts',
];

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
  /services\/payments\/|services\/retail-pricing\/|services\/retail-eligibility\/|mercaria_retail/;

/** #74's ranking. A feed's contents are not a ranking input. */
const RANKING_REFERENCE = /rankOffers|offerRanking|services\/ranking\//;

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

  it('covers every module in services/feed-import and db/feedImport — the enumeration floor', () => {
    // A file added to either directory and forgotten by the list above would
    // make every scan here silently narrower. Read the real directories.
    const walk = (relative: string): string[] =>
      readdirSync(join(SRC_ROOT, relative))
        .filter((entry) => entry.endsWith('.ts'))
        .filter((entry) => statSync(join(SRC_ROOT, relative, entry)).isFile())
        .map((entry) => `${relative}/${entry}`);

    const onDisk = [
      ...walk('services/feed-import'),
      ...walk('services/feed-import/parse'),
      ...walk('db/feedImport'),
    ];
    const listed = new Set(DOMAIN_PATHS);
    expect(onDisk.filter((path) => !listed.has(path))).toEqual([]);
    expect(onDisk.length).toBeGreaterThanOrEqual(25);
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

  it('the domain directory really is where the gate thinks it is', () => {
    const files = readdirSync(DOMAIN_DIR).filter((entry) => entry.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(18);
  });
});
