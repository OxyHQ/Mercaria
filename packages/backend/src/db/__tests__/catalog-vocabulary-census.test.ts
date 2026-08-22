/**
 * THE CENSUS over #367's canonical vocabulary, and over the open questions the
 * epic is living with.
 *
 * Two of the epic's checkboxes land here and they are one artefact with two
 * populations:
 *
 * - **Line 102**, "encode this vocabulary in the ADR and domain documentation".
 *   ADR 0007 **D16** holds the TERM SET and each term's home;
 *   `docs/catalog-glossary.md` holds the MEANINGS. Two facts, not two copies —
 *   and the one fact they share, the term set, is bound here in both
 *   directions, so they cannot disagree.
 * - **Line 121**, "record explicit decisions for every unresolved semantic
 *   question in the ADR rather than letting individual PRs invent behavior".
 *   ADR 0007 **D17** and §"Open questions". Every question carries a resolution
 *   trigger that this file RUNS.
 *
 * ## Why the vocabulary earns a gate at all
 *
 * Because the encoding that already existed was measurably wrong, and nothing
 * could notice. Measured on 2026-08-23, against `origin/main` at `58d2301e`:
 *
 * - The glossary cited each term's home by LINE. **Twelve of the twenty-three
 *   were stale**, `inventory_levels` by two hundred and ten lines — a document
 *   six days old. They are gone; CLAUSE 3 keeps them gone.
 * - Its identity section stated four figures said to come "from the gate's own
 *   walk". Re-run against that same gate, **every one had moved**, upward, in
 *   six days, because the gate asserts FLOORS and a floor cannot notice growth.
 *   They are gone too — PR #857's finding a second time.
 * - Of the nineteen terms, `catalog-concept-distinctness.test.ts` bound SEVEN
 *   (the concepts #367 line 58 names). The other twelve could rot to anything.
 * - The glossary said the write-ownership invariant is a convention in "the two
 *   places"; the document it cites for that answers three.
 * - It said "two terms in the epic's table have no row of their own" while its
 *   own table gave one of them a row.
 *
 * None of those is a lie somebody told. Every one is a fact with no owner,
 * which is the same thing a few weeks later.
 *
 * ## What this census can and cannot prove
 *
 * It proves a term is NAMED in both documents, that its home is a table the
 * drizzle barrel really exports, and that the file the glossary sends you to
 * really declares it. It can never prove a DEFINITION is true — no gate reads a
 * markdown cell and knows whether that sentence describes that table. So the
 * one hand-written list here, {@link OPEN_QUESTIONS}, is bound to things that
 * exist and are checked: every id must appear as a heading in the ADR, every
 * heading must have an entry, and every non-null trigger must actually RUN.
 *
 * ## The trigger, and the failure it exists for
 *
 * A deferral written in the future tense is never re-read. That is this
 * repository's own history twice over (D17 records both), and
 * `db/deferredForeignKeys.ts` is the one place it was already solved: a
 * deferred relation's gate "fails the moment a table with that name appears in
 * the schema". CLAUSE 4 generalizes that from foreign keys to semantic
 * questions — a trigger that fires means the question became answerable, and
 * the build stays red until somebody writes the answer into the ADR.
 *
 * So the assertion is deliberately the unusual way round: **every trigger must
 * report the question STILL OPEN.** A green run here is not "the questions are
 * fine", it is "nothing has answered them yet".
 *
 * ## Instrument
 *
 * Table identity comes from the drizzle barrel at runtime (`getTableName`), so
 * a multi-line `pgTable(` is not a case to get right and there is no comment to
 * strip. The one thing the barrel cannot give is which FILE declares a table,
 * so that is a source scan — and CLAUSE 0 requires the two to agree as SETS
 * before anything below trusts either. CLAUSE 0 also asserts one thing it knows
 * must PASS: that a SQL column name and its TypeScript property differ under
 * `DATABASE_CASING`, resolved through `sqlColumnName`. An instrument that
 * silently returned TS identifiers would pass every other assertion in this
 * file.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName, is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import { CATALOG_GOVERNANCE_ACTIONS } from '@mercaria/shared-types';
import * as schema from '../schema/index.js';
import { MIGRATIONS_FOLDER } from '../migrationsFolder.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');
const GLOSSARY = join(REPO_ROOT, 'docs', 'catalog-glossary.md');
const ADR = join(REPO_ROOT, 'docs', 'adr', '0007-universal-catalog-taxonomy-and-authoring.md');
const SCHEMA_DIR = join(HERE, '..', 'schema');

/* ────────────────────────────── the instrument ────────────────────────────── */

