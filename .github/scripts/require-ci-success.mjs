#!/usr/bin/env node
/**
 * Refuse a production deploy unless CI actually passed for THIS commit.
 *
 * ## Why this exists rather than `needs:` or `workflow_run`
 *
 * The three web apps deploy from their own workflows, each triggered by a
 * `push` to `main` with a `paths:` filter. They have no job to `needs:`, and
 * they cannot be switched to `workflow_run` without giving up that filter —
 * `workflow_run` carries no `paths:`, so the narrowing that stops a docs-only
 * change redeploying three apps would have to be rebuilt out of a diff. So the
 * dependency is expressed the third way: the deploy job `needs:` a gate job,
 * and the gate ASKS the API what `ci.yml` concluded for this exact commit.
 *
 * That keeps ONE definition of "CI passed" — `ci.yml`'s own run — instead of a
 * second copy of the suite inside each deploy workflow, which is the shape that
 * drifts. `deploy-aws.yml` carries such a copy today and it has already drifted:
 * it runs the backend lint, the backend suite and the bundle, and NOT the ten
 * `validate:*` guards, the five typechecks or the three app test runners.
 *
 * ## What each rule here is worth
 *
 * Every one of these is a way a check like this reads green while measuring
 * nothing, and each has cost this org real time:
 *
 *  - **A skipped job reads as green.** `ci.yml`'s four `Build *` jobs
 *    `needs: lint-and-test`, so on a red commit they report `skipped`, not
 *    `failed` — anyone counting failures sees zero. So this asserts
 *    `conclusion === 'success'` per job, never "no failures".
 *  - **Gate on identity, not counts.** A run with zero real jobs reports
 *    `fail=0 pending=0`. So the required job NAMES must be PRESENT as well as
 *    successful; missing counts as failing.
 *  - **`?head_sha=` can return nothing when a run exists.** Measured in this
 *    org, and it is not reliably broken, which is worse. So an empty answer is
 *    re-checked by listing recent runs and matching the sha client-side before
 *    anything concludes the run is absent.
 *  - **A run that has not appeared yet is not a run that failed.** The deploy
 *    workflow and `ci.yml` are triggered by the same push and race; a missing
 *    run is waited for, with a bound, and only then refused.
 *  - **A `pull_request` run is not a verdict on this commit.** GitHub builds the
 *    MERGE commit for `pull_request`, and `main` is squash-merged here, so the
 *    tree that ran is not the tree being deployed. Those runs are excluded.
 *
 * ## The one thing it deliberately does not have
 *
 * There is no bypass input. `deploy-aws.yml`'s `needs: test` has none either,
 * and a switch whose cheapest green is "ship the commit CI rejected" is worse
 * than no gate. Shipping from a red commit means reverting the commit.
 *
 * `REQUIRED_CI_JOBS` is exported so a test can assert it still equals the job
 * names `ci.yml` really defines — see `deployGating.test.ts`. A job added to CI
 * fails that test until somebody decides whether a deploy should wait for it.
 */

import { pathToFileURL } from 'node:url';

/**
 * Every job `ci.yml` defines, by the name the Actions API reports.
 *
 * Kept here rather than parsed out of the workflow at run time so this script
 * needs no YAML dependency and no `bun install` in the gate job — the drift is
 * caught by `deployGating.test.ts`, which reads the real `ci.yml` and asserts
 * this list equals it exactly. Loud and cheap, in the suite that already runs on
 * every push and PR.
 */
export const REQUIRED_CI_JOBS = Object.freeze([
  'Lint & Test',
  'Build API',
  'Build App',
  'Build Dashboard',
  'Build POS',
]);

/** The workflow whose verdict gates a deploy. */
export const CI_WORKFLOW_FILE = 'ci.yml';

/** How long to keep waiting for a run to APPEAR before calling it absent. */
const APPEAR_TIMEOUT_MS = 5 * 60 * 1000;
/** How long to keep waiting for a run that exists to CONCLUDE. */
const CONCLUDE_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 15 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class GateFailure extends Error {}

async function api(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'user-agent': 'mercaria-require-ci-success',
    },
  });
  if (!response.ok) {
    // A 401/403/404 is a broken gate, not a slow queue. Refusing to distinguish
    // them is how a gate ends up waiting out its timeout on every run and then
    // getting deleted for being flaky.
    throw new GateFailure(
      `GitHub API ${response.status} ${response.statusText} for ${path}. ` +
        `The gate needs a token with \`actions: read\` on this repository.`,
    );
  }
  return response.json();
}

/**
 * Every non-`pull_request` CI run for exactly this sha, newest first.
 *
 * Two queries, because the `head_sha` filter has been measured returning an
 * empty set while a matching run existed. The fallback lists the workflow's
 * recent runs and matches client-side; only when BOTH are empty is the run
 * treated as absent.
 */
