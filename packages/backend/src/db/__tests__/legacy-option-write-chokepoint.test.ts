/**
 * `listing_options` and `product_variant_option_values` are written by
 * `db/catalog/listingRepository.ts` and `db/catalog/variantRepository.ts`, and by
 * nothing else.
 *
 * ## What this protects, and why prose could not
 *
 * ADR 0007 D6/D13 RETAIN the two legacy free-text option tables as legacy claims.
 * #367 step 4 then wants them demoted to a migration compatibility projection
 * rather than the source of truth — and until that flip happens, the thing that
 * stops the gap widening is that the writer set does not grow.
 *
 * Before #824 it was bounded by nothing. The exclusion of the two largest
 * CALLERS from `variant-axis-isolation.test.ts` wall 4 is recorded in prose in
 * four places — ADR 0007 D13, `db/variantAxes/legacyOptionRepository.ts`, that
 * test's own header, and `docs/variant-axes.md` / `docs/catalog-contracts.md` —
 * and was asserted by no gate. Four documents agreeing does not make a build
 * fail.
 *
 * The failure mode is the quiet one. A third writer would put unexamined free
 * text into a table the epic is trying to stop treating as authoritative, with
 * no error, no log line, and every read still working — because every
 * buyer-facing read still reads these tables. It would surface as a typed axis
 * claim that disagrees with the option row it is supposed to be a projection of,
 * discovered by whoever later tries to flip the direction.
 *
 * A third writer therefore fails THIS test until somebody decides what it means
 * for #367's direction — which is the point. A gate that skips what is missing
 * from its own map is not a gate, so every hit must be a named writer with a
 * stated disposition; being absent from the list fails, and so does being ON the
 * list without writing.
 *
 * ## What this is NOT, and what it must not be read as replacing
 *
 * `variant-axis-isolation.test.ts` wall 4 measures a DIFFERENT property: that no
 * module in the variant-axes domain may write — or even import a module that
 * writes — these tables. That is a prohibition scoped to one domain. This is a
 * census scoped to the whole tree. Neither subsumes the other: wall 4 would still
 * fire on a variant-axes module that merely IMPORTS `catalog/listingRepository`,
 * which writes no statement and so is invisible here.
 *
 * Note in particular that wall 4's detector NAMES `catalog-write.service` as a
 * forbidden IMPORT for that domain. That is a prohibition, not a permission
 * grant, and neither `catalog-write.service.ts` nor `connector-sync.service.ts`
 * contains a write against either table — both reach them through
 * `insertListing` / `insertVariants` / `updateVariant`, which is what a
 * chokepoint is FOR. They are callers, not writers, and are deliberately absent
 * from `PERMITTED_WRITERS` below: listing a module that does not write would rot
 * the list green the moment somebody checked it.
 *
 * ## Comments: stripped in one direction and not the other, deliberately
 *
 * The two choices fail opposite ways, so each half of this file uses the one
 * whose failure is safe.
 *
 * FINDING the population scans RAW source, following
 * `listing-publication-chokepoint.test.ts`. An unstripped scan can only produce a
 * false POSITIVE — a comment quoting a write shape turns the build red and is
 * corrected in one line — while a stripper truncates at a `//` inside a string
 * literal and can hide a real write, which is the failure this census exists to
 * prevent. The probes are assembled from table names rather than written out, so
 * this file cannot become the offender it looks for.
 *
 * Proving a permitted writer STILL WRITES strips comments, because there the
 * directions reverse: a permitted module whose real statement had been removed
 * but whose docblock still quoted one would keep its entry green forever, which
 * is precisely the rot an exactness check exists to catch.
 *
 * It scans PRODUCTION source only. Fixtures write both tables all over the suite
 * and are supposed to.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The drizzle symbols for the two tables, assembled from rather than quoted. */
const TABLE_SYMBOLS = ['listingOptions', 'productVariantOptionValues'] as const;

