/**
 * The CONTENT revert detector (#735).
 *
 * A branch cut from an older base can silently delete work that landed after
 * it, and every gate reads green. It happened: `ec05743c` (PR #725) reverted
 * the whole of #726 — 58 files including a build gate — and CI passed.
 *
 * ## Why ancestry cannot see this, and why content can
 *
 * #725 was NOT stale by any ancestry measure. It HAD #726 in its history —
 * `merge-base(31e4da1f, 8c6654a5) = 8c6654a5`, #726's own merge commit — and
 * then discarded the content while resolving the merge. The signature is *"the
 * branch contains X but its tree does not reflect X"*, and no ancestry question
 * can express it: **ancestry is about what a branch KNOWS, this is about what
 * it KEPT.**
 *
 * That is not a hypothesis. The "base must not be older than the last commit
 * touching any file it modifies" check was implemented and its positive control
 * against #725 returned **ZERO** — `files checked: 67 | STALE: 0`. It is
 * recorded here rather than deleted because **a reader who sees only the
 * surviving mechanism will re-propose the refuted one**, which is exactly how
 * that one came to be proposed in the first place.
 *
 * What content can say: **a revert REPRODUCES a past state; new work does
 * not.** So for each file a branch changes, ask whether the branch's blob
 * equals an EARLIER blob of that same file on the base branch while differing
 * from the base's current one.
 *
 * ## Measured coverage
 *
 * Against #725, from `8d55ddbe` (main as it was BEFORE the merge) to
 * `ec05743c`: 73 files, 69 differing, **54 reverts**. With the deletion
 * tripwire's 4, that is **58 of 58** — the whole incident. Against three
 * ordinary feature merges: 7, 2 and 10 files differing and **0 reverts**.
 *
 * ## The deletion tripwire is a TRIPWIRE, not a census
 *
 * `git diff --diff-filter=D` fires on #725 and names its four deleted modules,
 * and that is **4 of 58**. The other 54 were reverted by MODIFICATION, which a
 * deletion filter cannot see — including the three that did the damage
 * (`validate-i18n-strings.mjs`, `ShoppingAgentCard.tsx`,
 * `ui/i18n/locales/en.json`). Had #726 created no new modules it would have
 * been silent on all 58. It is reported beside the content result, with that
 * number, so nobody mistakes it for coverage.
 *
 * ## Two limits, stated here rather than discovered later
 *
 * 1. **The history walk is bounded** to {@link HISTORY_WINDOW} commits per
 *    file. A revert to a state older than that window is MISSED. The bound
 *    exists because this runs on every PR and an unbounded walk over a file
 *    with thousands of commits is how a gate becomes something somebody turns
 *    off.
 * 2. **A deliberate revert PR is flagged, and that is correct.** A real revert
 *    should be confirmed, not waved through — the restore of #726 (`78a0e78a`)
 *    fires on all 58 of its files, exactly as it should. The failure message
 *    says how to acknowledge one rather than implying a defect.
 *
 * ## What this does NOT cover
 *
 * The signal that would have caught #725 fastest was SCOPE: 73 files for a PR
 * titled *"give claim re-settlement an operator caller"*, including twelve
 * locale bundles and an i18n guard. That is a judgement, not a mechanism, and
 * #735 records it as deliberately not mechanisable. This gate covers the
 * incident; the judgement covers the ones it does not.
 */

import { execFileSync } from 'node:child_process';

/**
 * How many commits of each file's history are examined on the base branch.
 *
 * Generous against the incident it is built from — every one of #725's 54
 * reverts is found within a handful of commits — and bounded because this runs
 * on every pull request. A revert to a state older than this is missed, which
 * is limit 1 above.
 */
export const HISTORY_WINDOW = 80;

/** The env var a deliberate revert sets. `all`, or a comma-separated path list. */
export const ACKNOWLEDGE_ENV = 'CONTENT_REVERT_ACKNOWLEDGED';

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // A path absent at a commit is an ANSWER here, not an error, and git
      // writes `fatal: ... exists on disk, but not in <rev>` for every one.
      // Left on stdout a clean run prints dozens of them, which is how a gate
      // teaches its readers to skim past its own output — and a real failure
      // then arrives in a wall of noise nobody reads.
      stdio: allowFailure ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

