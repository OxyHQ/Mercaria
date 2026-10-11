/**
 * The deploy workflow and the migrator cannot drift apart.
 *
 * ## Why a test, when the workflow is not code this package runs
 *
 * `.github/workflows/deploy-aws.yml` decides whether a release needs a
 * post-rollout migration task by GREPPING the migration files for a phase
 * marker. That grep is a second copy of syntax `@oxy.so/db` owns — and the
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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { MIGRATION_RUNS, POST_PHASE_GREP_PATTERN } from '@oxy.so/db/migrate';
import { MIGRATIONS_FOLDER } from '../migrationsFolder.js';

/** Only the shape these assertions read — not a schema for GitHub Actions. */
interface WorkflowFile {
  on: {
    workflow_dispatch?: {
      inputs?: Record<string, { default?: string; options?: string[] }>;
    };
  };
  jobs: Record<
    string,
    { steps: { name?: string; if?: string; run?: string; env?: Record<string, string> }[] }
  >;
}

/** The repo root, from this file: `packages/backend/src/db/__tests__` is four deep. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'deploy-aws.yml');
const SCRIPT_PATH = join(REPO_ROOT, '.github', 'scripts', 'run-migration-task.sh');
const ECS_TASK_SCRIPT_PATH = join(REPO_ROOT, '.github', 'scripts', 'run-ecs-task.sh');

const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
const script = readFileSync(SCRIPT_PATH, 'utf8');
const ecsTaskScript = readFileSync(ECS_TASK_SCRIPT_PATH, 'utf8');

describe('the deploy workflow and the migrator agree', () => {
  it('greps migrations with the pattern @oxy.so/db exports, not a copy of it', () => {
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

  it('pins migrations, rollout and catalog registration to one immutable image', () => {
    const jobs = (parse(workflow) as WorkflowFile).jobs;
    const register = jobs.deploy.steps.find((step) =>
      step.name?.startsWith('Resolve the ECS one-shot shape'),
    );
    const rollout = jobs.deploy.steps.find((step) => step.name?.startsWith('Deploy to ECS'));
    const catalog = jobs.deploy.steps.find((step) =>
      step.name?.startsWith('Register the deployed capability catalog'),
    );

    expect(workflow).toContain("--query 'imageDetails[0].imageDigest'");
    expect(register?.run).toContain('aws ecs register-task-definition');
    expect(register?.run).toContain('{family, taskRoleArn, executionRoleArn, networkMode,');
    expect(register?.run).toContain('runtimePlatform, enableFaultInjection}');
    expect(register?.run).not.toContain('del(.taskDefinitionArn');
    expect(register?.run).toContain('.image = $image');
    expect(register?.run).toContain('/oxy/$APP/OXY_APPLICATION_KEY');
    expect(register?.run).toContain('/oxy/$APP/OXY_APPLICATION_SECRET');
    expect(register?.run).toContain('.name != "OXY_APPLICATION_KEY"');
    expect(register?.run).toContain('.name != "OXY_APPLICATION_SECRET"');
    expect(register?.run).toContain('{name: "OXY_API_URL", value: $oxy_api_url}');
    // No GoWay client means no location can be published (ADR 0013).
    expect(register?.run).toContain('{name: "GOWAY_API_URL", value: $goway_api_url}');
    expect(register?.env?.GOWAY_API_URL).toBe(
      "${{ vars.GOWAY_API_URL || 'https://api.goway.to' }}",
    );
    expect(rollout?.run).toContain('--task-definition');
    expect(catalog?.run).toContain('packages/backend/dist/register-capability-catalog.js');
    expect(catalog?.env?.TASK_DEFINITION).toBe('${{ steps.ecs.outputs.task_definition }}');
    expect(ecsTaskScript).toContain('--task-definition "$TASK_DEFINITION"');
    expect(ecsTaskScript).toContain('EXIT_CODE');
  });

  it('verifies the exact ECS candidate before destructive migrations or catalog publication', () => {
    const steps = (parse(workflow) as WorkflowFile).jobs.deploy.steps;
    const resolve = steps.find((step) => step.name?.startsWith('Resolve the ECS one-shot shape'));
    const rolloutIndex = steps.findIndex((step) => step.name?.startsWith('Deploy to ECS'));
    const smokeIndex = steps.findIndex((step) => step.name?.startsWith('Verify live Mercaria MCP'));
    const rollbackIndex = steps.findIndex((step) =>
      step.name?.startsWith('Roll back a failed candidate'),
    );
    const postIndex = steps.findIndex((step) => step.name?.startsWith('Migrate (post)'));
    const catalogIndex = steps.findIndex((step) =>
      step.name?.startsWith('Register the deployed capability catalog'),
    );
    const rollout = steps[rolloutIndex];
    const smoke = steps[smokeIndex];
    const rollback = steps[rollbackIndex];

    expect(resolve?.run).toContain('previous_task_definition=$TD');
    expect(rollout?.run).toContain('deployment_started=true');
    expect(rollout?.run).toContain('.github/scripts/wait-for-ecs-deployment.sh');
    expect(rollout?.run).not.toContain('aws ecs wait services-stable');
    expect(rollout?.run).toContain('live_task_definition');
    expect(rollout?.run).toContain('live_image');
    expect(smoke?.run).toContain('.github/scripts/smoke-mcp.sh');

    expect(rollback?.if).toContain('failure()');
    expect(rollback?.if).toContain("phase_mode != 'all'");
    expect(rollback?.if).toContain("rollback_safe != 'false'");
    expect(rollback?.env?.PREVIOUS_TASK_DEFINITION).toBe(
      '${{ steps.ecs.outputs.previous_task_definition }}',
    );
    expect(rollback?.run).toContain('--task-definition "$PREVIOUS_TASK_DEFINITION"');
    expect(rollback?.run).toContain('.github/scripts/wait-for-ecs-deployment.sh');

    expect(rolloutIndex).toBeGreaterThan(-1);
    expect(smokeIndex).toBeGreaterThan(rolloutIndex);
    expect(rollbackIndex).toBeGreaterThan(smokeIndex);
    expect(postIndex).toBeGreaterThan(rollbackIndex);
    expect(catalogIndex).toBeGreaterThan(postIndex);
  });

  it('passes only phase values the migrator accepts', () => {
    // The script builds `--phase=` from its own argument, so the literal values
    // live in the CASE that validates it. Every one must be a spelling the
    // package accepts, and every one must be reachable from the workflow.
    expect(script).toMatch(/pre \| post \| all\)/);
    for (const phase of ['pre', 'post', 'all']) {
      expect(MIGRATION_RUNS).toContain(phase);
      expect(workflow).toContain(`run-migration-task.sh ${phase}`);
    }
  });

  it('offers the cutover override, defaulted to the phased pair', () => {
    /**
     * The chain has a `pre` migration queued behind a `post` one, which makes
     * `--phase=pre` refuse on a database where the whole batch is pending —
     * the cutover. `all` is the deliberate way through, so it has to be
     * REACHABLE (or the cutover needs someone to remember a manual dispatch)
     * and it has to be OPT-IN (or every ordinary release applies destructive
     * migrations while the previous image is still serving).
     */
    const dispatch = (parse(workflow) as WorkflowFile).on.workflow_dispatch;
    const input = dispatch?.inputs?.migration_phase;
    expect(input, 'the migration_phase dispatch input is gone').toBeDefined();
    expect(input?.default).toBe('pre-post');
    expect(input?.options).toEqual(['pre-post', 'all']);
  });

  it('runs the cutover and the phased pair as MUTUALLY EXCLUSIVE paths', () => {
    // Both running would apply the chain twice — harmless by idempotency, but
    // the `post` half would then run against a database with nothing pending
    // and the phase planner's own guard is the only thing between that and a
    // red cutover. The conditions are what keep them apart.
    const jobs = (parse(workflow) as WorkflowFile).jobs;
    const steps = jobs.deploy.steps.filter((step) => step.name?.startsWith('Migrate ('));
    expect(steps.map((step) => step.name)).toHaveLength(3);

    const conditionFor = (prefix: string): string => {
      const step = steps.find((candidate) => candidate.name?.startsWith(prefix));
      expect(step, `no step named ${prefix}`).toBeDefined();
      return (step?.if ?? '').replace(/\s+/g, ' ');
    };
    expect(conditionFor('Migrate (all)')).toContain("phase_mode == 'all'");
    expect(conditionFor('Migrate (pre)')).toContain("phase_mode != 'all'");
    expect(conditionFor('Migrate (post)')).toContain("phase_mode != 'all'");
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

  it('greps the WHOLE journal, never this release’s own diff (#574)', () => {
    /**
     * The recovery that makes an evicted deploy survivable, stated as the thing
     * that must not be tidied away.
     *
     * `has_post` is computed by grepping the entire migrations directory, so it
     * is `true` whenever ANY post migration exists — eleven do, and one has
     * since 2026-08-08, which is BEFORE this step was written. So the post task
     * runs on every ordinary release and applies whatever the ledger says is
     * PENDING, not whatever this commit added.
     *
     * That is what let `f38227b7` — a commit adding no migration at all — apply
     * the `0106_panoramic_patch` that #574's evicted run was carrying. Narrowing
     * the grep to the release's own diff reads as a tightening, would leave
     * every ordinary deploy green, and would silently convert that bounded
     * window into a permanent one: an evicted post migration would then be
     * applied by NOTHING.
     */
    const detect = (parse(workflow) as WorkflowFile).jobs.deploy.steps.find((step) =>
      step.name?.startsWith('Detect a post-rollout migration'),
    );
    expect(detect, 'the post-migration detection step is gone').toBeDefined();
    const command = detect?.run ?? '';

    // Positive control. Without it, every prohibition below passes against a
    // step whose command was renamed, emptied or restructured out of reach —
    // the guard would read clean while measuring nothing.
    expect(command, 'the detect step no longer greps the migrations directory').toContain(
      'packages/backend/drizzle',
    );
    expect(command).toContain('has_post=');

    // The scope must be the directory, recursively — not a commit range.
    for (const narrowing of ['git diff', 'git log', 'git show', 'HEAD~', 'github.event.before']) {
      expect(
        command,
        `the detect step scopes the grep with \`${narrowing}\`, which limits it to this ` +
          `release and removes the recovery an evicted deploy depends on (#574)`,
      ).not.toContain(narrowing);
    }

    // And the property the grep exists to have: something in the tree matches
    // it today. A repository with no post migration would make the assertions
    // above true and the step's output permanently `false`.
    const posts = readdirSync(MIGRATIONS_FOLDER).filter(
      (file) =>
        file.endsWith('.sql') &&
        readFileSync(join(MIGRATIONS_FOLDER, file), 'utf8')
          .split('\n')
          .some((line) => line.trim() === POST_PHASE_GREP_PATTERN.replace(/^\^|\$$/g, '')),
    );
    expect(posts.length, 'no post migration exists, so has_post measures nothing').toBeGreaterThan(
      0,
    );
  });
});

