/**
 * Nothing reaches production from a commit CI has not passed.
 *
 * ## Why a test in this package, for files it never runs
 *
 * The same reason `deployWorkflow.test.ts` exists one file over: the workflows
 * are code with no runner, so a gate that stops gating fails SILENTLY and
 * everything downstream goes green. #505 is exactly that shape — three of the
 * four production deploys had no dependency on CI at all, and it was invisible
 * because `deploy-aws.yml`'s `needs: test` made the pipeline LOOK gated.
 * Measured over the 329 pushes to `main` before the fix: 93 web deploys shipped
 * without a green CI (29 from an outright `failure`, 64 from a run that was
 * `cancelled` by the next merge).
 *
 * ## What each assertion here is worth
 *
 * The load-bearing one is the FIRST: `require-ci-success.mjs` names the CI jobs
 * it demands, and a name list that drifts from the workflow is the classic
 * "gate that skips what a hand-maintained map omits". Deriving the list from
 * `ci.yml` inside the script would need a YAML parser and therefore a
 * `bun install` in every gate job, so the list stays a constant and the
 * EQUALITY is asserted here instead — cheap, loud, and in a suite that already
 * runs on every push and PR. A job added to CI fails this test until somebody
 * decides whether a deploy should wait for it.
 *
 * The second walks the workflows for jobs holding PRODUCTION CREDENTIALS rather
 * than for jobs named "deploy". A credential is what actually makes a job able
 * to ship: you cannot reach Cloudflare or ECS without one, and you can call a
 * job anything. The expected set is asserted by EQUALITY, not containment, so a
 * fifth deploy target fails the build until it is classified — the shape a
 * `>= 4` floor cannot catch, because it is satisfied by the four that already
 * exist.
 *
 * The third pins the `ci.yml` concurrency property the gate DEPENDS on. With
 * the group keyed on the ref alone, back-to-back merges cancelled the run for
 * the commit that had just landed, and a cancelled run is not a pass — so
 * reverting that line would not break the gate, it would make the gate refuse
 * roughly a third of deploys, which is the kind of red somebody "fixes" by
 * deleting the gate.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

/** The repo root, from this file: `packages/backend/src/db/__tests__` is five deep. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');
const GATE_SCRIPT_PATH = join(REPO_ROOT, '.github', 'scripts', 'require-ci-success.mjs');

/**
 * Loaded through a runtime-computed specifier on purpose.
 *
 * This package's `rootDir` is its own root, so a static import of a file under
 * `.github/` would be a TS6059 and the typecheck would refuse the whole program.
 * A dynamic import with a non-literal specifier is not resolved into the
 * program, which is what lets the real constant be read rather than a copy of it
 * re-declared here — and a copy is precisely what this file exists to forbid.
 */
const gateModule: {
  REQUIRED_CI_JOBS: readonly string[];
  judgeJobs: (jobs: { name: string; conclusion?: string | null; status?: string }[]) => string[];
} = await import(pathToFileURL(GATE_SCRIPT_PATH).href);

/** Only the shape these assertions read — not a schema for GitHub Actions. */
interface WorkflowStep {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface WorkflowJob {
  name?: string;
  needs?: string | string[];
  steps?: WorkflowStep[];
}
interface WorkflowFile {
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean | string };
  jobs: Record<string, WorkflowJob>;
}

function readWorkflow(file: string): WorkflowFile {
  return parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf8')) as WorkflowFile;
}

/** The name the Actions API reports for a job — its `name:`, else its id. */
function reportedJobName(id: string, job: WorkflowJob): string {
  return job.name ?? id;
}

const CI_WORKFLOW_FILE = 'ci.yml';

const WEB_DEPLOY_WORKFLOWS = [
  'deploy-cloudflare.yml',
  'deploy-dashboard.yml',
  'deploy-pos.yml',
] as const;

