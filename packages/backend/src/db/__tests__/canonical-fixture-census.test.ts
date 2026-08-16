/**
 * Two rules about canonical fixtures, both consequences of ONE fact: the
 * matcher's candidate retrieval is global.
 *
 * `services/matching/postgres-candidate-source.ts` searches EVERY
 * `canonical_products` row — an exact `normalized_name` lookup, an alias
 * lookup, and a trigram scan — which is correct for production and makes every
 * file's canonical fixtures visible to every other file's matcher on the one
 * throwaway database a suite run shares. Two things follow, and neither is a
 * bug in any single file:
 *
 * 1. **A sibling can make a file's own rows undeletable.** A file driving the
 *    matcher records a `match_decisions` row citing another file's fixture, and
 *    `matched_canonical_product_id` / `matched_canonical_variant_id` are both
 *    `ON DELETE RESTRICT`. The owner's correctly-scoped teardown then fails with
 *    `23503` and the whole FILE fails — measured once in four full baseline runs
 *    on `85d6697`. `canonical-teardown.ts` is the answer; this is what makes
 *    every fixture reach it.
 * 2. **A fixture with a STABLE name is a standing attractor.** A literal
 *    `normalized_name` is the same string in every run, so every later sibling's
 *    retrieval finds it and can match against it — a fixture from one domain
 *    silently shaping another domain's matcher outcomes, deterministically,
 *    forever. Per-run naming makes it an ordinary row.
 *
 * ## Why a census and not careful files
 *
 * Which files collide changes on every run: vitest orders files by SIZE, so any
 * added line anywhere reshuffles them. The property therefore has to hold for
 * files nobody has written yet, which rules out a hand-maintained list — a gate
 * that skips what is missing from its own map is not a gate. #270 measured the
 * cost of the alternative: the helper existed and TWO files of twenty-five used
 * it.
 *
 * ## A file-level permission is not enough, so there is a SECOND, parsed rule
 *
 * "Which files may issue a bare canonical delete" is the coarsest thing a source
 * scan can express, and it is coarser than the property: the three fixtures on
 * the list below are permitted one because a bare delete IS the subject of an
 * assertion, and the same permission would silently cover a careless one in
 * their own `afterAll` — which is the exact cross-file pin the helper exists to
 * survive. `canonical-teardown.realdb.test.ts` was that file until #279.
 *
 * So a second rule PARSES every scanned source with the TypeScript compiler,
 * finds each `.delete(canonicalProducts|canonicalVariants)` call, and asks
 * whether any enclosing call is a lifecycle hook. A delete inside `afterAll`
 * fails the build wherever it appears; a delete inside an `it` does not. A regex
 * cannot make that distinction at all — the two spellings are the same
 * characters — which is why this one reads the syntax tree instead.
 *
 * ## Two things this deliberately does not do
 *
 * The REGEX rule does NOT strip comments. The failure direction of scanning raw
 * source is a false POSITIVE — a comment quoting a delete fails the build loudly
 * and is corrected in one line — while comment stripping truncates at a `//`
 * inside a string literal and can hide a real statement, which is the direction
 * that costs something. The probes below are assembled from table names so this
 * file cannot become the offender it is looking for. (The parsed rule is
 * comment-blind by construction, which makes the two an independent pair rather
 * than the same reading twice: a disagreement between them is itself a finding.)
 *
 * It scans TEST sources only. Production code deletes no canonical row on this
 * path at all; a merge RE-HOMES them (`services/curation/`), which is a
 * different operation with its own census (`merge-plan-census.test.ts`).
 *
 * ## The spellings it does not match, measured as absent rather than assumed
 *
 * Both detectors read a drizzle table SYMBOL in a statement builder, so four
 * shapes would slip past: a raw `sql` delete or a `truncate`, an aliased import
 * (`import { canonicalProducts as products }`), a namespace-qualified access
 * (`schema.canonicalProducts`), and — for the name rule — a quoted key or a
 * literal bound to a variable first. Grepped at this revision: nobody spells any
 * of them, and no repository or service exports a canonical delete at all, so
 * the delete surface really is these test files. That is a latent gap, not a
 * live one, and it is written down because a reader who assumes the regex is
 * exhaustive will eventually add the fifth shape.
 */

