/**
 * Hand-written migration statements are ANCHORED, and the anchors are checked.
 *
 * drizzle-kit models tables, columns, CHECKs and indexes. It models no trigger,
 * no function and no backfill — so a regeneration silently DROPS every one it
 * finds, and the statement nobody notices is gone is precisely the unmarked
 * one. Three branches in this repository have lost their triggers exactly that
 * way; all three applied cleanly afterwards and enforced nothing.
 *
 * The convention (adopted by ADR 0007's taxonomy branch, gated here):
 *
 *     -- oxy:handwritten-begin=<name>
 *     CREATE OR REPLACE FUNCTION <name>() ...
 *     CREATE TRIGGER <name> ...
 *     -- oxy:handwritten-end=<name>
 *
 * ## Why this file exists rather than the convention alone
 *
 * A marker nothing reads is decoration, and decoration is worse than nothing:
 * it reads as a guarantee. So the gate is the point, and the marker is how it
 * finds what to guard.
 *
 * ## The deploy-phase rule reads `@oxyhq/db`'s OWN parser
 *
 * `readMigrationPhases` is what `migrate.ts` calls at apply time. Re-implementing
 * "exactly one marker" here would be a SECOND authority over one fact, and the
 * two could disagree — with this one green and the deploy failing. Driving the
 * real parser from the journal's tags also catches a tag whose `.sql` is
 * missing, which no regex over a directory listing can see.
 *
 * ## Adoption regressed once already, which is the case for gating it
 *
 * `0083`, `0084` and `0085` carry correct markers. `0086_clever_wasp.sql` has
 * SEVEN unmarked statements and none. A convention adopted for three migrations
 * and then dropped, with nothing to notice, is what a gate is for — and it is
 * why `0086` is on the grandfathered list below rather than being a file
 * somebody remembered to fix.
 *
 * ## Grandfathering, and why the list can only shrink
 *
 * The 48 migrations that predate the convention are allow-listed BY NAME. They
 * are applied and immutable, and retrofitting markers into them is worse than
 * the gap. The list carries an EXACT-COUNT assertion, and each entry is checked
 * to still NEED its exemption — so an entry that stops being necessary fails
 * the build and must be deleted, and a new violation cannot quietly join.
 *
 * The list was DERIVED by the scanner below rather than by a hand-written grep,
 * and that mattered on the first run: a grep for "files containing a trigger"
 * produced 51, and three of them (`0083`, `0084`, `0085`) already carry correct
 * markers. Excusing a file that complies is how an exemption list rots — which
 * is exactly what the expiry assertion caught, on its own first execution.
 *
 * ## What the floors are for
 *
 * "Every statement is marked" is also what a scan that read nothing reports,
 * and this scan reads a directory by glob. So the corpus is floored in three
 * independent ways — files, statements and marked blocks — and every detector
 * carries a mutation self-test against text held in memory. Nothing here
 * mutates a file on disk: a migration is an applied artefact, and a test that
 * edits one is a test that can leave the repository broken.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationPhases } from '@oxyhq/db/migrate';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(HERE, '..', '..', '..');
const DRIZZLE_DIR = join(BACKEND, 'drizzle');

/**
 * A marker line, and nothing that merely mentions one.
 *
 * The name is restricted to an identifier deliberately: a header comment
 * documenting the convention writes `-- oxy:handwritten-begin=<name>` inside
 * backticks, and a permissive pattern would read that prose as an unclosed
 * block. Anchoring at line start is not enough on its own — this is.
 */
const MARKER = /^--\s*oxy:handwritten-(begin|end)=([A-Za-z0-9_]+)\s*$/;

/**
 * The statements drizzle-kit cannot model and therefore drops on a regeneration.
 *
 * `CONSTRAINT` is in the pattern because `CREATE CONSTRAINT TRIGGER` is a real
 * form this repository uses, and a matcher without it does NOT report a clean
 * zero — which is the whole problem. Measured on
 * `0040_equal_sharon_ventura.sql`, the one file carrying the form: 3 constraint
 * triggers, 3 plain triggers, 4 functions, 10 in total. A matcher missing
 * `CONSTRAINT` returns 7; a matcher looking only for `^CREATE TRIGGER` returns
 * 3. Both are plausible, unsuspicious numbers. **A zero invites somebody to
 * look; a plausible count does not**, which is why the floor below is per-FORM
 * rather than a total.
 */
