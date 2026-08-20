/**
 * The walls around the external-mapping domain (#367 Workstream 11), asserted
 * STRUCTURALLY.
 *
 * Nine properties, each a scan or a schema read rather than a fixture, because
 * "cannot" is a stronger statement than "did not in this case".
 *
 * ## The population (#460)
 *
 * It was `readdirSync` over the two owned directories, ONE LEVEL DEEP each:
 * eleven modules. `db/schema/catalogExternalMappings.ts` — 42 KB declaring every
 * table, CHECK and unique index this domain's nine properties are ABOUT — was
 * behind none of them. Measured clean against all eleven detectors on
 * comment-stripped source before being added.
 *
 * The nine:
 *
 * 1. **Nothing here ranks anything.** #74 owns ranking behind a versioned
 *    policy, and a taxonomy mapping is one join from "the categories that pay
 *    best sit at the top". A scanned gate both ways is #77's precedent.
 * 2. **Nothing here reads the fee domain.** `fee-ranking-isolation.test.ts`'s
 *    rule, applied to the layer that decides what a source's category MEANS.
 * 3. **Nothing here reads the referral domain.**
 * 4. **No source-supplied string is ever executed.** `eval`, `new Function`,
 *    `node:vm`, six template engines and — the one that would actually happen —
 *    a `RegExp` built from anything other than a literal. #63 names the reason:
 *    a source-supplied pattern is a small language and a DoS primitive.
 * 5. **No canonical entity can be minted here.** No canonical write service, no
 *    matcher, no offer writer, no listing writer. That is what makes "source
 *    records stay idempotent and must not create duplicate canonical entities"
 *    a property of the import graph rather than a rule somebody follows.
 * 6. **#94's registry is never WRITTEN.** `attribute_source_mappings` is read as
 *    a legacy input and belongs to #94; a second writer would be the second
 *    source of truth this epic exists to remove.
 * 7. **No target column names a NAME, a LABEL or a SLUG.** ADR 0007 D1's single
 *    invariant, held by the absence of a column to put one in.
 * 8. **The resolver never reads `confidence`.** There is no confidence at which
 *    a mapping applies without approval.
 * 9. **The preview writes nothing.** A preview that could change something is
 *    not a preview.
 *
 * Plus the two disjointness gates and a census over the shipped transform rules.
 *
 * Every detector carries a vacuity floor and a mutation self-test, per the house
 * rule: a rotted regex passes by matching nothing, and a moved file passes by
 * having nothing to match.
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
  CATALOG_EXTERNAL_FORBIDDEN_TRANSFORMS,
  CATALOG_EXTERNAL_MAPPING_DIMENSIONS,
  CATALOG_EXTERNAL_MAPPING_FORBIDDEN_PROVENANCES,
  CATALOG_EXTERNAL_MAPPING_PROVENANCES,
  CATALOG_EXTERNAL_TRANSFORM_RULES,
} from '@mercaria/shared-types';
import {
  CATALOG_EXTERNAL_TRANSFORM_RULE_VERSIONS,
  registeredTransformRuleKeys,
} from '../transform-rules.js';
import { catalogExternalMappings } from '../../../db/schema/catalogExternalMappings.js';

/** The mappings table, so the two column censuses below read one definition. */
function catalogExternalMappingsTable() {
  return catalogExternalMappings;
}

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * What a module of this domain is called, wherever it lives.
 *
 * The `catalog-` prefix is deliberately NOT in the pattern: `external-mapping`
 * is the distinctive half, and the two camelCase spellings
 * (`db/catalogExternalMappings/`, `db/schema/catalogExternalMappings.ts`) are
 * reached by the optional hyphen. Measured over the whole of `src/`, this
 * selects twelve modules and every one is this domain's.
 */
const EXTERNAL_MAPPING_NAME_PATTERN = /external-?mappings?/i;

/** The two directories this domain owns outright. */
const OWNED_DIRECTORIES = [
  'services/catalog-external-mappings',
  'db/catalogExternalMappings',
] as const;

/** The flat directories a module of this domain lives in under a domain NAME. */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/** Every module of the external-mapping domain, enumerated from disk. */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    // RECURSIVE, where this read one directory level.
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, EXTERNAL_MAPPING_NAME_PATTERN, readDir),
  ];
}

/** Every module of the domain, read off the real directories. */
function domainFiles(): readonly string[] {
  return domainRelativePaths().map((relative) => join(SRC_ROOT, relative));
}