/**
 * Runtime secrets live in SSM Parameter Store, and the deploy never writes one.
 *
 * Until 2026-10-10 a step copied an allowlist of GitHub repo secrets into SSM on
 * every deploy, which made GitHub the source of truth for production
 * credentials: whoever could edit a repo secret could change what production
 * ran with, and the value lived in two systems. SSM (`/oxy/mercaria/*`,
 * SecureString) is now the only source; a value is set or rotated with
 * `aws ssm put-parameter --overwrite` by its owner, never by a workflow.
 *
 * Both halves are asserted, because each can regress alone: a step that writes
 * SSM again, and a workflow that starts reading app secrets out of GitHub again
 * (`toJSON(secrets)` additionally holds every run at `action_required`, measured
 * across the org on 2026-08-08).
 */
describe('the deploy reads runtime secrets from SSM and writes none', () => {
  it('never writes an SSM parameter', () => {
    const steps = (parse(workflow) as WorkflowFile).jobs.deploy.steps;
    for (const step of steps) {
      expect(step.run ?? '', `step "${step.name ?? '?'}" writes SSM`).not.toMatch(
        /ssm\s+put-parameter/,
      );
    }
  });

  it('reads no repo secret but the job token, and never the whole context', () => {
    expect(workflow).not.toMatch(/\$\{\{[^}]*toJSON\s*\(\s*secrets\s*\)/);
    const named = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map(
      (match) => match[1],
    );
    expect(named.length, 'the job token is still read, so the matcher works').toBeGreaterThan(0);
    expect([...new Set(named)]).toEqual(['GITHUB_TOKEN']);
  });
});
