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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { MIGRATION_RUNS, POST_PHASE_GREP_PATTERN } from '@oxyhq/db/migrate';
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
    expect(register?.run).toContain(
      '{family, taskRoleArn, executionRoleArn, networkMode,',
    );
    expect(register?.run).toContain('runtimePlatform, enableFaultInjection}');
    expect(register?.run).not.toContain('del(.taskDefinitionArn');
    expect(register?.run).toContain('.image = $image');
    expect(register?.run).toContain('/oxy/$APP/OXY_APPLICATION_KEY');
    expect(register?.run).toContain('/oxy/$APP/OXY_APPLICATION_SECRET');
    expect(register?.run).toContain('.name != "OXY_APPLICATION_KEY"');
    expect(register?.run).toContain('.name != "OXY_APPLICATION_SECRET"');
    expect(register?.run).toContain('{name: "OXY_API_URL", value: $oxy_api_url}');
    expect(rollout?.run).toContain('--task-definition');
    expect(catalog?.run).toContain('packages/backend/dist/register-capability-catalog.js');
    expect(catalog?.env?.TASK_DEFINITION).toBe('${{ steps.ecs.outputs.task_definition }}');
    expect(ecsTaskScript).toContain("--task-definition \"$TASK_DEFINITION\"");
    expect(ecsTaskScript).toContain("EXIT_CODE");
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
 * The SSM sync step names the secrets it copies, and that is what keeps deploys
 * automated.
 *
 * A step that walks `${{ toJSON(secrets) }}` and pipes the lot into
 * `aws ssm put-parameter` is structurally a secret-exfiltration payload, and
 * GitHub's malicious-workflow detection treats it as one: every run of a
 * workflow containing it is created as `action_required` with ZERO jobs until a
 * human approves it in the UI. Measured across the org on 2026-08-08 — three
 * repos with the pattern all held, two without it deployed unheld. Nothing in a
 * normal CI run reports this, because the runs never start; it looks like an
 * outage, not a workflow defect.
 *
 * The assertions below are deliberately paired. Checking only for the absence of
 * `toJSON(secrets)` would pass on a step that synced nothing at all, and checking
 * only that the names are present would pass on a step that ALSO enumerated
 * everything. And the two spellings of the allowlist — the `env:` bindings and
 * the shell word lists — are cross-checked against each other rather than each
 * against a literal, because the drift that actually happens is adding one and
 * forgetting the other: a name in `env:` but not in the loop is never synced,
 * and a name in the loop but not in `env:` reads as empty and is skipped with a
 * warning nobody sees until the deploy that needed it.
 */