function readDomainFile(path: string): string {
  const source = readFileSync(path, 'utf8');
  // The vacuity floor: an empty or moved file must FAIL here rather than pass a
  // scan by having nothing in it to match.
  expect(source.length, `${path} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * Strip comments before a reachability test.
 *
 * These modules DOCUMENT what they refuse to do in the vocabulary the detectors
 * use — "#74 owns ranking", "a source-supplied pattern is a DoS primitive" — so
 * a scan over raw source would fail on the prose that exists to explain the
 * boundary.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

// The directory patterns are anchored on `/<dir>/` rather than on
// `services/<dir>/`, because a module inside `services/` reaches a sibling
// domain by a RELATIVE path (`../fees/…`). #125's isolation gate caught exactly
// that gap in its own mutation self-test: the first spelling would have let a
// relative import through while looking like a wall.
const RANKING_REFERENCE = /\/ranking\/|rankOffers|rankOfferComparison|offerRanking/;
const FEE_REFERENCE = /\/fees\/|feeSchedule|orderFeeSnapshot|marketplace_fee|commissionBps/;
const REFERRAL_REFERENCE = /\/referral|referralAttribution|referral_programs|referralReward/;
const CODE_EXECUTION: readonly { name: string; pattern: RegExp }[] = [
  { name: 'eval', pattern: /\beval\s*\(/ },
  { name: 'the Function constructor', pattern: /new\s+Function\s*\(/ },
  { name: 'node:vm', pattern: /node:vm|require\(['"]vm['"]\)|vm\.runIn/ },
  {
    name: 'a template engine',
    pattern: /handlebars|mustache|nunjucks|liquidjs|\bejs\b|\bpug\b|\beta\b/i,
  },
  // The one that would actually happen: a pattern assembled from a value. Every
  // regular expression in this domain is a literal in `transform-rules.ts`.
  { name: 'a constructed RegExp', pattern: /new\s+RegExp\s*\(/ },
  { name: 'a dynamic import', pattern: /\bimport\s*\(/ },
];
const CANONICAL_WRITE_REFERENCE =
  /canonical-product\.service|canonical-variant\.service|product-family\.service|brand\.service|organization\.service|product-identifier\.service|catalog-write\.service/;
const MATCHER_REFERENCE = /matching\/match\.service|\brunMatch\b|matchIncomingVariant/;
const OFFER_WRITE_REFERENCE =
  /recordExternalOffer|upsertExternalOffer|upsertNativeOffer|requestNativeOfferSync/;
/**
 * A WRITE against #94's registry.
 *
 * Deliberately narrow: this domain legitimately READS `attributeSourceMappings`
 * (that is the whole of `legacy-registry.ts`), so a gate over the identifier
 * would have to be loosened until it caught nothing. What must never happen is a
 * write.
 */
const REGISTRY_WRITE_REFERENCE =
  /\.insert\(\s*attributeSourceMappings|\.update\(\s*attributeSourceMappings|\.delete\(\s*attributeSourceMappings|\.insert\(\s*attributeDefinitions|\.update\(\s*attributeDefinitions|\.delete\(\s*attributeDefinitions|\.insert\(\s*attributeEnumValues|\.update\(\s*attributeEnumValues|\.delete\(\s*attributeEnumValues/;

describe('the domain does other issues’ jobs nowhere', () => {
  it('covers every module in both directories — the enumeration floor', () => {
    // A gate over an empty list passes vacuously and reads exactly like a clean
    // one, so the file list is read off disk and floored.
    const files = domainFiles();
    expect(
      files.length,
      'no domain modules found — did the directories move?',
    ).toBeGreaterThanOrEqual(10);
  });

  it('ranks nothing, reads no fee and reaches no referral', () => {
    let scanned = 0;
    for (const path of domainFiles()) {
      const source = withoutComments(readDomainFile(path));
      expect(RANKING_REFERENCE.test(source), `${path} reaches #74's ranking`).toBe(false);
      expect(FEE_REFERENCE.test(source), `${path} reaches the fee domain`).toBe(false);
      expect(REFERRAL_REFERENCE.test(source), `${path} reaches the referral domain`).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(10);
  });

  it('mints no canonical entity, runs no matcher and writes no offer', () => {
    for (const path of domainFiles()) {
      const source = withoutComments(readDomainFile(path));
      expect(
        CANONICAL_WRITE_REFERENCE.test(source),
        `${path} imports a canonical write service; an external mapping must not mint one`,
      ).toBe(false);
      expect(MATCHER_REFERENCE.test(source), `${path} runs the matcher`).toBe(false);
      expect(OFFER_WRITE_REFERENCE.test(source), `${path} writes an offer`).toBe(false);
    }
  });

  it('never WRITES #94’s registry', () => {
    for (const path of domainFiles()) {
      const source = withoutComments(readDomainFile(path));
      expect(
        REGISTRY_WRITE_REFERENCE.test(source),
        `${path} writes #94's registry; that table is #94's and a second writer is a second truth`,
      ).toBe(false);
    }
  });
});

