#!/usr/bin/env node
/**
 * Assert that what is merged on `main` actually shipped.
 *
 * ## The hole this closes (#574)
 *
 * `deploy-aws.yml` shares ONE concurrency group per ref with
 * `cancel-in-progress: false`. GitHub keeps at most one PENDING run per group,
 * so a third arrival EVICTS the queued second. That is the right setting and
 * must not be flipped — cancelling a run between `run-task` and its exit-code
 * check orphans a live migration task — but it means a merge commit's deploy
 * can be dropped without ever executing.
 *
 * An eviction is harmless EXACTLY WHEN the run that evicted it succeeds. The
 * evictor is always a descendant, so it ships a superset of the code and (see
 * `deploy-aws.yml`'s `Migrate (post)` step) applies every migration the evicted
 * run was carrying. Nothing asserted that condition, and a `cancelled` run with
 * zero jobs notifies nobody.
 *
 * Measured on this repository, 300 `Deploy to AWS` runs on `main` over four
 * weeks to 2026-08-17: 235 success, 41 cancelled, 15 failure, 9
 * action_required. Those 65 non-success runs form 36 windows in which a merged
 * commit was not in production; the median commit waited 23.1 minutes and the
 * worst waited 358.2 minutes. TWO of those windows contained a newly added
 * `post`-phase migration — 2026-08-08 (`0003_retire_legacy_payment_columns`
 * and `0005_drop_empty_string_defaults`, a 4.5-hour window) and 2026-08-17
 * (`0106_panoramic_patch`, the one #574 was opened for). Nothing reported any
 * of them.
 *
 * ## The invariant, and why it is stated this way
 *
 * > The newest run of a deploy workflow on `main` must have concluded
 * > `success`. Every non-success run newer than the last success names a commit
 * > that is merged and not shipped.
 *
 * Three things about that phrasing are load-bearing:
 *
 *  - **It is anchored on the newest RUN, never on the newest COMMIT.** All four
 *    deploy workflows carry `paths:`/`paths-ignore:` filters, so a docs-only
 *    tip legitimately has no run at all. Anchoring on the commit would mean
 *    rebuilding those filters out of a diff — the untestable reconstruction
 *    `docs/deploy.md` §"Why the gate reads CI's result" already rejected — and
 *    it would report a gap on every docs merge.
 *  - **Coverage is by CREATION order, never by completion order.** An evicted
 *    run completes in seconds while the run it was queued behind takes fifteen
 *    minutes, so ordering by `updated_at` puts the success BEFORE the
 *    cancellations it did not cover and reads a real gap as covered. Measured
 *    against 2026-08-17T07:22Z, where completion order reported 1 uncovered
 *    commit and creation order reports the true 3 (`0f93aecd`, `01a5e50c`, then
 *    `61e21d7f` whose own deploy FAILED). `run_number` is the sort key rather
 *    than `created_at`: it is monotonic per workflow, it cannot tie, and a
 *    re-run keeps it — so re-running an OLD run green does not read as covering
 *    the newer commits it never contained.
 *  - **A run still in flight DEFERS rather than passing or failing.** It will
 *    conclude, and its conclusion re-triggers this check. Without the deferral
 *    every eviction reports a gap that resolves minutes later on its own: 125
 *    of the 300 completions above had another run in flight at that instant,
 *    and firing on those is how an alarm gets muted. With it, the same history
 *    produces 22 reports in four weeks, every one of them a state where the
 *    pipeline had genuinely stopped.
 *
 * ## What it deliberately is not
 *
 * There is no bypass and no "acknowledge" input, matching
 * `require-ci-success.mjs`. The cheapest way to make this green is a successful
 * deploy of `main`, which is the remedy — so the invariant does not push
 * anybody toward the hazard. It also does not RE-DISPATCH a deploy: that turns
 * a report into an actor with `actions: write`, and against a genuinely failing
 * deploy (the ECR pull timeout on `203d8754`) it would loop.
 */

import { pathToFileURL } from 'node:url';

