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
 * Two kinds of seller, ONE surface (ADR 0018 D3): a store and a private (P2P)
 * seller read and accept their terms through the same handlers, the same
 * selection and the same `fee_schedule_acceptances` rows, and differ only in how
 * the ROUTE establishes the owner:
 *
 *  - a store's is `req.store`, established by `loadStore` and gated by
 *    `requireStorePermission('store:manage')` — the SAME permission payment
 *    onboarding uses, and for the same reason: agreeing to what a store pays
 *    Mercaria is the owner's decision, and `store:manage` is the one permission
 *    an `admin` does not hold;
 *  - a private seller's is the caller (`getRequiredOxyUserId`), on `/seller` —
 *    the person selling IS the owner, as on `/seller/payments`.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxy.so/core/server';
import type {
  CurrencyCode,
  FeeScheduleAcceptanceSummary,
  SellerFeeScheduleView,
} from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import {
  findFeeScheduleAcceptance,
  insertFeeScheduleAcceptance,
  type FeeScheduleAcceptanceRow,
} from '../db/fees/feeScheduleRepository.js';
import {
  findApplicableSchedule,
  findApplicableSellerSchedule,
  previewFee,
  toFeeScheduleSummary,
  type ConnectedMarketplaceSellerType,
} from '../services/fees/order-fees.service.js';
import { nativeRailPresentmentCurrencies } from '../services/payments/native-rail.js';
import { sendSuccess } from '../utils/api-response.js';
import { conflict, notFound, respondWithError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';
import type { AcceptFeeScheduleBody, FeePreviewBody } from '../middleware/fees-schemas.js';

/**
 * The seller whose fee terms a route reads and accepts, as the ROUTE
 * establishes it — never from the body, exactly as `payments.controller.ts`
 * resolves the owner of a payment account.
 *
 * The two kinds differ in one fact: a store has a currency of its own, asked
 * before the card rail's; a private seller has none (ADR 0018 D3).
 */
interface FeeOwner {
  ownerType: ConnectedMarketplaceSellerType;
  ownerId: string;
  ownCurrency?: CurrencyCode;
}

type FeeOwnerOf = (req: Request) => FeeOwner;

/** The loaded store (guaranteed by `loadStore`, gated on `store:manage`). */
const storeFeeOwner: FeeOwnerOf = (req) => {
  const store = req.store;
  if (!store) {
    throw notFound('Store not loaded');
  }
  return {
    ownerType: 'store',
    ownerId: store.id,
    ownCurrency: store.defaultCurrency as CurrencyCode,
  };
};

/** The calling private (P2P) seller. The caller IS the owner on this surface. */
const sellerFeeOwner: FeeOwnerOf = (req) => ({
  ownerType: 'user',
  ownerId: getRequiredOxyUserId(req),
});

/** The schedule this owner's card sales select now — the one checkout would. */
async function applicableScheduleFor(owner: FeeOwner) {
  return await findApplicableSellerSchedule({
    sellerType: owner.ownerType,
    ...(owner.ownCurrency === undefined ? {} : { ownCurrency: owner.ownCurrency }),
    saleCurrencies: nativeRailPresentmentCurrencies(),
  });
}

function toAcceptanceSummary(row: FeeScheduleAcceptanceRow): FeeScheduleAcceptanceSummary {
  return {
    scheduleKey: row.scheduleKey,
    scheduleVersion: row.scheduleVersion,
    termsVersion: row.termsVersion,
    acceptedByOxyUserId: row.acceptedByOxyUserId,
    acceptedAt: row.createdAt.toISOString(),
  };
}

/**
 * The schedule currently applicable to this seller's sales (selected exactly as
 * checkout selects it, at "now" — `findApplicableSellerSchedule`), plus this
 * seller's acceptance of that exact version when one exists.
 */
function feeScheduleHandler(ownerOf: FeeOwnerOf) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const owner = ownerOf(req);
      const schedule = await applicableScheduleFor(owner);
      if (!schedule) {
        sendSuccess<SellerFeeScheduleView>(res, {});
        return;
      }
      const acceptance = await findFeeScheduleAcceptance(getDb(), {
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        scheduleKey: schedule.scheduleKey,
        scheduleVersion: schedule.version,
      });
      sendSuccess<SellerFeeScheduleView>(res, {
        schedule: toFeeScheduleSummary(schedule),
        ...(acceptance ? { acceptance: toAcceptanceSummary(acceptance) } : {}),
      });
    } catch (err) {
      log.general.error({ err }, 'Failed to load the fee schedule');
      respondWithError(res, err, 'Failed to load the fee schedule');
    }
  };
}

/**
 * Record the seller's acceptance of the CURRENT schedule version's terms, in
 * `fee_schedule_acceptances` — the one table checkout's gate reads, for a store
 * (`owner_type = 'store'`) and a private seller (`'user'`) alike.
 *
 * The body echoes what the seller's screen showed and every part of it is
 * checked against the schedule actually in force — a stale dialog (the schedule
 * moved underneath it) is refused with a conflict naming the current version,
 * never recorded against the wrong one. A replay of the same acceptance
 * converges on the existing row (`ON CONFLICT DO NOTHING` in the repository),
 * so the audit trail holds one consent per version however many times the
 * button was pressed.
 */
function acceptFeeScheduleHandler(ownerOf: FeeOwnerOf) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const owner = ownerOf(req);
      const body = req.body as AcceptFeeScheduleBody;
      const schedule = await applicableScheduleFor(owner);
      if (!schedule) {
        throw conflict('No fee schedule currently applies to your sales.');
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
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        acceptedByOxyUserId: getRequiredOxyUserId(req),
      });
      sendSuccess(res, toAcceptanceSummary(acceptance.row), acceptance.created ? 201 : 200);
    } catch (err) {
      log.general.error({ err }, 'Failed to record fee schedule acceptance');
      respondWithError(res, err, 'Failed to accept the fee schedule');
    }
  };
}

/** GET /admin/stores/:storeId/fees/schedule */
export const getStoreFeeScheduleHandler = feeScheduleHandler(storeFeeOwner);
/** POST /admin/stores/:storeId/fees/accept — the owner's consent (`store:manage`). */
export const acceptStoreFeeScheduleHandler = acceptFeeScheduleHandler(storeFeeOwner);
/** GET /seller/fees/schedule — the private seller's own terms (ADR 0018 D3). */
export const getSellerFeeScheduleHandler = feeScheduleHandler(sellerFeeOwner);
/** POST /seller/fees/accept — the private seller's own consent; the caller IS the owner. */
export const acceptSellerFeeScheduleHandler = acceptFeeScheduleHandler(sellerFeeOwner);

/**
 * POST /admin/stores/:storeId/fees/preview — the fee and net on a hypothetical
 * discounted item subtotal, via the SAME pure arithmetic checkout applies.
 */
export async function previewStoreFeeHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as FeePreviewBody;
    storeFeeOwner(req);
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