describe('the deploy workflow syncs an explicit allowlist, never the whole context', () => {
  /**
   * What this repo OWNS and consumes. Deliberately NOT a mirror of the live
   * task definition, and it diverges in BOTH directions.
   *
   * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY live under /oxy/_shared/, this
   * repo holds neither, and the repos that do own them (OxyHQServices, Syra)
   * are what write them.
   *
   * The four connector parameters are the divergence the OTHER way: measured on
   * oxy-mercaria:3 on 2026-08-16, the live revision names none of them, and it
   * is not supposed to yet. A task definition naming a parameter that does not
   * exist fails at task START with ResourceInitializationError, so the sync has
   * to write them BEFORE oxy-infra adds them to the task definition. Until that
   * lands they are synced and read by nothing, which is inert — where the
   * reverse order is an outage. Their consumers already exist in this package:
   * connectors/shopify/config.ts, connectors/config.ts and
   * lib/connector-crypto.ts.
   *
   * CONNECTOR_OAUTH_REDIRECT_BASE_URL and CONNECTOR_DEFAULT_CATEGORY_SLUG are
   * NOT here and must not be added: they are configuration, so they belong in
   * the task definition's `environment`, not in SecureString.
   *
   * SERVICE_SECRET is RETIRED (#164) and is the one entry a future reader is
   * likely to "fix" back in, because the live task definition DOES still name
   * it — measured on oxy-mercaria:3, 2026-08-16. That is the state being
   * retired, not a gap: no Mercaria code reads the variable any more, so the
   * sync would be re-writing a live credential nothing consumes. The task
   * definition entry is removed in oxy-infra
   * (terraform-uswest2/app-services.tf), and the SSM parameter and the GitHub
   * repo secret are deleted only AFTER that rollout — deleting the parameter
   * while a task definition still names it fails every task at START with
   * ResourceInitializationError. Re-adding it here would restore the sync, not
   * the safety.
   *
   * So this list is "what this repo OWNS and still consumes", which is what the
   * sync step is for, and no longer a mirror of the live revision.
   */
  const EXPECTED_ALLOWLIST = [
    'DATABASE_URL',
    'REDIS_URL',
    'VAPID_PRIVATE_KEY',
    'VAPID_PUBLIC_KEY',
    'VAPID_SUBJECT',
    'SHOPIFY_CLIENT_ID',
    'SHOPIFY_CLIENT_SECRET',
    'CONNECTOR_ENCRYPTION_KEY',
    'CONNECTOR_OAUTH_STATE_SECRET',
  ];

  const syncStep = (parse(workflow) as WorkflowFile).jobs.deploy.steps.find((step) =>
    step.name?.startsWith('Sync GitHub secrets'),
  );

  /** The words of a `NAME="a b c"` assignment in the step's shell body. */
  const shellList = (variable: string): string[] => {
    const match = new RegExp(`^\\s*${variable}="([^"]*)"`, 'm').exec(syncStep?.run ?? '');
    expect(match, `the step no longer assigns ${variable}`).not.toBeNull();
    return (match?.[1] ?? '').split(/\s+/).filter(Boolean);
  };

  it('has a sync step at all', () => {
    // Vacuity floor for every assertion below: they all read this step, and an
    // `undefined` step would make the `?.` chains silently trivially true.
    expect(syncStep, 'the secret sync step is gone').toBeDefined();
    expect(syncStep?.env, 'the sync step binds no secrets').toBeDefined();
    // And a SIZE floor, tracking the list rather than sitting under it. The two
    // `toEqual` assertions below compare the list against the workflow, so they
    // pass on any TANDEM deletion from both — this is the only thing bounding
    // one. It is meant to fail on a removal, so that a removal is argued for.
    expect(EXPECTED_ALLOWLIST.length).toBeGreaterThan(8);
  });

  it('never enumerates the whole secrets context', () => {
    // Matched as an EXPRESSION, not as text: the step's own comment explains the
    // block by name, so a bare `toContain` check would fail on the explanation
    // rather than on the payload.
    expect(workflow).not.toMatch(/\$\{\{[^}]*toJSON\s*\(\s*secrets\s*\)/);
  });

  it('binds each allowlisted secret under a SYNC_ prefix, and nothing else', () => {
    // The prefix is not cosmetic. `aws-actions/configure-aws-credentials` exports
    // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY into the job environment, so a
    // secret bound under its raw name shadows the assumed OIDC role and fails
    // the step with UnrecognizedClientException.
    const env = syncStep?.env ?? {};
    for (const [key, value] of Object.entries(env)) {
      expect(key, `${key} must be bound under the SYNC_ prefix`).toMatch(/^SYNC_/);
      expect(value).toBe(`\${{ secrets.${key.replace(/^SYNC_/, '')} }}`);
    }
    expect(Object.keys(env).map((key) => key.replace(/^SYNC_/, '')).sort()).toEqual(
      [...EXPECTED_ALLOWLIST].sort(),
    );
  });

  it('iterates exactly the secrets it binds', () => {
    const iterated = [...shellList('SHARED_SECRETS'), ...shellList('APP_SECRETS')].sort();
    const bound = Object.keys(syncStep?.env ?? {})
      .map((key) => key.replace(/^SYNC_/, ''))
      .sort();
    expect(iterated).toEqual(bound);
    expect(iterated).toEqual([...EXPECTED_ALLOWLIST].sort());
  });

  it('keeps REDIS_URL on the shared path and the app secrets on the app path', () => {
    // One field decides which SSM namespace a value lands in. A shared secret
    // written to /oxy/mercaria/ is invisible to the task definition, which reads
    // it from /oxy/_shared/ — so the sync reports success and changes nothing
    // the container sees.
    expect(shellList('SHARED_SECRETS')).toEqual(['REDIS_URL']);
    expect(shellList('APP_SECRETS')).not.toContain('REDIS_URL');
    expect(syncStep?.run).toContain('path="/oxy/_shared/$k"');
    expect(syncStep?.run).toContain('path="/oxy/$APP/$k"');
  });

  it('still refuses placeholders and a non-us-west-2 REDIS_URL', () => {
    // Both guards predate the allowlist and protect production from a secret
    // that was never really set: skipping leaves the previous SSM value alone,
    // where syncing would overwrite it with an empty string or a dash.
    expect(syncStep?.run).toContain('[ "$v" = "-" ]');
    // The escaped spelling, because the guard is a `grep` regex — asserting the
    // bare hostname passes on a workflow whose dots are unescaped wildcards.
    expect(syncStep?.run).toContain(String.raw`'\.usw2\.cache\.amazonaws\.com'`);
  });
});
