/**
 * The bounded referral pilot's operator handlers (#149).
 *
 * Thin, for the reason every other operator controller in this repo is: each
 * one validates, calls exactly one service or repository function, and
 * projects. The decisions live in `services/referral-pilot/`, which is pure and
 * testable without an HTTP request.
 *
 * ## What the publish handler refuses, and why it is here rather than in a CHECK
 *
 * A cohort may not go live with an unmonitored stop condition, with nobody on
 * its allow-list, or as a successor to a version nobody reviewed. None of the
 * three is expressible as a row CHECK — each is a statement about OTHER rows —
 * so they are enforced at the one moment a draft becomes binding, which is also
 * the cheapest moment to find them.
 */

import type { NextFunction, Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import {
  ALL_CURRENCY_CODES,
  REFERRAL_PILOT_REVIEW_DECISIONS,
  REFERRAL_PILOT_STOP_METRICS,
  REFERRAL_PILOT_STOP_SCOPES,
  REFERRAL_PILOT_SUBJECTS,
  REFERRAL_PILOT_THRESHOLD_UNITS,
} from '@mercaria/shared-types';
import type {
  CurrencyCode,
  ReferralPilotReviewDecision,
  ReferralPilotStopMetric,
  ReferralPilotStopScope,
  ReferralPilotSubject,
  ReferralPilotThresholdUnit,
} from '@mercaria/shared-types';
import { sendSuccess, sendError, ErrorCodes } from '../utils/api-response.js';
import { conflict, validationError } from '../lib/errors/error-codes.js';
import {
  addReferralPilotPartner,
  addReferralPilotThreshold,
  createReferralPilotCohortDraft,
  findActiveReferralPilotCohort,
  findReferralPilotCohortById,
  listReferralPilotCohorts,
  listReferralPilotPartners,
  listReferralPilotStops,
  listReferralPilotThresholds,
  publishReferralPilotCohortVersion,
  recordReferralPilotReview,
} from '../db/referralPilot/pilotRepository.js';
import {
  composeReferralPilotReportFor,
  evaluateReferralPilotStopThresholds,
  liftReferralPilotStop,
  raiseReferralPilotStop,
  readReferralPilotReport,
} from '../services/referral-pilot/pilot.service.js';
import type { ReferralPilotMeasurement } from '../services/referral-pilot/thresholds.js';

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError(`\`${name}\` is required.`);
  }
  return value;
}

/** Read one closed-set value off a validated body, narrowed rather than cast. */
function oneOf<T extends string>(values: readonly T[], value: unknown, field: string): T {
  const found = values.find((entry) => entry === value);
  if (found === undefined) throw validationError(`\`${field}\` is not a recognised value.`);
  return found;
}

function requiredDate(value: unknown, field: string): Date {
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw validationError(`\`${field}\` is not a date.`);
  return parsed;
}

/** Read the programme a pilot route is scoped to. Never optional: a pilot bounds ONE programme. */
function requiredProgramId(req: Request): string {
  const value = req.query['programId'];
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError('`programId` is required.');
  }
  return value;
}

/** GET — every version for one programme, newest first, with the active one named. */
export async function listReferralPilotCohortsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const programId = requiredProgramId(req);
    const versions = await listReferralPilotCohorts(programId);
    const active = await findActiveReferralPilotCohort(programId);
    sendSuccess(res, { versions, activeVersion: active?.version ?? null });
  } catch (error) {
    next(error);
  }
}

/** GET — one version's bounds, its allow-list, its thresholds and its stops. */
export async function referralPilotCohortTraceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cohortId = requiredParam(req, 'cohortId');
    const cohort = await findReferralPilotCohortById(cohortId);
    if (!cohort) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }
    const [partners, thresholds, stops] = await Promise.all([
      listReferralPilotPartners(cohortId),
      listReferralPilotThresholds(cohortId),
      listReferralPilotStops(cohortId),
    ]);
    sendSuccess(res, { cohort, partners, thresholds, stops });
  } catch (error) {
    next(error);
  }
}

