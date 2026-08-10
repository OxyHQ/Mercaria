/**
 * Delivery promises and estimates (#126 §"Delivery promises and estimates",
 * ADR 0004 D9.9).
 *
 * ADR 0004 D9.9 puts the customer-facing delivery promise on Mercaria, *derived
 * from the supplier quote's stated service and transit range, snapshotted on
 * the order*. Everything in this module follows from that one sentence plus the
 * issue's rule 9 — *never silently rewrite past promises*.
 *
 * ## An append-only trail, not a current-estimate column
 *
 * The tempting shape is `orders.estimated_delivery_at`, updated as better
 * information arrives. It satisfies rules 4 and 6 badly and rule 9 not at all:
 * a column that can be overwritten is precisely the mechanism by which a past
 * promise is silently rewritten, and once it has been there is nothing left to
 * compare a complaint against. So every statement is a ROW, the accepted one is
 * unique per order and immutable, and {@link readRetailDeliveryPromiseView}
 * derives "accepted" and "current" as two separately reportable values (rule 4).
 *
 * ## A failed refresh is a row too
 *
 * Rule 6 asks that estimates be *marked stale when supplier or Moovo updates
 * fail*. An append-only trail can only say "we asked and could not find out" by
 * recording the asking, so `refresh_failed` is an OUTCOME rather than an
 * absence — and a row with that outcome carries no window at all, which is rule
 * 10 (*unknown cost/estimate is not zero/on time*) held by a CHECK rather than
 * by a convention about what to display.
 *
 * ## A supplier SLA never becomes a guarantee
 *
 * Rule 5. {@link recordSupplierDeliveryEstimate} takes no basis parameter and
 * writes `advisory` unconditionally; only {@link recordAcceptedDeliveryPromise}
 * writes `guaranteed`, and the table's own CHECK refuses a `guaranteed`
 * accepted promise from any source but `mercaria_checkout`. That is #122's
 * downgrade rule pointed at a promise: there is no code path that upgrades one,
 * so the guarantee cannot arrive by omission.
 */

import type {
  RetailDeliveryPromiseBasis,
  RetailDeliveryPromiseKind,
  RetailDeliveryPromiseSource,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  insertRetailDeliveryPromise,
  listRetailDeliveryPromises,
  type RetailDeliveryPromiseRow,
} from '../../db/retailFulfilment/retailFulfilmentRepository.js';

/**
 * How long a supplier or logistics estimate is treated as current.
 *
 * Twelve hours, and it is a DISPLAY decision: the question is *"may Mercaria
 * still repeat this to a buyer as the current estimate"*, not *"has the parcel
 * moved"*. Longer than the projection's six hours because an estimate is a
 * statement about a future date and does not decay as fast as a position does.
 */
export const RETAIL_DELIVERY_ESTIMATE_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

/** One statement about when goods arrive, as a surface reads it. */
export interface RetailDeliveryPromiseStatement {
  kind: RetailDeliveryPromiseKind;
  source: RetailDeliveryPromiseSource;
  basis: RetailDeliveryPromiseBasis;
  /** ISO-8601. Absent when the source gave only one end of the window. */
  earliestAt?: string;
  latestAt?: string;
  /** ISO-8601 — when the SOURCE observed it (#126 rule 7). */
  observedAt: string;
  /** Derived against the reader's clock, never stored. */
  stale: boolean;
}

/**
 * What a customer surface shows (#126 rule 4: accepted and current, separately).
 *
 * `current` is absent when nothing has been observed since checkout, which is
 * the ordinary state of a freshly placed order — and it is ABSENT rather than a
 * copy of `accepted`, because a surface repeating the accepted promise as a
 * live estimate is exactly rule 9's silent rewrite in the other direction.
 *
 * `lastRefreshFailure` is separate from both. A surface that only showed the
 * newest OBSERVED estimate would be silently confident about a figure whose
 * refresh has been failing for a day.
 */
export interface RetailDeliveryPromiseView {
  accepted?: RetailDeliveryPromiseStatement;
  current?: RetailDeliveryPromiseStatement;
  lastRefreshFailure?: { reason: string; observedAt: string };
}

