/**
 * The walls ADR 0007 D3 asks for, asserted STRUCTURALLY rather than promised.
 *
 * 1. **Nothing in navigation may write to `categories`** — nor to the
 *    collections, brands or families a node points at. A menu is an arrangement
 *    of the catalogue and never a second authority over what the catalogue
 *    MEANS, and this is the gate that makes it true of modules nobody has
 *    written yet. It is the wall D3 states in as many words.
 * 2. **Navigation cannot reach the ranking domain**, in either direction. What
 *    a menu points at is editorial and explicit; how RESULTS are ordered is
 *    #74's, behind its versioned policy. A homepage section one join from a
 *    weighted ordering is a sponsored-placement surface that nobody decided to
 *    build.
 * 3. **A node carries no presentation column at all.** Labels live in
 *    `navigation_node_localizations`, so "stable ids and keys PLUS localized
 *    presentation, never presentation alone" is a property of the schema.
 *    Walked from the REAL drizzle tables, not read out of the file.
 * 4. **A node carries no taxonomy-semantics column** — no slug, ancestry,
 *    lifecycle or selectability. A navigation row that could restate a
 *    category's meaning is the first half of one that disagrees with it.
 * 5. **The forbidden target kinds are a VOCABULARY**, disjoint from the seven
 *    permitted ones, so a refusal names the exact prohibition.
 * 6. **The trigger's depth bound is the same number `NAVIGATION_MAX_DEPTH` is.**
 *    A hand-written trigger cannot read a TypeScript constant, so the two agree
 *    because this test says so rather than because somebody remembered.
 *
 * Every scanner carries the house defences: a vacuity floor so a moved file
 * fails instead of silently shrinking the scan, comment stripping because these
 * modules DOCUMENT what they refuse to do in the detectors' own vocabulary, and
 * a mutation self-test so a rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import {
  NAVIGATION_FORBIDDEN_TARGET_KINDS,
  NAVIGATION_MAX_DEPTH,
  NAVIGATION_NODE_TARGET_KINDS,
} from '@mercaria/shared-types';
import {
  navigationNodeLocalizations,
  navigationNodes,
  navigationSavedQueries,
  navigationTrees,
} from '../../db/schema/navigation.js';

import {
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
  type DirectoryReader,
} from '../../__tests__/domain-population.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DRIZZLE_ROOT = join(SRC_ROOT, '..', 'drizzle');

/**
 * The migration carrying this domain's hand-written statements, found by
 * CONTENT.
 *
 * Never by file name: `db:generate` names a migration randomly, so a
 * regeneration renames it, and a test naming one would go green by reading a
 * file that no longer exists. Exactly one migration may carry these markers —
 * two would mean a regeneration left the old copy behind, which is the state
 * where half the triggers are applied twice and nobody notices.
 */
function navigationMigration(): string {
  const marker = '-- oxy:handwritten-begin=mercaria_navigation_';
  const matches = readdirSync(DRIZZLE_ROOT)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ name, source: readFileSync(join(DRIZZLE_ROOT, name), 'utf8') }))
    .filter((file) => file.source.includes(marker));
  expect(
    matches.map((file) => file.name),
    'exactly one migration carries the navigation trigger blocks',
  ).toHaveLength(1);
  return matches[0].source;
}

/** Anything whose PATH names this domain. */
const DOMAIN_NAMED = /navigation/i;

const OWNED_DIRECTORIES = ['services/navigation', 'db/navigation'] as const;
const SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'] as const;

/**
 * Every module of the navigation domain, DERIVED as a function of its reader
 * (#460).
 *
 * This replaces four HAND-NAMED single files under a comment saying the route
 * files "are exactly where a publish-this-category endpoint would be added, so
 * leaving either out would exempt the most likely place". The reasoning was
 * right and the list was still one short: `db/schema/navigation.ts` — where such
 * an endpoint's COLUMN would be declared — was named nowhere and sat behind
 * every wall in this file. 11 modules of 12.
 */
