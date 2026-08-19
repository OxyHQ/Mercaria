/**
 * What is merged on `main` is asserted to have shipped (#574).
 *
 * ## Why a test in this package, for files it never runs
 *
 * The reason `deployWorkflow.test.ts` and `deployGating.test.ts` give: the
 * workflows are code with no runner, so a check that stops checking fails
 * SILENTLY and everything downstream stays green. This one guards a check whose
 * whole purpose is to notice silence, which makes its own silence the worst
 * possible failure.
 *
 * ## What each assertion here is worth
 *
 * The load-bearing pair is the population and the NAMES.
 * `require-deploy-coverage.mjs` watches a list of workflows, and
 * `deploy-coverage.yml` triggers on a list of workflow NAMES — two
 * hand-maintained lists, which is the "gate that skips what a hand-maintained
 * map omits" shape. So the population is DERIVED by walking every workflow file
 * for a job holding a production credential (the predicate
 * `deployGating.test.ts` already established: a credential is what makes a job
 * able to ship, and a name is just a name), and asserted by EQUALITY. A fifth
 * deploy target, or a renamed workflow, fails the build instead of quietly
 * dropping out of the watch — and a rename is the realistic one, because
 * `workflow_run` matches on the display name and a stale name there fires for
 * nothing at all.
 *
 * The rest pin `judgeCoverage` against the four shapes that read as "everything
 * shipped" while work sits unshipped. The one to read is the ORDERING test: an
 * evicted run completes in seconds while the run it queued behind takes
 * fifteen minutes, so ordering coverage by `updated_at` puts the success ABOVE
 * the cancellations it did not cover. That is not hypothetical — it is what the
 * first implementation of this check did, and replaying it against
 * 2026-08-17T07:39Z reported 1 unshipped commit where the truth was 3.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { POST_PHASE_GREP_PATTERN } from '@oxyhq/db/migrate';
import { MIGRATIONS_FOLDER } from '../migrationsFolder.js';

/** The repo root, from this file: `packages/backend/src/db/__tests__` is five deep. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');
const COVERAGE_WORKFLOW = 'deploy-coverage.yml';
const SCRIPT_PATH = join(REPO_ROOT, '.github', 'scripts', 'require-deploy-coverage.mjs');

interface CoverageRun {
  run_attempt?: number;
  run_number?: number;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  created_at?: string;
  html_url?: string;
}
interface Verdict {
  state: 'covered' | 'pending' | 'uncovered' | 'no_runs' | 'no_success_in_page';
  uncovered: CoverageRun[];
  pending: CoverageRun[];
  lastSuccess?: CoverageRun | null;
}

interface WatchedWorkflow {
  file: string;
  name: string;
  migrations: boolean;
  statesOutcome: boolean;
}
interface OutcomeHalfSteps {
  half: string;
  positive: string;
  negative: string;
  absentMeans: string;
}
interface OutcomeStep {
  name?: string;
  conclusion?: string | null;
}
interface OutcomeVerdict {
  state: 'shipped' | 'hollow' | 'unstated' | 'contradictory' | 'unreadable';
  jobCount: number;
  stepCount: number;
  halves: { half: string; absentMeans: string; verdict: string }[];
}

/**
 * Loaded through a runtime-computed specifier, for `deployGating.test.ts`'s
 * reason: this package's `rootDir` is its own root, so a static import of a
 * file under `.github/` is a TS6059 that refuses the whole program. The point
 * is to read the REAL constants rather than re-declare copies here, and a copy
 * is exactly what this file exists to forbid.
 */