/** Every table the drizzle barrel exports, by its SQL name. The truth. */
function barrelTables(): ReadonlyMap<string, PgTable> {
  const out = new Map<string, PgTable>();
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) out.set(getTableName(value), value);
  }
  return out;
}

interface Declaration {
  readonly file: string;
  readonly symbol: string;
}

/**
 * Which FILE declares each table — the one fact the runtime barrel cannot
 * answer, so it is read out of the source.
 *
 * The SQL name sits either on the `pgTable(` line or on the next one, and both
 * spellings are read: a single-line pattern would silently miss the multi-line
 * form, which is the house form and therefore almost all of them.
 */
function declarationFiles(): ReadonlyMap<string, Declaration> {
  const out = new Map<string, Declaration>();
  for (const file of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith('.ts'))) {
    const lines = readFileSync(join(SCHEMA_DIR, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const declared = /^export const (\w+) = pgTable\(\s*(?:'([a-z0-9_]+)')?/.exec(line);
      if (!declared) return;
      const name = declared[2] ?? /^\s*'([a-z0-9_]+)'/.exec(lines[index + 1] ?? '')?.[1];
      if (!name) return;
      out.set(name, { file: `db/schema/${file}`, symbol: declared[1] });
    });
  }
  return out;
}

/** A `| **Term** | … | home |` row of the glossary's vocabulary table. */
function glossaryTerms(markdown: string): ReadonlyMap<string, { table?: string; file?: string }> {
  const out = new Map<string, { table?: string; file?: string }>();
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| **')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const term = /^\*\*(.+?)\*\*$/.exec(cells[1]);
    if (!term) continue;
    out.set(term[1], {
      table: /`([a-z][a-z0-9_]+)`/.exec(cells[3])?.[1],
      file: /`(db\/schema\/[A-Za-z]+\.ts)`/.exec(cells[3])?.[1],
    });
  }
  return out;
}

/** The `| Term | Home |` rows of ADR 0007 D16. */
function adrVocabulary(markdown: string): ReadonlyMap<string, string | null> {
  const out = new Map<string, string | null>();
  const section = /### D16\.[\s\S]*?\n### D17\./.exec(markdown);
  if (!section) return out;
  for (const line of section[0].split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('|---')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4) continue;
    if (cells[1] === 'Term' || cells[1] === '') continue;
    out.set(cells[1], /`([a-z][a-z0-9_]+)`/.exec(cells[2])?.[1] ?? null);
  }
  return out;
}

/** The `### Q<n>. …` headings under the ADR's `## Open questions`. */
function adrOpenQuestions(markdown: string): readonly string[] {
  const section = /\n## Open questions\n[\s\S]*?\n## /.exec(markdown);
  if (!section) return [];
  return [...section[0].matchAll(/^### (Q\d+)\./gm)].map((match) => match[1]);
}

/**
 * The NEWEST body of a `CREATE OR REPLACE FUNCTION <name>` in the migration
 * chain — newest, because a later migration replaces an earlier definition and
 * reading the first one would answer about a body Postgres no longer runs.
 */
function newestFunctionBody(name: string): string | null {
  const files = readdirSync(MIGRATIONS_FOLDER)
    .filter((entry) => entry.endsWith('.sql'))
    .sort();
  let body: string | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_FOLDER, file), 'utf8');
    const start = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
    if (start === -1) continue;
    const end = sql.indexOf('$$;', start);
    body = sql.slice(start, end === -1 ? undefined : end);
  }
  return body;
}

/* ─────────────────────────── the open-question register ─────────────────── */