/**
 * Every workflow that ships something, by file and by the name the Actions API
 * reports for its runs.
 *
 * Both spellings are here because both are needed and neither is derivable from
 * the other without a YAML parser this script must not need (the gate job runs
 * on bare node, with no `bun install`). `deployCoverage.test.ts` asserts this
 * list equals the deploy workflows that really exist and that each `name`
 * matches the file's real `name:` — so a renamed workflow fails the build
 * instead of silently dropping out of the watch.
 *
 * `migrations: true` marks the one whose gap can leave the DATABASE behind, not
 * merely the code. It is what turns "a deploy was cancelled" — which happened
 * 41 times last month and is routinely ignored — into "commit X carrying
 * migration 0106 is merged and not applied".
 */
export const DEPLOY_WORKFLOWS = Object.freeze([
  Object.freeze({ file: 'deploy-aws.yml', name: 'Deploy to AWS', migrations: true }),
  Object.freeze({ file: 'deploy-cloudflare.yml', name: 'Deploy Frontend', migrations: false }),
  Object.freeze({ file: 'deploy-dashboard.yml', name: 'Deploy Dashboard', migrations: false }),
  Object.freeze({ file: 'deploy-pos.yml', name: 'Deploy POS', migrations: false }),
]);

/**
 * The phase marker a `post` migration carries.
 *
 * A copy of `@oxyhq/db`'s `POST_PHASE_GREP_PATTERN` without the anchors, for
 * the same reason `deploy-aws.yml` carries a copy of the pattern itself: this
 * script cannot import the package. `deployCoverage.test.ts` asserts the two
 * agree, exactly as `deployWorkflow.test.ts` does for the workflow.
 */
export const POST_PHASE_MARKER = '-- oxy:deploy-phase=post';

/** Repo-relative migrations folder, pinned against `MIGRATIONS_FOLDER` by the test. */
export const MIGRATIONS_PATH = 'packages/backend/drizzle';

/**
 * How long an in-flight run may defer the verdict before it stops counting.
 *
 * Above a healthy run's whole duration — `deploy-aws.yml`'s `gate` job alone
 * budgets 40 minutes, and the build plus rollout adds roughly fifteen more. A
 * run stuck `queued` past this is not about to rescue anything, and letting it
 * defer forever would give the check a permanent way to be silent.
 */
export const DEFAULT_STALE_RUN_MS = 90 * 60 * 1000;

/** How many runs to read. Deep enough that a real success is in the page. */
const RUNS_PER_PAGE = 100;

class CoverageFailure extends Error {}

async function api(path, token, { raw = false } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'user-agent': 'mercaria-require-deploy-coverage',
    },
  });
  if (!response.ok) {
    // A 401/403/404 is a broken check, not an empty history. Refusing to tell
    // them apart is how this ends up reporting "everything shipped" forever.
    throw new CoverageFailure(
      `GitHub API ${response.status} ${response.statusText} for ${path}. ` +
        `This check needs a token with \`actions: read\` and \`contents: read\`.`,
    );
  }
  return raw ? response.text() : response.json();
}

/**
 * Runs newest-CREATED first.
 *
 * `run_number` is monotonic per workflow and assigned at creation, so it orders
 * runs the way commits landed even when two runs share a `created_at` second —
 * which they do: `4af9503c`, `192ff190` and `9176f49c` were created within
 * sixteen seconds of each other on 2026-08-17.
 */
export function sortNewestFirst(runs) {
  return [...runs].sort((a, b) => {
    const byNumber = (b.run_number ?? 0) - (a.run_number ?? 0);
    if (byNumber !== 0) return byNumber;
    return Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0);
  });
}

/**
 * The verdict for one workflow, given its runs on `main`.
 *
 * Pure and exported so the cases that matter can be tested without the network.
 * They are exactly the ones an integration test would be least likely to reach:
 * an eviction whose evictor is still running, an eviction whose evictor failed,
 * and a page with no successful run in it at all.
 */