const HANDWRITTEN_STATEMENT = /^\s*create\s+(or\s+replace\s+)?(constraint\s+)?(trigger|function)\b/i;

/**
 * The same matcher WITHOUT the `CONSTRAINT` branch — a control, never a second
 * authority.
 *
 * It exists so the corpus test below can prove the branch is live against real
 * migrations rather than against a synthetic string: if the two matchers ever
 * agree, either the corpus lost its constraint triggers or the real pattern
 * stopped distinguishing them, and both are worth being told about.
 */
const NAIVE_STATEMENT = /^\s*create\s+(or\s+replace\s+)?(trigger|function)\b/i;

/** Which of the three forms one statement is. */
type StatementForm = 'trigger' | 'constraint_trigger' | 'function';

/**
 * What the migrator splits on — the LITERAL string, because that is what it
 * does.
 *
 * `drizzle-orm/migrator.js` is `query.split('--> statement-breakpoint')`: a raw
 * string split, not a line-anchored regex. So a separator anywhere in the file,
 * including mid-line and including inside a function body, splits there. The
 * scan below is a character stream for that reason.
 */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/**
 * Where the separator token appears, and where it appears LEGITIMATELY.
 *
 * The third failure mode, and the one that needs no dollar quote to bite:
 * **quoting the token in PROSE is itself a split point.** `query.split(TOKEN)`
 * runs before anything parses a comment, so a header comment EXPLAINING the
 * convention cuts itself in two and its tail becomes a chunk of its own.
 * Measured live by `w-compat`: adding an explanatory header took a file from
 * 9/9 statements applied to 4/9, while the marker check and the
 * strip-and-compare both stayed green — the latter correctly, since no SQL had
 * changed.
 *
 * The invariant is one line: **every occurrence of the token must END a line.**
 * A separator does; a prose mention does not. Equivalently, the number of
 * chunks the migrator produces is one more than the number of real separators.
 *
 * It complements the dollar-quote check rather than replacing it — that one
 * catches a separator in a place a comment scan never looks, and this one
 * catches a separator the comment scan deliberately skips.
 */
function separatorPositions(text: string): { total: number; endOfLine: number } {
  const total = text.split(STATEMENT_BREAKPOINT).length - 1;
  const endOfLine = text
    .split('\n')
    .filter((line) => line.trimEnd().endsWith(STATEMENT_BREAKPOINT)).length;
  return { total, endOfLine };
}

/**
 * Every separator that falls INSIDE a dollar-quoted body, plus the quote state
 * the walk ended in.
 *
 * This is the failure mode that does not announce itself. A separator between a
 * `CREATE FUNCTION`'s header and its `$$ … $$` body splits the function in half
 * — the migrator splits before anything is parsed, so BOTH halves fail — and it
 * presents as a syntax error in the author's own SQL, which sends them looking
 * at the wrong thing.
 *
 * ## A `--` line OUTSIDE a body is skipped WITHOUT reading its `$$`
 *
 * That order is the whole correctness of this function. A header comment that
 * merely MENTIONS `$$ LANGUAGE plpgsql;` — which any file documenting its own
 * hand-written block might — flips the quote state if the walk reads it, and
 * every later line is then treated as body text. The gate would report a false
 * offender on a file whose SQL is untouched, which is worse than reporting
 * nothing: it fails a correct file, and the cheapest green is deleting the
 * assertion.
 *
 * No file in the corpus mentions `$$` in a comment TODAY, so this scanner was
 * correct by nobody having written that comment yet. That is not a property,
 * which is why the order is stated here and controlled BOTH WAYS by a test.
 *
 * A plain toggle on `$$` is otherwise exact here, verified rather than assumed:
 * this repository uses NO tagged dollar quotes (`$name$`) anywhere, every file
 * ends outside a body, the count is exactly twice the number of
 * `CREATE FUNCTION` statements (288 = 144 x 2), and no `$$` appears inside a
 * string literal. If a tagged quote ever lands, the balance result below is
 * what would notice.
 */
