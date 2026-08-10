/**
 * Price-signal controllers (THIN) — the public read, the merchant surface and
 * the operator surface (#82).
 *
 * Nothing here derives anything. Every verdict, every sample fact, every refusal
 * reason and every recommendation is composed in `services/price-signals/`, so a
 * controller cannot produce a second answer to any of them — and there is no DTO
 * field a serializer could widen into a competitor's identity or a commission,
 * because `MERCHANT_COMPETITIVENESS_FORBIDDEN_FIELDS` names all of them and a
 * test walks a REAL emitted response for each.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import {
  PRICE_SIGNAL_POLICY_KEY,
  type ConditionGroup,
  type CurrencyCode,
  type MerchantCompetitivenessRow,
  type PriceSignalFeedbackReason,
  type PriceSignalKind,
  type PriceSignalRunMode,
} from '@mercaria/shared-types';
import { config } from '../config/index.js';
import {
  activatePriceSignalPolicyVersion,
  archivePriceSignalPolicyVersion,
  findPriceSignalPolicyByVersion,
  insertPriceSignalPolicyVersion,
  listPriceSignalPolicyVersions,
} from '../db/priceSignals/priceSignalPolicyRepository.js';
import {
  insertPriceSignalRun,
  listEvaluationsForSubject,
  listPriceSignalRuns,
} from '../db/priceSignals/priceSignalRunRepository.js';
import { readMerchantCompetitiveness } from '../services/price-signals/competitiveness.service.js';
import {
  closePriceSignalFeedbackReport,
  filePriceSignalFeedback,
  listOwnPriceSignalFeedback,
  listPriceSignalFeedbackQueue,
} from '../services/price-signals/feedback.service.js';
import {
  detectPriceSignalMassChange,
  readPriceSignalCoverage,
  readPriceSignalFeedbackSummary,
  readPriceSignalLabelDistribution,
} from '../services/price-signals/metrics.service.js';
import { readPriceSignals } from '../services/price-signals/read.service.js';
import { routeParam } from '../utils/request.js';
import { sendSuccess } from '../utils/api-response.js';
import { notFound, respondWithError, validationError } from '../lib/errors/error-codes.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Public                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/** GET /price-signals — one subject's signals, with their samples and semantics. */
export async function getPriceSignalsHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as {
      canonicalProductId?: string;
      canonicalVariantId?: string;
      segment: ConditionGroup;
      currency: CurrencyCode;
      market?: string;
    };
    sendSuccess(
      res,
      await readPriceSignals({
        ...(query.canonicalProductId ? { canonicalProductId: query.canonicalProductId } : {}),
        ...(query.canonicalVariantId ? { canonicalVariantId: query.canonicalVariantId } : {}),
        segment: query.segment,
        currency: query.currency,
        ...(query.market ? { market: query.market.toUpperCase() } : {}),
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read price signals');
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Merchant                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * GET /merchant-competitiveness/:merchantId — the merchant's own analysis.
 *
 * `format=csv` is issue UI 4's export, and it is a rendering of exactly the rows
 * the JSON carries. A second query with its own idea of what a merchant may see
 * is how an export ends up carrying a column the API withholds.
 */
export async function getMerchantCompetitivenessHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const query = req.query as unknown as {
      segment: ConditionGroup;
      currency: CurrencyCode;
      market?: string;
      limit: number;
      afterOfferId?: string;
      format: 'json' | 'csv';
    };

    const response = await readMerchantCompetitiveness({
      merchantId: routeParam(req, 'merchantId'),
      oxyUserId: getRequiredOxyUserId(req),
      segment: query.segment,
      currency: query.currency,
      ...(query.market ? { market: query.market.toUpperCase() } : {}),
      limit: Math.min(query.limit, config.priceSignals.merchantSubjectLimit),
      ...(query.afterOfferId ? { afterOfferId: query.afterOfferId } : {}),
    });

    if (query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="competitiveness.csv"');
      res.send(toCompetitivenessCsv(response.rows));
      return;
    }
    sendSuccess(res, response);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read merchant competitiveness');
  }
}

/**
 * The export, as CSV.
 *
 * Every column is a field of {@link MerchantCompetitivenessRow} and there is no
 * column for a competitor: the export cannot carry what the type does not have,
 * which is the same guarantee the JSON has and not a second one somebody
 * maintains.
 */
function toCompetitivenessCsv(rows: readonly MerchantCompetitivenessRow[]): string {
  const header = [
    'kind',
    'state',
    'reason',
    'canonicalProductId',
    'canonicalVariantId',
    'segment',
    'market',
    'currency',
    'measure',
    'deliveryIncluded',
    'taxInclusion',
    'from',
    'to',
    'deltaBps',
    'position',
    'label',
    'confidence',
    'observations',
    'distinctSellers',
    'distinctOffers',
    'coverageDays',
    'outliersExcluded',
    'deduplicated',
    'eligibilityLossReasons',
    'offerId',
  ];

  const lines = rows.map((row) => {
    const value = row.value;
    return [
      row.kind,
      row.state,
      row.reason ?? '',
      row.subject.canonicalProductId ?? '',
      row.subject.canonicalVariantId ?? '',
      row.subject.segment,
      row.subject.market ?? '',
      row.subject.currency,
      row.subject.measure,
      String(row.subject.deliveryIncluded),
      row.subject.taxInclusion,
      row.subject.from,
      row.subject.to,
      value !== undefined && (value.measure === 'relative' || value.measure === 'drop' || value.measure === 'label')
        ? String(value.deltaBps)
        : '',
      value !== undefined && value.measure === 'relative' ? value.position : '',
      value !== undefined && value.measure === 'label' ? value.label : '',
      value !== undefined && value.measure === 'label' ? value.confidence : '',
      String(row.sample.observations),
      String(row.sample.distinctSellers),
      String(row.sample.distinctOffers),
      String(row.sample.coverageDays),
      String(row.sample.outliersExcluded),
      String(row.sample.deduplicated),
      (row.eligibilityLossReasons ?? []).join(' '),
      row.offerId ?? '',
    ].map(csvCell);
  });

  return [header.map(csvCell).join(','), ...lines.map((line) => line.join(','))].join('\n');
}

/**
 * One CSV cell.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with an apostrophe: a spreadsheet
 * reads those as a FORMULA, and every value here comes from a catalogue somebody
 * else writes. That is not a theoretical concern for a file a merchant opens in
 * Excel.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** POST /merchant-competitiveness/:merchantId/feedback — a correction report. */
export async function postPriceSignalFeedbackHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      canonicalProductId?: string;
      canonicalVariantId?: string;
      segment: ConditionGroup;
      currency: CurrencyCode;
      market?: string;
      signalKind: PriceSignalKind;
      reason: PriceSignalFeedbackReason;
      note?: string;
    };

    const filed = await filePriceSignalFeedback({
      merchantId: routeParam(req, 'merchantId'),
      oxyUserId: getRequiredOxyUserId(req),
      ...(body.canonicalProductId ? { canonicalProductId: body.canonicalProductId } : {}),
      ...(body.canonicalVariantId ? { canonicalVariantId: body.canonicalVariantId } : {}),
      segment: body.segment,
      currency: body.currency,
      ...(body.market ? { market: body.market.toUpperCase() } : {}),
      signalKind: body.signalKind,
      reason: body.reason,
      ...(body.note ? { note: body.note } : {}),
    });

    sendSuccess(res, { id: filed.id, status: filed.status, reason: filed.reason }, 201);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to file a price-signal correction report');
  }
}