/**
 * Record the promise the buyer accepted — in the order's own transaction.
 *
 * @param db MUST be the transaction the order is written in. ADR 0004 D9.9
 *   calls it *snapshotted on the order*, and a promise that committed without
 *   its order would describe a delivery for a sale that did not happen.
 */
export async function recordAcceptedDeliveryPromise(
  db: DatabaseOrTransaction,
  input: {
    orderId: string;
    earliestAt?: Date;
    latestAt?: Date;
    observedAt: Date;
  },
): Promise<RetailDeliveryPromiseRow> {
  if (!input.earliestAt && !input.latestAt) {
    // The CHECK would refuse it, and refusing here says why. An accepted
    // promise with no window is not a shorter promise, it is a purchase made
    // with no delivery statement at all — which is a checkout defect, not a
    // row to store.
    throw new Error(
      'An accepted delivery promise must carry at least one end of its window; a promise with ' +
        'no dates is not a promise a buyer could have accepted.',
    );
  }
  return insertRetailDeliveryPromise(db, {
    orderId: input.orderId,
    promiseKind: 'accepted_at_checkout',
    source: 'mercaria_checkout',
    outcome: 'observed',
    // The ONE place `guaranteed` is written. See the module docblock.
    basis: 'guaranteed',
    ...(input.earliestAt ? { earliestAt: input.earliestAt } : {}),
    ...(input.latestAt ? { latestAt: input.latestAt } : {}),
    observedAt: input.observedAt,
  });
}

/**
 * Record what a supplier said about handling or dispatch.
 *
 * No basis parameter, deliberately — see the module docblock. `sourceRef` is
 * the supplier's own quote or order handle and is PROTECTED: it identifies a
 * procurement record and belongs in no buyer-facing DTO.
 */
export async function recordSupplierDeliveryEstimate(input: {
  orderId: string;
  fulfilmentIntentId: string;
  kind: Extract<RetailDeliveryPromiseKind, 'supplier_handling' | 'supplier_dispatch'>;
  sourceRef?: string;
  earliestAt?: Date;
  latestAt?: Date;
  observedAt: Date;
}): Promise<RetailDeliveryPromiseRow> {
  const observed = Boolean(input.earliestAt ?? input.latestAt);
  return insertRetailDeliveryPromise(getDb(), {
    orderId: input.orderId,
    fulfilmentIntentId: input.fulfilmentIntentId,
    promiseKind: input.kind,
    source: 'supplier_adapter',
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    // A supplier that answered without dates has told us something — that it
    // does not know — and recording it as `unknown` is what keeps a later
    // "no estimate available" distinguishable from never having asked.
    outcome: observed ? 'observed' : 'unknown',
    ...(observed ? { basis: 'advisory' as const } : {}),
    ...(input.earliestAt ? { earliestAt: input.earliestAt } : {}),
    ...(input.latestAt ? { latestAt: input.latestAt } : {}),
    observedAt: input.observedAt,
  });
}

/**
 * Record Moovo's transport estimate (#126 rule 3: Moovo owns the estimate; this
 * records the observation of it).
 *
 * Always `advisory`, for the same reason a supplier's is: the only guaranteed
 * statement Mercaria makes is the one it made to the buyer at checkout, and a
 * carrier's estimate becoming a guarantee is how a delay turns into a broken
 * promise nobody made.
 */
export async function recordLogisticsDeliveryEstimate(input: {
  orderId: string;
  fulfilmentIntentId: string;
  transportRequestId: string;
  earliestAt?: Date;
  latestAt?: Date;
  observedAt: Date;
}): Promise<RetailDeliveryPromiseRow> {
  const observed = Boolean(input.earliestAt ?? input.latestAt);
  return insertRetailDeliveryPromise(getDb(), {
    orderId: input.orderId,
    fulfilmentIntentId: input.fulfilmentIntentId,
    promiseKind: 'logistics_estimate',
    source: 'moovo_logistics',
    sourceRef: input.transportRequestId,
    outcome: observed ? 'observed' : 'unknown',
    ...(observed ? { basis: 'advisory' as const } : {}),
    ...(input.earliestAt ? { earliestAt: input.earliestAt } : {}),
    ...(input.latestAt ? { latestAt: input.latestAt } : {}),
    observedAt: input.observedAt,
  });
}

