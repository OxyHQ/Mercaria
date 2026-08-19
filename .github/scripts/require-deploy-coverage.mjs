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
 * Measured on this repository over `Deploy to AWS` runs 60-358 on `main` (298
 * completed, 2026-07-29 to 2026-08-17): 232 success, 42 cancelled, 15 failure,
 * 9 action_required. Those 66 non-success runs form 37 windows in which a
 * merged commit was not in production; the median commit waited 23.1 minutes
 * and the worst waited 358.2 minutes. TWO of those windows contained a newly
 * added `post`-phase migration — 2026-08-08 (`0003_retire_legacy_payment_columns`
 * and `0005_drop_empty_string_defaults`, a 4.5-hour window) and 2026-08-17
 * (`0106_panoramic_patch`, the one #574 was opened for). Nothing reported any
 * of them.
 *
 * The window is pinned to run NUMBERS because the repository is live and these
 * figures move as you read them: the first pass counted 300/41/36 and twenty
 * minutes later the same query gave 298/42/37. Every run id is committed in
 * `docs/deploy/2026-08-18-evicted-deploy-run-evidence.md`, because Actions
 * history ages out and none of this can be re-derived once it has.
 *
 * ## The invariant, and why it is stated this way
 *
 * > The newest run of a deploy workflow on `main` must have concluded
 * > `success` — and, where the workflow declares what it did, that declaration
 * > must say it shipped. Every non-success run newer than the last success
 * > names a commit that is merged and not shipped.
 *
 * The second clause is #608 and it is not decoration: a `Deploy to AWS` run
 * that hits the service-existence guard skips every migration and the rollout
 * and still concludes `success`, so the first clause alone printed "shipped"
 * for a run that shipped nothing. See `DEPLOY_OUTCOME_STEPS`.
 *
 * Three things about the first clause's phrasing are load-bearing:
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
 *    of the 298 completions above had another run in flight at that instant —
 *    high precisely because this is the one workflow that SERIALISES — and
 *    firing on those is how an alarm gets muted. With it, the same history
 *    produces 23 reports rather than 66, every one of them a state where the
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
 *
 * `statesOutcome: true` marks the one that declares what it DID (see
 * `DEPLOY_OUTCOME_STEPS`). It is not a synonym for `migrations`: the three web
 * deploys have no short-circuit of that shape at all — measured, neither
 * `|| echo` nor an early `exit 0` appears in any of them, so `wrangler deploy`
 * failing is the only way for them to ship nothing, and that fails the job.
 * `deployCoverage.test.ts` DERIVES this flag by reading the workflow files for
 * the outcome step names, so a workflow that grows a statement, or loses one,
 * fails the build instead of being watched by the wrong rule.
 */
export const DEPLOY_WORKFLOWS = Object.freeze([
  Object.freeze({
    file: 'deploy-aws.yml',
    name: 'Deploy to AWS',
    migrations: true,
    statesOutcome: true,
  }),
  Object.freeze({
    file: 'deploy-cloudflare.yml',
    name: 'Deploy Frontend',
    migrations: false,
    statesOutcome: false,
  }),
  Object.freeze({
    file: 'deploy-dashboard.yml',
    name: 'Deploy Dashboard',
    migrations: false,
    statesOutcome: false,
  }),
  Object.freeze({
    file: 'deploy-pos.yml',
    name: 'Deploy POS',
    migrations: false,
    statesOutcome: false,
  }),
]);

/**
 * The outcome a deploy run STATES about itself, by step name (#608).
 *
 * ## Why this is read instead of inferred
 *
 * A `Deploy to AWS` run can conclude `success` having migrated and rolled out
 * NOTHING: the service-existence guard short-circuits, every later step is
 * skipped, and the job exits 0. So "the newest run succeeded" — the whole of
 * what #574 asserted — does not carry "the commit shipped", and this check was
 * printing the second from the first.
 *
 * The obvious cheap fix is to infer the hollow green from `Migrate (pre)` being
 * `skipped`. It was rejected: the rollout used to be decided by a SECOND,
 * independent ECS query inside a step with no `if:`, which therefore always
 * reported `success` whatever its shell decided — so the inference could not
 * reach the state that leaves a MIGRATED database served by the PREVIOUS image,
 * the worst of the three. #608 fixed that half at the source (one query, one
 * verdict, a failed query is now red), and this constant is the other half: the
 * workflow says what happened and this script reads the statement.
 *
 * ## Why STEP NAMES, of all channels
 *
 * Because they are the only machine-readable one. `/actions/runs/{id}/jobs`
 * returns `jobs[].steps[].name` and `.conclusion` and does NOT return a job's
 * `outputs:`; a step summary has no REST representation at all. An artifact
 * name would also travel, at the cost of an upload step and a 90-day expiry
 * that would silently turn every older run `unstated`.
 *
 * MEASURED against run 32131834422 (the newest successful `Deploy to AWS` on
 * `main` on 2026-08-18) rather than assumed: a job object's keys are exactly
 * check_run_url, completed_at, conclusion, created_at, head_branch, head_sha,
 * html_url, id, labels, name, node_id, run_attempt, run_id, run_url,
 * runner_group_id, runner_group_name, runner_id, runner_name, started_at,
 * status, steps, url, workflow_name — no `outputs`. The same read shows step
 * names coming back verbatim, em dashes included, and `Migrate (all)` reported
 * as `skipped` inside a green run.
 *
 * Each half is a PAIR whose two `if:` conditions are one predicate and its
 * negation, so exactly one member runs whenever the job reaches them. That is
 * what makes "neither" and "both" refusable rather than interpretable —
 * `judgeDeployOutcome` reports them as `contradictory` rather than guessing.
 */
export const DEPLOY_OUTCOME_STEPS = Object.freeze([
  Object.freeze({
    half: 'migrations',
    positive: 'Outcome: migrations applied',
    negative: 'Outcome: migrations NOT applied',
    absentMeans: 'the database was not touched by this run',
  }),
  Object.freeze({
    half: 'rollout',
    positive: 'Outcome: rollout performed',
    negative: 'Outcome: rollout NOT performed',
    absentMeans: 'the image is in ECR and is NOT being served',
  }),
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

/**
 * The phase marker a `pre` migration carries.
 *
 * Present so a body that declares NEITHER is distinguishable from one that
 * declares `pre`. There is no default phase — `db:generate` requires exactly one
 * marker — so a file with neither is a defect, and #672's containment report
 * treats it as `unknown`, which groups with `post`.
 */
export const PRE_PHASE_MARKER = '-- oxy:deploy-phase=pre';

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

/**
 * What one half of the outcome statement says, from the steps of a run.
 *
 * Four answers, and the two failure ones are kept apart because they lead
 * somewhere different: `unstated` means the run carries no such statement at
 * all — an older run, or a workflow whose statement was deleted — while
 * `ambiguous` means it carries a self-contradictory one, which is a defect in
 * the workflow rather than in its age.
 */
function judgeHalf(half, byName) {
  const positives = byName.get(half.positive) ?? [];
  const negatives = byName.get(half.negative) ?? [];
  if (positives.length === 0 && negatives.length === 0) return 'unstated';
  // Exactly one of the pair, once. A duplicated name is as unreadable as a
  // missing one: the two copies can disagree and nothing says which is meant.
  if (positives.length > 1 || negatives.length > 1) return 'ambiguous';
  const succeeded = [...positives, ...negatives].filter((step) => step.conclusion === 'success');
  if (succeeded.length !== 1) return 'ambiguous';
  return succeeded[0].name === half.positive ? 'positive' : 'negative';
}

/**
 * Did this run actually ship, by its own account?
 *
 * Pure and exported so every state can be pinned without the network — which
 * matters more here than for `judgeCoverage`, because three of the five states
 * are ones no healthy repository ever produces and an integration test would
 * therefore never reach.
 *
 * `unreadable` is the VACUITY FLOOR and it is deliberately first: a run whose
 * jobs came back empty, or whose jobs carry no steps, is what a token that lost
 * `actions: read`, a wrong run id or an API shape change produces — and it is
 * indistinguishable from a run that stated nothing. "I found no steps" must
 * never render as "no step said no".
 */
export function judgeDeployOutcome({ jobs }) {
  const jobList = jobs ?? [];
  const steps = jobList.flatMap((job) => job.steps ?? []);
  if (jobList.length === 0 || steps.length === 0) {
    return {
      state: 'unreadable',
      jobCount: jobList.length,
      stepCount: steps.length,
      halves: [],
    };
  }

  const byName = new Map();
  for (const step of steps) {
    const seen = byName.get(step.name) ?? [];
    seen.push(step);
    byName.set(step.name, seen);
  }

  const halves = DEPLOY_OUTCOME_STEPS.map((half) => ({
    half: half.half,
    absentMeans: half.absentMeans,
    verdict: judgeHalf(half, byName),
  }));

  const base = { jobCount: jobList.length, stepCount: steps.length, halves };
  if (halves.every((entry) => entry.verdict === 'unstated')) return { state: 'unstated', ...base };
  if (halves.some((entry) => entry.verdict === 'unstated' || entry.verdict === 'ambiguous')) {
    return { state: 'contradictory', ...base };
  }
  if (halves.some((entry) => entry.verdict === 'negative')) return { state: 'hollow', ...base };
  return { state: 'shipped', ...base };
}

/** Migration files a commit ADDED, from the commit endpoint's file list. */
export function addedMigrationFiles(files) {
  return (files ?? [])
    .filter((file) => file.status === 'added')
    .map((file) => file.filename)
    .filter((name) => name.startsWith(`${MIGRATIONS_PATH}/`) && name.endsWith('.sql'));
}

/**
 * Is this migration file present in the TREE at some commit — containment, never
 * ancestry (#672).
 *
 * Two directory listings, differenced. `judgeCoverage` above answers "did the
 * newest RUN succeed"; this answers the different question an operator actually
 * asks during an incident — "is the migration I merged applied?" — and the two
 * are stated separately because their costs are different.
 *
 * ## Why a set difference of listings, and not the three obvious alternatives
 *
 * **Not ancestry.** `git merge-base --is-ancestor` and the `compare` endpoint
 * both answer a question about HISTORY, and history and content diverge exactly
 * where somebody is looking: a squash, a revert, a cherry-pick. `compare` can
 * additionally UNDER-report here — a file present at the tip and absent at the
 * applied commit is invisible to it whenever the applied side deleted it after
 * the merge base, which is the revert case precisely.
 *
 * **Not `git cat-file -e <sha>:<path>`**, which #672 names, even though the gate
 * job does check out. `actions/checkout` fetches depth 1, so an older applied
 * commit is not in the local object store and `cat-file` fails for a FETCH
 * reason that is indistinguishable from the file being absent — the alarming
 * direction, on every run. The REST contents endpoint has identical semantics
 * with no fetch dependency, and the equivalence was measured rather than
 * assumed, on #672's own case: `0113_odd_tarot.sql` at `e2b22a36` gives
 * `cat-file` CONTAINS and HTTP 200, and at `e3e6ed6e` gives `cat-file` absent
 * and HTTP 404.
 *
 * **Not one containment call per migration.** There are 117 migration files and
 * 12 of them are `post`; a per-file probe is 117 calls an hour to answer a
 * question two directory reads answer exactly.
 *
 * Pure, so every state below is testable without the network — including the
 * ones an integration test would never reach.
 */
export function judgeMigrationContainment({ tipMigrations, appliedMigrations }) {
  // "I could not read a listing" is its own state and must never render as
  // "everything is applied" — the whole failure mode #672 is about, one level
  // down. `null` is what a propagated read failure hands us.
  if (!Array.isArray(tipMigrations) || !Array.isArray(appliedMigrations)) {
    return { state: 'unreadable', missing: [] };
  }
  // The vacuity floor. An empty tip listing is what a renamed folder, a wrong
  // ref or a changed API shape produces, and it reports "nothing is missing"
  // exactly as a fully-applied repository does.
  if (tipMigrations.length === 0) {
    return { state: 'no_migrations_found', missing: [] };
  }
  const applied = new Set(appliedMigrations);
  const missing = tipMigrations.filter((name) => !applied.has(name)).sort();
  if (missing.length === 0) return { state: 'applied', missing: [] };
  return { state: 'unapplied', missing };
}

/**
 * Split the unapplied migrations by phase, keeping #594's line.
 *
 * `pre` and `post` are NOT equally urgent and collapsing them is how an alarm
 * teaches people to ignore the case that matters. An unapplied `pre` left the
 * database and the image in sync at the OLD version — the deploy simply did not
 * happen. An unapplied `post` is the dangerous one: `post` statements break the
 * image that is already live, so a merged-and-unapplied `post` means the code
 * shipped and the schema it requires did not.
 *
 * A migration whose body could not be read is `unknown` and is grouped with
 * `post`, because the safe reading of "I cannot tell which phase this is" is the
 * urgent one.
 */
export function splitMigrationsByPhase(missing, phaseOf) {
  const post = [];
  const pre = [];
  for (const name of missing) {
    const phase = phaseOf(name);
    if (phase === 'pre') pre.push(name);
    else post.push(name);
  }
  return { post, pre };
}

/** Does this migration file body declare itself a post-rollout migration? */
export function declaresPostPhase(body) {
  return body.split('\n').some((line) => line.trim() === POST_PHASE_MARKER);
}

/**
 * Which phase a migration body declares: `pre`, `post`, or `unknown`.
 *
 * `unknown` covers both "no marker" and "both markers", and it is deliberately
 * NOT defaulted to `pre`. A file whose phase cannot be read is grouped with
 * `post` by {@link splitMigrationsByPhase}, so the ambiguous case lands on the
 * urgent side rather than the quiet one.
 */
export function declaredPhase(body) {
  const post = declaresPostPhase(body);
  const pre = body.split('\n').some((line) => line.trim() === PRE_PHASE_MARKER);
  if (post === pre) return 'unknown';
  return post ? 'post' : 'pre';
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

/**
 * The jobs of one run, for its LATEST attempt.
 *
 * That default (`filter=latest`) is what this wants: a re-run replaces the
 * answer rather than adding a second one, so the outcome read here is the
 * outcome of the attempt that currently stands.
 *
 * Any failure PROPAGATES, exactly as `readRuns` does. There is no fallback and
 * no `catch`, because every recovery available here answers "I could not tell"
 * and the only safe rendering of that is a refusal. `readPostMigrations` may
 * swallow because it is enrichment printed beside a verdict already reached;
 * this IS the verdict.
 */
async function readRunJobs({ repository, runId, token }) {
  const payload = await api(
    `/repos/${repository}/actions/runs/${runId}/jobs?per_page=${RUNS_PER_PAGE}`,
    token,
  );
  return payload.jobs ?? [];
}

function describeRun(run) {
  return `${(run.head_sha ?? '').slice(0, 8)} ${run.conclusion ?? run.status} — ${run.html_url}`;
}

/**
 * The `.sql` migration names present in the tree at `ref`, or `null`.
 *
 * `null` on ANY failure, and the caller renders that as its own `unreadable`
 * state rather than as "nothing is missing". A 404 on the FOLDER is a `null`
 * too: it means this ref predates the migrations folder or the folder moved,
 * and neither is evidence that a migration is applied.
 *
 * Only the names are returned. The bodies are read separately and only for the
 * few names that turn out to be missing, which is what keeps this two calls
 * instead of one per migration.
 */
async function readMigrationListing({ repository, ref, token }) {
  try {
    const entries = await api(
      `/repos/${repository}/contents/${encodeURI(MIGRATIONS_PATH)}?ref=${ref}`,
      token,
    );
    if (!Array.isArray(entries)) return null;
    return entries
      .filter((entry) => entry.type === 'file' && entry.name.endsWith('.sql'))
      .map((entry) => entry.name);
  } catch {
    return null;
  }
}

/**
 * The newest run that STATES it applied migrations, and the commit it built.
 *
 * Anchoring on the newest SUCCESS would be wrong: #608's hollow green is a run
 * that concluded `success` having migrated nothing, and containment measured
 * against that commit would report every migration applied because the code was
 * present in its tree. What has to be true is that a run CARRYING the migration
 * also RAN the migrator, so the anchor is the newest run whose `migrations` half
 * reads `positive`.
 *
 * Bounded, because reading jobs costs a call per run and a long unshipped
 * stretch would otherwise walk the whole page. Exhausting the bound is its own
 * answer — `null` — never a fallback to a weaker anchor.
 */
async function findNewestMigratingRun({ repository, runs, token, maxJobReads = 12 }) {
  let reads = 0;
  for (const run of sortNewestFirst(runs)) {
    if (run.status !== 'completed' || run.conclusion !== 'success') continue;
    if (reads >= maxJobReads) return null;
    reads += 1;
    const jobs = await readRunJobs({ repository, runId: run.id, token });
    const outcome = judgeDeployOutcome({ jobs });
    const migrations = outcome.halves.find((half) => half.half === 'migrations');
    if (migrations?.verdict === 'positive') return run;
  }
  return null;
}

/**
 * The SECOND claim (#672): is every migration merged on `main` contained in a
 * commit some deploy actually migrated?
 *
 * Stated separately from `checkDeployCoverage` and never folded into it, because
 * the run-anchored claim has to keep working unchanged for the docs-only case.
 * That is also why #672 is not "swap the anchor": all four deploy workflows
 * carry `paths:`/`paths-ignore:` filters, so a docs-only tip legitimately
 * produces no run, and a commit-anchored check would have to rebuild those
 * filters out of a diff — the untestable reconstruction `docs/deploy.md`
 * rejects.
 *
 * This claim sidesteps that entirely by not being about commits. It is about
 * migration FILES, which is the right shape for a second reason #672 names:
 * migrations are cumulative, so "carried" is not "was added by" — `f38227b7`
 * added no migration at all and applied `0106`.
 */
export async function checkMigrationContainment({
  repository,
  branch = 'main',
  token,
  workflows = DEPLOY_WORKFLOWS,
  log = console.log,
}) {
  const workflow = workflows.find((entry) => entry.migrations);
  if (!workflow) return { problems: [] };

  const runs = await readRuns({ repository, file: workflow.file, branch, token });
  const migrating = await findNewestMigratingRun({ repository, runs, token });
  if (!migrating) {
    // Its own state. "No run said it migrated" is not "everything is applied",
    // and it is exactly what a stalled pipeline looks like.
    return {
      problems: [
        `MIGRATION CONTAINMENT: no run of ${workflow.name} on ${branch} states that it applied ` +
          `migrations, within the newest runs read. Nothing here says a migration is missing — ` +
          `it says this check could not find a commit whose deploy ran the migrator, which is ` +
          `not the same as everything being applied.`,
      ],
    };
  }

  const [tipMigrations, appliedMigrations] = await Promise.all([
    readMigrationListing({ repository, ref: branch, token }),
    readMigrationListing({ repository, ref: migrating.head_sha, token }),
  ]);
  const verdict = judgeMigrationContainment({ tipMigrations, appliedMigrations });

  if (verdict.state === 'unreadable') {
    return {
      problems: [
        `MIGRATION CONTAINMENT: could not read the migration listing at ${branch} or at ` +
          `${(migrating.head_sha ?? '').slice(0, 8)}. An unreadable listing is what a token ` +
          `without \`contents: read\`, a moved folder or a changed API shape looks like — it is ` +
          `not evidence that every migration is applied.`,
      ],
    };
  }
  if (verdict.state === 'no_migrations_found') {
    return {
      problems: [
        `MIGRATION CONTAINMENT: the listing of ${MIGRATIONS_PATH} at ${branch} is EMPTY. That is ` +
          `a renamed folder or a broken read, not a repository with no migrations, and it ` +
          `reports "nothing is missing" exactly as a fully-applied repository does.`,
      ],
    };
  }
  if (verdict.state === 'applied') {
    log(
      `Migration containment: every one of the ${tipMigrations.length} migrations on ${branch} is ` +
        `contained in ${(migrating.head_sha ?? '').slice(0, 8)}, which states it applied ` +
        `migrations — ${migrating.html_url}`,
    );
    return { problems: [] };
  }

  // Read the phase of ONLY the missing files, at the tip where they exist.
  const phases = new Map();
  for (const name of verdict.missing) {
    try {
      const body = await api(
        `/repos/${repository}/contents/${encodeURI(`${MIGRATIONS_PATH}/${name}`)}?ref=${branch}`,
        token,
        { raw: true },
      );
      phases.set(name, declaredPhase(body));
    } catch {
      phases.set(name, 'unknown');
    }
  }
  const { post, pre } = splitMigrationsByPhase(verdict.missing, (name) => phases.get(name));

  const lines = [];
  if (post.length > 0) {
    lines.push(
      `MIGRATION CONTAINMENT: ${post.length} migration(s) merged on ${branch} and NOT applied.`,
      `  the newest deploy that states it migrated built ` +
        `${(migrating.head_sha ?? '').slice(0, 8)} — ${migrating.html_url}`,
    );
    for (const name of post) {
      const phase = phases.get(name);
      lines.push(
        `  *** ${name} (${phase === 'unknown' ? 'PHASE UNREADABLE — treated as post' : 'post'}) ` +
          `is on ${branch} and is absent from that commit's tree.`,
      );
    }
    lines.push(
      '  a `post` migration breaks the image that is already live, so this is the live half: ' +
        'the code shipped and the schema it requires did not.',
    );
  }
  if (pre.length > 0) {
    // Reported, never alarmed. An unapplied `pre` left the database and the
    // image in sync at the old version, and alarming on it is how the `post`
    // case gets ignored.
    log(
      `Migration containment: ${pre.length} \`pre\` migration(s) on ${branch} are not yet ` +
        `applied (${pre.join(', ')}). A \`pre\` that did not run left the database and the image ` +
        `in sync at the old version, so this is reported and not alarmed.`,
    );
  }
  return { problems: lines.length > 0 ? [lines.join('\n')] : [] };
}

/**
 * The report for a run that succeeded without shipping.
 *
 * Names WHICH HALF is missing, because the two lead to different remedies and
 * to very different urgency: a rollout that did not happen leaves the previous
 * image serving code that is a release behind, while migrations that did not
 * happen leave the database behind the image — and the pair of them apart is
 * the state the workflow now cannot reach and this check would still catch.
 */
function describeHollowGreen(workflow, run, outcome) {
  const lines = [`${workflow.name}: HOLLOW GREEN — the newest run succeeded and shipped nothing.`];
  lines.push(`  - ${describeRun(run)}`);

  if (outcome.state === 'unreadable') {
    lines.push(
      `  read ${outcome.jobCount} job(s) and ${outcome.stepCount} step(s) for this run. An empty` +
        ` read is what a token without \`actions: read\` or a changed API shape looks like —` +
        ` it is not evidence that the run shipped.`,
    );
    return lines.join('\n');
  }
  if (outcome.state === 'unstated') {
    lines.push(
      `  the run states no outcome at all. Every deploy since #608 declares one through the` +
        ` steps named ${DEPLOY_OUTCOME_STEPS.map((half) => `"${half.positive}"`).join(' and ')},` +
        ` so this is a run that predates the statement or a workflow that lost it.`,
    );
    return lines.join('\n');
  }
  if (outcome.state === 'contradictory') {
    for (const entry of outcome.halves) {
      lines.push(`  ${entry.half}: ${entry.verdict}`);
    }
    lines.push(
      '  the two steps of a half are one predicate and its negation, so exactly one of each' +
        ' must have run. This run says otherwise, which is a defect in the workflow.',
    );
    return lines.join('\n');
  }

  for (const entry of outcome.halves.filter((half) => half.verdict === 'negative')) {
    lines.push(`  *** ${entry.half.toUpperCase()} DID NOT HAPPEN: ${entry.absentMeans}`);
  }
  return lines.join('\n');
}

/**
 * Check every deploy workflow and report.
 *
 * Returns `{ problems, deferred }` rather than just the failures, because the
 * summary line has to be able to tell "every deploy succeeded" from "one is
 * still running and I did not look". The first version printed the former in
 * both cases — the precise overclaim this whole check exists to stop, made by
 * the check itself.
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
  const deferred = [];
  let workflowsWithRuns = 0;

  for (const workflow of workflows) {
    const runs = await readRuns({ repository, file: workflow.file, branch, token });
    const verdict = judgeCoverage({ runs, now: now() });
    if (runs.length > 0) workflowsWithRuns += 1;

    if (verdict.state === 'covered') {
      // `covered` says the newest run CONCLUDED success. For a workflow that
      // declares what it did, that is not yet "shipped" — one more call, on one
      // run, turns a conclusion into a statement (#608).
      if (workflow.statesOutcome) {
        const jobs = await readRunJobs({ repository, runId: verdict.lastSuccess.id, token });
        const outcome = judgeDeployOutcome({ jobs });
        if (outcome.state !== 'shipped') {
          problems.push(describeHollowGreen(workflow, verdict.lastSuccess, outcome));
          continue;
        }
      }
      log(`${workflow.name}: shipped — newest run ${describeRun(verdict.lastSuccess)}`);
      continue;
    }
    if (verdict.state === 'pending') {
      deferred.push(workflow.name);
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

  return { problems, deferred };
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
  let deferred;
  try {
    ({ problems, deferred } = await checkDeployCoverage({ repository, branch, token }));
    // The SECOND claim (#672), stated separately and appended to the same
    // report. Separate because the two answer different questions — "did the
    // newest RUN succeed" and "is the migration I merged APPLIED" — and the
    // first has to keep working unchanged for the docs-only case, where there
    // is legitimately no run at all.
    const containment = await checkMigrationContainment({ repository, branch, token });
    problems = [...problems, ...containment.problems];
  } catch (error) {
    if (error instanceof CoverageFailure) {
      console.error(`\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  if (problems.length === 0) {
    // Say which of the two greens this is. A deferred workflow has a verdict
    // coming, and its own completion re-runs this check; claiming it succeeded
    // would be exactly the overclaim #574 is about.
    console.log(
      deferred.length === 0
        ? `\nEvery deploy workflow's newest run on ${branch} succeeded.`
        : `\nNothing unshipped on ${branch}. Not yet decided for ${deferred.length} of ` +
            `${DEPLOY_WORKFLOWS.length} (${deferred.join(', ')}) — a run is still in flight, ` +
            `and its conclusion re-runs this check.`,
    );
    return;
  }

  const report = problems.join('\n\n');
  console.error(
    `\n::error title=Merged on ${branch} but not shipped::` +
      `${problems.length} deploy workflow(s) left work unshipped — see the job log.\n`,
  );
  console.error(`${report}\n`);
  console.error(
    'Either a deploy run was evicted from the queue, failed, or is awaiting approval and\n' +
      'the run that superseded it did not succeed either — or a run CONCLUDED SUCCESS while\n' +
      'shipping nothing, which is the HOLLOW GREEN above. Both leave the code and any\n' +
      `migrations on those commits OUT of production.\n\n` +
      'To fix: re-run the newest deploy run linked above, or merge/push again so a fresh\n' +
      'deploy ships the current tip. Migrations are cumulative and the post-rollout step\n' +
      'runs on every deploy, so one successful deploy applies everything pending.\n\n' +
      'A hollow green additionally means the ECS service was not found. That is a fact\n' +
      'about the infrastructure, not about this repository: check that service `mercaria`\n' +
      'on cluster `oxy-cluster` still exists (oxy-infra owns it). Re-running the deploy\n' +
      'will not help until it does.\n',
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