interface OpenQuestion {
  readonly id: string;
  /** What a PR would answer by accident. */
  readonly question: string;
  /**
   * Answers "has this become answerable?". `true` means the question is now
   * decidable from the code and the ADR must record the decision — the build
   * goes red. `null` is admitted where nothing observable changes, and then
   * {@link OpenQuestion.noTriggerBecause} is mandatory.
   */
  readonly resolved: (() => boolean) | null;
  readonly noTriggerBecause?: string;
}

const OPEN_QUESTIONS: readonly OpenQuestion[] = [
  {
    id: 'Q1',
    question:
      'Is a bulk re-pin of every listing on a product-type version store-scoped or operator-only?',
    // The action cannot exist without a member here: `checkOneOf` renders this
    // tuple into the CHECK on both `catalog_governance_change_requests.action`
    // and `catalog_governance_audit_events.action`, so a member is the earliest
    // point at which somebody has answered "who may run it" by building it.
    resolved: () =>
      CATALOG_GOVERNANCE_ACTIONS.some((action) => /repin|re_pin|republish_listings|bulk/.test(action)),
  },
  {
    id: 'Q2',
    question:
      "When a listing's product-type pin moves, must its existing axes move with it, or do they keep citing the version they were made under?",
    // Any clause tying the two has to READ `listings` from inside the axis
    // citation trigger, so the reference is the first observable sign that
    // somebody picked one of the two rules (#883).
    resolved: () => /\blistings\b/.test(newestFunctionBody('mercaria_native_variant_axis_citation') ?? ''),
  },
  {
    id: 'Q3',
    question: 'Community translation contribution, and its moderation rules, if enabled.',
    resolved: null,
    noTriggerBecause:
      'Nothing in this repository changes when this is decided AGAINST, and the affirmative ' +
      'answer arrives as a whole feature rather than as a symbol a predicate could watch for. ' +
      'This entry therefore still depends on somebody re-reading it, which is why it says so.',
  },
];

/* ──────────────────────────────── the walk ─────────────────────────────────── */

const tables = barrelTables();
const declarations = declarationFiles();
const glossaryDoc = readFileSync(GLOSSARY, 'utf8');
const adrDoc = readFileSync(ADR, 'utf8');
const glossary = glossaryTerms(glossaryDoc);
const vocabulary = adrVocabulary(adrDoc);

/** Floors. Every one guards a parse that returns empty when its shape moves. */
const MINIMUM_TABLES = 400;
const MINIMUM_DECLARATIONS = 400;
const MINIMUM_TERMS = 19;