function scanDollarQuoting(text: string): {
  breakpointsInsideBody: number[];
  dollarQuotes: number;
  balanced: boolean;
} {
  const breakpointsInsideBody: number[] = [];
  let dollarQuotes = 0;
  let inside = false;

  text.split('\n').forEach((line, index) => {
    if (!inside && line.trimStart().startsWith('--')) return;
    let at = 0;
    while (at < line.length) {
      if (line.startsWith('$$', at)) {
        inside = !inside;
        dollarQuotes += 1;
        at += 2;
        continue;
      }
      if (line.startsWith(STATEMENT_BREAKPOINT, at)) {
        if (inside) breakpointsInsideBody.push(index + 1);
        at += STATEMENT_BREAKPOINT.length;
        continue;
      }
      at += 1;
    }
  });

  // Ending INSIDE a body is the unbalanced case, and it is the same fact an odd
  // count reports — read off the walk that already skipped comments rather than
  // from a second count that has not.
  return { breakpointsInsideBody, dollarQuotes, balanced: !inside };
}

interface MarkedBlock {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
}

interface MarkerScan {
  readonly blocks: readonly MarkedBlock[];
  /** Structural faults: an orphan, a mismatch, an unclosed block. */
  readonly problems: readonly string[];
  /** Statements sitting outside every block, by line number. */
  readonly unmarked: readonly { line: number; text: string }[];
  readonly statementCount: number;
  /**
   * Counted PER FORM, because a total cannot fail when one branch of the
   * matcher goes dead — the corpus is large enough that 250 statements is
   * comfortable with every constraint trigger missing.
   */
  readonly forms: Readonly<Record<StatementForm, number>>;
}

/**
 * Walk one file, pairing markers on a stack and placing every statement.
 *
 * A STACK rather than a flat pair count, because "seven begins and seven ends"
 * is satisfied by seven begins followed by seven ends with every statement
 * between the fourth and fifth — which is nested wrongly and marks nothing it
 * claims to. Nesting is permitted (a block inside a block is legible); crossing
 * is not.
 */
// NOT exported. Importing a `.test.ts` file registers its suites in the
// importer, so a value exported from one is an invitation to run this whole
// gate twice under another file's name. Nothing outside this file needs it.
function scanHandwrittenMarkers(text: string): MarkerScan {
  const lines = text.split('\n');
  const blocks: MarkedBlock[] = [];
  const problems: string[] = [];
  const unmarked: { line: number; text: string }[] = [];
  const open: { name: string; line: number }[] = [];
  let statementCount = 0;
  const forms: Record<StatementForm, number> = {
    trigger: 0,
    constraint_trigger: 0,
    function: 0,
  };

  lines.forEach((raw, index) => {
    const line = index + 1;
    const marker = MARKER.exec(raw.replace(/\r$/u, ''));
    if (marker !== null) {
      const [, kind, name] = marker;
      if (kind === 'begin') {
        open.push({ name, line });
        return;
      }
      const top = open.pop();
      if (top === undefined) {
        problems.push(`line ${line}: \`end=${name}\` closes nothing.`);
        return;
      }
      if (top.name !== name) {
        problems.push(
          `line ${line}: \`end=${name}\` closes \`begin=${top.name}\` (opened at line ${top.line}).`,
        );
        return;
      }
      blocks.push({ name, startLine: top.line, endLine: line });
      return;
    }

    // A commented-out statement is not a statement. Checked BEFORE the
    // statement pattern, or every line of prose describing a trigger would be
    // reported as an unmarked one.
    if (raw.trimStart().startsWith('--')) return;
    const statement = HANDWRITTEN_STATEMENT.exec(raw);
    if (statement === null) return;
    statementCount += 1;
    const [, , constraint, kind] = statement;
    if (kind.toLowerCase() === 'function') forms.function += 1;
    else if (constraint !== undefined) forms.constraint_trigger += 1;
    else forms.trigger += 1;
    if (open.length === 0) unmarked.push({ line, text: raw.trim() });
  });

  for (const dangling of open) {
    problems.push(`line ${dangling.line}: \`begin=${dangling.name}\` is never closed.`);
  }

  return { blocks, problems, unmarked, statementCount, forms };
}

/**
 * Migrations written before the convention was adopted.
 *
 * They are APPLIED and immutable; retrofitting markers into them would edit
 * history to satisfy a gate, which is worse than the gap it papers over. Every
 * entry is asserted to still need its exemption, so the list can only shrink.
 *
 * NOTHING MAY BE ADDED HERE. A new migration carrying an unmarked trigger is
 * the failure this file exists to catch, and allow-listing it is the one repair
 * that puts the failure back.
 */
