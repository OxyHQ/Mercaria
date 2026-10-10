#!/usr/bin/env bun

/**
 * Mutation-tests `validate-lint-coverage.mjs`.
 *
 * That guard's subject is coverage that can leave QUIETLY — a package's `lint`
 * script becoming a placeholder, a path joining Biome's exclusions, the root
 * script narrowing, a CI step disappearing, an Expo app dropping out of the
 * env-var ESLint — so it fails in the quiet direction by construction: a
 * `packages/` walk that returns nothing satisfies empty expected sets, a
 * `RUNS_A_LINTER` that matched nothing files every package as a placeholder,
 * and a workflow matcher that matched nothing reports a CI file with no lint
 * steps as one whose lint steps are all correct. Each case below breaks exactly
 * one of those and requires the guard to fail with words naming the right one.
 *
 * The must-PASS cases matter as much: this gate deliberately does NOT demand a
 * linter from anybody, so it must stay silent about every change that is not a
 * change of coverage.
 *
 * Fixtures are real directory trees and the REAL guard is spawned against each
 * through `LINT_COVERAGE_VALIDATOR_ROOT`, rather than this file re-implementing
 * the guard's logic and then measuring the re-implementation.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validator = resolve(repositoryRoot, 'scripts/validate-lint-coverage.mjs');

/** Run the REAL guard against a scratch tree. */
async function runAgainst(files) {
  const root = await mkdtemp(join(tmpdir(), 'lint-coverage-validator-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      if (contents === null) continue;
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(
        full,
        typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`,
      );
    }
    const proc = Bun.spawnSync({
      cmd: ['bun', validator],
      cwd: repositoryRoot,
      env: { ...process.env, LINT_COVERAGE_VALIDATOR_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: proc.exitCode,
      output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A workflow carrying the gating job, the Biome step and the three Expo steps. */
const CI_YML =
  'name: CI\n' +
  'on: [push, pull_request]\n' +
  'jobs:\n' +
  '  lint-and-test:\n' +
  '    runs-on: ubuntu-latest\n' +
  '    steps:\n' +
  '      - name: Biome (format and lint, every package)\n' +
  '        run: bunx biome ci .\n' +
  '      - name: Expo env-var lint (Storefront)\n' +
  '        run: bun run --filter @mercaria/frontend lint:expo\n' +
  '      - name: Expo env-var lint (Dashboard)\n' +
  '        run: bun run --filter @mercaria/dashboard lint:expo\n' +
  '      - name: Expo env-var lint (POS)\n' +
  '        run: bun run --filter @mercaria/pos lint:expo\n' +
  '      - name: Test the backend\n' +
  '        run: bun run --filter @mercaria/backend test\n';

/**
 * The real config's shape, comments and a trailing comma INCLUDED: the guard
 * reads JSONC through TypeScript's parser, and a fixture written as plain JSON
 * would never exercise that.
 */
const EXCLUSIONS = [
  '!**/node_modules',
  '!.worktrees',
  '!**/dist',
  '!**/coverage',
  '!**/.expo',
  '!**/.next',
  '!**/drizzle/meta',
  '!**/*.generated.*',
  '!packages/contracts/openapi.json',
  '!docs/audits',
  '!.github/scripts/reviewed-images.json',
  '!packages/ui/src/theme/global.css',
];

function biomeConfig({
  includes = ['**', ...EXCLUSIONS],
  schema = '2.5.15',
  linter = {},
  formatter = {},
  overrides = [],
} = {}) {
  return (
    '{\n' +
    `  "$schema": "https://biomejs.dev/schemas/${schema}/schema.json",\n` +
    '  // a comment, as the real file carries\n' +
    `  "files": { "ignoreUnknown": true, "includes": ${JSON.stringify(includes)} },\n` +
    `  "formatter": ${JSON.stringify({ enabled: true, ...formatter })},\n` +
    `  "linter": ${JSON.stringify({ enabled: true, rules: { preset: 'recommended' }, ...linter })},\n` +
    `  "overrides": ${JSON.stringify(overrides)},\n` +
    '}\n'
  );
}

const BIOME = 'biome check .';
const APP_DEV = {
  '@typescript-eslint/parser': '^8.64.0',
  eslint: '^9.39.5',
  'eslint-plugin-expo': '^1.2.1',
};

function app(name, extra = {}) {
  return {
    name,
    scripts: {
      typecheck: 'tsc --noEmit',
      test: 'vitest run',
      lint: `${BIOME} && bun run lint:expo`,
      'lint:expo': 'eslint .',
    },
    devDependencies: APP_DEV,
    ...extra,
  };
}

/**
 * The repository as it stands: all EIGHT packages lint with Biome, the three
 * Expo apps additionally run the env-var ESLint, nothing is a placeholder. The
 * SDK's manifest name is NOT `@mercaria/<directory>` (#1017).
 *
 * Every package also carries an unrelated script or two, so a case can change
 * one without touching `lint` and prove the gate stays silent.
 */
function tree(extra = {}) {
  return {
    'package.json': {
      name: 'mercaria',
      scripts: {
        lint: 'biome check . && bun run lint:expo',
        'lint:expo':
          'bun run --filter @mercaria/frontend --filter @mercaria/dashboard --filter @mercaria/pos lint:expo',
      },
      devDependencies: { '@biomejs/biome': '2.5.15', typescript: '^5.9.3' },
    },
    'biome.jsonc': biomeConfig(),
    'packages/backend/package.json': {
      name: '@mercaria/backend',
      scripts: { lint: BIOME, test: 'vitest run' },
    },
    'packages/contracts/package.json': {
      name: '@mercaria/contracts',
      scripts: { lint: BIOME, test: 'vitest run', build: 'tsc -p tsconfig.json' },
    },
    'packages/ui/package.json': {
      name: '@mercaria/ui',
      scripts: { lint: BIOME, typecheck: 'tsc --noEmit' },
    },
    'packages/shared-types/package.json': {
      name: '@mercaria/shared-types',
      scripts: { lint: BIOME, build: 'tsc' },
    },
    'packages/sdk/package.json': {
      name: '@mercaria.co/sdk',
      scripts: { lint: BIOME, test: 'vitest run', typecheck: 'tsc --noEmit' },
    },
    'packages/frontend/package.json': app('@mercaria/frontend'),
    'packages/dashboard/package.json': app('@mercaria/dashboard'),
    'packages/pos/package.json': app('@mercaria/pos'),
    '.github/workflows/ci.yml': CI_YML,
    ...extra,
  };
}

/** The same tree with one package's manifest replaced wholesale. */
function withPackage(directory, manifest, extra = {}) {
  return tree({ [`packages/${directory}/package.json`]: manifest, ...extra });
}

const ALL_EIGHT = 'backend, contracts, dashboard, frontend, pos, sdk, shared-types, ui';

const cases = [
  {
    name: 'the repository as it stands passes',
    files: tree(),
    expectExit: 0,
    expectOutput: 'lint coverage guard passed',
  },

  // ------------------------------------------- per-package lint scripts ---
  {
    name: 'a package LOSING its lint script fails',
    files: withPackage('backend', { name: '@mercaria/backend', scripts: { test: 'vitest run' } }),
    expectExit: 1,
    expectOutput: 'packages with NO lint script are [backend], expected []',
  },
  {
    // The silent one: the script survives, the linting does not. A name-keyed
    // detector would keep calling this package linted.
    name: 'a real linter QUIETLY becoming a placeholder fails',
    files: withPackage('ui', {
      name: '@mercaria/ui',
      scripts: { lint: 'echo "No lint configured for ui" && exit 0' },
    }),
    expectExit: 1,
    expectOutput: 'packages whose lint script is a PLACEHOLDER are [ui], expected []',
  },
  {
    // A package that exists on disk and in nobody's git index yet. The guard
    // walks the filesystem precisely so this is caught the day it appears.
    name: 'a NEW package with no lint script fails',
    files: tree({
      'packages/kiosk/package.json': { name: '@mercaria/kiosk', scripts: { test: 'vitest run' } },
    }),
    expectExit: 1,
    expectOutput: 'packages with NO lint script are [kiosk], expected []',
  },
  {
    // #494's shape: a whole package disappearing must not be absorbed by a
    // total. The sets are EXACT, so `pos` leaving cannot be made up for.
    name: 'a whole package disappearing fails — the #494 shape',
    files: (() => {
      const files = tree();
      delete files['packages/pos/package.json'];
      return files;
    })(),
    expectExit: 1,
    expectOutput:
      'packages running a REAL linter are [backend, contracts, dashboard, frontend, sdk, shared-types, ui], ' +
      `expected [${ALL_EIGHT}]`,
  },
  {
    name: 'a package whose manifest is not valid JSON fails loudly',
    files: tree({ 'packages/pos/package.json': '{ not json\n' }),
    expectExit: 1,
    expectOutput: 'packages/pos/package.json could not be read as JSON',
  },
  {
    // MEASURED on the predecessor of this guard: an empty walk still exits 1
    // without the floor, because it mismatches a NON-empty expected set. The
    // case pins the DIAGNOSTIC — the failure names the walk.
    name: 'a packages/ walk that finds nothing names the WALK, not just the sets',
    files: {
      'package.json': tree()['package.json'],
      'biome.jsonc': biomeConfig(),
      '.github/workflows/ci.yml': CI_YML,
    },
    expectExit: 1,
    expectOutput: '0 workspace packages found under packages/, below the 8 floor',
  },

  // ------------------------------------------------------- the root script ---
  {
    name: 'the root script narrowing Biome to one package fails',
    files: tree({
      'package.json': {
        ...tree()['package.json'],
        scripts: { lint: 'biome check packages/backend && bun run lint:expo' },
      },
    }),
    expectExit: 1,
    expectOutput: 'which does not run `biome check .` over the whole tree',
  },
  {
    name: 'the root script dropping lint:expo fails',
    files: tree({
      'package.json': { ...tree()['package.json'], scripts: { lint: 'biome check .' } },
    }),
    expectExit: 1,
    expectOutput: 'which no longer runs `lint:expo`',
  },
  {
    name: 'the root script disappearing fails',
    files: tree({ 'package.json': { ...tree()['package.json'], scripts: { build: 'tsc' } } }),
    expectExit: 1,
    expectOutput: 'the root package.json has no `lint` script',
  },

  // ------------------------------------------------------- Biome declared ---
  {
    name: 'Biome declared as a RANGE fails',
    files: tree({
      'package.json': {
        ...tree()['package.json'],
        devDependencies: { '@biomejs/biome': '^2.5.15' },
      },
    }),
    expectExit: 1,
    expectOutput: 'declares @biomejs/biome ^2.5.15, expected EXACTLY 2.5.15',
  },
  {
    name: 'Biome missing from the root fails',
    files: tree({ 'package.json': { ...tree()['package.json'], devDependencies: {} } }),
    expectExit: 1,
    expectOutput: 'declares @biomejs/biome nowhere',
  },
  {
    name: 'a package declaring its own Biome fails',
    files: withPackage('ui', {
      name: '@mercaria/ui',
      scripts: { lint: BIOME },
      devDependencies: { '@biomejs/biome': '2.5.15' },
    }),
    expectExit: 1,
    expectOutput: 'packages/ui declares its own @biomejs/biome 2.5.15',
  },

  // ------------------------------------------------------- the Biome config ---
  {
    name: 'a NEW exclusion in biome.jsonc fails',
    files: tree({
      'biome.jsonc': biomeConfig({ includes: ['**', ...EXCLUSIONS, '!packages/backend/src'] }),
    }),
    expectExit: 1,
    expectOutput: 'biome.jsonc excludes [',
  },
  {
    name: 'an exclusion REMOVED from biome.jsonc fails too — it is a decision either way',
    files: tree({
      'biome.jsonc': biomeConfig({
        includes: ['**', ...EXCLUSIONS.filter((entry) => entry !== '!docs/audits')],
      }),
    }),
    expectExit: 1,
    expectOutput: 'biome.jsonc excludes [',
  },
  {
    name: 'includes that no longer start at the whole tree fail',
    files: tree({
      'biome.jsonc': biomeConfig({ includes: ['packages/backend/**', ...EXCLUSIONS] }),
    }),
    expectExit: 1,
    expectOutput: 'does not start with "**"',
  },
  {
    name: 'the linter switched off fails',
    files: tree({ 'biome.jsonc': biomeConfig({ linter: { enabled: false } }) }),
    expectExit: 1,
    expectOutput: 'sets `linter.enabled: false`',
  },
  {
    name: 'the formatter switched off fails',
    files: tree({ 'biome.jsonc': biomeConfig({ formatter: { enabled: false } }) }),
    expectExit: 1,
    expectOutput: 'sets `formatter.enabled: false`',
  },
  {
    // The exclusion list cannot see this one, which is exactly why it is checked.
    name: 'an override switching the linter off for a path fails',
    files: tree({
      'biome.jsonc': biomeConfig({
        overrides: [{ includes: ['packages/sdk/**'], linter: { enabled: false } }],
      }),
    }),
    expectExit: 1,
    expectOutput: 'override #0 (["packages/sdk/**"]) sets `linter.enabled: false`',
  },
  {
    name: 'a $schema naming another Biome fails',
    files: tree({ 'biome.jsonc': biomeConfig({ schema: '2.4.0' }) }),
    expectExit: 1,
    expectOutput: 'which does not name 2.5.15',
  },
  {
    name: 'an unparseable biome.jsonc fails loudly',
    files: tree({ 'biome.jsonc': '{ "files": [ \n' }),
    expectExit: 1,
    expectOutput: 'biome.jsonc could not be parsed',
  },
  {
    name: 'a missing biome.jsonc fails loudly',
    files: tree({ 'biome.jsonc': null }),
    expectExit: 1,
    expectOutput: 'biome.jsonc could not be read',
  },

  // ---------------------------------------------------- the Expo ESLint ---
  {
    name: 'an app losing lint:expo fails',
    files: withPackage('pos', app('@mercaria/pos', { scripts: { lint: BIOME } })),
    expectExit: 1,
    expectOutput:
      'packages whose `lint:expo` runs ESLint are [dashboard, frontend], expected [dashboard, frontend, pos]',
  },
  {
    name: 'an app whose lint stops running lint:expo fails',
    files: withPackage(
      'frontend',
      app('@mercaria/frontend', { scripts: { lint: BIOME, 'lint:expo': 'eslint .' } }),
    ),
    expectExit: 1,
    expectOutput: 'packages/frontend\'s `lint` script ("biome check .") does not run `lint:expo`',
  },
  {
    // The state of every package on `main` before #607.
    name: 'an app running eslint but DECLARING none fails',
    files: withPackage(
      'dashboard',
      app('@mercaria/dashboard', { devDependencies: { 'eslint-plugin-expo': '^1.2.1' } }),
    ),
    expectExit: 1,
    expectOutput: 'packages/dashboard runs eslint in its lint scripts but DECLARES no eslint',
  },
  {
    name: "one app's eslint range drifting from its siblings fails",
    files: withPackage(
      'frontend',
      app('@mercaria/frontend', { devDependencies: { ...APP_DEV, eslint: '^9.0.0' } }),
    ),
    expectExit: 1,
    expectOutput: 'packages/frontend declares eslint ^9.0.0, expected ^9.39.5',
  },
  {
    // The skew #607 MEASURED on main.
    name: '@eslint/js skewed from the eslint beside it fails',
    files: withPackage(
      'dashboard',
      app('@mercaria/dashboard', { devDependencies: { ...APP_DEV, '@eslint/js': '^9.39.4' } }),
    ),
    expectExit: 1,
    expectOutput: 'packages/dashboard declares @eslint/js ^9.39.4 beside eslint ^9.39.5',
  },
  {
    // A package going back to eslint wholesale is still asked to declare it.
    name: 'a non-app package linting with eslint must declare it',
    files: withPackage('backend', {
      name: '@mercaria/backend',
      scripts: { lint: 'eslint src', test: 'vitest run' },
    }),
    expectExit: 1,
    expectOutput: 'packages/backend runs eslint in its lint scripts but DECLARES no eslint',
  },
  {
    // The negative direction: Biome-only packages are NOT asked for eslint.
    name: 'a package running only Biome is NOT asked to declare eslint',
    files: tree(),
    expectExit: 0,
    expectOutput: 'lint coverage guard passed',
    rejectOutput: 'DECLARES no eslint',
  },

  // ----------------------------------------------------------- the workflow ---
  {
    name: 'CI losing its Biome step fails',
    files: tree({
      '.github/workflows/ci.yml': CI_YML.replace(
        '        run: bunx biome ci .\n',
        '        run: echo skipped\n',
      ),
    }),
    expectExit: 1,
    expectOutput: 'no `run: bunx biome ci .` step was found in ci.yml',
  },
  {
    name: "CI's Biome step narrowed to a path fails",
    files: tree({
      '.github/workflows/ci.yml': CI_YML.replace(
        'bunx biome ci .',
        'bunx biome ci packages/backend',
      ),
    }),
    expectExit: 1,
    expectOutput: 'no `run: bunx biome ci .` step was found in ci.yml',
  },
  {
    name: "CI losing one app's Expo step fails",
    files: tree({
      '.github/workflows/ci.yml': CI_YML.replace(
        '      - name: Expo env-var lint (POS)\n        run: bun run --filter @mercaria/pos lint:expo\n',
        '',
      ),
    }),
    expectExit: 1,
    expectOutput: 'ci.yml runs lint:expo for [@mercaria/dashboard, @mercaria/frontend], expected',
  },
  {
    // A multi-filter step: the measured silent skip. It names all three, so the
    // target SET still matches — but the guard must not read it as three steps.
    name: 'CI folding the three Expo steps into one multi-filter step fails',
    files: tree({
      '.github/workflows/ci.yml': CI_YML.replace(
        '      - name: Expo env-var lint (Storefront)\n        run: bun run --filter @mercaria/frontend lint:expo\n',
        '',
      )
        .replace(
          '      - name: Expo env-var lint (Dashboard)\n        run: bun run --filter @mercaria/dashboard lint:expo\n',
          '',
        )
        .replace(
          '--filter @mercaria/pos lint:expo',
          '--filter @mercaria/frontend --filter @mercaria/dashboard --filter @mercaria/pos lint:expo',
        ),
    }),
    expectExit: 1,
    expectOutput: 'ci.yml runs lint:expo for [@mercaria/pos], expected',
  },
  {
    // #1017. The published package's name is not `@mercaria/<directory>`.
    name: 'a CI lint target is matched against the manifest NAME, not the directory',
    files: tree({
      '.github/workflows/ci.yml': `${CI_YML}      - run: bun run --filter @mercaria/sdk lint\n`,
    }),
    expectExit: 1,
    expectOutput:
      'ci.yml runs `--filter @mercaria/sdk lint` but that package has no script running a real linter',
  },
  {
    name: 'CI running lint:expo for a package without it fails',
    files: tree({
      '.github/workflows/ci.yml': `${CI_YML}      - run: bun run --filter @mercaria/ui lint:expo\n`,
    }),
    expectExit: 1,
    expectOutput:
      'ci.yml runs `--filter @mercaria/ui lint:expo` but that package has no `lint:expo` running eslint',
  },
  {
    name: 'the gating job being renamed fails',
    files: tree({ '.github/workflows/ci.yml': CI_YML.replace('lint-and-test:', 'checks:') }),
    expectExit: 1,
    expectOutput: 'no longer declares the `lint-and-test` job',
  },

  // ---------------------------------------------------- the must-NOT-fire ---
  {
    name: 'changes to scripts that are not lint scripts do NOT fire',
    files: withPackage(
      'frontend',
      app('@mercaria/frontend', {
        scripts: {
          lint: `${BIOME} && bun run lint:expo`,
          'lint:expo': 'eslint .',
          test: 'vitest run --coverage',
          typecheck: 'tsc --noEmit',
          build: 'expo export',
        },
      }),
    ),
    expectExit: 0,
    expectOutput: 'lint coverage guard passed',
  },
  {
    name: 'a named per-package lint step that IS real does not fire',
    files: tree({
      '.github/workflows/ci.yml': `${CI_YML}      - run: bun run --filter @mercaria.co/sdk lint\n`,
    }),
    expectExit: 0,
    expectOutput: 'lint coverage guard passed',
  },
];

/**
 * The guard's controls run on every invocation, so every case above exercises
 * them. This asserts the SOURCE still carries them: deleting a control would
 * otherwise leave every case green, since none depends on one existing.
 */
async function assertGuardSource() {
  const source = await readFile(validator, 'utf8');
  const required = [
    'LINTER_CONTROL_MUST_MATCH',
    'LINTER_CONTROL_MUST_NOT_MATCH',
    // #607's pair. `RUNS_ESLINT` decides the population every declaration check
    // examines, so one that matched nothing would leave all of them vacuously
    // true — and the guard would print a tidy summary saying so.
    'ESLINT_CONTROL_MUST_MATCH',
    'ESLINT_CONTROL_MUST_NOT_MATCH',
    // The whole-tree detector: a root script narrowed to one directory still
    // READS as running Biome, so this pair is what keeps "covers all eight" true.
    'BIOME_TREE_CONTROL_MUST_MATCH',
    'BIOME_TREE_CONTROL_MUST_NOT_MATCH',
    'positive control failed',
    'negative control failed',
  ];
  const missing = required.filter((token) => !source.includes(token));
  return missing.length > 0
    ? `guard source no longer carries ${missing.join(', ')} — its self-controls were removed`
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
  // A case that must fail for ONE reason and not another. Without this, a case
  // asserting only exit 1 passes on any failure at all — including the one it
  // exists to rule out, which is how a gate that over-fires reads as covered.
  if (testCase.rejectOutput !== undefined && output.includes(testCase.rejectOutput)) {
    problems.push(`expected output NOT to contain ${JSON.stringify(testCase.rejectOutput)}`);
  }
  if (problems.length > 0) {
    failed += 1;
    console.error(`FAIL  ${testCase.name}`);
    for (const problem of problems) console.error(`        ${problem}`);
    console.error(`        --- guard output ---\n${output.replace(/^/gm, '        ')}`);
  } else {
    console.log(`ok    ${testCase.name}`);
  }
}

const sourceProblem = await assertGuardSource();
if (sourceProblem) {
  failed += 1;
  console.error(`FAIL  the guard keeps its own controls\n        ${sourceProblem}`);
} else {
  console.log('ok    the guard keeps its own controls');
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length + 1} lint coverage cases failed.`);
  process.exit(1);
}

console.log(`\nAll ${cases.length + 1} lint coverage cases passed.`);
