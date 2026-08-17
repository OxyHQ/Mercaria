/**
 * The walls around the Awin source (#66), asserted STRUCTURALLY.
 *
 * Six properties, each a scan or a type read rather than a fixture, because
 * "cannot" is a stronger statement than "did not in this case":
 *
 * 1. **A feed can never establish a brand relationship** (issue adapter
 *    rule 7). No module here reaches #55's relationship layer, and the claims a
 *    feed may never make are named as VALUES, disjoint from everything this
 *    domain records.
 * 2. **There is no second parser, money reader, external-id derivation or
 *    content-hash scheme** (issue rule 1). #63's stack is CALLED, and the
 *    shapes of a re-implementation are scanned for.
 * 3. **#63's CONFIGURATION surface is not reused.** `resolve.ts`,
 *    `configuration.service.ts`, `report.service.ts` and `preview.service.ts`
 *    read a merchant-facing table an Awin advertiser has no row in, and
 *    `docs/feed-importer.md` names them explicitly as what #66 must not touch.
 * 4. **The domain writes into the commerce graph nowhere** — no canonical write
 *    service, no offer write, no matcher write, no money domain, no ranking.
 * 5. **ONE module makes an outbound call to Awin**, which is what makes the
 *    fleet-wide budget real: a second would be a second answer to "how hard may
 *    Mercaria knock on Awin".
 * 6. **No Awin URL is stored, projected or logged.** The key is in the PATH, so
 *    the schema has no URL column at all and the operator projection reports
 *    whether a LOCATOR is configured rather than what it says.
 *
 * The scanner follows the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor, an ENUMERATION floor read off the real directories, and a mutation
 * self-test on every detector, so a rotted regex cannot pass by matching
 * nothing.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import {
  AWIN_ACTIVATIONS,
  AWIN_COMMISSIONABLE_MEMBERSHIPS,
  AWIN_FEED_COLUMNS,
  AWIN_FORBIDDEN_ADVERTISER_CLAIMS,
  AWIN_IDENTITY_COLUMNS,
  AWIN_MEMBERSHIP_STATUSES,
  AWIN_SAMPLE_FINDINGS,
  AWIN_TRACKING_HOSTS,
  AWIN_TRACKING_VERDICTS,
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

/** The flat directories every domain's HTTP surface shares. */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware'] as const;

/**
 * The one module this domain shares with #62's framework.
 *
 * `awin-feed.ts` is not Awin's directory — it lives in the framework's
 * `adapters/` by the write-boundary rule — but every Awin wall has to hold
 * across it, because the tracking-link prohibition and the "a feed cannot
 * assert a badge" rule are properties of what an Awin pass may do. EXACT, so a
 * second borrowed module is a decision.
 */
const BORROWED_FRAMEWORK_MODULES = ['services/ingestion/adapters/awin-feed.ts'] as const;

/**
 * Every module of the Awin domain, plus the adapter and the surface. WALKED and
 * FILTERED, never listed.
 *
 * This was twenty-three hand-written paths under exactly that claim, and it
 * happened to be true on the day it was measured — which is the whole problem
 * (#460): a list is complete when it is written and silently incomplete the day
 * somebody adds a file, and what the gate then skips is precisely the module
 * nobody has reviewed. Nothing about the assertion changes when that happens;
 * it just covers less.
 *
 * The two owned directories are walked whole. The shared flat directories have
 * no directory of this domain's own to walk, so the population is derived from
 * the filename convention every file in them already follows; `awin` is
 * unambiguous, so this needs no exclusion list.
 */
