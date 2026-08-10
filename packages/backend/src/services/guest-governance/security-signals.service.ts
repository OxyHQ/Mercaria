/**
 * Security monitoring (#111 "Security monitoring").
 *
 * ## The signature is the guarantee, exactly as it is for analytics
 *
 * `recordSecuritySignal` returns `void`, not `Promise<void>`. A caller has
 * nothing to await, so a monitoring write can never join a request's critical
 * path and a caller who tried gets `Property 'then' does not exist on type
 * 'void'` from `tsc`. `services/analytics/sink.ts` established the shape and
 * the reasoning is identical: a counter that could block a checkout is a
 * counter that will one day block a checkout.
 *
 * The consequence is stated rather than hidden: signal counts are LOSSY under a
 * database outage. That is acceptable here for the same reason it is in
 * analytics — no number in this table is financial truth, and every one of the
 * critical signals has a durable record behind it that a reconciliation can
 * recount from (`payment_discrepancies` for the payment ones,
 * `guest_order_claims` for the claim conflict, the row counts themselves for
 * cleanup lag).
 *
 * ## An alert may carry ids and never values
 *
 * `GUEST_SECURITY_SIGNAL_REGISTER` names the correlation handles each signal is
 * allowed, and every member of `GUEST_SIGNAL_CORRELATION_KINDS` is a
 * Mercaria-minted id that authorizes nothing. There is no member for a token,
 * an email, an address or a card, so an alert composer has nothing unsafe to
 * reach for — the `tracePayment` five-handle device.
 */

import type { GuestSecuritySignal } from '@mercaria/shared-types';
import { GUEST_SECURITY_SIGNAL_REGISTER } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import {
  countSecuritySignal,
  readSignalTotals,
  type SignalTotal,
} from '../../db/guestGovernance/signalRepository.js';
import { countOverdueGuestRows } from '../../db/guestGovernance/retentionRepository.js';
import { windowStartFor } from './subject.js';

/**
 * Count one observation of one signal. Returns immediately.
 *
 * The write is detached and its rejection swallowed with a log line — the third
 * deliberate swallow in this codebase, after the analytics sink's flush and its
 * identity derivation, and for the same reason: a failure here means a database
 * problem worth a log line and worth nothing at all to the request that has
 * already been answered.
 */
export function recordSecuritySignal(signal: GuestSecuritySignal, delta = 1): void {
  if (delta <= 0) return;
  // `getDb()` THROWS when the pool is not open, so it must not be called
  // synchronously here. That is not a theoretical tidiness: the first caller
  // wired up was the CSRF refusal path, and a `csrf_failure` counter that threw
  // would have turned a clean 403 into a 500 — during a boot window, during a
  // database outage, and in every unit test of the middleware, which is how it
  // was found. A function that promises never to block a request has to keep
  // that promise when the database is the thing that is wrong.
  //
  // `Promise.resolve().then(...)` moves BOTH the handle lookup and the write
  // off the synchronous path, and the `catch` covers both.
  void Promise.resolve()
    .then(() =>
      countSecuritySignal(getDb(), {
        signal,
        windowStartedAt: windowStartFor(new Date(), config.guest.governance.signalWindowSeconds),
        delta,
      }),
    )
    .catch((error: unknown) => {
      log.guest.error({ err: error, signal }, '[GuestSignals] failed to record a security signal');
    });
}

/** One signal, with its definition attached — what a monitoring surface renders. */
export interface SecuritySignalReading {
  readonly signal: GuestSecuritySignal;
  readonly title: string;
  readonly severity: string;
  readonly runbook: string;
  readonly meaning: string;
  /** How many observations in the range. */
  readonly total: number;
  /** How many windows carried at least one. */
  readonly windows: number;
  /**
   * Whether this signal has EVER been recorded in the range.
   *
   * The load-bearing field. A signal that was observed zero times and one that
   * nothing in the deployment can emit both read `total: 0`, and they mean
   * opposite things — the first is a healthy system, the second is a monitor
   * that would stay silent through the incident it exists for.
   */
  readonly observed: boolean;
}

/**
 * Every signal over a range, with the ones that were never observed reported
 * as such rather than as zero.
 *
 * The register is the outer loop and the counts are joined ONTO it, which is
 * what makes an unobserved signal visible: reading the counters alone would
 * return fourteen rows on a deployment where the fifteenth has no emitter, and
 * nothing in that output would say the fifteenth exists.
 */
export async function readSecuritySignals(input: {
  since: Date;
  until: Date;
}): Promise<readonly SecuritySignalReading[]> {
  const totals = await readSignalTotals(getDb(), input);
  const bySignal = new Map<string, SignalTotal>(totals.map((row) => [row.signal, row]));
  return GUEST_SECURITY_SIGNAL_REGISTER.map((definition) => {
    const observed = bySignal.get(definition.signal);
    return {
      signal: definition.signal,
      title: definition.title,
      severity: definition.severity,
      runbook: definition.runbook,
      meaning: definition.meaning,
      total: observed?.total ?? 0,
      windows: observed?.windows ?? 0,
      observed: observed !== undefined,
    };
  });
}

/**
 * Measure the cleanup lag and record it (#111 security monitoring 9).
 *
 * A SWEEP rather than an event, because the thing being measured is an absence:
 * nothing happens when a retention job stops running, so there is no call site
 * to instrument. This counts the rows that are past a deadline the sweep has
 * not reached and records the count as one observation with that magnitude —
 * which is why `countSecuritySignal` takes a delta rather than always
 * incrementing by one.
 *
 * It returns the count so a caller can assert on it. `readSecuritySignals`
 * reports it as a number an operator watches, and #111 acceptance 2 is that it
 * stays near zero.
 */
export async function measureCleanupLag(now: Date): Promise<number> {
  const overdue = await countOverdueGuestRows(getDb(), now);
  if (overdue > 0) recordSecuritySignal('cleanup_lag', overdue);
  return overdue;
}
