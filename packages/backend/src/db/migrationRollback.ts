/**
 * What rolling each migration back requires — DERIVED from its own SQL, and
 * bound to a declaration the migration carries.
 *
 * ## The question this answers, and why the phase marker does not answer it
 *
 * `-- oxy:deploy-phase=pre|post` says which side of a rollout a migration is
 * safe to apply on. It says nothing about going BACKWARDS, which is the
 * question somebody actually has during an incident: *we are rolling the image
 * back — do I have to touch the database, and if so, with what?*
 *
 * The two answers differ by phase and the difference is the whole point:
 *
 *   `pre`  — additive, correct against the previous image too. **The rollback
 *            point is the image revision alone: the schema needs nothing.** If
 *            you want the schema back as well, the inverse is derivable.
 *   `post` — took something away, so the previous image is already broken
 *            against this schema. **There is no rollback point past it** until
 *            what it removed is put back, and putting it back is not something
 *            the forward file can tell you how to do.
 *
 * ## Why a declaration alone would be worthless
 *
 * "Every migration declares a rollback posture" is satisfied completely by
 * declaring every migration irreversible. That census goes green, reads as
 * thorough, and tells an operator nothing at 3am. So the declaration is bound
 * to a fact derived from the migration's own statements, in BOTH directions:
 *
 *   - `derived` is refused on a migration carrying any statement whose inverse
 *     this file cannot produce. You cannot under-claim.
 *   - every lossy posture is refused on a migration whose statements are ALL
 *     invertible. You cannot over-claim either — which is the direction a
 *     disposition census cannot see, and the direction "declare everything
 *     irreversible" goes.
 *
 * And a lossy posture's note must NAME an object the migration actually
 * removes or rewrites. `restore: from a snapshot` is boilerplate anybody can
 * type without opening the file; `restore: listings.legacy_options and every
 * value in it` is not.
 *
 * ## Why the inverse is derived from the forward SQL and NOT from the snapshots
 *
 * `meta/<idx>_snapshot.json` records drizzle-kit's model of the schema, and a
 * pair of them would let a differ emit the missing `ADD CONSTRAINT` for every
 * `DROP CONSTRAINT`. It is deliberately not used, for the reason
 * `migration-handwritten-markers.test.ts` exists: a snapshot models tables,
 * columns, CHECKs and indexes and models **no trigger, no function and no
 * backfill**. A differ over that pair would emit confident SQL for the modelled
 * half and silently omit the rest — rollback SQL that is wrong in the way an
 * operator cannot see, run at the worst possible moment. The forward file is
 * what was applied, so it is what is read.
 *
 * ## Nothing here applies anything
 *
 * There is no down-migration runner and this module issues no SQL. It reports.
 * `scripts/rollback-plan.ts` prints the report; the gate asserts the
 * declarations match it. A migration is an applied artefact — the recovery is
 * an operator's decision, and this is the material they make it with.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** What rolling one migration back takes. */
export type RollbackPosture =
  /** Every statement's inverse is derivable from this file. No note. */
  | 'derived'
  /** Something is gone and putting it back is a restore from outside this file. */
  | 'restore'
  /** Something is gone and a named forward path re-derives it. */
  | 'replay'
  /** Something is gone, it is not coming back, and that is the decision. */
  | 'accepted';

/** Every accepted posture, in the order the docs list them. */
export const ROLLBACK_POSTURES: readonly RollbackPosture[] = [
  'derived',
  'restore',
  'replay',
  'accepted',
];

/**
 * The postures that require a note, i.e. every one but `derived`.
 *
 * Derived by SUBTRACTION rather than listed, so a posture added to the tuple
 * above needs a note by default. The safe direction: a new posture that turns
 * out to need no note is a line somebody deletes here on purpose, where a new
 * posture silently exempt from the note rule is the hole this file exists to
 * close.
 */
export const LOSSY_POSTURES: readonly RollbackPosture[] = ROLLBACK_POSTURES.filter(
  (posture) => posture !== 'derived',
);