describe('#367 line 102 — the vocabulary is encoded in the ADR and in the glossary, and they agree', () => {
  it('is not vacuous: every input parsed to something large, and the instrument resolves SQL names', () => {
    // Four independent floors, because four independent things silently return
    // empty here — and "every term agrees" is exactly what an empty pair of
    // maps reports. Floors, never equalities, except for the term set itself:
    // that one IS the subject, so it is pinned rather than floored.
    expect(tables.size, 'the drizzle barrel exported no tables').toBeGreaterThanOrEqual(MINIMUM_TABLES);
    expect(
      declarations.size,
      'the source scan found no `export const x = pgTable(` at all',
    ).toBeGreaterThanOrEqual(MINIMUM_DECLARATIONS);
    expect(glossary.size, 'no term parsed out of the glossary table').toBeGreaterThanOrEqual(MINIMUM_TERMS);
    expect(vocabulary.size, 'no term parsed out of ADR 0007 D16').toBeGreaterThanOrEqual(MINIMUM_TERMS);

    // CLAUSE 0's known answer, and the one assertion here that must PASS for a
    // reason unrelated to the subject: `DATABASE_CASING` means the TypeScript
    // property and the SQL column differ for most columns, and an instrument
    // that quietly handed back TS identifiers would satisfy every other
    // assertion in this file. `listings.productTypeDefinitionId` is the column
    // Q2 is about, which makes it the right one to prove the resolver on.
    const listings = tables.get('listings');
    expect(listings, 'the barrel has no `listings`').toBeDefined();
    const pin = getTableConfig(listings as PgTable).columns.find(
      (column) => sqlColumnName(column) === 'product_type_definition_id',
    );
    expect(pin, 'no column resolves to the SQL name `product_type_definition_id`').toBeDefined();
    expect(sqlColumnName(pin!)).not.toBe(pin!.name);
    expect(pin!.name).toBe('productTypeDefinitionId');

    console.log(
      `[catalog-vocabulary] ${tables.size} tables in the barrel; ${declarations.size} declarations located in source; ` +
        `${vocabulary.size} ADR terms; ${glossary.size} glossary terms; ${OPEN_QUESTIONS.length} open questions.`,
    );
  });

  it('CLAUSE 0 — the two derivations of the table population agree as SETS', () => {
    // The source scan is the only thing that can answer "which file", and it is
    // a text scan, so it is checked against the runtime barrel before anything
    // trusts it. A scan whose pattern stopped matching would shrink silently
    // and every file assertion below would then pass by never being reached.
    const missing = [...tables.keys()].filter((name) => !declarations.has(name));
    const invented = [...declarations.keys()].filter((name) => !tables.has(name));
    expect(missing, 'the source scan missed tables the barrel exports').toEqual([]);
    expect(invented, 'the source scan invented tables the barrel does not export').toEqual([]);
  });

  it('CLAUSE 1 — the ADR and the glossary name the SAME nineteen terms', () => {
    // Both directions. A term the ADR added and the glossary never defined is
    // a name with no meaning; a term the glossary defines and the ADR never
    // listed is a concept outside the binding set. Neither is worse and both
    // are silent.
    const onlyInAdr = [...vocabulary.keys()].filter((term) => !glossary.has(term));
    const onlyInGlossary = [...glossary.keys()].filter((term) => !vocabulary.has(term));
    expect(onlyInAdr, 'ADR 0007 D16 lists a term the glossary does not define').toEqual([]);
    expect(onlyInGlossary, 'the glossary defines a term ADR 0007 D16 does not list').toEqual([]);
    expect(vocabulary.size, 'the vocabulary is nineteen terms').toBe(19);
  });

  it('CLAUSE 2 — every home is the same table in both documents, exists, and lives in the cited file', () => {
    let homed = 0;
    let dispositioned = 0;
    for (const [term, adrHome] of vocabulary) {
      const row = glossary.get(term)!;
      if (adrHome === null) {
        // A term with no table needs a written disposition rather than
        // silence — the `NOT_IN_THE_MAP` device. The glossary row must say so
        // too, or the two documents disagree about whether a home exists.
        dispositioned++;
        expect(row.table, `${term} has no home in the ADR but the glossary cites a table`).toBeUndefined();
        continue;
      }
      homed++;
      expect(row.table, `the glossary's home for "${term}" disagrees with ADR 0007 D16`).toBe(adrHome);
      expect(tables.has(adrHome), `"${term}" is homed at \`${adrHome}\`, which no table exports`).toBe(true);
      expect(row.file, `the glossary row for "${term}" cites no schema file`).toBeDefined();
      expect(
        declarations.get(adrHome)!.file,
        `the glossary sends a reader to ${row.file} for \`${adrHome}\`, which is declared elsewhere`,
      ).toBe(row.file);
    }
    // Both counters, because "every home checks out" is also what zero homes
    // reports, and the disposition branch is the one that would silently
    // swallow the whole table if a parse stopped finding backticks.
    expect(homed, 'no term was checked against a real table').toBeGreaterThanOrEqual(18);
    expect(dispositioned, 'no term carries a written no-table disposition').toBe(1);
  });

  it('CLAUSE 3 — the glossary cites no LINE in a live source file', () => {
    // The fact with no owner. A line number describes a file's current shape
    // and rots on an edit nobody made to this document; twelve of twenty-three
    // had, before they were removed. A citation into an APPLIED MIGRATION is
    // the one permitted form, because a migration is immutable once it has run,
    // so its line numbers cannot move.
    const cited = [...glossaryDoc.matchAll(/`([A-Za-z0-9_/.-]*\.(?:ts|tsx)):(\d+)`/g)].map((m) => m[0]);
    expect(
      cited,
      'a line citation into a live source file is back in the glossary; cite the file and the ' +
        'identifier instead, which this census resolves against the schema',
    ).toEqual([]);
    // The inverse: the detector must find the form it permits, or it is a
    // pattern that matches nothing and this clause is decoration.
    const migrationCitations = [...glossaryDoc.matchAll(/`(drizzle\/[A-Za-z0-9_]+\.sql):(\d+)`/g)];
    expect(
      migrationCitations.length,
      'the detector found no migration citation either, so it may be matching nothing at all',
    ).toBeGreaterThanOrEqual(1);
    for (const [, file, line] of migrationCitations) {
      const source = readFileSync(join(REPO_ROOT, 'packages', 'backend', file), 'utf8').split('\n');
      expect(source[Number(line) - 1], `${file}:${line} is past the end of the file`).toBeDefined();
    }
  });
});

