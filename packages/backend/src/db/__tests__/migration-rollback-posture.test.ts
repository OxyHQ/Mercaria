/**
 * Every migration declares what rolling it back takes, and the declaration is
 * checked against its own SQL.
 *
 * ## The census this file is deliberately NOT
 *
 * "Every migration declares a rollback posture" is a requirement satisfied
 * COMPLETELY by declaring every migration irreversible. That census goes green
 * on the first run, reads as thorough, and hands an operator nothing at 3am —
 * a disposition census satisfied by disposing of everything.
 *
 * So the declaration is bound to a derivation, in BOTH directions:
 *
 *   - `derived` is refused on a migration carrying any statement whose inverse
 *     `migrationRollback.ts` cannot produce. You cannot under-claim.
 *   - `restore` / `replay` / `accepted` are refused on a migration whose every
 *     statement HAS a derivable inverse. **You cannot over-claim either.** This
 *     is the direction a declaration census cannot see, and it is exactly the
 *     direction "declare everything irreversible" takes.
 *
 * And a lossy note must NAME an object the migration removes or rewrites, from
 * a set derived from the IRREVERSIBLE statements alone. `restore: from a
 * snapshot` is a sentence anybody can type without opening the file;
 * `restore: orders.settlement_amount and every value in it` is not.
 *
 * ## What the phase marker already answers, and what it does not
 *
 * `-- oxy:deploy-phase=` says which side of a rollout a migration may be
 * applied on. Measured on this corpus, it does NOT predict invertibility: every
 * `post` migration is lossy, as expected — and so is the MAJORITY of the `pre`
 * ones, because a widened CHECK is spelled `DROP CONSTRAINT` + `ADD
 * CONSTRAINT` and the dropped definition is not in the file that dropped it.
 * That gap is the whole reason this gate is not redundant with the phase one,
 * and it is asserted below rather than asserted in prose: `pre` migrations with
 * a loss are floored at a number a coincidence could not reach.
 *
 * ## Nothing here writes to a migration
 *
 * A migration is an applied artefact and a test that edits one is a test that
 * can leave the repository broken — `migration-handwritten-markers.test.ts`'s
 * rule, and it holds here for the same reason. Every mutation is composed in
 * memory and classified through a throwaway directory under the OS temp root,
 * created and removed per call. It goes through the REAL `classifyMigrations`
 * rather than a second in-memory parser: a mutation test against a
 * re-implementation proves the re-implementation can fail.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LOSSY_POSTURES,
  MINIMUM_NOTE_LENGTH,
  ROLLBACK_POSTURES,
  classifyMigrations,
  derivedInverse,
  faults,
  irreversibleStatements,
  objectsAtRisk,
  rollbackMarkerLine,
  verdictOnNote,
  type MigrationRollback,
} from '../migrationRollback.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(HERE, '..', '..', '..', 'drizzle');

const MIGRATIONS = classifyMigrations(DRIZZLE_DIR);

/**
 * A well-formed additive migration, and the base every mutation below starts
 * from. Two statements, both invertible, so it is legally `derived`.
 */
const ADDITIVE = [
  '-- oxy:deploy-phase=pre',
  '-- oxy:rollback=derived',
  'CREATE TABLE "widgets" ("id" text PRIMARY KEY NOT NULL);--> statement-breakpoint',
  'CREATE INDEX "widgets_id_idx" ON "widgets" USING btree ("id");',
  '',
].join('\n');

/**
 * A well-formed LOSSY migration: it drops a constraint whose definition is not
 * here, so it must carry a note, and the note names the constraint.
 */
const LOSSY = [
  '-- oxy:deploy-phase=post',
  '-- oxy:rollback=restore: widgets_kind_check is widened here and its previous form is in an ' +
    'earlier migration; re-adding it fails against rows carrying the added value',
  'ALTER TABLE "widgets" DROP CONSTRAINT "widgets_kind_check";--> statement-breakpoint',
  'ALTER TABLE "widgets" ADD CONSTRAINT "widgets_kind_check" CHECK ("kind" in (\'a\',\'b\'));',
  '',
].join('\n');