const PRE_MARKER_MIGRATIONS: readonly string[] = [
  '0002_payment_domain.sql',
  '0006_tag_search_stemming.sql',
  '0014_fantastic_patriot.sql',
  '0016_volatile_wiccan.sql',
  '0017_far_smasher.sql',
  '0018_nappy_makkari.sql',
  '0019_short_corsair.sql',
  '0021_lumpy_boom_boom.sql',
  '0023_ambitious_proemial_gods.sql',
  '0024_greedy_wendigo.sql',
  '0026_marvelous_bill_hollister.sql',
  '0027_equal_blonde_phantom.sql',
  '0028_long_cyclops.sql',
  '0029_classy_the_order.sql',
  '0030_giant_energizer.sql',
  '0031_cynical_penance.sql',
  '0032_legal_dark_beast.sql',
  '0033_material_spirit.sql',
  '0034_closed_tattoo.sql',
  '0038_square_ironclad.sql',
  '0039_nappy_orphan.sql',
  '0040_equal_sharon_ventura.sql',
  '0042_fat_xavin.sql',
  '0043_quiet_lenny_balinger.sql',
  '0045_soft_groot.sql',
  '0046_fuzzy_captain_flint.sql',
  '0048_small_mandroid.sql',
  '0049_cultured_speedball.sql',
  '0050_redundant_the_enforcers.sql',
  '0052_abnormal_microbe.sql',
  '0053_public_living_mummy.sql',
  '0054_bizarre_pixie.sql',
  '0056_many_pepper_potts.sql',
  '0057_acoustic_sphinx.sql',
  '0059_icy_dragon_man.sql',
  '0060_colorful_speed_demon.sql',
  '0061_swift_talos.sql',
  '0063_yielding_secret_warriors.sql',
  '0064_vengeful_colleen_wing.sql',
  '0065_purple_human_cannonball.sql',
  '0066_clear_slapstick.sql',
  '0067_hard_nightmare.sql',
  '0076_left_wolf_cub.sql',
  '0077_fearless_black_bird.sql',
  '0079_purple_dust.sql',
  '0081_faithful_misty_knight.sql',
  '0082_dry_king_bedlam.sql',
  '0086_clever_wasp.sql',
];

/**
 * Every migration this package ships.
 *
 * This briefly also read a `catalogLocalization.pending.sql` — the file #367
 * step 2 held while ADR 0007 D11 serialized the migration slot, so the
 * marked-block floor below had something to count before the slot was granted.
 * That file became `0091` and was deleted in the same commit, which is what the
 * two-copies rule requires; the floor is now met by the migration itself.
 */
function sqlFiles(): { name: string; path: string; text: string }[] {
  return readdirSync(DRIZZLE_DIR)
    .filter((entry) => entry.endsWith('.sql'))
    .map((entry) => ({
      name: entry,
      path: join(DRIZZLE_DIR, entry),
      text: readFileSync(join(DRIZZLE_DIR, entry), 'utf8'),
    }));
}

const FILES = sqlFiles();
const SCANS = FILES.map((file) => ({ ...file, scan: scanHandwrittenMarkers(file.text) }));