/** A blob id, or `null` when the path does not exist at that commit. */
function blobAt(commit, path) {
  return git(['rev-parse', `${commit}:${path}`], { allowFailure: true });
}

/**
 * Does `commit` exist in this clone?
 *
 * Asked explicitly because the answer on a SHALLOW clone is no, and a control
 * that cannot reach its own fixture reports the same clean output as one that
 * ran and found nothing — which is the exact shape of the incident this gate
 * exists for. `actions/checkout` defaults to `fetch-depth: 1`.
 */
export function commitPresent(commit) {
  return git(['cat-file', '-e', `${commit}^{commit}`], { allowFailure: true }) !== null;
}

/**
 * Run the detector between two commits.
 *
 * `base` is the branch being merged INTO and supplies both halves of the
 * question — its current blob, and the history the earlier blob is looked for
 * in. For a merge gate that is `origin/main`; for the positive control it must
 * be main as it was BEFORE the merge under test, never the merge itself.
 */
export function detectContentReverts({ base, head, window = HISTORY_WINDOW }) {
  const mergeBase = git(['merge-base', base, head]);
  const changed = git(['diff', '--name-only', `${mergeBase}...${head}`])
    .split('\n')
    .filter((line) => line.length > 0);

  const deletions = git(['diff', '--diff-filter=D', '--name-only', `${mergeBase}...${head}`])
    .split('\n')
    .filter((line) => line.length > 0);

  const reverts = [];
  let differing = 0;

  for (const path of changed) {
    const mine = blobAt(head, path);
    // Deleted on the branch. The content question does not apply — the
    // deletion tripwire is what speaks for these.
    if (mine === null) continue;

    const current = blobAt(base, path);
    if (mine === current) continue;
    differing += 1;

    const history = git(['log', '--format=%H', `-n`, String(window), base, '--', path]);
    if (history === null || history.length === 0) continue;

    for (const commit of history.split('\n')) {
      if (blobAt(commit, path) === mine) {
        reverts.push({ path, reproduces: commit });
        break;
      }
    }
  }

  return { mergeBase, changed, differing, reverts, deletions };
}

/**
 * The commit trailer a branch acknowledges a deliberate revert with.
 *
 * Read from the COMMITS on the branch rather than from the pull request body,
 * and that is the whole reason it exists. The env var below cannot be set from
 * a pull request at all — only in the workflow — so before this the only routes
 * past a legitimate revert were editing `ci.yml`, which then applies to every
 * future pull request, or turning the gate off. A gate whose cheapest green is
 * the dangerous action is worse than no gate, and this one qualified until it
 * fired on its first legitimate change.
 *
 * A trailer is in the branch, appears in the diff, is reviewable beside the
 * change it excuses, and does not outlive the branch the way a workflow edit
 * does. A pull request BODY would not do: it is editable after review and is
 * not part of what merges.
 */
export const ACKNOWLEDGE_TRAILER = 'Content-revert-acknowledged';

/**
 * Paths named by acknowledgement trailers on `base..head`.
 *
 * Repeatable — one trailer per path is the intended spelling, because the
 * failure this gate exists for is a revert NOBODY LOOKED AT, and naming each
 * file is the looking. `all` stays available and is deliberately coarser to
 * read in the output.
 *
 * Matched case-insensitively on the trailer NAME only. Git's own trailer
 * convention is case-insensitive and a branch that wrote `content-revert-
 * acknowledged:` would otherwise be silently unacknowledged — which is a false
 * RED, the direction that teaches people to bypass the gate.
 */
function trailerAcknowledgements(base, head) {
  const log = git(['log', '--format=%B%x00', `${base}..${head}`], { allowFailure: true });
  const paths = new Set();
  let all = false;
  for (const line of log.split(/\r?\n/)) {
    const match = /^\s*Content-revert-acknowledged\s*:\s*(.+?)\s*$/i.exec(line);
    if (match === null) continue;
    const value = match[1];
    if (value === 'all') all = true;
    else for (const entry of value.split(',')) paths.add(entry.trim());
  }
  return { all, paths };
}

/**
 * Paths the caller has declared a deliberate revert of.
 *
 * Two sources, unioned: the {@link ACKNOWLEDGE_TRAILER} on the branch's own
 * commits — the only one available from a pull request — and
 * {@link ACKNOWLEDGE_ENV}, kept for a local run where committing a trailer to
 * try a comparison would be absurd.
 */