function navigationPopulation(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...OWNED_DIRECTORIES.flatMap((directory) => walkOwnedDirectory(directory, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, DOMAIN_NAMED, readDir),
  ];
}

/** Every module of the navigation domain, with its source. */
function domainSources(): { relative: string; source: string }[] {
  return navigationPopulation().map((relative) => ({
    relative,
    source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
  }));
}

/**
 * Strip comments before a reachability scan.
 *
 * These modules explain what they refuse to do using the same words the
 * detectors look for — the schema's docblock names `categories` and the word
 * "write" in one sentence — so scanning raw source would make every wall fire on
 * its own explanation, and the fix somebody reaches for is to delete the
 * explanation.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * A WRITE against a table this domain may only read.
 *
 * Deliberately not a mention of the table: `navigationRepository.ts` selects
 * from `categories`, `collections`, `brands` and `canonical_product_families` on
 * every request, and a detector that fired on those is one whoever hit it next
 * would disable. What it looks for is the drizzle write verbs against one of
 * them, and an import of a write service or a category writer by name.
 */
const FOREIGN_WRITE_REFERENCE =
  /\.(insert|update|delete)\s*\(\s*(categories|collections|collectionRules|listingCollections|brands|canonicalProductFamilies|canonicalProducts|listings)\b|from\s+'[^']*(catalog-write\.service|categoryRepository|collection\.service|canonical-write)[^']*'|\b(insertCategory|updateCategory|deleteCategory|upsertCategory|materializeCollection|syncListingFacets)\s*\(/;

/** Reaching the ranking domain, from any direction. */
const RANKING_REFERENCE =
  /from\s+'[^']*(services\/ranking|offer-ranking|ranking\/)[^']*'|\b(rankOffers|rankOfferComparison|evaluateOfferEligibility|resolveRankingPolicy)\s*\(/;

/**
 * A ranking INPUT wearing a navigation name.
 *
 * `position` is fine and is what this domain orders by — an explicit editorial
 * sequence somebody typed. A weight, a score, a boost or a sponsored slot is a
 * different thing: it is an ordering somebody would tune, and tuning it here
 * would put a second, unversioned ranking authority behind the menu editor.
 */
const RANKING_INPUT_REFERENCE =
  /\b(rankingWeight|scoreWeight|boostBps|boostFactor|sponsoredSlot|sponsoredRank|paidPlacement|promotedWeight)\b/;

describe('#460 — the population is closed against the tree', () => {
  it('no navigation-named module anywhere in src/ sits outside the population', () => {
    // #460's whole-tree assertion, through the shared derivation so the positive
    // control re-derives THIS population against the seeded reader.
    //
    // The four hand-named single files this replaces carried a comment arguing
    // that the route files are "exactly where a publish-this-category endpoint
    // would be added, so leaving either out would exempt the most likely place".
    // That reasoning was right and the list was still one short:
    // `db/schema/navigation.ts` — where such an endpoint's COLUMN would be
    // declared — was named nowhere. 11 of 12.
    assertNothingOutsideDomainPopulation({
      population: navigationPopulation,
      pattern: DOMAIN_NAMED,
      // Measured empty: every navigation-named module in the tree is a module of
      // this domain. One owned by somebody else goes here WITH its reason.
      notThisDomain: [],
      sweepFloor: 10,
      plantIn: 'lib',
      plantName: 'navigation-cache.ts',
    });
  });
});

describe('the navigation domain has no reach it should not have', () => {
  const domain = domainSources();

  it('is not vacuous: the domain has real modules and they are not empty', () => {
    // The floor catches a renamed directory, which would otherwise make every
    // scan below pass against an empty list.
    expect(domain.length).toBeGreaterThanOrEqual(11);
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('WALL 1: no module writes a category, collection, brand, family or listing', () => {
    for (const file of domain) {
      expect(
        FOREIGN_WRITE_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} writes a table navigation may only read; a menu is an arrangement of ` +
          'the catalogue and never a second authority over it (ADR 0007 D3)',
      ).toBe(false);
    }
  });

  it('WALL 2: no module reaches the ranking domain', () => {
    for (const file of domain) {
      expect(
        RANKING_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches #74's ranking domain; what a menu points at is editorial and ` +
          'how results are ordered is a versioned policy, and joining the two makes a ' +
          'sponsored-placement surface nobody decided to build',
      ).toBe(false);
    }
  });

  it('WALL 2b: no module names a ranking input', () => {
    for (const file of domain) {
      expect(
        RANKING_INPUT_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} names a weight, boost or sponsored slot; ordering here is \`position\`, ` +
          'an editorial sequence somebody typed',
      ).toBe(false);
    }
  });

  it('WALL 3: a node row carries no presentation column at all', () => {
    // Walked from the REAL drizzle table, so a column added in a migration and
    // mirrored into the schema fails here rather than being described away.
    const columns = Object.keys(getTableColumns(navigationNodes));
    for (const forbidden of ['label', 'name', 'title', 'description', 'accessibilityLabel']) {
      expect(columns, `navigation_nodes must not carry ${forbidden}`).not.toContain(forbidden);
    }
    // …and the positive control: the identity it DOES carry is present, so a
    // renamed table cannot pass this by having no columns to check.
    expect(columns).toContain('key');
    expect(columns).toContain('targetKind');
    expect(columns.length).toBeGreaterThanOrEqual(15);

    // The other half of the same fact: presentation exists, one table over.
    const labels = Object.keys(getTableColumns(navigationNodeLocalizations));
    expect(labels).toContain('label');
    expect(labels).toContain('locale');
    expect(labels).toContain('status');
    expect(labels).toContain('provenance');
  });

  it('WALL 4: no navigation table restates a category or a collection', () => {
    for (const [name, table] of [
      ['navigation_nodes', navigationNodes],
      ['navigation_trees', navigationTrees],
      ['navigation_saved_queries', navigationSavedQueries],
    ] as const) {
      const columns = Object.keys(getTableColumns(table));
      for (const forbidden of [
        'categorySlug',
        'categoryName',
        'ancestorIds',
        'ancestorSlugs',
        'selectable',
        'isActive',
        'collectionHandle',
        'collectionTitle',
        'productIds',
        'listingIds',
      ]) {
        expect(columns, `${name} must not carry ${forbidden}`).not.toContain(forbidden);
      }
    }
    // The pointers themselves ARE present — the wall is about SEMANTICS being
    // restated, not about a node being unable to point at anything.
    const nodeColumns = Object.keys(getTableColumns(navigationNodes));
    expect(nodeColumns).toContain('categoryId');
    expect(nodeColumns).toContain('collectionId');
  });

  it('WALL 5: the forbidden target kinds are disjoint from the permitted ones', () => {
    const permitted = new Set<string>(NAVIGATION_NODE_TARGET_KINDS);
    for (const forbidden of NAVIGATION_FORBIDDEN_TARGET_KINDS) {
      expect(permitted.has(forbidden), `${forbidden} is both permitted and forbidden`).toBe(false);
    }
    // The prohibition list is not decoration: it has to name the two somebody
    // would reach for first — a paid slot, and writing the taxonomy.
    expect(NAVIGATION_FORBIDDEN_TARGET_KINDS).toContain('sponsored_placement');
    expect(NAVIGATION_FORBIDDEN_TARGET_KINDS).toContain('category_write');
    expect(NAVIGATION_FORBIDDEN_TARGET_KINDS.length).toBeGreaterThanOrEqual(6);
    // …and the permitted set is exactly ADR 0007 D3's seven.
    expect(NAVIGATION_NODE_TARGET_KINDS.length).toBe(7);
  });

  it('WALL 6: the cycle trigger bounds depth at the number the constant does', () => {
    // A hand-written trigger cannot read a TypeScript constant. Two
    // representations of one fact can disagree, so this is what makes them
    // agree — the assertion is BUILT from the constant rather than repeating it.
    const pending = navigationMigration();
    expect(pending).toContain(`hops >= ${NAVIGATION_MAX_DEPTH}`);
    expect(pending).toContain(
      `hops + coalesce(subtree_height, 0) >= ${NAVIGATION_MAX_DEPTH}`,
    );
    expect(pending).toContain(`deeper than ${NAVIGATION_MAX_DEPTH} levels`);
    // The positive control: the file really does hold the trigger this asserts
    // about, so a renamed or emptied file fails rather than matching nothing.
    expect(pending).toContain('CREATE TRIGGER mercaria_navigation_node_acyclic');
    expect(pending).toContain('CREATE TRIGGER mercaria_navigation_tree_window_exclusion');
    expect(pending).toContain('CREATE TRIGGER mercaria_navigation_published_nodes_frozen');
    expect(pending).toContain('CREATE TRIGGER mercaria_navigation_localization_review_protected');
  });

  it('WALL 6b: every hand-written statement is wrapped in a marker pair', () => {
    // The paste source, checked on every run so it cannot rot while it waits
    // for a migration slot. `migration-handwritten-markers.test.ts` checks the
    // GENERATED migration; this checks the file those statements are pasted
    // from, which is where they live for as long as the slot queue is.
    //
    // drizzle-kit cannot model a trigger or a function, so a regeneration drops
    // every one of them — the markers are what makes that loss visible instead
    // of silent, and an UNWRAPPED statement is the one nobody notices is gone.
    const pending = navigationMigration();
    const stack: string[] = [];
    const seen = new Set<string>();
    const uncovered: string[] = [];

    for (const line of pending.split('\n')) {
      const begin = /^-- oxy:handwritten-begin=(\S+)$/.exec(line);
      const end = /^-- oxy:handwritten-end=(\S+)$/.exec(line);
      if (begin !== null) {
        const name = begin[1];
        expect(seen.has(name), `marker name reused within the file: ${name}`).toBe(false);
        seen.add(name);
        stack.push(name);
        continue;
      }
      if (end !== null) {
        // An orphan end and a mismatched pair are the two failures a `grep -c`
        // of each marker cannot tell apart from a correct file.
        expect(stack.length, `orphan end marker: ${end[1]}`).toBeGreaterThan(0);
        expect(stack.pop()).toBe(end[1]);
        continue;
      }
      // `CREATE CONSTRAINT TRIGGER` is a real form in this schema and the
      // obvious matcher misses it, so it is named explicitly.
      if (/^\s*CREATE (OR REPLACE )?(FUNCTION|TRIGGER|CONSTRAINT TRIGGER)\b/i.test(line)) {
        if (stack.length === 0) uncovered.push(line.trim().slice(0, 80));
      }
    }

    expect(stack, 'unclosed marker blocks').toEqual([]);
    expect(uncovered, 'these statements are outside any marker pair').toEqual([]);
    // The vacuity floor: a file whose markers were all deleted would satisfy
    // every assertion above by having nothing to check.
    expect(seen.size).toBe(9);
    expect(seen.has('mercaria_navigation_node_acyclic')).toBe(true);
  });

  it('WALL 6b2: nothing in the pending SQL quotes the breakpoint token in PROSE', () => {
    // `migrator.js` splits the file on this literal string BEFORE anything
    // parses a comment, so a header explaining the convention cuts ITSELF in
    // half — the tail of the sentence becomes the head of the next chunk and
    // applies as bare text. Measured on this file: quoting it once took the
    // chunk count from 18 to 19.
    //
    // The token is assembled here rather than written out, because a test file
    // is not split by the migrator but a future reader copying this line into
    // the SQL would be. The check is the one that distinguishes a separator
    // from a mention: a real separator ENDS its line.
    const token = `-->${' '}statement-breakpoint`;
    const pending = navigationMigration();
    const lines = pending.split('\n');
    const separators = lines.filter((line) => line.trimEnd().endsWith(token)).length;
    const chunks = pending.split(token).length;

    const offenders = lines
      .map((line, index) => ({ line, number: index + 1 }))
      .filter((entry) => entry.line.includes(token) && !entry.line.trimEnd().endsWith(token))
      .map((entry) => `line ${entry.number}: ${entry.line.trim().slice(0, 80)}`);

    expect(offenders, 'these lines quote the breakpoint token mid-line').toEqual([]);
    expect(chunks, 'the migrator would see more chunks than there are separators').toBe(
      separators + 1,
    );
    // The vacuity floor: a file with no separators at all would satisfy the
    // equality trivially, and is its own bug — nine blocks in one chunk.
    expect(separators).toBeGreaterThanOrEqual(17);
  });

  it('WALL 6c: the pending SQL declares exactly one deploy phase, and it is `pre`', () => {
    // Exactly one, and `pre`: every statement is additive, and a file with two
    // markers or none is one the deploy phase cannot be read off at all.
    const phases = navigationMigration().match(/^-- oxy:deploy-phase=(pre|post)$/gm) ?? [];
    expect(phases).toEqual(['-- oxy:deploy-phase=pre']);
  });
});

/**
 * The mutation self-test.
 *
 * Every detector above is only worth having if it FIRES. A regex that has rotted
 * — a renamed module, a changed call shape — passes silently against every file,
 * which is the shape `~/Oxy/AGENTS.md` calls a check that cannot distinguish
 * success from failure. So each is run against a source that genuinely contains
 * what it forbids, AND against the reads this domain legitimately performs.
 */
describe('the detectors themselves', () => {
  it('WALL 1 fires on a category write and not on a category read', () => {
    expect(FOREIGN_WRITE_REFERENCE.test('await db.insert(categories).values(row);')).toBe(true);
    expect(FOREIGN_WRITE_REFERENCE.test('await db.update(collections).set({ isPublished: true });')).toBe(
      true,
    );
    expect(FOREIGN_WRITE_REFERENCE.test("import { insertCategory } from '../catalog/categoryRepository.js';")).toBe(
      true,
    );
    expect(FOREIGN_WRITE_REFERENCE.test('await syncListingFacets(db, listingId);')).toBe(true);
    // The measured false positives: this domain READS all four tables on every
    // request, and a detector that fired on those would be turned off.
    expect(FOREIGN_WRITE_REFERENCE.test('.from(categories)')).toBe(false);
    expect(
      FOREIGN_WRITE_REFERENCE.test('.select({ id: categories.id, identifier: categories.slug })'),
    ).toBe(false);
    expect(FOREIGN_WRITE_REFERENCE.test('const map = context.categories.get(id);')).toBe(false);
    // …and its OWN writes are not foreign writes.
    expect(FOREIGN_WRITE_REFERENCE.test('await db.insert(navigationNodes).values(values);')).toBe(
      false,
    );
  });

  it('WALL 2 fires on a ranking import and a ranking call', () => {
    expect(RANKING_REFERENCE.test("import { rankOffers } from '../ranking/rank.js';")).toBe(true);
    expect(RANKING_REFERENCE.test("import { x } from '../../services/ranking/facts.js';")).toBe(true);
    expect(RANKING_REFERENCE.test('const ordered = rankOfferComparison(candidates);')).toBe(true);
    expect(RANKING_REFERENCE.test('const position = node.position;')).toBe(false);
  });

  it('WALL 2b fires on a weight and not on a position', () => {
    expect(RANKING_INPUT_REFERENCE.test('const rankingWeight = 0.4;')).toBe(true);
    expect(RANKING_INPUT_REFERENCE.test('node.sponsoredSlot = true;')).toBe(true);
    expect(RANKING_INPUT_REFERENCE.test('siblings.sort((a, b) => a.position - b.position);')).toBe(
      false,
    );
  });

  it('the comment stripper removes a line comment and a block comment', () => {
    // Without it, WALL 1 fires on the schema docblock that explains WALL 1.
    expect(withoutComments('// db.insert(categories)\nconst a = 1;')).not.toContain(
      'insert(categories)',
    );
    expect(withoutComments('/* insertCategory( */\nconst a = 1;')).not.toContain('insertCategory(');
    // …and does NOT eat a URL inside a string, which would be a stripper that
    // silently blanks half the file it hands to a detector.
    expect(withoutComments("const u = 'https://example.test/x';")).toContain('example.test');
  });
});

/**
 * ADR 0007 D12: `CATALOG_TAXONOMY_V2_ENABLED` gates the MOUNT and never a stored row.
 *
 * BLANKET — no configuration anywhere in the population, including the four flat
 * members `domainSources()` adds, because none of them reads any today. That is
 * unusual for a population containing a controller and two routes, and it is why
 * the wall can be this strong here: the lever is read in `app.ts` and nowhere
 * else, and `routes/internal-navigation.ts` is deliberately NOT gated on it, so an
 * operator can still preview a tree during the incident that switched the public
 * surface off.
 *
 * What it prevents: a repository or a projection that read the flag could refuse
 * to return a published tree, node or label that already exists — and a rollback
 * that deleted a merchandiser's work is not one anybody would pull. It also stops
 * the subtler version, a read path that answers differently depending on a flag
 * whose whole contract is that it only decides whether the ROUTE exists.
 *
 * If a page bound or a cache TTL ever legitimately belongs in this domain, narrow
 * this to `config.catalog.taxonomyV2Enabled` — the shape
 * `catalog-proposal-isolation.test.ts` uses for exactly that reason — rather than
 * deleting the wall.
 */
const NAVIGATION_LEVER_PATTERN =
  /from\s+['"][^'"]*\/config(?:\/[^'"]*)?['"]|process\s*\.\s*env\b/u;

describe('the rollout lever gates the MOUNT and never a stored tree', () => {
  it('no module in the navigation population reaches configuration', () => {
    const sources = domainSources();
    // The vacuity floor. A population of zero passes this wall and reads exactly
    // like a clean one.
    expect(sources.length, 'the navigation scan found too few files').toBeGreaterThanOrEqual(9);
    const offenders = sources
      .filter((file) => NAVIGATION_LEVER_PATTERN.test(withoutComments(file.source)))
      .map((file) => file.relative);
    expect(offenders).toEqual([]);
  });

  it('POSITIVE CONTROL: the population really includes the routes and the controller', () => {
    // The wall above is only interesting because it covers the HTTP members —
    // which is where a lever read would most plausibly appear. Without this, a
    // `domainSources()` narrowed to the two service directories would satisfy it
    // while exempting the three files most likely to offend.
    const relatives = domainSources().map((file) => file.relative);
    for (const expected of [
      'routes/navigation.ts',
      'routes/internal-navigation.ts',
      'controllers/navigation.controller.ts',
    ]) {
      expect(relatives, `${expected} is outside the scanned population`).toContain(expected);
    }
  });

  it('MUTATION SELF-TEST: the REAL scan names EXACTLY the mutated member', () => {
    const sources = domainSources();
    // The victim is the CONTROLLER rather than the first file found: it is the
    // member a lever read would really be written into, and picking it means this
    // self-test also proves the flat members are inside the scan.
    const victim = sources.find((file) => file.relative === 'controllers/navigation.controller.ts');
    expect(victim, 'the controller is not in the population').toBeDefined();
    if (victim === undefined) return;
    const mutated = `${victim.source}\nif (config.catalog.taxonomyV2Enabled) { /* x */ }\nimport { config } from '../config/index.js';\n`;
    expect(mutated).not.toBe(victim.source);
    const offenders = sources
      .map((file) => (file.relative === victim.relative ? { ...file, source: mutated } : file))
      .filter((file) => NAVIGATION_LEVER_PATTERN.test(withoutComments(file.source)))
      .map((file) => file.relative);
    expect(offenders).toEqual([victim.relative]);
  });
});