/** The same two tables as SQL identifiers, for the raw-statement spellings. */
const TABLE_NAMES = ['listing_options', 'product_variant_option_values'] as const;

const anyOf = (names: readonly string[]): string => `(?:${names.join('|')})`;

/**
 * A write against either legacy option table, in every spelling that reaches one.
 *
 * Keyed on the STATEMENT, never on a function name: the whole point is that a
 * module which renames `replaceOptionValues`, or inlines the statement with no
 * helper at all, is still caught. `variant-axis-isolation.test.ts` wall 4 can
 * afford to name `replaceListingOptions` as well because it is scoped to one
 * domain and errs toward refusing; a tree-wide census keyed on a symbol name
 * would be defeated by one rename.
 *
 * DELETE counts as a write. `replaceListingOptions` and `replaceOptionValues` are
 * both delete-then-insert, so a scan for insertion alone would already miss half
 * of each of the two statements it exists to find — and a module that only
 * deleted rows would erase a merchant's options while reading as clean.
 *
 * `\s*` throughout because the house spelling breaks a long statement across
 * lines and a line-based scan reads that as clean. The raw-SQL branches are here
 * because `db.execute` bypasses the query builder entirely, and the interpolated
 * `${…}` branches because inside a `sql` template the table name never appears as
 * text at all — the spelling `listing-publication-chokepoint.test.ts` records
 * itself as having been blind to until #427 wrote the first one.
 *
 * `\b` after each raw table name so a future `listing_options_archive` is not
 * read as this table; `[,)]` after each symbol for the same reason.
 */
const LEGACY_OPTION_WRITE = new RegExp(
  [
    `\\.\\s*(?:insert|update|delete)\\s*\\(\\s*${anyOf(TABLE_SYMBOLS)}\\s*[,)]`,
    `insert\\s+into\\s+"?${anyOf(TABLE_NAMES)}\\b"?`,
    `update\\s+"?${anyOf(TABLE_NAMES)}\\b"?\\s+set`,
    `delete\\s+from\\s+"?${anyOf(TABLE_NAMES)}\\b"?`,
    `insert\\s+into\\s+\\$\\{\\s*${anyOf(TABLE_SYMBOLS)}\\s*\\}`,
    `update\\s+\\$\\{\\s*${anyOf(TABLE_SYMBOLS)}\\s*\\}`,
    `delete\\s+from\\s+\\$\\{\\s*${anyOf(TABLE_SYMBOLS)}\\s*\\}`,
  ].join('|'),
  'iu',
);

/**
 * Every production file that writes either table, and why it is allowed to.
 * Relative to `src/`, sorted.
 *
 * `statements` is the count the module must still carry AFTER comment stripping.
 * It is what stops an entry outliving the write that earned it.
 */
const PERMITTED_WRITERS: readonly {
  readonly path: string;
  readonly statements: number;
  readonly disposition: string;
}[] = [
  {
    path: join('db', 'catalog', 'listingRepository.ts'),
    statements: 2,
    disposition:
      'the OWNER of `listing_options` — `replaceListingOptions` replaces a listing’s whole option list as one delete plus one insert, and its sole caller is `insertListing` in this same module',
  },
  {
    path: join('db', 'catalog', 'variantRepository.ts'),
    statements: 2,
    disposition:
      'the OWNER of `product_variant_option_values` — `replaceOptionValues` is module-private and replaces a variant’s values as one delete plus one insert, called by `insertVariants` and `updateVariant` in this same module',
  },
];

/**
 * The exported half of the chokepoint.
 *
 * `replaceListingOptions` is EXPORTED, so `listing_options` can be written from
 * any module without that module containing a statement this census can see —
 * the one hole the write-statement wall cannot cover, and exactly one call away
 * from the defect #824 describes. `replaceOptionValues` is module-private, which
 * is why `variantRepository.ts` needs no equivalent entry; the assertion that it
 * STAYS private is below, because exporting it would open the same hole there.
 */
const EXPORTED_WRITE_HELPER = 'replaceListingOptions';