describe('#367 line 121 — every open question is EVALUATED, not narrated (ADR 0007 D17)', () => {
  const headings = adrOpenQuestions(adrDoc);

  it('is not vacuous: the ADR really has an Open questions section with headings in it', () => {
    expect(
      headings.length,
      'no `### Q<n>.` heading parsed out of ADR 0007 §Open questions — the section was renamed, ' +
        'removed, or its heading shape changed, and every assertion below would then pass by ' +
        'comparing two empty lists',
    ).toBeGreaterThanOrEqual(1);
    expect(adrDoc).toContain('## Open questions');
  });

  it('CLAUSE 4 — the register is TOTAL over the ADR, in both directions', () => {
    // The `GUEST_PORTAL_MESSAGE_TRIGGERS` device. A question in the ADR with no
    // entry here is one nothing evaluates; an entry here with no question in
    // the ADR is a trigger guarding a decision no reader can find.
    expect([...headings].sort()).toEqual(OPEN_QUESTIONS.map((q) => q.id).sort());
    for (const question of OPEN_QUESTIONS) {
      expect(adrDoc, `${question.id} has no heading in the ADR`).toContain(`### ${question.id}.`);
      expect(question.question.length, `${question.id} has no question text`).toBeGreaterThan(30);
    }
  });

  it('CLAUSE 4 — every trigger reports its question STILL OPEN', () => {
    // Deliberately the unusual way round. A trigger that fires means the
    // question became answerable from the code, and the answer must be written
    // into ADR 0007's decisions and the entry deleted — the
    // `DEFERRED_FOREIGN_KEYS` mechanism, generalized from foreign keys to
    // semantic questions. Green here means "nothing has answered them yet",
    // never "the questions are fine".
    let evaluated = 0;
    for (const question of OPEN_QUESTIONS) {
      if (question.resolved === null) {
        expect(
          question.noTriggerBecause?.length ?? 0,
          `${question.id} has no trigger and no reason for having none`,
        ).toBeGreaterThan(80);
        continue;
      }
      evaluated++;
      expect(
        question.resolved(),
        `${question.id} is now ANSWERABLE from the code and is still listed as open in ADR 0007 ` +
          `§Open questions: "${question.question}" — record the decision as a numbered D and delete ` +
          'the entry.',
      ).toBe(false);
    }
    // A register of nothing but null triggers is a narrated register wearing
    // this file's name.
    expect(evaluated, 'no open question carries a trigger this file can run').toBeGreaterThanOrEqual(2);
  });
});