describe('no source-supplied string is ever executed', () => {
  it('the domain contains no execution primitive and no constructed pattern', () => {
    for (const path of domainFiles()) {
      const source = withoutComments(readDomainFile(path));
      for (const { name, pattern } of CODE_EXECUTION) {
        expect(pattern.test(source), `${path} reaches ${name}`).toBe(false);
      }
    }
  });

  it('every transform rule ships in the image, and every shipped key is citable', () => {
    // The census, both ways. A key in the tuple with no implementation would be
    // storable, reviewable and permanently unresolvable — a row that looks like
    // work somebody did. An implementation under a key nobody may cite is dead.
    const declared = Object.keys(CATALOG_EXTERNAL_TRANSFORM_RULE_VERSIONS).sort();
    expect(declared).toEqual([...CATALOG_EXTERNAL_TRANSFORM_RULES].sort());

    const expected = Object.entries(CATALOG_EXTERNAL_TRANSFORM_RULE_VERSIONS)
      .flatMap(([rule, versions]) => versions.map((version) => `${rule}:${version}`))
      .sort();
    expect(registeredTransformRuleKeys()).toEqual(expected);
    expect(expected.length).toBeGreaterThanOrEqual(8);
  });
});

describe('the two prohibition lists are DISJOINT from what they guard', () => {
  it('no forbidden provenance is a permitted one', () => {
    const permitted = new Set<string>(CATALOG_EXTERNAL_MAPPING_PROVENANCES);
    const overlap = CATALOG_EXTERNAL_MAPPING_FORBIDDEN_PROVENANCES.filter((entry) =>
      permitted.has(entry),
    );
    expect(overlap, 'a forbidden basis joined the provenance tuple').toEqual([]);
    // Vacuity floors on both: an emptied list satisfies disjointness and
    // protects nothing.
    expect(CATALOG_EXTERNAL_MAPPING_PROVENANCES.length).toBeGreaterThanOrEqual(5);
    expect(CATALOG_EXTERNAL_MAPPING_FORBIDDEN_PROVENANCES.length).toBeGreaterThanOrEqual(9);
  });

  it('no forbidden transform is a shipped one', () => {
    const shipped = new Set<string>(CATALOG_EXTERNAL_TRANSFORM_RULES);
    const overlap = CATALOG_EXTERNAL_FORBIDDEN_TRANSFORMS.filter((entry) => shipped.has(entry));
    expect(overlap, 'a forbidden transform joined the shipped tuple').toEqual([]);
    expect(CATALOG_EXTERNAL_TRANSFORM_RULES.length).toBeGreaterThanOrEqual(8);
    expect(CATALOG_EXTERNAL_FORBIDDEN_TRANSFORMS.length).toBeGreaterThanOrEqual(10);
  });

  it('`name_match` and `slug_match` are named, because ADR 0007 D1 is the one invariant', () => {
    expect(CATALOG_EXTERNAL_MAPPING_FORBIDDEN_PROVENANCES).toContain('name_match');
    expect(CATALOG_EXTERNAL_MAPPING_FORBIDDEN_PROVENANCES).toContain('slug_match');
  });
});