import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import { canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A direct deletion of either canonical table, newline-tolerant.
 *
 * `\s*` throughout because the house spelling puts the call and its `where` on
 * separate lines wherever the statement runs long, and a line-based scan reads
 * that as clean — `awin-writes`, `adapter-contract-suite`, `sell-yours` and
 * `catalog-pages` all spelled it that way before #270.
 */
const DIRECT_CANONICAL_DELETE = /\.\s*delete\s*\(\s*canonical(Products|Variants)\s*\)/u;

/**
 * Creating a canonical product — what puts a file in scope for the NAME rule.
 *
 * BOTH spellings, because a fixture built through the service is exactly as
 * visible to the matcher as one built with a direct insert, and the direct
 * spelling alone missed one:
 * `services/procurement/__tests__/procurement-offer.service.realdb.test.ts`
 * creates its product with `createCanonicalProduct(...)` and deletes nothing,
 * so it was invisible to the delete rule AND to this one.
 */
const CREATES_CANONICAL_PRODUCT =
  /\.\s*insert\s*\(\s*canonicalProducts\s*\)|createCanonicalProduct\s*\(/u;

/**
 * A `normalizedName` set to a plain string literal.
 *
 * `normalized_name` is what `retrieveByNormalizedName` looks up exactly and what
 * the trigram index is built over, so it is the column that decides whether a
 * fixture is findable by a sibling. A template literal is accepted because that
 * is how a per-run token is spelled; the rule is not "no literal anywhere", it
 * is "this value must be able to differ between runs".
 *
 * ## What it cannot see, said out loud
 *
 * It reads the `normalizedName` a fixture WRITES. A literal `name:` handed to
 * `createCanonicalProduct` is normalized by the service, so the stable value
 * reaches the column without this pattern ever seeing it —
 * `canonical-catalog.realdb.test.ts:1087` is the one instance, and it is
 * acceptable there for a different reason: that file deletes its fixtures, so
 * the row exists only while it runs rather than standing in every later
 * sibling's retrieval. The rule that would close this properly is "a fixture
 * that is never deleted must not carry a stable name", which needs the two
 * halves joined; this is the checkable approximation, and the gap is named
 * rather than left to be discovered.
 */
const LITERAL_NORMALIZED_NAME = new RegExp(`${'normalized'}${'Name'}\\s*:\\s*['"]`, 'u');

/**
 * The files allowed to issue a canonical delete directly, relative to `src/`, in
 * sorted order, each with the reason a reader can check.
 *
 * Named rather than pattern-matched: an exact array cannot be widened by
 * accident, where a prefix or a directory rule could quietly cover a fifth file
 * nobody looked at. The list is pinned to an exact size below, and the two
 * fixtures on it must ALSO route their teardown through the helper — a
 * file-level permission is the coarsest thing a source scan can express, and
 * without that second assertion a permitted file's teardown could regress back
 * to a raw delete inside the same permission.
 */
const PERMITTED: readonly { readonly file: string; readonly reason: string }[] = [
  {
    file: 'db/__tests__/canonical-catalog.realdb.test.ts',
    reason:
      'Asserts the RESTRICT itself: a variant a bundle names as a component cannot be deleted out ' +
      'from under it, so the bare statement inside `expect(...).rejects` IS the subject. Its ' +
      'teardown goes through the helper.',
  },
  {
    file: 'db/__tests__/canonical-teardown.realdb.test.ts',
    reason:
      "#270's own gate. It constructs a citing decision and issues the bare delete to prove the " +
      'foreign key refuses it — that statement is what the file is about, and it sits inside the ' +
      'assertion rather than in a hook. Its own teardown goes through the helper, since #279.',
  },
  {
    file: 'db/__tests__/canonical-teardown.ts',
    reason:
      'The helper. It is the statement every fixture now goes through, and the only place in the ' +
      'test estate that may issue a bare canonical delete without asserting something about it.',
  },
  {
    file: 'db/__tests__/watchlists.realdb.test.ts',
    reason:
      'Asserts the RESTRICT itself: a variant a watchlist item names as its preferred one cannot ' +
      'be deleted, so the bare statement inside `expect(...).rejects` IS the subject. Its teardown ' +
      'goes through the helper.',
  },
  {
    file: 'services/compatibility/__tests__/compatibility.realdb.test.ts',
    reason:
      'Asserts the RESTRICT itself (#367 step 8): a canonical product an `automotive_fitments` ' +
      'row names cannot be deleted out from under it, so the bare statement inside ' +
      '`expectRefusal(...)` IS the subject — it is the evidence for the "nothing is orphaned" ' +
      'claim its merge-plan entries make. Its teardown goes through the helper, and it was ' +
      'routed there BY this census: the fixture originally deleted canonical rows directly in ' +
      "`afterAll`, which is exactly the cross-file 23503 the helper exists for.",
  },
];

/**
 * The permitted FIXTURES — everything on the list but the helper itself.
 *
 * `canonical-teardown.realdb.test.ts` joined them in #279. It was left off
 * deliberately when the list was written, on the reading that a file gating the
 * teardown is not a fixture — and it owns canonical rows like any other, so its
 * own `afterAll` was a victim of exactly the cross-file pin it exists to
 * reproduce.
 */
const PERMITTED_FIXTURES = [
  'db/__tests__/canonical-catalog.realdb.test.ts',
  'db/__tests__/canonical-teardown.realdb.test.ts',
  'db/__tests__/watchlists.realdb.test.ts',
  'services/compatibility/__tests__/compatibility.realdb.test.ts',
];

/**
 * The calls a delete must not be nested inside.
 *
 * Setup hooks as well as teardown ones: a `beforeAll` that clears leftovers is
 * the same unguarded statement wearing a different name, and it runs while every
 * other file is at its busiest.
 */
const LIFECYCLE_HOOKS = ['afterAll', 'afterEach', 'beforeAll', 'beforeEach'];

/**
 * One parsed call this census cares about, and the hook it sits in if any.
 *
 * BOTH kinds come out of one walk, because the two questions are the same
 * question asked in opposite directions: which canonical deletes run from a
 * teardown (none may) and which teardowns reach the helper (every permitted
 * fixture's must). Answering the second by searching the file for the helper's
 * NAME is what a substring can do and it is not enough — measured: removing the
 * call from `canonical-teardown.realdb.test.ts`'s `afterAll` left the census
 * green, because the file's own test bodies still name it a dozen times.
 */
interface CanonicalCallSite {
  readonly file: string;
  readonly line: number;
  readonly hook: string | null;
  readonly kind: 'bare_delete' | 'helper_call';
}

/**
 * Every direct canonical delete and every teardown-helper call in one source,
 * read from the SYNTAX TREE.
 *
 * The enclosing hook is carried down the walk rather than looked up afterwards,
 * so a call nested in a callback inside a hook — a `map`, a `Promise.all`, a
 * local function — is still attributed to the hook that will run it.
 */
function canonicalCallSites(file: string, source: string): CanonicalCallSite[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: CanonicalCallSite[] = [];

  const isCanonicalDelete = (node: ts.Node): boolean => {
    if (!ts.isCallExpression(node)) return false;
    if (!ts.isPropertyAccessExpression(node.expression)) return false;
    if (node.expression.name.text !== 'delete') return false;
    const [argument] = node.arguments;
    if (argument === undefined || !ts.isIdentifier(argument)) return false;
    return argument.text === 'canonicalProducts' || argument.text === 'canonicalVariants';
  };

  const isHelperCall = (node: ts.Node): boolean =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'deleteTestCanonicalRows';

  const walk = (node: ts.Node, hook: string | null): void => {
    let inside = hook;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      LIFECYCLE_HOOKS.includes(node.expression.text)
    ) {
      inside = node.expression.text;
    }
    const kind = isCanonicalDelete(node)
      ? 'bare_delete'
      : isHelperCall(node)
        ? 'helper_call'
        : null;
    if (kind !== null) {
      sites.push({
        file,
        line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        hook: inside,
        kind,
      });
    }
    ts.forEachChild(node, (child) => {
      walk(child, inside);
    });
  };

  walk(parsed, null);
  return sites;
}

const TEARDOWN_HELPER = 'db/__tests__/canonical-teardown.ts';
const THIS_CENSUS = 'db/__tests__/canonical-fixture-census.test.ts';

/**
 * Floor on the fixtures routed through the helper.
 *
 * Twenty-four call it today. Eighteen is far enough below to absorb a file that
 * legitimately stops owning canonical rows and far enough above zero to catch a
 * walk that stopped reading. It retires when canonical-owning fixtures do; a
 * commit lowering it must name the file that stopped creating them and why.
 */
const CALLER_FLOOR = 18;

/**
 * Every `.ts` a test run loads: anything under a `__tests__` directory — which
 * catches the shared suites that are not named `*.test.ts`, the shape
 * `adapter-contract-suite.ts` established and one of the callers — plus any
 * `*.test.ts` elsewhere.
 */
function testSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...testSources(path));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    const underTests = relative(SRC_ROOT, path).split(sep).includes('__tests__');
    if (underTests || entry.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** `{relative path → source}` for every scanned file. */
function scannedSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const path of testSources(SRC_ROOT)) {
    sources.set(relative(SRC_ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8'));
  }
  return sources;
}

/**
 * The RESTRICT edges that run BETWEEN the two canonical tables.
 *
 * `deleteTestCanonicalRows` partitions exactly two tables, so the only edges that
 * can make one of a file's own rows refuse the delete of ANOTHER of its own
 * rows are the ones whose source AND target are both canonical. There are three
 * and each has a rule in the planner: the parent link, and the two
 * self-referencing merge pointers a retained tombstone pins.
 *
 * Pinned as an exact set on `merge-plan-census.test.ts`'s precedent. A fourth
 * such edge is then not a schema change anybody can make quietly — it fails here
 * until the planner is taught what to do with it, which is the point, because
 * finding fewer edges by reading looks identical to there BEING fewer. Every
 * other RESTRICT foreign key aimed at a canonical table comes from a table this
 * helper does not partition, so it is the CALLER's children-first obligation and
 * a different failure class.
 *
 * One table elsewhere has the same loser/winner SHAPE and is out of reach here:
 * `catalog_merge_conflicts.loser_variant_id` / `.winner_variant_id`, two RESTRICT
 * references to different variants from one row. It is safe today because both
 * files that write it delete their conflict rows unconditionally by job id
 * before calling the helper. A caller that ever scoped that cleanup by
 * DELETABLE ids would reproduce this class outside any canonical partition.
 */
const CANONICAL_INTERNAL_RESTRICT_EDGES = [
  'canonical_products.merged_into_id',
  'canonical_variants.merged_into_id',
  'canonical_variants.product_id',
];

describe('the canonical fixture census', () => {
  const sources = scannedSources();

  it('walked a plausible test estate', () => {
    // The vacuity floor. A broken walk, a moved directory or an extension
    // filter that stopped matching all report the same clean zero as a correct
    // scan, and every assertion below would pass on each of them.
    expect(sources.size, 'the walk read almost nothing — did the layout move?').toBeGreaterThan(300);
    // Both exclusions have to NAME a file the walk actually read. A stale path —
    // a rename, a moved directory — excludes nothing and reads exactly like a
    // correct run, leaving the floor one file easier to clear than it looks.
    expect(sources.has(TEARDOWN_HELPER), 'the helper path is stale').toBe(true);
    expect(sources.has(THIS_CENSUS), 'this census path is stale').toBe(true);
  });

  it('finds ONLY the helper and the two RESTRICT proofs deleting canonical rows', () => {
    const offenders = [...sources]
      .filter(([, source]) => DIRECT_CANONICAL_DELETE.test(source))
      .map(([path]) => path)
      .sort();

    // Exact identity, never containment: an allow-list that may grow is the gate
    // switching itself off one defensible entry at a time. This assertion is
    // also its own positive control — it can only pass by having FOUND the four
    // real deletions in the tree, so a scan that read nothing, or a regex that
    // matched nothing, fails here rather than reporting a tidy zero.
    expect(
      offenders,
      'a fixture deletes canonical rows directly; route it through deleteTestCanonicalRows, so a match decision another file recorded against your fixture cannot fail your teardown with 23503',
    ).toEqual(PERMITTED.map((entry) => entry.file));
  });

  it('pins the permission list, and every permission states why', () => {
    // A list that only grows is the gate switching itself off. Four files are
    // permitted today; adding a fifth is a decision somebody makes on purpose.
    expect(PERMITTED).toHaveLength(5);
    for (const entry of PERMITTED) {
      expect(entry.reason.length, entry.file).toBeGreaterThan(80);
    }

    // The permission is per FILE, which is the coarsest thing a source scan can
    // express: a fixture allowed a deliberate bare delete is thereby allowed a
    // careless one in its teardown. So every permitted fixture must still route
    // its teardown through the helper — that, plus the parsed hook rule below,
    // is what keeps the permission narrow.
    expect(PERMITTED_FIXTURES).toHaveLength(4);
    for (const file of PERMITTED_FIXTURES) {
      expect(PERMITTED.map((entry) => entry.file)).toContain(file);
      expect(
        sources.get(file) ?? '',
        `${file} is permitted a bare canonical delete but no longer routes its teardown through the helper`,
      ).toContain('deleteTestCanonicalRows(');
    }
  });

  it('keeps every canonical delete OUT of a setup or teardown hook', () => {
    const sites = [...sources].flatMap(([path, source]) => canonicalCallSites(path, source));
    const deletes = sites.filter((site) => site.kind === 'bare_delete');

    // The vacuity floor AND a second, comment-blind reading of the regex rule
    // above: the parse can only name these four files by having found real
    // `.delete(canonical…)` calls in them, so a parser that matched nothing —
    // a moved directory, a `ScriptKind` that stopped applying — fails here
    // instead of reporting a clean empty list of hook offenders below.
    expect(
      [...new Set(deletes.map((site) => site.file))].sort(),
      'the parsed reading and the regex reading disagree about which files delete canonical rows',
    ).toEqual(PERMITTED.map((entry) => entry.file));

    const inHooks = deletes
      .filter((site) => site.hook !== null)
      .map((site) => `${site.file}:${String(site.line)} (${site.hook ?? ''})`)
      .sort();

    expect(
      inHooks,
      'a file deletes canonical rows directly from a lifecycle hook; the file-level permission covers a DELIBERATE delete inside an assertion, not a teardown — route the teardown through deleteTestCanonicalRows',
    ).toEqual([]);
  });

  it('has every permitted fixture calling the helper FROM its teardown', () => {
    // The other half, and the one a substring cannot answer: `PERMITTED_FIXTURES`
    // above only proves the name appears somewhere in the file, which every one
    // of them satisfies from its test bodies alone. This asserts the call is in
    // the hook that actually runs at the end.
    for (const file of PERMITTED_FIXTURES) {
      const source = sources.get(file);
      expect(source, `${file} is on the permission list but the walk never read it`).toBeDefined();
      const teardownCalls = canonicalCallSites(file, source ?? '').filter(
        (site) => site.kind === 'helper_call' && site.hook !== null,
      );
      expect(
        teardownCalls.map((site) => site.hook),
        `${file} is permitted a bare canonical delete but its teardown no longer calls deleteTestCanonicalRows`,
      ).not.toEqual([]);
    }
  });

  it('tells a teardown from an assertion, and a canonical table from its neighbours', () => {
    // The mutation self-test for the parsed rule. The assertion above expects an
    // empty list, which is also what a walk that stopped descending reports, so
    // the detector is exercised here against literal buffers — assembled from
    // table names, so this file never becomes the thing it scans for.
    const variants = `canonical${'Variants'}`;
    const products = `canonical${'Products'}`;

    const hookSite = canonicalCallSites(
      'probe.ts',
      `afterAll(async () => { await db.delete(${variants}).where(x); });`,
    );
    expect(hookSite.map((site) => [site.kind, site.hook])).toEqual([['bare_delete', 'afterAll']]);

    // The shape the permission exists FOR: the same statement as the subject of
    // an assertion. It must NOT be attributed to a hook.
    const assertionSite = canonicalCallSites(
      'probe.ts',
      `it('refuses', async () => { await expect(db.delete(${products}).where(x)).rejects.toThrow(); });`,
    );
    expect(assertionSite.map((site) => [site.kind, site.hook])).toEqual([['bare_delete', null]]);

    // A hook that delegates: the attribution has to survive the callback, or the
    // rule is defeated by one `Promise.all`.
    const nested = canonicalCallSites(
      'probe.ts',
      `beforeAll(async () => { await Promise.all(ids.map(async (id) => db.delete(${variants}).where(x))); });`,
    );
    expect(nested.map((site) => [site.kind, site.hook])).toEqual([['bare_delete', 'beforeAll']]);

    // The helper, and WHERE it is called from — the distinction the substring
    // check cannot draw.
    expect(
      canonicalCallSites(
        'probe.ts',
        'afterAll(async () => deleteTestCanonicalRows(db, { productIds }));',
      ).map((site) => [site.kind, site.hook]),
    ).toEqual([['helper_call', 'afterAll']]);
    expect(
      canonicalCallSites(
        'probe.ts',
        "it('cleans up', async () => deleteTestCanonicalRows(db, { productIds }));",
      ).map((site) => [site.kind, site.hook]),
    ).toEqual([['helper_call', null]]);
    // An IMPORT of the helper is not a call to it.
    expect(
      canonicalCallSites('probe.ts', "import { deleteTestCanonicalRows } from './canonical-teardown.js';"),
    ).toEqual([]);

    // A near miss: a sibling table.
    expect(
      canonicalCallSites('probe.ts', `afterAll(async () => db.delete(${variants}Attributes).where(x));`),
    ).toEqual([]);
  });

  it('is used by every fixture that owns canonical rows', () => {
    const callers = [...sources].filter(
      ([path, source]) =>
        path !== TEARDOWN_HELPER && path !== THIS_CENSUS && source.includes('deleteTestCanonicalRows('),
    );
    expect(
      callers.length,
      'the fixtures stopped going through the helper',
    ).toBeGreaterThanOrEqual(CALLER_FLOOR);
  });

  it('gives every canonical fixture a name that can differ between runs', () => {
    const inScope = [...sources].filter(
      ([path, source]) => path !== THIS_CENSUS && CREATES_CANONICAL_PRODUCT.test(source),
    );

    // The floor that makes the zero below mean something. If nothing inserts a
    // canonical product, the rule is measuring an empty set.
    expect(
      inScope.length,
      'no test file inserts a canonical product — the detector or the walk stopped working',
    ).toBeGreaterThanOrEqual(10);

    const offenders = inScope
      .filter(([, source]) => LITERAL_NORMALIZED_NAME.test(source))
      .map(([path]) => path)
      .sort();

    expect(
      offenders,
      'a canonical fixture carries a literal normalizedName; the matcher looks that column up exactly across every row in the shared database, so a stable one is a standing candidate for every later sibling — scope it with a per-run token',
    ).toEqual([]);
  });

  it('pins the RESTRICT edges the teardown planner has to know about', () => {
    const edges: string[] = [];
    for (const table of [canonicalProducts, canonicalVariants]) {
      const config = getTableConfig(table);
      for (const foreignKey of config.foreignKeys) {
        const reference = foreignKey.reference();
        const target = getTableName(reference.foreignTable);
        // Only an edge that stays INSIDE the partitioned pair can be split by it.
        if (target !== 'canonical_products' && target !== 'canonical_variants') continue;
        if (foreignKey.onDelete !== 'restrict') continue;
        // `sqlColumnName`, not `column.name`: the casing is set on the drizzle
        // INSTANCE, so `column.name` is the TypeScript key — it would compare
        // consistently and name columns nobody can grep for. The trap
        // `merge-plan-census.test.ts` records, met again here.
        for (const column of reference.columns) edges.push(`${config.name}.${sqlColumnName(column)}`);
      }
    }

    // Exact identity, never containment, and it is its own positive control: it
    // can only pass by having FOUND all three in the schema, so a reflection
    // that read nothing fails here rather than reporting a tidy empty set.
    expect(
      edges.sort(),
      'a RESTRICT edge between the canonical tables is not covered by deleteTestCanonicalRows; a partition can put its two ends on opposite sides and the delete is then refused',
    ).toEqual(CANONICAL_INTERNAL_RESTRICT_EDGES);
  });

  it('detects every spelling and nothing that merely looks like one', () => {
    // The mutation self-test. The offender assertions above can only report a
    // set, which is what a dead regex reports too — the delete rule is saved by
    // demanding an exact non-empty list, but the NAME rule expects `[]`, so its
    // detector has nothing above to prove it is alive. Both are exercised here
    // against literal buffers, assembled from table names so they never appear
    // in this file as the things it scans for.
    const products = `canonical${'Products'}`;
    const variants = `canonical${'Variants'}`;

    for (const table of [products, variants]) {
      expect(DIRECT_CANONICAL_DELETE.test(`await db.delete(${table}).where(eq(${table}.id, id));`)).toBe(
        true,
      );
      expect(
        DIRECT_CANONICAL_DELETE.test(
          `await db\n  .delete(${table})\n  .where(inArray(${table}.id, ids));`,
        ),
        'the multi-line spelling read as clean',
      ).toBe(true);
      expect(DIRECT_CANONICAL_DELETE.test(`await tx.delete( ${table} );`)).toBe(true);
    }

    // Near misses: a sibling table, and the helper call itself.
    expect(DIRECT_CANONICAL_DELETE.test(`await db.delete(${products}SourceLinks).where(x);`)).toBe(
      false,
    );
    expect(DIRECT_CANONICAL_DELETE.test(`await db.delete(${variants}Attributes).where(x);`)).toBe(
      false,
    );
    expect(DIRECT_CANONICAL_DELETE.test('await deleteTestCanonicalRows(db, { productIds });')).toBe(
      false,
    );
    // An UPDATE is not a delete — clearing `mergedIntoId` before a delete is a
    // legitimate statement two fixtures make.
    expect(DIRECT_CANONICAL_DELETE.test(`await db.update(${products}).set({ status });`)).toBe(false);

    const name = `${'normalized'}${'Name'}`;
    expect(LITERAL_NORMALIZED_NAME.test(`${name}: 'emergency path widget',`)).toBe(true);
    expect(LITERAL_NORMALIZED_NAME.test(`${name}: "double quoted",`)).toBe(true);
    expect(LITERAL_NORMALIZED_NAME.test(`${name} : 'spaced',`)).toBe(true);
    // A template literal is how a per-run token is spelled, and a value read
    // from a helper or a variable can already differ between runs.
    expect(LITERAL_NORMALIZED_NAME.test(`${name}: \`widget \${RUN}\`,`)).toBe(false);
    expect(LITERAL_NORMALIZED_NAME.test(`${name}: normalizeEntityName(label),`)).toBe(false);

    expect(CREATES_CANONICAL_PRODUCT.test(`await db.insert(${products}).values({});`)).toBe(true);
    expect(CREATES_CANONICAL_PRODUCT.test(`await db.insert(${products}Aliases).values({});`)).toBe(
      false,
    );
    // The service spelling, which the direct pattern alone missed.
    expect(CREATES_CANONICAL_PRODUCT.test('const p = await createCanonicalProduct({ name });')).toBe(
      true,
    );
    expect(CREATES_CANONICAL_PRODUCT.test('await createCanonicalProductFamily({ name });')).toBe(
      false,
    );
  });
});
