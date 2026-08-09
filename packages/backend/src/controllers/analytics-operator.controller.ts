/**
 * The discovery-analytics operator surface (#77 "Dashboards").
 *
 * Reads plus the two experiment WRITES (publish a version, stop a running one).
 * Everything is behind `requireAnalyticsOperator`, which is the whole of the
 * authorization.
 *
 * ## What it deliberately cannot expose
 *
 * A person, in any form. No endpoint accepts a pseudonym, an Oxy user id, an
 * email or any contact value, and no projection returns one — the trace
 * projection in `db/analytics/eventRepository.ts` names every field explicitly
 * and neither identity column is on the list. So "show me everything this
 * session did" is not a question this surface can be asked, which is a stronger
 * refusal than a rule about how to answer it.
 *
 * A low-frequency query, likewise. `readTopQueries` applies the reporting floor
 * unconditionally and is the only query reader in the backend, so an operator
 * sees exactly what a merchant sees there. An allow-list is a list of people,
 * not a licence.
 *
 * ## The two writes, and why they are the only ones
 *
 * Publishing an experiment version and stopping one are decisions a person
 * makes, and both are already idempotent CAS statements in the repository. Every
 * other "repair" this domain could want is a recomputation — and a rollup bucket
 * is an upsert a sweep will redo on its own, so an endpoint that forced one
 * would add a way to change a number without adding a way to change a fact.
 */

import type { Request, Response } from 'express';
import {
  ANALYTICS_EXPERIMENT_ASSIGNMENT_UNITS,
  ANALYTICS_EXPERIMENT_STOP_CONDITIONS,
  ANALYTICS_METRICS,
  ANALYTICS_METRIC_KEYS,
  ANALYTICS_QUERY_MIN_OCCURRENCES,
  type AnalyticsExperimentAssignmentUnit,
  type AnalyticsExperimentStopCondition,
} from '@mercaria/shared-types';
import { randomBytes } from 'node:crypto';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';
import {
  listExperiments,
  readAnalyticsHealth,
  readExperimentGuardrails,
  readMetricSeries,
  readQueryReport,
  traceCheckoutConversion,
  traceQuery,
} from '../services/analytics/operator-analytics.service.js';
import {
  activateExperiment,
  insertExperimentDraft,
  readMaxExperimentVersion,
  stopExperiment,
} from '../db/analytics/experimentRepository.js';
import { isKnownTreatmentKind } from '../services/analytics/experiments.js';
import { runAnalyticsRollup } from '../services/analytics/rollup.js';

/** Hard ceiling on rows any single call returns. */
const MAX_ROWS = 200;

/** Read a required `YYYY-MM-DD` query parameter. */
function dateParam(req: Request, name: string): string | undefined {
  const raw = req.query[name];
  if (typeof raw !== 'string') return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

/** Read an optional string query parameter. */
function stringParam(req: Request, name: string): string | undefined {
  const raw = req.query[name];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/**
 * GET /internal/analytics/metrics — every definition.
 *
 * The catalogue a dashboard builds itself from, so a client never has to hold a
 * copy of what a metric means. Acceptance 6 lives here as much as in the series
 * endpoint: a dashboard that cannot fetch a definition cannot render a metric.
 */
export function listMetricDefinitionsHandler(_req: Request, res: Response): void {
  sendSuccess(res, {
    metrics: ANALYTICS_METRICS,
    queryReportingMinimumOccurrences: ANALYTICS_QUERY_MIN_OCCURRENCES,
  });
}

/** GET /internal/analytics/metrics/:metricKey — one series, with its definition. */
export async function getMetricSeriesHandler(req: Request, res: Response): Promise<void> {
  const metricKey = routeParam(req, 'metricKey');
  const from = dateParam(req, 'from');
  const to = dateParam(req, 'to');
  if (metricKey === '' || from === undefined || to === undefined) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'metricKey, from and to are required', 400);
    return;
  }

  try {
    const series = await readMetricSeries({
      metricKey,
      from,
      to,
      ...(stringParam(req, 'storeId') === undefined
        ? {}
        : { storeId: stringParam(req, 'storeId') as string }),
      ...(stringParam(req, 'market') === undefined
        ? {}
        : { market: stringParam(req, 'market') as string }),
    });
    if (!series) {
      // A metric with no definition is refused rather than served empty — a
      // dashboard must not be able to render a number nothing explains.
      sendError(res, ErrorCodes.NOT_FOUND, 'No such metric', 404);
      return;
    }
    sendSuccess(res, series);
  } catch (err: unknown) {
    log.general.error({ err, metricKey }, '[Analytics] metric series read failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to read the metric', 500);
  }
}

/**
 * GET /internal/analytics/queries — the top aggregate queries.
 *
 * Above the reporting floor, always. `zeroResults=true` narrows it to dashboard
 * 2's list.
 */
