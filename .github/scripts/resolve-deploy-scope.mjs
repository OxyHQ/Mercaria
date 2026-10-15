#!/usr/bin/env node
/**
 * WHICH commit does this deploy ship, and does it change what this workflow
 * ships?
 *
 * ## The target is the newest CI-green commit on `main`, resolved at run time
 *
 * Not the commit whose CI completion triggered the run, and not "the tip or
 * nothing". Walking `main` from the tip: a commit with NO `ci.yml` run is passed
 * over — a merge made with `GITHUB_TOKEN` (automerge-first-party.yml's
 * dependabot merges) starts no workflow at all, so it never gets one, and
 * "only the tip deploys" would strand the green commit beneath it forever (the
 * failure Alia hit). A commit whose CI is QUEUED or IN PROGRESS holds the run:
 * that run's completion triggers this workflow again. A commit whose CI FAILED
 * is passed over and reported (`tip_failed`), so the newest green commit still
 * ships while the red one stays visible. The first green commit found is the
 * target, and `require-ci-success.mjs` then verifies it job by job.
 *
 * Resolving at run time is also what makes eviction and cancellation harmless:
 * whichever run of the concurrency group actually executes ships the newest
 * green commit as of then, so a run that displaced another never ships less.
 *
 * ## Why this exists
 *
 * The four deploys trigger on `ci.yml`'s `workflow_run` completion instead of a
 * `push`, so the run no longer polls for CI while holding a runner. The price
 * is that `workflow_run` takes no `paths:`, so the narrowing each deploy used
 * to carry — the storefront redeploys only when `packages/frontend/**` (and its
 * dependencies) changed, the API skips a docs-only merge — is rebuilt here from
 * a diff. `docs/deploy.md` §"What gates a deploy" has the full reasoning.
 *
 * ## The base is the last commit this workflow actually SHIPPED
 *
 * Never the push's `before`, and never the previous run. A diff against the
 * previous push forgets everything a failed, cancelled or evicted deploy was
 * carrying: a docs-only merge after a red storefront deploy would read "nothing
 * to ship" while production still lacks the red one's change. Anchoring on the
 * newest run whose SHIPPING job concluded `success` — and, for the API, whose
 * `Outcome: rollout performed` step ran — makes every decision cover everything
 * since production last moved, so a skipped deploy can never hide an unshipped
 * one. A run that decided "nothing to ship" is never a base: its own jobs did
 * not ship.
 *
 * ## Every doubt resolves to DEPLOY
 *
 * The scope half decides only whether to SKIP work; it never decides whether
 * a commit is fit to ship — `require-ci-success.mjs` verifies the target after
 * this and refuses on its own. So the safe answer to "I could not tell" is to deploy: no base
 * found, an API error, a diverged history or a truncated file list all print
 * why and answer `deploy=true`. The only `false` answers are a diff that was
 * read COMPLETELY and touches nothing in scope, and an identical tree (a CI
 * re-run on a commit already shipped). A manual dispatch always deploys.
 */

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The prefix of the step name a shipping job states its commit in. A step NAME
 * because it is the one thing `/actions/runs/{id}/jobs` returns (see
 * `require-deploy-coverage.mjs` §DEPLOY_OUTCOME_STEPS); a run's own `head_sha`
 * is `main`'s tip when the event fired, which is not necessarily what shipped.
 */
export const SHIPPED_COMMIT_PREFIX = 'Shipped commit ';

/** How far down `main` to look for a CI-green commit. */
const MAX_COMMITS = 30;

/** How many successful runs to inspect for the last real shipment. */
const MAX_BASE_CANDIDATES = 25;
/** The compare endpoint returns at most this many files, with no pagination. */
const COMPARE_FILE_CAP = 300;

/**
 * GitHub's `paths:` glob subset, as a RegExp. `**` crosses `/`, `*` does not,
 * and a pattern matches the whole path — the same reading `on.push.paths` used.
 */
export function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*' && pattern[index + 2] === '/') {
      // `**/` is zero or more whole directories.
      source += '(?:.*/)?';
      index += 2;
    } else if (char === '*' && pattern[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'u');
}