const DOMAIN_PATHS = [
  ...walk('services/awin'),
  ...walk('db/awin'),
  ...BORROWED_FRAMEWORK_MODULES,
  ...SHARED_DIRECTORIES.flatMap((directory) =>
    readdirSync(join(SRC_ROOT, directory), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .filter((entry) => /awin/i.test(entry.name))
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
  const from = (prefix: string) => DOMAIN_PATHS.filter((path) => path.startsWith(prefix)).length;
  expect(from('services/awin/'), 'the service walk found nothing').toBeGreaterThanOrEqual(13);
  expect(from('db/awin/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(6);
  expect(BORROWED_FRAMEWORK_MODULES.length, 'the borrowed set changed').toBe(1);
  expect(from('routes/'), 'no Awin route was derived').toBeGreaterThanOrEqual(1);
  expect(from('controllers/'), 'no Awin controller was derived').toBeGreaterThanOrEqual(1);
  expect(from('middleware/'), 'no Awin request schema was derived').toBeGreaterThanOrEqual(1);
  expect(DOMAIN_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
}

/** #55's relationship layer. A feed's contents can never assert a badge. */
const RELATIONSHIP_REFERENCE =
  /commerce-graph\/relationship|relationshipRepository|commerce_relationships|SUFFICIENT_EVIDENCE_KINDS|schema\/relationships/;

/** The canonical WRITE services — minting, renaming or re-pointing an entity. */
const CANONICAL_WRITE_REFERENCE =
  /canonical-product\.service|canonical-variant\.service|product-family\.service|brand\.service|organization\.service|product-identifier\.service/;

/** The offer domain. #57 owns an offer; this source produces observations. */
const OFFER_WRITE_REFERENCE = /offers\/offer\.service|offerRepository|recordExternalOffer/;

/** #58's matcher write path. */
const MATCHER_WRITE_REFERENCE = /matching\/match\.service|runMatch\(/;

/** The payment and retail domains. A feed cannot make Mercaria the seller. */
const COMMERCE_MONEY_REFERENCE =
  /services\/payments\/|\.\.\/payments\/|services\/retail-pricing\/|\.\.\/retail-pricing\/|services\/retail-eligibility\/|\.\.\/retail-eligibility\/|mercaria_retail/;

/** #74's ranking. A network's contents are not a ranking input. */
const RANKING_REFERENCE = /rankOffers|offerRanking|services\/ranking\/|\.\.\/ranking\//;

/**
 * A SECOND parser, money reader, id derivation or hash (issue rule 1).
 *
 * The shapes a re-implementation actually takes: splitting on a delimiter,
 * multiplying a price into minor units, joining key parts, and hashing a
 * record. The one legitimate `createHash` in this domain is the feed LIST's
 * digest, which is a fact about a poll rather than about a product — so the
 * detector names `content_hash`/`contentHash` specifically rather than any hash
 * at all, which would fire on it and get the gate disabled.
 */
const SECOND_PARSER_REFERENCE =
  /\.split\(['"],['"]\)|parseFloat\(|Math\.round\([^)]*\*\s*100|contentHash|content_hash|deriveExternalId\s*=/;

/** #63's CONFIGURATION surface — a merchant-facing table Awin has no row in. */
const FEED_CONFIGURATION_REFERENCE =
  /feed-import\/(resolve|configuration\.service|report\.service|preview\.service)|feedConfigurationRepository|feed_configurations/;

/** An outbound call to Awin. Exactly one module may make one. */
const OUTBOUND_CALL_REFERENCE = /openFeedStream\(|safeFetch\(|globalThis\.fetch\(/;

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
 * detectors use — "#55 owns the badge", "there is no second parser here" — so a
 * scan over raw source would fail on the prose that exists to explain the
 * boundary.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

describe('a feed can never establish a brand relationship (adapter rule 7)', () => {
  it('no module reaches #55’s relationship layer', () => {
    let scanned = 0;
    for (const relative of DOMAIN_PATHS) {
      const source = withoutComments(readDomainFile(relative));
      expect(
        RELATIONSHIP_REFERENCE.test(source),
        `${relative} reaches the relationship layer`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(DOMAIN_PATHS.length);
  });

  it('the forbidden claims are DISJOINT from everything this domain records', () => {
    // Every vocabulary the domain can actually write. A forbidden claim that
    // appeared in one of them would be a badge with a row shape.
    const recordable = new Set<string>([
      ...AWIN_MEMBERSHIP_STATUSES,
      ...AWIN_ACTIVATIONS,
      ...AWIN_TRACKING_VERDICTS,
      ...AWIN_SAMPLE_FINDINGS,
      ...AWIN_FEED_COLUMNS,
    ]);
    expect(AWIN_FORBIDDEN_ADVERTISER_CLAIMS.filter((claim) => recordable.has(claim))).toEqual([]);
    // Vacuity floors on both sides: an emptied list satisfies disjointness
    // without protecting anything.
    expect(AWIN_FORBIDDEN_ADVERTISER_CLAIMS.length).toBeGreaterThanOrEqual(5);
    expect(recordable.size).toBeGreaterThanOrEqual(50);
  });

  it('no table in this domain has a column that could hold one', async () => {
    const schema = await import('../../../db/schema/awin.js');
    for (const [name, table] of Object.entries(schema)) {
      if (typeof table !== 'object' || table === null) continue;
      let columns: readonly string[];
      try {
        columns = Object.keys(getTableColumns(table as never));
      } catch {
        continue;
      }
      for (const column of columns) {
        expect(
          /official|authorized|authorised|reseller|brand_owner|brandOwner|manufacturer|distributor/i.test(
            column,
          ),
          `${name}.${column} could hold a brand claim`,
        ).toBe(false);
      }
    }
  });
});

describe('there is no second parser, money reader or id derivation (rule 1)', () => {
  it('every module reuses #63’s stack rather than re-implementing it', () => {
    for (const relative of DOMAIN_PATHS) {
      const source = withoutComments(readDomainFile(relative));
      expect(
        SECOND_PARSER_REFERENCE.test(source),
        `${relative} looks like a second parser, money reader, id join or hash scheme`,
      ).toBe(false);
    }
  });

  it('the adapter CALLS #63’s pipeline by name', () => {
    const adapter = readDomainFile('services/ingestion/adapters/awin-feed.ts');
    for (const entry of [
      'buildFeedStage',
      'readFeedStagePage',
      'readFeedStageManifest',
      'feedCompletionVerdict',
      'mayReportCompleteEnumeration',
    ]) {
      expect(adapter, `the adapter does not call ${entry}`).toContain(entry);
    }
  });

  it('#63’s CONFIGURATION surface is not reused anywhere', () => {
    for (const relative of DOMAIN_PATHS) {
      const source = withoutComments(readDomainFile(relative));
      expect(
        FEED_CONFIGURATION_REFERENCE.test(source),
        `${relative} reaches #63's merchant-facing configuration, which Awin has no row in`,
      ).toBe(false);
    }
  });
});

describe('the domain writes into the commerce graph nowhere', () => {
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

describe('one module calls Awin, and no URL is ever stored', () => {
  it('exactly one module makes an outbound call', () => {
    const callers = DOMAIN_PATHS.filter((relative) =>
      OUTBOUND_CALL_REFERENCE.test(withoutComments(readDomainFile(relative))),
    );
    // A second caller would be a second answer to "how hard may Mercaria knock
    // on Awin", and the loser is whichever one the dispatcher does not go
    // through.
    expect(callers).toEqual(['services/awin/network.ts']);
  });

  it('every outbound call is claimed against the network lease', () => {
    const network = withoutComments(readDomainFile('services/awin/network.ts'));
    // Both entry points go through the lease: the list read wraps itself, and
    // the feed open is wrapped by its caller in `register.ts`, which is asserted
    // separately below.
    expect(network).toContain('withAwinNetworkLease');
    expect(network).toContain('claimAwinNetworkLease');
    const register = withoutComments(readDomainFile('services/awin/register.ts'));
    expect(register).toContain('withAwinNetworkLease');
  });

  it('no table has a feed URL column — the key is in the PATH', async () => {
    const schema = await import('../../../db/schema/awin.js');
    for (const [name, table] of Object.entries(schema)) {
      if (typeof table !== 'object' || table === null) continue;
      let columns: readonly string[];
      try {
        columns = Object.keys(getTableColumns(table as never));
      } catch {
        continue;
      }
      for (const column of columns) {
        expect(/url$|Url$|_url_/i.test(column), `${name}.${column} could hold a feed URL`).toBe(
          false,
        );
      }
    }
  });

  it('the operator projection reports whether a locator is CONFIGURED, never what it says', () => {
    const controller = readDomainFile('controllers/awin-operator.controller.ts');
    const start = controller.indexOf('function toAccountDTO(');
    expect(start, 'toAccountDTO has moved; this gate reads its body').toBeGreaterThan(0);
    const end = controller.indexOf('\n}', start);
    const projection = controller.slice(start, end);
    // A vacuity floor on the slice: an empty body satisfies the assertions below
    // without protecting anything.
    expect(projection.length).toBeGreaterThan(400);
    expect(projection).toContain('feedCredentialConfigured');
    expect(/feedCredentialRef:|publisherApiCredentialRef:/.test(projection)).toBe(false);
  });
});

describe('the vocabularies are closed and the constants are what they claim', () => {
  it('exactly one membership is commissionable, and it is a MEMBER of the set', () => {
    expect(AWIN_COMMISSIONABLE_MEMBERSHIPS).toEqual(['joined']);
    for (const membership of AWIN_COMMISSIONABLE_MEMBERSHIPS) {
      expect(AWIN_MEMBERSHIP_STATUSES).toContain(membership);
    }
  });

  it('every tracking host is a bare, lower-case hostname', () => {
    expect(AWIN_TRACKING_HOSTS.length).toBeGreaterThanOrEqual(4);
    for (const host of AWIN_TRACKING_HOSTS) {
      // No scheme, no path, no port, no wildcard: the comparison is EXACT
      // against a parsed `hostname`, and anything richer here would silently
      // never match — a set that matches nothing refuses every legitimate link.
      expect(host).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u);
      expect(host).toBe(host.toLowerCase());
    }
  });

  it('the identity column is ONE and is a member of the requested column set', () => {
    expect(AWIN_IDENTITY_COLUMNS).toHaveLength(1);
    for (const column of AWIN_IDENTITY_COLUMNS) {
      expect(AWIN_FEED_COLUMNS).toContain(column);
    }
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('each regex matches a seeded positive and rejects an ordinary line', () => {
    expect(
      RELATIONSHIP_REFERENCE.test(
        "import { assertRelationship } from '../commerce-graph/relationship.service.js';",
      ),
    ).toBe(true);
    expect(RELATIONSHIP_REFERENCE.test('const advertiserRelation = null;')).toBe(false);

    expect(
      CANONICAL_WRITE_REFERENCE.test("import { x } from '../canonical/canonical-product.service.js';"),
    ).toBe(true);
    expect(CANONICAL_WRITE_REFERENCE.test('canonicalVariantId')).toBe(false);

    expect(
      OFFER_WRITE_REFERENCE.test("import { recordExternalOffer } from '../offers/offer.service.js';"),
    ).toBe(true);
    expect(OFFER_WRITE_REFERENCE.test('const offers = [];')).toBe(false);

    expect(MATCHER_WRITE_REFERENCE.test('const decision = await runMatch(subject);')).toBe(true);
    expect(MATCHER_WRITE_REFERENCE.test('const matched = 0;')).toBe(false);

    expect(COMMERCE_MONEY_REFERENCE.test("from '../services/payments/provider.js'")).toBe(true);
    expect(COMMERCE_MONEY_REFERENCE.test('const price = 1999;')).toBe(false);

    expect(RANKING_REFERENCE.test('const ordered = rankOffers(rows);')).toBe(true);
    expect(RANKING_REFERENCE.test('.orderBy(asc(awinFeeds.feedId))')).toBe(false);

    expect(SECOND_PARSER_REFERENCE.test("const cells = line.split(',');")).toBe(true);
    expect(SECOND_PARSER_REFERENCE.test('const minor = Math.round(major * 100);')).toBe(true);
    expect(SECOND_PARSER_REFERENCE.test('const contentHash = sha256(payload);')).toBe(true);
    expect(SECOND_PARSER_REFERENCE.test('const parts = value.split(listSeparator);')).toBe(false);

    expect(
      FEED_CONFIGURATION_REFERENCE.test("import { resolveFeedImport } from '../feed-import/resolve.js';"),
    ).toBe(true);
    expect(FEED_CONFIGURATION_REFERENCE.test("import { buildFeedStage } from '../feed-import/staging.js';")).toBe(
      false,
    );

    expect(OUTBOUND_CALL_REFERENCE.test('const outcome = await openFeedStream(request);')).toBe(true);
    expect(OUTBOUND_CALL_REFERENCE.test('const rows = await listAwinFeeds(id);')).toBe(false);
  });

  it('the comment stripper removes prose without removing code', () => {
    const stripped = withoutComments(
      [
        '/** never reaches commerce_relationships */',
        "import { x } from './y.js'; // relationshipRepository",
        'const z = safe(a);',
      ].join('\n'),
    );
    expect(RELATIONSHIP_REFERENCE.test(stripped)).toBe(false);
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
