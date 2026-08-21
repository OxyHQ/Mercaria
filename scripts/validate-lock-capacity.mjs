#!/usr/bin/env bun

/**
 * The backend suite must fit inside the Postgres shared lock table — issue #849.
 *
 * ## The failure this exists to move
 *
 * Every realdb file that creates its OWN throwaway database migrates it with the
 * real migrator, which applies the whole chain in ONE transaction and therefore
 * holds every object lock it takes until commit. PostgreSQL sizes ONE shared
 * lock table for the whole server, so those migrations contend for a single pool
 * rather than each getting their own budget. Past the pool the failure is
 * `out of shared memory`, landing mid-migration on whichever `ALTER TABLE` was
 * executing in whichever files happened to overlap — so it reads as an unrelated
 * flake that moves between files run to run, in whichever pull request happened
 * to add the file that tipped it over.
 *
 * ## Why a guard rather than a bigger number
 *
 * `docker-compose.postgres.yml` used to justify its ceiling with a hand-written
 * sentence: "the suite needs six (five private-database files plus the shared
 * globalSetup database)". It needed twelve. Nothing told anybody, because the
 * enforced value still happened to work — the shape #849 was filed about. A
 * count somebody must remember to update is the artefact that went stale, so
 * this guard counts instead.
 *
 * ## What it checks
 *
 * 1. The ceiling is spelled the same in all THREE places that state it. They are
 *    three mechanisms for one fact and can drift; the drift that matters is
 *    silent, because lock exhaustion would then reproduce in one environment
 *    only.
 * 2. There is a RECORDED MEASUREMENT for exactly that ceiling. Changing the
 *    ceiling without measuring at it fails the build — a gate whose capacity
 *    input is a number somebody carried forward is a gate that lies later, which
 *    is the defect, not a smaller version of it.
 * 3. The suite's requirement — one concurrent migration per private-database
 *    realdb file, plus one for the shared globalSetup database — fits inside the
 *    capacity PROJECTED to the migration chain as it stands today.
 *
 * ## Why the capacity is projected rather than compared flat
 *
 * A capacity measurement decays: a longer chain is more objects locked inside
 * one transaction, so the same ceiling carries fewer concurrent migrations than
 * it did. Comparing today's file count against a capacity taken at an older
 * chain is exactly the arithmetic #849 was filed over. So the recorded
 * measurement carries the chain length it was taken at, and the projection
 * charges every migration added since at the measured marginal lock cost. The
 * capacity this guard enforces therefore FALLS as the chain grows, with nobody
 * having to remember anything — and when it falls past the requirement the guard
 * names the probe that re-measures it.
 *
 * Re-run the measurement with:
 *
 *   packages/backend/scripts/lock-capacity-probe.ts
 *
 * @see docker-compose.postgres.yml
 * @see .github/workflows/ci.yml
 * @see packages/backend/vitest.pg.globalSetup.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The tree under test. Overridable so the self-test can drive real fixtures. */
const repositoryRoot =
  process.env.LOCK_CAPACITY_VALIDATOR_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where the measurement rows live, for the remedy line.
 *
 * Written out rather than derived from `import.meta.url` relative to
 * `repositoryRoot`: under the self-test's env override those two are different
 * trees, and the "relative" path came out as a `../..` walk into the tmpdir.
 */
const GUARD_PATH = "scripts/validate-lock-capacity.mjs";

/**
 * Concurrent-migration capacity, MEASURED, one row per ceiling.
 *
 * Taken with `packages/backend/scripts/lock-capacity-probe.ts`: N real
 * migrations through the real migrator entrypoint, launched together and
 * escalated until `out of shared memory`, with two independent witnesses that
 * the migrations genuinely overlapped (a swept interval overlap and a sampled
 * `pg_locks` peak). `capacity` is the highest N where every migration COMPLETED;
 * `firstExhausted` is the lowest N where at least one failed on the lock table.
 *
 * `journalEntries` is not decoration. A capacity without the chain length it was
 * taken at cannot expire visibly, and #849 is the issue somebody filed after
 * quoting one that could not.
 */