const coverage: {
  DEPLOY_WORKFLOWS: readonly WatchedWorkflow[];
  DEPLOY_OUTCOME_STEPS: readonly OutcomeHalfSteps[];
  POST_PHASE_MARKER: string;
  MIGRATIONS_PATH: string;
  DEFAULT_STALE_RUN_MS: number;
  judgeCoverage: (input: { runs: CoverageRun[]; now?: number; staleRunMs?: number }) => Verdict;
  judgeDeployOutcome: (input: { jobs: { steps?: OutcomeStep[] }[] }) => OutcomeVerdict;
  addedMigrationFiles: (files: { status?: string; filename: string }[]) => string[];
  declaresPostPhase: (body: string) => boolean;
  PRE_PHASE_MARKER: string;
  declaredPhase: (body: string) => 'pre' | 'post' | 'unknown';
  judgeMigrationContainment: (input: {
    tipMigrations: string[] | null;
    appliedMigrations: string[] | null;
  }) => { state: string; missing: string[] };
  splitMigrationsByPhase: (
    missing: string[],
    phaseOf: (name: string) => 'pre' | 'post' | 'unknown',
  ) => { post: string[]; pre: string[] };
  checkDeployCoverage: (input: {
    repository: string;
    token?: string;
    workflows?: readonly WatchedWorkflow[];
    log?: (line: string) => void;
  }) => Promise<{ problems: string[]; deferred: string[] }>;
} = await import(pathToFileURL(SCRIPT_PATH).href);

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface WorkflowFile {
  name?: string;
  on?: {
    push?: { branches?: string[] };
    workflow_run?: { workflows?: string[]; types?: string[] };
    schedule?: { cron: string }[];
    workflow_dispatch?: unknown;
  };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

function readWorkflow(file: string): WorkflowFile {
  return parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf8')) as WorkflowFile;
}

/**
 * A job able to ship, by the CREDENTIAL it holds rather than by its name —
 * `deployGating.test.ts`'s predicate, kept identical on purpose so the two
 * tests cannot disagree about what a deploy is.
 */
function shipsToProduction(steps: WorkflowStep[] = []): boolean {
  return steps.some(
    (step) =>
      step.uses?.startsWith('aws-actions/configure-aws-credentials') ||
      Object.values(step.env ?? {}).some((value) =>
        String(value).includes('secrets.CLOUDFLARE_API_TOKEN'),
      ),
  );
}

/** Every workflow file in the repo holding a credential that can ship. */
const CREDENTIAL_FILES = readdirSync(WORKFLOWS_DIR)
  .filter((file) => file.endsWith('.yml'))
  .filter((file) =>
    Object.values(readWorkflow(file).jobs ?? {}).some((job) => shipsToProduction(job.steps)),
  )
  .sort();

/** Of those, the ones a MERGE sets off — the population "unshipped" is about. */
const DEPLOYING_FILES = CREDENTIAL_FILES.filter((file) =>
  (readWorkflow(file).on?.push?.branches ?? []).includes('main'),
).sort();

/**
 * Credential-holding workflows a merge does NOT set off.
 *
 * Named rather than filtered away in silence: this check's population is
 * derived, and a derivation that quietly drops members is the thing it exists
 * to avoid. A new entry here is a decision somebody has to make — is this a
 * deploy that can fall behind `main`, or a one-shot? — which is exactly the
 * question the equality below cannot ask on its own.
 */
const DISPATCH_ONLY_WITH_CREDENTIALS: Record<string, string> = {
  // A one-shot DNS/ACM setup for mcp.mention.earth, a different product, run by
  // hand. It holds a Cloudflare token and ships nothing on merge, so there is
  // no "merged but not deployed" state it can be in.
  'setup-mention-mcp-dns.yml': 'workflow_dispatch one-shot, not triggered by merging',
};

describe('the coverage check watches every workflow that can ship', () => {
  it('watches exactly the credential-holding workflows a merge sets off', () => {
    // Vacuity floor. A walk that parsed nothing, or a predicate that matched
    // nothing, produces an empty set — and an empty set is trivially equal to
    // an empty `DEPLOY_WORKFLOWS`, which is the shape that reads green while
    // watching nothing at all.
    expect(CREDENTIAL_FILES.length).toBeGreaterThanOrEqual(4);
    expect(DEPLOYING_FILES.length).toBeGreaterThanOrEqual(4);

    // EQUALITY, never containment: a `>= 4` floor is satisfied by the four that
    // already exist and says nothing about a fifth.
    expect(coverage.DEPLOY_WORKFLOWS.map((entry) => entry.file).sort()).toEqual(DEPLOYING_FILES);
  });

  it('accounts for every credential-holding workflow it does NOT watch', () => {
    // The narrowing above is only honest if what it drops is enumerated. A new
    // credential-holding workflow fails here until somebody classifies it,
    // which is the half a `push`-trigger filter silently skips.
    const excluded = CREDENTIAL_FILES.filter((file) => !DEPLOYING_FILES.includes(file));
    expect(excluded.sort()).toEqual(Object.keys(DISPATCH_ONLY_WITH_CREDENTIALS).sort());
  });

  it('knows each workflow by the name the Actions API really reports', () => {
    for (const entry of coverage.DEPLOY_WORKFLOWS) {
      const real = readWorkflow(entry.file).name;
      expect(real, `${entry.file} has no name:`).toBeTruthy();
      expect(entry.name, `${entry.file} was renamed to "${real}"`).toBe(real);
    }
  });

  it('marks exactly the workflow whose gap can leave the DATABASE behind', () => {
    // The API deploy is the only one that applies migrations, and that is what
    // separates "some code is a few minutes late" from "a constraint the code
    // relies on is not in the database".
    const withMigrations = coverage.DEPLOY_WORKFLOWS.filter((entry) => entry.migrations);
    expect(withMigrations.map((entry) => entry.file)).toEqual(['deploy-aws.yml']);
  });
});

describe('the coverage workflow is wired to the workflows it claims to watch', () => {
  const workflow = readWorkflow(COVERAGE_WORKFLOW);

  it('triggers on the completion of exactly those workflows, by name', () => {
    // The realistic failure: somebody renames a deploy workflow, this list
    // keeps the old name, and `workflow_run` silently matches nothing. There is
    // no error anywhere — the check just stops running for that target.
    const watched = workflow.on?.workflow_run?.workflows ?? [];
    expect(watched.slice().sort()).toEqual(coverage.DEPLOY_WORKFLOWS.map((e) => e.name).sort());
    expect(workflow.on?.workflow_run?.types).toEqual(['completed']);
  });

  it('keeps the schedule that carries the guarantee when no event fires', () => {
    // `workflow_run` makes the answer fast; the cron is what makes it certain.
    // A run held `action_required`, a human cancellation or a stalled queue can
    // emit nothing the trigger above would see.
    expect(workflow.on?.schedule?.length, 'the scheduled backstop is gone').toBeGreaterThan(0);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
  });

  it('runs the real script and asks for no more permission than reading', () => {
    const commands = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .flatMap((step) => (step.run ? [step.run] : []));
    expect(commands.some((command) => command.includes('require-deploy-coverage.mjs'))).toBe(true);

    // A report must not be able to act. `actions: write` would let it
    // re-dispatch a deploy, which against a genuinely failing one loops.
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
  });

  it('cannot build the queue it exists to report on', () => {
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(true);
  });
});

describe('the script and the migrator agree about what a post migration is', () => {
  it('spells the phase marker the way @oxyhq/db does', () => {
    // Vacuity floor, matching `deployWorkflow.test.ts`: an empty constant would
    // make the containment below pass against anything.
    expect(coverage.POST_PHASE_MARKER.length).toBeGreaterThan(10);
    // The script cannot import the package (the job runs on bare node with no
    // `bun install`), so it carries the marker without the grep anchors. The
    // pattern must still be exactly that marker, anchored.
    expect(POST_PHASE_GREP_PATTERN).toBe(`^${coverage.POST_PHASE_MARKER}$`);
  });

  it('looks for migrations where the migrator actually keeps them', () => {
    expect(coverage.MIGRATIONS_PATH.split('/').join(sep)).toBe(
      relative(REPO_ROOT, MIGRATIONS_FOLDER),
    );
  });

  it('tells a post migration from a pre one', () => {
    expect(coverage.declaresPostPhase('-- oxy:deploy-phase=post\nALTER TABLE x;')).toBe(true);
    // The discriminating half. A body check that merely looked for
    // `oxy:deploy-phase` would call every migration a post migration and report
    // an alarm on every unshipped commit, which is how an alarm gets ignored.
    expect(coverage.declaresPostPhase('-- oxy:deploy-phase=pre\nALTER TABLE x;')).toBe(false);
    expect(coverage.declaresPostPhase('ALTER TABLE x;')).toBe(false);
  });

  it('counts only migrations a commit ADDED', () => {
    const files = [
      { status: 'added', filename: 'packages/backend/drizzle/0106_panoramic_patch.sql' },
      { status: 'modified', filename: 'packages/backend/drizzle/meta/_journal.json' },
      // A file that merely CHANGED is not a new migration: the journal is
      // append-only, so a modified `.sql` is a rewrite of something already
      // applied and counting it would report a phantom pending drop.
      { status: 'modified', filename: 'packages/backend/drizzle/0044_curly_boomerang.sql' },
      { status: 'added', filename: 'packages/backend/src/db/schema/orders.ts' },
    ];
    expect(coverage.addedMigrationFiles(files)).toEqual([
      'packages/backend/drizzle/0106_panoramic_patch.sql',
    ]);
  });
});

describe('judgeCoverage refuses the shapes that read as "everything shipped"', () => {
  /**
   * A fixture epoch far in the PAST, and it must stay that way.
   *
   * This was first written as the real date of the window these cases model,
   * 17 August 2026, and that broke `fixture-date-census` the same day, because
   * the real clock reached it. A literal dated today or later is the #253 bug:
   * it passes while you write it, keeps passing, and fails for whoever pushes
   * on the day it arrives, in a file they did not touch.
   *
   * Only the ORDER of these instants matters to `judgeCoverage`, never their
   * absolute value, so the epoch is arbitrary and is chosen to be unreachable.
   * The times-of-day still line up with the incident the cases are named for
   * (07:14, 07:22, 07:23, 07:24) because every instant below is an OFFSET from
   * this one — deliberately, since a second date literal is how this recurs in
   * a form the census cannot see.
   *
   * Note the date above carries no quotes or backticks around it, on purpose:
   * that census matches an opening quote OR BACKTICK followed by a date, so a
   * date wrapped in markdown ticks inside a comment reads to it exactly like a
   * code literal. The first attempt at this very note failed the gate it was
   * explaining.
   */
  const T = Date.parse('2020-01-01T07:00:00Z');
  const minutes = (n: number) => T + n * 60_000;

  /** A completed run. `created` and `finished` are minutes past T. */
  const done = (
    run_number: number,
    head_sha: string,
    conclusion: string,
    created: number,
  ): CoverageRun => ({
    run_number,
    head_sha,
    conclusion,
    status: 'completed',
    created_at: new Date(minutes(created)).toISOString(),
    html_url: `https://example.invalid/${run_number}`,
  });

  const running = (run_number: number, head_sha: string, created: number): CoverageRun => ({
    run_number,
    head_sha,
    conclusion: null,
    status: 'in_progress',
    created_at: new Date(minutes(created)).toISOString(),
    html_url: `https://example.invalid/${run_number}`,
  });

  it('passes when the newest run succeeded', () => {
    const verdict = coverage.judgeCoverage({
      runs: [done(1, 'aaaaaaaa', 'success', 0), done(2, 'bbbbbbbb', 'success', 5)],
      now: minutes(30),
    });
    expect(verdict.state).toBe('covered');
    expect(verdict.lastSuccess?.head_sha).toBe('bbbbbbbb');
  });

  it('defers while a run is still in flight rather than reporting a gap', () => {
    // The eviction case at the instant it happens: the evicted run is cancelled
    // and its EVICTOR is running. Reporting here would fire on all 125 of the
    // in-flight completions measured over four weeks, and an alarm that fires
    // on work already in hand is one somebody mutes.
    const verdict = coverage.judgeCoverage({
      runs: [
        done(1, 'aaaaaaaa', 'success', 0),
        done(2, 'ffffffff', 'cancelled', 5),
        running(3, 'cccccccc', 6),
      ],
      now: minutes(10),
    });
    expect(verdict.state).toBe('pending');
    expect(verdict.pending.map((run) => run.head_sha)).toEqual(['cccccccc']);
  });

  it('reports the eviction once its EVICTOR has failed too', () => {
    // 2026-08-17T07:22–07:39Z, the branch that makes eviction unsafe.
    const verdict = coverage.judgeCoverage({
      runs: [
        done(1, 'ae3ed27e', 'success', 14),
        done(2, '0f93aecd', 'cancelled', 22),
        done(3, '01a5e50c', 'cancelled', 23),
        done(4, '61e21d7f', 'failure', 24),
      ],
      now: minutes(45),
    });
    expect(verdict.state).toBe('uncovered');
    expect(verdict.uncovered.map((run) => run.head_sha)).toEqual([
      '61e21d7f',
      '01a5e50c',
      '0f93aecd',
    ]);
    expect(verdict.lastSuccess?.head_sha).toBe('ae3ed27e');
  });

  it('orders coverage by run number, not by when a run FINISHED', () => {
    /**
     * The bug this check shipped with, caught by replaying it against real
     * history rather than by reading it.
     *
     * An evicted run is cancelled within seconds of being created, while the
     * successful run it was queued behind takes a quarter of an hour. Sorted by
     * `updated_at`, that success lands ABOVE the cancellations it never
     * covered, and the verdict reads `uncovered = 1` where the truth is 3.
     *
     * Here run 1 succeeded but was CREATED first and finished last; runs 2-4
     * are the later commits. Only a run-number ordering puts all three above
     * it. Under any completion-order sort this test reports fewer.
     */
    const slowSuccess = done(1, 'ae3ed27e', 'success', 14);
    const verdict = coverage.judgeCoverage({
      runs: [
        done(4, '61e21d7f', 'failure', 24),
        done(2, '0f93aecd', 'cancelled', 22),
        slowSuccess,
        done(3, '01a5e50c', 'cancelled', 23),
      ],
      now: minutes(45),
    });
    expect(verdict.uncovered).toHaveLength(3);
  });

  it('does not let a re-run of an OLD run cover the commits after it', () => {
    /**
     * A re-run keeps its `run_number`. The obvious recovery from a red deploy
     * is to re-run the last green one, and that must NOT read as shipping the
     * newer commits it never contained — it would silence this report while
     * leaving production exactly as stale.
     *
     * The timestamps here disagree with the run numbers on purpose: the
     * re-attempted run 9 carries the LATEST `created_at` of the two. Whatever a
     * re-run does to that field, the ordering must follow the run number, so
     * this is the case that separates the two possible sort keys rather than
     * one where they happen to agree.
     */
    const verdict = coverage.judgeCoverage({
      runs: [
        { ...done(9, 'old00000', 'success', 40), run_attempt: 2 } as CoverageRun,
        done(10, 'new00000', 'failure', 5),
      ],
      now: minutes(45),
    });
    expect(verdict.state).toBe('uncovered');
    expect(verdict.uncovered.map((run) => run.head_sha)).toEqual(['new00000']);
  });

  it('stops deferring to a run that has been in flight far too long', () => {
    // Otherwise a run stuck `queued` is a permanent way for this check to be
    // silent, which is the same silence it exists to break.
    const verdict = coverage.judgeCoverage({
      runs: [done(1, 'aaaaaaaa', 'success', 0), done(2, 'bbbbbbbb', 'failure', 5), running(3, 'cccccccc', 6)],
      now: minutes(6) + coverage.DEFAULT_STALE_RUN_MS + 1,
    });
    expect(verdict.state).toBe('uncovered');
  });

  it('does not report "no runs" as "nothing is missing"', () => {
    // An empty read is what a renamed file, a wrong branch or a token without
    // `actions: read` produces, and it is indistinguishable from a quiet week.
    expect(coverage.judgeCoverage({ runs: [], now: minutes(0) }).state).toBe('no_runs');
  });

  it('says so when the whole page it read contains no success', () => {
    // Distinct from `uncovered`, which names a last-known-good run. Claiming a
    // precise unshipped set from a page that may simply not reach back far
    // enough would be a true statement about the page and a misleading one
    // about the repository.
    const verdict = coverage.judgeCoverage({
      runs: [done(1, 'aaaaaaaa', 'failure', 0), done(2, 'bbbbbbbb', 'cancelled', 5)],
      now: minutes(45),
    });
    expect(verdict.state).toBe('no_success_in_page');
    expect(verdict.lastSuccess).toBeNull();
  });
});

describe('the check refuses to report a green it did not measure', () => {
  it('fails when every workflow reads back zero runs', async () => {
    // The vacuity floor, exercised. Without it, a token that lost
    // `actions: read`, a renamed workflow file or a wrong branch all print
    // "every deploy workflow's newest run succeeded" — the precise shape of a
    // check that reads clean while measuring nothing.
    const lines: string[] = [];
    await expect(
      coverage.checkDeployCoverage({
        repository: 'owner/repo',
        // Reachable only if the walk is empty, which is the condition under test.
        workflows: [],
        log: (line) => lines.push(line),
      }),
    ).rejects.toThrow(/not a quiet week/);
    expect(lines).toEqual([]);
  });
});

/**
 * Every step name declared anywhere in a workflow file.
 *
 * PARSED, never grepped: the workflow explains the outcome mechanism in its own
 * comments and in the shell comments inside its `run:` blocks, so a text search
 * for these names would match the prose that describes them and read as a
 * statement that is not there.
 */
function declaredStepNames(file: string): string[] {
  return Object.values(readWorkflow(file).jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .flatMap((step) => (typeof step.name === 'string' ? [step.name] : []));
}

/** Every name either half of the outcome statement can take. */
const OUTCOME_STEP_NAMES = coverage.DEPLOY_OUTCOME_STEPS.flatMap((half) => [
  half.positive,
  half.negative,
]);

/** Workflow files that really carry an outcome statement, derived by walking them. */
const FILES_STATING_AN_OUTCOME = readdirSync(WORKFLOWS_DIR)
  .filter((file) => file.endsWith('.yml'))
  .filter((file) => declaredStepNames(file).some((name) => OUTCOME_STEP_NAMES.includes(name)))
  .sort();

describe('a deploy run states its own outcome, and the check reads the statement (#608)', () => {
  it('marks exactly the workflows that really declare one', () => {
    // Vacuity floor on the vocabulary itself. An empty `DEPLOY_OUTCOME_STEPS`
    // would make every containment below pass against every workflow, and the
    // derived population would be empty and trivially equal to an empty flag
    // set — a gate watching nothing, reading green.
    expect(coverage.DEPLOY_OUTCOME_STEPS.length).toBeGreaterThanOrEqual(2);
    expect(OUTCOME_STEP_NAMES.length).toBe(coverage.DEPLOY_OUTCOME_STEPS.length * 2);
    expect(new Set(OUTCOME_STEP_NAMES).size).toBe(OUTCOME_STEP_NAMES.length);
    expect(FILES_STATING_AN_OUTCOME.length).toBeGreaterThanOrEqual(1);

    // EQUALITY both ways. A workflow that grows a statement must be read for
    // one, and a workflow whose statement was deleted must stop being trusted
    // to make it — the second is the direction that reads green while the check
    // silently starts inferring "shipped" from a conclusion again.
    expect(
      coverage.DEPLOY_WORKFLOWS.filter((entry) => entry.statesOutcome)
        .map((entry) => entry.file)
        .sort(),
    ).toEqual(FILES_STATING_AN_OUTCOME);
  });

  it('declares every half of the statement, exactly once, in the deploy job', () => {
    const names = declaredStepNames('deploy-aws.yml');
    for (const name of OUTCOME_STEP_NAMES) {
      expect(names.filter((declared) => declared === name), `step "${name}"`).toHaveLength(1);
    }
  });

  it('writes each half as one predicate and its negation, so exactly one runs', () => {
    /**
     * The property the reader depends on: "neither ran" and "both ran" are
     * states `judgeDeployOutcome` REFUSES rather than interprets, which is only
     * honest if the workflow cannot produce them.
     *
     * The transform below is De Morgan for the shape these conditions actually
     * take — a disjunction of `==` comparisons — and it deliberately does not
     * generalise. A condition it cannot negate fails this test rather than
     * being waved through, which is the right outcome: a pair whose
     * exhaustiveness needs a paragraph to see is a pair somebody will get
     * wrong.
     */
    const negate = (condition: string): string =>
      condition
        .replace(/\s+/g, ' ')
        .trim()
        .split(' || ')
        .map((clause) => clause.replace(' == ', ' != '))
        .join(' && ');

    const steps = Object.values(readWorkflow('deploy-aws.yml').jobs ?? {}).flatMap(
      (job) => job.steps ?? [],
    );
    const conditionOf = (name: string): string => {
      const step = steps.find((candidate) => candidate.name === name);
      expect(step, `no step named "${name}"`).toBeDefined();
      return (step?.if ?? '').replace(/\s+/g, ' ').trim();
    };

    for (const half of coverage.DEPLOY_OUTCOME_STEPS) {
      const positive = conditionOf(half.positive);
      // Vacuity floor: an unconditional step has no `if:` at all, and `negate('')`
      // is `''`, so without this the equality below would pass for a pair that
      // BOTH always run.
      expect(positive, `"${half.positive}" has no if:`).toContain(' == ');
      expect(conditionOf(half.negative), `the ${half.half} pair is not exhaustive`).toBe(
        negate(positive),
      );
    }
  });

  it('asks ECS whether the service exists exactly once, and never swallows the answer', () => {
    /**
     * #608's root defect: `aws ecs describe-services ... 2>/dev/null || echo NONE`
     * made a FAILED query indistinguishable from an ABSENT service. Measured
     * against the real account on 2026-08-18 — an absent service exits 0 and
     * prints `None`, while a missing cluster, an invalid credential and an
     * unreachable endpoint exit 254, 254 and 255 — so the exit code is the
     * discriminator and the `||` is what destroyed it.
     *
     * There were TWO such call sites, and the second (inside a step with no
     * `if:`, which therefore always reported `success`) is what could leave a
     * MIGRATED database served by the PREVIOUS image.
     */
    const stripShellComments = (block: string): string =>
      block
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');

    const runBlocks = Object.values(readWorkflow('deploy-aws.yml').jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .flatMap((step) => (typeof step.run === 'string' ? [step.run] : []));
    const swallows = (block: string): boolean => /\|\|\s*echo\s+NONE/.test(block);

    // The detector can fail. Without this the census below would also pass
    // against a spelling that never matches anything — and it is the comment
    // stripping that makes the difference here, because this workflow now
    // EXPLAINS the old idiom in shell comments inside the very blocks censused.
    expect(swallows('S=$(aws ecs describe-services ... 2>/dev/null || echo NONE)')).toBe(true);
    expect(stripShellComments('  # ... || echo NONE ...\nreal_command')).not.toContain('NONE');

    // Vacuity floor on the population.
    expect(runBlocks.length).toBeGreaterThanOrEqual(5);
    expect(runBlocks.map(stripShellComments).filter(swallows)).toEqual([]);

    // One authority for "does the service exist". The rollout must READ the
    // resolved verdict rather than take its own, or the two can disagree.
    const rollout = Object.values(readWorkflow('deploy-aws.yml').jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.name?.startsWith('Deploy to ECS'));
    expect(rollout, 'the rollout step is gone').toBeDefined();
    expect(rollout?.if ?? '').toContain("steps.ecs.outputs.status == 'ACTIVE'");

    // And a failed query must be loud rather than silently "no service".
    const resolve = Object.values(readWorkflow('deploy-aws.yml').jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.name === 'Resolve the ECS one-shot shape');
    expect(stripShellComments(resolve?.run ?? '')).toContain('exit 1');
  });
});

describe('judgeDeployOutcome refuses every green it did not read a statement from', () => {
  const [MIGRATIONS, ROLLOUT] = coverage.DEPLOY_OUTCOME_STEPS;

  /** A run's steps, given what each half of the statement said. */
  const runWith = (
    migrations: 'positive' | 'negative',
    rollout: 'positive' | 'negative',
  ): { steps: OutcomeStep[] }[] => [
    { steps: [{ name: 'Build and push (linux/arm64)', conclusion: 'success' }] },
    {
      steps: [
        { name: 'Resolve the ECS one-shot shape', conclusion: 'success' },
        {
          name: MIGRATIONS.positive,
          conclusion: migrations === 'positive' ? 'success' : 'skipped',
        },
        {
          name: MIGRATIONS.negative,
          conclusion: migrations === 'negative' ? 'success' : 'skipped',
        },
        { name: ROLLOUT.positive, conclusion: rollout === 'positive' ? 'success' : 'skipped' },
        { name: ROLLOUT.negative, conclusion: rollout === 'negative' ? 'success' : 'skipped' },
      ],
    },
  ];

  it('passes only when both halves say it happened', () => {
    const verdict = coverage.judgeDeployOutcome({ jobs: runWith('positive', 'positive') });
    expect(verdict.state).toBe('shipped');
    expect(verdict.halves.map((half) => half.verdict)).toEqual(['positive', 'positive']);
  });

  it('names the rollout when the database moved and the image did not', () => {
    // THE WORST OF THE THREE STATES, and the one the cheap fix could not reach:
    // `Migrate (pre)` ran, so inferring from its `skipped` conclusion reports
    // this run as shipped. Here the run says otherwise itself.
    const verdict = coverage.judgeDeployOutcome({ jobs: runWith('positive', 'negative') });
    expect(verdict.state).toBe('hollow');
    expect(verdict.halves.filter((half) => half.verdict === 'negative')).toEqual([
      { half: ROLLOUT.half, absentMeans: ROLLOUT.absentMeans, verdict: 'negative' },
    ]);
  });

  it('names the migrations when the image rolled and the database did not', () => {
    const verdict = coverage.judgeDeployOutcome({ jobs: runWith('negative', 'positive') });
    expect(verdict.state).toBe('hollow');
    expect(verdict.halves.filter((half) => half.verdict === 'negative').map((h) => h.half)).toEqual([
      MIGRATIONS.half,
    ]);
  });

  it('reports the short-circuit, where neither half happened', () => {
    expect(coverage.judgeDeployOutcome({ jobs: runWith('negative', 'negative') }).state).toBe(
      'hollow',
    );
  });

  it('does not read "no steps" as "no step said no"', () => {
    // THE VACUITY FLOOR. A token that lost `actions: read`, a wrong run id and
    // an API shape change all produce an empty read, and an empty read passes
    // every "is this step skipped" test there is — because there is no step.
    expect(coverage.judgeDeployOutcome({ jobs: [] }).state).toBe('unreadable');
    expect(coverage.judgeDeployOutcome({ jobs: [{ steps: [] }, {}] }).state).toBe('unreadable');
  });

  it('refuses a run that states nothing rather than assuming the best', () => {
    // Every run created before #608 is in this state, as is any run of a
    // workflow whose statement was deleted. Both must be red: the entire point
    // is that a conclusion of `success` does not carry "it shipped".
    const verdict = coverage.judgeDeployOutcome({
      jobs: [{ steps: [{ name: 'Deploy to ECS (rolling)', conclusion: 'success' }] }],
    });
    expect(verdict.state).toBe('unstated');
  });

  it('refuses a half-stated run', () => {
    const jobs = runWith('positive', 'positive');
    jobs[1].steps = (jobs[1].steps ?? []).filter((step) => step.name !== MIGRATIONS.positive);
    const verdict = coverage.judgeDeployOutcome({ jobs });
    expect(verdict.state).toBe('contradictory');
    expect(verdict.halves.find((half) => half.half === MIGRATIONS.half)?.verdict).toBe('ambiguous');
  });

  it('refuses a run where both members of a pair ran, or neither did', () => {
    const both = runWith('positive', 'positive');
    both[1].steps = (both[1].steps ?? []).map((step) =>
      step.name === ROLLOUT.negative ? { ...step, conclusion: 'success' } : step,
    );
    expect(coverage.judgeDeployOutcome({ jobs: both }).state).toBe('contradictory');

    const neither = runWith('positive', 'positive');
    neither[1].steps = (neither[1].steps ?? []).map((step) =>
      step.name === ROLLOUT.positive ? { ...step, conclusion: 'skipped' } : step,
    );
    expect(coverage.judgeDeployOutcome({ jobs: neither }).state).toBe('contradictory');
  });

  it('refuses a duplicated statement instead of believing the first copy', () => {
    const jobs = runWith('positive', 'positive');
    jobs.push({ steps: [{ name: ROLLOUT.positive, conclusion: 'skipped' }] });
    expect(coverage.judgeDeployOutcome({ jobs }).state).toBe('contradictory');
  });
});

describe('the check itself refuses to print "shipped" for a hollow green', () => {
  /**
   * End to end through `checkDeployCoverage`, over a stubbed transport.
   *
   * The pure verdict above is worth nothing if nothing calls it, and "the
   * mechanism is green and inert" is the failure this repository has paid for
   * more than once. So this drives the REAL entry point and asserts both that
   * the second API call is made and that its answer changes the report.
   */
  const run = {
    id: 4242,
    run_number: 7,
    head_sha: 'abcdef1234567890',
    status: 'completed',
    conclusion: 'success',
    created_at: new Date(Date.parse('2020-01-01T07:00:00Z')).toISOString(),
    html_url: 'https://example.invalid/4242',
  };
  const watched: WatchedWorkflow[] = [
    { file: 'deploy-aws.yml', name: 'Deploy to AWS', migrations: true, statesOutcome: true },
  ];

  /** Serves the runs list, then the jobs of run 4242 with the given step list. */
  const transport = (steps: OutcomeStep[], seen: string[]) => (url: string) => {
    seen.push(url);
    const body = url.includes('/jobs') ? { jobs: [{ steps }] } : { workflow_runs: [run] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };

  const statement = (rollout: 'success' | 'skipped'): OutcomeStep[] => [
    { name: coverage.DEPLOY_OUTCOME_STEPS[0].positive, conclusion: 'success' },
    { name: coverage.DEPLOY_OUTCOME_STEPS[0].negative, conclusion: 'skipped' },
    { name: coverage.DEPLOY_OUTCOME_STEPS[1].positive, conclusion: rollout },
    {
      name: coverage.DEPLOY_OUTCOME_STEPS[1].negative,
      conclusion: rollout === 'success' ? 'skipped' : 'success',
    },
  ];

  it('reads the run it just called green, and reports the missing half', async () => {
    const seen: string[] = [];
    const lines: string[] = [];
    vi.stubGlobal('fetch', transport(statement('skipped'), seen));
    try {
      const { problems } = await coverage.checkDeployCoverage({
        repository: 'OxyHQ/Mercaria',
        workflows: watched,
        log: (line) => lines.push(line),
      });
      // The second call is the whole mechanism; without it there is nothing to
      // judge and the report is the old one.
      expect(seen.some((url) => url.includes('/actions/runs/4242/jobs'))).toBe(true);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('HOLLOW GREEN');
      expect(problems[0]).toContain('ROLLOUT DID NOT HAPPEN');
      // And it must NOT have said the thing #608 is about.
      expect(lines.join('\n')).not.toContain('shipped —');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still says shipped when the run says it shipped', async () => {
    const seen: string[] = [];
    const lines: string[] = [];
    vi.stubGlobal('fetch', transport(statement('success'), seen));
    try {
      const { problems } = await coverage.checkDeployCoverage({
        repository: 'OxyHQ/Mercaria',
        workflows: watched,
        log: (line) => lines.push(line),
      });
      expect(problems).toEqual([]);
      expect(lines.join('\n')).toContain('Deploy to AWS: shipped —');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('a healthy release must not read as hollow (the good-day baseline)', () => {
  /**
   * The `deploy` job's REAL step list, verbatim from run 32131834422 — a normal
   * successful release of `e3e6ed6e` on `main` — with the four outcome steps
   * appended as the workflow now emits them on that same path.
   *
   * ## The trap this exists to catch
   *
   * **`Migrate (all)` is `skipped` on EVERY normal release.** Its own name says
   * so: *cutover only, never a normal release*. #608's cheap fix reads a skipped
   * migrate step as a hollow green — and a version of it anchored on the wrong
   * step of the three would have flagged all 147 healthy runs in the evidence
   * window. A suite whose only cases are failures cannot tell you it stays quiet
   * on a good day, and the good day HAS a skipped step in it.
   *
   * Kept as a literal rather than fetched: Actions history ages out, and this is
   * evidence about a run nobody can re-read in ninety days.
   */
  const HEALTHY_DEPLOY_STEPS: OutcomeStep[] = [
    { name: 'Set up job', conclusion: 'success' },
    { name: 'Run actions/checkout@v4', conclusion: 'success' },
    { name: 'Configure AWS credentials (OIDC, no stored keys)', conclusion: 'success' },
    { name: 'Sync GitHub secrets -> SSM (GitHub is the source of truth)', conclusion: 'success' },
    { name: 'Login to ECR', conclusion: 'success' },
    { name: 'Set up Docker Buildx', conclusion: 'success' },
    { name: 'Build and push (linux/arm64)', conclusion: 'success' },
    { name: 'Resolve the ECS one-shot shape', conclusion: 'success' },
    { name: 'Detect a post-rollout migration in the journal', conclusion: 'success' },
    { name: 'Migrate (all) — cutover only, never a normal release', conclusion: 'skipped' },
    { name: 'Migrate (pre) — before the rollout', conclusion: 'success' },
    { name: 'Deploy to ECS (rolling)', conclusion: 'success' },
    { name: 'Migrate (post) — after the new image is live', conclusion: 'success' },
    { name: 'Outcome: migrations applied', conclusion: 'success' },
    { name: 'Outcome: migrations NOT applied', conclusion: 'skipped' },
    { name: 'Outcome: rollout performed', conclusion: 'success' },
    { name: 'Outcome: rollout NOT performed', conclusion: 'skipped' },
    { name: 'Post Set up Docker Buildx', conclusion: 'success' },
    { name: 'Post Login to ECR', conclusion: 'success' },
    { name: 'Post Configure AWS credentials (OIDC, no stored keys)', conclusion: 'success' },
    { name: 'Post Run actions/checkout@v4', conclusion: 'success' },
    { name: 'Complete job', conclusion: 'success' },
  ];
  const healthyRun = () => [
    { steps: [{ name: 'Require a green CI run for this commit', conclusion: 'success' }] },
    { steps: HEALTHY_DEPLOY_STEPS.map((step) => ({ ...step })) },
  ];

  it('reads a normal release as shipped, skipped Migrate (all) and all', () => {
    // The literal names are asserted rather than assumed, so a fixture that
    // silently stopped containing the skipped step could not pass this quietly.
    expect(
      HEALTHY_DEPLOY_STEPS.filter((step) => step.conclusion === 'skipped').map((step) => step.name),
    ).toEqual([
      'Migrate (all) — cutover only, never a normal release',
      'Outcome: migrations NOT applied',
      'Outcome: rollout NOT performed',
    ]);
    expect(coverage.judgeDeployOutcome({ jobs: healthyRun() }).state).toBe('shipped');
  });

  it('reads the STATEMENT, so no Migrate step can decide the verdict on its own', () => {
    /**
     * The other side of the trap. The check must not be re-deriving the answer
     * from the migrate steps — that is the inference #608 proposed and this PR
     * deliberately does not ship, because it cannot see the rollout half.
     *
     * So: flip every `Migrate (…)` step to `skipped` while leaving the
     * statement positive, and the verdict must not move. If it does, something
     * is reading the migrate steps behind the statement's back. The WORKFLOW is
     * where those steps and the statement are tied together, and the De Morgan
     * test above is what pins that end.
     */
    const jobs = healthyRun();
    const deploy = jobs[1];
    deploy.steps = deploy.steps.map((step) =>
      step.name?.startsWith('Migrate (') ? { ...step, conclusion: 'skipped' } : step,
    );
    expect(deploy.steps.filter((s) => s.name?.startsWith('Migrate (')).length).toBe(3);
    expect(coverage.judgeDeployOutcome({ jobs }).state).toBe('shipped');
  });

  it('turns the same healthy run hollow when the statement says the rollout did not happen', () => {
    // The short-circuit, on an otherwise identical run: everything above the
    // statement still reports `success`, which is exactly why the conclusion
    // could never carry the answer.
    const jobs = healthyRun();
    jobs[1].steps = jobs[1].steps.map((step) => {
      if (step.name === 'Outcome: rollout performed') return { ...step, conclusion: 'skipped' };
      if (step.name === 'Outcome: rollout NOT performed') return { ...step, conclusion: 'success' };
      return step;
    });
    const verdict = coverage.judgeDeployOutcome({ jobs });
    expect(verdict.state).toBe('hollow');
    expect(verdict.halves.filter((half) => half.verdict === 'negative').map((h) => h.half)).toEqual([
      'rollout',
    ]);
  });
});

describe('an EVICTED run is a fourth path to "nothing shipped"', () => {
  /**
   * Measured on `main` on 2026-08-18: three of five consecutive `Deploy to AWS`
   * runs concluded `cancelled`, and run 32131868824 (head `dcafc708`, carrying
   * migration `0113_odd_tarot`) reported `total_count: 0` jobs.
   *
   * `deploy-aws.yml` sets `cancel-in-progress: false`, so nothing is cancelled
   * by policy — a concurrency group holds at most one PENDING run and a newer
   * push EVICTS it. **The evicted run never starts**, so it has no jobs, no
   * steps and no step conclusions at all. That is the class every inference
   * from a step's `skipped` state is structurally blind to: there is no
   * `Migrate (pre)` to inspect.
   */
  it('is caught by the run-conclusion half, not by the outcome half', () => {
    // An eviction concludes `cancelled`, so it is never the newest SUCCESS and
    // the outcome check is never reached for it. #574 owns this path and
    // already reports it — what #608 adds does not overlap.
    const evicted = {
      run_number: 3,
      head_sha: 'dcafc708',
      status: 'completed',
      conclusion: 'cancelled',
      created_at: '2020-01-01T07:28:00Z',
      html_url: 'https://example.invalid/32131868824',
    };
    const verdict = coverage.judgeCoverage({
      runs: [
        {
          run_number: 2,
          head_sha: '085b405b',
          status: 'completed',
          conclusion: 'success',
          created_at: '2020-01-01T07:02:00Z',
        },
        evicted,
      ],
      now: Date.parse('2020-01-01T09:00:00Z'),
    });
    expect(verdict.state).toBe('uncovered');
    expect(verdict.uncovered.map((run) => run.head_sha)).toEqual(['dcafc708']);
  });

  it('would refuse rather than pass if its zero-job shape ever reached the outcome check', () => {
    // Defence in depth, and the reason the vacuity floor is phrased as it is: a
    // run that executed nothing produces `total_count: 0`, which is the exact
    // shape of a read that failed. Neither may render as "no step said no".
    expect(coverage.judgeDeployOutcome({ jobs: [] }).state).toBe('unreadable');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* #672: the SECOND claim — is the migration I merged actually applied?        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * `judgeCoverage` answers "did the newest RUN succeed". That is a claim about a
 * RUN, and #672 is the observation that nothing asserted the claim an operator
 * makes during an incident — "is the change I merged in production?".
 *
 * The two are stated separately rather than the anchor being swapped, because
 * all four deploy workflows carry `paths:`/`paths-ignore:` filters and a
 * docs-only tip legitimately produces no run at all. This claim avoids that
 * entirely by not being about commits: it is about migration FILES, compared by
 * CONTAINMENT.
 */
describe('#672 — migration containment is decided by content, never by history', () => {
  it('reports a migration present at the tip and absent from the applied tree', () => {
    const verdict = coverage.judgeMigrationContainment({
      tipMigrations: ['0112_a.sql', '0113_odd_tarot.sql'],
      appliedMigrations: ['0112_a.sql'],
    });
    expect(verdict.state).toBe('unapplied');
    expect(verdict.missing).toEqual(['0113_odd_tarot.sql']);
  });

  it('takes no ancestry input at all, which is what pins the revert and the squash', () => {
    // The acceptance criterion asks that containment, never ancestry, be the
    // test, and that a squash or a revert pin the difference. The strongest
    // available form of that is STRUCTURAL: this function is handed two
    // listings and nothing else. There is no commit, no parent, no merge base
    // and no compare range for an ancestry rule to be written against, so
    // "covered because the applied commit is an ancestor of the tip" is
    // unrepresentable rather than merely unused.
    expect(coverage.judgeMigrationContainment.length).toBe(1);

    // A REVERT: `0113` landed, was reverted on the branch the deploy built, and
    // re-landed on `main`. The applied commit IS an ancestor of the tip, so an
    // ancestry check reports covered — and the migration is genuinely not in
    // that tree.
    const reverted = coverage.judgeMigrationContainment({
      tipMigrations: ['0112_a.sql', '0113_odd_tarot.sql'],
      appliedMigrations: ['0112_a.sql'],
    });
    expect(reverted.state).toBe('unapplied');

    // A SQUASH: the applied commit is not an ancestor of the tip at all, yet it
    // carries every migration. Ancestry says uncovered; content says applied,
    // and content is what the migrator acts on.
    const squashed = coverage.judgeMigrationContainment({
      tipMigrations: ['0112_a.sql', '0113_odd_tarot.sql'],
      appliedMigrations: ['0113_odd_tarot.sql', '0112_a.sql', '0111_gone_from_tip.sql'],
    });
    expect(squashed.state).toBe('applied');
    expect(squashed.missing).toEqual([]);
  });

  it('keeps "I could not tell" apart from "everything is applied"', () => {
    // The failure this whole check exists to stop, one level down. A propagated
    // read failure arrives as `null`, and rendering that as `applied` would be
    // the check overclaiming about itself.
    expect(coverage.judgeMigrationContainment({ tipMigrations: null, appliedMigrations: [] }).state).toBe(
      'unreadable',
    );
    expect(
      coverage.judgeMigrationContainment({ tipMigrations: ['0001_a.sql'], appliedMigrations: null })
        .state,
    ).toBe('unreadable');
  });

  it('refuses an EMPTY tip listing rather than reading it as nothing missing', () => {
    // The vacuity floor. A renamed folder, a wrong ref or a changed API shape
    // all produce an empty listing, and an empty tip reports "nothing is
    // missing" exactly as a fully-applied repository does.
    const verdict = coverage.judgeMigrationContainment({
      tipMigrations: [],
      appliedMigrations: [],
    });
    expect(verdict.state).toBe('no_migrations_found');
    expect(verdict.state).not.toBe('applied');
  });

  it('keeps `pre` and `post` distinguishable, and groups an unreadable phase with `post`', () => {
    // #594's line, preserved. An unapplied `pre` left the database and the image
    // in sync at the old version; an unapplied `post` breaks the image that is
    // already live. Collapsing them is how the urgent case gets ignored.
    const phases: Record<string, 'pre' | 'post' | 'unknown'> = {
      '0113_post.sql': 'post',
      '0114_pre.sql': 'pre',
      '0115_mystery.sql': 'unknown',
    };
    const split = coverage.splitMigrationsByPhase(
      ['0113_post.sql', '0114_pre.sql', '0115_mystery.sql'],
      (name) => phases[name],
    );
    expect(split.pre).toEqual(['0114_pre.sql']);
    // `unknown` lands on the URGENT side: the safe reading of "I cannot tell
    // which phase this is" is the one that alarms.
    expect(split.post).toEqual(['0113_post.sql', '0115_mystery.sql']);
  });

  it('reads a declared phase, and calls a missing or doubled marker `unknown`', () => {
    expect(coverage.declaredPhase(`-- a comment\n${coverage.POST_PHASE_MARKER}\nALTER TABLE x;`)).toBe(
      'post',
    );
    expect(coverage.declaredPhase(`${coverage.PRE_PHASE_MARKER}\nCREATE TABLE y;`)).toBe('pre');
    // There is no default phase — `db:generate` requires exactly one marker — so
    // neither and both are the same defect and neither may read as `pre`.
    expect(coverage.declaredPhase('CREATE TABLE z;')).toBe('unknown');
    expect(
      coverage.declaredPhase(`${coverage.PRE_PHASE_MARKER}\n${coverage.POST_PHASE_MARKER}\n`),
    ).toBe('unknown');
  });

  it('the phase markers match the ones the migrator and the workflow really use', () => {
    // The same reasoning as `POST_PHASE_MARKER`'s existing assertion: this
    // script cannot import `@oxyhq/db`, so it carries a copy, and a copy that
    // drifts silently stops classifying anything.
    expect(POST_PHASE_GREP_PATTERN).toContain(coverage.POST_PHASE_MARKER);
    const migrations = readdirSync(MIGRATIONS_FOLDER).filter((name) => name.endsWith('.sql'));
    // A vacuity floor on the corpus this is validated against.
    expect(migrations.length).toBeGreaterThanOrEqual(100);
    const phases = migrations.map((name) =>
      coverage.declaredPhase(readFileSync(join(MIGRATIONS_FOLDER, name), 'utf8')),
    );
    // Every real migration classifies. An `unknown` here means either a
    // migration landed without its mandatory marker or the copy above drifted,
    // and both are worth failing the build for.
    expect(phases.filter((phase) => phase === 'unknown')).toEqual([]);
    // Both phases are actually present in the corpus, or this test would pass
    // against a classifier that answered one value for everything.
    expect(phases).toContain('post');
    expect(phases).toContain('pre');
  });
});
