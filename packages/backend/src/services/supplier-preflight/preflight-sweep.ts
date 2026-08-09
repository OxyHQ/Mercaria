/**
 * The loop that hands back lapsed holds, releases lapsed quotes and evaluates
 * supplier health (#122 concurrency 9, operations 6).
 *
 * ## The LOOP is gated; nothing durable is
 *
 * `SUPPLIER_PREFLIGHT_SWEEP_ENABLED` stops this loop and nothing else. Quotes
 * still expire against their own deadline and supplier holds still lapse on the
 * SUPPLIER's clock — `deriveSupplierQuoteUsage` and the reservation's
 * `provider_expires_at` are both read against the clock at every use, so
 * turning the sweep off cannot make a stale quote usable. What stops is
 * Mercaria RECORDING that they lapsed, which is the ordinary outbox inversion:
 * switching it back on drains the backlog rather than stranding it.
 *
 * That is why this sweep needs no lease of its own. Every action it takes is an
 * idempotent compare-and-swap — `releaseSupplierQuote` and
 * `releaseSupplierReservation` both converge — so N tasks running it
 * concurrently produce the same end state as one, and a dead task strands
 * nothing. A lease would buy exclusion this loop does not need and add a row
 * whose expiry is one more thing to get wrong.
 *
 * ## Releasing a lapsed hold still calls the supplier
 *
 * A hold past its own deadline is usually already gone on the supplier's side,
 * and the call is still made where the adapter supports it: some suppliers keep
 * a lapsed hold until it is explicitly returned, and the ones that do not
 * answer harmlessly. The bounded retry is what stops a supplier that refuses
 * the call from being retried forever — after
 * `SUPPLIER_PREFLIGHT_MAX_RELEASE_ATTEMPTS` the row drops out of the page and
 * stays visible with its error, which is the `dead_letter` posture without a
 * second status column.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import { findSupplierAccountById } from '../../db/procurement/supplierAccountRepository.js';
import {
  listLapsedOpenSupplierQuotes,
  releaseSupplierQuote,
} from '../../db/supplierPreflight/quoteRepository.js';
import {
  listLapsedSupplierReservations,
  readSupplierReservationProviderId,
  recordSupplierReleaseFailure,
  releaseSupplierReservation,
} from '../../db/supplierPreflight/reservationRepository.js';
import { evaluateSupplierPreflightHealth } from './health.service.js';
import { findSupplierAdapter } from './registry.js';
import { redactSupplierProviderMessage } from './redact.js';

/** What one sweep pass did. Returned so a test can assert progress without a clock. */
export interface SupplierPreflightSweepResult {
  quotesReleased: number;
  reservationsReleased: number;
  reservationReleaseFailures: number;
  healthRaised: number;
  healthLifted: number;
}

/**
 * Run one pass.
 *
 * Reservations FIRST, then quotes: a reservation points at its quote by foreign
 * key, and releasing the quote first would leave a live hold whose quote reads
 * as finished — which is exactly the state the operator surface would report as
 * "stock held for nobody". The order costs nothing and removes a window in
 * which the two records disagree.
 */
