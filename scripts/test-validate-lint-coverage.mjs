#!/usr/bin/env bun

/**
 * Mutation-tests `validate-lint-coverage.mjs`.
 *
 * That guard's whole subject is a set of things that are ABSENT — three packages
 * with no `lint` script, two whose script lints nothing — so it fails in the
 * quiet direction by construction: a `packages/` walk that returns nothing
 * satisfies all three expected sets at once, a `RUNS_A_LINTER` that matched
 * nothing files every package as a placeholder, and a workflow matcher that
 * matched nothing reports a CI file with no lint steps as one whose lint steps
 * are all correct. Each case below breaks exactly one of those and requires the
 * guard to fail with words naming the right one.
 *
 * The must-PASS cases matter as much: this gate deliberately does NOT demand a
 * linter from anybody, so it must stay silent about every change that is not a
 * change of coverage.
 *
 * Fixtures are real directory trees and the REAL guard is spawned against each
 * through `LINT_COVERAGE_VALIDATOR_ROOT`, rather than this file re-implementing
 * the guard's logic and then measuring the re-implementation.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-lint-coverage.mjs");

/** Run the REAL guard against a scratch tree. */
async function runAgainst(files) {
  const root = await mkdtemp(join(tmpdir(), "lint-coverage-validator-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      if (contents === null) continue;
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(
        full,
        typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`,
      );
    }
    const proc = Bun.spawnSync({
      cmd: ["bun", validator],
      cwd: repositoryRoot,
      env: { ...process.env, LINT_COVERAGE_VALIDATOR_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: proc.exitCode, output: `${proc.stdout.toString()}${proc.stderr.toString()}` };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A workflow carrying the gating job and the one real lint step. */
const CI_YML = "name: CI\n"
  + "on: [push, pull_request]\n"
  + "jobs:\n"
  + "  lint-and-test:\n"
  + "    runs-on: ubuntu-latest\n"
  + "    steps:\n"
  + "      - name: Lint the backend\n"
  + "        run: bun run --filter @mercaria/backend lint\n"
  + "      - name: Test the backend\n"
  + "        run: bun run --filter @mercaria/backend test\n";

/**
 * The repository as it stands: one real linter, two placeholders, three packages
 * with no `lint` script at all.
 *
 * Every package also carries an unrelated script or two, so a case can change one
 * without touching `lint` and prove the gate stays silent.
 */
function tree(extra = {}) {
  return {
    "package.json": { name: "mercaria", scripts: { lint: "bun run --filter '*' lint" } },
    "packages/backend/package.json": {
      name: "@mercaria/backend",
      scripts: { lint: "eslint src scripts build.ts", test: "vitest run" },
    },
    "packages/ui/package.json": {
      name: "@mercaria/ui",
      scripts: { lint: 'echo "No lint configured for ui" && exit 0', typecheck: "tsc --noEmit" },
    },
    "packages/shared-types/package.json": {
      name: "@mercaria/shared-types",
      scripts: { lint: 'echo "No lint configured for shared-types" && exit 0', build: "tsc" },
    },
    "packages/frontend/package.json": {
      name: "@mercaria/frontend",
      scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
    },
    "packages/dashboard/package.json": {
      name: "@mercaria/dashboard",
      scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
    },
    "packages/pos/package.json": {
      name: "@mercaria/pos",
      scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
    },
    ".github/workflows/ci.yml": CI_YML,
    ...extra,
  };
}

/** The same tree with one package's manifest replaced wholesale. */
function withPackage(directory, manifest, extra = {}) {
  return tree({ [`packages/${directory}/package.json`]: manifest, ...extra });
}

const cases = [
  {
    name: "the repository as it stands passes",
    files: tree(),
    expectExit: 0,
    expectOutput: "lint coverage guard passed",
  },

  // ------------------------------------------- coverage moving, both ways ---
  // The two directions the brief asked for: a package GAINING a script and a
  // package LOSING one. Both are changes of coverage and both must fail.

  {
    name: "a package GAINING a lint script fails",
    files: withPackage("frontend", {
      name: "@mercaria/frontend",
      scripts: { lint: "eslint .", test: "vitest run" },
    }),
    expectExit: 1,
    expectOutput: "packages with NO lint script are [dashboard, pos], expected "
      + "[dashboard, frontend, pos]",
  },
  {
    name: "a package LOSING its lint script fails",
    files: withPackage("backend", { name: "@mercaria/backend", scripts: { test: "vitest run" } }),
    expectExit: 1,
    expectOutput: "packages running a REAL linter are [], expected [backend]",
  },
  {
    // The silent one: the script survives, the linting does not. A name-keyed
    // detector would keep calling this package linted.
    name: "a real linter QUIETLY becoming a placeholder fails",
    files: withPackage("backend", {
      name: "@mercaria/backend",
      scripts: { lint: 'echo "skip for now" && exit 0', test: "vitest run" },
    }),
    expectExit: 1,
    expectOutput: "packages running a REAL linter are [], expected [backend]",
  },
  {
    name: "a placeholder becoming a real linter fails, because that is coverage too",
    files: withPackage("ui", { name: "@mercaria/ui", scripts: { lint: "eslint src" } }),
    expectExit: 1,
    expectOutput: "packages whose lint script is a PLACEHOLDER are [shared-types], expected "
      + "[shared-types, ui]",
  },
  {
    // A package that exists on disk and in nobody's git index yet. The guard
    // walks the filesystem precisely so this is caught the day it appears.
    name: "a NEW package with no lint script fails",
    files: tree({
      "packages/kiosk/package.json": { name: "@mercaria/kiosk", scripts: { test: "vitest run" } },
    }),
    expectExit: 1,
    expectOutput: "packages with NO lint script are [dashboard, frontend, kiosk, pos]",
  },
  {
    name: "a non-eslint linter still counts as real coverage",
    files: withPackage("frontend", {
      name: "@mercaria/frontend",
      scripts: { lint: "biome check .", test: "vitest run" },
    }),
    expectExit: 1,
    expectOutput: "packages running a REAL linter are [backend, frontend], expected [backend]",
  },

  // ------------------------------------------------------- the root script ---

  {
    name: "the root script dropping the wildcard fails",
    files: tree({
      "package.json": {
        name: "mercaria",
        scripts: { lint: "bun run --filter @mercaria/backend lint" },
      },
    }),
    expectExit: 1,
    expectOutput: "no longer contains \"--filter '*'\"",
  },
  {
    name: "the root script disappearing fails",
    files: tree({ "package.json": { name: "mercaria", scripts: { build: "tsc" } } }),
    expectExit: 1,
    expectOutput: "the root package.json has no `lint` script",
  },

  // ----------------------------------------------------------- the workflow ---

  {
    name: "CI losing its lint step fails",
    files: tree({
      ".github/workflows/ci.yml": CI_YML.replace(
        "      - name: Lint the backend\n        run: bun run --filter @mercaria/backend lint\n",
        "",
      ),
    }),
    expectExit: 1,
    expectOutput: "no `--filter <pkg> lint` step was found in ci.yml at all",
  },
  {
    name: "CI linting a package that has no linter fails",
    files: tree({
      ".github/workflows/ci.yml": `${CI_YML}      - run: bun run --filter @mercaria/pos lint\n`,
    }),
    expectExit: 1,
    expectOutput: "ci.yml runs `--filter @mercaria/pos lint` but that package has no script running "
      + "a real linter",
  },
  {
    name: "the gating job being renamed fails",
    files: tree({ ".github/workflows/ci.yml": CI_YML.replace("lint-and-test:", "checks:") }),
    expectExit: 1,
    expectOutput: "no longer declares the `lint-and-test` job",
  },

  // ------------------------------------------------------- the vacuity floor ---

  {
    // MEASURED, by disabling the floor and re-running this case: the tree still
    // exits 1 without it, because an empty walk mismatches three NON-empty
    // expected sets. So this case does not prove the floor decides anything —
    // it pins the DIAGNOSTIC, that the failure names the walk rather than
    // leaving three set mismatches to be misread as three unlinted packages.
    name: "a packages/ walk that finds nothing names the WALK, not just the sets",
    files: {
      "package.json": { name: "mercaria", scripts: { lint: "bun run --filter '*' lint" } },
      ".github/workflows/ci.yml": CI_YML,
    },
    expectExit: 1,
    expectOutput: "0 workspace packages found under packages/, below the 6 floor",
  },
  {
    // #494's shape, aimed at this gate: `validate-rtl-logical-classes.mjs` has a
    // GLOBAL floor (392) against a live 487, so deleting the whole of
    // `packages/pos/` leaves 420 and the guard PASSES. The equivalent attack
    // here is a package disappearing, and it must not survive it.
    //
    // What stops it is that the categories are EXACT SETS rather than a total:
    // `pos` leaving drops it out of EXPECTED_NO_SCRIPT, which no other package
    // can make up for. A single global count would have exactly #494's hole.
    name: "a whole package disappearing fails — the #494 shape",
    files: (() => {
      const files = tree();
      delete files["packages/pos/package.json"];
      return files;
    })(),
    expectExit: 1,
    expectOutput: "packages with NO lint script are [dashboard, frontend], expected "
      + "[dashboard, frontend, pos]",
  },
  {
    name: "a package whose manifest is not valid JSON fails loudly",
    files: tree({ "packages/pos/package.json": "{ not json\n" }),
    expectExit: 1,
    expectOutput: "packages/pos/package.json could not be read as JSON",
  },

  // ---------------------------------------------------- the must-NOT-fire ---

  {
    // The gate describes lint coverage and nothing else. A repo where somebody
    // changes a test script, adds a typecheck, or renames a job that is not the
    // gating one must stay silent — a gate that fires on unrelated edits is one
    // whose expected sets get updated without being read.
    name: "changes to scripts that are not `lint` do NOT fire",
    files: withPackage("frontend", {
      name: "@mercaria/frontend",
      scripts: { test: "vitest run --coverage", typecheck: "tsc --noEmit", build: "expo export" },
    }),
    expectExit: 0,
    expectOutput: "lint coverage guard passed",
  },
  {
    name: "a lint script that merely MENTIONS a linter in a comment-ish string still counts",
    // `RUNS_A_LINTER` is a word match on the command, which is the honest read:
    // a script invoking eslint through a wrapper is still linting.
    files: withPackage("backend", {
      name: "@mercaria/backend",
      scripts: { lint: "bun run eslint src", test: "vitest run" },
    }),
    expectExit: 0,
    expectOutput: "lint coverage guard passed",
  },
];

/**
 * The guard's controls run on every invocation, so every case above exercises
 * them. This asserts the SOURCE still carries them: deleting a control would
 * otherwise leave every case green, since none depends on one existing.
 */
async function assertGuardSource() {
  const source = await readFile(validator, "utf8");
  const required = [
    "LINTER_CONTROL_MUST_MATCH",
    "LINTER_CONTROL_MUST_NOT_MATCH",
    "positive control failed",
    "negative control failed",
  ];
  const missing = required.filter((token) => !source.includes(token));
  return missing.length > 0
    ? `guard source no longer carries ${missing.join(", ")} — its self-controls were removed`
    : null;
}

let failed = 0;

for (const testCase of cases) {
  const { exitCode, output } = await runAgainst(testCase.files);
  const problems = [];
  if (exitCode !== testCase.expectExit) {
    problems.push(`expected exit ${testCase.expectExit}, got ${exitCode}`);
  }
  if (!output.includes(testCase.expectOutput)) {
    problems.push(`expected output to contain ${JSON.stringify(testCase.expectOutput)}`);
  }
  if (problems.length > 0) {
    failed += 1;
    console.error(`FAIL  ${testCase.name}`);
    for (const problem of problems) console.error(`        ${problem}`);
    console.error(`        --- guard output ---\n${output.replace(/^/gm, "        ")}`);
  } else {
    console.log(`ok    ${testCase.name}`);
  }
}

const sourceProblem = await assertGuardSource();
if (sourceProblem) {
  failed += 1;
  console.error(`FAIL  the guard keeps its own controls\n        ${sourceProblem}`);
} else {
  console.log("ok    the guard keeps its own controls");
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length + 1} lint coverage cases failed.`);
  process.exit(1);
}

console.log(`\nAll ${cases.length + 1} lint coverage cases passed.`);