function acknowledged(base, head) {
  const fromTrailers = trailerAcknowledgements(base, head);
  const raw = (process.env[ACKNOWLEDGE_ENV] ?? '').trim();
  if (raw.length === 0) return fromTrailers;
  if (raw === 'all') return { all: true, paths: fromTrailers.paths };
  return {
    all: fromTrailers.all,
    paths: new Set([...fromTrailers.paths, ...raw.split(',').map((entry) => entry.trim())]),
  };
}

function main() {
  const base = process.env.REVERT_DETECTOR_BASE?.trim() || 'origin/main';
  const head = process.env.REVERT_DETECTOR_HEAD?.trim() || 'HEAD';

  if (!commitPresent(base) || !commitPresent(head)) {
    console.error(
      `content-revert: cannot reach ${base} or ${head} in this clone.\n` +
        'On CI this means a SHALLOW checkout: set `fetch-depth: 0` on actions/checkout.\n' +
        'Failing rather than skipping — a detector that cannot see its subject reports the\n' +
        'same clean output as one that ran and found nothing.',
    );
    process.exit(1);
  }

  const result = detectContentReverts({ base, head });

  // The vacuity floor. "No reverts found" and "found no files" are the same
  // output, and that identity IS this incident in miniature — so an empty
  // population is a failure of the gate, never a pass.
  if (result.changed.length === 0) {
    console.error(
      `content-revert: the population is EMPTY — no files differ between ${base} and ${head}.\n` +
        'That is not a clean result, it is no result: this gate cannot distinguish it from\n' +
        'a run that examined everything and found nothing. Check the refs.',
    );
    process.exit(1);
  }

  console.log(
    `content-revert: ${result.changed.length} changed, ${result.differing} differing from ` +
      `${base}, ${result.reverts.length} reverting an earlier state ` +
      `(history window ${HISTORY_WINDOW}).`,
  );

  if (result.deletions.length > 0) {
    // Reported with its measured coverage so nobody reads it as a census: on
    // the incident this gate is built from it saw 4 of 58.
    console.log(
      `content-revert: ${result.deletions.length} file(s) deleted — a TRIPWIRE, not a census ` +
        '(4 of 58 on #725; the other 54 were reverted by modification):',
    );
    for (const path of result.deletions) console.log(`  D ${path}`);
  }

  if (result.reverts.length === 0) {
    process.exit(0);
  }

  const ack = acknowledged(base, head);
  const unacknowledged = ack.all
    ? []
    : result.reverts.filter((entry) => !ack.paths.has(entry.path));

  for (const entry of result.reverts) {
    const mark = ack.all || ack.paths.has(entry.path) ? 'ack' : 'REVERTS';
    console.log(`  ${mark} ${entry.path}  (reproduces ${entry.reproduces.slice(0, 8)})`);
  }

  if (unacknowledged.length === 0) {
    console.log('content-revert: every reverted file is acknowledged.');
    process.exit(0);
  }

  console.error(
    `\ncontent-revert: ${unacknowledged.length} file(s) reproduce an earlier state of ` +
      `${base} while differing from its current one.\n\n` +
      'This is what a stale-base branch looks like when it discards work that landed after\n' +
      'it: the branch may well CONTAIN that work in its history and simply not reflect it in\n' +
      'its tree, which is why no ancestry check reports anything.\n\n' +
      'If this is a DELIBERATE revert or restore, that is a legitimate change and this gate\n' +
      'is asking you to confirm it rather than reporting a defect. Acknowledge it with:\n\n' +
      `  ${ACKNOWLEDGE_TRAILER}: <path>   # in a commit on this branch, one per file\n` +
      `  ${ACKNOWLEDGE_TRAILER}: all      # coarser, and it says so in the output\n\n` +
      `The trailer is what works from a pull request; ${ACKNOWLEDGE_ENV} is for a local run.\n\n` +
      'If it is NOT deliberate, rebase onto the base branch and re-apply your own changes on\n' +
      "top of the current content — do not resolve the conflict by taking your branch's side.",
  );
  process.exit(1);
}

if (import.meta.main) main();
