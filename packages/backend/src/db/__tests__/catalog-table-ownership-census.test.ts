/**
 * THE CENSUS over `docs/catalog-table-ownership.md`.
 *
 * That document answers one question — "which module owns this table, and who
 * may write it" — and it answered it by HAND, with nothing reading it. So it
 * drifted the way a hand-maintained map always drifts: not by saying something
 * false, but by going QUIET. Seven tables landed in the catalogue between
 * `0112` and `0133` and none of them appears in the map. The heading still
 * claimed forty-seven, which was exactly right when it was written and stopped
 * being right on 2026-08-18, and nothing anywhere could notice, because
 * `git grep -l catalog-table-ownership -- packages/backend/src` returned
 * nothing at all.
 *
 * A missing row is worse than a wrong one. A wrong row is argued with; a
 * missing row reads as "no module owns this", which is the state in which a
 * second writer gets added — and the map exists precisely to stop that.
 *
 * ## The population is DERIVED, and that is the whole point
 *
 * "The tables the epic added" is a claim about COMPLETENESS, and finding fewer
 * tables looks identical to there BEING fewer (`~/Oxy/AGENTS.md`). So the set
 * is read out of the artefact that actually created them — the migration SQL in
 * `packages/backend/drizzle` — rather than out of a list somebody maintains
 * beside the document it guards. A list maintained beside the doc would go
 * stale in lockstep with the doc and report a clean run forever.
 *
 * `merge-plan-census.test.ts` is the house precedent and this follows it: a new
 * table fails the build until somebody decides which module owns it, which
 * forces the decision at the moment the table is added, by the person adding
 * it. `NOT_IN_THE_MAP` — an entry with a REASON — is a decision the census
 * accepts. Silence is not.
 *
 * ## What a census can and cannot prove
 *
 * It proves a table was CLASSIFIED. It can never prove the classification is
 * TRUE — no gate can read a markdown cell and know whether that module really
 * owns that table. So the two hand-written lists here are bound to things that
 * exist and are checked: every `NOT_IN_THE_MAP` key must be in the derived
 * population (a dead exemption fails), must resolve to a real drizzle table
 * (a named symbol that exists), and must NOT also appear in the map (two
 * answers to one question is the defect, not the fix).
 *
 * ## The floors, and the inverse floor nobody writes
 *
 * "Every table is documented" is also what a parse that matched NOTHING
 * reports, so the derived population, the migrations it came from, the drizzle
 * barrel and the document's own identifier set are all floored independently.
 * And the inverse: the detector is driven, in memory, against a document with
 * one entry REMOVED and against a population with one table INVENTED, so a
 * detector that can only ever answer "clean" fails here rather than in six
 * months. Nothing in this file writes to disk — a migration is an applied
 * artefact and the document is checked in.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../migrationsFolder.js';
import * as schema from '../schema/index.js';

/** The document, relative to the repository root. */
const DOC_RELATIVE = join('docs', 'catalog-table-ownership.md');

/**
 * Found by WALKING UP, not by counting `..` segments.
 *
 * `migrationsFolder.ts` records why a fixed depth is wrong for anything under
 * `packages/backend`, and the same reasoning applies to a test that may be run
 * from the package, from the repository root or through a workspace filter. It
 * throws rather than falling back: a gate that cannot find its subject and
 * carries on is a gate that reports a clean census over nothing.
 */
