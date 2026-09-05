/**
 * Every job this runner OWNS is also a job it TICKS.
 *
 * Two hand-written lists state two different facts and they have to agree:
 * `PAYMENT_RECONCILIATION_JOBS` is the vocabulary `runOnePage` dispatches and
 * refuses against, and `JOB_ORDER` is what the timer actually walks. Nothing in
 * the types connects them, and the failure when they drift is silent in the
 * worst direction — a job in the vocabulary but not in the order is dispatched
 * correctly whenever somebody calls `runReconciliationJob` by hand, so its
 * tests pass, while the timer never runs it. Its cursor row is never created,
 * so it does not even appear in the operator metrics' `cursors` list, where a
 * stale `lastCompletedAt` is the alert. Absent, it reads as "not configured".
 *
 * `JOB_ORDER` is deliberately NOT derived from the tuple: the order is a
 * decision (open payments first because it can still prevent harm; withheld
 * transfers last because releasing one needs fresh account readiness), and a
 * sort is not a decision. So the list stays hand-written and this binds it.
 */

import { describe, expect, it } from 'vitest';
import { PAYMENT_RECONCILIATION_JOBS, RECONCILIATION_JOBS } from '@mercaria/shared-types';
import { JOB_ORDER } from '../runner.js';

describe('the sweeps the runner ticks', () => {
  it('ticks every job it owns, exactly once', () => {
    // Set equality plus a length check, because two lists compared as sets
    // agree just as happily when a member is duplicated — and a duplicated job
    // is a sweep that takes its own lease twice per tick, where the second
    // claim silently finds the row held and does nothing.
    expect(JOB_ORDER.length).toBe(PAYMENT_RECONCILIATION_JOBS.length);
    expect([...JOB_ORDER].sort()).toEqual([...PAYMENT_RECONCILIATION_JOBS].sort());
  });

  it('is not vacuously satisfied by two empty lists', () => {
    // The floor. Deleting both lists would satisfy the case above, and this is
    // what would notice. Five is what ships today; a sixth sweep raises it here
    // in the same commit, which is the point at which somebody re-reads the
    // order rather than appending to it.
    expect(JOB_ORDER.length).toBe(5);
  });

  it('owns a strict subset of the reconciliation vocabulary', () => {
    // `retail_reconciliation` takes a cursor row in the same table and is run by
    // `services/retail-reconciliation/runner.ts`, because `role-separation.test.ts`
    // forbids this directory from importing the procurement domain. If it ever
    // appeared here, the two runners would race for one lease.
    const owned = new Set<string>(PAYMENT_RECONCILIATION_JOBS);
    const unowned = RECONCILIATION_JOBS.filter((job) => !owned.has(job));
    expect(unowned).toEqual(['retail_reconciliation']);
  });
});