export function judgeCoverage({ runs, now = Date.now(), staleRunMs = DEFAULT_STALE_RUN_MS }) {
  const ordered = sortNewestFirst(runs);

  // Distinct from `covered` on purpose. A workflow with no runs at all reports
  // exactly what a broken query reports, and "I found none" must never render
  // as "none are missing".
  if (ordered.length === 0) return { state: 'no_runs', uncovered: [], pending: [] };

  const inFlight = ordered.filter((run) => run.status !== 'completed');
  const deferring = inFlight.filter((run) => now - Date.parse(run.created_at) < staleRunMs);
  if (deferring.length > 0) {
    return { state: 'pending', uncovered: [], pending: deferring };
  }

  const lastSuccessIndex = ordered.findIndex(
    (run) => run.status === 'completed' && run.conclusion === 'success',
  );

  // No success anywhere in the page. Reporting all `RUNS_PER_PAGE` runs as
  // uncovered would be a true statement about the page and a misleading one
  // about the repository, so this is its own state and says what it read.
  if (lastSuccessIndex === -1) {
    return { state: 'no_success_in_page', uncovered: ordered, pending: inFlight, lastSuccess: null };
  }

  const uncovered = ordered.slice(0, lastSuccessIndex);
  if (uncovered.length === 0) {
    return { state: 'covered', uncovered: [], pending: inFlight, lastSuccess: ordered[0] };
  }
  return {
    state: 'uncovered',
    uncovered,
    pending: inFlight,
    lastSuccess: ordered[lastSuccessIndex],
  };
}

/** Migration files a commit ADDED, from the commit endpoint's file list. */
export function addedMigrationFiles(files) {
  return (files ?? [])
    .filter((file) => file.status === 'added')
    .map((file) => file.filename)
    .filter((name) => name.startsWith(`${MIGRATIONS_PATH}/`) && name.endsWith('.sql'));
}

/** Does this migration file body declare itself a post-rollout migration? */
export function declaresPostPhase(body) {
  return body.split('\n').some((line) => line.trim() === POST_PHASE_MARKER);
}

/**
 * Which of an uncovered commit's new migrations are `post` — best effort.
 *
 * Enrichment, never the verdict: every failure path answers `unknown` rather
 * than `none`, because "we could not tell" and "there is no migration" lead an
 * operator to opposite conclusions and only one of them is safe to assume. The
 * commit endpoint caps `files` at 300 with no pagination, so a commit at the
 * cap is `unknown` too.
 */
async function readPostMigrations({ repository, sha, token }) {
  try {
    const commit = await api(`/repos/${repository}/commits/${sha}`, token);
    const files = commit.files ?? [];
    if (files.length >= 300) return { known: false, files: [] };

    const found = [];
    for (const path of addedMigrationFiles(files)) {
      const body = await api(
        `/repos/${repository}/contents/${encodeURI(path)}?ref=${sha}`,
        token,
        { raw: true },
      );
      if (declaresPostPhase(body)) found.push(path);
    }
    return { known: true, files: found };
  } catch {
    return { known: false, files: [] };
  }
}

async function readRuns({ repository, file, branch, token }) {
  const payload = await api(
    `/repos/${repository}/actions/workflows/${file}/runs` +
      `?branch=${encodeURIComponent(branch)}&per_page=${RUNS_PER_PAGE}`,
    token,
  );
  return payload.workflow_runs ?? [];
}

function describeRun(run) {
  return `${(run.head_sha ?? '').slice(0, 8)} ${run.conclusion ?? run.status} — ${run.html_url}`;
}

/**
 * Check every deploy workflow and report. Returns the failing report lines.
 */