/**
 * Classify one in-memory migration through the REAL corpus reader.
 *
 * `classifyMigrations` reads a directory, so the text goes through a throwaway
 * directory holding exactly one file. Removed in a `finally`, so a failing
 * assertion still cleans up.
 */
function classifyText(text: string): MigrationRollback {
  const dir = mkdtempSync(join(tmpdir(), 'mercaria-rollback-'));
  try {
    writeFileSync(join(dir, '0000_probe.sql'), text);
    const [only] = classifyMigrations(dir);
    return only;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the corpus this gate reads', () => {
  it('found the migrations, and found them the same way the journal does', () => {
    // The migration count is floored from a source INDEPENDENT of the
    // declarations: `classifyMigrations` globs the directory, so flooring its
    // own output against itself would be circular. The journal is the other
    // authority, and the three counts have to agree.
    const journal = JSON.parse(
      readFileSync(join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    const onDisk = readdirSync(DRIZZLE_DIR).filter((entry) => entry.endsWith('.sql'));

    expect(journal.entries.length).toBeGreaterThanOrEqual(130);
    expect(onDisk.length).toBe(journal.entries.length);
    expect(MIGRATIONS.length).toBe(journal.entries.length);
  });

  it('read statements out of them, not an empty parse', () => {
    // "Every declaration checks out" is also what a gate reports when it parsed
    // nothing at all, and this one splits text by a literal token.
    const statements = MIGRATIONS.reduce((total, m) => total + m.statements.length, 0);
    expect(statements).toBeGreaterThanOrEqual(3000);
    const invertible = MIGRATIONS.reduce(
      (total, m) => total + m.statements.filter((s) => s.inverse !== null).length,
      0,
    );
    expect(invertible).toBeGreaterThanOrEqual(2800);
  });

  it('finds real losses, in both of the reasons it can report', () => {
    // The floor that makes the `derived` half of the bind non-vacuous: with no
    // irreversible statement anywhere, "no file wrongly claims `derived`" is
    // true of a classifier that returns an inverse for everything.
    const byReason = new Map<string, number>();
    for (const migration of MIGRATIONS) {
      for (const statement of irreversibleStatements(migration)) {
        byReason.set(statement.reason ?? '?', (byReason.get(statement.reason ?? '?') ?? 0) + 1);
      }
    }
    expect(byReason.get('definition_not_in_file') ?? 0).toBeGreaterThanOrEqual(120);
    // Counted separately, because `definition_not_in_file` alone is comfortably
    // over any total floor while the whole `data` branch is dead.
    expect(byReason.get('data') ?? 0).toBeGreaterThanOrEqual(20);
  });

  it('uses BOTH sides of the vocabulary, so neither half of the bind is dead', () => {
    const derived = MIGRATIONS.filter((m) => m.declared === 'derived');
    const lossy = MIGRATIONS.filter(
      (m) => m.declared !== null && (LOSSY_POSTURES as readonly string[]).includes(m.declared),
    );
    // A corpus declared entirely `derived` never exercises the note rule; one
    // declared entirely lossy never exercises the over-claim refusal. Both
    // floors have to hold for the gate below to mean anything.
    expect(derived.length).toBeGreaterThanOrEqual(40);
    expect(lossy.length).toBeGreaterThanOrEqual(60);
    expect(derived.length + lossy.length).toBe(MIGRATIONS.length);
  });

  it('is not measuring the phase marker under another name', () => {
    // The finding that makes this gate worth having. If invertibility tracked
    // the deploy phase, the phase marker would already answer the rollback
    // question and this whole file would be a second spelling of it. It does
    // not: the MAJORITY of the losses are in `pre` migrations, because a
    // widened CHECK is `DROP CONSTRAINT` + `ADD CONSTRAINT` and the dropped
    // definition is not in the file that dropped it.
    const lossyPre = MIGRATIONS.filter(
      (m) =>
        irreversibleStatements(m).length > 0 &&
        /^-- oxy:deploy-phase=pre$/mu.test(readFileSync(join(DRIZZLE_DIR, m.file), 'utf8')),
    );
    expect(lossyPre.length).toBeGreaterThanOrEqual(50);
  });

  it('derives an at-risk set NARROWER than the file, or the note rule is free', () => {
    // The note must name something the migration removes or rewrites. If
    // `objectsAtRisk` returned every identifier in the file, that rule would be
    // satisfied by naming the table the migration created — which is not what
    // was lost. At least one migration must have an at-risk set strictly
    // smaller than its identifier set, and in practice most do.
    const narrower = MIGRATIONS.filter((migration) => {
      const all = new Set(migration.statements.flatMap((statement) => statement.objects));
      return irreversibleStatements(migration).length > 0 && objectsAtRisk(migration).size < all.size;
    });
    expect(narrower.length).toBeGreaterThanOrEqual(30);
  });
});

describe('every migration declares a rollback posture, and the SQL agrees with it', () => {
  it('leaves no migration undeclared, mis-spelled or doubly declared', () => {
    const offenders = MIGRATIONS.filter((m) => m.markerProblems.length > 0).map(
      (m) => `${m.file}: ${m.markerProblems.join('; ')}`,
    );
    expect(
      offenders,
      'Add `-- oxy:rollback=<posture>` beside the file\'s `-- oxy:deploy-phase=` line. ' +
        `Postures: ${ROLLBACK_POSTURES.join(' | ')}. See docs/runbooks/migration-rollback.md.`,
    ).toEqual([]);
  });

  it('classifies every statement, so every declaration is checkable', () => {
    const unclassified = MIGRATIONS.flatMap((m) =>
      irreversibleStatements(m)
        .filter((s) => s.reason === 'unclassified')
        .map((s) => `${m.file}:${s.line} \`${s.text}\``),
    );
    expect(
      unclassified,
      'A statement form `invert()` has no opinion on. Nothing can be checked about a migration ' +
        'carrying one, so teach `invert` what its inverse is — or that there is none.',
    ).toEqual([]);
  });

  it('refuses every declaration the migration\'s own SQL contradicts', () => {
    const offenders = MIGRATIONS.filter((m) => faults(m).length > 0).map(
      (m) => `${m.file}: ${faults(m).join(' | ')}`,
    );
    expect(offenders).toEqual([]);
  });

  it('cites earlier migrations that actually hold the definition', () => {
    // The rule that catches a plausible wrong NUMBER — a note naming the right
    // object and sending an operator to a file that does not contain it. It
    // found eight false citations on the first pass of retrofitting this
    // corpus, which is why it is in the gate rather than in a one-off script.
    const offenders = MIGRATIONS.filter((m) => m.citationProblems.length > 0).map(
      (m) => `${m.file}: ${m.citationProblems.join('; ')}`,
    );
    expect(offenders).toEqual([]);
  });

  it('is reading a corpus that CONTAINS citations, or the rule is free', () => {
    const citations = MIGRATIONS.reduce(
      (total, m) =>
        total + (m.note === null ? 0 : [...m.note.matchAll(/\b\d{4}\b/gu)].length),
      0,
    );
    expect(citations).toBeGreaterThanOrEqual(40);
    // …spread across many files, not forty of them in one note.
    const citing = MIGRATIONS.filter((m) => m.note !== null && /\b\d{4}\b/u.test(m.note));
    expect(citing.length).toBeGreaterThanOrEqual(25);
  });

  it('keeps every marker in the header, ahead of the first statement', () => {
    // A `--` line INSIDE a `$$ … $$` body is body text rather than a comment,
    // so a marker placed there would both be read as a declaration here and
    // become part of the function's own SQL. Requiring it above the first
    // statement puts it somewhere no dollar quote has opened yet.
    const offenders: string[] = [];
    for (const migration of MIGRATIONS) {
      const lines = readFileSync(join(DRIZZLE_DIR, migration.file), 'utf8').split('\n');
      const marker = lines.findIndex((line) => /^-- oxy:rollback=/u.test(line));
      const firstStatement = migration.statements[0]?.line ?? Number.POSITIVE_INFINITY;
      if (marker + 1 >= firstStatement) offenders.push(`${migration.file}: line ${marker + 1}`);
    }
    expect(offenders).toEqual([]);
  });

  it('derives an inverse for every statement it says it can', () => {
    for (const migration of MIGRATIONS) {
      const { statements, omitted } = derivedInverse(migration);
      const invertible = migration.statements.filter((s) => s.inverse !== null);
      expect(statements.length, `${migration.file}`).toBe(invertible.length);
      expect(omitted.length, `${migration.file}`).toBe(
        migration.statements.length - invertible.length,
      );
    }
  });
});

describe('the detectors themselves — mutation self-tests, in memory only', () => {
  it('reports the healthy additive file clean — the positive control', () => {
    const migration = classifyText(ADDITIVE);
    expect(migration.declared).toBe('derived');
    expect(faults(migration)).toEqual([]);
    // The floor on the control: a parse that found no statements reports
    // exactly the same clean result.
    expect(migration.statements).toHaveLength(2);
    expect(irreversibleStatements(migration)).toEqual([]);
  });

  it('reports the healthy lossy file clean — the other positive control', () => {
    const migration = classifyText(LOSSY);
    expect(migration.declared).toBe('restore');
    expect(faults(migration)).toEqual([]);
    expect(irreversibleStatements(migration)).toHaveLength(1);
  });

  it('catches a stripped declaration', () => {
    const mutated = ADDITIVE.split('\n')
      .filter((line) => !line.startsWith('-- oxy:rollback='))
      .join('\n');
    expect(mutated).not.toContain('oxy:rollback');
    expect(faults(classifyText(mutated)).join(' ')).toMatch(/declares no `-- oxy:rollback=` marker/u);
  });

  it('catches TWO declarations, which a "has a marker" check calls healthy', () => {
    const mutated = ADDITIVE.replace(
      '-- oxy:rollback=derived',
      '-- oxy:rollback=derived\n-- oxy:rollback=accepted: something else entirely happened here',
    );
    expect(faults(classifyText(mutated)).join(' ')).toMatch(/declares 2 .* markers/u);
  });

  it('tells a MIS-SPELLED posture from an absent one', () => {
    const mutated = ADDITIVE.replace('-- oxy:rollback=derived', '-- oxy:rollback=derivd');
    const problems = faults(classifyText(mutated)).join(' ');
    expect(problems).toMatch(/is not one of/u);
    // …and specifically NOT the absent-marker message, which would put a typo
    // in the same bucket as a file nobody has touched.
    expect(problems).not.toMatch(/declares no/u);
  });

  it('does NOT read an indented prose mention as a declaration', () => {
    // `0134_red_silver_fox.sql` documents its own verification greps in its
    // header. A `^--\s*` pattern would read such a line as a second marker and
    // fail a compliant file, whose cheapest green is deleting the assertion.
    const mutated = ADDITIVE.replace(
      '-- oxy:rollback=derived',
      '-- oxy:rollback=derived\n--   grep -c \'^-- oxy:rollback\' 0000_probe.sql   -> 1\n--   -- oxy:rollback=accepted would be wrong here',
    );
    const migration = classifyText(mutated);
    expect(migration.markerProblems).toEqual([]);
    expect(migration.declared).toBe('derived');
  });

  // ---- the bind, in the direction a declaration census CAN see -------------

  it('catches `derived` claimed over a statement it cannot invert', () => {
    const mutated = `${ADDITIVE}ALTER TABLE "widgets" DROP CONSTRAINT "widgets_kind_check";\n`;
    const problems = faults(classifyText(mutated)).join(' ');
    expect(problems).toMatch(/declares `derived` but 1 statement\(s\) cannot be inverted/u);
    expect(problems).toMatch(/widgets_kind_check/u);
  });

  it('catches `derived` claimed over a backfill', () => {
    const mutated = `${ADDITIVE}UPDATE "widgets" SET "kind" = 'a' WHERE "kind" IS NULL;\n`;
    expect(faults(classifyText(mutated)).join(' ')).toMatch(/\(data\)/u);
  });

  it('catches a note on `derived`, which has nothing to say', () => {
    const mutated = ADDITIVE.replace(
      '-- oxy:rollback=derived',
      '-- oxy:rollback=derived: the inverse drops widgets and its index',
    );
    expect(faults(classifyText(mutated)).join(' ')).toMatch(/`derived` with a note/u);
  });

  // ---- the bind, in the direction it CANNOT ------------------------------

  it('catches a lossy posture on a migration that loses nothing — every one of them', () => {
    // THE assertion this file exists for. "Declare everything irreversible"
    // satisfies a declaration census completely and is refused here, for each
    // of the three lossy postures rather than for one of them, because a bind
    // wired for `restore` alone is walked around by typing `accepted`.
    for (const posture of LOSSY_POSTURES) {
      const mutated = ADDITIVE.replace(
        '-- oxy:rollback=derived',
        rollbackMarkerLine(
          posture,
          'widgets is gone and only a snapshot from before this ran has it',
        ),
      );
      const problems = faults(classifyText(mutated)).join(' ');
      expect(problems, `\`${posture}\` was accepted on a purely additive migration`).toMatch(
        /every one of its 2 statement\(s\) has a derivable inverse/u,
      );
    }
    // The control that makes the loop mean something: the SAME text with the
    // honest posture is clean, so the refusals above are about the claim rather
    // than about the mutation having broken the file.
    expect(faults(classifyText(ADDITIVE))).toEqual([]);
  });

  it('catches a lossy posture carrying no note at all', () => {
    const mutated = LOSSY.replace(/^-- oxy:rollback=restore:.*$/mu, '-- oxy:rollback=restore');
    expect(mutated).toContain('-- oxy:rollback=restore\n');
    expect(faults(classifyText(mutated)).join(' ')).toMatch(/the note is empty/u);
  });

  it('catches a placeholder note', () => {
    for (const placeholder of ['TBD', 'n/a', 'none', 'unknown', '---']) {
      const mutated = LOSSY.replace(
        /^-- oxy:rollback=restore:.*$/mu,
        `-- oxy:rollback=restore: ${placeholder}`,
      );
      expect(faults(classifyText(mutated)).join(' '), placeholder).toMatch(/placeholder/u);
    }
  });

  it('catches a note too short to say anything', () => {
    const mutated = LOSSY.replace(
      /^-- oxy:rollback=restore:.*$/mu,
      '-- oxy:rollback=restore: it is lost',
    );
    expect(faults(classifyText(mutated)).join(' ')).toMatch(
      new RegExp(`${MINIMUM_NOTE_LENGTH} is the floor`, 'u'),
    );
  });

  it('catches BOILERPLATE — a long, plausible note naming nothing this file touches', () => {
    // The residual fakeable surface, and the rule that closes it. This note is
    // grammatical, specific-sounding, well over the length floor, and could be
    // pasted into all 135 files without opening one of them.
    const mutated = LOSSY.replace(
      /^-- oxy:rollback=restore:.*$/mu,
      '-- oxy:rollback=restore: this change cannot be undone from the migration file; restore ' +
        'the database from a snapshot taken before the deploy',
    );
    const problems = faults(classifyText(mutated)).join(' ');
    expect(problems).toMatch(/names none of the .* objects this migration removes or rewrites/u);
    // …and it NAMES the objects the author should have mentioned, so the
    // failure is actionable rather than a scolding.
    expect(problems).toMatch(/widgets_kind_check/u);
  });

  it('is not satisfied by naming an object the migration merely CREATED', () => {
    // The narrowness of `objectsAtRisk`, asserted rather than assumed: a
    // migration that creates `widgets_created_idx` and drops a constraint must
    // not have its note satisfied by the index it added.
    const text = [
      '-- oxy:deploy-phase=post',
      '-- oxy:rollback=restore: widgets_created_idx is added by this migration and is not what ' +
        'was lost here at all',
      'CREATE INDEX "widgets_created_idx" ON "widgets" USING btree ("created_at");--> statement-breakpoint',
      'ALTER TABLE "widgets" DROP CONSTRAINT "widgets_kind_check";',
      '',
    ].join('\n');
    const migration = classifyText(text);
    expect(objectsAtRisk(migration).has('widgets_created_idx')).toBe(false);
    expect(verdictOnNote(migration).outcome).toBe('refused');
  });

  // ---- the classifier's own branches -------------------------------------

  it('reads a DO block from its body, and fails CLOSED on one that writes', () => {
    const readOnly = [
      '-- oxy:deploy-phase=pre',
      '-- oxy:rollback=derived',
      'DO $$ BEGIN IF (SELECT count(*) FROM "widgets") = 0 THEN RAISE EXCEPTION \'empty\'; END IF; END; $$;',
      '',
    ].join('\n');
    expect(faults(classifyText(readOnly))).toEqual([]);

    const writes = readOnly.replace(
      'RAISE EXCEPTION \'empty\';',
      'UPDATE "widgets" SET "kind" = \'a\';',
    );
    // The mutation APPLIED, which is the difference between a detector that
    // fired and one that was handed the original text.
    expect(writes).toContain('UPDATE "widgets"');
    expect(faults(classifyText(writes)).join(' ')).toMatch(/\(data\)/u);
  });

  it('inverts a FIRST `CREATE OR REPLACE FUNCTION` and refuses a rewrite of one', () => {
    // The distinction is a fact about the CORPUS, not about the statement: a
    // first definition's inverse is a drop, a rewrite's inverse is the previous
    // body, which lives in an earlier file. Driven through the real corpus
    // reader by writing two files into one directory.
    const dir = mkdtempSync(join(tmpdir(), 'mercaria-rollback-fn-'));
    try {
      const body =
        'CREATE OR REPLACE FUNCTION mercaria_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;';
      writeFileSync(
        join(dir, '0000_first.sql'),
        `-- oxy:deploy-phase=pre\n-- oxy:rollback=derived\n${body}\n`,
      );
      writeFileSync(
        join(dir, '0001_second.sql'),
        `-- oxy:deploy-phase=pre\n-- oxy:rollback=derived\n${body}\n`,
      );
      const [first, second] = classifyMigrations(dir);
      expect(first.statements[0].inverse).toBe('DROP FUNCTION mercaria_probe();');
      expect(faults(first)).toEqual([]);
      expect(second.statements[0].inverse).toBeNull();
      expect(second.statements[0].reason).toBe('definition_not_in_file');
      expect(faults(second).join(' ')).toMatch(/cannot be inverted/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unwinds the derived inverse in REVERSE order', () => {
    // A table's constraints are added after it and have to come off before it.
    const text = [
      '-- oxy:deploy-phase=pre',
      '-- oxy:rollback=derived',
      'CREATE TABLE "widgets" ("id" text PRIMARY KEY NOT NULL);--> statement-breakpoint',
      'ALTER TABLE "widgets" ADD CONSTRAINT "widgets_id_fk" FOREIGN KEY ("id") REFERENCES "other"("id");',
      '',
    ].join('\n');
    const { statements } = derivedInverse(classifyText(text));
    expect(statements).toEqual([
      'ALTER TABLE "widgets" DROP CONSTRAINT "widgets_id_fk";',
      'DROP TABLE "widgets";',
    ]);
  });

  it('treats a tightening as invertible and a relaxing as not', () => {
    // `SET NOT NULL` reverses to `DROP NOT NULL`, losslessly — a real answer
    // the phase marker cannot give, since such a migration is `post`. The
    // reverse direction cannot: re-tightening fails against any NULL written
    // since, and an inverse that can fail is not an inverse.
    const tighten = [
      '-- oxy:deploy-phase=post',
      '-- oxy:rollback=derived',
      'ALTER TABLE "widgets" ALTER COLUMN "kind" SET NOT NULL;',
      '',
    ].join('\n');
    expect(faults(classifyText(tighten))).toEqual([]);
    expect(classifyText(tighten).statements[0].inverse).toBe(
      'ALTER TABLE "widgets" ALTER COLUMN "kind" DROP NOT NULL;',
    );

    const relax = tighten.replace('SET NOT NULL', 'DROP NOT NULL');
    expect(faults(classifyText(relax)).join(' ')).toMatch(/\(data\)/u);
  });

  it('checks a citation three ways, and each rule fires on its own', () => {
    // A two-file corpus: `0000` defines the CHECK, `0001` widens it and cites
    // where the previous form lives. Written through `classifyMigrations`
    // because a citation is a fact about the CORPUS and a single-file helper
    // cannot express one.
    const dir = mkdtempSync(join(tmpdir(), 'mercaria-rollback-cite-'));
    try {
      writeFileSync(
        join(dir, '0000_defines.sql'),
        '-- oxy:deploy-phase=pre\n-- oxy:rollback=derived\n' +
          'ALTER TABLE "w" ADD CONSTRAINT "w_kind_check" CHECK ("kind" in (\'a\'));\n',
      );
      // An unrelated earlier migration, so "cites something earlier" and "cites
      // something that holds the definition" are DIFFERENT questions here.
      writeFileSync(
        join(dir, '0001_unrelated.sql'),
        '-- oxy:deploy-phase=pre\n-- oxy:rollback=derived\nCREATE TABLE "z" ("id" text PRIMARY KEY NOT NULL);\n',
      );
      const widen = (note: string): string =>
        `-- oxy:deploy-phase=pre\n-- oxy:rollback=restore: ${note}\n` +
        'ALTER TABLE "w" DROP CONSTRAINT "w_kind_check";\n';
      const classify = (note: string) => {
        writeFileSync(join(dir, '0002_widens.sql'), widen(note));
        return classifyMigrations(dir)[2];
      };

      // The positive control: a TRUE citation is clean.
      expect(
        faults(classify('w_kind_check is widened here; its previous form is in 0000')),
      ).toEqual([]);

      // 1. an index that is not a migration at all
      expect(
        classify('w_kind_check is widened here; its previous form is in 0099')
          .citationProblems.join(' '),
      ).toMatch(/not a migration in this folder/u);

      // 2. an index that is LATER — the `0106` -> `0110` shape, and the one a
      //    "does the file exist" check would call healthy.
      writeFileSync(
        join(dir, '0003_later.sql'),
        '-- oxy:deploy-phase=pre\n-- oxy:rollback=derived\nCREATE TABLE "y" ("id" text PRIMARY KEY NOT NULL);\n',
      );
      expect(
        classify('w_kind_check is widened here; its previous form is in 0003')
          .citationProblems.join(' '),
      ).toMatch(/LATER than this migration/u);

      // 3. a plausible WRONG number: 0001 exists, is earlier, and holds nothing
      //    this migration touches. Neither of the two rules above sees it.
      const wrong = classify('w_kind_check is widened here; its previous form is in 0001');
      expect(wrong.citationProblems.join(' ')).toMatch(/mentions none of the/u);
      expect(wrong.citationProblems.join(' ')).toMatch(/w_kind_check/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has a decided answer for EVERY statement form it claims to know', () => {
    // A branch of `invert` with no case here is inverse SQL nobody has read,
    // and an operator runs this output during an incident. Table-driven so a
    // branch added without a row is visible, and asserted in both directions:
    // what the inverse IS, or which reason says there is none.
    const forms: readonly [string, string | null, string | null][] = [
      // additive — the inverse is a drop of the thing just named
      ['CREATE TABLE "w" ("id" text PRIMARY KEY NOT NULL);', 'DROP TABLE "w";', null],
      ['ALTER TABLE "w" ADD COLUMN "k" text;', 'ALTER TABLE "w" DROP COLUMN "k";', null],
      [
        'ALTER TABLE "w" ADD CONSTRAINT "w_k_check" CHECK ("k" in (\'a\'));',
        'ALTER TABLE "w" DROP CONSTRAINT "w_k_check";',
        null,
      ],
      ['CREATE INDEX "w_k_idx" ON "w" USING btree ("k");', 'DROP INDEX "w_k_idx";', null],
      ['CREATE UNIQUE INDEX "w_k_key" ON "w" USING btree ("k");', 'DROP INDEX "w_k_key";', null],
      ['CREATE SEQUENCE "w_seq" AS bigint START WITH 1;', 'DROP SEQUENCE "w_seq";', null],
      [
        'ALTER TABLE "w" ALTER COLUMN "k" SET NOT NULL;',
        'ALTER TABLE "w" ALTER COLUMN "k" DROP NOT NULL;',
        null,
      ],
      // renames carry BOTH names, so the inverse is the same statement reversed
      ['ALTER TABLE "w" RENAME TO "v";', 'ALTER TABLE "v" RENAME TO "w";', null],
      [
        'ALTER TABLE "w" RENAME COLUMN "k" TO "j";',
        'ALTER TABLE "w" RENAME COLUMN "j" TO "k";',
        null,
      ],
      // the definition that was removed is not in the statement that removed it
      ['ALTER TABLE "w" DROP CONSTRAINT "w_k_check";', null, 'definition_not_in_file'],
      ['DROP INDEX "w_k_idx";', null, 'definition_not_in_file'],
      ['DROP TABLE "w";', null, 'definition_not_in_file'],
      ['DROP SEQUENCE "w_seq";', null, 'definition_not_in_file'],
      ['ALTER TABLE "w" ALTER COLUMN "k" DROP DEFAULT;', null, 'definition_not_in_file'],
      ['ALTER TABLE "w" ALTER COLUMN "k" SET DEFAULT \'a\';', null, 'definition_not_in_file'],
      // rows are destroyed, or the inverse would fail against rows written since
      ['ALTER TABLE "w" DROP COLUMN "k";', null, 'data'],
      ['ALTER TABLE "w" ALTER COLUMN "k" DROP NOT NULL;', null, 'data'],
      ['ALTER TABLE "w" ALTER COLUMN "k" SET DATA TYPE integer;', null, 'data'],
      ['UPDATE "w" SET "k" = \'a\';', null, 'data'],
      ['INSERT INTO "w" ("id") VALUES (\'x\');', null, 'data'],
      ['DELETE FROM "w" WHERE "k" IS NULL;', null, 'data'],
      // nobody has decided
      ['CLUSTER "w" USING "w_k_idx";', null, 'unclassified'],
    ];

    for (const [sql, inverse, reason] of forms) {
      const migration = classifyText(
        `-- oxy:deploy-phase=pre\n-- oxy:rollback=derived\n${sql}\n`,
      );
      expect(migration.statements, sql).toHaveLength(1);
      expect(migration.statements[0].inverse, sql).toBe(inverse);
      expect(migration.statements[0].reason, sql).toBe(reason);
    }

    // The floor on the table itself: a loop over an empty list asserts nothing,
    // and every branch has to be represented on BOTH sides.
    expect(forms.length).toBeGreaterThanOrEqual(22);
    expect(forms.filter(([, inverse]) => inverse !== null).length).toBeGreaterThanOrEqual(9);
    expect(new Set(forms.map(([, , reason]) => reason)).size).toBe(4);
  });

  it('reports an unknown statement form rather than assuming it is additive', () => {
    // The `merge-plan-census` device: a form nobody has decided about fails the
    // build. Assuming "additive" would silently widen what `derived` covers,
    // and assuming "lossy" would silently force a note nobody can write.
    const mutated = `${ADDITIVE}CLUSTER "widgets" USING "widgets_id_idx";\n`;
    expect(faults(classifyText(mutated)).join(' ')).toMatch(/has no opinion on/u);
  });
});
