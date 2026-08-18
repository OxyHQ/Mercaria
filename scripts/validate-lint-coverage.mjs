#!/usr/bin/env bun

/**
 * `bun run lint` must not report success while covering a sixth of the repo.
 *
 * ## What is actually wrong today
 *
 * The root script is `lint: bun run --filter '*' lint`. Three of the six
 * workspace packages — `frontend`, `dashboard`, `pos` — define no `lint` script
 * at all, and a WILDCARD filter skips a package with no such script SILENTLY.
 * Two more (`ui`, `shared-types`) define `echo "No lint configured…" && exit 0`.
 * So the command exits 0 having really linted ONE package, and nothing in the
 * command, the workflow or `package.json` says so.
 *
 * The asymmetry is the part worth remembering, because it is why this hole is
 * invisible while the same shape one command over is not:
 *
 *   * a NAMED filter with a missing script exits 1 — `bun run --filter
 *     @mercaria/frontend lint` prints `error: No packages matched the filter`,
 *     byte-identical to naming a package that does not exist. Loud.
 *   * the WILDCARD skips it in silence and exits 0. Quiet.
 *
 * `ci.yml` is honest: it only ever claims `--filter @mercaria/backend lint`, and
 * that step really does lint the backend. **The root script is the artefact that
 * lies, and `ci.yml` is honest.** So a gate written against the workflow alone
 * would pass while the developer command went on covering a sixth of the repo,
 * which is why this one reads the root script FIRST and the workflow second.
 *
 * ## What this gate does and deliberately does NOT do
 *
 * It does NOT demand a `lint` script from the three Expo apps. Whether they
 * should be linted is a real question with unknown fallout — three unlinted app
 * packages will have accumulated violations, and discovering how many belongs in
 * its own PR rather than inside a gate. What is wrong TODAY is that the coverage
 * is invisible, not that it is small.
 *
 * So this pins the CURRENT state truthfully, in three EXACT sets, and any
 * movement in any of them fails the build and forces somebody to decide. That
 * converts an invisible hole into a recorded one, which is the fix available
 * today. `client-test-runners.test.ts` (#482) pins the `test` direction the same
 * way, with `['shared-types','ui']` as an exact set.
 *
 * ## Why the categories are keyed on script CONTENT, never on a package name
 *
 * A placeholder is a placeholder because of what it RUNS, not because of what it
 * is called. Keying on the name means a package that quietly swaps a real linter
 * for `exit 0` keeps its category, which is the one change this gate exists to
 * catch. #482 made the same choice for `test` (`/\bvitest\b/` against
 * `scripts.test`) and it is the reason its placeholder set means anything.
 *
 * ## Why it reads the filesystem rather than `git ls-files`
 *
 * A guard enumerating via `git ls-files` cannot see an UNTRACKED file, so the
 * first run against a package somebody just created is vacuous and green — and
 * a brand-new package with no linter is exactly the case this should catch on
 * the day it appears, not on the day it is committed. `readdirSync` over
 * `packages/` has no such blind spot.
 *
 * ## Vacuity
 *
 * Every set is asserted EXACTLY rather than with a floor, so this cannot report
 * clean by finding less — and MEASURED, that is what catches a broken discovery:
 * with the floor below disabled, a tree containing no packages at all still
 * exits 1, because an empty walk mismatches three NON-empty expectations.
 *
 * So `MINIMUM_PACKAGES` is deliberately not load-bearing for the verdict, and
 * saying otherwise would be the more comfortable claim. It earns its place for
 * two smaller reasons: it names the CAUSE ("the walk found nothing") where the
 * sets can only report the symptom ("backend is not linted"), which is the
 * difference between one confusing failure and three; and it is the one check
 * here that survives somebody relaxing an expected set during a refactor.
 *
 * The detector's positive and negative controls are the ones that carry real
 * weight, and they run on every invocation: a `RUNS_A_LINTER` that matched
 * nothing would file every package as a placeholder and still print three tidy
 * sets. Mutating it to match nothing turns this guard red naming that control.
 *
 * Usage:  bun scripts/validate-lint-coverage.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Overridable so the self-test can point the REAL guard at a scratch tree. */
const repositoryRoot = process.env.LINT_COVERAGE_VALIDATOR_ROOT
  ? resolve(process.env.LINT_COVERAGE_VALIDATOR_ROOT)
  : resolve(here, "..");