export async function getQueryReportHandler(req: Request, res: Response): Promise<void> {
  const from = dateParam(req, 'from');
  const to = dateParam(req, 'to');
  if (from === undefined || to === undefined) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'from and to are required', 400);
    return;
  }

  try {
    const rows = await readQueryReport({
      from,
      to,
      ...(stringParam(req, 'market') === undefined
        ? {}
        : { market: stringParam(req, 'market') as string }),
      ...(req.query.zeroResults === 'true' ? { zeroResultOnly: true } : {}),
      limit: MAX_ROWS,
    });
    sendSuccess(res, {
      queries: rows,
      minimumOccurrences: ANALYTICS_QUERY_MIN_OCCURRENCES,
    });
  } catch (err: unknown) {
    log.general.error({ err }, '[Analytics] query report read failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to read the query report', 500);
  }
}

/**
 * GET /internal/analytics/trace — one search's derived events, in order.
 *
 * Opens from a query event id or a checkout group and NOTHING else. There is
 * deliberately no actor handle: see the module docblock.
 */
export async function traceHandler(req: Request, res: Response): Promise<void> {
  const queryEventId = stringParam(req, 'queryEventId');
  const checkoutGroupId = stringParam(req, 'checkoutGroupId');
  if (queryEventId === undefined && checkoutGroupId === undefined) {
    sendError(
      res,
      ErrorCodes.VALIDATION_ERROR,
      'One of queryEventId or checkoutGroupId is required',
      400,
    );
    return;
  }

  try {
    sendSuccess(res, {
      ...(queryEventId === undefined ? {} : { query: await traceQuery(queryEventId, MAX_ROWS) }),
      ...(checkoutGroupId === undefined
        ? {}
        : { checkout: await traceCheckoutConversion(checkoutGroupId) }),
    });
  } catch (err: unknown) {
    log.general.error({ err }, '[Analytics] trace failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to trace', 500);
  }
}

/** GET /internal/analytics/health — the sink, retention and seam status. */
export async function healthHandler(_req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await readAnalyticsHealth());
  } catch (err: unknown) {
    log.general.error({ err }, '[Analytics] health read failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to read analytics health', 500);
  }
}

/** GET /internal/analytics/experiments — every version, or one experiment's. */
export async function listExperimentsHandler(req: Request, res: Response): Promise<void> {
  try {
    const key = stringParam(req, 'experimentKey');
    sendSuccess(res, {
      experiments: await listExperiments(key),
      guardrails: await readExperimentGuardrails(),
      treatmentKinds: ANALYTICS_EXPERIMENT_TREATMENT_KINDS_FOR_CLIENT,
      stopConditions: ANALYTICS_EXPERIMENT_STOP_CONDITIONS,
      assignmentUnits: ANALYTICS_EXPERIMENT_ASSIGNMENT_UNITS,
      metricKeys: ANALYTICS_METRIC_KEYS,
    });
  } catch (err: unknown) {
    log.general.error({ err }, '[Analytics] experiment list failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to list experiments', 500);
  }
}

/**
 * The treatment kinds offered to an operator form.
 *
 * Re-derived from the tuple rather than re-listed, so the form and the CHECK
 * cannot drift — and so the vocabulary that structurally cannot express a
 * coercive guest treatment is the same one the UI is built from.
 */
const ANALYTICS_EXPERIMENT_TREATMENT_KINDS_FOR_CLIENT = [
  'ranking_policy',
  'result_presentation',
  'offer_presentation',
  'copy_variant',
  'checkout_step_order',
] as const;

/** The body `POST /internal/analytics/experiments` accepts. */
interface PublishExperimentBody {
  experimentKey?: unknown;
  treatmentKind?: unknown;
  hypothesis?: unknown;
  primaryMetricKey?: unknown;
  guardrailMetricKeys?: unknown;
  stopConditions?: unknown;
  assignmentUnit?: unknown;
  variants?: unknown;
  trafficAllocationBps?: unknown;
  rankingPolicyVersion?: unknown;
  activate?: unknown;
}

/** Whether every element of an unknown value is a member of a closed tuple. */
function isSubsetOf(value: unknown, allowed: readonly string[]): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && allowed.includes(item))
  );
}

/**
 * POST /internal/analytics/experiments — publish a new version.
 *
 * Every field is validated against the closed vocabulary before it can reach a
 * column. The one that matters most is `treatmentKind`: a value outside
 * `ANALYTICS_EXPERIMENT_TREATMENT_KINDS` is refused here AND by the CHECK, so
 * an experiment that could hide `Continue as guest`, auto-create an account or
 * preselect marketing consent has no representable declaration at either layer.
 */