/**
 * The one accepted spelling: `-- oxy:rollback=<value>`, at column 0, one space.
 *
 * Shaped after `@oxyhq/db`'s own `/^-- oxy:deploy-phase=(.*)$/` on purpose, in
 * two respects that both matter.
 *
 * **No leading-whitespace tolerance.** `0134_red_silver_fox.sql` documents its
 * own verification greps in its header — `--   grep -c '^-- oxy:deploy-phase' …`
 * — and a permissive `^--\s*` would read an indented prose mention of this
 * marker as a second declaration. That is the failure
 * `migration-handwritten-markers.test.ts` measured on the separator token, one
 * marker over.
 *
 * **`(.*)` rather than an alternation over the four postures.** An
 * unrecognised value has to be DISTINGUISHABLE from an absent marker: a typo'd
 * `-- oxy:rollback=derivd` must fail as a bad value, not read as "this
 * migration declares nothing" and land in the same bucket as a file nobody has
 * touched.
 *
 * The note is everything after the first colon. A `derived` marker carries no
 * colon at all — an empty note and an absent one are different facts, and only
 * one of them is legal for `derived`.
 */
const MARKER = /^-- oxy:rollback=(.*)$/u;

/** The one accepted spelling, for a writer rather than a reader. */
export function rollbackMarkerLine(posture: RollbackPosture, note?: string): string {
  return note === undefined
    ? `-- oxy:rollback=${posture}`
    : `-- oxy:rollback=${posture}: ${note}`;
}

/** Why a statement's inverse cannot be produced from this file. */
export type IrreversibleReason =
  /** The definition of what was removed is not in this file. */
  | 'definition_not_in_file'
  /** Rows are destroyed, or rows written since would make the inverse fail. */
  | 'data'
  /** The classifier has no opinion. A decision is owed, not a default. */
  | 'unclassified';

export interface ClassifiedStatement {
  /** 1-based line of the statement's first word, for a message a human can act on. */
  readonly line: number;
  /** The statement, collapsed to one line and truncated for reporting. */
  readonly text: string;
  /** The inverse, when this file carries enough to produce one. */
  readonly inverse: string | null;
  /** Why not, when it does not. */
  readonly reason: IrreversibleReason | null;
  /**
   * The objects this statement acts on, lowercased and unquoted.
   *
   * Collected for every statement, not only the irreversible ones, because the
   * note rule needs the removed set and the floors need the total.
   */
  readonly objects: readonly string[];
}

export interface MigrationRollback {
  /** The `.sql` basename. */
  readonly file: string;
  /** The declared posture, or null when the file declares none. */
  readonly declared: RollbackPosture | null;
  /** The note, or null when there is no colon. `''` when the colon is bare. */
  readonly note: string | null;
  /** Structural faults in the marker itself: none, several, unknown value. */
  readonly markerProblems: readonly string[];
  /**
   * Migrations this note cites by index that do not hold up.
   *
   * Computed in {@link classifyMigrations} rather than in {@link faults},
   * because it is the one question about a note that needs the CORPUS and not
   * just the file.
   */
  readonly citationProblems: readonly string[];
  readonly statements: readonly ClassifiedStatement[];
}

/**
 * A migration index cited inside a note.
 *
 * Four digits, which is the shape every migration filename starts with and a
 * shape nothing else in a note uses: an issue is `#106`, a table is
 * `awin_advertisers`. **An ADR would collide** — `ADR 0004` reads as a citation
 * of `0004_stripe_event_ingress.sql` — so a note names an ADR by its title or
 * its issue, and the runbook says so. No note in this corpus names one.
 */
const CITED_INDEX = /\b(\d{4})\b/gu;

/**
 * One statement's identifiers, in the order they appear.
 *
 * Double-quoted identifiers are what drizzle-kit emits; bare ones are what the
 * hand-written statements use. Both are taken, and both are lowercased, because
 * a note naming `Listings` must satisfy a rule about `listings`.
 */