const MEASUREMENTS = [
  {
    ceiling: 256,
    capacity: 15,
    firstExhausted: 16,
    /** Peak `pg_locks` held by ONE full-chain migration, at `journalEntries`. */
    locksPerMigration: 5986,
    journalEntries: 133,
    measuredOn: "2026-08-21",
    measuredAtCommit: "9b18057",
    image: "postgis/postgis:17-3.5",
    serverVersion: "17.5",
    maxConnections: 100,
  },
  /**
   * Nothing is set to 512 today. It is recorded because the ceiling is the
   * remedy when the headroom above runs out, and this guard refuses a ceiling it
   * holds no measurement for — so without this row, raising it would mean
   * standing up a server and spending twenty minutes at the moment somebody is
   * already blocked. Measured in the same session as the row above, so it is a
   * measurement rather than a doubling of one.
   */
  {
    ceiling: 512,
    capacity: 31,
    firstExhausted: 32,
    locksPerMigration: 5986,
    journalEntries: 133,
    measuredOn: "2026-08-21",
    measuredAtCommit: "9b18057",
    image: "postgis/postgis:17-3.5",
    serverVersion: "17.5",
    maxConnections: 100,
  },
];

/**
 * Locks one MORE migration adds to a full-chain apply, measured rather than
 * assumed — the projection above is only as honest as this number.
 *
 * Measured on 2026-08-21 at commit 9b18057 by applying truncated copies of the
 * chain and reading the `pg_locks` peak of each:
 *
 *     93 entries  -> 5393 locks
 *    109 entries  -> 5818 locks     (+26.6 per migration over the previous row)
 *    123 entries  -> 5959 locks     (+10.1)
 *    133 entries  -> 5986 locks     (+2.7)
 *
 * The three windows disagree because recent migrations have been cheaper than
 * older ones, so a single slope is a choice. This takes the LARGEST — the
 * 93→133 average of 14.8 — because a larger marginal makes the projected
 * capacity fall faster, which fires this guard earlier and asks for a
 * re-measurement sooner. Erring the other way is how a gate goes quiet.
 */
const MARGINAL_LOCKS_PER_MIGRATION = 14.8;

/**
 * One concurrent migration per private-database realdb file, plus ONE for the
 * shared database `vitest.pg.globalSetup.ts` creates for the whole suite.
 *
 * Named rather than written as a bare `+ 1`, because the shared database is the
 * half a reader forgets and it is a real migration contending for the same pool.
 */
const SHARED_GLOBAL_SETUP_DATABASES = 1;

/**
 * The call that makes a test file create its own database instead of using the
 * shared one. The census is keyed on this USE and not on a filename convention:
 * a file is expensive because it migrates, not because of what it is called.
 *
 * Counted over every `*.test.ts` and not only `*.realdb.test.ts`, because the
 * suffix is a convention and the cost is not — a plain `.test.ts` that called
 * this would migrate a database and be invisible to a census keyed on the name.
 */
const PRIVATE_DATABASE_MARKER = "createMercariaTestDatabase";

/**
 * The module that DEFINES the marker, recognised by its export rather than by
 * its path so a rename does not silently turn it into a twelfth database.
 */
const MARKER_DEFINITION = `export async function ${PRIVATE_DATABASE_MARKER}`;

/**
 * Comments, stripped before the marker is looked for.
 *
 * `services/ingestion/__tests__/active-policy-slot.test.ts` explains in prose
 * why it does NOT create its own database, and names the call while doing it.
 * A census over raw source counts that file, which is the failure mode where a
 * gate fires on a file that is innocent and the fix is to weaken the gate.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Where the three statements of the ceiling live, and how each is spelled. */
const CEILING_SITES = [
  {
    path: "docker-compose.postgres.yml",
    what: "the compose server argument",
    pattern: /command:\s*postgres\s+-c\s+max_locks_per_transaction=(\d+)/,
  },
  {
    path: ".github/workflows/ci.yml",
    what: "the CI service-container ALTER SYSTEM",
    pattern: /ALTER SYSTEM SET max_locks_per_transaction\s*=\s*(\d+)/,
  },
  {
    path: "packages/backend/vitest.pg.globalSetup.ts",
    what: "the floor the harness asserts on whatever server it is handed",
    pattern: /const REQUIRED_MAX_LOCKS_PER_TRANSACTION\s*=\s*(\d+)/,
  },
];

const failures = [];

/** Record a failure with the file it is about, so the output is actionable. */
function fail(message) {
  failures.push(message);
}

function readIfPresent(relativePath) {
  try {
    return readFileSync(join(repositoryRoot, relativePath), "utf8");
  } catch {
    return null;
  }
}

/**
 * Every `*.realdb.test.ts` under the backend's `src/`.
 *
 * Walked rather than globbed through a shell, so the population is this
 * process's own and a shell that matched nothing cannot read as a repository
 * with no realdb files.
 */
