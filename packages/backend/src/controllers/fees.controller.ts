/**
 * The merchant fee surface (#88) — what a store sees, accepts and previews.
 *
 * Everything answers from the SAME selection and the SAME pure arithmetic
 * checkout uses (`services/fees/`), which is the whole of merchant experience 3
 * and trust rule 3: the schedule the dashboard shows, the fee the preview
 * quotes and the fee an order snapshots cannot disagree, because they are one
 * code path asked three ways. Nothing here exposes a buyer, a guest, or any
 * per-buyer figure — a schedule scoped by buyer facts is unrepresentable, so
 * there is nothing of the kind to show (merchant experience 8–9).
 *
 * The owner is `req.store`, established by `loadStore` and gated by
 * `requireStorePermission('store:manage')` on the route — the SAME permission
 * payment onboarding uses, and for the same reason: agreeing to what a store
 * pays Mercaria is the owner's decision, and `store:manage` is the one
 * permission an `admin` does not hold.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { CurrencyCode, StoreFeeScheduleView } from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import {
  findFeeScheduleAcceptance,
  insertFeeScheduleAcceptance,
} from '../db/fees/feeScheduleRepository.js';
import {
  findApplicableSchedule,
  previewFee,
  toFeeScheduleSummary,
} from '../services/fees/order-fees.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { conflict, notFound, respondWithError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';
import type { AcceptFeeScheduleBody, FeePreviewBody } from '../middleware/fees-schemas.js';

/** The loaded store for the current request (guaranteed by `loadStore`). */
function loadedStore(req: Request): { id: string; defaultCurrency: CurrencyCode } {
  const store = req.store;
  if (!store) {
    throw notFound('Store not loaded');
  }
  return { id: store.id, defaultCurrency: store.defaultCurrency as CurrencyCode };
}

/**
 * GET /admin/stores/:storeId/fees/schedule — the schedule currently applicable
 * to this store (selected exactly as checkout selects it, at "now", for
 * `sellerType: 'store'` in the store's own currency), plus this store's
 * acceptance of that exact version when one exists.
 */
export async function getStoreFeeScheduleHandler(req: Request, res: Response): Promise<void> {
  try {
    const store = loadedStore(req);
    const schedule = await findApplicableSchedule({
      sellerType: 'store',
      currency: store.defaultCurrency,
    });
    if (!schedule) {
      sendSuccess<StoreFeeScheduleView>(res, {});
      return;
    }
    const acceptance = await findFeeScheduleAcceptance(getDb(), {
      ownerType: 'store',
      ownerId: store.id,
      scheduleKey: schedule.scheduleKey,
      scheduleVersion: schedule.version,
    });
    sendSuccess<StoreFeeScheduleView>(res, {
      schedule: toFeeScheduleSummary(schedule),
      ...(acceptance
        ? {
            acceptance: {
              scheduleKey: acceptance.scheduleKey,
              scheduleVersion: acceptance.scheduleVersion,
              termsVersion: acceptance.termsVersion,
              acceptedByOxyUserId: acceptance.acceptedByOxyUserId,
              acceptedAt: acceptance.createdAt.toISOString(),
            },
          }
        : {}),
    });
  } catch (err) {
    log.general.error({ err }, 'Failed to load store fee schedule');
    respondWithError(res, err, 'Failed to load the fee schedule');
  }
}

/**
 * POST /admin/stores/:storeId/fees/accept — record the owner's acceptance of
 * the CURRENT schedule version's terms.
 *
 * The body echoes what the owner's screen showed and every part of it is
 * checked against the schedule actually in force — a stale dialog (the schedule
 * moved underneath it) is refused with a conflict naming the current version,
 * never recorded against the wrong one. A replay of the same acceptance
 * converges on the existing row (`ON CONFLICT DO NOTHING` in the repository),
 * so the audit trail holds one consent per version however many times the
 * button was pressed.
 */
export async function acceptStoreFeeScheduleHandler(req: Request, res: Response): Promise<void> {
  try {
    const store = loadedStore(req);
    const body = req.body as AcceptFeeScheduleBody;
    const schedule = await findApplicableSchedule({
      sellerType: 'store',
      currency: store.defaultCurrency,
    });
    if (!schedule) {
      throw conflict('No fee schedule is currently applicable to this store.');
    }
    if (
      schedule.scheduleKey !== body.scheduleKey ||
      schedule.version !== body.version ||
      schedule.termsVersion !== body.termsVersion
    ) {
      throw conflict(
        `The applicable fee schedule is now ${schedule.scheduleKey} v${String(schedule.version)} ` +
          `(terms ${schedule.termsVersion}); reload it and accept the current version.`,
      );
    }
    const acceptance = await insertFeeScheduleAcceptance(getDb(), {
      scheduleKey: schedule.scheduleKey,
      scheduleVersion: schedule.version,
      termsVersion: schedule.termsVersion,
      ownerType: 'store',
      ownerId: store.id,
      acceptedByOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(
      res,
      {
        scheduleKey: acceptance.row.scheduleKey,
        scheduleVersion: acceptance.row.scheduleVersion,
        termsVersion: acceptance.row.termsVersion,
        acceptedByOxyUserId: acceptance.row.acceptedByOxyUserId,
        acceptedAt: acceptance.row.createdAt.toISOString(),
      },
      acceptance.created ? 201 : 200,
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to record fee schedule acceptance');
    respondWithError(res, err, 'Failed to accept the fee schedule');
  }
}

/**
 * POST /admin/stores/:storeId/fees/preview — the fee and net on a hypothetical
 * discounted item subtotal, via the SAME pure arithmetic checkout applies.
 */
export async function previewStoreFeeHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as FeePreviewBody;
    loadedStore(req);
    const schedule = await findApplicableSchedule({
      sellerType: 'store',
      currency: body.currency,
    });
    sendSuccess(
      res,
      previewFee({ schedule, basisMinor: body.basisAmount, currency: body.currency }),
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to preview the marketplace fee');
    respondWithError(res, err, 'Failed to preview the marketplace fee');
  }
}