export async function runSupplierPreflightSweep(
  options: { now?: Date } = {},
): Promise<SupplierPreflightSweepResult> {
  const db = getDb();
  const now = options.now ?? new Date();
  const result: SupplierPreflightSweepResult = {
    quotesReleased: 0,
    reservationsReleased: 0,
    reservationReleaseFailures: 0,
    healthRaised: 0,
    healthLifted: 0,
  };

  const lapsedHolds = await listLapsedSupplierReservations(
    {
      limit: config.supplierPreflight.sweepBatchSize,
      maxReleaseAttempts: config.supplierPreflight.maxReleaseAttempts,
      now,
    },
    db,
  );

  for (const reservation of lapsedHolds) {
    try {
      await callSupplierRelease(reservation.id, reservation.supplierAccountId, now);
      const released = await releaseSupplierReservation(
        { reservationId: reservation.id, reason: 'expired', now },
        db,
      );
      if (released) result.reservationsReleased += 1;
    } catch (err) {
      result.reservationReleaseFailures += 1;
      await recordSupplierReleaseFailure(
        {
          reservationId: reservation.id,
          error: redactSupplierProviderMessage(
            err instanceof Error ? err.message : 'The supplier adapter threw a non-Error value.',
          ),
          now,
        },
        db,
      );
      log.general.warn(
        { supplierAccountId: reservation.supplierAccountId, reservationId: reservation.id },
        '[SupplierPreflight] could not release a lapsed supplier hold; will retry',
      );
    }
  }

  const lapsedQuotes = await listLapsedOpenSupplierQuotes(
    { limit: config.supplierPreflight.sweepBatchSize, now },
    db,
  );
  for (const quote of lapsedQuotes) {
    const released = await releaseSupplierQuote(
      { quoteId: quote.id, reason: 'expired', now },
      db,
    );
    if (released) result.quotesReleased += 1;
  }

  const health = await evaluateSupplierPreflightHealth({ now, db });
  result.healthRaised = health.raised;
  result.healthLifted = health.lifted;

  return result;
}

/**
 * Ask the supplier to take its hold back, where the adapter can.
 *
 * The provider id is read through the EXPLICIT accessor rather than off the
 * row: it is a protected column and this is the one path that legitimately
 * needs it — presenting it back to the supplier is the entire operation.
 *
 * An adapter that cannot release is not an error: it cannot have made a hold in
 * the first place (`registerSupplierAdapter` refuses a declaration without a
 * release), so reaching here with one means the account's provider slug changed
 * under an existing row, and the local release is still the right thing to do.
 */
async function callSupplierRelease(
  reservationId: string,
  supplierAccountId: string,
  now: Date,
): Promise<void> {
  const db = getDb();
  const account = await findSupplierAccountById(supplierAccountId, db);
  if (!account) return;
  const adapter = findSupplierAdapter(account.provider);
  if (!adapter?.releaseReservation) return;

  const providerReservationId = await readSupplierReservationProviderId(reservationId, db);
  if (!providerReservationId) return;

  await adapter.releaseReservation({
    providerAccountId: account.providerAccountId,
    environment: account.environment,
    providerReservationId,
    reason: 'expired',
    timeoutMs: DEFAULT_RELEASE_TIMEOUT_MS,
  });
  void now;
}

/**
 * The deadline on a release call.
 *
 * A code constant rather than the policy's `provider_timeout_ms`: a release
 * runs on a background sweep with nobody waiting, so it can afford to be more
 * patient than a checkout-path quote, and reading the policy here would make a
 * cleanup depend on a version that may have been retired since the hold was
 * taken.
 */
const DEFAULT_RELEASE_TIMEOUT_MS = 15_000;

let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Start the sweep on this task.
 *
 * `unref()` immediately, the convention every Oxy singleton timer follows: a
 * housekeeping interval that keeps the event loop alive hangs a jest/vitest run
 * non-deterministically, and the `?.` covers a runtime without it.
 */
export function startSupplierPreflightSweep(): void {
  if (timer) return;
  if (!config.supplierPreflight.sweepEnabled) {
    log.general.info(
      '[SupplierPreflight] sweep disabled (SUPPLIER_PREFLIGHT_SWEEP_ENABLED=false); quotes and ' +
        'holds still lapse against their own clocks, they are simply not recorded as lapsed',
    );
    return;
  }

  timer = setInterval(() => {
    void runSupplierPreflightSweep().catch((err: unknown) => {
      log.general.error({ err }, '[SupplierPreflight] sweep pass failed');
    });
  }, config.supplierPreflight.sweepIntervalMs);
  timer.unref?.();
}

/** Stop the sweep — the shutdown path, and what a test calls between files. */
export function stopSupplierPreflightSweep(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
