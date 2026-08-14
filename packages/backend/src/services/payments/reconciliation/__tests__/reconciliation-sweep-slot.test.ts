/**
 * Every realdb file that touches `payment_discrepancies` takes the sweep slot.
 *
 * The hazard this gates is not a wrong query — it is a CORRECT one running
 * concurrently. `recordDiscrepancy` upserts on `(kind, correlation_key)` and
 * REOPENS a resolved row, deliberately; `auditOpenPayables` is an aggregate over
 * the whole of `ledger_entries` bounded only by an age buffer that
 * `reconciliation.realdb.test.ts` sets to zero. So a globally-driven sweep in one
 * file destroys an operator resolution another file just asserted, and the
 * failure surfaces in the VICTIM as `expected 'open' to be 'resolved'`, naming
 * nothing about the cause. `reconciliation-sweep-slot.ts` is the mutex; this is
 * what stops a third file joining without it.
 *
 * ## Exact identity, never containment
 *
 * The toucher set is asserted EQUAL to the holder set and its size is pinned. A
 * containment check ("every toucher also holds") passes when a file stops
 * touching, and a floor that only grows is how a gate switches itself off one
 * defensible line at a time. Pinning the size is what makes a NEW toucher fail
 * the build rather than widen the list.
 *
 * ## It does not strip comments, and that is the same trade `store-teardown-census`
 * made
 *
 * Comment stripping truncates at a `//` inside a string literal and can hide a
 * real call — the direction that costs something. A comment quoting a call is a
 * false POSITIVE: the build fails loudly and is fixed in one line. The detectors
 * therefore match CALL shapes (`name(`), which prose is unlikely to contain, and
 * the probes below are assembled from fragments so this file cannot become the
 * offender it is looking for.
 *
 * ## Its own vacuity floors
 *
 * A walk that found no files, or a detector that matched nothing, reads exactly
 * like a clean estate. So the number of realdb files walked has a floor, the
 * toucher set has an exact size, and every detector is mutation-tested against
 * literal buffers below — including a near-miss that must NOT match.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * Floor on the walk itself. 93 `*.realdb.test.ts` files exist today; 60 is well
 * below that and well above zero, so it catches a broken walk without failing on
 * ordinary growth or on a file somebody legitimately deletes.
 */
const REALDB_FILE_FLOOR = 60;

/**
 * Assembled from fragments so this file's own prose cannot match them.
 *
 * Each names a way to reach `payment_discrepancies` — DIRECTLY (the two
 * recorder entry points, and the reader a victim asserts through) or by
 * DISPATCH (a sweep entry point whose job modules record).
 *
 * The dispatch half is the one worth reading. `runner.ts` itself contains no
 * `reportDiscrepancy(` call at all: it reaches the table only by calling the
 * four job modules, which between them hold sixteen (open-payments 3,
 * provider-objects 8, account-readiness 2, ledger-audit 3). So a realdb file
 * driving `runReconciliationJob(` writes discrepancy rows — including
 * `auditLedgerPage`'s `cursor: null` global checks — without spelling any
 * direct recorder call, and a gate naming only the direct ones would stay green
 * while an unslotted third claimant joined. That gap was real: this file's own
 * driver passes today only INCIDENTALLY, because it happens to spell
 * `auditLedgerPage(` as well.
 *
 * Four of these match no realdb file today, which is deliberate: they exist for
 * the file nobody has written yet, and the mutation self-test below is what
 * keeps them from being decoration.
 *
 * `reconcileOnePayment(` is deliberately ABSENT — it is aimed at one payment id
 * by construction, so it cannot collide with a sibling's rows, and detecting it
 * would force a future well-behaved file to serialize for nothing.
 */
const DISCREPANCY_CALLS: readonly RegExp[] = [
  new RegExp(`${'report'}${'Discrepancy'}\\s*\\(`, 'u'),
  new RegExp(`${'record'}${'Discrepancy'}\\s*\\(`, 'u'),
  new RegExp(`${'find'}${'DiscrepancyById'}\\s*\\(`, 'u'),
  new RegExp(`${'close'}${'Discrepancy'}\\s*\\(`, 'u'),
  new RegExp(`${'audit'}${'LedgerPage'}\\s*\\(`, 'u'),
  new RegExp(`${'run'}${'ReconciliationJob'}\\s*\\(`, 'u'),
  new RegExp(`${'reconcile'}${'OpenPaymentsPage'}\\s*\\(`, 'u'),
  new RegExp(`${'reconcile'}${'ProviderObjectsPage'}\\s*\\(`, 'u'),
  new RegExp(`${'reconcile'}${'AccountReadiness'}\\s*\\(`, 'u'),
];

