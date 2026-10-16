/**
 * A sweep that cannot run is SKIPPED with a reason, never silently absent.
 *
 * `startPaymentReconciler` once opened with a check on one rail's flag — the
 * whole timer, off, on any deployment without that rail, with no log line.
 * Payments book the ledger on every booking rail (`mock` included), so
 * `ledger_audit` — the one sweep whose job is to notice a succeeded payment with
 * no charge behind it — had a real question to ask and a timer that never
 * started to ask it. `withheld_transfers` is the same: it re-enters settlement
 * through the provider PORT and is the ONLY thing that releases a held payout.
 *
 * That is the shape this file guards. "Not configured" and "never ran" looked
 * identical from outside, and the second is the one that hides a finding.
 */

import { describe, expect, it } from 'vitest';
import { PAYMENT_RECONCILIATION_JOBS } from '@mercaria/shared-types';
import { config } from '../../../../config/index.js';
import {
  JOB_ORDER,
  isPaymentReconcilerRunning,
  reconciliationJobIsServable,
  startPaymentReconciler,
  stopPaymentReconciler,
} from '../runner.js';

describe('which sweeps a deployment can serve', () => {
  it('runs the two that read only Mercaria rows, whatever rail is configured', () => {
    // These two must hold on EVERY deployment, including one with no payment
    // rail at all. `ledger_audit` derives its provider list from
    // `PROVIDER_BOOKS_LEDGER`, which includes `mock`; `withheld_transfers` goes
    // through the port and resolves whichever rail the payment names.
    expect(reconciliationJobIsServable('ledger_audit')).toBe(true);
    expect(reconciliationJobIsServable('withheld_transfers')).toBe(true);
  });

  it('holds the one that genuinely needs a rail read to that rail', () => {
    // Asserted as "agrees with the config", not as a fixed boolean: the suite
    // runs with Peable off, and hard-coding `false` here would pass for the
    // wrong reason the day someone turned it on.
    expect(reconciliationJobIsServable('open_payments')).toBe(config.payments.peable.enabled);
  });

  it('answers for every job the runner actually ticks', () => {
    // The totality that matters at runtime. `JOB_REQUIRES_RAIL` is a total
    // record over `ReconciliationJob` so the COMPILER catches a new sweep, but
    // a compiler check cannot see a job added to `JOB_ORDER` and left out of the
    // predicate's reachable branches.
    for (const job of JOB_ORDER) {
      expect([job, typeof reconciliationJobIsServable(job)]).toEqual([job, 'boolean']);
    }
  });

  it('is not vacuously satisfied by an empty job order', () => {
    // The floor. Every case above passes over an empty `JOB_ORDER`, and an empty
    // one means a reconciler that ticks nothing — which is precisely the state
    // this file exists to make impossible to reach quietly.
    expect(JOB_ORDER.length).toBe(PAYMENT_RECONCILIATION_JOBS.length);
    expect(JOB_ORDER.length).toBeGreaterThanOrEqual(3);
  });

  it('leaves at least one sweep runnable on a deployment with no rail configured', () => {
    // The property in one line, and the one that was false before this change.
    // If this ever goes to zero, a deployment can boot a reconciler that can
    // never find anything and report itself started.
    expect(JOB_ORDER.some((job) => reconciliationJobIsServable(job))).toBe(true);
  });

  /**
   * The change itself, observed rather than inferred.
   *
   * Every case above is about the PREDICATE, and all of them keep passing with
   * a rail-flag gate restored at the top of `startPaymentReconciler` — because
   * the predicate is never reached when the loop never starts. That gap is
   * exactly the bug's shape one level up, so it gets its own case.
   *
   * This suite runs with the card rail OFF, which is what makes the observation
   * discriminating: under a rail gate the timer is never created.
   */
  it('starts the loop on a deployment with no card rail', () => {
    expect(config.payments.peable.enabled).toBe(false);

    try {
      startPaymentReconciler();
      expect(isPaymentReconcilerRunning()).toBe(true);
    } finally {
      // Always, even on failure: a live interval would outlast this file and
      // tick against another suite's database.
      stopPaymentReconciler();
    }
    expect(isPaymentReconcilerRunning()).toBe(false);
  });
});
