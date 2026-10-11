#!/usr/bin/env bun

/**
 * `bun run lint` must not report success while covering less than it claims.
 *
 * ## History, and the shape this exists for
 *
 * Until the Biome adoption the root script was `bun run --filter '*' lint`, and a
 * WILDCARD filter skips a package with no `lint` script SILENTLY. When this file
 * was written that command really linted ONE package of six while exiting 0;
 * #496 moved the three Expo apps into the real set, #1017 added `sdk` and
 * `contracts`, and the answer reached 6 of 8 — `ui` and `shared-types` stayed
 * `echo … && exit 0` placeholders. #607 added the second half of the question:
 * covering a package says nothing about WHICH linter covered it, and an
 * undeclared eslint resolving at a version nothing pinned changes which
 * findings appear — fewer findings exits 0.
 *
 * Biome now lints and format-checks the WHOLE tree from the repo root
 * (`biome check .`, `biome ci .` in CI), so coverage is no longer a sum of
 * per-package scripts. It is decided by three things this gate pins EXACTLY:
 *
 *   1. what the root `lint` script runs — `biome check .` over the whole tree,
 *      plus `lint:expo`;
 *   2. what `biome.jsonc` EXCLUDES — every negated `files.includes` entry is
 *      pinned, so a package (or its source) leaving Biome's view is a diff to
 *      this file, never a quiet config edit; a disabled linter or formatter,
 *      globally or in an override, fails;
 *   3. what `ci.yml` runs in the gating job — `biome ci .` and each Expo app's
 *      `lint:expo` by NAME.
 *
 * The remaining ESLint is the three Expo apps' `lint:expo` — `eslint-plugin-expo`'s
 * env-var rules, which Biome lacks (`eslint.config.apps.mjs`). Its population is
 * pinned and its declaration is checked the #607 way.
 *
 * ## The wildcard hazard did not go away, it moved
 *
 * MEASURED while writing this: `bun run --filter A --filter B --filter C
 * lint:expo` with one of the three lacking the script runs the other two and
 * exits 0 — the multi-filter skips in silence exactly as `--filter '*'` did. A
 * SINGLE named filter with a missing script exits 1. So the root `lint:expo`
 * can lose an app quietly, which is why the per-package sets below are exact,
 * and why `ci.yml` runs each app as its own single-filter step.
 *
 * ## Per-package `lint` scripts
 *
 * Every package keeps a `lint` script (`biome check .`, plus `lint:expo` for the
 * apps) so `bun run --filter <pkg> lint` stays a real command. They are pinned
 * as three EXACT sets keyed on script CONTENT, never on a package name — a
 * package that swaps a real linter for `exit 0` must not keep its category.
 * All eight are real today; the placeholder and no-script sets are EMPTY and
 * kept as categories, because a package arriving in either is the silent loss
 * this file exists to catch.
 *
 * ## Why it reads the filesystem rather than `git ls-files`
 *
 * A guard enumerating via `git ls-files` cannot see an UNTRACKED file, so a
 * brand-new package would be invisible until committed. `readdirSync` over
 * `packages/` has no such blind spot.
 *
 * ## Vacuity
 *
 * Every set is asserted EXACTLY rather than with a floor, so this cannot report
 * clean by finding less. `MINIMUM_PACKAGES` names the cause when the walk finds
 * nothing. The detectors' positive and negative controls run on every
 * invocation: a `RUNS_A_LINTER` that matched nothing would file every package as
 * a placeholder and still print three tidy sets. Biome itself refuses the other
 * vacuity — `biome check` over a tree where every path is ignored exits 1 with
 * "No files were processed" (measured on 2.5.15).
 *
 * Usage:  bun scripts/validate-lint-coverage.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));

/** Overridable so the self-test can point the REAL guard at a scratch tree. */
const repositoryRoot = process.env.LINT_COVERAGE_VALIDATOR_ROOT
  ? resolve(process.env.LINT_COVERAGE_VALIDATOR_ROOT)
  : resolve(here, "..");

/** A script that runs a real linter, decided by CONTENT. */
const RUNS_A_LINTER = /\b(eslint|biome|oxlint)\b/u;

/**
 * A script that runs ESLINT specifically (#607). The lookahead keeps
 * `eslint-plugin-*` out — `\beslint\b` alone matches it, because a hyphen IS a
 * word boundary.
 */
const RUNS_ESLINT = /\beslint\b(?!-)/u;