/** Non-empty, trimmed lines of a multi-line env value. */
export function patternList(value) {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Whether a changed-file list reaches this deploy.
 *
 * `include` mirrors `on.push.paths` (any file matching any pattern), `exclude`
 * mirrors `on.push.paths-ignore` (any file matching none). Exactly one of the
 * two is given; both empty is a configuration error, not "deploy nothing".
 */
export function touchesScope({ files, include = [], exclude = [] }) {
  if (include.length === 0 && exclude.length === 0) {
    throw new Error('resolve-deploy-scope: neither DEPLOY_PATHS nor DEPLOY_PATHS_IGNORE is set');
  }
  if (include.length > 0 && exclude.length > 0) {
    throw new Error('resolve-deploy-scope: set DEPLOY_PATHS or DEPLOY_PATHS_IGNORE, not both');
  }
  if (include.length > 0) {
    const matchers = include.map(globToRegExp);
    return files.filter((file) => matchers.some((matcher) => matcher.test(file)));
  }
  const matchers = exclude.map(globToRegExp);
  return files.filter((file) => !matchers.some((matcher) => matcher.test(file)));
}

/**
 * Whether a run SHIPPED, by its jobs: the shipping job concluded `success` and,
 * when named, the step that states the rollout ran. Pure, for the tests.
 */
export function runShipped({ jobs, shippingJob, shippedStep }) {
  const job = (jobs ?? []).find((candidate) => candidate.name === shippingJob);
  if (!job || job.conclusion !== 'success') return false;
  if (!shippedStep) return true;
  return (job.steps ?? []).some(
    (step) => step.name === shippedStep && step.conclusion === 'success',
  );
}

/**
 * The commit a run SHIPPED, or null. Its `Shipped commit <sha>` statement when
 * it has one; otherwise its `head_sha`, which is exact for every run made
 * before the statement existed (push-triggered, or `workflow_run` runs that
 * shipped only their own tip). Pure, for the tests.
 */
export function shippedCommit({ run, jobs, shippingJob, shippedStep }) {
  if (!runShipped({ jobs, shippingJob, shippedStep })) return null;
  const job = jobs.find((candidate) => candidate.name === shippingJob);
  const stated = (job.steps ?? []).find(
    (step) => step.name?.startsWith(SHIPPED_COMMIT_PREFIX) && step.conclusion === 'success',
  );
  const sha = stated ? stated.name.slice(SHIPPED_COMMIT_PREFIX.length).trim() : run.head_sha;
  return /^[0-9a-f]{40}$/u.test(sha ?? '') ? sha : null;
}

/**
 * The target, walking `main` newest first. Pure, for the tests.
 *
 * `ciRuns` maps a sha to its newest push-event `ci.yml` run. Returns
 * `{ action: 'deploy', target, failedNewer }`, `{ action: 'hold', pending }` or
 * `{ action: 'none', failedNewer }`.
 */
export function chooseTarget({ commits, ciRuns }) {
  const failedNewer = [];
  for (const sha of commits) {
    const run = ciRuns.get(sha);
    // No CI run at all: a GITHUB_TOKEN merge. Never a reason to hold.
    if (!run) continue;
    if (run.status !== 'completed') return { action: 'hold', pending: sha, failedNewer };
    if (run.conclusion === 'success') return { action: 'deploy', target: sha, failedNewer };
    failedNewer.push(sha);
  }
  return { action: 'none', failedNewer };
}

/**
 * The decision, given the compare result against the last shipped commit.
 * Pure, for the tests. Returns `{ deploy, reason }`.
 */
export function decide({ base, comparison, include, exclude }) {
  if (!base) {
    return { deploy: true, reason: 'no earlier run of this workflow shipped — deploying' };
  }
  if (!comparison) {
    return { deploy: true, reason: `could not compare against ${base} — deploying` };
  }
  if (comparison.status === 'identical') {
    return { deploy: false, reason: `this commit is ${base}, which is already shipped` };
  }
  if (comparison.status !== 'ahead') {
    return {
      deploy: true,
      reason: `history is \`${comparison.status}\` relative to ${base} — deploying`,
    };
  }
  const files = (comparison.files ?? []).map((file) => file.filename);
  if (files.length === 0 || files.length >= COMPARE_FILE_CAP) {
    return {
      deploy: true,
      reason: `the file list since ${base} is ${files.length === 0 ? 'empty' : 'truncated'} — deploying`,
    };
  }
  const hits = touchesScope({ files, include, exclude });
  if (hits.length > 0) {
    return {
      deploy: true,
      reason: `${hits.length} of ${files.length} changed file(s) since ${base} are in scope, e.g. ${hits.slice(0, 5).join(', ')}`,
    };
  }
  return {
    deploy: false,
    reason: `none of the ${files.length} file(s) changed since ${base} (the last shipped commit) are in scope`,
  };
}

async function api(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'user-agent': 'mercaria-resolve-deploy-scope',
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return response.json();
}

async function findLastShipped({
  repository,
  workflowFile,
  currentRunId,
  shippingJob,
  shippedStep,
  token,
}) {
  const payload = await api(
    `/repos/${repository}/actions/workflows/${workflowFile}/runs?branch=main&status=success&per_page=50`,
    token,
  );
  const runs = (payload.workflow_runs ?? [])
    .filter((run) => String(run.id) !== String(currentRunId))
    .sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0))
    .slice(0, MAX_BASE_CANDIDATES);
  for (const run of runs) {
    const { jobs } = await api(
      `/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
      token,
    );
    const sha = shippedCommit({ run, jobs, shippingJob, shippedStep });
    if (sha) return { run, sha };
  }
  return null;
}

async function readCiRuns({ repository, token }) {
  const payload = await api(
    `/repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100`,
    token,
  );
  const bySha = new Map();
  const newestFirst = [...(payload.workflow_runs ?? [])].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  );
  for (const run of newestFirst) if (!bySha.has(run.head_sha)) bySha.set(run.head_sha, run);
  return bySha;
}

async function main() {
  const env = process.env;
  const repository = env.GITHUB_REPOSITORY;
  const tip = env.GITHUB_SHA;
  const token = env.GITHUB_TOKEN;
  const include = patternList(env.DEPLOY_PATHS);
  const exclude = patternList(env.DEPLOY_PATHS_IGNORE);

  const output = (values) => {
    if (env.GITHUB_OUTPUT) {
      appendFileSync(
        env.GITHUB_OUTPUT,
        Object.entries(values)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(''),
      );
    }
  };
  const summary = (line) => {
    console.log(line);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
  };

  // Validate the configuration before anything can short-circuit, so a broken
  // pattern list fails every run rather than only the ones that reach the diff.
  touchesScope({ files: [], include, exclude });

  if (!repository || !tip || !env.WORKFLOW_FILE || !env.SHIPPING_JOB) {
    throw new Error(
      'resolve-deploy-scope: GITHUB_REPOSITORY, GITHUB_SHA, WORKFLOW_FILE and SHIPPING_JOB are required',
    );
  }
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    summary(`DEPLOY ${tip}: a manual dispatch always deploys the commit it names`);
    output({ target: tip, deploy: true, held: false, tip_failed: false, base: '' });
    return;
  }

  // No catch here: a target that cannot be resolved must not be guessed, so an
  // API failure is a red gate rather than a deploy of the wrong commit.
  const [{ commits }, ciRuns] = await Promise.all([
    api(`/repos/${repository}/commits?sha=${tip}&per_page=${MAX_COMMITS}`, token).then((list) => ({
      commits: list.map((commit) => commit.sha),
    })),
    readCiRuns({ repository, token }),
  ]);
  const choice = chooseTarget({ commits, ciRuns });
  const tipFailed = choice.failedNewer.length > 0;
  if (tipFailed) {
    console.log(
      `::warning::newer commit(s) on main whose CI did not succeed: ${choice.failedNewer.join(', ')}`,
    );
  }
  if (choice.action === 'hold') {
    summary(
      `HOLD: ${choice.pending}, newer than any green commit, has a CI run that has not concluded; ` +
        'its completion triggers this workflow again',
    );
    output({ target: '', deploy: false, held: true, tip_failed: false, base: '' });
    return;
  }
  if (choice.action === 'none') {
    throw new Error(
      `resolve-deploy-scope: no commit among the newest ${MAX_COMMITS} on main has a green CI run`,
    );
  }
  const { target } = choice;
  console.log(`target: ${target}${target === tip ? ' (the tip)' : ` (tip is ${tip})`}`);

  let base = null;
  let comparison = null;
  try {
    const shipped = await findLastShipped({
      repository,
      workflowFile: env.WORKFLOW_FILE,
      currentRunId: env.GITHUB_RUN_ID,
      shippingJob: env.SHIPPING_JOB,
      shippedStep: env.SHIPPED_STEP || '',
      token,
    });
    base = shipped?.sha ?? null;
    if (shipped)
      console.log(`last shipped by run ${shipped.run.id}: ${base} — ${shipped.run.html_url}`);
    if (base) {
      comparison = await api(
        `/repos/${repository}/compare/${base}...${target}?per_page=100`,
        token,
      );
    }
  } catch (error) {
    console.log(`::warning::could not resolve the deploy scope (${error.message}); deploying`);
  }
  const { deploy, reason } = decide({ base, comparison, include, exclude });
  summary(`${deploy ? 'DEPLOY' : 'SKIP'} ${target}: ${reason}`);
  output({ target, deploy, held: false, tip_failed: tipFailed, base: base ?? '' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