/** GET /merchant-competitiveness/:merchantId/feedback — the merchant's own reports. */
export async function listMerchantPriceSignalFeedbackHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { limit } = req.query as unknown as { limit: number };
    sendSuccess(
      res,
      await listOwnPriceSignalFeedback(
        routeParam(req, 'merchantId'),
        getRequiredOxyUserId(req),
        limit,
      ),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to list price-signal correction reports');
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Operator                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/** GET /internal/price-signals/policies — every version of the key, newest first. */
export async function listPriceSignalPoliciesHandler(req: Request, res: Response): Promise<void> {
  try {
    const { limit } = req.query as unknown as { limit: number };
    sendSuccess(res, {
      policyKey: PRICE_SIGNAL_POLICY_KEY,
      versions: await listPriceSignalPolicyVersions(limit),
    });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to list price-signal policies');
  }
}

/** POST /internal/price-signals/policies — publish a DRAFT. It defines nothing yet. */
export async function createPriceSignalPolicyHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      version: string;
      description: string;
      minObservations: number;
      minDistinctSellers: number;
      minDistinctOffers: number;
      minCoverageDays: number;
      recentWindowDays: number;
      outlierModifiedZThreshold: number;
      outlierMinDeviationBps: number;
      materialDropBps: number;
      typicalBandBps: number;
      goodPriceBelowMedianBps: number;
      strongSampleMultiplier: number;
      objectiveMetricKeys: string[];
      guardrailMetricKeys: string[];
    };

    const created = await insertPriceSignalPolicyVersion({
      policyKey: PRICE_SIGNAL_POLICY_KEY,
      ...body,
      createdByOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, created, 201);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to publish a price-signal policy version');
  }
}