/**
 * A script that runs a real linter, decided by CONTENT.
 *
 * `biome` and `oxlint` are here beside `eslint` not because anything uses them
 * but because the failure they would cause is silent: a package migrating to one
 * would be filed as a placeholder, and this gate would report the migration as a
 * package that STOPPED linting.
 */
const RUNS_A_LINTER = /\b(eslint|biome|oxlint)\b/u;

/**
 * A script that runs ESLINT specifically (#607).
 *
 * Narrower than `RUNS_A_LINTER` on purpose: only eslint's declaration is in
 * question here, and a package that migrated to `biome` must not be asked to
 * declare a linter it does not run. The lookahead is what keeps
 * `eslint-config-check` and friends out — `\beslint\b` alone matches
 * `eslint-plugin-react`, because a hyphen IS a word boundary.
 */
const RUNS_ESLINT = /\beslint\b(?!-)/u;

/** The wildcard spelling whose silent skip is the whole reason for this file. */
const WILDCARD_FILTER = "--filter '*'";

/** A named lint step in the workflow: `bun run --filter <pkg> lint`. */
const FILTERED_LINT_RUN = /--filter\s+(\S+)\s+lint\b/gu;

/**
 * The gating job. Named rather than inferred, #482's reasoning: a step is only
 * gated if the JOB carrying it is the one a merge waits on, and a step quietly
 * moved into a job nothing requires would still satisfy "some step runs it".
 */
const GATING_JOB = "lint-and-test";

// ------------------------------------------------------- expected state -----

/** Packages whose `lint` script runs a real linter. */
const EXPECTED_REAL = ["backend", "dashboard", "frontend", "pos"];

/** Packages whose `lint` script is an `exit 0` placeholder. */
const EXPECTED_PLACEHOLDER = ["shared-types", "ui"];

/**
 * Packages with NO `lint` script at all — the category that has no analogue on
 * the `test` side, where all six declare something. A package here is skipped in
 * silence by the root wildcard.
 *
 * EMPTY since #496, and deliberately kept as a category rather than deleted:
 * the set being empty is the decision, and a package arriving here later is
 * exactly the silent loss this file exists to catch. The three Expo apps that
 * used to sit here were measured at 0 errors and 13 warnings between them — the
 * cost of linting them was not a wall, so there was nothing to ratchet.
 */
const EXPECTED_NO_SCRIPT = [];

/** Workspace packages named by a `--filter <pkg> lint` step in the workflow. */
const EXPECTED_CI_LINT_TARGETS = [
  "@mercaria/backend",
  "@mercaria/dashboard",
  "@mercaria/frontend",
  "@mercaria/pos",
];

/**
 * The eslint range every eslint-running package declares (#607).
 *
 * ONE range across all of them, because divergent ranges are how a workspace
 * ends up resolving two linters and linting half its packages with each. The
 * value is here so the gate can say which one drifted rather than only that they
 * disagree.
 *
 * `@eslint/js` must match it. That is not tidiness: eslint depends on its own
 * `@eslint/js` at an EXACT version, so a repo declaring a different range gets
 * TWO copies and spreads `js.configs.recommended` from one while running the
 * core of the other. Measured on `main` before #607 — `@eslint/js` 9.39.5
 * hoisted, 9.39.4 nested under an eslint nobody declared — the two halves of
 * the linter's own ruleset on different versions by accident.
 */
const EXPECTED_ESLINT_RANGE = "^9.39.5";

/** Packages that must carry it — DERIVED from the walk, never a hand list. */
const MINIMUM_ESLINT_PACKAGES = 4;

/**
 * Below this the `packages/` walk is broken. See the docblock: this does NOT
 * decide the verdict — the exact sets already refuse an empty walk, measured —
 * it names the cause instead of leaving three set mismatches to be read as three
 * unlinted packages.
 */
const MINIMUM_PACKAGES = 6;

const failures = [];

// ------------------------------------------------------------- controls -----

/**
 * The detector's own controls, run on every invocation.
 *
 * The negative half is the one that matters: without it, a `RUNS_A_LINTER` that
 * had decayed into something matching everything would file `ui`'s `echo … &&
 * exit 0` as a real linter and report a repo in better shape than it is.
 */
