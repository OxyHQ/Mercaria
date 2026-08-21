/**
 * How many concurrent real migrations a Postgres server can carry — issue #849.
 *
 * `docker-compose.postgres.yml` raises `max_locks_per_transaction` above its
 * default because every realdb file that creates its OWN throwaway database
 * migrates it with the real migrator, which applies the whole chain in ONE
 * transaction and therefore holds every object lock it takes until commit.
 * PostgreSQL sizes ONE shared lock table from
 * `max_locks_per_transaction * (max_connections + max_prepared_transactions)`,
 * so those migrations contend for a single pool rather than each getting their
 * own budget.
 *
 * The number that sizing rests on is a MEASUREMENT, and a measurement of this
 * shrinks as the migration chain grows: a longer chain is more objects locked
 * inside one transaction, so the same ceiling carries fewer concurrent
 * migrations than it did. #849 was filed because that number had been quoted
 * forward from an earlier chain instead of re-derived. This script is how it is
 * re-derived.
 *
 * ## Running it
 *
 * The server must ALREADY be running at the ceiling under test.
 * `max_locks_per_transaction` is `postmaster` context, so neither `PGOPTIONS`
 * nor `ALTER SYSTEM` reaches a running server without a restart — which is why
 * this script takes a server rather than trying to configure one. Use a
 * DEDICATED server: it creates and drops databases, and a probe that escalates
 * until the shared lock table is exhausted takes every other connection on that
 * server down with it.
 *
 * ```sh
 * docker run -d --name lock-probe-pg -p 127.0.0.1:5849:5432 \
 *   -e POSTGRES_USER=mercaria -e POSTGRES_PASSWORD=mercaria -e POSTGRES_DB=mercaria_probe \
 *   postgis/postgis:17-3.5 postgres -c max_locks_per_transaction=256
 *
 * cd packages/backend
 * LOCK_CAPACITY_PROBE=1 \
 *   LOCK_PROBE_ADMIN_URL=postgres://mercaria:mercaria@127.0.0.1:5849/mercaria_probe \
 *   bun run scripts/lock-capacity-probe.ts --from=8 --to=16
 * ```
 *
 * `LOCK_CAPACITY_PROBE=1` is a second gate on top of the explicit invocation.
 * The script drops every database it creates and nothing else, but it drives a
 * server to `out of shared memory` on purpose, and that is not something to do
 * to a server somebody is mid-migration against.
 *
 * ## What it reports, and why each field is there
 *
 * A capacity figure is only a capacity figure if the migrations it counts were
 * genuinely SIMULTANEOUS. N subprocesses that ran one after another all succeed
 * at any ceiling and report a capacity the server does not have, and the two
 * outcomes are indistinguishable from the exit codes alone. So every round
 * carries two independent witnesses of overlap:
 *
 *   - `maxIntervalOverlap` — the largest number of migrations whose wall-clock
 *     windows intersected, swept from the recorded start/end instants.
 *   - `peakLocks` — the highest `pg_locks` count sampled while the round ran.
 *     A round that overlapped shows roughly N times one migration's lock cost;
 *     a round that did not shows roughly one.
 *
 * A round whose `maxIntervalOverlap` is below N MEASURED NOTHING about capacity
 * at N, and is reported as `vacuous` rather than as a pass.
 */

import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMercariaTestDatabase, dropMercariaTestDatabase } from '../src/db/testDatabase.js';

/** This package's root — where `package.json` and `drizzle/` live. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The text PostgreSQL uses when the shared lock table is exhausted. */
const LOCK_EXHAUSTION_MARKER = 'out of shared memory';

/** How often the lock sampler asks the server how many locks are held. */
const LOCK_SAMPLE_INTERVAL_MS = 150;

interface ProbeOptions {
  from: number;
  to: number;
}

/** One migration's wall-clock window, in epoch milliseconds. */
interface MigrationWindow {
  startedAt: number;
  endedAt: number;
  outcome: 'migrated' | 'lock_exhausted' | 'other_failure';
  detail: string;
}

interface RoundResult {
  concurrency: number;
  migrated: number;
  lockExhausted: number;
  otherFailures: number;
  maxIntervalOverlap: number;
  peakLocks: number;
  /**
   * `carried` — every migration finished and they genuinely overlapped.
   * `exhausted` — at least one failed with `out of shared memory`.
   * `other_failure` — something failed that was not lock exhaustion, so this
   * round says nothing about the lock table.
   * `vacuous` — the migrations did not overlap N-wide, so the round measured
   * nothing at this concurrency whatever its exit codes were.
   */
  verdict: 'carried' | 'exhausted' | 'other_failure' | 'vacuous';
}

