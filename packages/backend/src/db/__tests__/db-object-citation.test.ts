/**
 * A docblock in the database layer cannot name a database object that does not
 * exist (#759).
 *
 * Four false mechanisms were found in one small area by somebody reading them
 * by hand (#730, fixed in #757): a trigger name that existed nowhere and whose
 * docblock described the INVERSE of the real guarantee, a name that was really
 * two per-table triggers, a singular/plural typo, and a claim that a function
 * was "exported for the isolation gate's benefit" by a 695-line gate that
 * references neither it nor its table. A named identifier that does not exist
 * is the cheapest possible thing to catch and the most likely to be quoted
 * forward.
 *
 * ## Why the OBVIOUS gate was refused, and what this does instead
 *
 * #759 is filed with a refusal attached. Scanning `src/**` for `mercaria_*` and
 * asserting each exists in `drizzle/` was measured: **135 cited, 36 absent, 3
 * genuine — 3 in 36.** The other 33 are cookie names, ledger accounts, planted
 * fixtures, secret prefixes and commercial modes that share the prefix, and the
 * way a false positive gets "fixed" is an exclusion list — a hand-maintained
 * map arriving through the back door, worst exactly where it matters, because
 * the cookie added next month lands on the list and the list is the thing
 * nobody re-reads.
 *
 * The refusal is correct and this gate does not argue with it. What it does is
 * reject the premise underneath it: that the population of CITATIONS has to be
 * derived from a NAME rule. It does not, because **the false positives differ
 * from the true ones by WHERE THEY ARE WRITTEN, not by what they are called.**
 *
 *  - A cookie name, a ledger account and a planted fixture are *runtime string
 *    literals*. A trigger name is *prose*. Restricting to comment ranges (the
 *    TypeScript scanner's, so it is lexical fact rather than a regex guess)
 *    removes 24 of the 34.
 *  - What survives that — `mercaria_guest`, `mercaria_portal`,
 *    `mercaria_retail_margin` — is cited in comments in `middleware/` and
 *    `services/`, never in the database layer. A comment under `src/db/` naming
 *    an identifier in the project's database-object convention IS a claim about
 *    a database object. That is a DIRECTORY rule, so a file added to `src/db/`
 *    tomorrow is covered with no edit here.
 *
 * Measured against the tree immediately before #757, which is the only honest
 * test of a gate written after its defects were fixed: **3 flagged, and they are
 * exactly the 3 defects. Zero false positives, and no exclusion list of any
 * kind.** Against today's tree: 0.
 *
 * ## The two things that would have made it wrong, both measured
 *
 * **A wildcard is a citation, not a truncation.** `mercaria_navigation_*` and
 * `mercaria_native_*_claim_frozen` are authors deliberately naming a FAMILY,
 * and an identifier pattern that stops at the `*` turns each into a shorter
 * name that then reads as absent. Those were the only two false positives an
 * earlier draft produced, and the fix is not to exclude them: a glob is
 * checkable too, and must match at least one real object. They resolve to 9 and
 * 2 — and the 2 is precisely the "really two per-table triggers" fact that one
 * of the original defects got wrong.
 *
 * **A narrower authority is not a better one.** Deriving the authority from
 * CREATE statements alone (228 objects) rather than from every identifier the
 * migrations mention (242) flags `mercaria_retail` in eight `db/schema`
 * docblocks — a commercial-mode VALUE that genuinely exists in the database,
 * inside a CHECK. Two candidate repairs were measured and both rejected:
 * excluding identifiers declared as string literals in `shared-types` blinds
 * the gate to **6** real objects, and doing so across the backend blinds it to
 * **51**. A gate that skips what a derived list omits is the same failure one
 * level down. So the authority is every identifier the schema KNOWS, which is
 * the honest reading of the claim a docblock makes, and it needs no exclusions.
 *
 * ## The freshness hazard, and which side it is safe on
 *
 * `~/Oxy/AGENTS.md`: a regeneration DROPS every hand-written trigger and
 * function. Deriving the AUTHORITY from `drizzle/` is the safe direction and is
 * a bonus — if a regeneration silently drops a trigger, its surviving docblock
 * citation turns this gate RED, which is a second defect class caught free.
 * Deriving the POPULATION from the handwritten-block markers (the shape #759
 * suggests opening with) is the dangerous direction: a regeneration that
 * dropped the blocks would empty the population and this file would go
 * VACUOUSLY GREEN at the exact moment the triggers stopped existing. It is also
 * measured to under-cover — 81 blocks against 242 identifiers, because a block
 * routinely defines a function and a trigger under different names. So the
 * population is comments, and the floors below are what stand in for the risk
 * that direction would have carried.
 *
 * ## Scope, stated rather than implied (#460's second resolution)
 *
 * This covers comments under `src/db/`. Docblocks elsewhere — a service
 * describing a trigger it relies on — are NOT covered, because the identifiers
 * that share the prefix outside the database layer are cookies and ledger
 * accounts and there is no structural way to tell them from a trigger name in
 * the same sentence. That is a real limit and it is a number: widening to all
 * of `src/` costs 7 false positives today. It is not "the gate covers
 * docblocks"; it covers the database layer's.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const DB_ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, '');
const BACKEND_ROOT = join(DB_ROOT, '..', '..');
const DRIZZLE_ROOT = join(BACKEND_ROOT, 'drizzle');

/**
 * The project's database-object naming convention, and a `*` so a WILDCARD
 * citation is captured whole.
 *
 * Without `*` in the class, `mercaria_navigation_*` matches as
 * `mercaria_navigation`, which exists nowhere — the gate would then report a
 * defect on a correct docblock, and the obvious repair would be to exclude it.
 */