const LINTER_CONTROL_MUST_MATCH = [
  "eslint src scripts build.ts",
  "eslint . --max-warnings 0",
  "biome check .",
];
const LINTER_CONTROL_MUST_NOT_MATCH = [
  'echo "No lint configured for ui" && exit 0',
  'echo "No lint configured for shared-types" && exit 0',
  "tsc --noEmit",
  "echo linting",
];

for (const script of LINTER_CONTROL_MUST_MATCH) {
  if (!RUNS_A_LINTER.test(script)) {
    failures.push(
      `positive control failed: ${JSON.stringify(script)} did not read as running a linter — the `
      + "detector is broken, and a broken one files every package as a placeholder while still "
      + "printing three tidy sets",
    );
  }
}
for (const script of LINTER_CONTROL_MUST_NOT_MATCH) {
  if (RUNS_A_LINTER.test(script)) {
    failures.push(
      `negative control failed: ${JSON.stringify(script)} read as running a linter — a placeholder `
      + "would then be counted as real coverage, which is the direction that overstates the repo",
    );
  }
}

/**
 * `RUNS_ESLINT`'s own pair (#607).
 *
 * Its negative half carries the weight, in BOTH directions a wrong answer goes:
 * a detector matching `biome check .` would demand a package declare a linter it
 * does not run, and one matching a bare `eslint-plugin-*` mention would file a
 * package as an eslint runner on the strength of a plugin name. Either way the
 * derived population stops describing who actually runs eslint — and it is the
 * population that decides what the declaration checks examine.
 */
const ESLINT_CONTROL_MUST_MATCH = [
  "eslint .",
  "eslint src scripts build.ts",
  "eslint . --max-warnings 0",
];
const ESLINT_CONTROL_MUST_NOT_MATCH = [
  "biome check .",
  "oxlint",
  'echo "No lint configured for ui" && exit 0',
  // A plugin name is not a linter invocation.
  "eslint-config-check",
];

for (const script of ESLINT_CONTROL_MUST_MATCH) {
  if (!RUNS_ESLINT.test(script)) {
    failures.push(
      `positive control failed: ${JSON.stringify(script)} did not read as running eslint — the `
      + "derived population would then be empty, and every declaration check vacuously true",
    );
  }
}
for (const script of ESLINT_CONTROL_MUST_NOT_MATCH) {
  if (RUNS_ESLINT.test(script)) {
    failures.push(
      `negative control failed: ${JSON.stringify(script)} read as running eslint — a package would `
      + "be asked to declare a linter it does not run",
    );
  }
}

// ------------------------------------------------------- the three sets -----