function readNumericFlag(argv: readonly string[], name: string, fallback: number): number {
  const prefix = `--${name}=`;
  for (const arg of argv) {
    if (!arg.startsWith(prefix)) continue;
    const parsed = Number.parseInt(arg.slice(prefix.length), 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      throw new Error(`Unrecognised ${prefix}${arg.slice(prefix.length)} — expected a positive integer.`);
    }
    return parsed;
  }
  return fallback;
}

/** The number of entries in the migration journal — the chain this was measured at. */
function readJournalEntryCount(): number {
  const journalPath = join(PACKAGE_ROOT, 'drizzle', 'meta', '_journal.json');
  const parsed: unknown = JSON.parse(readFileSync(journalPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed)) {
    throw new Error(`${journalPath} has no "entries" array — cannot report the chain length.`);
  }
  const entries = (parsed as { entries: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error(`${journalPath}'s "entries" is not an array.`);
  }
  return entries.length;
}

/**
 * The largest number of windows that were open at the same instant.
 *
 * Swept over start/end events rather than compared pairwise, so it is the real
 * simultaneity of the round and not an assumption that launching together means
 * running together.
 */
function maxOverlap(windows: readonly MigrationWindow[]): number {
  const events: { at: number; delta: number }[] = [];
  for (const window of windows) {
    events.push({ at: window.startedAt, delta: 1 });
    events.push({ at: window.endedAt, delta: -1 });
  }
  // Ends before starts at an equal instant, so two windows that merely touch
  // are not counted as overlapping.
  events.sort((a, b) => (a.at === b.at ? a.delta - b.delta : a.at - b.at));

  let open = 0;
  let peak = 0;
  for (const event of events) {
    open += event.delta;
    if (open > peak) peak = open;
  }
  return peak;
}

/**
 * Sample `pg_locks` until stopped, returning the highest count seen.
 *
 * On its own connection, because the connections under test are inside their
 * migration transactions and cannot answer.
 */
function startLockSampler(adminUrl: string): { stop: () => Promise<number> } {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  let peak = 0;
  let running = true;

  const loop = (async () => {
    while (running) {
      try {
        const [row] = await sql<{ held: string }[]>`select count(*)::text as held from pg_locks`;
        if (row) {
          const held = Number.parseInt(row.held, 10);
          if (!Number.isNaN(held) && held > peak) peak = held;
        }
      } catch (reason: unknown) {
        // A sample that could not be taken is a missing sample, not a failure of
        // the probe: the server may be refusing new work precisely because the
        // round under test is exhausting it, which is the outcome being measured.
        // Reported rather than swallowed, so a sampler that never sampled is
        // visible instead of reading as a peak of zero.
        process.stdout.write(`    lock sample skipped: ${reason instanceof Error ? reason.message : String(reason)}\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_SAMPLE_INTERVAL_MS));
    }
  })();

  return {
    stop: async () => {
      running = false;
      await loop;
      await sql.end({ timeout: 5 });
      return peak;
    },
  };
}

/** Classify one migration failure without swallowing what it actually said. */
function classifyFailure(reason: unknown): { outcome: 'lock_exhausted' | 'other_failure'; detail: string } {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return {
    outcome: detail.includes(LOCK_EXHAUSTION_MARKER) ? 'lock_exhausted' : 'other_failure',
    detail,
  };
}

/** Run N real migrations concurrently against `adminUrl` and report what happened. */
async function runRound(adminUrl: string, concurrency: number): Promise<RoundResult> {
  const sampler = startLockSampler(adminUrl);
  const created: string[] = [];

  const settled = await Promise.allSettled(
    Array.from({ length: concurrency }, async (): Promise<MigrationWindow> => {
      const startedAt = Date.now();
      try {
        const url = await createMercariaTestDatabase(adminUrl);
        created.push(url);
        return { startedAt, endedAt: Date.now(), outcome: 'migrated', detail: '' };
      } catch (reason: unknown) {
        const classified = classifyFailure(reason);
        return { startedAt, endedAt: Date.now(), outcome: classified.outcome, detail: classified.detail };
      }
    }),
  );

  const peakLocks = await sampler.stop();

  const windows: MigrationWindow[] = [];
  for (const entry of settled) {
    // Every task returns a window rather than throwing, so a rejection here is
    // the probe itself failing and must not be counted as a migration outcome.
    if (entry.status === 'rejected') {
      throw new Error(`The probe's own task rejected: ${String(entry.reason)}`);
    }
    windows.push(entry.value);
  }

  for (const url of created) {
    await dropMercariaTestDatabase(url);
  }

  const migrated = windows.filter((w) => w.outcome === 'migrated').length;
  const lockExhausted = windows.filter((w) => w.outcome === 'lock_exhausted').length;
  const otherFailures = windows.filter((w) => w.outcome === 'other_failure').length;
  const overlap = maxOverlap(windows);

  let verdict: RoundResult['verdict'];
  if (overlap < concurrency) verdict = 'vacuous';
  else if (otherFailures > 0) verdict = 'other_failure';
  else if (lockExhausted > 0) verdict = 'exhausted';
  else verdict = 'carried';

  const firstOther = windows.find((w) => w.outcome === 'other_failure');
  if (firstOther) {
    process.stdout.write(`    first non-lock failure: ${firstOther.detail.slice(0, 400)}\n`);
  }

  return { concurrency, migrated, lockExhausted, otherFailures, maxIntervalOverlap: overlap, peakLocks, verdict };
}

/** Report the server's own view of the lock table it was started with. */
async function readServerSettings(adminUrl: string): Promise<Record<string, string>> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<{ name: string; setting: string }[]>`
      select name, setting from pg_settings
      where name in ('max_locks_per_transaction', 'max_connections', 'max_prepared_transactions', 'server_version')
      order by name
    `;
    const out: Record<string, string> = {};
    for (const row of rows) out[row.name] = row.setting;
    return out;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  if (process.env.LOCK_CAPACITY_PROBE !== '1') {
    throw new Error(
      'Refusing to run without LOCK_CAPACITY_PROBE=1. This probe drives a Postgres server to ' +
        '"out of shared memory" on purpose; point it at a dedicated server, never at one anybody ' +
        'else is using. See the header for a one-line `docker run`.',
    );
  }

  const adminUrl = process.env.LOCK_PROBE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error('LOCK_PROBE_ADMIN_URL is required — a server this probe may create and drop databases on.');
  }

  const options: ProbeOptions = {
    from: readNumericFlag(process.argv, 'from', 1),
    to: readNumericFlag(process.argv, 'to', 16),
  };
  if (options.to < options.from) {
    throw new Error(`--to=${String(options.to)} is below --from=${String(options.from)}.`);
  }

  const settings = await readServerSettings(adminUrl);
  const journalEntries = readJournalEntryCount();

  process.stdout.write('# Concurrent-migration lock capacity\n\n');
  process.stdout.write(`measuredOn:            ${new Date().toISOString()}\n`);
  process.stdout.write(`journalEntries:        ${String(journalEntries)}\n`);
  for (const [name, value] of Object.entries(settings)) {
    process.stdout.write(`${name.padEnd(22)} ${value}\n`);
  }
  process.stdout.write('\n');

  const results: RoundResult[] = [];
  for (let concurrency = options.from; concurrency <= options.to; concurrency += 1) {
    process.stdout.write(`N=${String(concurrency)} …\n`);
    const result = await runRound(adminUrl, concurrency);
    results.push(result);
    process.stdout.write(
      `  ${result.verdict.padEnd(14)} migrated=${String(result.migrated)} ` +
        `lockExhausted=${String(result.lockExhausted)} other=${String(result.otherFailures)} ` +
        `maxIntervalOverlap=${String(result.maxIntervalOverlap)} peakLocks=${String(result.peakLocks)}\n`,
    );
    if (result.verdict === 'exhausted' || result.verdict === 'other_failure') break;
  }

  const carried = results.filter((r) => r.verdict === 'carried');
  const highestCarried = carried.length > 0 ? carried[carried.length - 1].concurrency : 0;
  const firstExhausted = results.find((r) => r.verdict === 'exhausted');

  process.stdout.write('\n## Result\n');
  process.stdout.write(`highestCarried:        ${String(highestCarried)}\n`);
  process.stdout.write(
    `firstExhausted:        ${firstExhausted ? String(firstExhausted.concurrency) : 'not reached in this range'}\n`,
  );
  process.stdout.write(
    'Record BOTH numbers with the journalEntries and measuredOn above. A capacity without the\n' +
      'chain length it was taken at cannot expire visibly, which is the defect #849 is about.\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