function findSourceFiles() {
  const root = join(repositoryRoot, "packages/backend/src");
  const tests = [];
  const others = [];

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        (entry.name.endsWith(".test.ts") ? tests : others).push(full);
      }
    }
  }

  try {
    if (!statSync(root).isDirectory()) return { tests, others };
  } catch {
    return { tests, others };
  }
  walk(root);
  return { tests: tests.sort(), others: others.sort() };
}

/** The ceiling every environment must agree on, or null when they do not. */
function resolveEnforcedCeiling() {
  const readings = [];

  for (const site of CEILING_SITES) {
    const contents = readIfPresent(site.path);
    if (contents === null) {
      fail(`${site.path} is missing, so ${site.what} cannot be read.`);
      continue;
    }
    const match = site.pattern.exec(contents);
    if (!match) {
      // A pattern that stopped matching reports a clean ZERO, which here would
      // read as "the ceilings agree" — the direction that must never be quiet.
      fail(
        `${site.path} no longer states max_locks_per_transaction where this guard ` +
          `looks for it (${site.what}). Either the ceiling moved or the guard's ` +
          `pattern rotted; both need a person, and neither may pass silently.`,
      );
      continue;
    }
    readings.push({ path: site.path, value: Number.parseInt(match[1], 10) });
  }

  if (readings.length !== CEILING_SITES.length) return null;

  const distinct = [...new Set(readings.map((r) => r.value))];
  if (distinct.length !== 1) {
    fail(
      `The three statements of max_locks_per_transaction disagree:\n` +
        readings.map((r) => `    ${String(r.value).padStart(5)}  ${r.path}`).join("\n") +
        `\n  They are three mechanisms for one fact — a compose argument, an ALTER SYSTEM ` +
        `plus restart, and the floor the harness asserts — and the drift that matters is ` +
        `silent: lock exhaustion reproducing in one environment only.`,
    );
    return null;
  }

  return distinct[0];
}

