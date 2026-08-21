/**
 * Print what rolling a migration back takes.
 *
 * The operator-facing half of `src/db/migrationRollback.ts`. Two modes:
 *
 *   bun run db:rollback-plan                 every migration, one line each
 *   bun run db:rollback-plan 0134            one migration, in full, with the
 *                                            derived inverse and what it omits
 *
 * A tag prefix is enough — `0134` finds `0134_red_silver_fox.sql`, because the
 * generated name is not something anybody remembers.
 *
 * `--census` reports the corpus split and every statement the classifier has no
 * opinion on. That last list must be empty; the gate
 * (`db/__tests__/migration-rollback-posture.test.ts`) fails the build when it is
 * not, because a statement nobody classified is a declaration nobody can check.
 *
 * Nothing here connects to a database and nothing here applies anything. The
 * derived inverse is material for a decision, not a down migration: the file it
 * was derived from is an applied artefact, and the statements it CANNOT invert
 * are printed beside the ones it can, so a reader cannot mistake a partial
 * inverse for a complete one.
 */

import {
  classifyMigrations,
  derivedInverse,
  faults,
  irreversibleStatements,
  type MigrationRollback,
} from '../src/db/migrationRollback.js';
import { MIGRATIONS_FOLDER } from '../src/db/migrationsFolder.js';

const ARGS = process.argv.slice(2);
const CENSUS = ARGS.includes('--census');
const TARGET = ARGS.find((arg) => !arg.startsWith('--'));

const migrations = classifyMigrations(MIGRATIONS_FOLDER);

function summary(migration: MigrationRollback): string {
  const irreversible = irreversibleStatements(migration);
  const declared = migration.declared ?? '(none)';
  const shape =
    irreversible.length === 0
      ? `${migration.statements.length} statements, all invertible`
      : `${irreversible.length}/${migration.statements.length} not invertible`;
  return `${migration.file.padEnd(46)} ${declared.padEnd(9)} ${shape}`;
}

function printOne(migration: MigrationRollback): void {
  const { statements, omitted } = derivedInverse(migration);
  console.log(`\n=== ${migration.file} ===`);
  console.log(`declared: ${migration.declared ?? '(none)'}`);
  if (migration.note !== null) console.log(`note:     ${migration.note}`);
  const problems = faults(migration);
  console.log(`faults:   ${problems.length === 0 ? 'none' : ''}`);
  for (const problem of problems) console.log(`  - ${problem}`);

  console.log(`\n-- derived inverse (${statements.length} statements, reverse order)`);
  console.log('-- REVIEW BEFORE RUNNING. Nothing generated this against a live schema.');
  for (const statement of statements) console.log(statement);

  if (omitted.length > 0) {
    console.log(`\n-- NOT INVERTED (${omitted.length}). The inverse above is INCOMPLETE.`);
    for (const statement of omitted) {
      console.log(`--   line ${statement.line} (${statement.reason}) ${statement.text}`);
    }
  }
}

if (CENSUS) {
  const unclassified = migrations.flatMap((migration) =>
    irreversibleStatements(migration)
      .filter((statement) => statement.reason === 'unclassified')
      .map((statement) => `${migration.file}:${statement.line} ${statement.text}`),
  );
  const totals = migrations.reduce(
    (sum, migration) => {
      const irreversible = irreversibleStatements(migration);
      return {
        statements: sum.statements + migration.statements.length,
        derivable: sum.derivable + (irreversible.length === 0 ? 1 : 0),
        lossy: sum.lossy + (irreversible.length === 0 ? 0 : 1),
        irreversible: sum.irreversible + irreversible.length,
      };
    },
    { statements: 0, derivable: 0, lossy: 0, irreversible: 0 },
  );
  console.log(
    `migrations=${migrations.length} statements=${totals.statements} ` +
      `fully-invertible-files=${totals.derivable} files-with-a-loss=${totals.lossy} ` +
      `irreversible-statements=${totals.irreversible}`,
  );
  const byReason = new Map<string, number>();
  for (const migration of migrations) {
    for (const statement of irreversibleStatements(migration)) {
      byReason.set(statement.reason ?? '?', (byReason.get(statement.reason ?? '?') ?? 0) + 1);
    }
  }
  for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`);
  }
  console.log(`unclassified statements: ${unclassified.length}`);
  for (const entry of unclassified) console.log(`  ${entry}`);
  const failing = migrations.filter((migration) => faults(migration).length > 0);
  console.log(`\nmigrations with a declaration fault: ${failing.length}`);
  for (const migration of failing) {
    console.log(`  ${migration.file}`);
    for (const problem of faults(migration)) console.log(`      ${problem}`);
  }
  process.exit(unclassified.length === 0 && failing.length === 0 ? 0 : 1);
}

if (TARGET === undefined) {
  for (const migration of migrations) console.log(summary(migration));
  process.exit(0);
}

const matches = migrations.filter((migration) => migration.file.startsWith(TARGET));
if (matches.length === 0) {
  console.error(`No migration matches \`${TARGET}\`.`);
  process.exit(1);
}
for (const migration of matches) printOne(migration);