function locateDoc(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hops = 0; hops < 12; hops += 1) {
    const candidate = join(dir, DOC_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not find ${DOC_RELATIVE} above ${dirname(fileURLToPath(import.meta.url))}. This gate ` +
      'reads that document; without it there is nothing to census against.',
  );
}

const DOC_PATH = locateDoc();

/**
 * The epic's first migration, DERIVED from git rather than eyeballed.
 *
 *     git log --diff-filter=A --format=%s -- packages/backend/drizzle/0088_*.sql
 *     → feat(catalog): taxonomy identity, lifecycle, aliases and redirects (#367) (#401)
 *
 * and the two below it belong to other epics entirely:
 *
 *     0087 → feat(connectors): carry an imported order's ... breakdown (#378) (#391)
 *     0086 → feat(referrals): bound the pilots, and measure what they cost (#342)
 *
 * `0086` is the one worth naming, because it is the trap: it creates four
 * tables (`referral_pilot_cohorts` and siblings) and it sits immediately below
 * a long run of catalogue migrations, so it reads as the start of the run to
 * anyone who finds the boundary by scrolling. It is not. Taking it as the
 * boundary puts four referral tables into a catalogue ownership map.
 *
 * The constant cannot be re-derived here — CI checks out at depth 1, so there
 * is no history for a test to read, and a git-shelling gate would be VACUOUS in
 * exactly the place it runs. It is anchored instead: the boundary migration's
 * own tables are asserted below, and every table the map names is asserted to
 * sit at or above the boundary unless it is one of the reasoned pre-epic
 * subjects. Raising this number to silence a failure fails both.
 */
const FIRST_EPIC_MIGRATION_IDX = 88;

/**
 * Tables in the derived population that the ownership map deliberately does not
 * carry, each with the reason it does not.
 *
 * EMPTY today, and declared rather than omitted: an empty exemption list that
 * exists is a fact the gate reports, where an absent one is a mechanism nobody
 * can tell apart from a mechanism that was never wired. Every table created at
 * or after the boundary is a catalogue table today, including the two a
 * NEIGHBOURING issue added (`listing_pin_releases`, #427; `product_variant_images`,
 * #850) — which the map carries for the same reason it carries the rest: a
 * reader asking "who owns this" does not know which issue number it arrived
 * under.
 */
const NOT_IN_THE_MAP: Readonly<Record<string, string>> = {};

/**
 * Tables the document NAMES that predate the boundary, each with the reason it
 * names them.
 *
 * These are not counter-examples to the boundary; they are the subjects of the
 * document's second table, "Who may write, per subject", which is about
 * pre-existing catalogue tables the epic did NOT add and deliberately did not
 * fork. Listing them here is what turns the boundary from an unchecked constant
 * into a checked one: each is asserted to be a real table created STRICTLY
 * BELOW the boundary, so a boundary raised past `0088` would strand
 * `category_aliases` outside this list and fail.
 */
const PRE_EPIC_SUBJECTS: Readonly<Record<string, string>> = {
  categories: 'ADR 0007 D2 — widened in place, never forked; the map says so in the taxonomy row',
  attribute_definitions: "#94's registry, extended in place rather than forked (the map says so)",
  attribute_enum_values: "#94's controlled values — a write-chokepoint subject, not an epic table",
  canonical_attribute_values: "#53/#59's selected fact — a write-chokepoint subject",
  canonical_products: "#53's canonical catalogue — a write-chokepoint subject",
  brands: "#53's brand layer — a write-chokepoint subject",
};

/** Every drizzle table the barrel exports — the set drizzle-kit emits DDL for. */
const barrelTables: ReadonlySet<string> = new Set(
  Object.values(schema).flatMap((value) => (is(value, PgTable) ? [getTableName(value)] : [])),
);

/**
 * A `CREATE TABLE` the migrator will actually execute.
 *
 * Anchored at column 0, which is what distinguishes a statement from the NINE
 * places in this chain where a header comment discusses `CREATE TABLE` in prose
 * (`0026`, `0039`, `0058`, `0075`, `0078`, `0079`, `0081`, `0099`, `0108`) — a
 * census over source must exclude comments and must be anchored, and here one
 * rule does both, because drizzle-kit emits every statement flush left and
 * every comment behind `--`.
 */
const CREATE_TABLE = /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gm;

interface CreatedTable {
  readonly table: string;
  readonly migration: string;
  readonly idx: number;
}

/**
 * Every table the migration chain creates, with the migration that created it.
 *
 * The directory listing is the population's source, so the `.sql` filter and
 * the four-digit index are both read off the real filenames rather than off the
 * journal: a `.sql` present with no journal entry is still a file
 * `drizzle-kit generate` will collide with, and a journal entry with no `.sql`
 * is `migration-handwritten-markers.test.ts`'s business, not this one's.
 */
function censusCreatedTables(): readonly CreatedTable[] {
  const files = readdirSync(MIGRATIONS_FOLDER)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const found: CreatedTable[] = [];
  for (const name of files) {
    const idx = Number.parseInt(name.slice(0, 4), 10);
    if (!Number.isInteger(idx)) continue;
    const sql = readFileSync(join(MIGRATIONS_FOLDER, name), 'utf8');
    for (const match of sql.matchAll(CREATE_TABLE)) {
      found.push({ table: match[1], migration: name, idx });
    }
  }
  return found;
}

const created = censusCreatedTables();

/** The derived population: every table created at or after the epic's boundary. */
const population: readonly CreatedTable[] = created.filter(
  (entry) => entry.idx >= FIRST_EPIC_MIGRATION_IDX,
);

const doc = readFileSync(DOC_PATH, 'utf8');

/**
 * Every snake_case identifier the document names in a MARKDOWN TABLE ROW.
 *
 * A row, not the whole file, and that is the contract rather than an
 * optimisation: the document's answer to "who owns this" IS a table row, so a
 * table mentioned only in a passing sentence is precisely the state this gate
 * exists to refuse. Backticks anchor it — the document is prose about tables,
 * columns, files and flags, and an unanchored word scan would read `stale`,
 * `pre` and `post` as table names and then never fail again.
 */
function documentedIdentifiers(markdown: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const line of markdown.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    for (const match of line.matchAll(/`([a-z][a-z0-9_]*)`/g)) found.add(match[1]);
  }
  return found;
}

/**
 * The detector, as a pure function of the two sets — which is what lets the
 * mutation self-tests drive it against text and tables held in memory.
 */
function undocumented(
  members: readonly CreatedTable[],
  documented: ReadonlySet<string>,
): readonly string[] {
  return [
    ...new Set(
      members
        .filter((entry) => !documented.has(entry.table) && !(entry.table in NOT_IN_THE_MAP))
        .map((entry) => entry.table),
    ),
  ].sort();
}

describe('docs/catalog-table-ownership.md names every table the catalogue epic added', () => {
  const documented = documentedIdentifiers(doc);

  it('is not vacuous: the migrations, the population, the barrel and the doc are all large', () => {
    /**
     * Four independent floors, because four independent things can silently
     * return nothing here: the directory read, the `CREATE TABLE` pattern, the
     * schema barrel import and the markdown scan. Any one of them answering
     * empty makes the coverage assertion below pass against two empty sets,
     * which is the shape of every check that measures nothing.
     *
     * Floors, never equalities: they may only rise, and the point of this gate
     * is that the population grows without anybody editing this file.
     */
    expect(created.length, 'the migration chain parsed to no tables at all').toBeGreaterThanOrEqual(
      400,
    );
    expect(
      population.length,
      'the derived population is empty or tiny; the boundary or the pattern is wrong',
    ).toBeGreaterThanOrEqual(54);
    expect(
      new Set(population.map((entry) => entry.migration)).size,
      'the population came from too few migrations to be the epic',
    ).toBeGreaterThanOrEqual(16);
    expect(barrelTables.size, 'the drizzle barrel exported no tables').toBeGreaterThanOrEqual(400);
    expect(
      documented.size,
      'no identifier was read out of the document, so nothing below compares anything',
    ).toBeGreaterThanOrEqual(40);
  });

  it('POSITIVE CONTROL: the parse produced real tables, not regex debris', () => {
    /**
     * Every parsed name is a table drizzle itself knows about. This is what
     * catches a pattern that started capturing `IF`, a keyword or a quote — the
     * failure mode in which the population is large, the names are plausible
     * and none of them is real, so the coverage check reports a long list of
     * nonsense and whoever reads it weakens the gate.
     *
     * It is also the check that notices a table DROPPED by a later migration:
     * the `CREATE TABLE` stays in the chain forever, so a dropped table remains
     * in the population and stops being in the barrel. There is no
     * `DROP TABLE` anywhere in the chain today, and the day one lands this
     * names it and its disposition is an entry in `NOT_IN_THE_MAP`.
     */
    const notReal = [
      ...new Set(
        population
          .filter((entry) => !barrelTables.has(entry.table) && !(entry.table in NOT_IN_THE_MAP))
          .map((entry) => `${entry.table} (${entry.migration})`),
      ),
    ].sort();
    expect(
      notReal,
      'these were parsed out of the migration chain and no drizzle table of that name exists. ' +
        'Either the CREATE TABLE pattern is capturing something that is not a table name, or a ' +
        'table was dropped — in which case give it a NOT_IN_THE_MAP entry saying which migration ' +
        'dropped it.',
    ).toEqual([]);
  });

  it('names every table created at or after the epic boundary', () => {
    const missing = undocumented(population, documented);
    expect(
      missing,
      'these tables were created by a migration in the catalogue epic and no row of ' +
        'docs/catalog-table-ownership.md names them, so the map says nothing about who owns ' +
        'them. Add each one to the module that owns it — a row, not a sentence — or add a ' +
        'NOT_IN_THE_MAP entry with the reason it does not belong. Silence is not a disposition.',
    ).toEqual([]);
  });

  it('BOUNDARY ANCHOR: the boundary migration is the epic\'s first, and no mapped table predates it', () => {
    /**
     * Two assertions, and together they are what stops the boundary constant
     * from being raised to make a failure go away.
     *
     * The first pins it to a migration whose content is known: `0088` is the
     * taxonomy branch, and those three tables are the taxonomy row of the map.
     * The second is the one that actually bites: every table the map names,
     * that is a real table, must sit at or above the boundary unless it is a
     * reasoned pre-epic subject. Raise the boundary to 100 and
     * `category_aliases`, `product_type_fields` and thirty more fall below it
     * with no reason recorded, and this fails naming all of them.
     */
    const atBoundary = population
      .filter((entry) => entry.idx === FIRST_EPIC_MIGRATION_IDX)
      .map((entry) => entry.table)
      .sort();
    expect(
      atBoundary,
      `migration ${FIRST_EPIC_MIGRATION_IDX} is supposed to be the epic's first — the taxonomy ` +
        'branch (#367/#401). It creates something else, so the boundary has moved.',
    ).toEqual(['category_aliases', 'category_external_mappings', 'category_redirects']);

    const firstCreatedAt = new Map<string, number>();
    for (const entry of created) {
      const seen = firstCreatedAt.get(entry.table);
      if (seen === undefined || entry.idx < seen) firstCreatedAt.set(entry.table, entry.idx);
    }
    const strandedBelow = [...documented]
      .filter((name) => barrelTables.has(name))
      .filter((name) => (firstCreatedAt.get(name) ?? FIRST_EPIC_MIGRATION_IDX) < FIRST_EPIC_MIGRATION_IDX)
      .filter((name) => !(name in PRE_EPIC_SUBJECTS))
      .sort();
    expect(
      strandedBelow,
      'the map names these tables and they were created BELOW the boundary this gate scans from, ' +
        'so they are documented and uncensused. Either the boundary is wrong, or each needs a ' +
        'PRE_EPIC_SUBJECTS entry saying why the map names a table the epic did not add.',
    ).toEqual([]);
  });

  it('binds every hand-written entry to something that exists', () => {
    /**
     * A census proves a table was classified; it can never prove the
     * classification is true. So the two lists it does trust are held to what
     * IS checkable: the table exists, the entry is still needed, and no entry
     * answers a question the map already answers.
     */
    let checked = 0;
    for (const [table, reason] of Object.entries(NOT_IN_THE_MAP)) {
      checked += 1;
      expect(
        population.some((entry) => entry.table === table),
        `NOT_IN_THE_MAP excuses \`${table}\` and no migration at or after the boundary creates ` +
          'it, so the exemption excuses nothing. Delete it.',
      ).toBe(true);
      expect(
        documented.has(table),
        `\`${table}\` is excused from the map AND named by it. Two answers to one question is ` +
          'the defect; delete one.',
      ).toBe(false);
      expect(reason.length, `NOT_IN_THE_MAP['${table}'] records no reason`).toBeGreaterThan(40);
    }

    for (const [table, reason] of Object.entries(PRE_EPIC_SUBJECTS)) {
      checked += 1;
      expect(
        barrelTables.has(table),
        `PRE_EPIC_SUBJECTS names \`${table}\` and no drizzle table of that name exists — the ` +
          'entry is bound to nothing.',
      ).toBe(true);
      expect(
        population.some((entry) => entry.table === table),
        `PRE_EPIC_SUBJECTS calls \`${table}\` pre-epic and a migration at or after the boundary ` +
          'creates it. It is an epic table; the map should own it, not excuse it.',
      ).toBe(false);
      expect(reason.length, `PRE_EPIC_SUBJECTS['${table}'] records no reason`).toBeGreaterThan(40);
    }

    // A floor, because a loop over two empty objects passes every assertion in
    // it. PRE_EPIC_SUBJECTS carries six today and NOT_IN_THE_MAP none.
    expect(checked, 'no hand-written entry was checked; this test measured nothing').toBeGreaterThanOrEqual(6);
  });

  it('MUTATION SELF-TEST: a dropped row is caught by name, and an undocumented table is not missed', () => {
    /**
     * The two directions, both against copies in memory.
     *
     * Removing a row's mention must make the detector name THAT table and only
     * that table — a detector that named everything, or nothing, would pass the
     * coverage assertion above just as happily today.
     */
    const victim = 'native_variant_signatures';
    expect(documented.has(victim), 'the mutation victim is not in the doc to begin with').toBe(true);
    const mutilated = doc
      .split('\n')
      .map((line) => (line.trimStart().startsWith('|') ? line.replaceAll(`\`${victim}\`, `, '') : line))
      .join('\n');
    const afterRemoval = documentedIdentifiers(mutilated);
    expect(afterRemoval.has(victim), 'the mutation did not apply; the census below proves nothing').toBe(
      false,
    );
    expect(undocumented(population, afterRemoval)).toEqual([victim]);

    // And the inverse nobody writes: a table the map does not name must be
    // REPORTED, not silently absorbed. If the detector only ever answered `[]`
    // every assertion above it would still pass.
    const invented: CreatedTable = {
      table: 'catalog_tables_nobody_documented',
      migration: '9999_synthetic.sql',
      idx: 9999,
    };
    expect(undocumented([...population, invented], documented)).toEqual([invented.table]);

    // And the control for the control: with the real document and the real
    // population, the same function answers empty. A detector wired to a stale
    // path or an empty read would answer empty here too — which is why the two
    // mutations above are what carry the proof, and this is only the pair.
    expect(undocumented(population, documented)).toEqual([]);
  });
});