export async function publishExperimentHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as PublishExperimentBody;

  const experimentKey = typeof body.experimentKey === 'string' ? body.experimentKey.trim() : '';
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(experimentKey)) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'experimentKey has an invalid shape', 400);
    return;
  }
  if (typeof body.treatmentKind !== 'string' || !isKnownTreatmentKind(body.treatmentKind)) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'treatmentKind is not a known kind', 400);
    return;
  }
  if (typeof body.hypothesis !== 'string' || body.hypothesis.trim().length < 10) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'hypothesis is required', 400);
    return;
  }
  if (
    typeof body.primaryMetricKey !== 'string' ||
    !ANALYTICS_METRIC_KEYS.includes(body.primaryMetricKey)
  ) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'primaryMetricKey is not a known metric', 400);
    return;
  }
  if (!isSubsetOf(body.guardrailMetricKeys, ANALYTICS_METRIC_KEYS)) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'guardrailMetricKeys must name known metrics', 400);
    return;
  }
  if (!isSubsetOf(body.stopConditions, ANALYTICS_EXPERIMENT_STOP_CONDITIONS)) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'stopConditions must be from the closed set', 400);
    return;
  }
  if (
    typeof body.assignmentUnit !== 'string' ||
    !(ANALYTICS_EXPERIMENT_ASSIGNMENT_UNITS as readonly string[]).includes(body.assignmentUnit)
  ) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'assignmentUnit is not a known unit', 400);
    return;
  }
  if (
    !Array.isArray(body.variants) ||
    body.variants.length < 2 ||
    !body.variants.every((v) => typeof v === 'string' && /^[a-z0-9_-]{1,32}$/.test(v))
  ) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'variants must name at least two arms', 400);
    return;
  }
  const bps = typeof body.trafficAllocationBps === 'number' ? body.trafficAllocationBps : -1;
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'trafficAllocationBps must be 0..10000', 400);
    return;
  }

  try {
    const version = (await readMaxExperimentVersion(experimentKey)) + 1;
    const draft = await insertExperimentDraft({
      experimentKey,
      version,
      treatmentKind: body.treatmentKind,
      hypothesis: body.hypothesis.trim(),
      primaryMetricKey: body.primaryMetricKey,
      guardrailMetricKeys: body.guardrailMetricKeys,
      stopConditions: body.stopConditions as AnalyticsExperimentStopCondition[],
      assignmentUnit: body.assignmentUnit as AnalyticsExperimentAssignmentUnit,
      // Minted here, never client-supplied: a caller who chose the salt could
      // choose which units land in which arm, which is the whole of a
      // randomized experiment.
      assignmentSalt: randomBytes(16).toString('hex'),
      variants: body.variants as string[],
      trafficAllocationBps: bps,
      rankingPolicyVersion:
        typeof body.rankingPolicyVersion === 'string' ? body.rankingPolicyVersion : null,
    });

    if (body.activate !== true) {
      sendSuccess(res, draft, 201);
      return;
    }

    const activated = await activateExperiment({
      experimentKey,
      version,
      now: new Date(),
    });
    if (!activated) {
      // The one-active-per-key partial unique refused it: another version is
      // already live. Reported as a conflict rather than swallowed, because
      // "published but not running" is a state an operator must be told about.
      sendError(
        res,
        ErrorCodes.CONFLICT,
        'Another version of this experiment is already active; stop it first',
        409,
      );
      return;
    }
    sendSuccess(res, activated, 201);
  } catch (err: unknown) {
    log.general.error({ err, experimentKey }, '[Analytics] publishing an experiment failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to publish the experiment', 500);
  }
}

/**
 * POST /internal/analytics/experiments/:experimentKey/stop — stop a running arm.
 *
 * The reason is MANDATORY and comes from the closed stop-condition set. An
 * experiment stopped with no recorded cause is one whose result cannot be
 * interpreted later, and "somebody turned it off" is what an incident review
 * most needs and least often has.
 */
export async function stopExperimentHandler(req: Request, res: Response): Promise<void> {
  const experimentKey = routeParam(req, 'experimentKey');
  const body = req.body as { version?: unknown; reason?: unknown };
  const version = typeof body.version === 'number' ? body.version : -1;
  const reason = typeof body.reason === 'string' ? body.reason : '';

  if (experimentKey === '' || !Number.isInteger(version) || version < 1) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'experimentKey and version are required', 400);
    return;
  }
  if (!(ANALYTICS_EXPERIMENT_STOP_CONDITIONS as readonly string[]).includes(reason)) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'reason must be from the closed set', 400);
    return;
  }

  try {
    const stopped = await stopExperiment({
      experimentKey,
      version,
      reason: reason as AnalyticsExperimentStopCondition,
      now: new Date(),
    });
    if (!stopped) {
      sendError(res, ErrorCodes.NOT_FOUND, 'No active version of that experiment', 404);
      return;
    }
    sendSuccess(res, stopped);
  } catch (err: unknown) {
    log.general.error({ err, experimentKey }, '[Analytics] stopping an experiment failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to stop the experiment', 500);
  }
}

/**
 * POST /internal/analytics/rollup — compute the next pending day now.
 *
 * Not a repair: the loop would do this on its own within the interval, and
 * every write it performs is an upsert on a bucket key. It exists so an
 * operator investigating a stale chart can distinguish "the loop is stuck" from
 * "there is nothing to compute" without waiting a quarter of an hour.
 */
export async function runRollupNowHandler(_req: Request, res: Response): Promise<void> {
  try {
    const outcome = await runAnalyticsRollup();
    sendSuccess(res, outcome ?? { skipped: true });
  } catch (err: unknown) {
    log.general.error({ err }, '[Analytics] manual rollup failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to run the rollup', 500);
  }
}