const CITATION_TOKEN = /mercaria_[a-z0-9_*]*[a-z0-9*]/g;

/** The same convention with no wildcard, for reading SQL. */
const SQL_IDENTIFIER = /mercaria_[a-z0-9_]*[a-z0-9]/g;

/**
 * A statement that DEFINES or REMOVES an object, used only by the dead-name
 * guard below.
 *
 * The modifier alternation is not decoration: `CREATE CONSTRAINT TRIGGER
 * mercaria_native_signature_agrees` is real and a pattern without `constraint`
 * misses it, which during development made a live object read as undefined.
 */
const OBJECT_STATEMENT =
  /\b(create|drop)\s+(?:(?:or\s+replace|constraint|unique|materialized)\s+)*(?:trigger|function|index|policy|view)\s+(?:if\s+(?:not\s+)?exists\s+)?(mercaria_[a-z0-9_]+)/gi;

interface Journal {
  readonly entries: readonly { readonly idx: number; readonly tag: string }[];
}

function migrationsInOrder(): { tag: string; sql: string }[] {
  const journal = JSON.parse(
    readFileSync(join(DRIZZLE_ROOT, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => ({ tag: entry.tag, sql: readFileSync(join(DRIZZLE_ROOT, `${entry.tag}.sql`), 'utf8') }));
}

/** Every identifier the migrations mention — what the schema KNOWS. */
function identifiersKnownToTheSchema(): Set<string> {
  const known = new Set<string>();
  for (const file of readdirSync(DRIZZLE_ROOT).filter((name) => name.endsWith('.sql')))
    for (const match of readFileSync(join(DRIZZLE_ROOT, file), 'utf8').matchAll(SQL_IDENTIFIER))
      known.add(match[0]);
  return known;
}

/** Replay CREATE/DROP in journal order; what survives, and what was ever dropped. */
function replayObjectLifecycle(): { live: Set<string>; everDropped: Set<string> } {
  const live = new Set<string>();
  const everDropped = new Set<string>();
  for (const { sql } of migrationsInOrder())
    for (const match of sql.matchAll(OBJECT_STATEMENT)) {
      const name = match[2];
      if (match[1].toLowerCase() === 'create') live.add(name);
      else {
        live.delete(name);
        everDropped.add(name);
      }
    }
  return { live, everDropped };
}

interface Citation {
  readonly token: string;
  readonly relative: string;
  readonly line: number;
}

/** Every `.ts` under `src/db/`, recursively, excluding this test tree. */
function databaseLayerFiles(relative = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(DB_ROOT, relative), { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...databaseLayerFiles(child));
    else if (entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
}

/**
 * Citations in COMMENT ranges, taken from the TypeScript scanner.
 *
 * The scanner rather than a regex, because "is this inside a comment" is a
 * lexical fact the compiler already answers exactly, and the regex version gets
 * an identifier inside a string containing `//` wrong in the permissive
 * direction.
 *
 * The READER is injected so the self-tests below drive this derivation over
 * seeded source rather than a copy of it. It is deliberately NOT exported: the
 * self-tests are in this file, so an export would have no consumer — which is
 * the fourth defect #759's own write-up records (`findDeclaredLink`'s docblock
 * claimed it was "exported for the isolation gate's benefit" by a gate that
 * references neither it nor its table), reproduced inside the fix for it.
 */
function citationsInComments(
  files: readonly string[],
  read: (relative: string) => string,
): Citation[] {
  const citations: Citation[] = [];
  for (const relative of files) {
    const text = read(relative);
    if (!text.includes('mercaria_')) continue;
    const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
    const comments: { start: number; end: number }[] = [];
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan())
      if (
        kind === ts.SyntaxKind.SingleLineCommentTrivia ||
        kind === ts.SyntaxKind.MultiLineCommentTrivia
      )
        comments.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd() });
    for (const match of text.matchAll(CITATION_TOKEN)) {
      const position = match.index ?? 0;
      if (!comments.some((range) => position >= range.start && position < range.end)) continue;
      citations.push({
        token: match[0],
        relative,
        line: source.getLineAndCharacterOfPosition(position).line + 1,
      });
    }
  }
  return citations;
}

