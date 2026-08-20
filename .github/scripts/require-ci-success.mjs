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
 *  - **A TRANSPORT failure is not a verdict either (#728), and this one is the
 *    complement of the rest.** Every rule above defends against reading GREEN
 *    while measuring nothing; this defends the other direction. A socket fault
 *    while polling used to escape the loop and exit 1, which is byte-identical
 *    to a refusal: `deploy` skipped, run red, deploy-coverage reporting the
 *    commit as uncovered. Measured on run 32367249937 for `8c6654a5`, whose CI
 *    was `in_progress` at the time and SUCCEEDED eight minutes later — and
 *    because these workflows trigger only on `push`/`workflow_dispatch`, nothing
 *    re-fires when that happens. So a transport error is retried within its own
 *    bound and, if it persists, refused with a message that SAYS it was
 *    transport. "I could not ask" and "the answer was no" must not be the same
 *    observable.
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

/**
 * How long the API may be UNREACHABLE before the gate gives up (#728).
 *
 * Its own bound, deliberately shorter than the two above. Those measure how long
 * a verdict may take to arrive; this measures how long we may fail to ASK. A
 * permanently unreachable API must not spend the 30-minute conclude budget and
 * then report the same undifferentiated red — that converts "I could not ask"
 * into a hang.
 *
 * CONSECUTIVE, not cumulative: any successful call resets it. A blip is what
 * this exists to absorb; a sustained outage is what it exists to report.
 */
const TRANSPORT_TIMEOUT_MS = 2 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class GateFailure extends Error {}

/**
 * Error codes that mean "the request did not complete", not "the answer is no".
 *
 * Measured from the real failure this exists for — `Deploy to AWS` run
 * 32367249937 on `8c6654a5`, whose log reads:
 *
 *     TypeError: fetch failed
 *       [cause]: SocketError: other side closed
 *         code: 'UND_ERR_SOCKET',
 *
 * The `fetch failed` wrapper is checked as well as the codes, because it is
 * Node's outer shape for EVERY network fault and therefore covers causes not on
 * this list. The list is still worth having: it also matches an error thrown
 * with a bare `code` and no wrapper.
 */
const TRANSPORT_ERROR_CODES = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_RESPONSE_STATUS_CODE',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
]);

/**
 * Whether an error means the gate could not ASK, rather than that the answer
 * was no (#728).
 *
 * ## A `GateFailure` is never transport, and that is stated HERE
 *
 * The first line is the whole safety property of this change: a deliberate
 * refusal must keep exiting 1. Putting it in the classifier rather than in the
 * caller's branch order means a second call site cannot get it wrong — there is
 * no ordering to reproduce. `api()` raises `GateFailure` for a 401/403/404
 * precisely because those are a broken gate rather than a slow queue, and
 * retrying one for two minutes would bury the message that names the fix.
 *
 * ## It refuses to guess
 *
 * Anything that is neither a `GateFailure` nor a recognisable network fault is
 * rethrown UNCHANGED and immediately — a `TypeError` from a bug in this script
 * must not be retried for two minutes and then reported as a network problem,
 * which would be a wrong diagnosis printed with confidence. Widening this to
 * "anything that is not a GateFailure" is the tempting simplification and it is
 * the one to refuse.
 */
export function isTransportError(error) {
  if (error instanceof GateFailure) return false;
  if (!error || typeof error !== 'object') return false;
  const codes = [error.code, error.cause?.code, error.cause?.cause?.code];
  if (codes.some((code) => typeof code === 'string' && TRANSPORT_ERROR_CODES.has(code))) {
    return true;
  }
  // Node wraps every network fault from `fetch` in this exact TypeError.
  return error instanceof TypeError && /fetch failed/iu.test(String(error.message ?? ''));
}

/** The shortest true description of a transport error, for the poll log. */
function describeTransportError(error) {
  const code = error?.code ?? error?.cause?.code ?? error?.cause?.cause?.code;
  const detail = error?.cause?.message ?? error?.message ?? String(error);
  return code ? `${code}: ${detail}` : String(detail);
}

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

async function requireCiSuccess({
  repository,
  sha,
  token,
  now = () => Date.now(),
  // Injected so the retry can be tested without a network — the `now` seam
  // above set the precedent. Production passes none of them, so the defaults
  // ARE the shipped behaviour rather than a parallel path.
  findRuns = findRunsForSha,
  readRunJobs = readJobs,
  sleepFor = sleep,
}) {
  const startedAt = now();
  let seenRun = null;
  /** When the CURRENT unbroken run of transport failures began; null when healthy. */
  let transportFailingSince = null;

  /**
   * Convert a transport failure into a poll miss, or refuse once it persists.
   *
   * Rethrows anything that is not a transport error, so a `GateFailure` and a
   * bug in this script both surface immediately and unchanged.
   */
  const absorbTransportFailure = (error) => {
    if (!isTransportError(error)) throw error;
    const at = now();
    transportFailingSince ??= at;
    if (at - transportFailingSince > TRANSPORT_TIMEOUT_MS) {
      throw new GateFailure(
        `Could not reach the GitHub API for ${Math.round(TRANSPORT_TIMEOUT_MS / 60000)} ` +
          `minutes while checking CI for ${sha}.\n` +
          `Last error: ${describeTransportError(error)}\n\n` +
          `This is a TRANSPORT failure, not a CI verdict. The gate could not ASK whether CI ` +
          `passed, which is a different thing from CI having failed — this commit may be ` +
          `perfectly deployable. Re-run this deploy once the API is reachable; do not read ` +
          `it as a red CI, and do not revert the commit on the strength of this message.`,
      );
    }
    console.log(`waiting: GitHub API unreachable (${describeTransportError(error)}); retrying…`);
  };

  for (;;) {
    let runs;
    try {
      runs = await findRuns({ repository, sha, token });
    } catch (error) {
      absorbTransportFailure(error);
      await sleepFor(POLL_INTERVAL_MS);
      continue;
    }
    transportFailingSince = null;
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
      await sleepFor(POLL_INTERVAL_MS);
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
      await sleepFor(POLL_INTERVAL_MS);
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

    // The SAME retry, because this call reaches the network too. A socket fault
    // here is exactly as much "not a verdict" as one in the run lookup, and
    // leaving it bare would have fixed half the bug — the half that happened to
    // fail first on 8c6654a5.
    let jobs;
    try {
      jobs = await readRunJobs({ repository, runId: run.id, token });
    } catch (error) {
      absorbTransportFailure(error);
      await sleepFor(POLL_INTERVAL_MS);
      continue;
    }
    transportFailingSince = null;

    const problems = judgeJobs(jobs);
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
