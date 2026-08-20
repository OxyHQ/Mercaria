/**
 * The controls for the content revert detector (#735).
 *
 * The detector exists because a plausible-but-uncontrolled mechanism shipped as
 * coverage once already: "a PR's base must not be older than the last commit
 * touching any file it modifies" was implemented, and its positive control
 * against #725 returned ZERO. **The controls below are the thing that caught
 * that, and they must stay able to catch the next one.**
 *
 * ## The positive control is the incident itself
 *
 * `8d55ddbe` → `ec05743c`. Both are permanent commits on `main`, deliberately:
 * the pre-squash branch (`31e4da1f`) is not reachable once its remote branch is
 * deleted, and a control whose fixture can disappear is a control that will one
 * day pass by being unable to run. Both pairs were measured and agree exactly —
 * 73 files, 69 differing, 54 reverts.
 *
 * ## The base must be main as it was BEFORE the merge under test
 *
 * `8d55ddbe`, never `ec05743c`. This has already gone wrong in the opposite
 * direction: the detector's first run was pointed at `origin/main`, which IS
 * #725's merge, so the branch's content equalled main's and it reported
 * `0 differing, 0 reverts` — nearly discarding a WORKING detector as useless.
 * **A tree that already contains the defect can neither exhibit nor detect it.**
 *
 * A vacuous control is not biased toward either outcome. It returns whatever
 * the empty set returns and the reader supplies the conclusion — which is how
 * one broken mechanism was nearly shipped and one working one nearly binned.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  commitPresent,
  detectContentReverts,
  HISTORY_WINDOW,
} from './validate-no-content-revert.mjs';

/** Main as it was immediately BEFORE #725's merge. */
const BEFORE_THE_REVERT = '8d55ddbe';
/** #725 — the merge that reverted the whole of #726. */
const THE_REVERT = 'ec05743c';
/** #734 — the restore, which legitimately reproduces an earlier state. */
const THE_RESTORE = '78a0e78a';
/** #733 — an ordinary feature merge, the negative control. */
const AN_ORDINARY_MERGE = 'f9292ba2';

/** #725's measured signature, and the number the whole gate rests on. */
const EXPECTED_REVERTS = 54;
const EXPECTED_DELETIONS = 4;

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
}

// ── The fixtures have to exist, and their absence must be LOUD ──────────────
//
// On a shallow clone every case below would examine an empty population and
// report clean. That is the failure mode this whole gate is about, so it is
// checked first and named precisely.
for (const commit of [BEFORE_THE_REVERT, THE_REVERT, THE_RESTORE, AN_ORDINARY_MERGE]) {
  if (!commitPresent(commit)) {
    console.error(
      `content-revert controls: ${commit} is not in this clone.\n` +
        'These controls run against real repository history, so CI must check out with\n' +
        '`fetch-depth: 0`. Refusing to report a result computed over commits that are\n' +
        'not here — an unreachable fixture and a clean run produce the same output.',
    );
    process.exit(1);
  }
}

console.log('content-revert controls:');

// ── 1. POSITIVE: the incident fires, and fires on the measured number ───────
const positive = detectContentReverts({ base: BEFORE_THE_REVERT, head: THE_REVERT });

// Stated separately from the count below, because it is the assertion that
// caught the refuted mechanism: that one returned ZERO here.
check(
  'the #725 revert is detected at all (the refuted ancestry check returned ZERO here)',
  positive.reverts.length > 0,
  `got ${positive.reverts.length}`,
);
check(
  `the #725 revert is detected on exactly ${EXPECTED_REVERTS} files`,
  positive.reverts.length === EXPECTED_REVERTS,
  `got ${positive.reverts.length}`,
);
check(
  `the deletion tripwire sees ${EXPECTED_DELETIONS} of them — a tripwire, not a census`,
  positive.deletions.length === EXPECTED_DELETIONS,
  `got ${positive.deletions.length}`,
);
// The three files that did the actual damage were reverted by MODIFICATION, so
// a deletion filter is silent on all three. Named individually because "54" is
// a number and these are the reason the number matters.
for (const path of [
  'scripts/validate-i18n-strings.mjs',
  'packages/ui/src/i18n/locales/en.json',
]) {
  check(
    `names ${path}, which the deletion filter cannot see`,
    positive.reverts.some((entry) => entry.path === path),
    'not flagged',
  );
}