describe('the deploy gate demands the CI jobs that actually exist', () => {
  it('requires exactly the jobs ci.yml defines, by their reported names', () => {
    const ci = readWorkflow(CI_WORKFLOW_FILE);
    const defined = Object.entries(ci.jobs).map(([id, job]) => reportedJobName(id, job));

    // Vacuity floor. An empty or one-job `ci.yml` would make the equality below
    // pass against a gate that demands almost nothing, and a workflow that
    // failed to parse would produce exactly that.
    expect(defined.length).toBeGreaterThanOrEqual(5);

    // A job whose name is computed cannot be matched against the API's report by
    // a static list, and the failure direction is silence — the gate would look
    // for a literal `${{ ... }}` and report it MISSING, which at least fails
    // closed, but the message would send the reader to the wrong place.
    for (const name of defined) {
      expect(name, `ci.yml job name must be a literal, not an expression: ${name}`).not.toContain(
        '${{',
      );
    }

    expect([...gateModule.REQUIRED_CI_JOBS].sort()).toEqual([...defined].sort());
  });

  it('names a gate script that exists and is the one the workflows invoke', () => {
    expect(existsSync(GATE_SCRIPT_PATH)).toBe(true);

    for (const file of WEB_DEPLOY_WORKFLOWS) {
      const workflow = readWorkflow(file);
      const invocations = Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.run?.includes('require-ci-success.mjs'));
      expect(invocations, `${file} must invoke the gate script`).toHaveLength(1);
    }
  });
});

describe('every job holding production credentials waits for a verification', () => {
  /**
   * Walking CREDENTIALS rather than job names, because a credential is what
   * makes a job able to ship and a name is just a name.
   */
  function shipsToProduction(job: WorkflowJob): boolean {
    return (job.steps ?? []).some(
      (step) =>
        step.uses?.startsWith('aws-actions/configure-aws-credentials') ||
        Object.values(step.env ?? {}).some((value) =>
          String(value).includes('secrets.CLOUDFLARE_API_TOKEN'),
        ),
    );
  }

  /** Every `run:` in this job and, transitively, everything it `needs`. */
  function commandsBehind(workflow: WorkflowFile, jobId: string): string[] {
    const seen = new Set<string>();
    const commands: string[] = [];
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const job = workflow.jobs[id];
      if (!job) return;
      for (const step of job.steps ?? []) if (step.run) commands.push(step.run);
      const needs = job.needs === undefined ? [] : [job.needs].flat();
      for (const dependency of needs) visit(dependency);
    };
    const root = workflow.jobs[jobId];
    const rootNeeds = root?.needs === undefined ? [] : [root.needs].flat();
    for (const dependency of rootNeeds) visit(dependency);
    return commands;
  }

  const shipping = Object.fromEntries(
    ['ci.yml', 'deploy-aws.yml', ...WEB_DEPLOY_WORKFLOWS].flatMap((file) => {
      const workflow = readWorkflow(file);
      return Object.entries(workflow.jobs)
        .filter(([, job]) => shipsToProduction(job))
        .map(([id]) => [`${file}#${id}`, { file, id, workflow }] as const);
    }),
  );

  it('is exactly the four production targets, so a fifth must be classified', () => {
    // EQUALITY, never containment. A `>= 4` floor is satisfied by the four that
    // already exist and would say nothing about a new one.
    expect(Object.keys(shipping).sort()).toEqual(
      [
        'deploy-aws.yml#deploy',
        'deploy-cloudflare.yml#deploy-app',
        'deploy-dashboard.yml#deploy-dashboard',
        'deploy-pos.yml#deploy-pos',
      ].sort(),
    );
  });

  it.each(Object.keys(shipping))('%s depends on something that verifies the commit', (key) => {
    const { workflow, id } = shipping[key];
    const commands = commandsBehind(workflow, id);

    // Vacuity floor: an ungated job has NO commands behind it, and so would a
    // walk that silently found nothing. Asserting the verification marker alone
    // could not tell those two apart.
    expect(commands.length, `${key} has no jobs behind it at all — it is ungated`).toBeGreaterThan(
      0,
    );

    const verified = commands.some(
      (command) =>
        command.includes('require-ci-success.mjs') ||
        command.includes('--filter @mercaria/backend test'),
    );
    expect(verified, `${key} must wait for CI or for its own test job`).toBe(true);
  });
});

