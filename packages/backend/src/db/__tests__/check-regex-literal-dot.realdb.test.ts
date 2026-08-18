/**
 * No CHECK constraint the database actually holds may use a WILDCARD `.` (#477).
 *
 * The mine this gate closes has been stepped on twice, in two domains, and both
 * times the declaration read correctly:
 *
 * ```ts
 * sql`${t.key} ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'`
 * ```
 *
 * A tagged template's COOKED strings drop `\.` to `.` before drizzle ever sees
 * the pattern, so what reached Postgres was `(.[a-z][a-z0-9_]*)*$` — and in a
 * POSIX regex `.` matches ANY character. Each constraint therefore admitted
 * precisely what it was written to refuse: `foo bar` and `foo/bar` as
 * product-type keys, `axcom` as an advertiser host. Nothing errored, no test
 * failed, and both rows are immutable once written.
 *
 * ## Why this reads `pg_constraint` and not the schema source or the SQL files
 *
 * Reading the DECLARATION is what missed it twice — it is correct TypeScript
 * that says the right thing, and the defect exists only in the artefact.
 *
 * Reading `drizzle/*.sql` is the next idea and it cannot work: migrations are
 * append-only history, so `0089` carries the bad pattern forever and a scan over
 * the files can never go green no matter what is fixed. Worse, it would have to
 * replay DROP/ADD ordering to know which definition survived — a parser whose
 * every subtle error lands in the "reports clean" direction.
 *
 * `pg_constraint` on the fully-migrated throwaway database is the whole chain
 * already applied, by the real migrator, with superseded definitions gone and
 * the expression normalised by Postgres itself. It is the state production is
 * in, which is the only thing the question was ever about.
 *
 * ## Why "no wildcard at all" rather than "a wildcard we did not intend"
 *
 * A detector cannot tell a deliberate `.` from a lost `\.` — they are the same
 * character. So the invariant is the checkable one. Today that costs nothing
 * (every literal dot in the schema is spelled `\.` or `[.]`, and no constraint
 * wants a wildcard), and a pattern that genuinely needs one has to say so in a
 * diff rather than acquire it by accident. There is deliberately NO exemption
 * list: an exemption excusing a live defect is a permanent one, and a list that
 * exists is a list somebody appends to.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';

/**
 * Floors, so a broken query or extractor cannot report a clean zero.
 *
 * "No wildcard dots" and "no patterns at all" produce the identical green, and
 * the second is what a changed quoting convention or a typo in the operator
 * alternation would actually cause.
 *
 * MEASURED on the migrated database, by raising each floor until it reported:
 * 3,048 CHECK constraints, 165 regex patterns among them, 18 of those carrying
 * a dot in some form. The floors below sit under those with room, and the
 * schema only grows — so this is a floor its own subject cannot erode.
 */
const MIN_CHECK_CONSTRAINTS = 500;
const MIN_REGEX_PATTERNS = 100;
const MIN_PATTERNS_CONTAINING_A_DOT = 10;

/**
 * Every regex literal handed to `~`, `~*`, `!~` or `!~*`.
 *
 * `''` is SQL's escape for a quote inside a literal, so the body consumes pairs
 * rather than stopping at the first one.
 */
const REGEX_OPERAND = /(?:!~\*?|~\*?)\s*'((?:[^']|'')*)'/gu;

/**
 * The offsets of every `.` that is a WILDCARD — unescaped, and outside a
 * bracket expression.
 *
 * Both exclusions matter and neither is optional. `\.` is the escaped literal
 * dot; `[.]` is the same thing spelled without a backslash, which is how
 * `CATEGORY_KEY_PATTERN` sidesteps the escaping question entirely (#589 deleted
 * `AWIN_DECLARED_HOST_PATTERN`, the other constant that took that decision,
 * along with the unwritten column it guarded). A detector that ignored bracket
 * expressions would flag `[A-Za-z0-9_:.-]`, correct today in three
 * `feed_import` constraints — and a gate whose first act is three false
 * positives is a gate somebody turns off.
 */
function wildcardDotOffsets(pattern: string): number[] {
  const offsets: number[] = [];
  let index = 0;
  let inBracket = false;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (inBracket) {
      if (char === ']') inBracket = false;
      index += 1;
      continue;
    }
    if (char === '[') {
      index += 1;
      // A `]` in the first position (after an optional `^`) is a literal `]`,
      // not the end of the bracket expression.
      if (pattern[index] === '^') index += 1;
      if (pattern[index] === ']') index += 1;
      inBracket = true;
      continue;
    }
    if (char === '.') offsets.push(index);
    index += 1;
  }
  return offsets;
}

/** Every regex literal inside one constraint definition. */
function extractRegexOperands(definition: string): string[] {
  return [...definition.matchAll(REGEX_OPERAND)].map((match) => match[1].replace(/''/gu, "'"));
}