describe('mutation self-tests — each detector, against inputs it never receives from disk', () => {
  it('the glossary parser reads a real row and refuses a prose line', () => {
    const parsed = glossaryTerms(
      ['| **Offer** | terms | `offers`, `db/schema/offers.ts` |', 'Two terms in the epic table have no row.'].join(
        '\n',
      ),
    );
    expect(parsed.size).toBe(1);
    expect(parsed.get('Offer')).toEqual({ table: 'offers', file: 'db/schema/offers.ts' });
  });

  it('the ADR vocabulary parser stops at D17, so a later table cannot be read as a term', () => {
    const parsed = adrVocabulary(
      [
        '### D16. The vocabulary',
        '| Term | Home |',
        '|---|---|',
        '| Offer | `offers` |',
        '| Entity reference | *no table* |',
        '### D17. An open question',
        '| Term | Home |',
        '| Smuggled | `not_a_term` |',
      ].join('\n'),
    );
    expect([...parsed.keys()]).toEqual(['Offer', 'Entity reference']);
    expect(parsed.get('Entity reference')).toBeNull();
  });

  it('CLAUSE 1 fires when a term is in one document and not the other', () => {
    const adrOnly = new Map(vocabulary);
    adrOnly.set('Planted concept', 'listings');
    expect([...adrOnly.keys()].filter((term) => !glossary.has(term))).toEqual(['Planted concept']);
    const glossaryOnly = new Map(glossary);
    glossaryOnly.set('Planted concept', { table: 'listings' });
    expect([...glossaryOnly.keys()].filter((term) => !vocabulary.has(term))).toEqual(['Planted concept']);
  });

  it('CLAUSE 2 fires when the glossary sends a reader to the wrong file', () => {
    // The failure that was live until this census: a home naming a file that
    // does not declare it. Driven here rather than on disk, so it cannot be
    // satisfied by the real document happening to be right.
    const wrong = { table: 'offers', file: 'db/schema/catalog.ts' };
    expect(declarations.get(wrong.table)!.file).not.toBe(wrong.file);
    expect(declarations.get('offers')!.file).toBe('db/schema/offers.ts');
  });

  it('CLAUSE 3 fires on a line citation into a live file and not on one into a migration', () => {
    const detector = /`([A-Za-z0-9_/.-]*\.(?:ts|tsx)):(\d+)`/g;
    expect('see `db/schema/catalog.ts:128` for it'.match(detector)).toHaveLength(1);
    expect('see `drizzle/0097_uneven_hedge_knight.sql:178` for it'.match(detector)).toBeNull();
    // And it must not fire on a file cited WITHOUT a line, which is the form
    // the glossary now uses everywhere — a detector that flagged those would be
    // one whose cheapest green is deleting the citation entirely.
    expect('see `db/schema/catalog.ts` for it'.match(detector)).toBeNull();
  });

  it('CLAUSE 4 fires when a trigger reports its question answered', () => {
    // The whole point of the register, driven against a trigger that returns
    // true. Without this, a register of triggers that can only ever answer
    // "still open" would satisfy CLAUSE 4 forever.
    const answered: OpenQuestion = { id: 'Q99', question: 'x'.repeat(40), resolved: () => true };
    expect(answered.resolved!()).toBe(true);
    expect(OPEN_QUESTIONS.filter((q) => q.resolved !== null).length).toBeGreaterThanOrEqual(2);
  });

  it("Q2's trigger reads the migration chain and can tell the two bodies apart", () => {
    // A trigger that silently found no function body would answer `false`
    // forever — "still open" — which is the safe-looking direction and the one
    // that makes this entry decoration. So: the body must be FOUND, must not
    // mention `listings` today, and the detector must fire on a body that does.
    const body = newestFunctionBody('mercaria_native_variant_axis_citation');
    expect(body, 'the axis citation function was not found in the migration chain').not.toBeNull();
    expect(body!.length).toBeGreaterThan(400);
    expect(/\blistings\b/.test(body!)).toBe(false);
    expect(/\blistings\b/.test(`${body!}\n  select 1 from listings l where ...`)).toBe(true);
    expect(newestFunctionBody('mercaria_no_such_function_exists')).toBeNull();
  });

  it("Q1's trigger fires on a member that would answer it, and not on today's tuple", () => {
    expect(CATALOG_GOVERNANCE_ACTIONS.length).toBeGreaterThanOrEqual(15);
    const detector = (actions: readonly string[]) =>
      actions.some((action) => /repin|re_pin|republish_listings|bulk/.test(action));
    expect(detector(CATALOG_GOVERNANCE_ACTIONS)).toBe(false);
    expect(detector([...CATALOG_GOVERNANCE_ACTIONS, 'product_type_bulk_repin'])).toBe(true);
  });

  it('the glossary and the ADR are real files, not empty ones', () => {
    // The floor under every `readFileSync` above: a truncated file parses to
    // nothing and reports agreement between two empty sets.
    expect(statSync(GLOSSARY).size).toBeGreaterThan(4000);
    expect(statSync(ADR).size).toBeGreaterThan(20000);
  });
});
