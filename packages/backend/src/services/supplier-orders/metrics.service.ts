/**
 * What an operator can see about procurement (#124 observability 1–10).
 *
 * A JSON projection plus structured logs, and no prometheus dependency — the
 * `/internal/payments/metrics` arrangement, for the same reason: scraping and
 * alerting wiring belongs to `oxy-infra`, and a metrics library in this service
 * would be a second place for a number to be defined.
 *
 * Every figure below names its source table. That matters here more than
 * usual, because two of the ten things #124 asks to be tracked are counts of
 * things that DID NOT happen — a refused call and an unverified callback — and
 * neither is derivable from the rows a successful path leaves behind. The
 * refusals are `supplier_order_attempts` rows with `outcome = 'refused'`; the
 * unverified callbacks are process-local counters, because the whole point is
 * that they are never stored.
 */

import type { ProcurementExceptionKind } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  procurementOutboxCounts,
  listProcurementOutboxRows,
} from '../../db/supplierOrders/outboxRepository.js';
import { supplierOrderAttemptCounts } from '../../db/supplierOrders/attemptRepository.js';
import {
  procurementExceptionCounts,
  listOpenProcurementExceptions,
} from '../../db/supplierOrders/exceptionRepository.js';
import {
  supplierProviderEventCounts,
  supplierProviderEventLag,
} from '../../db/supplierOrders/providerEventRepository.js';
import { readSupplierEventIngestCounters } from './event-ingest.service.js';

/** How far back the latency and rate figures look. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** The whole operator metrics projection. */
export interface ProcurementMetrics {
  windowStart: string;
  /** #124 observability 1, 2 and 8 — per operation and outcome, with p95. */
  attempts: { operation: string; outcome: string; total: number; p95LatencyMs: number | null }[];
  /** #124 observability 6 and 9 — the durable job queue by type and status. */
  outbox: { eventType: string; status: string; total: number }[];
  /** #124 observability 5 — inbound events by delivery and status. */
  events: { delivery: string; status: string; total: number }[];
  /** #124 observability 5 and 9 — per account, how long a source has been silent. */
  lag: { supplierAccountId: string; delivery: string; lastReceivedAt: string; lagMs: number; slaBreached: boolean }[];
  /** #124 observability 3, 6 and 10 — the conditions a person owns. */
  exceptions: { kind: string; open: number; resolved: number }[];
  /** Process-local: deliveries this task refused because it could not verify them. */
  ingest: { refusedUnverified: number; storedWebhook: number; storedPoll: number; duplicates: number };
}

/** Read every figure the operator surface publishes. */
export async function readProcurementMetrics(options?: {
  windowMs?: number;
  now?: Date;
}): Promise<ProcurementMetrics> {
  const now = options?.now ?? new Date();
  const since = new Date(now.getTime() - (options?.windowMs ?? DEFAULT_WINDOW_MS));
  const db = getDb();

  const [attempts, outbox, events, lag, exceptions] = await Promise.all([
    supplierOrderAttemptCounts({ since }, db),
    procurementOutboxCounts(db),
    supplierProviderEventCounts(db),
    supplierProviderEventLag(db),
    procurementExceptionCounts(db),
  ]);

  return {
    windowStart: since.toISOString(),
    attempts,
    outbox,
    events,
    lag: lag.map((entry) => {
      const lagMs = now.getTime() - new Date(entry.lastReceivedAt).getTime();
      return {
        supplierAccountId: entry.supplierAccountId,
        delivery: entry.delivery,
        lastReceivedAt: new Date(entry.lastReceivedAt).toISOString(),
        lagMs,
        slaBreached: lagMs > config.procurement.eventLagSlaMs,
      };
    }),
    exceptions,
    ingest: readSupplierEventIngestCounters(),
  };
}

/**
 * The operator queues: open conditions and dead-lettered jobs.
 *
 * Read from the tables that already hold them rather than copied into a third
 * one — the `listPaymentOutboxExceptions` decision (#50): copying would make
 * one condition two rows that can disagree about whether it is resolved.
 */
export async function readProcurementQueues(input?: {
  kind?: ProcurementExceptionKind;
  limit?: number;
}): Promise<{
  openExceptions: Awaited<ReturnType<typeof listOpenProcurementExceptions>>;
  deadLetters: Awaited<ReturnType<typeof listProcurementOutboxRows>>;
}> {
  const limit = Math.min(Math.max(1, input?.limit ?? 50), 200);
  const [openExceptions, deadLetters] = await Promise.all([
    listOpenProcurementExceptions({ ...(input?.kind ? { kind: input.kind } : {}), limit }),
    listProcurementOutboxRows(getDb(), { statuses: ['dead_letter'], limit }),
  ]);
  return { openExceptions, deadLetters };
}
