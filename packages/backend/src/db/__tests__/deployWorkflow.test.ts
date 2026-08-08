/**
 * The deploy workflow and the migrator cannot drift apart.
 *
 * ## Why a test, when the workflow is not code this package runs
 *
 * `.github/workflows/deploy-aws.yml` decides whether a release needs a
 * post-rollout migration task by GREPPING the migration files for a phase
 * marker. That grep is a second copy of syntax `@oxyhq/db` owns — and the
 * failure mode of a stale copy is silent and total: a pattern that no longer
 * matches reads as "no post migration in this release", the drop is never
 * applied by anything, and the deploy goes green. Nothing else in the repo would
 * notice, because no test runs the workflow.
 *
 * `POST_PHASE_GREP_PATTERN` is exported for exactly this purpose — its own
 * docblock says a CI gate can assert the workflow contains the string. So this
 * file is that gate: it reads the real workflow and the real constant, and fails
 * if the workflow stops carrying it verbatim.
 *
 * ## What each assertion is worth
 *
 * The pattern check alone would pass on a workflow that carried the string in a
 * comment and grepped for something else, so the command that actually runs is
 * checked too. And the phase VALUES the workflow passes to `--phase=` are
 * checked against `MIGRATION_RUNS`, because a workflow invoking
 * `--phase=pre-deploy` is refused by the migrator at deploy time — which is the
 * right behaviour, and a terrible time to find out.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATION_RUNS, POST_PHASE_GREP_PATTERN } from '@oxyhq/db/migrate';
import { MIGRATIONS_FOLDER } from '../migrationsFolder.js';

/** The repo root, from this file: `packages/backend/src/db/__tests__` is four deep. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'deploy-aws.yml');
const SCRIPT_PATH = join(REPO_ROOT, '.github', 'scripts', 'run-migration-task.sh');

const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
const script = readFileSync(SCRIPT_PATH, 'utf8');

describe('the deploy workflow and the migrator agree', () => {
  it('greps migrations with the pattern @oxyhq/db exports, not a copy of it', () => {
    // Vacuity floor: if the constant were ever exported as an empty string this
    // assertion would pass against any workflow at all.
    expect(POST_PHASE_GREP_PATTERN.length).toBeGreaterThan(10);
    expect(workflow).toContain(POST_PHASE_GREP_PATTERN);
  });

  it('runs the built migrator by the path the image actually contains', () => {
    // `dist/db/migrate.js`, not `src/db/migrate.ts`: the runtime image ships
    // neither bun nor `src/`, so the developer-facing `db:migrate` script cannot
    // run there. `build.ts` emits this path as a second entry point.
    expect(script).toContain('packages/backend/dist/db/migrate.js');
    expect(script).toContain('"node"');
  });

  it('passes only phase values the migrator accepts', () => {
    const phases = [...script.matchAll(/--phase=(?:"\s*\+\s*\$phase|([a-z-]+))/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    for (const phase of phases) {
      expect(MIGRATION_RUNS).toContain(phase);
    }
    // The script builds `--phase=` from its own argument, so the literal values
    // live in the CASE that validates it. Both must be spellings the package
    // accepts, and both must appear or one phase is unreachable.
    expect(script).toMatch(/pre \| post\)/);
    for (const phase of ['pre', 'post']) {
      expect(MIGRATION_RUNS).toContain(phase);
      expect(workflow).toContain(`run-migration-task.sh ${phase}`);
    }
  });

  it('names the same target database guard the migrator enforces', () => {
    // The migrator refuses to run without `--target-database`, so a workflow
    // that omitted it would fail every deploy at the first migration.
    expect(script).toContain('--target-database=');
    expect(workflow).toMatch(/^ {2}PG_DATABASE:/m);
  });

  it('greps the folder the migrator actually reads', () => {
    // The workflow greps a path spelled by hand; if the migrations folder ever
    // moved, the grep would find nothing and quietly report "no post migration".
    const folderName = MIGRATIONS_FOLDER.split('/').filter(Boolean).at(-1);
    expect(folderName).toBe('drizzle');
    expect(workflow).toContain('packages/backend/drizzle');
  });
});