/** Taking the mutex. */
const ACQUIRES_SLOT = new RegExp(`${'acquire'}${'ReconciliationSweepSlot'}\\s*\\(`, 'u');

/** Every `*.realdb.test.ts` under `src/`, as paths relative to `src/`. */
function realdbFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.realdb.test.ts')) found.push(relative(SRC_ROOT, full).split(sep).join('/'));
    }
  };
  walk(SRC_ROOT);
  return found.sort();
}

function touchesDiscrepancies(source: string): boolean {
  return DISCREPANCY_CALLS.some((pattern) => pattern.test(source));
}

function holdsSlot(source: string): boolean {
  return ACQUIRES_SLOT.test(source);
}

describe('the reconciliation sweep slot', () => {
  const files = realdbFiles();

  it('walked a plausible number of realdb files', () => {
    expect(files.length).toBeGreaterThanOrEqual(REALDB_FILE_FLOOR);
  });

  it('is held by EXACTLY the realdb files that touch payment_discrepancies', () => {
    const touchers: string[] = [];
    const holders: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(SRC_ROOT, file), 'utf8');
      if (touchesDiscrepancies(source)) touchers.push(file);
      if (holdsSlot(source)) holders.push(file);
    }

    // The floor that stops a broken detector reading as a clean estate. Two
    // files touch this table today and both must be found.
    expect(touchers, 'the detectors matched nothing, so this gate measured nothing').toHaveLength(2);
    expect(touchers).toEqual(holders);
  });

  it('detects a toucher that does not hold the slot, and only a real call', () => {
    // The mutation self-test: each detector must fire on a real call shape and
    // must not fire on the near-miss. Built from fragments, as above.
    const call = `await ${'report'}${'Discrepancy'}({ kind: 'ledger_unbalanced' });`;
    const acquire = `${'sweepSlot'} = await ${'acquire'}${'ReconciliationSweepSlot'}(db);`;

    expect(touchesDiscrepancies(call)).toBe(true);
    expect(holdsSlot(call)).toBe(false);
    expect(holdsSlot(`${call}\n${acquire}`)).toBe(true);

    // A near miss: a DIFFERENT symbol that merely starts the same way must not
    // be read as a call to the recorder, or the gate would fail files that
    // reach nothing.
    const nearMiss = `const ${'report'}${'DiscrepancyCount'} = 3;`;
    expect(touchesDiscrepancies(nearMiss)).toBe(false);
  });

  it('fires on EVERY detected call shape, and on none of their near misses', () => {
    // Four of the nine detectors match no realdb file today, so the census
    // above cannot prove they work — a pattern that stopped matching would read
    // exactly like a well-behaved estate. Each one is exercised here against a
    // real call and against the same identifier with a suffix, so a broken
    // pattern and an over-broad one both fail rather than reading as clean.
    const names: readonly string[] = [
      `${'report'}${'Discrepancy'}`,
      `${'record'}${'Discrepancy'}`,
      `${'find'}${'DiscrepancyById'}`,
      `${'close'}${'Discrepancy'}`,
      `${'audit'}${'LedgerPage'}`,
      `${'run'}${'ReconciliationJob'}`,
      `${'reconcile'}${'OpenPaymentsPage'}`,
      `${'reconcile'}${'ProviderObjectsPage'}`,
      `${'reconcile'}${'AccountReadiness'}`,
    ];

    // The floor: as many probes as detectors, so dropping a detector without
    // dropping its probe leaves this list longer than the patterns it exercises.
    expect(names).toHaveLength(DISCREPANCY_CALLS.length);

    for (const name of names) {
      expect(touchesDiscrepancies(`await ${name}(db, { limit: 500 });`), name).toBe(true);
      // The house spelling breaks a long call across lines; a line-based
      // detector would read that as clean.
      expect(touchesDiscrepancies(`await ${name}\n  (db);`), `${name} (wrapped)`).toBe(true);
      expect(touchesDiscrepancies(`const ${name}Count = 3;`), `${name} (near miss)`).toBe(false);
      expect(holdsSlot(`await ${name}(db);`), `${name} (not the slot)`).toBe(false);
    }
  });
});
