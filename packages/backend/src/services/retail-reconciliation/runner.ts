/**
 * The leased, bounded, resumable sweep that reconciles retail orders (#128,
 * ADR 0004 D8.8).
 *
 * ## Why a SWEEP and not an event
 *
 * The evidence a reconciliation needs arrives from places that do not tell
 * anybody: a supplier issues an invoice into #124's document store, a credit
 * note lands weeks later, a dispute closes. #50 already states the rule this
 * follows — "webhooks are the normal event path and are NOT a substitute for
 * reconciliation: an event that was never delivered is invisible to everything
 * that waits to be told."
 *
 * ## It reuses `reconciliation_cursors` and NOT the payments runner
 *
 * The cursor table, the lease and the claim are the payment domain's and are
 * already right, so this takes a row there rather than growing a second lease
 * mechanism to get wrong. What it cannot share is the RUNNER: this reads
 * purchase orders and supplier invoices, and `role-separation.test.ts` (#118)
 * forbids anything under `services/payments/` from importing the procurement
 * domain. `PAYMENT_RECONCILIATION_JOBS` is the subset that runner dispatches,
 * and it now REFUSES any other job by name rather than falling through to one
 * of its own — which is what stops this job silently running the
 * account-readiness sweep.
 *
 * ## Bounded, resumable, idempotent
 *
 * One PAGE per tick, never a loop until done. The cursor advances only after a
 * page is fully handled, so a task that dies mid-page leaves it where it was and
 * the next run replays it — and a replayed page re-derives the same evidence
 * digest, so it writes no revision at all. Resumability and idempotency are the
 * same property here approached from two sides.
 *
 * ## The LOOP is gated; the records never are
 *
 * `RETAIL_RECONCILIATION_ENABLED=false` stops the timer and nothing else. An
 * operator reconciling an order by hand still writes its revision, still raises
 * its exceptions and still books what it recognizes — the payment outbox's rule,
 * for the same reason: switching a loop off during an incident should park work,
 * not lose the record of it. `retail-reconciliation-isolation.test.ts` fails the
 * build if any module but this one reads the flag.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  advanceReconciliationCursor,
  claimReconciliationRun,
  releaseReconciliationRun,
  RECONCILIATION_LEASE_MS,
} from '../../db/payments/reconciliationCursorRepository.js';
import { listRetailOrdersToReconcile } from '../../db/retailReconciliation/reconciliationRepository.js';
import { listOpenAdjustments } from '../../db/retailReconciliation/adjustmentRepository.js';
import { log } from '../../lib/logger.js';
import { settleRetailCustomerAdjustment } from './adjustment.service.js';
import { reconcileRetailOrder } from './reconciliation.service.js';
import { ingestSupplierCreditsForOrder } from './supplier-credit.service.js';

/** What one page did. */
export interface RetailReconciliationPage {
  scanned: number;
  revisions: number;
  adjustmentsCreated: number;
  adjustmentsSettled: number;
  blocked: number;
  /** `null` ends the pass: the cursor is cleared and a new one begins next tick. */
  nextCursor: string | null;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * Reconcile one page of retail orders.
 *
 * Exported so a test and an operator can drive a page deterministically rather
 * than waiting for a tick, and so a failure is visibly scoped to the page rather
 * than to "reconciliation".
 *
 * @returns `undefined` when another task holds the lease.
 */
export async function runRetailReconciliationPage(options?: {
  limit?: number;
  now?: Date;
}): Promise<RetailReconciliationPage | undefined> {
  const db = getDb();
  const now = options?.now ?? new Date();
  const limit = options?.limit ?? config.retailReconciliation.batchSize;
  const leaseOwner = `retail-reconciliation:${String(process.pid)}:${randomUUID()}`;

  const cursor = await claimReconciliationRun(db, {
    job: 'retail_reconciliation',
    leaseOwner,
    leaseMs: RECONCILIATION_LEASE_MS,
    now,
  });
  if (!cursor) return undefined;

  try {
    const page = await reconcilePage({ afterOrderId: cursor.cursor ?? undefined, limit, now });

    if (page.nextCursor === null) {
      await releaseReconciliationRun(db, {
        job: 'retail_reconciliation',
        leaseOwner,
        completed: true,
        now,
      });
    } else {
      // The cursor must be durable BEFORE the lease is given up — the reverse
      // order lets a second task claim the run and read a cursor that had not
      // moved, which replays a page that already succeeded.
      await advanceReconciliationCursor(db, {
        job: 'retail_reconciliation',
        leaseOwner,
        cursor: page.nextCursor,
        now,
      });
      await releaseReconciliationRun(db, {
        job: 'retail_reconciliation',
        leaseOwner,
        completed: false,
        now,
      });
    }
    if (page.blocked > 0) {
      log.general.warn(page, '[RetailReconciliation] a page left orders blocked on evidence');
    }
    return page;
  } catch (error: unknown) {
    // The lease is released and the CURSOR IS NOT MOVED, which is the whole of
    // resumability: the next run replays the page that threw, and a replayed
    // page re-derives the same digest and writes nothing twice.
    await releaseReconciliationRun(db, {
      job: 'retail_reconciliation',
      leaseOwner,
      completed: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      now,
    });
    log.general.error({ err: error }, '[RetailReconciliation] a sweep page failed');
    throw error;
  }
}

/** One page's work, without the lease around it. */
async function reconcilePage(input: {
  afterOrderId?: string;
  limit: number;
  now: Date;
}): Promise<RetailReconciliationPage> {
  const orders = await listRetailOrdersToReconcile({
    ...(input.afterOrderId ? { afterOrderId: input.afterOrderId } : {}),
    limit: input.limit,
  });

  let revisions = 0;
  let adjustmentsCreated = 0;
  let blocked = 0;

  for (const order of orders) {
    // Credits FIRST, so a credit note that arrived since the last pass is part
    // of the evidence this revision reads rather than the next one's.
    await ingestSupplierCreditsForOrder({ orderId: order.id, now: input.now });

    const outcome = await reconcileRetailOrder({ orderId: order.id, now: input.now });
    if (outcome.created) revisions += 1;
    if (outcome.adjustmentId) adjustmentsCreated += 1;
    if (outcome.blocked.length > 0) blocked += 1;
  }

  const adjustmentsSettled = await settleOpenAdjustments(input);

  const last = orders[orders.length - 1];
  return {
    scanned: orders.length,
    revisions,
    adjustmentsCreated,
    adjustmentsSettled,
    blocked,
    // A short page is the end of the pass. The cursor is the last order id
    // CONSIDERED and not the last one that produced a revision: an order the
    // digest matched is still considered, and resuming from the last CHANGED
    // one would re-read every unchanged order between them on every page.
    nextCursor: orders.length < input.limit ? null : (last?.id ?? null),
  };
}

/**
 * Pay what is owed and payable.
 *
 * Bounded by the same page size and driven from the same tick, because an
 * adjustment nobody pays is an obligation to a buyer sitting in a queue. Each
 * settlement is independently idempotent, and a failure on one is logged and
 * skipped rather than failing the page — one buyer's stuck refund must not stop
 * every other buyer's.
 */
async function settleOpenAdjustments(input: { limit: number; now: Date }): Promise<number> {
  const open = await listOpenAdjustments({ limit: input.limit });
  let settled = 0;
  for (const adjustment of open) {
    try {
      const outcome = await settleRetailCustomerAdjustment({
        adjustmentId: adjustment.id,
        now: input.now,
      });
      if (outcome?.refundId) settled += 1;
    } catch (error: unknown) {
      log.general.error(
        { err: error, adjustmentId: adjustment.id },
        '[RetailReconciliation] a cost adjustment could not be settled; it stays owed',
      );
    }
  }
  return settled;
}

/**
 * Start the sweep timer. Runs on EVERY task, like the outbox dispatcher and for
 * the same reason: the lease on the cursor row already gives the property a
 * leader election would, and N tasks that lose the claim cost microseconds.
 */
export function startRetailReconciliationSweep(): void {
  if (timer) return;
  if (!config.retailReconciliation.enabled) {
    log.general.info(
      '[RetailReconciliation] the sweep is disabled; records and operator actions are unaffected',
    );
    return;
  }
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void runRetailReconciliationPage()
      .catch((err: unknown) => {
        log.general.error({ err }, '[RetailReconciliation] sweep tick failed');
      })
      .finally(() => {
        running = false;
      });
  }, config.retailReconciliation.pollIntervalMs);
  // A module-level interval that keeps the process alive hangs jest and vitest
  // non-deterministically; `unref` is what every timer in this codebase does.
  timer.unref?.();
}

/** Stop the timer. Used by the shutdown path and by tests. */
export function stopRetailReconciliationSweep(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