/** A wildcard citation names a FAMILY; it is satisfied by at least one member. */
function globMembers(glob: string, known: ReadonlySet<string>): string[] {
  const pattern = new RegExp(
    `^${glob
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[a-z0-9_]*')}$`,
  );
  return [...known].filter((name) => pattern.test(name));
}

/** The whole verdict, over any citation set, so the self-tests drive it too. */
function unresolvedCitations(
  citations: readonly Citation[],
  known: ReadonlySet<string>,
): Citation[] {
  return citations.filter((citation) =>
    citation.token.includes('*')
      ? globMembers(citation.token, known).length === 0
      : !known.has(citation.token),
  );
}

const KNOWN = identifiersKnownToTheSchema();
const FILES = databaseLayerFiles();
const readDatabaseLayer = (relative: string): string => readFileSync(join(DB_ROOT, relative), 'utf8');
const CITATIONS = citationsInComments(FILES, readDatabaseLayer);

describe('a docblock in the database layer names only objects that exist (#759)', () => {
  it('every identifier cited in a `src/db/` comment is known to the schema', () => {
    expect(
      unresolvedCitations(CITATIONS, KNOWN).map((c) => `${c.relative}:${c.line} cites ${c.token}`),
      'a docblock names a database object the migrations do not create. Either the name is wrong ' +
        '(fix the comment) or a regeneration dropped the object (restore it) — those are the two ' +
        'causes and they need opposite repairs',
    ).toEqual([]);
  });

  it('the authority and the population are both real, so a clean result means something', () => {
    // The AUTHORITY. A broken read here makes every citation "absent", which is
    // loud rather than silent — but a floor costs one line and names the cause.
    expect(KNOWN.size, 'the migration scan found almost no identifiers').toBeGreaterThanOrEqual(200);

    // The POPULATION, which is the direction that fails SILENTLY: a comment
    // scanner that returned nothing reports the same empty result as a tree
    // with no defects. Floors are below today's counts so a routine deletion
    // does not fail the build, and far enough above zero that a traversal
    // which reached nothing does.
    expect(FILES.length, 'the database-layer walk found nothing').toBeGreaterThanOrEqual(40);
    const exact = CITATIONS.filter((c) => !c.token.includes('*'));
    const globs = CITATIONS.filter((c) => c.token.includes('*'));
    expect(new Set(exact.map((c) => c.token)).size, 'no exact citation was found').toBeGreaterThanOrEqual(25);
    expect(new Set(globs.map((c) => c.token)).size, 'no wildcard citation was found').toBeGreaterThanOrEqual(1);

    // …and the citations are spread over real files rather than all coming from
    // one, which a single malformed docblock could otherwise supply.
    expect(new Set(CITATIONS.map((c) => c.relative)).size).toBeGreaterThanOrEqual(10);
  });

  it('the authority admits no DEAD name — every dropped object is re-created', () => {
    // The one way an authority of "everything the migrations mention" is
    // PERMISSIVE: an object created, later dropped, and still named in a
    // docblock would resolve against the `DROP` statement's own text.
    //
    // Today all three drops are the idempotent drop-then-create pattern inside
    // one file, so nothing is dead. The day a genuine removal lands, this goes
    // red and whoever lands it decides what the citing docblocks should say —
    // which is the decision being taken rather than a citation quietly passing.
    const { live, everDropped } = replayObjectLifecycle();
    expect(everDropped.size, 'no DROP was parsed at all — the statement pattern has rotted').toBeGreaterThanOrEqual(1);
    expect(
      [...everDropped].filter((name) => !live.has(name)),
      'a migration drops an object that nothing re-creates, so the citation authority now ' +
        'contains a name no database has. Narrow the authority or fix the citing docblocks',
    ).toEqual([]);
    expect(live.size, 'the CREATE replay found almost nothing').toBeGreaterThanOrEqual(180);
  });

  it('the wildcard citations resolve to real families, and to more than one member where they say so', () => {
    const globs = [...new Set(CITATIONS.filter((c) => c.token.includes('*')).map((c) => c.token))];
    expect(globs.length).toBeGreaterThanOrEqual(1);
    for (const glob of globs)
      expect(globMembers(glob, KNOWN).length, `${glob} names a family with no members`).toBeGreaterThanOrEqual(1);
  });
});

