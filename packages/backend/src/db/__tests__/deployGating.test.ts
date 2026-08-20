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
 * #518 NARROWED that second one, and the narrowing is the point of the change
 * rather than a tidy-up. It used to accept `--filter @mercaria/backend test` as
 * a verification, because `deploy-aws.yml` had a `test` job running it — so the
 * assertion passed while the API's actual gate was a 4-step copy of a 21-step
 * `ci.yml` that never ran `tsc`. Demonstrated on 7071d999: a `string` assigned
 * to a `number` in `lib/allowed-origins.ts` fails `typecheck` with TS2322,
 * passes the suite and `build:backend`, and lands TWICE in the shipped
 * `dist/index.js`. A guard that accepts the weaker of two answers is measuring
 * whichever one is cheapest to satisfy.
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
interface FakeRun {
  id: number;
  run_attempt: number;
  status: string;
  conclusion?: string | null;
  html_url: string;
}

const gateModule: {
  REQUIRED_CI_JOBS: readonly string[];
  judgeJobs: (jobs: { name: string; conclusion?: string | null; status?: string }[]) => string[];
  isTransportError: (error: unknown) => boolean;
  GateFailure: new (message: string) => Error;
  requireCiSuccess: (options: {
    repository: string;
    sha: string;
    token?: string;
    now?: () => number;
    findRuns?: (options: { repository: string; sha: string; token?: string }) => Promise<FakeRun[]>;
    readRunJobs?: (options: {
      repository: string;
      runId: number;
      token?: string;
    }) => Promise<{ name: string; conclusion?: string | null; status?: string }[]>;
    sleepFor?: (ms: number) => Promise<void>;
  }) => Promise<FakeRun>;
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

/**
 * Every workflow that must reach CI's verdict through the gate script.
 *
 * Deliberately a SUPERSET of `WEB_DEPLOY_WORKFLOWS` rather than a widening of
 * it: the three web workflows also share a concurrency posture
 * (`cancel-in-progress: true`) that `deploy-aws.yml` must NOT have — cancelling
 * it between `run-task` and its exit-code check orphans a live migration task.
 * Two different properties over two overlapping sets, so they are two lists.
 *
 * That opposite posture is ASSERTED below ("the API deploy must never cancel a
 * run mid-migration"), not merely described here. It was described here and
 * nowhere else until #574: the `it.each` that checks the posture iterates
 * `WEB_DEPLOY_WORKFLOWS`, which excludes `deploy-aws.yml`, so the exact flip
 * this paragraph warns against passed every gate in the repository. A stated
 * requirement is not a checked one.
 */
const GATED_DEPLOY_WORKFLOWS = [...WEB_DEPLOY_WORKFLOWS, 'deploy-aws.yml'] as const;

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

    for (const file of GATED_DEPLOY_WORKFLOWS) {
      const workflow = readWorkflow(file);
      const invocations = Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.run?.includes('require-ci-success.mjs'));
      expect(invocations, `${file} must invoke the gate script`).toHaveLength(1);
    }
  });

  /**
   * The regression #518 fixed, stated as the thing that must not come back.
   *
   * `deploy-aws.yml` carried a second, partial copy of `ci.yml` — 4 steps against
   * 21 — and the copy is what made a backend type error deployable: it ran the
   * suite and the esbuild bundle and never `tsc`. The repair is not "widen the
   * copy", it is "have no copy", so this asserts the ABSENCE rather than the
   * contents of one, and a re-added `test` job fails here with the reason.
   */
  it('no deploy workflow re-grows its own copy of the suite', () => {
    const RUNS_THE_API_SUITE = '--filter @mercaria/backend test';

    // Positive control FIRST. Without it a rename of the script or the filter
    // makes every assertion below pass by matching nothing, which is the exact
    // shape of a guard that reads clean while measuring nothing.
    const ciCommands = Object.values(readWorkflow(CI_WORKFLOW_FILE).jobs)
      .flatMap((job) => job.steps ?? [])
      .flatMap((step) => (step.run ? [step.run] : []));
    expect(
      ciCommands.some((command) => command.includes(RUNS_THE_API_SUITE)),
      'ci.yml no longer runs the API suite by this spelling — this guard is now vacuous',
    ).toBe(true);

    for (const file of GATED_DEPLOY_WORKFLOWS) {
      const commands = Object.values(readWorkflow(file).jobs)
        .flatMap((job) => job.steps ?? [])
        .flatMap((step) => (step.run ? [step.run] : []));
      for (const command of commands) {
        expect(
          command,
          `${file} runs the API suite itself — that is the drifted second copy #518 removed`,
        ).not.toContain(RUNS_THE_API_SUITE);
      }
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

    // NARROWED by #518. This used to also accept `--filter @mercaria/backend
    // test`, specifically so `deploy-aws.yml`'s own `test` job satisfied it —
    // which made the assertion agree that a job was verified by a copy of CI
    // that ran 4 of `ci.yml`'s 21 steps and never typechecked anything. There is
    // now ONE thing that counts as a verification, and it is CI's own verdict.
    const verified = commands.some((command) => command.includes('require-ci-success.mjs'));
    expect(verified, `${key} must wait for a green ci.yml run for this commit`).toBe(true);
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

/**
 * The setting whose thirty-line comment says it "reads like an optimisation to
 * flip", finally enforced (#574).
 *
 * Until this existed the requirement lived only in prose — in `deploy-aws.yml`'s
 * own header, and in the `GATED_DEPLOY_WORKFLOWS` docblock above — while the
 * only `cancel-in-progress` assertion in the repository iterated
 * `WEB_DEPLOY_WORKFLOWS` and asserted `true`. So the flip passed every gate.
 * There were four `toBe(true)` in this file and zero `toBe(false)`, which is
 * the control that turns "probably unenforced" into "certainly".
 *
 * Both halves matter and they break differently:
 *
 *  - **`cancel-in-progress: true`** would cancel a run between
 *    `run-task` and its exit-code check, ORPHANING a live migration task — the
 *    ECS task keeps running against production while the workflow reports
 *    nothing. It also triggers this workflow family's defensive rollback rather
 *    than preventing it (measured in Allo, 2026-08-09).
 *  - **A group keyed on the SHA** — the `ci.yml` shape, and the tempting
 *    "fix" for #574 since it stops evictions — would let two deploys migrate
 *    CONCURRENTLY. `@oxyhq/db`'s migrator takes no lock and assigns the
 *    interlock to its caller; this group IS that interlock. Evictions are the
 *    price of it, which is why #574 was answered by reporting them
 *    (`deploy-coverage.yml`) rather than by preventing them.
 */
describe('the API deploy must never cancel a run mid-migration', () => {
  const API_DEPLOY_WORKFLOW = 'deploy-aws.yml';

  it('does not cancel superseded runs, and says so explicitly', () => {
    const { concurrency } = readWorkflow(API_DEPLOY_WORKFLOW);
    expect(concurrency, `${API_DEPLOY_WORKFLOW} must declare a concurrency block`).toBeDefined();

    // Positive control for the ACCESSOR, not a second authority on the web
    // deploys' own requirement. Without it, a renamed key or a `readWorkflow`
    // that silently returned `{}` would make the assertion below read
    // `undefined`, and the failure would send the reader to the wrong place.
    expect(
      readWorkflow('deploy-cloudflare.yml').concurrency?.['cancel-in-progress'],
      'this key no longer reads as a boolean anywhere — the assertion below is measuring nothing',
    ).toBe(true);

    // Explicit `false`, not merely absent. GitHub defaults it to false, so
    // deleting the line is behaviourally identical and leaves a thirty-line
    // comment explaining a setting that is no longer written down — which is
    // how the next reader concludes it was never deliberate.
    expect(
      concurrency?.['cancel-in-progress'],
      `${API_DEPLOY_WORKFLOW} must NOT cancel in progress: a cancellation between ` +
        `\`run-task\` and its exit-code check orphans a live migration task`,
    ).toBe(false);
  });

  it('serialises per REF and never per sha, which would race two migrators', () => {
    const group = readWorkflow(API_DEPLOY_WORKFLOW).concurrency?.group ?? '';

    expect(group).toContain('github.ref');
    expect(
      group,
      `${API_DEPLOY_WORKFLOW} must not key its concurrency group on the sha: that gives every ` +
        `commit its own group, so two deploys migrate CONCURRENTLY against a migrator that ` +
        `takes no lock. It is the tempting "fix" for the evictions in #574 and it is unsafe; ` +
        `the answer there is deploy-coverage.yml, which REPORTS an eviction that was not ` +
        `covered by a later success.`,
    ).not.toContain('github.sha');
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

/**
 * A transport fault is not a verdict (#728).
 *
 * The failure this covers is real: `Deploy to AWS` run 32367249937 on
 * `8c6654a5` went red with `TypeError: fetch failed` / `UND_ERR_SOCKET` while
 * polling, `deploy` was skipped, and CI for that commit went on to SUCCEED eight
 * minutes later. Nothing re-fires when that happens — `deploy-aws.yml` triggers
 * on `push` and `workflow_dispatch` only — so the commit stays undeployed.
 *
 * The whole point is that "I could not ask" and "the answer was no" must stop
 * being the same observable. Two of the cases below are therefore about what
 * must STILL fail: a deliberate refusal, and a bug in the script itself.
 */
describe('the gate distinguishes a transport fault from a refusal', () => {
  const greenJobs = () =>
    gateModule.REQUIRED_CI_JOBS.map((name) => ({ name, conclusion: 'success' }));
  const completedRun: FakeRun = {
    id: 1,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://example.invalid/run/1',
  };

  /** The EXACT shape the real failure had, reproduced rather than approximated. */
  function socketError(): Error {
    const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    return Object.assign(new TypeError('fetch failed'), { cause });
  }

  /**
   * A clock that only moves when the gate sleeps.
   *
   * Sleeping IS the passage of time here, so the transport budget is exercised
   * without the test taking two real minutes — and a retry that forgot to sleep
   * would never reach the deadline, which is itself worth catching.
   */
  function fakeClock() {
    let clock = 0;
    return {
      now: () => clock,
      sleepFor: async (ms: number) => {
        clock += ms;
      },
    };
  }

  it('classifies the real error shape as transport, and a refusal as NOT', () => {
    expect(gateModule.isTransportError(socketError())).toBe(true);
    // The safety property: a deliberate refusal must never be retried.
    expect(gateModule.isTransportError(new gateModule.GateFailure('CI run concluded failure'))).toBe(
      false,
    );
    // And a bug in the script is not a network problem.
    expect(gateModule.isTransportError(new TypeError('x.map is not a function'))).toBe(false);
    expect(gateModule.isTransportError(undefined)).toBe(false);
  });

  it('retries a socket fault and still reaches the right verdict', async () => {
    const clock = fakeClock();
    let attempts = 0;
    const run = await gateModule.requireCiSuccess({
      repository: 'o/r',
      sha: 'abc',
      ...clock,
      findRuns: async () => {
        attempts += 1;
        if (attempts <= 3) throw socketError();
        return [completedRun];
      },
      readRunJobs: async () => greenJobs(),
    });
    expect(run.id).toBe(completedRun.id);
    // Vacuity floor: without this, a `findRuns` that never threw would pass the
    // assertion above and prove nothing about the retry.
    expect(attempts, 'the transport error was never actually raised').toBe(4);
  });

  it('retries a socket fault raised while reading the JOBS, not just the run', async () => {
    // The half a fix aimed only at `findRunsForSha` would leave open. Both calls
    // reach the network and a fault in either is equally not a verdict.
    const clock = fakeClock();
    let jobReads = 0;
    const run = await gateModule.requireCiSuccess({
      repository: 'o/r',
      sha: 'abc',
      ...clock,
      findRuns: async () => [completedRun],
      readRunJobs: async () => {
        jobReads += 1;
        if (jobReads <= 2) throw socketError();
        return greenJobs();
      },
    });
    expect(run.id).toBe(completedRun.id);
    expect(jobReads, 'the job read never threw').toBe(3);
  });

  it('FAILS on a persistent outage, with a message naming it as transport', async () => {
    const clock = fakeClock();
    let attempts = 0;
    const thrown = await gateModule
      .requireCiSuccess({
        repository: 'o/r',
        sha: 'abc',
        ...clock,
        findRuns: async () => {
          attempts += 1;
          throw socketError();
        },
        readRunJobs: async () => greenJobs(),
      })
      .then(
        () => null,
        (error: unknown) => error as Error,
      );

    expect(thrown, 'a permanently unreachable API must not hang or succeed').toBeInstanceOf(
      gateModule.GateFailure,
    );
    // The distinction is the whole fix: an operator must not read this as a red
    // CI and revert the commit.
    expect(thrown?.message).toMatch(/TRANSPORT failure, not a CI verdict/u);
    expect(thrown?.message).toMatch(/UND_ERR_SOCKET/u);
    expect(attempts, 'it gave up without retrying').toBeGreaterThan(1);
  });

  it('does NOT retry a refusal — a red CI still fails immediately', async () => {
    // The inverse of the fix, and the one that would be catastrophic to get
    // wrong: a catch wide enough to swallow `GateFailure` turns a false red into
    // a false GREEN.
    const clock = fakeClock();
    let attempts = 0;
    const thrown = await gateModule
      .requireCiSuccess({
        repository: 'o/r',
        sha: 'abc',
        ...clock,
        findRuns: async () => {
          attempts += 1;
          return [{ ...completedRun, conclusion: 'failure' }];
        },
        readRunJobs: async () => greenJobs(),
      })
      .then(
        () => null,
        (error: unknown) => error as Error,
      );

    expect(thrown).toBeInstanceOf(gateModule.GateFailure);
    expect(thrown?.message).toMatch(/concluded `failure`/u);
    expect(thrown?.message).not.toMatch(/TRANSPORT/u);
    expect(attempts, 'a refusal was polled more than once').toBe(1);
  });

  it('rethrows a NON-transport error unchanged instead of retrying it', async () => {
    // A bug in this script must surface as itself, immediately. Retrying it for
    // two minutes and then reporting a network problem is a wrong diagnosis
    // printed with confidence.
    const clock = fakeClock();
    let attempts = 0;
    const bug = new TypeError('runs.filter is not a function');
    const thrown = await gateModule
      .requireCiSuccess({
        repository: 'o/r',
        sha: 'abc',
        ...clock,
        findRuns: async () => {
          attempts += 1;
          throw bug;
        },
        readRunJobs: async () => greenJobs(),
      })
      .then(
        () => null,
        (error: unknown) => error as Error,
      );

    expect(thrown).toBe(bug);
    expect(thrown).not.toBeInstanceOf(gateModule.GateFailure);
    expect(attempts).toBe(1);
  });

  it('resets the budget on success, so intermittent blips never accumulate', async () => {
    // CONSECUTIVE, not cumulative. Ten faults spread across a long poll must not
    // add up to a refusal — that would make a flaky network indistinguishable
    // from an outage, which is the bug one level up.
    const clock = fakeClock();
    let attempts = 0;
    const run = await gateModule.requireCiSuccess({
      repository: 'o/r',
      sha: 'abc',
      ...clock,
      findRuns: async () => {
        attempts += 1;
        // Alternate: fault, pending, fault, pending… far longer in total than
        // TRANSPORT_TIMEOUT_MS, but never consecutively so.
        if (attempts % 2 === 1 && attempts < 20) throw socketError();
        if (attempts < 20) return [{ ...completedRun, status: 'in_progress', conclusion: null }];
        return [completedRun];
      },
      readRunJobs: async () => greenJobs(),
    });
    expect(run.id).toBe(completedRun.id);
    expect(attempts).toBe(20);
  });
});
