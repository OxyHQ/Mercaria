/**
 * Fee schedule administration (#88) — the platform operator's surface.
 *
 * Lives under `/internal/payments/*` behind `requirePaymentOperator`, beside
 * the #50 tooling, because "what commission does the marketplace charge" is a
 * platform-wide decision no store membership can authorize. Unlike the repair
 * surface, NOTHING here moves money: a schedule only prices orders that have
 * not been placed yet, and every placed order keeps its immutable snapshot
 * whatever happens in this file.
 *
 * The audit is structural: `created_by` on the draft, `approved_by` +
 * `activated_at` on the activation (a CHECK refuses an anonymous active row),
 * and the immutability trigger makes "edit an active schedule" impossible for
 * this surface and for every other client — publishing a NEW version is the
 * only way policy changes (trust rules 4–5).
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { getDb } from '../db/postgres.js';
import {
  activateFeeSchedule,
  insertFeeSchedule,
  listFeeSchedules,
  retireFeeSchedule,
} from '../db/fees/feeScheduleRepository.js';
import { toFeeScheduleSummary } from '../services/fees/order-fees.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { conflict, respondWithError } from '../lib/errors/error-codes.js';
import { isUniqueViolation } from '@oxyhq/db';
import { log } from '../lib/logger.js';
import type { FeeScheduleCreateBody } from '../middleware/fees-schemas.js';

/**
 * The operator projection: the merchant summary plus the row id the two
 * lifecycle routes address, and the audit columns the merchant DTO omits.
 */
function operatorView(row: Parameters<typeof toFeeScheduleSummary>[0]) {
  return {
    id: row.id,
    ...toFeeScheduleSummary(row),
    createdByOxyUserId: row.createdByOxyUserId,
    ...(row.approvedByOxyUserId ? { approvedByOxyUserId: row.approvedByOxyUserId } : {}),
  };
}

/** GET /internal/payments/fee-schedules — every version of every schedule. */
export async function listFeeSchedulesHandler(req: Request, res: Response): Promise<void> {
  try {
    const scheduleKey = typeof req.query.scheduleKey === 'string' ? req.query.scheduleKey : undefined;
    const rows = await listFeeSchedules(getDb(), scheduleKey ? { scheduleKey } : undefined);
    sendSuccess(res, { schedules: rows.map(operatorView) });
  } catch (err) {
    log.general.error({ err }, 'Failed to list fee schedules');
    respondWithError(res, err, 'Failed to list fee schedules');
  }
}

/** POST /internal/payments/fee-schedules — draft a new version. */
export async function createFeeScheduleHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as FeeScheduleCreateBody;
    const row = await insertFeeSchedule(getDb(), {
      scheduleKey: body.scheduleKey,
      version: body.version,
      name: body.name,
      merchantSummary: body.merchantSummary,
      effectiveStart: new Date(body.effectiveStart),
      ...(body.effectiveEnd ? { effectiveEnd: new Date(body.effectiveEnd) } : {}),
      ...(body.eligibleSellerType ? { eligibleSellerType: body.eligibleSellerType } : {}),
      ...(body.eligibleCurrency ? { eligibleCurrency: body.eligibleCurrency } : {}),
      percentageBps: body.percentageBps,
      ...(body.fixedFeeMinor !== undefined && body.eligibleCurrency
        ? { fixedFee: { amount: body.fixedFeeMinor, currency: body.eligibleCurrency } }
        : {}),
      ...(body.minFeeMinor !== undefined ? { minFeeMinor: body.minFeeMinor } : {}),
      ...(body.maxFeeMinor !== undefined ? { maxFeeMinor: body.maxFeeMinor } : {}),
      ...(body.taxTreatment ? { taxTreatment: body.taxTreatment } : {}),
      ...(body.refundPolicy ? { refundPolicy: body.refundPolicy } : {}),
      termsVersion: body.termsVersion,
      createdByOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, operatorView(row), 201);
  } catch (err) {
    if (isUniqueViolation(err, 'fee_schedules_key_version_key')) {
      respondWithError(
        res,
        conflict('That schedule key and version already exist; draft the next version number.'),
        'Failed to draft the fee schedule',
      );
      return;
    }
    log.general.error({ err }, 'Failed to draft a fee schedule');
    respondWithError(res, err, 'Failed to draft the fee schedule');
  }
}

/**
 * POST /internal/payments/fee-schedules/:id/activate — publish a draft,
 * superseding the key's current active version in the same transaction.
 */
export async function activateFeeScheduleHandler(req: Request, res: Response): Promise<void> {
  try {
    const row = await activateFeeSchedule(getDb(), {
      id: routeParam(req, 'id'),
      approvedByOxyUserId: getRequiredOxyUserId(req),
    });
    if (!row) {
      throw conflict('Only a draft schedule version can be activated.');
    }
    sendSuccess(res, operatorView(row));
  } catch (err) {
    log.general.error({ err }, 'Failed to activate a fee schedule');
    respondWithError(res, err, 'Failed to activate the fee schedule');
  }
}

/** POST /internal/payments/fee-schedules/:id/retire — withdraw without replacement. */
export async function retireFeeScheduleHandler(req: Request, res: Response): Promise<void> {
  try {
    const row = await retireFeeSchedule(getDb(), routeParam(req, 'id'));
    if (!row) {
      throw conflict('Only an active or draft schedule version can be retired.');
    }
    sendSuccess(res, operatorView(row));
  } catch (err) {
    log.general.error({ err }, 'Failed to retire a fee schedule');
    respondWithError(res, err, 'Failed to retire the fee schedule');
  }
}