/** Every workspace package directory, from the FILESYSTEM. */
function packageDirectories() {
  const root = join(repositoryRoot, "packages");
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function manifestOf(directory) {
  const path = join(repositoryRoot, "packages", directory, "package.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`packages/${directory}/package.json could not be read as JSON (${error.message})`);
    return null;
  }
}

const directories = packageDirectories();
const real = [];
const placeholder = [];
const noScript = [];

/** Kept so the declaration check below reads the SAME manifests this walk did. */
const manifests = new Map();

for (const directory of directories) {
  const manifest = manifestOf(directory);
  if (manifest === null) continue;
  manifests.set(directory, manifest);
  const script = manifest.scripts?.lint;
  if (script === undefined) noScript.push(directory);
  else if (RUNS_A_LINTER.test(script)) real.push(directory);
  else placeholder.push(directory);
}

if (directories.length < MINIMUM_PACKAGES) {
  failures.push(
    `${directories.length} workspace packages found under packages/, below the ${MINIMUM_PACKAGES} `
    + "floor — a walk that finds nothing leaves all three sets empty, and three empty sets match "
    + "three empty expectations",
  );
}

const sameSet = (found, expected) =>
  found.length === expected.length && found.every((name, index) => name === expected[index]);

if (!sameSet(real, EXPECTED_REAL)) {
  failures.push(
    `packages running a REAL linter are [${real.join(", ")}], expected [${EXPECTED_REAL.join(", ")}]. `
    + "A package leaving this set stopped being linted; one joining it is good news that still has "
    + "to be recorded here, because this list is what says how much `bun run lint` covers.",
  );
}
if (!sameSet(placeholder, EXPECTED_PLACEHOLDER)) {
  failures.push(
    `packages whose lint script is a PLACEHOLDER are [${placeholder.join(", ")}], expected `
    + `[${EXPECTED_PLACEHOLDER.join(", ")}]. A placeholder exits 0 without linting anything, so a `
    + "package arriving here from the real set is a silent loss of coverage.",
  );
}
if (!sameSet(noScript, EXPECTED_NO_SCRIPT)) {
  failures.push(
    `packages with NO lint script are [${noScript.join(", ")}], expected `
    + `[${EXPECTED_NO_SCRIPT.join(", ")}]. The root wildcard skips these in SILENCE and still exits `
    + "0, so a package arriving here disappears from `bun run lint` with no output at all.",
  );
}

// Every package lands in exactly one set. Without this a package could be
// dropped from the walk and still satisfy all three comparisons above, since
// each only sees its own members.
const partitioned = [...real, ...placeholder, ...noScript].sort();
if (!sameSet(partitioned, directories)) {
  failures.push(
    `the three sets cover [${partitioned.join(", ")}] but packages/ holds [${directories.join(", ")}] `
    + "— a package in none of them is one this gate says nothing about",
  );
}

// ------------------------------------------------- the linter is DECLARED ---

// #607. `bun run lint` covering a package says nothing about WHICH linter it
// covered it with, and on `main` the answer was one no manifest named: eslint
// arrived purely as an auto-installed peer, at a version nothing pinned, under
// peer ranges spanning three majors.
//
// The failure this prevents is not a red build. A resolution that moves eslint
// changes which findings appear, and FEWER findings is a green build — the shape
// this repo gates against everywhere else, arriving through the lockfile with no
// manifest diff to review.
//
// The population is DERIVED from the walk above, so a fifth package that starts
// running eslint is covered on the day it appears rather than when somebody
// remembers to add it here.
const eslintRunners = real.filter((directory) => RUNS_ESLINT.test(manifests.get(directory).scripts.lint));

if (eslintRunners.length < MINIMUM_ESLINT_PACKAGES) {
  failures.push(
    `${eslintRunners.length} package(s) run eslint, below the ${MINIMUM_ESLINT_PACKAGES} floor — `
    + "a derivation that finds none makes every declaration check below vacuously true, which is "
    + "exactly the silence this gate exists to break",
  );
}

const declaredRanges = new Map();
for (const directory of eslintRunners) {
  const manifest = manifests.get(directory);
  const declared = manifest.devDependencies?.eslint ?? manifest.dependencies?.eslint;
  if (declared === undefined) {
    failures.push(
      `packages/${directory} runs eslint in its lint script but DECLARES no eslint. It resolves as `
      + "an auto-installed peer, so nothing in any manifest pins it and the peer ranges in play "
      + `span three majors. Add "eslint": "${EXPECTED_ESLINT_RANGE}" to its devDependencies.`,
    );
    continue;
  }
  declaredRanges.set(directory, declared);
  if (declared !== EXPECTED_ESLINT_RANGE) {
    failures.push(
      `packages/${directory} declares eslint ${declared}, expected ${EXPECTED_ESLINT_RANGE}. Every `
      + "eslint-running package states ONE range, because divergent ranges resolve to two linters "
      + "and lint half the workspace with each.",
    );
  }
  // The skew #607 measured: eslint pins its own `@eslint/js` EXACTLY, so a
  // different range here is a second copy and a ruleset running under a core it
  // does not match.
  const js = manifest.devDependencies?.["@eslint/js"] ?? manifest.dependencies?.["@eslint/js"];
  if (js !== undefined && js !== declared) {
    failures.push(
      `packages/${directory} declares @eslint/js ${js} beside eslint ${declared}. eslint depends on `
      + "@eslint/js at an EXACT version, so these must state the same range or the repo carries two "
      + "copies and spreads `js.configs.recommended` from one while running the core of the other.",
    );
  }
}

// ------------------------------------------------------ the root script -----

let rootManifest = null;
try {
  rootManifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
} catch (error) {
  failures.push(`the root package.json could not be read as JSON (${error.message})`);
}

const rootLint = rootManifest?.scripts?.lint;
if (rootLint === undefined) {
  failures.push(
    "the root package.json has no `lint` script — this gate exists to describe what that command "
    + "covers, so its removal is a change somebody has to make deliberately",
  );
} else if (!rootLint.includes(WILDCARD_FILTER)) {
  failures.push(
    `the root lint script is ${JSON.stringify(rootLint)}, which no longer contains `
    + `${JSON.stringify(WILDCARD_FILTER)}. The silent-skip behaviour this gate describes is a `
    + "property of the WILDCARD; if the script now names packages explicitly, a missing script "
    + "exits 1 instead and the three sets below stop meaning what they say.",
  );
}

// ------------------------------------------------------------ the workflow --

const workflowPath = join(repositoryRoot, ".github", "workflows", "ci.yml");
let workflow = "";
try {
  workflow = readFileSync(workflowPath, "utf8");
} catch (error) {
  failures.push(`.github/workflows/ci.yml could not be read (${error.message})`);
}

if (workflow.length > 0 && !workflow.includes(`${GATING_JOB}:`)) {
  failures.push(
    `.github/workflows/ci.yml no longer declares the \`${GATING_JOB}\` job — the lint step below is `
    + "only gated if the job carrying it is the one a merge waits on",
  );
}

const ciLintTargets = [...workflow.matchAll(FILTERED_LINT_RUN)].map((match) => match[1]).sort();
if (workflow.length > 0 && ciLintTargets.length === 0) {
  failures.push(
    "no `--filter <pkg> lint` step was found in ci.yml at all. Either every lint step was removed, "
    + "or this matcher stopped matching — and a matcher that finds nothing reports a workflow with "
    + "no lint steps as one whose lint steps are all correct.",
  );
}
if (!sameSet(ciLintTargets, EXPECTED_CI_LINT_TARGETS)) {
  failures.push(
    `ci.yml runs lint for [${ciLintTargets.join(", ")}], expected `
    + `[${EXPECTED_CI_LINT_TARGETS.join(", ")}]. CI is the honest artefact here; a change to what it `
    + "claims is a change to what is actually enforced on a merge.",
  );
}

// Every package CI names must actually have a linter to run, or the step is a
// named filter that exits 1 — loud, but only once somebody pushes.
const realNames = new Set(real.map((directory) => `@mercaria/${directory}`));
for (const target of ciLintTargets) {
  if (!realNames.has(target)) {
    failures.push(
      `ci.yml runs \`--filter ${target} lint\` but that package has no script running a real `
      + "linter. A NAMED filter with a missing script exits 1, so this breaks the build rather "
      + "than passing quietly — the wildcard is the one that skips in silence.",
    );
  }
}

// ------------------------------------------------------------------ verdict --

if (failures.length > 0) {
  console.error("lint coverage guard failed:\n");
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    "  This gate pins what `bun run lint` covers; it does not demand that any package acquire a\n"
    + "  linter. If a category genuinely moved, update the expected set in this file in the same\n"
    + "  change — that edit is the record that somebody decided.\n",
  );
  process.exit(1);
}