/** `biome check .` / `biome ci .` over the WHOLE tree — a narrower path is not. */
const RUNS_BIOME_OVER_TREE = /\bbiome\s+(check|ci)\s+\.(?=\s|$|&|;)/u;

/** A named single-filter lint step in the workflow: `--filter <pkg> lint:expo`. */
const FILTERED_EXPO_LINT_RUN = /--filter\s+(\S+)\s+lint:expo\b/gu;

/** A named lint step of the OLD shape; any left must still name a real linter. */
const FILTERED_LINT_RUN = /--filter\s+(\S+)\s+lint(?![:\w-])/gu;

/** The workflow's Biome step, as a `run:` line. */
const CI_BIOME_STEP = /^\s*(?:-\s+)?run:\s*bunx biome ci \.\s*$/mu;

/** The gating job, named rather than inferred (#482's reasoning). */
const GATING_JOB = "lint-and-test";

// ------------------------------------------------------- expected state -----

/** Packages whose `lint` script runs a real linter — all of them. */
const EXPECTED_REAL = [
  "backend", "contracts", "dashboard", "frontend", "pos", "sdk", "shared-types", "ui",
];

/** Packages whose `lint` script is an `exit 0` placeholder. EMPTY since Biome. */
const EXPECTED_PLACEHOLDER = [];

/** Packages with NO `lint` script. EMPTY since #496. */
const EXPECTED_NO_SCRIPT = [];

/** Packages whose `lint:expo` runs ESLint (the Expo env-var rules). */
const EXPECTED_EXPO_ESLINT = ["dashboard", "frontend", "pos"];

/** Workspace packages named by a `--filter <pkg> lint:expo` step in ci.yml. */
const EXPECTED_CI_EXPO_TARGETS = ["@mercaria/dashboard", "@mercaria/frontend", "@mercaria/pos"];

/** The one eslint range every eslint-running package declares (#607). */
const EXPECTED_ESLINT_RANGE = "^9.39.5";

/** The one Biome version: EXACT, root devDependency, and the config's `$schema`. */
const EXPECTED_BIOME_VERSION = "2.5.15";

/**
 * Every negated `files.includes` entry in `biome.jsonc`, EXACTLY. Each is a
 * path Biome neither formats nor lints; the reasons are beside each entry in
 * the config. Adding one here is the record that somebody decided.
 */
const EXPECTED_BIOME_EXCLUSIONS = [
  "!**/*.generated.*",
  "!**/.expo",
  "!**/.next",
  "!**/coverage",
  "!**/dist",
  "!**/drizzle/meta",
  "!**/node_modules",
  "!.github/scripts/reviewed-images.json",
  "!.worktrees",
  "!docs/audits",
  "!packages/contracts/openapi.json",
  "!packages/ui/src/theme/global.css",
];

/** Below this the `packages/` walk is broken; it names the cause. */
const MINIMUM_PACKAGES = 8;

const failures = [];

// ------------------------------------------------------------- controls -----

const LINTER_CONTROL_MUST_MATCH = [
  "biome check .",
  "biome check . && bun run lint:expo",
  "eslint . --max-warnings 0",
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

const ESLINT_CONTROL_MUST_MATCH = ["eslint .", "eslint src scripts build.ts", "eslint . --max-warnings 0"];
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

/**
 * `RUNS_BIOME_OVER_TREE`'s pair. The negative half carries the weight: a root
 * script narrowed to one directory still READS as running Biome, and is the
 * quiet way the whole-tree claim stops being true.
 */
const BIOME_TREE_CONTROL_MUST_MATCH = ["biome check .", "biome check . && bun run lint:expo", "biome ci ."];
const BIOME_TREE_CONTROL_MUST_NOT_MATCH = [
  "biome check packages/backend",
  "biome check ./packages",
  "biome format --write .",
  "eslint .",
];

for (const script of BIOME_TREE_CONTROL_MUST_MATCH) {
  if (!RUNS_BIOME_OVER_TREE.test(script)) {
    failures.push(
      `positive control failed: ${JSON.stringify(script)} did not read as Biome over the whole tree — `
      + "the root-script check would then refuse the real one",
    );
  }
}
for (const script of BIOME_TREE_CONTROL_MUST_NOT_MATCH) {
  if (RUNS_BIOME_OVER_TREE.test(script)) {
    failures.push(
      `negative control failed: ${JSON.stringify(script)} read as Biome over the whole tree — a `
      + "narrowed root script would pass as full coverage",
    );
  }
}

// ------------------------------------------------------- the three sets -----

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
    + "floor — a walk that finds nothing leaves every set empty, and empty sets match empty "
    + "expectations",
  );
}