/** POST — draft a version. A draft binds nothing until it is published. */
export async function createReferralPilotCohortHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const supersedes = body['supersedesCohortId'];
    const cohort = await createReferralPilotCohortDraft({
      cohortKey: String(body['cohortKey']),
      version: Number(body['version']),
      subject: oneOf<ReferralPilotSubject>(REFERRAL_PILOT_SUBJECTS, body['subject'], 'subject'),
      legalEntity: String(body['legalEntity']),
      programOwnerOxyUserId: String(body['programOwnerOxyUserId']),
      programId: String(body['programId']),
      programVersionId: String(body['programVersionId']),
      markets: (body['markets'] as string[]) ?? [],
      payoutCurrency: oneOf<CurrencyCode>(
        ALL_CURRENCY_CODES,
        body['payoutCurrency'],
        'payoutCurrency',
      ),
      startsAt: requiredDate(body['startsAt'], 'startsAt'),
      endsAt: requiredDate(body['endsAt'], 'endsAt'),
      maxAttributionsPerPartner: Number(body['maxAttributionsPerPartner']),
      maxAttributionsTotal: Number(body['maxAttributionsTotal']),
      rewardBudgetMinor: Number(body['rewardBudgetMinor']),
      manualReviewRequired: body['manualReviewRequired'] !== false,
      ...(typeof supersedes === 'string' ? { supersedesCohortId: supersedes } : {}),
      rationale: String(body['rationale']),
    });
    sendSuccess(res, cohort, 201);
  } catch (error) {
    next(error);
  }
}

/** POST — allow-list one partner. The trigger refuses a published cohort. */
export async function addReferralPilotPartnerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    await addReferralPilotPartner({
      cohortId: requiredParam(req, 'cohortId'),
      partnerId: String(body['partnerId']),
      addedByOxyUserId: getRequiredOxyUserId(req),
      note: String(body['note']),
    });
    sendSuccess(res, { added: true }, 201);
  } catch (error) {
    next(error);
  }
}

/** POST — publish one threshold. The trigger refuses a published cohort. */
export async function addReferralPilotThresholdHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const scope = oneOf<ReferralPilotStopScope>(
      REFERRAL_PILOT_STOP_SCOPES,
      body['scope'],
      'scope',
    );
    // A market-scoped stop covers NOTHING today, because a touch carries no
    // market and the admission gate has none to compare (`stopCovers`). A
    // threshold that could never bite is worse than an absent one — it reads as
    // a bound somebody published — so it is refused here rather than stored.
    if (scope === 'market') {
      throw validationError(
        'A market-scoped threshold cannot bite: a referral touch carries no market, so the ' +
          'admission gate has nothing to compare. Publish it as `pilot` or `partner`, and see ' +
          '`ReferralPilotEntry.market` for what would close this.',
      );
    }
    await addReferralPilotThreshold({
      cohortId: requiredParam(req, 'cohortId'),
      metric: oneOf<ReferralPilotStopMetric>(
        REFERRAL_PILOT_STOP_METRICS,
        body['metric'],
        'metric',
      ),
      unit: oneOf<ReferralPilotThresholdUnit>(
        REFERRAL_PILOT_THRESHOLD_UNITS,
        body['unit'],
        'unit',
      ),
      thresholdValue: Number(body['thresholdValue']),
      windowHours: Number(body['windowHours']),
      scope,
    });
    sendSuccess(res, { added: true }, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * POST — publish a draft.
 *
 * Three refusals, each a statement about other rows that no CHECK could carry:
 * every stop metric needs a published number, the allow-list must name at least
 * one partner, and a successor's predecessor must have been reviewed.
 */
export async function publishReferralPilotCohortHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cohortId = requiredParam(req, 'cohortId');
    const draft = await findReferralPilotCohortById(cohortId);
    if (!draft) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }

    const thresholds = await listReferralPilotThresholds(cohortId);
    const covered = new Set(thresholds.map((entry) => entry.metric));
    const missing = REFERRAL_PILOT_STOP_METRICS.filter((metric) => !covered.has(metric));
    if (missing.length > 0) {
      throw validationError(
        `This cohort has no threshold for ${missing.join(', ')}. Every stop condition needs a ` +
          'published number before the pilot may run under these bounds.',
      );
    }

    const partners = await listReferralPilotPartners(cohortId);
    if (partners.length === 0) {
      throw validationError(
        'This cohort allow-lists no partner, so nobody could earn under it.',
      );
    }

    // #149 acceptance 7, as a refusal rather than a promise: a widening is a new
    // version, and a new version may not go live until the one it supersedes has
    // a dated review with a decision, an author and a rationale.
    if (draft.supersedesCohortId !== null) {
      const predecessor = await findReferralPilotCohortById(draft.supersedesCohortId);
      if (!predecessor) throw validationError('The superseded version no longer exists.');
      if (predecessor.reviewedAt === null) {
        throw conflict(
          `Version ${predecessor.version} has no expansion review. Record one before ` +
            'publishing a version that supersedes it — expansion is a dated decision, never a ' +
            'rollout.',
        );
      }
    }

    const published = await publishReferralPilotCohortVersion({
      cohortId,
      publishedByOxyUserId: getRequiredOxyUserId(req),
    });
    if (!published) throw conflict('The cohort is not a draft.');
    sendSuccess(res, published);
  } catch (error) {
    next(error);
  }
}