// ── 2. NEGATIVE: ordinary work is not a revert ──────────────────────────────
const negative = detectContentReverts({
  base: `${AN_ORDINARY_MERGE}^`,
  head: AN_ORDINARY_MERGE,
});
check(
  'an ordinary feature merge raises nothing',
  negative.reverts.length === 0,
  `got ${negative.reverts.length}: ${negative.reverts.map((e) => e.path).join(', ')}`,
);
// Without this the case above passes on an empty population, which is the
// vacuity this gate exists to refuse.
check(
  'and it examined a non-empty population',
  negative.differing > 0,
  `differing=${negative.differing}`,
);

// ── 3. A DELIBERATE restore is flagged, and that is CORRECT ────────────────
//
// #734 restored what #725 reverted, so its content reproduces an earlier state
// by construction. The gate is meant to ask for confirmation here, not to be
// silent — which is why the failure message carries an acknowledgement path
// rather than reading as a defect report.
const restore = detectContentReverts({ base: `${THE_RESTORE}^`, head: THE_RESTORE });
check(
  'the #734 restore is flagged too, which is the acknowledgement path working',
  restore.reverts.length > 0,
  `got ${restore.reverts.length}`,
);

// ── 4. The VACUITY FLOOR itself ────────────────────────────────────────────
//
// A ref compared against itself has nothing to examine. The detector must
// return an empty population so the caller can fail on it — if this ever
// returned a clean non-empty result, every case above would be unfalsifiable.
const vacuous = detectContentReverts({ base: THE_REVERT, head: THE_REVERT });
check(
  'a ref against itself yields an EMPTY population, which the runner fails on',
  vacuous.changed.length === 0,
  `changed=${vacuous.changed.length}`,
);

// ── 5. The window is bounded, and the bound is real ────────────────────────
//
// A window of one cannot reach back to the reverted state, so the positive
// control must go quiet. This is what makes limit 1 in the docblock a measured
// statement rather than a disclaimer.
const narrow = detectContentReverts({
  base: BEFORE_THE_REVERT,
  head: THE_REVERT,
  window: 1,
});
check(
  'a window of 1 finds fewer — the bound in the docblock is real, not a disclaimer',
  narrow.reverts.length < positive.reverts.length,
  `window=1 gave ${narrow.reverts.length}, window=${HISTORY_WINDOW} gave ${positive.reverts.length}`,
);

// ── 6. The vacuity floor END TO END, through the real entry point ──────────
//
// Case 4 proves the DETECTOR returns an empty population; it says nothing about
// whether the RUNNER fails on one, and that is the acceptance criterion. The
// two are different functions and only this one is what CI executes — a floor
// that exists in a library nobody calls is the shape of guard this gate is
// built to catch. So spawn the real script the way the workflow does.
const spawned = spawnSync(
  'bun',
  [fileURLToPath(new URL('./validate-no-content-revert.mjs', import.meta.url))],
  {
    encoding: 'utf8',
    env: { ...process.env, REVERT_DETECTOR_BASE: THE_REVERT, REVERT_DETECTOR_HEAD: THE_REVERT },
  },
);
check(
  'the runner EXITS NON-ZERO on an empty population, not just reports one',
  spawned.status === 1,
  `exit=${spawned.status}`,
);
check(
  'and it says the population was empty rather than that nothing was found',
  /population is EMPTY/.test(`${spawned.stderr}${spawned.stdout}`),
  'message did not name the empty population',
);

if (failures > 0) {
  console.error(`\ncontent-revert controls: ${failures} failed.`);
  process.exit(1);
}
console.log('content-revert controls: all passed.');