async function findRunsForSha({ repository, sha, token }) {
  const collect = (payload) =>
    (payload.workflow_runs ?? []).filter(
      (run) => run.head_sha === sha && run.event !== 'pull_request',
    );

  const filtered = collect(
    await api(
      `/repos/${repository}/actions/workflows/${CI_WORKFLOW_FILE}/runs` +
        `?head_sha=${sha}&per_page=100`,
      token,
    ),
  );
  if (filtered.length > 0) return sortNewestFirst(filtered);

  const listed = collect(
    await api(
      `/repos/${repository}/actions/workflows/${CI_WORKFLOW_FILE}/runs?per_page=100`,
      token,
    ),
  );
  return sortNewestFirst(listed);
}

function sortNewestFirst(runs) {
  return [...runs].sort((a, b) => {
    if (a.run_attempt !== b.run_attempt) return b.run_attempt - a.run_attempt;
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });
}

async function readJobs({ repository, runId, token }) {
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const payload = await api(
      `/repos/${repository}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
      token,
    );
    jobs.push(...(payload.jobs ?? []));
    if (jobs.length >= (payload.total_count ?? jobs.length) || (payload.jobs ?? []).length === 0) {
      return jobs;
    }
  }
}

/**
 * The verdict, given the jobs of a completed run.
 *
 * Pure and exported so it can be tested without the network — the assertions
 * that matter (a `skipped` job is not a pass, a missing job is not a pass) are
 * exactly the ones an integration test would be least likely to reach.
 */
export function judgeJobs(jobs) {
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const problems = [];
  for (const required of REQUIRED_CI_JOBS) {
    const job = byName.get(required);
    if (!job) {
      problems.push(`${required}: MISSING from the run (missing counts as failing)`);
      continue;
    }
    if (job.conclusion !== 'success') {
      problems.push(`${required}: ${job.conclusion ?? job.status ?? 'no conclusion'}`);
    }
  }
  return problems;
}

async function requireCiSuccess({ repository, sha, token, now = () => Date.now() }) {
  const startedAt = now();
  let seenRun = null;

  for (;;) {
    const runs = await findRunsForSha({ repository, sha, token });
    const run = runs[0];

    if (!run) {
      if (now() - startedAt > APPEAR_TIMEOUT_MS) {
        throw new GateFailure(
          `No \`${CI_WORKFLOW_FILE}\` run exists for ${sha} after ` +
            `${Math.round(APPEAR_TIMEOUT_MS / 60000)} minutes. A commit with no CI run has ` +
            `no verdict to deploy on. If CI was skipped by a \`paths-ignore\`, that is the ` +
            `thing to fix — this gate cannot tell "CI passed" from "CI never ran".`,
        );
      }
      console.log(`waiting: no CI run for ${sha} yet…`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (run.id !== seenRun) {
      seenRun = run.id;
      console.log(`CI run ${run.id} (attempt ${run.run_attempt}) — ${run.html_url}`);
    }

    if (run.status !== 'completed') {
      if (now() - startedAt > CONCLUDE_TIMEOUT_MS) {
        throw new GateFailure(
          `CI run ${run.id} for ${sha} was still \`${run.status}\` after ` +
            `${Math.round(CONCLUDE_TIMEOUT_MS / 60000)} minutes. Refusing to deploy on an ` +
            `unfinished verdict.`,
        );
      }
      console.log(`waiting: CI run ${run.id} is ${run.status}…`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (run.conclusion !== 'success') {
      throw new GateFailure(
        `CI run ${run.id} for ${sha} concluded \`${run.conclusion}\`, not \`success\`.\n` +
          `${run.html_url}\n` +
          (run.conclusion === 'cancelled'
            ? 'A cancelled run is not a pass — the commit was never verified. Re-run CI for ' +
              'this commit, then re-run this deploy.'
            : 'Shipping from this commit means reverting it, not bypassing this gate.'),
      );
    }

    const problems = judgeJobs(await readJobs({ repository, runId: run.id, token }));
    if (problems.length > 0) {
      throw new GateFailure(
        `CI run ${run.id} for ${sha} reports \`success\` but its jobs do not:\n` +
          problems.map((problem) => `  - ${problem}`).join('\n') +
          `\n${run.html_url}`,
      );
    }

    console.log(
      `CI passed for ${sha}: ${REQUIRED_CI_JOBS.length} required jobs, all \`success\`.`,
    );
    return run;
  }
}

async function main() {
  const args = new Map();
  for (const argument of process.argv.slice(2)) {
    const [key, ...rest] = argument.replace(/^--/, '').split('=');
    args.set(key, rest.join('='));
  }

  const repository = args.get('repository') ?? process.env.GITHUB_REPOSITORY;
  const sha = args.get('sha') ?? process.env.GITHUB_SHA;
  const token = args.get('token') ?? process.env.GITHUB_TOKEN;

  if (!repository || !sha) {
    console.error('usage: require-ci-success.mjs --repository=owner/name --sha=<sha> [--token=]');
    process.exit(2);
  }

  try {
    await requireCiSuccess({ repository, sha, token });
  } catch (error) {
    if (error instanceof GateFailure) {
      console.error(`\nRefusing to deploy.\n\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export { requireCiSuccess, GateFailure };
