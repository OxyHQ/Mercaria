/**
 * Every test runner in this repository is actually RUN by CI (#469).
 *
 * ## The failure this exists for
 *
 * A runner that nothing invokes is the worst of both outcomes: it looks like
 * coverage in every review and in every file listing, and it measures nothing.
 * This repository has hit the shape three times — a mechanism registered,
 * configured, even tested, with zero callers — and the reason it survives is
 * that there is nothing to go red. The test files exist, they pass when someone
 * runs them by hand, and the pipeline never mentions them.
 *
 * #469 added a runner to `packages/dashboard` and one to `packages/pos`, which
 * took the count of packages carrying a `test` script from two to four. Nothing
 * in the repository asserted that even the first two were wired up: no test and
 * no guard reads `.github/workflows/ci.yml` at all, and `AGENTS.md`'s claim that
 * "ci.yml names all 7" was already off by one with no build turning red.
 *
 * ## Why it is stated in both directions
 *
 * Forwards — a package declaring a `test` script must be named by a CI step —
 * is the zero-callers rule.
 *
 * Backwards — a step's `--filter` must name a package that HAS a real runner —
 * catches the case bun does not. Measured on bun 1.3.14: a filter matching no
 * workspace member, and a filter naming a package without that script, both
 * print "No packages matched the filter" and exit 1, so a plain typo fails the
 * step loudly and this assertion only restates it earlier and more legibly.
 * What bun cannot see is a step pointed at a package whose `test` is a
 * PLACEHOLDER: `bun run --filter @mercaria/ui test` prints "No tests specified"
 * and exits 0, so a step called "Test UI" would sit in the pipeline reading as a
 * passing suite forever while running an `echo`. That is the same "no checks
 * reported looks like success" failure the merge rules warn about, one layer
 * down, and it is the one this direction exists for.
 *
 * ## Derived, never hand-maintained
 *
 * The package set comes from reading `packages/` and every `package.json` in it.
 * A gate that skips what a hand-maintained map omits is not a gate, and finding
 * FEWER packages must never look the same as there BEING fewer — hence the
 * floors below, which are what makes a broken traversal fail instead of pass.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/** The repo root, from this file: `packages/backend/src/__tests__` is four deep. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const CI_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

/**
 * The job every check below must live in.
 *
 * Named rather than inferred: a step is only gated if the JOB carrying it is the
 * one a merge waits on, and a step quietly moved into a job nothing requires
 * would otherwise still satisfy "some step runs it".
 */
const GATING_JOB = 'lint-and-test';

/** Only the shape these assertions read — not a schema for GitHub Actions. */
interface WorkflowFile {
  jobs: Record<string, { name?: string; steps: { name?: string; run?: string }[] }>;
}

interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
}

const workflow = parse(readFileSync(CI_PATH, 'utf8')) as WorkflowFile;

function manifestsByDirectory(): Map<string, PackageManifest> {
  const found = new Map<string, PackageManifest>();
  for (const entry of readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    found.set(
      entry.name,
      JSON.parse(readFileSync(join(REPO_ROOT, 'packages', entry.name, 'package.json'), 'utf8')),
    );
  }
  return found;
}

const manifests = manifestsByDirectory();

/** Workspace names, so a `--filter` can be checked against something real. */
const workspaceNames = new Set(
  [...manifests.values()].map((manifest) => manifest.name).filter((name) => name !== undefined),
);

/**
 * A `test` script that actually runs a framework.
 *
 * Derived from the script's CONTENT rather than from a list of package names,
 * which is what keeps the exemption below from rotting: `shared-types` and `ui`
 * carry `echo "No tests specified" && exit 0`, and the day either becomes a real
 * `vitest run` it stops matching the placeholder shape and starts being required
 * here — with no list for anyone to remember to update.
 */
const RUNS_A_FRAMEWORK = /\bvitest\b/u;

const declaresTestScript = [...manifests.entries()].filter(
  ([, manifest]) => typeof manifest.scripts?.test === 'string',
);

/** The packages that declare a real runner. */
const packagesWithTests = declaresTestScript
  .filter(([, manifest]) => RUNS_A_FRAMEWORK.test(manifest.scripts?.test ?? ''))
  .map(([directory, manifest]) => ({ directory, name: manifest.name }));

/** The packages whose `test` script is an honest placeholder. */
const placeholderPackages = declaresTestScript
  .filter(([, manifest]) => !RUNS_A_FRAMEWORK.test(manifest.scripts?.test ?? ''))
  .map(([directory]) => directory);

const gatingSteps = workflow.jobs[GATING_JOB]?.steps ?? [];