console.log(
  `lint coverage guard passed — ${directories.length} workspace packages: `
  + `${real.length} running a real linter (${real.join(", ")}), `
  + `${placeholder.length} exit-0 placeholders (${placeholder.join(", ")}), `
  + `${noScript.length} with no lint script (${noScript.join(", ")}). `
  + `\`bun run lint\` is \`--filter '*'\`, which SKIPS the last group in SILENCE and exits 0, so it `
  + `reports success while really linting ${real.length} of ${directories.length} packages. `
  + "A NAMED filter with a missing script exits 1 instead, indistinguishably from naming a package "
  + `that does not exist. ci.yml runs lint for ${ciLintTargets.join(", ")} in \`${GATING_JOB}\`. `
  + `${eslintRunners.length} of them run eslint (${eslintRunners.join(", ")}) and all `
  + `${declaredRanges.size} DECLARE it at ${EXPECTED_ESLINT_RANGE}, matching their @eslint/js — `
  + "before #607 none declared it at all and it resolved as an auto-installed peer. "
  + `${LINTER_CONTROL_MUST_MATCH.length + ESLINT_CONTROL_MUST_MATCH.length} positive and `
  + `${LINTER_CONTROL_MUST_NOT_MATCH.length + ESLINT_CONTROL_MUST_NOT_MATCH.length} `
  + "negative detector controls run.",
);