const sameSet = (found, expected) =>
  found.length === expected.length && found.every((name, index) => name === expected[index]);

if (!sameSet(real, EXPECTED_REAL)) {
  failures.push(
    `packages running a REAL linter are [${real.join(", ")}], expected [${EXPECTED_REAL.join(", ")}]. `
    + "A package leaving this set stopped being linted by its own `lint` script; one joining it has "
    + "to be recorded here.",
  );
}
if (!sameSet(placeholder, EXPECTED_PLACEHOLDER)) {
  failures.push(
    `packages whose lint script is a PLACEHOLDER are [${placeholder.join(", ")}], expected `
    + `[${EXPECTED_PLACEHOLDER.join(", ")}]. A placeholder exits 0 without linting anything.`,
  );
}
if (!sameSet(noScript, EXPECTED_NO_SCRIPT)) {
  failures.push(
    `packages with NO lint script are [${noScript.join(", ")}], expected `
    + `[${EXPECTED_NO_SCRIPT.join(", ")}]. \`bun run --filter <pkg> lint\` stops being a command for `
    + "them, and a multi-package filter skips them in silence.",
  );
}

const partitioned = [...real, ...placeholder, ...noScript].sort();
if (!sameSet(partitioned, directories)) {
  failures.push(
    `the three sets cover [${partitioned.join(", ")}] but packages/ holds [${directories.join(", ")}] `
    + "— a package in none of them is one this gate says nothing about",
  );
}

// ------------------------------------------ the Expo ESLint, DECLARED -----

// Derived from the walk, so a fourth package that starts running eslint is
// covered on the day it appears. Read from `lint:expo` (the apps' ESLint) and
// from `lint` (a package that went back to eslint wholesale).
const eslintRunners = directories.filter((directory) => {
  const scripts = manifests.get(directory)?.scripts ?? {};
  return RUNS_ESLINT.test(scripts["lint:expo"] ?? "") || RUNS_ESLINT.test(scripts.lint ?? "");
});
const expoEslint = directories.filter((directory) =>
  RUNS_ESLINT.test(manifests.get(directory)?.scripts?.["lint:expo"] ?? ""));

if (!sameSet(expoEslint, EXPECTED_EXPO_ESLINT)) {
  failures.push(
    `packages whose \`lint:expo\` runs ESLint are [${expoEslint.join(", ")}], expected `
    + `[${EXPECTED_EXPO_ESLINT.join(", ")}]. That ESLint carries eslint-plugin-expo's env-var rules, `
    + "which Biome lacks; an app leaving this set ships a destructured or computed "
    + "`process.env.EXPO_PUBLIC_*` read that Metro inlines as `undefined`.",
  );
}
for (const directory of EXPECTED_EXPO_ESLINT) {
  const lint = manifests.get(directory)?.scripts?.lint ?? "";
  if (manifests.has(directory) && !lint.includes("lint:expo")) {
    failures.push(
      `packages/${directory}'s \`lint\` script (${JSON.stringify(lint)}) does not run \`lint:expo\`, so `
      + "`bun run --filter <app> lint` stops covering the Expo env-var rules",
    );
  }
}

const declaredRanges = new Map();
for (const directory of eslintRunners) {
  const manifest = manifests.get(directory);
  const declared = manifest.devDependencies?.eslint ?? manifest.dependencies?.eslint;
  if (declared === undefined) {
    failures.push(
      `packages/${directory} runs eslint in its lint scripts but DECLARES no eslint. It resolves as `
      + "an auto-installed peer, so nothing in any manifest pins it. Add "
      + `"eslint": "${EXPECTED_ESLINT_RANGE}" to its devDependencies.`,
    );
    continue;
  }
  declaredRanges.set(directory, declared);
  if (declared !== EXPECTED_ESLINT_RANGE) {
    failures.push(
      `packages/${directory} declares eslint ${declared}, expected ${EXPECTED_ESLINT_RANGE}. Every `
      + "eslint-running package states ONE range, because divergent ranges resolve to two linters.",
    );
  }
  const js = manifest.devDependencies?.["@eslint/js"] ?? manifest.dependencies?.["@eslint/js"];
  if (js !== undefined && js !== declared) {
    failures.push(
      `packages/${directory} declares @eslint/js ${js} beside eslint ${declared}. eslint depends on `
      + "@eslint/js at an EXACT version, so these must state the same range.",
    );
  }
}