export async function checkDeployCoverage({
  repository,
  branch = 'main',
  token,
  workflows = DEPLOY_WORKFLOWS,
  now = () => Date.now(),
  log = console.log,
}) {
  const problems = [];
  let workflowsWithRuns = 0;

  for (const workflow of workflows) {
    const runs = await readRuns({ repository, file: workflow.file, branch, token });
    const verdict = judgeCoverage({ runs, now: now() });
    if (runs.length > 0) workflowsWithRuns += 1;

    if (verdict.state === 'covered') {
      log(`${workflow.name}: shipped — newest run ${describeRun(verdict.lastSuccess)}`);
      continue;
    }
    if (verdict.state === 'pending') {
      log(
        `${workflow.name}: a run is still in flight, deferring — ` +
          verdict.pending.map(describeRun).join('; '),
      );
      continue;
    }
    if (verdict.state === 'no_runs') {
      log(`${workflow.name}: no runs on ${branch} at all.`);
      continue;
    }

    const lines = [
      verdict.state === 'no_success_in_page'
        ? `${workflow.name}: NO successful run in the last ${runs.length} runs on ${branch}.`
        : `${workflow.name}: ${verdict.uncovered.length} commit(s) merged and not shipped.`,
    ];
    for (const run of verdict.uncovered) {
      let suffix = '';
      if (workflow.migrations) {
        const posts = await readPostMigrations({ repository, sha: run.head_sha, token });
        if (!posts.known) suffix = '  [post migration: UNKNOWN — could not read this commit]';
        else if (posts.files.length > 0) {
          suffix = `  [*** POST MIGRATION MERGED AND NOT APPLIED: ${posts.files.join(', ')}]`;
        }
      }
      lines.push(`  - ${describeRun(run)}${suffix}`);
    }
    if (verdict.lastSuccess) {
      lines.push(`  last successful run: ${describeRun(verdict.lastSuccess)}`);
    }
    problems.push(lines.join('\n'));
  }

  // Vacuity floor. Every workflow reporting `no_runs` is what a wrong branch, a
  // renamed file or a token without `actions: read` produces, and it is
  // indistinguishable from a quiet week. A check that cannot tell those apart
  // has to refuse rather than print a clean green.
  if (workflowsWithRuns === 0) {
    throw new CoverageFailure(
      `None of the ${workflows.length} deploy workflows reported a single run on ` +
        `${branch}. That is what a renamed workflow file, a wrong branch or a token ` +
        `without \`actions: read\` looks like — not a quiet week. Refusing to report ` +
        `"everything shipped" from an empty read.`,
    );
  }

  return problems;
}

async function main() {
  const args = new Map();
  for (const argument of process.argv.slice(2)) {
    const [key, ...rest] = argument.replace(/^--/, '').split('=');
    args.set(key, rest.join('='));
  }

  const repository = args.get('repository') ?? process.env.GITHUB_REPOSITORY;
  const branch = args.get('branch') ?? 'main';
  const token = args.get('token') ?? process.env.GITHUB_TOKEN;

  if (!repository) {
    console.error(
      'usage: require-deploy-coverage.mjs --repository=owner/name [--branch=main] [--token=]',
    );
    process.exit(2);
  }

  let problems;
  try {
    problems = await checkDeployCoverage({ repository, branch, token });
  } catch (error) {
    if (error instanceof CoverageFailure) {
      console.error(`\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  if (problems.length === 0) {
    console.log(`\nEvery deploy workflow's newest run on ${branch} succeeded.`);
    return;
  }

  const report = problems.join('\n\n');
  console.error(
    `\n::error title=Merged on ${branch} but not shipped::` +
      `${problems.length} deploy workflow(s) left work unshipped — see the job log.\n`,
  );
  console.error(`${report}\n`);
  console.error(
    'A deploy run was evicted from the queue, failed, or is awaiting approval, and the\n' +
      'run that superseded it did not succeed either. The code and any migrations on\n' +
      `those commits are NOT in production.\n\n` +
      'To fix: re-run the newest failed deploy run linked above, or merge/push again so a\n' +
      'fresh deploy ships the current tip. Migrations are cumulative and the post-rollout\n' +
      'step runs on every deploy, so one successful deploy applies everything pending.\n',
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Merged on \`${branch}\` but not shipped\n\n\`\`\`\n${report}\n\`\`\`\n`,
    );
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export { CoverageFailure };
