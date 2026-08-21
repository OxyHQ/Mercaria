#!/usr/bin/env bun

/**
 * Mutation-tests `validate-lock-capacity.mjs`.
 *
 * That guard is mostly a set of COUNTS, and every one of its instruments fails
 * quiet: a directory walk that returned nothing satisfies the headroom check
 * outright, a regular expression that stopped matching reports agreement between
 * ceilings it never read, and a journal it could not parse projects a capacity
 * larger than anything measured. "I found fewer" and "there are fewer" look
 * identical from the outside, so each case below breaks exactly one instrument
 * and requires the guard to fail with words naming the right one.
 *
 * The inverse control matters as much and is the one nobody runs: what does the
 * instrument report when its subject is PRESENT? A guard that fails on every
 * fixture is not a guard, it is a broken pattern — so the healthy tree must
 * PASS, and the near-miss trees (one more file while headroom remains, a ceiling
 * change that WAS measured) must pass too.
 *
 * Fixtures are real directory trees and the REAL guard is spawned against each
 * through `LOCK_CAPACITY_VALIDATOR_ROOT`, rather than this file re-implementing
 * the guard's logic and then measuring the re-implementation.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-lock-capacity.mjs");

/**
 * The ceiling and the capacity the guard actually carries, read out of the guard
 * itself rather than restated here.
 *
 * A fixture built against a hard-coded 256 would keep passing after somebody
 * raised the real ceiling, and every case below would then be measuring a
 * configuration the repository no longer has.
 */
function guardFacts() {
  const source = readFileSync(validator, "utf8");
  const rows = [...source.matchAll(/ceiling:\s*(\d+),\s*\n\s*capacity:\s*(\d+),/g)].map((m) => ({
    ceiling: Number.parseInt(m[1], 10),
    capacity: Number.parseInt(m[2], 10),
  }));
  if (rows.length === 0) {
    throw new Error(
      "Could not read a single measurement row out of validate-lock-capacity.mjs. This " +
        "self-test builds every fixture from the guard's own numbers, so a reader that " +
        "matched nothing would silently test a configuration nobody has.",
    );
  }
  const shared = readFileSync(validator, "utf8").match(
    /const SHARED_GLOBAL_SETUP_DATABASES\s*=\s*(\d+)/,
  );
  if (!shared) throw new Error("Could not read SHARED_GLOBAL_SETUP_DATABASES out of the guard.");
  return { rows, sharedDatabases: Number.parseInt(shared[1], 10) };
}

const { rows, sharedDatabases } = guardFacts();
/** The lowest measured ceiling — the one every fixture is built at unless it says otherwise. */
const measured = rows.reduce((lowest, row) => (row.ceiling < lowest.ceiling ? row : lowest));
/** A ceiling no row records, for the "changed it without measuring" case. */
const unmeasuredCeiling = Math.max(...rows.map((r) => r.ceiling)) * 4 + 1;

let failures = 0;

