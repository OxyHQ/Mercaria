/**
 * The catalog observability operator surface (#367 W16/W17).
 *
 * ## A JSON endpoint plus structured logs, and no prometheus
 *
 * `services/payments/reconciliation/`'s decision, restated because it keeps being
 * tempting: no registry, no exporter, no scrape format. Scraping, alerting and
 * scheduling belong to `oxy-infra`, which is why there is no sweep loop in this
 * domain either — the integrity checks are a route a scheduled probe calls, and
 * the probe's cadence is infrastructure configuration rather than a constant
 * compiled into the image.
 *
 * ## Read-only, and the omissions are the design
 *
 * There is no "recompute this metric", no "clear this counter", no "resolve this
 * finding" and no "repair" of any kind. Every integrity check here is a
 * DETECTION whose subject can legitimately be mid-migration, so the closed route
 * set is what stops this surface becoming a way to make the catalogue agree with
 * a dashboard. `routes/internal-catalog-metrics.ts` enumerates it and a gate
 * asserts the set exactly.
 *
 * ## Every handler answers a metrics payload and nothing else
 *
 * No id belonging to a person reaches any of these responses. The integrity
 * samples carry subject keys — a category id, a redirect id — which is what an
 * operator opens; the metrics carry integers and closed-set dimension keys.
 */

import type { Request, Response } from 'express';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';
import { log } from '../lib/logger.js';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import { collectCatalogMetrics } from '../services/catalog-observability/metrics.service.js';
import { runCatalogIntegrityChecks } from '../services/catalog-observability/integrity.service.js';
import { readCatalogLatencyReport } from '../services/catalog-observability/budgets.js';
import { readProposalQueueAging } from '../services/catalog-observability/proposal-queue.js';
import { traceCatalogPublication } from '../services/catalog-observability/trace.service.js';

/** `GET /internal/catalog-metrics` — every defined metric, measured or not. */
export async function catalogMetricsHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await collectCatalogMetrics());
  } catch (error: unknown) {
    log.general.error(
      { err: error, actor: catalogOperatorId(req) },
      '[CatalogObservability] metrics collection failed',
    );
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Could not collect catalog metrics', 500);
  }
}

/** `GET /internal/catalog-metrics/integrity` — the six periodic checks. */
export async function catalogIntegrityHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await runCatalogIntegrityChecks());
  } catch (error: unknown) {
    log.general.error(
      { err: error, actor: catalogOperatorId(req) },
      '[CatalogObservability] integrity sweep failed',
    );
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Could not run catalog integrity checks', 500);
  }
}

/**
 * `GET /internal/catalog-metrics/proposal-queue` — the review queue's shape.
 *
 * The registry's six proposal metrics are single integers; this is the
 * distribution behind them — depth and oldest age per lifecycle state, a
 * five-band waiting-age partition over the open rows, nearest-rank percentiles
 * (withheld below the population at which a p95 is arithmetically the maximum),
 * and the explicit statement that no review-time SLA target exists.
 *
 * It takes NO parameter of any kind. There is no `storeId` filter, no state
 * filter and no date range: narrowing a queue aggregate by store is how "what is
 * this merchant asking for" becomes answerable from a metrics surface, and the
 * queue LIST at `/internal/catalog-proposals` is where a filter belongs. Nothing
 * in the response carries a proposal id, a store, a submitter or a label.
 */
export async function catalogProposalQueueHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await readProposalQueueAging());
  } catch (error: unknown) {
    log.general.error(
      { err: error, actor: catalogOperatorId(req) },
      '[CatalogObservability] proposal queue read failed',
    );
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Could not read the catalog proposal queue', 500);
  }
}

/** `GET /internal/catalog-metrics/latency` — the W16 budgets against what this task observed. */
export function catalogLatencyHandler(req: Request, res: Response): void {
  try {
    sendSuccess(res, readCatalogLatencyReport());
  } catch (error: unknown) {
    log.general.error(
      { err: error, actor: catalogOperatorId(req) },
      '[CatalogObservability] latency report failed',
    );
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Could not read catalog latency budgets', 500);
  }
}

/**
 * `GET /internal/catalog-metrics/trace/:handleKind/:handle` — one publication.
 *
 * The handle kind is a closed set of TWO values and the trace service's signature
 * accepts nothing else, so "show me everything this merchant published" and
 * "find the draft for this email" are unrepresentable rather than refused. The
 * `tracePayment` rule.
 */
export async function catalogPublicationTraceHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const kind = req.params['handleKind'];
  const handle = req.params['handle'];
  if (kind !== 'draft' && kind !== 'listing') {
    sendError(
      res,
      ErrorCodes.VALIDATION_ERROR,
      'A publication trace opens from a draft id or a listing id',
      400,
    );
    return;
  }
  if (typeof handle !== 'string' || handle === '') {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'A trace handle is required', 400);
    return;
  }
  try {
    const trace = await traceCatalogPublication(
      kind === 'draft' ? { by: 'draft_id', draftId: handle } : { by: 'listing_id', listingId: handle },
    );
    if (!trace) {
      // Undefined means the handle names nothing at all, which is a 404 rather
      // than six absent hops — a typo and a publication that never happened lead
      // an operator to different next steps.
      sendError(res, ErrorCodes.NOT_FOUND, 'No such catalog publication', 404);
      return;
    }
    sendSuccess(res, trace);
  } catch (error: unknown) {
    log.general.error(
      { err: error, actor: catalogOperatorId(req), handleKind: kind },
      '[CatalogObservability] publication trace failed',
    );
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Could not trace the catalog publication', 500);
  }
}
