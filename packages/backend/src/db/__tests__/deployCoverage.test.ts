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

import { describe, it, expect } from 'vitest';
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

/**
 * Loaded through a runtime-computed specifier, for `deployGating.test.ts`'s
 * reason: this package's `rootDir` is its own root, so a static import of a
 * file under `.github/` is a TS6059 that refuses the whole program. The point
 * is to read the REAL constants rather than re-declare copies here, and a copy
 * is exactly what this file exists to forbid.
 */
const coverage: {
  DEPLOY_WORKFLOWS: readonly { file: string; name: string; migrations: boolean }[];
  POST_PHASE_MARKER: string;
  MIGRATIONS_PATH: string;
  DEFAULT_STALE_RUN_MS: number;
  judgeCoverage: (input: { runs: CoverageRun[]; now?: number; staleRunMs?: number }) => Verdict;
  addedMigrationFiles: (files: { status?: string; filename: string }[]) => string[];
  declaresPostPhase: (body: string) => boolean;
  checkDeployCoverage: (input: {
    repository: string;
    token?: string;
    workflows?: readonly { file: string; name: string; migrations: boolean }[];
    log?: (line: string) => void;
  }) => Promise<{ problems: string[]; deferred: string[] }>;
} = await import(pathToFileURL(SCRIPT_PATH).href);

interface WorkflowStep {
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
  const T = Date.parse('2026-08-17T07:00:00Z');
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