interface LiveCheck {
  readonly table: string;
  readonly name: string;
  readonly definition: string;
}

let db: Database;
let checks: LiveCheck[] = [];

beforeAll(async () => {
  db = await connectPostgres();
  const rows = await db.execute(sql`
    select
      c.conrelid::regclass::text as table_name,
      c.conname                  as constraint_name,
      pg_get_constraintdef(c.oid) as definition
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    where c.contype = 'c'
      and n.nspname = 'public'
    order by 1, 2
  `);
  checks = [...rows].map((row) => ({
    table: String((row as Record<string, unknown>).table_name),
    name: String((row as Record<string, unknown>).constraint_name),
    definition: String((row as Record<string, unknown>).definition),
  }));
});

afterAll(async () => {
  await closePostgres();
});

describe('the CHECK constraints the migrated database actually holds', () => {
  it('reads enough of them to be measuring something', () => {
    // The vacuity floor. Without it every assertion below passes against a
    // query that returned nothing, which is the failure mode a census has.
    expect(checks.length, 'no CHECK constraints found — did the chain apply?').toBeGreaterThanOrEqual(
      MIN_CHECK_CONSTRAINTS,
    );

    const patterns = checks.flatMap((check) => extractRegexOperands(check.definition));
    expect(patterns.length).toBeGreaterThanOrEqual(MIN_REGEX_PATTERNS);
    // A dot in SOME form has to be present, or "no wildcard dots" is being
    // reported by a corpus that contains no dots at all.
    expect(patterns.filter((pattern) => pattern.includes('.')).length).toBeGreaterThanOrEqual(
      MIN_PATTERNS_CONTAINING_A_DOT,
    );
  });

  it('contains no wildcard `.` — a literal dot is `\\.` or `[.]`', () => {
    const offenders = checks.flatMap((check) =>
      extractRegexOperands(check.definition)
        .filter((pattern) => wildcardDotOffsets(pattern).length > 0)
        .map((pattern) => `${check.table}.${check.name}  ${pattern}`),
    );

    expect(
      offenders,
      [
        'A live CHECK regex carries a bare `.`, which matches ANY character.',
        'If a literal dot was meant, spell it `[.]` (no backslash for any layer',
        'to eat) or `\\.` reached through `sql.raw` — never inline in a drizzle',
        'template literal, whose cooked string drops the backslash. See #477.',
      ].join(' '),
    ).toEqual([]);
  });
});

describe('the detector itself', () => {
  // Mutation self-test. Every case runs through `wildcardDotOffsets` and
  // `extractRegexOperands` — the SAME functions the census above calls, on the
  // same code path — so a detector that silently stopped detecting fails here
  // rather than reporting a clean sweep.
  it('fires on the two spellings that reached production', () => {
    expect(wildcardDotOffsets('^[a-z][a-z0-9_]*(.[a-z][a-z0-9_]*)*$')).toEqual([17]);
    expect(
      wildcardDotOffsets('^[a-z0-9]([a-z0-9-]*[a-z0-9])?(.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
    ).toEqual([31]);
  });

  it('does not fire on either correct spelling of a literal dot', () => {
    expect(wildcardDotOffsets('^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$')).toEqual([]);
    expect(wildcardDotOffsets('^[a-z0-9][a-z0-9_-]*([.][a-z0-9][a-z0-9_-]*)*$')).toEqual([]);
  });

  it('does not fire on a dot inside a bracket expression', () => {
    // The three live `feed_import` patterns. A detector without the bracket
    // exclusion reports all of them and gets itself switched off.
    expect(wildcardDotOffsets('^[A-Za-z0-9][A-Za-z0-9 _.-]{0,199}$')).toEqual([]);
    expect(wildcardDotOffsets('^[A-Za-z0-9_:.\\[\\]-]{1,200}$')).toEqual([]);
    // `[.]` closing on a `]` that is itself the first bracket member.
    expect(wildcardDotOffsets('^[]a.b]$')).toEqual([]);
  });

  it('reads patterns out of a real constraint definition, quote escaping and all', () => {
    // The shape `pg_get_constraintdef` emits, including the `::text` casts it
    // adds — which is why the extractor stops at the closing quote rather than
    // trying to consume to the end of the expression.
    const definition = `CHECK ((((key)::text ~ '^a(.b)$'::text) AND ((key)::text !~ 'it''s\\.'::text)))`;
    expect(extractRegexOperands(definition)).toEqual(['^a(.b)$', "it's\\."]);
    expect(
      extractRegexOperands(definition).filter(
        (pattern) => wildcardDotOffsets(pattern).length > 0,
      ),
    ).toHaveLength(1);
  });
});