/**
 * POST /internal/price-signals/policies/:id/activate — promote, or ROLL BACK.
 *
 * A rollback is activating an earlier version, and nothing is re-derived: every
 * signal is computed at read time from observations this domain never writes,
 * which is issue monitoring 6 in one call.
 */
export async function activatePriceSignalPolicyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const activated = await activatePriceSignalPolicyVersion(
      routeParam(req, 'id'),
      getRequiredOxyUserId(req),
      new Date(),
    );
    if (activated === undefined) throw notFound('Policy version not found or not activatable');
    sendSuccess(res, activated);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to activate a price-signal policy version');
  }
}

/** POST /internal/price-signals/policies/:id/archive — retire a draft or a superseded version. */
export async function archivePriceSignalPolicyHandler(req: Request, res: Response): Promise<void> {
  try {
    const archived = await archivePriceSignalPolicyVersion(routeParam(req, 'id'), new Date());
    if (archived === undefined) throw notFound('Policy version not found or not archivable');
    sendSuccess(res, archived);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to archive a price-signal policy version');
  }
}

/** GET /internal/price-signals/runs — the measurement runs, newest first. */
export async function listPriceSignalRunsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { limit } = req.query as unknown as { limit: number };
    sendSuccess(res, await listPriceSignalRuns(limit));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to list price-signal runs');
  }
}

/**
 * POST /internal/price-signals/runs — queue one measurement sweep.
 *
 * The run names its POLICY VERSION explicitly, which is what makes monitoring 6
 * work without a canary: a `candidate_comparison` run measures a draft over the
 * same cohort as the live one and shows nobody the result.
 */
export async function createPriceSignalRunHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      policyVersion: string;
      mode: PriceSignalRunMode;
      currency: CurrencyCode;
      market?: string;
    };
    const version = await findPriceSignalPolicyByVersion(body.policyVersion);
    if (version === undefined) throw validationError(`Unknown policy version ${body.policyVersion}`);

    const run = await insertPriceSignalRun({
      policyVersionId: version.id,
      mode: body.mode,
      displayCurrency: body.currency,
      ...(body.market ? { market: body.market.toUpperCase() } : {}),
    });
    sendSuccess(res, run, 202);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to queue a price-signal run');
  }
}

/**
 * GET /internal/price-signals/runs/:id/metrics — coverage, the insufficient-data
 * rate, the label distribution and the mass-change diff, in one read.
 */
export async function priceSignalRunMetricsHandler(req: Request, res: Response): Promise<void> {
  try {
    const runId = routeParam(req, 'id');
    const coverage = await readPriceSignalCoverage(runId);
    if (coverage === undefined) throw notFound('Run not found');
    sendSuccess(res, {
      coverage,
      distribution: await readPriceSignalLabelDistribution(runId),
      massChange: await detectPriceSignalMassChange(runId),
    });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read price-signal run metrics');
  }
}

/**
 * GET /internal/price-signals/subjects/:subjectKey — one subject's recorded
 * evaluations.
 *
 * A trace opens from a SUBJECT KEY and nothing else. There is no handle here for
 * a buyer, a session or a merchant's account: a price signal is a claim about
 * what sellers published, and a surface that could be asked "show me everything
 * this person saw" is a different thing entirely (#78's trace, same rule).
 */
export async function priceSignalSubjectTraceHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(
      res,
      await listEvaluationsForSubject(
        routeParam(req, 'subjectKey'),
        config.priceSignals.traceLimit,
      ),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to trace a price-signal subject');
  }
}

/** GET /internal/price-signals/feedback — the open correction reports and their summary. */
export async function priceSignalFeedbackQueueHandler(req: Request, res: Response): Promise<void> {
  try {
    const { limit } = req.query as unknown as { limit: number };
    sendSuccess(res, {
      open: await listPriceSignalFeedbackQueue(limit),
      summary: await readPriceSignalFeedbackSummary(),
    });
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read the price-signal correction queue');
  }
}

/** POST /internal/price-signals/feedback/:id/close — resolve or reject, attributably. */
export async function closePriceSignalFeedbackHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { status: 'resolved' | 'rejected'; resolutionNote?: string };
    sendSuccess(
      res,
      await closePriceSignalFeedbackReport({
        id: routeParam(req, 'id'),
        status: body.status,
        operatorOxyUserId: getRequiredOxyUserId(req),
        ...(body.resolutionNote ? { resolutionNote: body.resolutionNote } : {}),
      }),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to close a price-signal correction report');
  }
}