describe('a web deploy does not park runners waiting for the CI it depends on', () => {
  /**
   * The `gate` job POLLS, so it occupies a runner for its entire wait —
   * measured under a real merge burst: nine idle gate jobs holding nine
   * DISTINCT assigned runner ids, while the `ci.yml` runs they were waiting on
   * sat `queued`, one of them having gone from `in_progress` BACK to `queued`.
   *
   * With no concurrency block, N merges park 3N runners against N CI runs. So
   * this is not tidiness: it is the difference between a gate that waits under
   * contention and a gate that CAUSES it, and the symptom is a deploy that goes
   * red on a 30-minute timeout while its CI was fine and merely unscheduled.
   *
   * Asserting the KEY rather than mere presence, because three workflows
   * sharing one group would serialise the three apps behind each other — a
   * different bug with an identical green.
   */
  const EXPECTED_GROUP_KEY: Record<(typeof WEB_DEPLOY_WORKFLOWS)[number], string> = {
    'deploy-cloudflare.yml': 'deploy-frontend-',
    'deploy-dashboard.yml': 'deploy-dashboard-',
    'deploy-pos.yml': 'deploy-pos-',
  };

  it.each(WEB_DEPLOY_WORKFLOWS)('%s serialises only itself, newest wins', (file) => {
    const { concurrency } = readWorkflow(file);
    expect(concurrency, `${file} must declare a concurrency block`).toBeDefined();

    // A deploy owes only the NEWEST artifact, unlike `ci.yml`, which owes a
    // verdict per commit and must therefore never cancel.
    expect(concurrency?.['cancel-in-progress']).toBe(true);

    const group = concurrency?.group ?? '';
    expect(group).toContain(EXPECTED_GROUP_KEY[file]);
    // Per-ref as well, so a topic-branch dispatch cannot evict a `main` deploy.
    expect(group).toContain('github.ref');
  });

  it('gives the three apps three DIFFERENT groups', () => {
    const groups = WEB_DEPLOY_WORKFLOWS.map((file) => readWorkflow(file).concurrency?.group);

    // Vacuity floor: three `undefined`s are also "all distinct".
    for (const group of groups) expect(group).toBeTruthy();
    expect(new Set(groups).size).toBe(WEB_DEPLOY_WORKFLOWS.length);
  });
});

describe('ci.yml gives every commit on main its own verdict', () => {
  const ci = readWorkflow(CI_WORKFLOW_FILE);

  it('does not let one merge cancel the run for the commit before it', () => {
    const group = ci.concurrency?.group ?? '';

    // The property is "two commits on main never share a concurrency group".
    // GitHub expressions cannot be evaluated here, so this asserts the one
    // mechanism that delivers it: the sha participates in the group. Reverting
    // to a ref-only group does not break the gate — it makes the gate refuse
    // every superseded commit, which is a red somebody deletes the gate to fix.
    expect(group, 'ci.yml concurrency must key main runs on the commit sha').toContain(
      'github.sha',
    );
  });
});

describe('judgeJobs refuses the two shapes that read as green', () => {
  const green = [
    ...gateModule.REQUIRED_CI_JOBS.map((name) => ({ name, conclusion: 'success' })),
  ];

  it('passes a run whose required jobs all succeeded', () => {
    expect(gateModule.judgeJobs(green)).toEqual([]);
  });

  it('refuses a SKIPPED job, which is the one that reads as no failure', () => {
    // `ci.yml`'s four `Build *` jobs `needs: lint-and-test`, so on a red commit
    // they report `skipped` — anyone counting failures sees zero. This is the
    // exact case #505 demonstrated.
    const skipped = green.map((job) =>
      job.name === 'Build App' ? { ...job, conclusion: 'skipped' } : job,
    );
    expect(gateModule.judgeJobs(skipped)).toEqual(['Build App: skipped']);
  });

  it('refuses a MISSING job, because a run with no jobs reports no failures', () => {
    const absent = green.filter((job) => job.name !== 'Build POS');
    expect(gateModule.judgeJobs(absent)).toEqual([
      'Build POS: MISSING from the run (missing counts as failing)',
    ]);
  });

  it('refuses a job that is still running rather than reading it as passed', () => {
    const running = green.map((job) =>
      job.name === 'Lint & Test' ? { name: job.name, conclusion: null, status: 'in_progress' } : job,
    );
    expect(gateModule.judgeJobs(running)).toEqual(['Lint & Test: in_progress']);
  });

  it('is not vacuous: an empty job list refuses every required job', () => {
    // Without this, all four assertions above would still pass if `judgeJobs`
    // had been mutated to return `[]` for anything it did not recognise.
    expect(gateModule.judgeJobs([])).toHaveLength(gateModule.REQUIRED_CI_JOBS.length);
  });
});