describe('a mapping can never point at a NAME (ADR 0007 D1)', () => {
  it('no target column in the schema names a name, a label, a slug or a title', async () => {
    const schema = await import('../../../db/schema/catalogExternalMappings.js');
    let inspected = 0;
    let targetColumns = 0;
    for (const [name, table] of Object.entries(schema)) {
      if (typeof table !== 'object' || table === null) continue;
      let columns: string[];
      try {
        columns = Object.keys(getTableColumns(table as never));
      } catch {
        continue;
      }
      inspected += 1;
      for (const column of columns) {
        if (!column.startsWith('target')) continue;
        targetColumns += 1;
        expect(
          /name|label|slug|title/i.test(column),
          `${name}.${column} is a target that names presentation; a name is never identity`,
        ).toBe(false);
      }
    }
    // Both floors matter: a scan over no tables and a scan over tables with no
    // target columns each pass while measuring nothing.
    expect(inspected, 'no tables found in the schema module').toBe(5);
    // Six: one per dimension, plus the family a unit code lives in and the
    // attribute a controlled value belongs to. Floored EXACTLY at the real
    // count, because a scan over zero target columns passes while measuring
    // nothing and reads identically to a clean one.
    expect(targetColumns, 'no target columns found — did they get renamed?').toBe(6);
  });

  it('the five dimensions each have a target column, and no sixth exists', async () => {
    const columns = new Set(Object.keys(getTableColumns(catalogExternalMappingsTable())));
    // The map is the census: a dimension added to the tuple with no column
    // behind it fails here rather than at a CHECK's `else false` in production.
    const columnFor: Readonly<Record<string, string>> = {
      product_type: 'targetProductTypeKey',
      attribute: 'targetAttributeKey',
      controlled_value: 'targetControlledValue',
      unit: 'targetUnitCode',
      size_system: 'targetSizeSystemKey',
    };
    expect(CATALOG_EXTERNAL_MAPPING_DIMENSIONS).toHaveLength(5);
    for (const dimension of CATALOG_EXTERNAL_MAPPING_DIMENSIONS) {
      const column = columnFor[dimension];
      expect(column, `dimension '${dimension}' declares no target column`).toBeDefined();
      expect(columns, `dimension '${dimension}' names a column that does not exist`).toContain(
        column,
      );
    }
  });

  it('carries NO category dimension and NO category column — that table is taxonomy’s', () => {
    // ADR 0007 D2 assigns `category_external_mappings` to the taxonomy module and
    // the taxonomy workstream built it. Asserted rather than left to a code
    // review, because the tempting change is small and looks like completeness:
    // one tuple member and one column, and the result is two tables answering
    // "what does this source's category mean". Folding that dimension in is an
    // ADR amendment plus a move migration, and this test is what that change has
    // to come through.
    expect(CATALOG_EXTERNAL_MAPPING_DIMENSIONS).not.toContain('category');
    const columns = Object.keys(getTableColumns(catalogExternalMappingsTable()));
    expect(columns.filter((column) => /category/i.test(column))).toEqual([]);
  });
});