const PERMITTED_HELPER_CALLERS: readonly { readonly path: string; readonly disposition: string }[] =
  [
    {
      path: join('db', 'catalog', 'listingRepository.ts'),
      disposition:
        'the owner itself — `insertListing` calls it, which is the chokepoint being used rather than bypassed',
    },
  ];

/** A call to the exported helper, as a CALL so an import line alone is not one. */
const HELPER_CALL = new RegExp(`\\b${EXPORTED_WRITE_HELPER}\\s*\\(`, 'u');

/**
 * Every symbol whose alias would hide a write from the walls above.
 *
 * Both of the preceding detectors are keyed on a SYMBOL, and an alias defeats
 * each of them in exactly one line:
 *
 *   - `import { listingOptions as lo }` then `.insert(lo)` writes the table and
 *     the write census reads clean;
 *   - `import { replaceListingOptions as r }` then `r(id, options, tx)` writes it
 *     through the exported helper and the caller census reads clean. Measured:
 *     that pair matches NEITHER probe, while the unaliased spelling matches.
 *
 * An alias always spells the real symbol on the import line, so refusing aliases
 * outright is what makes both symbol branches complete — cheaper, and far more
 * honest, than re-implementing an import resolver inside a test. Nothing in the
 * tree aliases any of the three today, so this costs nobody anything.
 */
const UNALIASABLE_SYMBOLS: readonly string[] = [...TABLE_SYMBOLS, EXPORTED_WRITE_HELPER];

const ALIASED_IMPORT = new RegExp(`\\b${anyOf(UNALIASABLE_SYMBOLS)}\\s+as\\s+\\w`, 'u');

/**
 * Strip comments before scanning.
 *
 * The sibling spelling from `variant-axis-isolation.test.ts`, including its `:`
 * guard so a `https://` inside a string literal is not eaten as a line comment.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** `{relative path → source}` for every production `.ts` under `src/`. */
function productionSources(): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const rel = relative(SRC_ROOT, path);
      if (rel.split(sep).includes('__tests__')) continue;
      sources.set(rel, readFileSync(path, 'utf8'));
    }
  };
  walk(SRC_ROOT);
  return sources;
}

function countMatches(source: string, probe: RegExp): number {
  return (source.match(new RegExp(probe.source, 'giu')) ?? []).length;
}