function main() {
  const enforcedCeiling = resolveEnforcedCeiling();

  const { tests: testFiles, others: nonTestFiles } = findSourceFiles();
  // Vacuity floor. A walk that found nothing satisfies the headroom check
  // outright, and "I found fewer files" and "there are fewer files" look
  // identical from the outside.
  if (testFiles.length === 0) {
    fail(
      `Found no *.test.ts files under packages/backend/src at all. This guard's whole ` +
        `subject is how many of them migrate their own database, so a walk that found ` +
        `none has measured nothing rather than found a suite that is cheap.`,
    );
  }

  const privateDatabaseFiles = testFiles.filter((file) =>
    stripComments(readFileSync(file, "utf8")).includes(PRIVATE_DATABASE_MARKER),
  );
  if (testFiles.length > 0 && privateDatabaseFiles.length === 0) {
    fail(
      `Found ${String(testFiles.length)} test files and not one calling ` +
        `${PRIVATE_DATABASE_MARKER}. That is the call this census is keyed on, so either ` +
        `every private-database file was removed — in which case delete this guard — or ` +
        `the harness renamed it and the census is now blind.`,
    );
  }

  // A census over TEST files cannot see a database opened by a helper they
  // import, and it would undercount by exactly as many test files as use it.
  // So a non-test module reaching the marker is a hard failure rather than a
  // silent zero — the definition itself excepted, recognised by its export so
  // that renaming the file does not turn it into a twelfth database.
  for (const file of nonTestFiles) {
    const source = stripComments(readFileSync(file, "utf8"));
    if (!source.includes(PRIVATE_DATABASE_MARKER)) continue;
    if (source.includes(MARKER_DEFINITION)) continue;
    fail(
      `${file.slice(repositoryRoot.length + 1)} calls ${PRIVATE_DATABASE_MARKER} and is not ` +
        `a test file. This census counts TEST files, so a helper that opens a database is ` +
        `charged once however many files import it — an undercount, in the direction that ` +
        `passes. Move the call into the test files, or teach this guard how to attribute it.`,
    );
  }

  const journalRaw = readIfPresent("packages/backend/drizzle/meta/_journal.json");
  let journalEntries = 0;
  if (journalRaw === null) {
    fail(`packages/backend/drizzle/meta/_journal.json is missing, so the chain length is unknown.`);
  } else {
    let parsed;
    try {
      parsed = JSON.parse(journalRaw);
    } catch {
      parsed = null;
    }
    if (!parsed || !Array.isArray(parsed.entries) || parsed.entries.length === 0) {
      fail(
        `packages/backend/drizzle/meta/_journal.json holds no migration entries. The ` +
          `projection below charges every migration added since the measurement, so a ` +
          `chain length of zero would project a capacity larger than anything measured.`,
      );
    } else {
      journalEntries = parsed.entries.length;
    }
  }

  const measurement =
    enforcedCeiling === null
      ? null
      : MEASUREMENTS.find((entry) => entry.ceiling === enforcedCeiling);

  if (enforcedCeiling !== null && !measurement) {
    fail(
      `max_locks_per_transaction is set to ${String(enforcedCeiling)} and nobody has ` +
        `measured what that carries. Recorded ceilings: ` +
        `${MEASUREMENTS.map((m) => String(m.ceiling)).join(", ")}.\n` +
        `  Raising the ceiling without measuring at it leaves this guard comparing the ` +
        `suite against a capacity it inferred, which is the defect #849 is about rather ` +
        `than a smaller version of it. Run:\n` +
        `    packages/backend/scripts/lock-capacity-probe.ts\n` +
        `  and add the row, with the chain length and date it was taken at.`,
    );
  }

  let projectedCapacity = 0;
  let projectedLockCost = 0;
  if (measurement && journalEntries > 0) {
    // A shorter chain than the measurement's is not a licence to claim MORE
    // capacity than was measured: migrations are not removed in practice, and a
    // projection that grew on a truncated journal would be an inference dressed
    // as a measurement.
    const migrationsSince = Math.max(0, journalEntries - measurement.journalEntries);
    projectedLockCost =
      measurement.locksPerMigration + MARGINAL_LOCKS_PER_MIGRATION * migrationsSince;
    const usableLockSlots = measurement.capacity * measurement.locksPerMigration;
    projectedCapacity = Math.floor(usableLockSlots / projectedLockCost);
  }

  const required = privateDatabaseFiles.length + SHARED_GLOBAL_SETUP_DATABASES;

  if (measurement && journalEntries > 0 && privateDatabaseFiles.length > 0) {
    if (required > projectedCapacity) {
      fail(
        `The backend suite wants ${String(required)} concurrent migrations and the server ` +
          `is projected to carry ${String(projectedCapacity)}.\n` +
          `    ${String(privateDatabaseFiles.length)} private-database realdb files ` +
          `(each migrates its own database)\n` +
          `  + ${String(SHARED_GLOBAL_SETUP_DATABASES)} shared globalSetup database\n` +
          `  = ${String(required)} concurrent full-chain migrations against one shared lock table.\n` +
          `\n` +
          `  Measured ${String(measurement.capacity)} at ` +
          `max_locks_per_transaction=${String(measurement.ceiling)} on ` +
          `${measurement.measuredOn} with a ${String(measurement.journalEntries)}-entry chain; ` +
          `the chain is now ${String(journalEntries)}, which charges ` +
          `${String(Math.round(projectedLockCost))} locks per migration and leaves ` +
          `${String(projectedCapacity)}.\n` +
          `\n` +
          `  Past that the failure is "out of shared memory" mid-migration, in whichever ` +
          `files happen to overlap — it will not look like this file's doing.\n` +
          `\n` +
          `  Raise max_locks_per_transaction in all three places, MEASURE what the new ` +
          `ceiling carries with packages/backend/scripts/lock-capacity-probe.ts, and record ` +
          `the row in ${GUARD_PATH}.`,
      );
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`Postgres lock capacity: ${String(failures.length)} problem(s)\n\n`);
    for (const message of failures) process.stderr.write(`  - ${message}\n\n`);
    process.exit(1);
  }

  process.stdout.write(
    `Postgres lock capacity OK — ${String(privateDatabaseFiles.length)} private-database ` +
      `realdb files + ${String(SHARED_GLOBAL_SETUP_DATABASES)} shared = ${String(required)} ` +
      `concurrent migrations; projected capacity ${String(projectedCapacity)} at ` +
      `max_locks_per_transaction=${String(enforcedCeiling)} ` +
      `(measured ${String(measurement ? measurement.capacity : 0)} at ` +
      `${String(measurement ? measurement.journalEntries : 0)} entries on ` +
      `${measurement ? measurement.measuredOn : "never"}, chain now ` +
      `${String(journalEntries)}). Headroom: ${String(projectedCapacity - required)} file(s).\n`,
  );
}

main();