describe('the corpus this gate reads', () => {
  it('found the migrations, not an empty directory', () => {
    // "Every statement is marked" is also what a scan that read nothing
    // reports, and this one reads a directory by glob.
    expect(FILES.length).toBeGreaterThanOrEqual(92);
    const statements = SCANS.reduce((total, file) => total + file.scan.statementCount, 0);
    expect(statements).toBeGreaterThanOrEqual(250);
    const blocks = SCANS.reduce((total, file) => total + file.scan.blocks.length, 0);
    expect(blocks).toBeGreaterThanOrEqual(4);
  });

  it('exercises EVERY form of the matcher, not just the common one', () => {
    // The floor that can actually fail. A total of 250 is satisfied comfortably
    // while the `CONSTRAINT` branch is dead, because ONE file on `main` carries
    // that form — so a total floor would go on reporting a healthy corpus while
    // three statements went unguarded. Per form, the branch has to be live.
    const totals = SCANS.reduce(
      (sum, file) => ({
        trigger: sum.trigger + file.scan.forms.trigger,
        constraint_trigger: sum.constraint_trigger + file.scan.forms.constraint_trigger,
        function: sum.function + file.scan.forms.function,
      }),
      { trigger: 0, constraint_trigger: 0, function: 0 },
    );
    expect(totals.trigger, 'no plain CREATE TRIGGER found').toBeGreaterThan(0);
    expect(totals.function, 'no CREATE FUNCTION found').toBeGreaterThan(0);
    expect(
      totals.constraint_trigger,
      'No CREATE CONSTRAINT TRIGGER found. Either the corpus lost the form or the matcher ' +
        'stopped recognising it — and the second reads as a healthy total.',
    ).toBeGreaterThan(0);
  });

  it('finds strictly more than a matcher without the CONSTRAINT branch', () => {
    // The mutation test against REAL migrations rather than a synthetic string.
    // Measured on 0040_equal_sharon_ventura.sql: full 10, naive 7 — the naive
    // number is plausible and wrong, which is the failure this whole gate is
    // shaped around.
    const naive = SCANS.reduce((total, file) => {
      const lines = file.text.split('\n').filter((line) => !line.trimStart().startsWith('--'));
      return total + lines.filter((line) => NAIVE_STATEMENT.test(line)).length;
    }, 0);
    const full = SCANS.reduce((total, file) => total + file.scan.statementCount, 0);
    const constraintTriggers = SCANS.reduce(
      (total, file) => total + file.scan.forms.constraint_trigger,
      0,
    );
    expect(full).toBeGreaterThan(naive);
    // Exactly the constraint triggers, not merely "more": a difference of any
    // other size means the two matchers disagree about something nobody meant.
    expect(full - naive).toBe(constraintTriggers);
  });

  it('reads a file it can actually parse', () => {
    for (const file of SCANS) {
      expect(file.text.length, `${file.name} is empty`).toBeGreaterThan(0);
    }
  });
});