describe('the legacy option-table write census', () => {
  it('finds ONLY the two catalog repositories writing either legacy option table', () => {
    const sources = productionSources();

    // The vacuity floor. A broken walk, a moved directory or an extension filter
    // that stopped matching all report the same clean zero as a correct scan.
    expect(sources.size, 'the walk read almost nothing — did the layout move?').toBeGreaterThan(
      400,
    );

    const writers = [...sources]
      .filter(([, source]) => LEGACY_OPTION_WRITE.test(source))
      .map(([path]) => path)
      .sort();

    // Exact identity, never containment, in BOTH directions. An allow-list that
    // may only grow is the gate switching itself off one defensible entry at a
    // time; a list carrying a module that no longer writes is the same erosion
    // arriving from the other side. It is also its own positive control — it can
    // only pass by having FOUND both real writers, so a walk that read nothing
    // or a probe that matched nothing fails here rather than reporting a tidy
    // zero.
    expect(
      writers,
      'a module writes a legacy option table directly. These tables are RETAINED legacy claims (ADR 0007 D6/D13) that #367 is trying to demote from source of truth — route the write through listingRepository/variantRepository, or add it here with a disposition (#824)',
    ).toEqual([...PERMITTED_WRITERS].map((writer) => writer.path).sort());
  });

  it('names writers whose paths the walk read, and which still write after comment stripping', () => {
    const sources = productionSources();

    for (const { path, statements, disposition } of PERMITTED_WRITERS) {
      const source = sources.get(path);

      // A stale path — a rename, a moved directory — permits nothing and reads
      // exactly like a correct run, leaving the census above comparing two lists
      // that agree about a file neither of them found.
      expect(source, `permitted writer path is stale: ${path}`).toBeDefined();
      expect(disposition.length, `permitted writer ${path} has no disposition`).toBeGreaterThan(40);

      // The anti-rot floor, and the one place comments are STRIPPED. Counted on
      // code alone, so an entry cannot be kept alive by a docblock that still
      // quotes the statement somebody deleted.
      const code = stripComments(source ?? '');
      expect(
        countMatches(code, LEGACY_OPTION_WRITE),
        `${path} no longer carries ${statements} legacy option write statement(s) in code. If the write moved, move the entry (#824)`,
      ).toBeGreaterThanOrEqual(statements);
    }

    // The exact count beside the floor the list excuses, so a third entry has to
    // be a deliberate edit here as well as there.
    expect(PERMITTED_WRITERS).toHaveLength(2);
  });

  it('bounds the callers of the EXPORTED write helper, which the statement scan cannot see', () => {
    const sources = productionSources();

    const callers = [...sources]
      .filter(([, source]) => HELPER_CALL.test(source))
      .map(([path]) => path)
      .sort();

    expect(
      callers,
      `a module calls ${EXPORTED_WRITE_HELPER} directly, writing legacy free-text options without a statement this census can see. Route it through insertListing, or add it here with a disposition (#824)`,
    ).toEqual([...PERMITTED_HELPER_CALLERS].map((caller) => caller.path).sort());

    for (const { path } of PERMITTED_HELPER_CALLERS) {
      expect(sources.has(path), `permitted helper caller path is stale: ${path}`).toBe(true);
    }

    // `replaceOptionValues` being module-private is what makes `variantRepository`
    // a MODULE boundary rather than a function boundary, and therefore why it
    // needs no caller entry. If it is ever exported, this wall's population has
    // to grow to cover it — so the privacy is asserted rather than assumed.
    const variantOwner = sources.get(join('db', 'catalog', 'variantRepository.ts'));
    expect(variantOwner, 'the variant owner path is stale').toBeDefined();
    expect(
      /export\s+(?:async\s+)?function\s+replaceOptionValues\b/u.test(stripComments(variantOwner ?? '')),
      '`replaceOptionValues` is now exported, so `product_variant_option_values` can be written from any module. Either keep it module-private, or extend the helper-caller census above to cover it (#824)',
    ).toBe(false);
  });

  it('refuses an aliased import of any protected symbol, which would hide a write', () => {
    const sources = productionSources();

    const aliased = [...sources]
      .filter(([, source]) => ALIASED_IMPORT.test(stripComments(source)))
      .map(([path]) => path)
      .sort();

    // Comments ARE stripped here: unlike the write scan, the safe direction for
    // an alias check is the strict one. A docblock explaining the prohibition
    // uses the same words, and this is a wall nobody currently stands against —
    // a false positive here has no real offender to point at.
    expect(
      aliased,
      'a module imports a legacy option table symbol, or the exported write helper, under another name — which defeats the symbol-keyed censuses above. Import it unaliased (#824)',
    ).toEqual([]);

    // The floor on the probe itself. An empty expectation is satisfied by a
    // detector that matches nothing, so the symbol list is asserted to be the
    // three real ones rather than left to be silently emptied.
    expect(UNALIASABLE_SYMBOLS).toHaveLength(3);
  });

  it('catches every write spelling, and no read', () => {
    // The detector self-test, against text held in memory. Without it, a probe
    // that had stopped matching would let every census above pass by finding
    // nothing anywhere.

    // The inline statement, with no helper wrapping it — the shape a rename or
    // an inlining would produce, and the one a name-keyed detector misses.
    expect(LEGACY_OPTION_WRITE.test('await db.insert(productVariantOptionValues).values(rows);')).toBe(
      true,
    );
    expect(LEGACY_OPTION_WRITE.test('await db.insert(listingOptions).values(rows);')).toBe(true);

    // The delete half of each replace, and the update nobody writes yet.
    expect(LEGACY_OPTION_WRITE.test('await db\n  .delete(productVariantOptionValues)\n  .where(x)')).toBe(
      true,
    );
    expect(LEGACY_OPTION_WRITE.test('db.update(listingOptions).set({ name })')).toBe(true);

    // Raw SQL, which bypasses the query builder and its column mappers.
    expect(LEGACY_OPTION_WRITE.test('db.execute(sql`insert into listing_options (name) values (1)`)')).toBe(
      true,
    );
    expect(LEGACY_OPTION_WRITE.test('sql`update "product_variant_option_values" set value = 1`')).toBe(
      true,
    );
    expect(LEGACY_OPTION_WRITE.test('sql`delete from listing_options where id = 1`')).toBe(true);

    // Interpolated, where the table name never appears as text. Asserted to be a
    // genuinely SEPARATE branch: the raw-name spelling does not catch it, so it
    // is a fourth shape rather than a second way of writing an existing one.
    const interpolated = 'sql`insert into ${listingOptions}\n  (name) values (1)`';
    expect(LEGACY_OPTION_WRITE.test(interpolated)).toBe(true);
    expect(new RegExp(`insert\\s+into\\s+"?${TABLE_NAMES[0]}\\b"?`, 'iu').test(interpolated)).toBe(
      false,
    );

    // Reads are legitimate and are what `legacyOptionRepository.ts` exists for.
    expect(LEGACY_OPTION_WRITE.test('.from(listingOptions).where(eq(listingOptions.listingId, id))')).toBe(
      false,
    );
    expect(LEGACY_OPTION_WRITE.test('select count(*) from ${productVariantOptionValues}')).toBe(false);

    // A neighbouring table whose name merely starts the same must not read as
    // this one.
    expect(LEGACY_OPTION_WRITE.test('sql`insert into listing_options_archive (id) values (1)`')).toBe(
      false,
    );
    expect(LEGACY_OPTION_WRITE.test('db.insert(listingOptionsArchive).values(rows)')).toBe(false);
  });

  it('strips comments without eating code, and catches an alias', () => {
    // The stripper's own mutation self-test. Both comment forms, the `:` guard,
    // and the positive control that a REAL statement survives.
    expect(stripComments('const a = 1; // db.insert(listingOptions)')).not.toContain('insert');
    expect(stripComments('/* db.insert(listingOptions) */ const a = 1;')).not.toContain('insert');
    expect(stripComments("const url = 'https://x';")).toContain('https://x');
    expect(stripComments('await db.insert(listingOptions).values(r);')).toContain(
      'insert(listingOptions)',
    );

    // The alias probe, and the negative control that an ordinary import is not
    // read as one.
    expect(ALIASED_IMPORT.test('import { listingOptions as lo } from "../schema/catalog.js";')).toBe(
      true,
    );
    expect(
      ALIASED_IMPORT.test('import { productVariantOptionValues as v } from "../schema/catalog.js";'),
    ).toBe(true);
    expect(ALIASED_IMPORT.test('import { listingOptions, listings } from "../schema/catalog.js";')).toBe(
      false,
    );

    // The helper-call probe, and the negative control that an import of the
    // symbol is not a call to it.
    expect(HELPER_CALL.test('await replaceListingOptions(id, options, tx);')).toBe(true);
    expect(HELPER_CALL.test('import { replaceListingOptions } from "./listingRepository.js";')).toBe(
      false,
    );

    // The evasion the two symbol-keyed censuses cannot see on their own, and the
    // reason the alias wall covers the HELPER and not only the tables. Both
    // halves are asserted: the pair genuinely defeats the caller probe, and the
    // alias probe genuinely catches it.
    const evasion = [
      'import { replaceListingOptions as r } from "./listingRepository.js";',
      'async function sneak() { await r(id, options, tx); }',
    ].join('\n');
    expect(HELPER_CALL.test(evasion)).toBe(false);
    expect(ALIASED_IMPORT.test(evasion)).toBe(true);
  });
});