// ------------------------------------------------- Biome is DECLARED -------

let rootManifest = null;
try {
  rootManifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
} catch (error) {
  failures.push(`the root package.json could not be read as JSON (${error.message})`);
}

const rootBiome = rootManifest?.devDependencies?.["@biomejs/biome"];
if (rootManifest !== null && rootBiome !== EXPECTED_BIOME_VERSION) {
  failures.push(
    `the root package.json declares @biomejs/biome ${rootBiome ?? "nowhere"}, expected EXACTLY `
    + `${EXPECTED_BIOME_VERSION}. A range lets the lockfile move the formatter, and a formatter that `
    + "moves reformats the tree on somebody else's pull request.",
  );
}
for (const directory of directories) {
  const manifest = manifests.get(directory);
  const own = manifest?.devDependencies?.["@biomejs/biome"] ?? manifest?.dependencies?.["@biomejs/biome"];
  if (own !== undefined) {
    failures.push(
      `packages/${directory} declares its own @biomejs/biome ${own}. Biome is pinned ONCE, at the root, `
      + "or two packages format the same tree with two versions.",
    );
  }
}

// ------------------------------------------------- the Biome config --------

const biomeConfigPath = join(repositoryRoot, "biome.jsonc");
let biomeConfig = null;
try {
  const text = readFileSync(biomeConfigPath, "utf8");
  // TypeScript's own JSONC reader: comments and trailing commas, no hand-rolled
  // parser guessing at syntax it does not recognise.
  const parsed = ts.parseConfigFileTextToJson(biomeConfigPath, text);
  if (parsed.error) {
    failures.push(`biome.jsonc could not be parsed (${ts.flattenDiagnosticMessageText(parsed.error.messageText, " ")})`);
  } else {
    biomeConfig = parsed.config;
  }
} catch (error) {
  failures.push(`biome.jsonc could not be read (${error.message})`);
}

if (biomeConfig !== null) {
  const schema = String(biomeConfig.$schema ?? "");
  if (!schema.includes(`/${EXPECTED_BIOME_VERSION}/`)) {
    failures.push(
      `biome.jsonc's $schema is ${JSON.stringify(schema)}, which does not name ${EXPECTED_BIOME_VERSION} — `
      + "the config and the pinned binary disagree about which Biome this is",
    );
  }
  const includes = biomeConfig.files?.includes;
  if (!Array.isArray(includes) || includes[0] !== "**") {
    failures.push(
      "biome.jsonc's `files.includes` does not start with \"**\" — Biome would no longer see the whole "
      + "tree, and every exclusion below would be measured against a narrower base",
    );
  } else {
    const exclusions = includes.filter((entry) => typeof entry === "string" && entry.startsWith("!")).sort();
    if (!sameSet(exclusions, EXPECTED_BIOME_EXCLUSIONS)) {
      failures.push(
        `biome.jsonc excludes [${exclusions.join(", ")}], expected [${EXPECTED_BIOME_EXCLUSIONS.join(", ")}]. `
        + "An exclusion is a path Biome neither formats nor lints; one added in the config alone is "
        + "coverage leaving in a diff nobody reads as such.",
      );
    }
  }
  if (biomeConfig.linter?.enabled === false) {
    failures.push("biome.jsonc sets `linter.enabled: false` — `biome check .` would lint nothing");
  }
  if (biomeConfig.formatter?.enabled === false) {
    failures.push("biome.jsonc sets `formatter.enabled: false` — `biome ci .` would check no formatting");
  }
  for (const [index, override] of (biomeConfig.overrides ?? []).entries()) {
    for (const tool of ["linter", "formatter"]) {
      if (override?.[tool]?.enabled === false) {
        failures.push(
          `biome.jsonc override #${index} (${JSON.stringify(override.includes ?? [])}) sets `
          + `\`${tool}.enabled: false\` — an exclusion spelled so the list above cannot see it`,
        );
      }
    }
  }
}

// ------------------------------------------------------ the root script -----