/** POST — record the dated expansion review on one version. Written once. */
export async function recordReferralPilotReviewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const reviewed = await recordReferralPilotReview({
      cohortId: requiredParam(req, 'cohortId'),
      decision: oneOf<ReferralPilotReviewDecision>(
        REFERRAL_PILOT_REVIEW_DECISIONS,
        body['decision'],
        'decision',
      ),
      reviewedByOxyUserId: getRequiredOxyUserId(req),
      rationale: String(body['rationale']),
      closes: body['closes'] === true,
    });
    if (!reviewed) {
      throw conflict('This version already carries a review, or does not exist.');
    }
    sendSuccess(res, reviewed);
  } catch (error) {
    next(error);
  }
}

/** GET — the measured-economics report for the active cohort. */
export async function readReferralPilotReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const report = await readReferralPilotReport({ programId: requiredProgramId(req) });
    if (report === null) {
      sendError(res, ErrorCodes.NOT_FOUND, 'No active pilot cohort', 404);
      return;
    }
    sendSuccess(res, report);
  } catch (error) {
    next(error);
  }
}

/** GET — the same report for one named version, active or not. */
export async function readReferralPilotVersionReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cohortId = requiredParam(req, 'cohortId');
    const cohort = await findReferralPilotCohortById(cohortId);
    if (!cohort) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }
    sendSuccess(res, await composeReferralPilotReportFor(cohort, new Date()));
  } catch (error) {
    next(error);
  }
}

/** POST — evaluate the published thresholds against supplied measurements. */
export async function evaluateReferralPilotThresholdsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const supplied = Array.isArray(body['measurements']) ? body['measurements'] : [];
    const measurements: ReferralPilotMeasurement[] = supplied.map((entry) => {
      const row = entry as Record<string, unknown>;
      return {
        metric: oneOf<ReferralPilotStopMetric>(
          REFERRAL_PILOT_STOP_METRICS,
          row['metric'],
          'metric',
        ),
        unit: oneOf<ReferralPilotThresholdUnit>(
          REFERRAL_PILOT_THRESHOLD_UNITS,
          row['unit'],
          'unit',
        ),
        value: Number(row['value']),
        scopeRef: typeof row['scopeRef'] === 'string' ? row['scopeRef'] : '',
        sampleSize: Number(row['sampleSize']),
      };
    });
    sendSuccess(
      res,
      await evaluateReferralPilotStopThresholds({
        programId: requiredProgramId(req),
        measurements,
      }),
    );
  } catch (error) {
    next(error);
  }
}

/** POST — raise a stop by hand. Attributable, always. */
export async function raiseReferralPilotStopHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const scope = oneOf<ReferralPilotStopScope>(
      REFERRAL_PILOT_STOP_SCOPES,
      body['scope'],
      'scope',
    );
    const result = await raiseReferralPilotStop({
      cohortId: requiredParam(req, 'cohortId'),
      metric: oneOf<ReferralPilotStopMetric>(
        REFERRAL_PILOT_STOP_METRICS,
        body['metric'],
        'metric',
      ),
      scope,
      scopeRef: scope === 'pilot' ? '' : String(body['scopeRef']),
      raisedByOxyUserId: getRequiredOxyUserId(req),
      observedValue: Number(body['observedValue']),
      thresholdValue: Number(body['thresholdValue']),
      detail: String(body['detail']),
    });
    sendSuccess(res, result, result.raised ? 201 : 200);
  } catch (error) {
    next(error);
  }
}

/** POST — lift a live stop. Attributable, dated and explained, all three. */
export async function liftReferralPilotStopHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const lifted = await liftReferralPilotStop({
      stopId: requiredParam(req, 'stopId'),
      liftedByOxyUserId: getRequiredOxyUserId(req),
      reason: String(body['reason']),
    });
    if (!lifted) throw conflict('That stop is not live.');
    sendSuccess(res, { lifted: true });
  } catch (error) {
    next(error);
  }
}