/** `bun run --filter <name> test`, as every test step in this workflow spells it. */
const FILTERED_TEST_RUN = /--filter\s+(\S+)\s+test\b/u;

const filteredTestTargets = gatingSteps
  .map((step) => FILTERED_TEST_RUN.exec(step.run ?? ''))
  .filter((match) => match !== null)
  .map((match) => match[1]);

describe('the CI workflow is readable and non-vacuous', () => {
  it('parses, and carries the job every other assertion reads', () => {
    // Without this, a renamed job would make every check below iterate an empty
    // list and pass — the classic census that reports clean by finding nothing.
    expect(Object.keys(workflow.jobs)).toContain(GATING_JOB);
    expect(gatingSteps.length).toBeGreaterThan(10);
  });

  it('finds the workspace packages on disk', () => {
    // Floors, not equalities: a package may be added without touching this file.
    expect(manifests.size).toBeGreaterThanOrEqual(6);
    expect(workspaceNames.size).toBe(manifests.size);
  });

  it('finds every package that declares a runner', () => {
    // Four today: backend, frontend, dashboard, pos. A floor of four is what
    // stops a traversal that silently found none from reading as compliance.
    expect(packagesWithTests.length).toBeGreaterThanOrEqual(4);
    expect(packagesWithTests.map((pkg) => pkg.directory).sort()).toEqual(
      expect.arrayContaining(['backend', 'dashboard', 'frontend', 'pos']),
    );
  });

  it('finds the test steps that run them', () => {
    expect(filteredTestTargets.length).toBeGreaterThanOrEqual(4);
  });
});

describe('the placeholder test scripts are exactly the two that have no tests', () => {
  // An exemption needs its own exact-count assertion, or it is a hole that grows
  // quietly. These two exist so `bun run --filter '*' test` does not fail on a
  // package with nothing to run; neither is excused from anything else.
  it('is exactly shared-types and ui', () => {
    expect(placeholderPackages.sort()).toEqual(['shared-types', 'ui']);
  });

  it('and each of them genuinely has no test file to run', () => {
    // The half that matters. A placeholder that acquires tests is a suite
    // nothing executes, and it would look identical to this state from the
    // manifest alone.
    for (const directory of placeholderPackages) {
      const tracked = spawnSync('git', ['ls-files', '--', `packages/${directory}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      expect(tracked.status).toBe(0);
      const files = tracked.stdout.split('\n').filter((path) => path !== '');
      expect(files.length).toBeGreaterThan(5);
      expect(files.filter((path) => /(?:^|\/)__tests__\/|\.test\.tsx?$/u.test(path))).toEqual([]);
    }
  });
});

describe('every package that declares a test script is run by CI', () => {
  it.each(packagesWithTests)('$directory is invoked by a step in the gating job', ({ name }) => {
    expect(filteredTestTargets).toContain(name);
  });

  it('names each of them exactly once, so a duplicate step cannot hide a missing one', () => {
    const counted = new Map<string, number>();
    for (const target of filteredTestTargets) {
      counted.set(target, (counted.get(target) ?? 0) + 1);
    }
    expect([...counted.entries()].filter(([, count]) => count > 1)).toEqual([]);
  });
});

describe('every CI test step names a package that exists and has a runner', () => {
  const withRunner = new Set(packagesWithTests.map((pkg) => pkg.name));

  it.each(filteredTestTargets)('%s is a real workspace member', (target) => {
    expect(workspaceNames).toContain(target);
  });

  it.each(filteredTestTargets)('%s runs a framework, not an echo', (target) => {
    // The half bun cannot answer: a placeholder `test` script exits 0, so a step
    // aimed at one is a permanently green suite that runs nothing.
    expect(withRunner).toContain(target);
  });
});

describe('a client runner is a real config, not an empty script', () => {
  const CLIENT_PACKAGES = ['frontend', 'dashboard', 'pos'] as const;

  it.each(CLIENT_PACKAGES)('%s has its own vitest config', (directory) => {
    // Per-package rather than one shared config, and that is a correctness
    // property: a test importing across a package boundary compiles the imported
    // source under the IMPORTING package's `strict` setting. All three of these
    // are `strict: true`; this package is `strict: false`. Exercised from here,
    // their modules would lose every null-safety check they were written to rely
    // on, and go green having measured a laxer language (#469).
    const config = readFileSync(join(REPO_ROOT, 'packages', directory, 'vitest.config.ts'), 'utf8');
    expect(config).toContain('defineConfig');
    expect(config).toContain("include: ['lib/**/__tests__/**/*.test.ts']");
  });

  it.each(CLIENT_PACKAGES)('%s runs vitest rather than a placeholder', (directory) => {
    expect(manifests.get(directory)?.scripts?.test).toBe('vitest run');
  });
});