async function runAgainst(files) {
  const root = await mkdtemp(join(tmpdir(), "lock-capacity-validator-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      if (contents === null) continue;
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }
    const proc = Bun.spawnSync({
      cmd: ["bun", validator],
      cwd: repositoryRoot,
      env: { ...process.env, LOCK_CAPACITY_VALIDATOR_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: proc.exitCode, output: `${proc.stdout.toString()}${proc.stderr.toString()}` };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function compose(ceiling) {
  return `services:\n  postgres:\n    image: postgis/postgis:17-3.5\n    command: postgres -c max_locks_per_transaction=${ceiling}\n`;
}

function workflow(ceiling) {
  return (
    `name: CI\non: [push]\njobs:\n  lint-and-test:\n    steps:\n` +
    `      - name: Raise the Postgres lock ceiling\n` +
    `        run: |\n` +
    `          docker exec "$CT" psql -c "ALTER SYSTEM SET max_locks_per_transaction = ${ceiling}"\n`
  );
}

function globalSetup(ceiling) {
  return `const REQUIRED_MAX_LOCKS_PER_TRANSACTION = ${ceiling};\nexport default async function setup() {}\n`;
}

function journal(entries) {
  return `${JSON.stringify(
    {
      version: "7",
      dialect: "postgresql",
      entries: Array.from({ length: entries }, (_, idx) => ({
        idx,
        version: "7",
        when: 1700000000000 + idx,
        tag: `${String(idx).padStart(4, "0")}_probe`,
        breakpoints: true,
      })),
    },
    null,
    2,
  )}\n`;
}

/** A realdb file that migrates its OWN database — the expensive kind. */
const PRIVATE_FILE =
  "import { createMercariaTestDatabase } from '../../db/testDatabase.js';\n" +
  "describe('x', () => { it('y', async () => { await createMercariaTestDatabase(url); }); });\n";

/** A realdb file that uses the SHARED database — costs no extra migration. */
const SHARED_FILE = "describe('x', () => { it('y', () => { expect(1).toBe(1); }); });\n";

/**
 * A tree the guard must accept: as many private-database files as the measured
 * capacity leaves room for, at the measured ceiling and the measured chain.
 */
function tree({
  privateFiles = measured.capacity - sharedDatabases,
  sharedFiles = 2,
  ceilings = {},
  entries = 133,
  extra = {},
} = {}) {
  const files = {
    "docker-compose.postgres.yml": compose(ceilings.compose ?? measured.ceiling),
    ".github/workflows/ci.yml": workflow(ceilings.workflow ?? measured.ceiling),
    "packages/backend/vitest.pg.globalSetup.ts": globalSetup(ceilings.harness ?? measured.ceiling),
    "packages/backend/drizzle/meta/_journal.json": journal(entries),
  };
  for (let i = 0; i < privateFiles; i += 1) {
    files[`packages/backend/src/services/__tests__/private-${String(i)}.realdb.test.ts`] =
      PRIVATE_FILE;
  }
  for (let i = 0; i < sharedFiles; i += 1) {
    files[`packages/backend/src/services/__tests__/shared-${String(i)}.realdb.test.ts`] =
      SHARED_FILE;
  }
  return { ...files, ...extra };
}

async function expectPass(label, files) {
  const { exitCode, output } = await runAgainst(files);
  if (exitCode === 0) {
    process.stdout.write(`  ok    ${label}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${label}\n        expected exit 0, got ${String(exitCode)}\n`);
  process.stdout.write(`${output.replace(/^/gm, "        ")}\n`);
}

async function expectFail(label, files, mustMention) {
  const { exitCode, output } = await runAgainst(files);
  if (exitCode === 0) {
    failures += 1;
    process.stdout.write(`  FAIL  ${label}\n        guard passed; it should have refused\n`);
    return;
  }
  const missing = mustMention.filter((needle) => !output.includes(needle));
  if (missing.length > 0) {
    failures += 1;
    process.stdout.write(
      `  FAIL  ${label}\n        refused, but said nothing about: ${missing.join(", ")}\n`,
    );
    process.stdout.write(`${output.replace(/^/gm, "        ")}\n`);
    return;
  }
  process.stdout.write(`  ok    ${label}\n`);
}

process.stdout.write("validate-lock-capacity self-test\n\n");

// ---------------------------------------------------------------------------
// The inverse control: what does the instrument report when its subject is
// PRESENT and healthy? A guard that refuses everything is a broken pattern
// wearing a gate's clothes, and no amount of must-FAIL cases would show it.
// ---------------------------------------------------------------------------
await expectPass("a tree exactly at capacity passes", tree());
await expectPass(
  "a tree one file below capacity passes",
  tree({ privateFiles: measured.capacity - sharedDatabases - 1 }),
);
await expectPass(
  "realdb files on the SHARED database do not count against the budget",
  tree({ sharedFiles: 40 }),
);

// ---------------------------------------------------------------------------
// The headroom rule itself.
// ---------------------------------------------------------------------------
await expectFail(
  "one private-database file past capacity is refused",
  tree({ privateFiles: measured.capacity - sharedDatabases + 1 }),
  ["out of shared memory", "lock-capacity-probe.ts"],
);

// ---------------------------------------------------------------------------
// The projection: a longer chain must SHRINK the capacity the guard allows,
// with nobody having edited a number. This is the whole point of #849 — a
// capacity compared flat against an older chain is the arithmetic that failed.
// ---------------------------------------------------------------------------
await expectFail(
  "a much longer chain shrinks the projected capacity and refuses the same file count",
  tree({ entries: 133 + 400 }),
  ["projected", "chain is now 533"],
);
await expectPass(
  "a longer chain still passes while the projection leaves room",
  // One file BELOW capacity, so the growth eats headroom rather than the budget.
  // The first spelling of this case sat exactly AT capacity and went red on a
  // seven-migration chain growth — which is the projection working, not a bug.
  tree({ privateFiles: measured.capacity - sharedDatabases - 1, entries: 140 }),
);

// ---------------------------------------------------------------------------
// Each instrument, broken one at a time. Every one of these fails QUIET if the
// guard does not check for it.
// ---------------------------------------------------------------------------
await expectFail(
  "a src tree with no realdb files at all is refused, not read as a cheap suite",
  { ...tree({ privateFiles: 0, sharedFiles: 0 }) },
  ["measured nothing"],
);
await expectFail(
  "realdb files that no longer name the marker are refused, not counted as zero",
  tree({
    privateFiles: 0,
    sharedFiles: 3,
  }),
  ["createMercariaTestDatabase", "blind"],
);
await expectFail(
  "a compose file whose ceiling moved out of the guard's pattern is refused",
  tree({ extra: { "docker-compose.postgres.yml": "services:\n  postgres:\n    image: x\n" } }),
  ["docker-compose.postgres.yml", "pattern rotted"],
);
await expectFail(
  "a workflow whose ALTER SYSTEM disappeared is refused",
  tree({ extra: { ".github/workflows/ci.yml": "name: CI\non: [push]\n" } }),
  [".github/workflows/ci.yml", "pattern rotted"],
);
await expectFail(
  "a harness that stopped asserting the floor is refused",
  tree({
    extra: { "packages/backend/vitest.pg.globalSetup.ts": "export default async function s() {}\n" },
  }),
  ["vitest.pg.globalSetup.ts", "pattern rotted"],
);
await expectFail(
  "an empty journal is refused rather than projecting a capacity above the measurement",
  tree({ entries: 0 }),
  ["_journal.json", "no migration entries"],
);
await expectFail(
  "a missing journal is refused",
  tree({ extra: { "packages/backend/drizzle/meta/_journal.json": null } }),
  ["_journal.json"],
);

// ---------------------------------------------------------------------------
// The two-mechanisms-for-one-fact rule, in every pairing. A silent disagreement
// here means lock exhaustion reproduces in one environment only.
// ---------------------------------------------------------------------------
await expectFail(
  "compose above CI is refused",
  tree({ ceilings: { compose: measured.ceiling * 2 } }),
  ["disagree", "docker-compose.postgres.yml"],
);
await expectFail(
  "CI above compose is refused",
  tree({ ceilings: { workflow: measured.ceiling * 2 } }),
  ["disagree", ".github/workflows/ci.yml"],
);
await expectFail(
  "the harness floor drifting below the servers is refused",
  tree({ ceilings: { harness: Math.floor(measured.ceiling / 2) } }),
  ["disagree", "vitest.pg.globalSetup.ts"],
);

// ---------------------------------------------------------------------------
// Raising the ceiling without measuring at it. This is the case that stops the
// gate becoming the thing it guards against: a capacity carried forward.
// ---------------------------------------------------------------------------
await expectFail(
  "a ceiling nobody measured is refused even though it is HIGHER than the measured one",
  tree({
    ceilings: {
      compose: unmeasuredCeiling,
      workflow: unmeasuredCeiling,
      harness: unmeasuredCeiling,
    },
  }),
  ["nobody has measured", "lock-capacity-probe.ts"],
);

process.stdout.write(
  `\n${failures === 0 ? "All cases behaved as required." : `${String(failures)} case(s) FAILED.`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