/**
 * Record that a refresh failed — #126 rule 6.
 *
 * `reason` is a CODE, never a provider's own message: a free-text field on a
 * row read by an operator surface is where a supplier's error string carrying
 * an order reference or an address ends up, and the reasons worth acting on are
 * a small closed set anyway (unreachable, refused, unauthorized).
 */
export async function recordDeliveryEstimateRefreshFailure(input: {
  orderId: string;
  fulfilmentIntentId: string;
  kind: Extract<RetailDeliveryPromiseKind, 'supplier_dispatch' | 'logistics_estimate'>;
  source: Extract<RetailDeliveryPromiseSource, 'supplier_adapter' | 'moovo_logistics'>;
  reason: string;
  observedAt: Date;
}): Promise<RetailDeliveryPromiseRow> {
  return insertRetailDeliveryPromise(getDb(), {
    orderId: input.orderId,
    fulfilmentIntentId: input.fulfilmentIntentId,
    promiseKind: input.kind,
    source: input.source,
    outcome: 'refresh_failed',
    failureReason: input.reason,
    observedAt: input.observedAt,
  });
}

/** One stored row, as a surface reads it. */
function toStatement(row: RetailDeliveryPromiseRow, now: Date): RetailDeliveryPromiseStatement {
  const observedAt = row.observedAt.toISOString();
  return {
    kind: row.promiseKind,
    source: row.source,
    // Only an `observed` row reaches here (the callers filter), and the CHECK
    // makes its basis non-null — but the column is nullable for the other
    // outcomes, so the fallback is written out rather than asserted away.
    basis: row.basis ?? 'advisory',
    ...(row.earliestAt ? { earliestAt: row.earliestAt.toISOString() } : {}),
    ...(row.latestAt ? { latestAt: row.latestAt.toISOString() } : {}),
    observedAt,
    stale: now.getTime() - row.observedAt.getTime() > RETAIL_DELIVERY_ESTIMATE_STALE_AFTER_MS,
  };
}

/**
 * The accepted promise, the current estimate and the last refresh failure.
 *
 * "Current" is the newest OBSERVED row that is not the accepted promise, by the
 * SOURCE's observation time rather than by insertion order — two deliveries
 * racing produce receipt times whose order says nothing, which is the ordering
 * rule #124's observation path already established.
 *
 * The accepted promise is never a candidate for `current` even though it is the
 * newest observed row on a fresh order. Reporting it as both would make rule 4
 * ("show accepted and current separately") vacuously satisfied by one value
 * displayed twice.
 */
export async function readRetailDeliveryPromiseView(
  orderId: string,
  now: Date,
): Promise<RetailDeliveryPromiseView> {
  const rows = await listRetailDeliveryPromises(orderId);
  const view: RetailDeliveryPromiseView = {};

  const accepted = rows.find((row) => row.promiseKind === 'accepted_at_checkout');
  if (accepted) view.accepted = toStatement(accepted, now);

  let current: RetailDeliveryPromiseRow | undefined;
  let failure: RetailDeliveryPromiseRow | undefined;
  for (const row of rows) {
    if (row.promiseKind === 'accepted_at_checkout') continue;
    if (row.outcome === 'observed') {
      if (!current || row.observedAt.getTime() > current.observedAt.getTime()) current = row;
    } else if (row.outcome === 'refresh_failed') {
      if (!failure || row.observedAt.getTime() > failure.observedAt.getTime()) failure = row;
    }
  }
  if (current) view.current = toStatement(current, now);
  if (failure?.failureReason) {
    view.lastRefreshFailure = {
      reason: failure.failureReason,
      observedAt: failure.observedAt.toISOString(),
    };
  }
  return view;
}
