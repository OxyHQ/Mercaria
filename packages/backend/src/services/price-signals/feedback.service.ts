/**
 * Merchant correction reports (#82 monitoring 4).
 *
 * A merchant saying "this signal about my offer is wrong" is a MEASUREMENT of
 * the policy, not a support ticket — which is why the reason is a closed set and
 * the note beside it is optional. The number monitoring 4 exists to produce is the
 * ratio of `resolved` to `rejected` per reason, and free text cannot be counted.
 *
 * Filing changes NOTHING about a signal. There is deliberately no path here that
 * hides an observation, suppresses a label or pins a price: every one of those
 * would be a way to make a price history say something nobody observed, which is
 * the single property that makes it worth keeping (#78's operator surface makes
 * the same three refusals for the same reason).
 */

import type {
  ConditionGroup,
  CurrencyCode,
  PriceSignalFeedbackReason,
  PriceSignalKind,
} from '@mercaria/shared-types';
import {
  closePriceSignalFeedback,
  fileOrFindOpenPriceSignalFeedback,
  listOpenPriceSignalFeedback,
  listPriceSignalFeedbackForMerchant,
  type PriceSignalFeedbackRow,
} from '../../db/priceSignals/priceSignalFeedbackRepository.js';
import { findVerifiedMerchantClaimant } from '../../db/priceSignals/priceSignalSubjectRepository.js';
import { notFound } from '../../lib/errors/error-codes.js';

export interface FilePriceSignalFeedbackInput {
  readonly merchantId: string;
  readonly oxyUserId: string;
  readonly canonicalProductId?: string;
  readonly canonicalVariantId?: string;
  readonly segment: ConditionGroup;
  readonly market?: string;
  readonly currency: CurrencyCode;
  readonly signalKind: PriceSignalKind;
  readonly reason: PriceSignalFeedbackReason;
  readonly note?: string;
}

/**
 * File a report, or converge on the open one that already says this.
 *
 * The authorization is #83's verdict and the refusal is a 404, for the reason the
 * competitiveness read gives: a distinguishable 403 would let anybody enumerate
 * which merchants have been claimed.
 */
export async function filePriceSignalFeedback(
  input: FilePriceSignalFeedbackInput,
): Promise<PriceSignalFeedbackRow> {
  const claimant = await findVerifiedMerchantClaimant(input.merchantId);
  if (claimant === null || claimant !== input.oxyUserId) throw notFound('Merchant not found');

  return fileOrFindOpenPriceSignalFeedback({
    merchantId: input.merchantId,
    reportedByOxyUserId: input.oxyUserId,
    scopeKind: input.canonicalVariantId === undefined ? 'canonical_product' : 'canonical_variant',
    ...(input.canonicalProductId === undefined ? {} : { canonicalProductId: input.canonicalProductId }),
    ...(input.canonicalVariantId === undefined ? {} : { canonicalVariantId: input.canonicalVariantId }),
    segment: input.segment,
    ...(input.market === undefined ? {} : { market: input.market }),
    displayCurrency: input.currency,
    signalKind: input.signalKind,
    reason: input.reason,
    ...(input.note === undefined ? {} : { note: input.note }),
  });
}

/** One merchant's own reports. Scoped by the same verified claim. */
export async function listOwnPriceSignalFeedback(
  merchantId: string,
  oxyUserId: string,
  limit: number,
): Promise<PriceSignalFeedbackRow[]> {
  const claimant = await findVerifiedMerchantClaimant(merchantId);
  if (claimant === null || claimant !== oxyUserId) throw notFound('Merchant not found');
  return listPriceSignalFeedbackForMerchant(merchantId, limit);
}

/** The operator queue. */
export async function listPriceSignalFeedbackQueue(limit: number): Promise<PriceSignalFeedbackRow[]> {
  return listOpenPriceSignalFeedback(limit);
}

/**
 * Close a report, attributably.
 *
 * `resolved` and `rejected` are kept apart because the correction RATE is the
 * ratio between them, and the CAS on `resolved_at IS NULL` is what makes a second
 * close converge on the first operator's reason rather than overwrite it.
 */
export async function closePriceSignalFeedbackReport(input: {
  readonly id: string;
  readonly status: 'resolved' | 'rejected';
  readonly operatorOxyUserId: string;
  readonly resolutionNote?: string;
  readonly now?: Date;
}): Promise<PriceSignalFeedbackRow> {
  const closed = await closePriceSignalFeedback({
    id: input.id,
    status: input.status,
    resolvedByOxyUserId: input.operatorOxyUserId,
    ...(input.resolutionNote === undefined ? {} : { resolutionNote: input.resolutionNote }),
    now: input.now ?? new Date(),
  });
  if (closed === undefined) throw notFound('Open correction report not found');
  return closed;
}