function identifiersIn(statement: string): string[] {
  const found: string[] = [];
  for (const [, quoted] of statement.matchAll(/"([^"]+)"/gu)) found.push(quoted.toLowerCase());
  for (const [, bare] of statement.matchAll(/\b(mercaria_[a-z0-9_]+)/giu)) {
    found.push(bare.toLowerCase());
  }
  // A trigger's own name, which is the object a note about a replaced trigger
  // has to be allowed to say. It is bare and — unlike the functions — usually
  // NOT `mercaria_`-prefixed (`catalog_source_objects_monotonic`), so the
  // pattern above misses every one of them. Found by the note rule refusing
  // four honest notes once whole-identifier matching landed.
  const trigger = TRIGGER_NAME.exec(statement);
  if (trigger?.groups !== undefined) found.push(trigger.groups.name.replace(/"/gu, '').toLowerCase());
  const fn = FUNCTION_NAME.exec(statement);
  if (fn?.groups !== undefined) found.push(fn.groups.name.toLowerCase());
  return found;
}

/** The trigger a `CREATE`/`DROP TRIGGER` statement names. */
const TRIGGER_NAME =
  /^(?:create(?: constraint)?|drop)\s+trigger\s+(?:if exists\s+)?(?<name>"[^"]+"|[a-z0-9_]+)/iu;

/** The function a `CREATE`/`DROP FUNCTION` statement names. */
const FUNCTION_NAME =
  /^(?:create(?: or replace)?|drop)\s+function\s+(?:if exists\s+)?(?<name>[a-z0-9_]+)/iu;

/**
 * The inverse of one statement, or the reason there is none.
 *
 * Ordered most specific first, because the forms nest: `ALTER TABLE … DROP
 * CONSTRAINT` has to be decided before the `ALTER TABLE … ADD` family, and
 * `CREATE OR REPLACE FUNCTION` before `CREATE FUNCTION`.
 *
 * Every branch that returns an inverse returns SQL a reader can check by eye
 * against the forward statement beside it. Nothing here reconstructs a
 * definition it was not given: that is what `definition_not_in_file` means, and
 * it is the honest answer for `DROP CONSTRAINT`, `DROP INDEX`, `DROP DEFAULT`
 * and `SET DEFAULT` alike.
 */
function invert(normalised: string): { inverse: string | null; reason: IrreversibleReason | null } {
  const sql = normalised.replace(/;\s*$/u, '');
  const lower = sql.toLowerCase();

  // ---- data --------------------------------------------------------------
  // A backfill is not undoable from the statement that performed it: the
  // pre-image is nowhere in the file. This is checked FIRST because an
  // `UPDATE … SET` mentions no DDL keyword the branches below would catch, and
  // an unmatched data statement would fall through to `unclassified` — a
  // decision owed rather than the fact that is already known.
  if (/^(update|insert|delete|truncate)\b/u.test(lower)) {
    return { inverse: null, reason: 'data' };
  }

  // ---- a `DO` block, decided from its BODY --------------------------------
  // Three exist in this corpus and all three are census blocks: a `SELECT …
  // INTO` a local variable, then `RAISE`. Such a block changes nothing, so its
  // inverse is a no-op and that is a derivation rather than an assumption —
  // read off the absence of every keyword that could write.
  //
  // Fail-closed in the direction that matters: a block containing any write
  // keyword ANYWHERE, including inside a `RAISE` message, is `data`. A block
  // whose message happens to contain the word "update" would therefore demand
  // an explicit lossy posture, which is the wrong answer in the harmless
  // direction. `SELECT … INTO` is a plpgsql assignment and is deliberately not
  // a write keyword here; `SELECT INTO` as DDL is not a form drizzle-kit or
  // this repository emits.
  if (/^do\s+\$\$/iu.test(lower)) {
    return /\b(insert|update|delete|truncate|alter|create|drop|grant|revoke)\b/u.test(lower)
      ? { inverse: null, reason: 'data' }
      : { inverse: '-- (no-op: the DO block only reads and raises)', reason: null };
  }

  // ---- removals: the definition is not in this file -----------------------
  // Decided BEFORE the `ALTER TABLE … ADD` family, because the widen-a-CHECK
  // pattern is a `DROP CONSTRAINT` and an `ADD CONSTRAINT` of the SAME name and
  // only the second carries a definition.
  if (/^alter table \S+ drop constraint\b/iu.test(sql)) {
    return { inverse: null, reason: 'definition_not_in_file' };
  }
  if (/^alter table \S+ drop column\b/iu.test(sql)) return { inverse: null, reason: 'data' };
  if (/^drop (index|table|sequence|view|materialized view)\b/iu.test(sql)) {
    return { inverse: null, reason: 'definition_not_in_file' };
  }
  if (/^drop (trigger|function|type)\b/iu.test(sql)) {
    return { inverse: null, reason: 'definition_not_in_file' };
  }
  if (/^alter table \S+ alter column \S+ drop default\b/iu.test(sql)) {
    return { inverse: null, reason: 'definition_not_in_file' };
  }
  if (/^alter table \S+ alter column \S+ set default\b/iu.test(sql)) {
    // The previous default is not in the statement, so the inverse is a guess.
    return { inverse: null, reason: 'definition_not_in_file' };
  }
  if (/^alter table \S+ alter column \S+ drop not null\b/iu.test(sql)) {
    // The inverse tightens, so it fails against any NULL written since. An
    // inverse that can fail is not an inverse.
    return { inverse: null, reason: 'data' };
  }
  if (/^alter table \S+ alter column \S+ (set data type|type)\b/iu.test(sql)) {
    return { inverse: null, reason: 'data' };
  }
  if (/\brename\b/iu.test(lower) && /^alter (table|index|sequence)\b/iu.test(lower)) {
    // Renaming back IS the inverse and is lossless — but the old name is only
    // in the statement for `RENAME TO`, and drizzle-kit also emits
    // `RENAME COLUMN a TO b`. Both carry both names, so this is derivable; it
    // is listed here so the ordering is visible and the corpus decides.
    const renameTable = /^alter table (?<from>"[^"]+"|\S+) rename to (?<to>"[^"]+"|\S+)/iu.exec(sql);
    if (renameTable?.groups !== undefined) {
      return {
        inverse: `ALTER TABLE ${renameTable.groups.to} RENAME TO ${renameTable.groups.from};`,
        reason: null,
      };
    }
    const renameColumn =
      /^alter table (?<table>"[^"]+"|\S+) rename column (?<from>"[^"]+"|\S+) to (?<to>"[^"]+"|\S+)/iu.exec(
        sql,
      );
    if (renameColumn?.groups !== undefined) {
      const { table, from, to } = renameColumn.groups;
      return { inverse: `ALTER TABLE ${table} RENAME COLUMN ${to} TO ${from};`, reason: null };
    }
    return { inverse: null, reason: 'unclassified' };
  }

  // ---- additions: the inverse is a drop of the thing just named -----------
  const createTable = /^create table (?:if not exists )?(?<name>"[^"]+"|\S+)/iu.exec(sql);
  if (createTable?.groups !== undefined) {
    return { inverse: `DROP TABLE ${createTable.groups.name};`, reason: null };
  }
  const addColumn =
    /^alter table (?<table>"[^"]+"|\S+) add column (?:if not exists )?(?<column>"[^"]+"|\S+)/iu.exec(
      sql,
    );
  if (addColumn?.groups !== undefined) {
    const { table, column } = addColumn.groups;
    return { inverse: `ALTER TABLE ${table} DROP COLUMN ${column};`, reason: null };
  }
  const addConstraint =
    /^alter table (?<table>"[^"]+"|\S+) add constraint (?<name>"[^"]+"|\S+)/iu.exec(sql);
  if (addConstraint?.groups !== undefined) {
    const { table, name } = addConstraint.groups;
    return { inverse: `ALTER TABLE ${table} DROP CONSTRAINT ${name};`, reason: null };
  }
  const createIndex =
    /^create (?:unique )?index (?:if not exists )?(?<name>"[^"]+"|\S+)/iu.exec(sql);
  if (createIndex?.groups !== undefined) {
    return { inverse: `DROP INDEX ${createIndex.groups.name};`, reason: null };
  }
  const createSequence = /^create sequence (?:if not exists )?(?<name>"[^"]+"|\S+)/iu.exec(sql);
  if (createSequence?.groups !== undefined) {
    return { inverse: `DROP SEQUENCE ${createSequence.groups.name};`, reason: null };
  }
  if (/^alter table \S+ alter column \S+ set not null\b/iu.test(sql)) {
    const setNotNull =
      /^alter table (?<table>"[^"]+"|\S+) alter column (?<column>"[^"]+"|\S+) set not null/iu.exec(
        sql,
      );
    if (setNotNull?.groups !== undefined) {
      const { table, column } = setNotNull.groups;
      // The forward direction tightens, which is why such a migration is
      // `post`. The BACKWARD direction relaxes, so it is derivable and
      // lossless — a real answer the phase marker cannot give.
      return { inverse: `ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL;`, reason: null };
    }
  }

  // ---- hand-written: derivable only on a FIRST definition -----------------
  const replaceFunction = /^create or replace function (?<name>[a-z0-9_]+)\s*\(/iu.exec(sql);
  if (replaceFunction?.groups !== undefined) {
    // Whether this is a first definition or a rewrite is not in the statement;
    // `classifyMigrations` decides it from the corpus and overwrites this.
    return { inverse: null, reason: 'definition_not_in_file' };
  }
  const createFunction = /^create function (?<name>[a-z0-9_]+)\s*\(/iu.exec(sql);
  if (createFunction?.groups !== undefined) {
    return { inverse: `DROP FUNCTION ${createFunction.groups.name}();`, reason: null };
  }
  const createTrigger =
    /^create (?:constraint )?trigger (?<name>[a-z0-9_"]+)[\s\S]*?\bon (?<table>"[^"]+"|\S+)/iu.exec(
      sql,
    );
  if (createTrigger?.groups !== undefined) {
    const { name, table } = createTrigger.groups;
    return { inverse: `DROP TRIGGER ${name} ON ${table};`, reason: null };
  }

  return { inverse: null, reason: 'unclassified' };
}

/**
 * Split a migration into statements, keeping line numbers.
 *
 * TWO boundaries, and the second is not optional.
 *
 * `--> statement-breakpoint` is what `drizzle-orm/migrator.js` splits on, so it
 * is the boundary the migrator sees. Splitting on THAT ALONE has a blind spot
 * that lies in the dangerous direction, and a mutation self-test found it: a
 * statement appended after one that carries no trailing breakpoint is GLUED to
 * it, so the classifier reads the pair as whichever form came first and the
 * second statement is never classified at all. A `DROP COLUMN` hidden that way
 * would leave a file passing as `derived`. Postgres accepts several statements
 * in one simple query, so nothing fails at apply time either.
 *
 * So a `;` ending a line ALSO closes a statement — but only OUTSIDE a
 * dollar-quoted body, or every `plpgsql` block would come apart into a dozen
 * unclassified fragments. The `$$` walk skips comment lines before reading
 * them, for the reason `migration-handwritten-markers.test.ts` records: a
 * header that merely MENTIONS `$$ LANGUAGE plpgsql;` would otherwise flip the
 * quote state and swallow the rest of the file.
 *
 * A `;` inside a string literal at end of line would mis-split. Nothing in this
 * corpus does it, and the failure is loud rather than silent: the tail becomes
 * an unclassified statement, which is a hard failure naming the line.
 *
 * Comment lines are dropped before the first word is taken, so a header
 * documenting the convention is not read as SQL. The line kept is the one the
 * first non-comment content sits on.
 */
function splitStatements(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = text.split('\n');
  let current: string[] = [];
  let firstLine: number | null = null;
  let insideDollarQuote = false;

  const flush = (): void => {
    if (firstLine === null) {
      current = [];
      return;
    }
    const collapsed = current.join(' ').replace(/\s+/gu, ' ').trim();
    if (collapsed.length > 0) out.push({ line: firstLine, text: collapsed });
    current = [];
    firstLine = null;
  };

  const take = (fragment: string, index: number): void => {
    if (fragment.trim().length === 0) return;
    firstLine ??= index + 1;
    current.push(fragment.trim());
  };

  lines.forEach((raw, index) => {
    // The separator is looked for BEFORE the comment skip, because drizzle-kit
    // emits it on a line of its OWN and that line starts with `--`. Skipping it
    // as a comment silently merges the statement before it into the one after —
    // measured on `0052_abnormal_microbe.sql`, where it hid a
    // `DROP TRIGGER IF EXISTS` inside the preceding `CREATE FUNCTION` and left
    // the file reading as fully invertible.
    const breakpointAt = raw.indexOf('--> statement-breakpoint');
    const content = breakpointAt === -1 ? raw : raw.slice(0, breakpointAt);
    const trimmed = content.trim();
    const isComment = !insideDollarQuote && (trimmed.startsWith('--') || trimmed.length === 0);

    if (isComment) {
      // A comment contributes nothing and its `$$` is deliberately not read —
      // a header quoting `$$ LANGUAGE plpgsql;` would otherwise flip the quote
      // state and swallow the rest of the file. The separator on it still ends
      // the statement above.
      if (breakpointAt !== -1) flush();
      return;
    }

    // Track the quote state across the CONTENT of this line before deciding
    // whether its trailing `;` is a boundary.
    const openedInside = insideDollarQuote;
    const quotes = content.split('$$').length - 1;
    if (quotes % 2 === 1) insideDollarQuote = !insideDollarQuote;

    take(content, index);
    if (breakpointAt !== -1) {
      flush();
      return;
    }
    // A `;` closing a line ends a statement only when the line neither started
    // nor ended inside a body — a `END;` in the middle of a `plpgsql` block
    // starts inside one, and a header line opening `$$` ends inside one.
    if (!openedInside && !insideDollarQuote && content.trimEnd().endsWith(';')) flush();
  });
  flush();
  return out;
}

/** Read the marker, and every way the marker itself can be wrong. */
function readMarker(text: string): Pick<MigrationRollback, 'declared' | 'note' | 'markerProblems'> {
  const problems: string[] = [];
  const matches = text
    .split('\n')
    .map((line) => MARKER.exec(line.replace(/\r$/u, '')))
    .filter((match): match is RegExpExecArray => match !== null);

  if (matches.length === 0) {
    return { declared: null, note: null, markerProblems: ['declares no `-- oxy:rollback=` marker'] };
  }
  if (matches.length > 1) {
    problems.push(`declares ${matches.length} \`-- oxy:rollback=\` markers; exactly one is legal`);
  }

  const raw = matches[0][1];
  const colon = raw.indexOf(':');
  const value = colon === -1 ? raw.trim() : raw.slice(0, colon).trim();
  const note = colon === -1 ? null : raw.slice(colon + 1).trim();
  const declared = (ROLLBACK_POSTURES as readonly string[]).includes(value)
    ? (value as RollbackPosture)
    : null;
  if (declared === null) {
    problems.push(`declares \`${value}\`, which is not one of ${ROLLBACK_POSTURES.join(' | ')}`);
  }
  return { declared, note, markerProblems: problems };
}

/**
 * Classify every migration in `folder`, in filename order.
 *
 * The `CREATE OR REPLACE FUNCTION` correction happens here rather than in
 * `invert`, because whether a replace is a first definition is a fact about the
 * CORPUS and not about the statement. A first definition's inverse is a drop; a
 * rewrite's inverse is the previous body, which lives in an earlier migration
 * and is therefore not in this one.
 */
export function classifyMigrations(folder: string): MigrationRollback[] {
  const files = readdirSync(folder)
    .filter((entry) => entry.endsWith('.sql'))
    .sort();

  const definedBefore = new Set<string>();
  /** index -> lowercased text, for every migration ALREADY walked. */
  const seenText = new Map<string, string>();
  const results: MigrationRollback[] = [];

  for (const file of files) {
    const text = readFileSync(join(folder, file), 'utf8');
    const marker = readMarker(text);
    const definedHere = new Set<string>();

    const statements = splitStatements(text).map(({ line, text: statement }) => {
      let { inverse, reason } = invert(statement);

      const replace = /^create or replace function (?<name>[a-z0-9_]+)\s*\(/iu.exec(statement);
      if (replace?.groups !== undefined && !definedBefore.has(replace.groups.name.toLowerCase())) {
        // Nothing defined it earlier, so `OR REPLACE` is defensive spelling on
        // a first definition and the inverse is a drop.
        inverse = `DROP FUNCTION ${replace.groups.name}();`;
        reason = null;
      }

      // The same question for a trigger, and it is not a nicety: every
      // `CREATE TRIGGER` in this corpus is preceded by a defensive
      // `DROP TRIGGER IF EXISTS`, and reading that as a loss reports a
      // migration that creates a table AND its trigger from scratch as having
      // destroyed something. Measured on `0052_abnormal_microbe.sql` and
      // `0056_many_pepper_potts.sql`, both of which introduce their tables.
      const dropTrigger =
        /^drop\s+trigger\s+(?:if exists\s+)?(?<name>"[^"]+"|[a-z0-9_]+)/iu.exec(statement);
      if (dropTrigger?.groups !== undefined) {
        const name = dropTrigger.groups.name.replace(/"/gu, '').toLowerCase();
        if (!definedBefore.has(name)) {
          inverse = '-- (no-op: nothing before this migration defined that trigger)';
          reason = null;
        }
      }

      for (const pattern of [
        /^create(?: or replace)? function\s+(?<name>[a-z0-9_]+)/iu,
        /^create(?: constraint)? trigger\s+(?<name>"[^"]+"|[a-z0-9_]+)/iu,
      ]) {
        const created = pattern.exec(statement);
        if (created?.groups !== undefined) {
          definedHere.add(created.groups.name.replace(/"/gu, '').toLowerCase());
        }
      }

      return {
        line,
        text: statement.length > 160 ? `${statement.slice(0, 157)}...` : statement,
        inverse,
        reason,
        objects: identifiersIn(statement),
      };
    });

    // Added AFTER the whole file is classified, so a drop-then-create pair
    // inside one migration still reads the drop against what came BEFORE it.
    for (const name of definedHere) definedBefore.add(name);
    const partial: MigrationRollback = { file, ...marker, citationProblems: [], statements };
    results.push({
      ...partial,
      citationProblems: checkCitations(partial, files, seenText),
    });
    seenText.set(file.slice(0, 4), text.toLowerCase());
  }

  return results;
}

/**
 * Does every migration this note cites by index hold up?
 *
 * A note may name the right object and still say something false about where it
 * comes from — "the previous form is in 0032" when it is in 0033 sends an
 * operator to a file that does not contain what they need, during an incident.
 * That half of truthfulness IS checkable, and checking it found EIGHT false
 * citations in the first pass of retrofitting this corpus.
 *
 * Three rules:
 *
 *  1. the index resolves to a migration that exists;
 *  2. it is strictly EARLIER than the citing one — a note explaining what a
 *     LATER migration does names it by issue (`#106`) rather than by index,
 *     because "the previous form is in 0110" from `0106` is a claim about the
 *     past that points at the future;
 *  3. that migration mentions at least one object the citing migration removes
 *     or rewrites. This is the rule that catches a plausible wrong number.
 */
function checkCitations(
  migration: MigrationRollback,
  files: readonly string[],
  seenText: ReadonlyMap<string, string>,
): string[] {
  if (migration.note === null) return [];
  const problems: string[] = [];
  const selfIndex = migration.file.slice(0, 4);
  const known = new Set(files.map((file) => file.slice(0, 4)));
  const atRisk = objectsAtRisk(migration);

  for (const [, index] of migration.note.matchAll(CITED_INDEX)) {
    if (index === selfIndex) continue;
    if (!known.has(index)) {
      problems.push(`cites \`${index}\`, which is not a migration in this folder`);
      continue;
    }
    const earlier = seenText.get(index);
    if (earlier === undefined) {
      problems.push(
        `cites \`${index}\`, which is LATER than this migration. A note about what a later ` +
          `migration does names it by issue (\`#106\`), not by index — an index reads as ` +
          `"where the previous definition lives".`,
      );
      continue;
    }
    if (![...atRisk].some((object) => earlier.includes(object))) {
      problems.push(
        `cites \`${index}\`, which mentions none of the ${atRisk.size} objects this migration ` +
          `removes or rewrites (${[...atRisk].slice(0, 5).join(', ')}${atRisk.size > 5 ? ', …' : ''})`,
      );
    }
  }
  return problems;
}

/** The statements whose inverse this file cannot produce. */
export function irreversibleStatements(
  migration: MigrationRollback,
): readonly ClassifiedStatement[] {
  return migration.statements.filter((statement) => statement.reason !== null);
}

/**
 * Every object an irreversible statement names — the set a lossy note must
 * intersect.
 *
 * Taken from the IRREVERSIBLE statements only. A note satisfied by any
 * identifier anywhere in the file would be satisfied by the name of a table the
 * migration merely created, which is not what was lost.
 */
export function objectsAtRisk(migration: MigrationRollback): Set<string> {
  const names = new Set<string>();
  for (const statement of irreversibleStatements(migration)) {
    for (const object of statement.objects) names.add(object);
  }
  return names;
}

/** Placeholders that are a blank wearing a word. */
const PLACEHOLDER = /^(tbd|todo|n\/?a|none|unknown|see above|-+|\?+)$/iu;

/** The shortest note that can name an object and say something about it. */
export const MINIMUM_NOTE_LENGTH = 24;

/**
 * A STRING discriminant, not `ok: true | false`.
 *
 * This backend compiles with `strict: false`, and without `strictNullChecks`
 * TypeScript does not narrow a union on the TRUTHINESS of a boolean-literal
 * discriminant — `if (!verdict.ok)` leaves the caller holding the whole union
 * and `verdict.problem` fails to compile. Hit here on the first typecheck, as
 * `docs/offer-freshness.md` records it being hit in #68 and #110.
 */
export type NoteVerdict =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'refused'; readonly problem: string };

/**
 * Whether a lossy posture's note says anything checkable.
 *
 * Three rules, and the third is the one that cannot be satisfied without
 * opening the migration: the note must NAME an object the migration removes or
 * rewrites. A generic sentence — "restore from a snapshot", "the data is gone"
 * — is exactly what a declaration census cannot tell from a real answer, and it
 * is what somebody retrofitting 135 files at speed would write.
 */
export function verdictOnNote(migration: MigrationRollback): NoteVerdict {
  const note = migration.note?.trim() ?? '';
  if (note.length === 0) {
    return { outcome: 'refused', problem: 'the note is empty' };
  }
  if (PLACEHOLDER.test(note)) {
    return { outcome: 'refused', problem: `the note is the placeholder \`${note}\`` };
  }
  if (note.length < MINIMUM_NOTE_LENGTH) {
    return {
      outcome: 'refused',
      problem: `the note is ${note.length} characters; ${MINIMUM_NOTE_LENGTH} is the floor`,
    };
  }
  const atRisk = objectsAtRisk(migration);
  const lowered = note.toLowerCase();
  // WHOLE identifiers, not substrings. A mutation self-test found the
  // difference and it is not academic: with a plain `includes`, a note about
  // `widgets_created_idx` — an index the migration ADDED — satisfies a rule
  // about the table `widgets`, because one name contains the other. `_` is a
  // word character in JavaScript, so a `\b`-anchored match refuses exactly
  // that while still matching `widgets.kind` and `widgets,`.
  const named = [...atRisk].filter((object) =>
    new RegExp(`\\b${object.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u').test(lowered),
  );
  if (named.length === 0) {
    return {
      outcome: 'refused',
      problem:
        `the note names none of the ${atRisk.size} objects this migration removes or rewrites ` +
        `(${[...atRisk].slice(0, 6).join(', ')}${atRisk.size > 6 ? ', …' : ''})`,
    };
  }
  return { outcome: 'ok' };
}

/** Everything wrong with one migration's declaration, in the order to read it. */
export function faults(migration: MigrationRollback): string[] {
  const problems = [...migration.markerProblems];
  if (migration.declared === null) return problems;

  const irreversible = irreversibleStatements(migration);
  const unclassified = irreversible.filter((statement) => statement.reason === 'unclassified');

  if (unclassified.length > 0) {
    problems.push(
      `carries ${unclassified.length} statement(s) this classifier has no opinion on, so no ` +
        `declaration about it can be checked: ` +
        unclassified.map((statement) => `line ${statement.line} \`${statement.text}\``).join('; ') +
        `. Teach \`invert\` what the inverse of that form is, or that there is none.`,
    );
    return problems;
  }

  if (migration.declared === 'derived') {
    if (migration.note !== null) {
      problems.push('declares `derived` with a note; `derived` takes none');
    }
    if (irreversible.length > 0) {
      problems.push(
        `declares \`derived\` but ${irreversible.length} statement(s) cannot be inverted from ` +
          `this file: ` +
          irreversible
            .map((statement) => `line ${statement.line} (${statement.reason}) \`${statement.text}\``)
            .join('; '),
      );
    }
    return problems;
  }

  // A lossy posture on a migration that loses nothing. This is the direction a
  // "does every file declare something" census is blind to, and the direction
  // "declare everything irreversible" takes.
  if (irreversible.length === 0) {
    problems.push(
      `declares \`${migration.declared}\` but every one of its ${migration.statements.length} ` +
        `statement(s) has a derivable inverse, so the schema contradicts the claim. Declare ` +
        `\`derived\`.`,
    );
    return problems;
  }

  const verdict = verdictOnNote(migration);
  if (verdict.outcome === 'refused') {
    problems.push(`declares \`${migration.declared}\` and ${verdict.problem}`);
  }
  for (const problem of migration.citationProblems) problems.push(problem);
  return problems;
}

/**
 * The derived inverse of one migration, newest statement first.
 *
 * Reversed because an inverse is unwound in the opposite order to the way it
 * was built: a table's foreign keys are added after it and have to come off
 * before it. This is a REPORT — nothing runs it, and the statements it omits
 * are named beside it rather than left implicit.
 */
export function derivedInverse(migration: MigrationRollback): {
  readonly statements: readonly string[];
  readonly omitted: readonly ClassifiedStatement[];
} {
  const statements = [...migration.statements]
    .reverse()
    .map((statement) => statement.inverse)
    .filter((inverse): inverse is string => inverse !== null);
  return { statements, omitted: irreversibleStatements(migration) };
}