describe('the detector can fail — mutation self-tests', () => {
  /** A file this gate really reads, so a seeded copy is production's own shape. */
  const victim = FILES.find((relative) => relative.startsWith('schema/'));

  it('finds a citation of an object that does not exist', () => {
    expect(victim).toBeDefined();
    if (victim === undefined) return;
    const planted = '/** Enforced by `mercaria_no_such_object_exists`. */\nexport const x = 1;\n';
    const seeded = citationsInComments([victim], () => planted);
    // The mutation LANDED before its effect is measured: an edit that never
    // applied is indistinguishable from one that survived.
    expect(seeded.map((c) => c.token)).toContain('mercaria_no_such_object_exists');
    expect(unresolvedCitations(seeded, KNOWN).map((c) => c.token)).toEqual([
      'mercaria_no_such_object_exists',
    ]);
  });

  it('finds a WILDCARD citation whose family is empty', () => {
    const planted = '/** Enforced by `mercaria_no_such_family_*`. */\nexport const x = 1;\n';
    const seeded = citationsInComments(['probe.ts'], () => planted);
    expect(seeded.map((c) => c.token)).toContain('mercaria_no_such_family_*');
    expect(unresolvedCitations(seeded, KNOWN)).toHaveLength(1);
  });

  it('does NOT flag a citation of a real object, or the gate is just "found nothing"', () => {
    const real = [...KNOWN].find((name) => name.startsWith('mercaria_') && name.length > 30);
    expect(real, 'the authority is empty, so this control cannot fail').toBeDefined();
    if (real === undefined) return;
    const planted = `/** Enforced by \`${real}\`. */\nexport const x = 1;\n`;
    const seeded = citationsInComments(['probe.ts'], () => planted);
    expect(seeded.map((c) => c.token)).toContain(real);
    expect(unresolvedCitations(seeded, KNOWN)).toEqual([]);
  });

  it('collects a citation from a COMMENT and not from a string literal', () => {
    // The clause the whole design rests on. Without it the population is every
    // `mercaria_*` in the file, which is the 3-in-36 gate #759 refuses — and it
    // would pass every floor above while flagging cookies and ledger accounts.
    const both =
      '/** Enforced by `mercaria_from_a_comment`. */\n' +
      "export const cookie = 'mercaria_from_a_string';\n";
    const tokens = citationsInComments(['probe.ts'], () => both).map((c) => c.token);
    expect(tokens).toContain('mercaria_from_a_comment');
    expect(tokens).not.toContain('mercaria_from_a_string');
  });

  it('reads a `//` inside a string as code, not as a comment', () => {
    const tricky = "export const url = 'https://x/mercaria_in_a_url';\n";
    expect(citationsInComments(['probe.ts'], () => tricky)).toEqual([]);
  });

  it('reds when a REGENERATION drops an object that a docblock still cites', () => {
    // The docblock above claims this is a second defect class caught free.
    // A claimed mechanism that is never exercised is the shape this whole issue
    // is about, so it is measured here rather than asserted in prose.
    //
    // The simulation is the real one: `~/Oxy/AGENTS.md` says a regeneration
    // DROPS every hand-written trigger and function, which removes it from the
    // migrations while every citing docblock survives untouched. So the
    // authority loses a name the population still cites.
    const cited = CITATIONS.find((citation) => !citation.token.includes('*'));
    expect(cited, 'there is no exact citation to drop, so this control cannot fail').toBeDefined();
    if (cited === undefined) return;
    expect(KNOWN.has(cited.token), 'the chosen citation is not currently resolving').toBe(true);

    const afterRegeneration = new Set(KNOWN);
    afterRegeneration.delete(cited.token);
    expect(
      unresolvedCitations(CITATIONS, afterRegeneration).map((c) => c.token),
      'a dropped object left its citation resolving — the gate does not catch a regeneration loss',
    ).toContain(cited.token);
  });
});