describe('hand-written statements are anchored', () => {
  it('leaves no CREATE TRIGGER or CREATE FUNCTION outside a marked block', () => {
    const offenders = SCANS.filter(
      (file) => !PRE_MARKER_MIGRATIONS.includes(file.name) && file.scan.unmarked.length > 0,
    ).map(
      (file) =>
        `${file.name}: ${file.scan.unmarked
          .map((statement) => `line ${statement.line} \`${statement.text}\``)
          .join(', ')}`,
    );
    expect(
      offenders,
      'A statement drizzle-kit cannot model, sitting outside an `-- oxy:handwritten-begin=<name>` ' +
        '/ `-- oxy:handwritten-end=<name>` pair. A regeneration DROPS it silently. Anchor it — do ' +
        'NOT add the file to PRE_MARKER_MIGRATIONS.',
    ).toEqual([]);
  });

  it('pairs every marker, in every file, grandfathered or not', () => {
    // Applied to the allow-listed files TOO: an old migration is excused from
    // HAVING markers, never from using them correctly if it grows some.
    const faults = SCANS.filter((file) => file.scan.problems.length > 0).map(
      (file) => `${file.name}: ${file.scan.problems.join(' ')}`,
    );
    expect(faults).toEqual([]);
  });

  it('gives every block a name that is used once per file', () => {
    for (const file of SCANS) {
      const names = file.scan.blocks.map((block) => block.name);
      expect(new Set(names).size, `${file.name} reuses a block name`).toBe(names.length);
    }
  });
});

describe('statement separators', () => {
  it('puts no `--> statement-breakpoint` inside a dollar-quoted body', () => {
    const offenders = SCANS.filter(
      (file) => scanDollarQuoting(file.text).breakpointsInsideBody.length > 0,
    ).map(
      (file) =>
        `${file.name}: lines ${scanDollarQuoting(file.text).breakpointsInsideBody.join(', ')}`,
    );
    expect(
      offenders,
      'A separator between a function header and its `$$ … $$` body splits the function in half. ' +
        'It presents as a syntax error in your own SQL rather than as a separator problem.',
    ).toEqual([]);
  });

  it('quotes the separator token nowhere but at the end of a statement', () => {
    const offenders = SCANS.map((file) => ({ name: file.name, ...separatorPositions(file.text) }))
      .filter((file) => file.total !== file.endOfLine)
      .map((file) => `${file.name}: ${file.total} occurrences but ${file.endOfLine} real separators`);
    expect(
      offenders,
      'The migrator splits on this token before anything parses a comment, so a prose mention ' +
        'of it cuts the file at that point and the rest becomes its own chunk. Measured: an ' +
        'explanatory header took a real migration from 9/9 statements applied to 4/9, with every ' +
        'other check still green.',
    ).toEqual([]);
  });

  it('is reading files that actually carry separators', () => {
    // The floor for the assertion above: a corpus with no separators satisfies
    // `total === endOfLine` everywhere, trivially.
    const carrying = SCANS.filter((file) => separatorPositions(file.text).total > 0);
    expect(carrying.length).toBeGreaterThanOrEqual(40);
    const separators = SCANS.reduce((total, file) => total + separatorPositions(file.text).total, 0);
    expect(separators).toBeGreaterThanOrEqual(500);
  });

  it('pairs every dollar quote', () => {
    const unbalanced = SCANS.filter((file) => !scanDollarQuoting(file.text).balanced).map(
      (file) => file.name,
    );
    expect(unbalanced).toEqual([]);
  });

  it('is reading real function bodies, not a corpus without any', () => {
    // The floor for the two assertions above: both are trivially satisfied by a
    // corpus containing no `$$` at all.
    const dollars = SCANS.reduce((total, file) => total + scanDollarQuoting(file.text).dollarQuotes, 0);
    expect(dollars).toBeGreaterThanOrEqual(200);
  });
});

describe('the grandfathered list', () => {
  it('holds exactly the files it was calibrated for', () => {
    // EXACT, not a minimum: a list a new violation can quietly join is not a
    // gate, and this is the assertion that makes adding one a decision somebody
    // has to write down and defend in a diff.
    expect(PRE_MARKER_MIGRATIONS).toHaveLength(48);
    expect(new Set(PRE_MARKER_MIGRATIONS).size).toBe(PRE_MARKER_MIGRATIONS.length);
  });

  it('names only files that exist and still need the exemption', () => {
    const byName = new Map(SCANS.map((file) => [file.name, file]));
    for (const name of PRE_MARKER_MIGRATIONS) {
      const file = byName.get(name);
      expect(file, `${name} is allow-listed and does not exist`).toBeDefined();
      // The exemption EXPIRES. If somebody anchors an old migration's
      // statements after all, this line goes red and the entry is deleted
      // rather than left behind excusing nothing.
      expect(
        file.scan.unmarked.length,
        `${name} no longer has an unmarked statement — delete it from PRE_MARKER_MIGRATIONS ` +
          'and drop the count by one.',
      ).toBeGreaterThan(0);
    }
  });
});

describe('the deploy-phase marker', () => {
  it('is exactly one per migration, read by the parser the migrator uses', () => {
    const journal = JSON.parse(
      readFileSync(join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags.length).toBeGreaterThanOrEqual(88);

    // `@oxyhq/db`'s own reader, not a second regex: it is what `migrate.ts`
    // calls at apply time, so this gate and the deploy cannot disagree. It also
    // reports a journal tag whose `.sql` is missing, which a directory scan
    // cannot see.
    const { phases, problems } = readMigrationPhases(tags, DRIZZLE_DIR);
    expect(problems).toEqual([]);
    expect(phases.size).toBe(tags.length);
  });
});

describe('the detectors themselves — mutation self-tests, in memory only', () => {
  /** A minimal, well-formed migration. Every mutation below starts from this. */
  const HEALTHY = [
    '-- oxy:deploy-phase=pre',
    'CREATE TABLE "x" ("id" text PRIMARY KEY NOT NULL);',
    '-- oxy:handwritten-begin=mercaria_x_guard',
    'CREATE OR REPLACE FUNCTION mercaria_x_guard()',
    'RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;',
    'CREATE TRIGGER mercaria_x_guard BEFORE UPDATE ON "x"',
    'FOR EACH ROW EXECUTE FUNCTION mercaria_x_guard();',
    '-- oxy:handwritten-end=mercaria_x_guard',
    '',
  ].join('\n');

  it('reports a healthy file clean — the positive control', () => {
    const scan = scanHandwrittenMarkers(HEALTHY);
    expect(scan.problems).toEqual([]);
    expect(scan.unmarked).toEqual([]);
    expect(scan.blocks).toHaveLength(1);
    // The floor on the control itself: a scan finding no statements would
    // report exactly the same clean result.
    expect(scan.statementCount).toBe(2);
  });

  it('catches a stripped `end` marker', () => {
    const mutated = HEALTHY.split('\n')
      .filter((line) => !line.startsWith('-- oxy:handwritten-end='))
      .join('\n');
    const scan = scanHandwrittenMarkers(mutated);
    expect(scan.problems.join(' ')).toMatch(/is never closed/u);
  });

  it('catches a stripped `begin` marker, and the statements it stops guarding', () => {
    const mutated = HEALTHY.split('\n')
      .filter((line) => !line.startsWith('-- oxy:handwritten-begin='))
      .join('\n');
    const scan = scanHandwrittenMarkers(mutated);
    expect(scan.problems.join(' ')).toMatch(/closes nothing/u);
    // Both halves matter: the orphan is the loud symptom, and the two now
    // unguarded statements are the actual damage.
    expect(scan.unmarked).toHaveLength(2);
  });

  it('catches a mismatched pair, which a begin/end COUNT would call healthy', () => {
    const mutated = HEALTHY.replace(
      '-- oxy:handwritten-end=mercaria_x_guard',
      '-- oxy:handwritten-end=mercaria_y_guard',
    );
    const scan = scanHandwrittenMarkers(mutated);
    expect(scan.problems.join(' ')).toMatch(/closes `begin=mercaria_x_guard`/u);
  });

  it('catches a statement that simply sits outside every block', () => {
    const mutated = `${HEALTHY}CREATE TRIGGER mercaria_stray BEFORE INSERT ON "x" FOR EACH ROW EXECUTE FUNCTION mercaria_x_guard();\n`;
    const scan = scanHandwrittenMarkers(mutated);
    expect(scan.problems).toEqual([]);
    expect(scan.unmarked).toHaveLength(1);
    expect(scan.unmarked[0].text).toMatch(/mercaria_stray/u);
  });

  it('catches a CONSTRAINT trigger, which the obvious pattern misses', () => {
    const mutated = `${HEALTHY}CREATE CONSTRAINT TRIGGER mercaria_deferred AFTER INSERT ON "x" DEFERRABLE FOR EACH ROW EXECUTE FUNCTION mercaria_x_guard();\n`;
    const scan = scanHandwrittenMarkers(mutated);
    expect(scan.unmarked).toHaveLength(1);
  });

  it('accepts BOTH live naming forms, and requires neither', () => {
    // `0083`-`0085` name their blocks unprefixed (`referral_tax_profiles_append_only`);
    // `0088` and after use the `mercaria_`-prefixed form matching the function,
    // which makes the rebase protocol's "grep for each trigger/function pair"
    // one grep. Both are in `main` and this gate checks PAIRING and UNIQUENESS,
    // never a name shape — a convention worth having is not worth a gate that
    // fails a compliant file over its spelling.
    const unprefixed = HEALTHY.split('mercaria_x_guard').join('plain_block_name');
    expect(scanHandwrittenMarkers(unprefixed).problems).toEqual([]);
    expect(scanHandwrittenMarkers(unprefixed).unmarked).toEqual([]);
    expect(scanHandwrittenMarkers(unprefixed).blocks[0].name).toBe('plain_block_name');
    // …and the prefixed one, which is the same assertion from the other side.
    expect(scanHandwrittenMarkers(HEALTHY).blocks[0].name).toBe('mercaria_x_guard');
  });

  it('catches a separator hidden inside a function body', () => {
    // A REPLACER FUNCTION, never a replacement string. `String.replace` treats
    // `$$` in a replacement string as an escaped `$`, so the obvious spelling
    // silently halves every dollar quote in the mutation — the toggle then never
    // opens, the checker reports zero, and the mutation test passes by having
    // never applied. Caught here by asserting the MUTATED result rather than
    // only the healthy one.
    const mutated = HEALTHY.replace(
      'RETURNS trigger AS $$ BEGIN RETURN NEW;',
      () => 'RETURNS trigger AS $$ BEGIN--> statement-breakpoint\n RETURN NEW;',
    );
    // The mutation APPLIED — dollar quotes intact, separator present.
    expect(mutated).toContain('$$ BEGIN--> statement-breakpoint');
    expect(mutated.split('$$').length - 1).toBe(2);
    expect(scanDollarQuoting(mutated).breakpointsInsideBody).toHaveLength(1);
    // …and the healthy file has none, which is the control that makes the line
    // above mean something.
    expect(scanDollarQuoting(HEALTHY).breakpointsInsideBody).toEqual([]);
  });

  it('is not desynced by a comment that MENTIONS a dollar quote — both directions', () => {
    // The exact shape that produces a false offender: a header comment quoting
    // `$$ LANGUAGE plpgsql;`, then real SQL with a legitimate separator after it.
    const documented = [
      '-- oxy:deploy-phase=pre',
      '-- Each block ends with `$$ LANGUAGE plpgsql;` and a separator after it.',
      'CREATE OR REPLACE FUNCTION mercaria_x_guard()',
      'RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;--> statement-breakpoint',
      'CREATE TRIGGER mercaria_x_guard BEFORE UPDATE ON "x" FOR EACH ROW EXECUTE FUNCTION mercaria_x_guard();',
      '',
    ].join('\n');

    // WITH the comment skipped first: clean, and the two real quotes counted.
    const scan = scanDollarQuoting(documented);
    expect(scan.breakpointsInsideBody).toEqual([]);
    expect(scan.balanced).toBe(true);
    expect(scan.dollarQuotes).toBe(2);

    // The OTHER direction — the control that makes the line above mean
    // something. A walk that reads the comment's `$$` first sees three quotes,
    // ends inside a body, and reports the legitimate separator as an offender.
    const naive = (text: string): number => {
      let inside = false;
      let found = 0;
      for (let at = 0; at < text.length; at += 1) {
        if (text.startsWith('$$', at)) { inside = !inside; at += 1; continue; }
        if (text.startsWith(STATEMENT_BREAKPOINT, at) && inside) found += 1;
      }
      return found;
    };
    expect(naive(documented)).toBeGreaterThan(0);
  });

  it('catches the token quoted in PROSE, which no other check sees', () => {
    // The header comment that explains the convention and thereby breaks the
    // file. Note the dollar-quote walk SKIPS this line as a comment — correctly
    // — which is exactly why this assertion is not redundant with it.
    const documented = [
      '-- oxy:deploy-phase=pre',
      '-- Each statement is followed by `--> statement-breakpoint`, like so.',
      'CREATE TABLE "x" ("id" text PRIMARY KEY NOT NULL);--> statement-breakpoint',
      'CREATE TABLE "y" ("id" text PRIMARY KEY NOT NULL);',
      '',
    ].join('\n');
    const positions = separatorPositions(documented);
    expect(positions.total).toBe(2);
    expect(positions.endOfLine).toBe(1);
    expect(positions.total).not.toBe(positions.endOfLine);

    // …and the same file without the explanatory line is clean, which is the
    // control that makes the assertion above about the PROSE rather than about
    // the fixture.
    const clean = documented.split('\n').filter((line) => !line.includes('like so')).join('\n');
    const cleanPositions = separatorPositions(clean);
    expect(cleanPositions.total).toBe(cleanPositions.endOfLine);
    expect(cleanPositions.total).toBe(1);
  });

  it('catches an unpaired dollar quote', () => {
    expect(scanDollarQuoting(HEALTHY).balanced).toBe(true);
    const unpaired = HEALTHY.replace('$$ LANGUAGE plpgsql;', () => ' LANGUAGE plpgsql;');
    expect(unpaired.split('$$').length - 1).toBe(1);
    expect(scanDollarQuoting(unpaired).balanced).toBe(false);
  });

  it('does not read PROSE about the convention as a marker or a statement', () => {
    const prose = [
      '-- oxy:deploy-phase=pre',
      '-- Each block is anchored between `-- oxy:handwritten-begin=<name>` and its',
      "--   grep -c '^-- oxy:handwritten-begin=' drizzle/0001_x.sql   # 1",
      '-- CREATE TRIGGER used to live here and was removed.',
      'CREATE TABLE "x" ("id" text PRIMARY KEY NOT NULL);',
      '',
    ].join('\n');
    const scan = scanHandwrittenMarkers(prose);
    expect(scan.problems).toEqual([]);
    expect(scan.blocks).toEqual([]);
    expect(scan.statementCount).toBe(0);
  });
});