const rootLint = rootManifest?.scripts?.lint;
if (rootManifest !== null && rootLint === undefined) {
  failures.push(
    "the root package.json has no `lint` script — this gate exists to describe what that command "
    + "covers, so its removal is a change somebody has to make deliberately",
  );
} else if (rootLint !== undefined) {
  if (!RUNS_BIOME_OVER_TREE.test(rootLint)) {
    failures.push(
      `the root lint script is ${JSON.stringify(rootLint)}, which does not run \`biome check .\` over `
      + "the whole tree — that one invocation IS the coverage of all eight packages",
    );
  }
  if (!rootLint.includes("lint:expo")) {
    failures.push(
      `the root lint script is ${JSON.stringify(rootLint)}, which no longer runs \`lint:expo\` — the `
      + "Expo env-var rules would leave `bun run lint`",
    );
  }
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
    `.github/workflows/ci.yml no longer declares the \`${GATING_JOB}\` job — the lint steps below are `
    + "only gated if the job carrying them is the one a merge waits on",
  );
}
if (workflow.length > 0 && !CI_BIOME_STEP.test(workflow)) {
  failures.push(
    "no `run: bunx biome ci .` step was found in ci.yml — Biome's format and lint verdict over the "
    + "whole tree is what a merge waits on, and without it nothing enforces either",
  );
}

const ciExpoTargets = [...workflow.matchAll(FILTERED_EXPO_LINT_RUN)].map((match) => match[1]).sort();
if (!sameSet(ciExpoTargets, EXPECTED_CI_EXPO_TARGETS)) {
  failures.push(
    `ci.yml runs lint:expo for [${ciExpoTargets.join(", ")}], expected `
    + `[${EXPECTED_CI_EXPO_TARGETS.join(", ")}]. One single-filter step per app, because a `
    + "multi-filter skips a package missing the script in silence.",
  );
}

const expoNames = new Set(expoEslint.map((directory) => manifests.get(directory).name));
for (const target of ciExpoTargets) {
  if (!expoNames.has(target)) {
    failures.push(
      `ci.yml runs \`--filter ${target} lint:expo\` but that package has no \`lint:expo\` running `
      + "eslint. A NAMED filter with a missing script exits 1, so this breaks the build.",
    );
  }
}

// Keyed on the manifest NAME: `packages/sdk` publishes as `@mercaria.co/sdk`.
const realNames = new Set(real.map((directory) => manifests.get(directory).name));
const ciLintTargets = [...workflow.matchAll(FILTERED_LINT_RUN)].map((match) => match[1]).sort();
for (const target of ciLintTargets) {
  if (!realNames.has(target)) {
    failures.push(
      `ci.yml runs \`--filter ${target} lint\` but that package has no script running a real `
      + "linter. A NAMED filter with a missing script exits 1, so this breaks the build.",
    );
  }
}

// ------------------------------------------------------------------ verdict --

if (failures.length > 0) {
  console.error("lint coverage guard failed:\n");
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    "  This gate pins what `bun run lint` and CI cover. If something genuinely moved, update the\n"
    + "  expected set in this file in the same change — that edit is the record that somebody decided.\n",
  );
  process.exit(1);
}

console.log(
  `lint coverage guard passed — ${directories.length} workspace packages, all covered by `
  + "`biome check .` from the root (format and lint), with "
  + `${EXPECTED_BIOME_EXCLUSIONS.length} pinned exclusions in biome.jsonc and @biomejs/biome pinned `
  + `EXACTLY at ${EXPECTED_BIOME_VERSION}. ${real.length} packages have a real \`lint\` script `
  + `(${real.join(", ")}), ${placeholder.length} placeholders, ${noScript.length} with none. `
  + `${expoEslint.length} Expo apps run eslint-plugin-expo through \`lint:expo\` (${expoEslint.join(", ")}), `
  + `all ${declaredRanges.size} declaring eslint ${EXPECTED_ESLINT_RANGE}. ci.yml runs \`biome ci .\` and `
  + `lint:expo for ${ciExpoTargets.join(", ")} in \`${GATING_JOB}\`. `
  + `${LINTER_CONTROL_MUST_MATCH.length + ESLINT_CONTROL_MUST_MATCH.length + BIOME_TREE_CONTROL_MUST_MATCH.length} `
  + "positive and "
  + `${LINTER_CONTROL_MUST_NOT_MATCH.length + ESLINT_CONTROL_MUST_NOT_MATCH.length + BIOME_TREE_CONTROL_MUST_NOT_MATCH.length} `
  + "negative detector controls run.",
);