describe('confidence is never an authority, and a preview never writes', () => {
  it('the resolver does not read `confidence`', () => {
    const source = withoutComments(
      readDomainFile(join(SRC_ROOT, 'services/catalog-external-mappings', 'resolution.service.ts')),
    );
    expect(
      /confidence/i.test(source),
      'resolution.service.ts mentions confidence; there is no confidence at which a mapping ' +
        'applies without approval',
    ).toBe(false);
  });

  it('the preview imports no writer and issues no statement that could write', () => {
    const source = withoutComments(readDomainFile(join(SRC_ROOT, 'services/catalog-external-mappings', 'preview.service.ts')));
    for (const writer of [
      'insertExternalMapping',
      'upsertExternalMappingReview',
      'recordExternalTokenObservation',
      'openExternalMappingRun',
      'applyObservationResolution',
      'transitionExternalMapping',
    ]) {
      expect(source.includes(writer), `preview.service.ts imports the writer ${writer}`).toBe(false);
    }
    expect(/\.insert\(|\.update\(|\.delete\(/.test(source), 'preview.service.ts writes').toBe(
      false,
    );
    // And it must still be doing something: a file that imported nothing would
    // satisfy every assertion above.
    expect(source).toContain('previewCandidateMapping');
    expect(source).toContain('tallyTokenObservations');
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('each regex matches a seeded positive and rejects an ordinary line', () => {
    // Both spellings of each import, absolute and RELATIVE — the relative one is
    // what a sibling domain is actually reached by.
    expect(RANKING_REFERENCE.test("import { rankOffers } from '../ranking/rank.js';")).toBe(true);
    expect(RANKING_REFERENCE.test("from '../../services/ranking/policy.js'")).toBe(true);
    expect(RANKING_REFERENCE.test('const ordered = rows.sort();')).toBe(false);

    expect(FEE_REFERENCE.test("import { planFees } from '../fees/fee.service.js';")).toBe(true);
    expect(FEE_REFERENCE.test("from '../../services/fees/plan.js'")).toBe(true);
    expect(FEE_REFERENCE.test('const feed = source.feedUrl;')).toBe(false);

    expect(REFERRAL_REFERENCE.test("import { x } from '../referrals/attribution.js';")).toBe(true);
    expect(REFERRAL_REFERENCE.test("from '../../services/referral-pilot/gate.js'")).toBe(true);
    expect(REFERRAL_REFERENCE.test('const referenceKey = row.externalKey;')).toBe(false);

    expect(CANONICAL_WRITE_REFERENCE.test("from '../canonical/canonical-product.service.js'")).toBe(
      true,
    );
    expect(CANONICAL_WRITE_REFERENCE.test('const canonicalProductId = row.id;')).toBe(false);

    expect(MATCHER_REFERENCE.test('const decision = await runMatch(subject);')).toBe(true);
    expect(MATCHER_REFERENCE.test('const matched = targets.some(agree);')).toBe(false);

    expect(OFFER_WRITE_REFERENCE.test('await recordExternalOffer(row);')).toBe(true);
    expect(OFFER_WRITE_REFERENCE.test('const offerId = row.offerId;')).toBe(false);

    expect(REGISTRY_WRITE_REFERENCE.test('db.insert(attributeSourceMappings).values(x)')).toBe(true);
    expect(REGISTRY_WRITE_REFERENCE.test('db.select().from(attributeSourceMappings)')).toBe(false);

    const positives: Readonly<Record<string, string>> = {
      eval: 'const out = eval(rule.body);',
      'the Function constructor': 'const fn = new Function("v", rule.body);',
      'node:vm': "import vm from 'node:vm';",
      'a template engine': "import Handlebars from 'handlebars';",
      'a constructed RegExp': 'const re = new RegExp(row.pattern);',
      'a dynamic import': "const mod = await import(row.module);",
    };
    for (const { name, pattern } of CODE_EXECUTION) {
      const seeded = positives[name];
      expect(seeded, `no seeded positive for ${name}`).toBeDefined();
      expect(pattern.test(seeded ?? ''), `${name} detector matches nothing`).toBe(true);
      expect(pattern.test('const value = row.externalKey.trim();')).toBe(false);
    }
  });

  it('the comment stripper removes prose without removing code', () => {
    const stripped = withoutComments(
      [
        '/** #74 owns rankOffers */',
        "import { x } from './y.js'; // rankOffers",
        'const z = rankOffers(a);',
      ].join('\n'),
    );
    expect(stripped).not.toContain('#74');
    expect(stripped).toContain('const z = rankOffers(a);');
    // And it must not eat a URL's `//`, which is the classic over-strip.
    expect(withoutComments("const u = 'https://example.com/x';")).toContain('https://example.com/x');
  });

  it('the domain-file reader refuses an empty file', () => {
    // The vacuity floor's own control: if `readDomainFile` accepted a stub,
    // every scan above would pass on a domain somebody had emptied.
    expect(() => readDomainFile(join(SRC_ROOT, 'services/catalog-external-mappings', 'does-not-exist.ts'))).toThrow();
  });
});

describe('the population the nine walls above are applied to (#460)', () => {
  it('nothing naming this domain sits outside it', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: EXTERNAL_MAPPING_NAME_PATTERN,
      // Deliberately empty, and the assertion is what makes that a measurement:
      // all twelve modules the whole-tree sweep finds are this domain's.
      notThisDomain: [],
      expectedExclusions: 0,
      // Below today's 12 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 9,
      plantIn: 'lib',
      plantName: 'external-mapping-cache.ts',
    });
  });

  it('`db/schema/catalogExternalMappings.ts` — the one module outside every wall — is in it', () => {
    // An identity assertion, not a floor. It is 42 KB declaring every table,
    // CHECK and unique index the nine properties above are ABOUT, and a floor
    // set below 12 is met without it.
    const population = domainRelativePaths();
    const schema = 'db/schema/catalogExternalMappings.ts';
    expect(population, `${schema} is outside the walls again`).toContain(schema);
    expect(
      statSync(join(SRC_ROOT, schema)).isFile(),
      `${schema} no longer exists, so naming it proves nothing`,
    ).toBe(true);
  });

  it('floors PER SHAPE, because the two sources break independently', () => {
    // One total lets the walk collapse to zero while the sweep carries it.
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    const shared = namedInSharedDirectories(SHARED_DIRECTORIES, EXTERNAL_MAPPING_NAME_PATTERN);
    expect(owned.length, 'the owned-directory walk reached nothing').toBeGreaterThanOrEqual(9);
    expect(shared.length, 'the shared-directory name sweep reached nothing').toBeGreaterThanOrEqual(
      1,
    );
  });

  it('the optional hyphen is load-bearing', () => {
    // The camelCase spelling is the ONLY way the schema module enters, so the
    // widening is measured rather than assumed: the hyphen-only pattern must NOT
    // reach it.
    const camelCase = 'db/schema/catalogExternalMappings.ts';
    expect(EXTERNAL_MAPPING_NAME_PATTERN.test(camelCase)).toBe(true);
    expect(/external-mappings?/i.test(camelCase), 'the hyphenated spelling already matched').toBe(
      false,
    );
    expect(domainRelativePaths()).toContain(camelCase);
  });
});
