/**
 * Rows → DTOs, and the field list IS the boundary (#79 abuse rule 6).
 *
 * Every projection here NAMES every field it emits — the `provider_accounts`
 * precedent from #46 — rather than spreading a row. A spread is how a column
 * added later reaches a client nobody re-reviewed, and the columns in this
 * domain include a buyer's own price target, which issue abuse rule 6 says no
 * merchant-facing surface may see. There is no merchant-facing projection here
 * at all, and the absence is what enforces it: a merchant surface would have to
 * write one.
 */

import type {
  ConditionGroup,
  OfferKind,
  PriceAlert,
  PriceAlertNotificationView,
  PriceAlertResolution,
  PriceAlertTrigger,
  PriceAlertTriggerQuote,
} from '@mercaria/shared-types';
import type { PriceAlertRow } from '../../db/priceAlerts/priceAlertRepository.js';
import type {
  PriceAlertTriggerQuoteRow,
  PriceAlertTriggerRow,
} from '../../db/priceAlerts/priceAlertTriggerRepository.js';
import type { PriceAlertNotificationRow } from '../../db/priceAlerts/priceAlertNotificationRepository.js';

/** The split ambiguity, in the union #80 established one domain over. */
function toResolution(
  row: PriceAlertRow,
  splitTargets: ReadonlyMap<string, string | null>,
): PriceAlertResolution {
  if (row.resolutionState !== 'ambiguous_after_split' || !row.splitJobId) {
    return { state: 'resolved' };
  }
  // The target the JOB has minted, read live, with the alert's own snapshot as
  // the fallback: a split that has not reached its `mint` phase has no second
  // candidate yet, and inventing one would ask the buyer to choose between a
  // product and nothing.
  const target = splitTargets.get(row.splitJobId) ?? row.splitTargetCanonicalProductId;
  return {
    state: 'ambiguous_after_split',
    splitJobId: row.splitJobId,
    sourceCanonicalProductId: row.canonicalProductId,
    ...(target ? { targetCanonicalProductId: target } : {}),
  };
}

export function toPriceAlertDTO(
  row: PriceAlertRow,
  splitTargets: ReadonlyMap<string, string | null> = new Map(),
): PriceAlert {
  return {
    id: row.id,
    canonicalProductId: row.canonicalProductId,
    ...(row.canonicalVariantId ? { canonicalVariantId: row.canonicalVariantId } : {}),
    target: { amount: row.targetAmount, currency: row.targetCurrency },
    basis: row.basis,
    conditionGroups: row.conditionGroups as readonly ConditionGroup[],
    ...(row.market ? { market: row.market } : {}),
    sellerScope: row.sellerScope,
    proximityScope: row.proximityScope,
    ...(row.merchantId ? { merchantId: row.merchantId } : {}),
    ...(row.storefrontId ? { storefrontId: row.storefrontId } : {}),
    availabilityRequirement: row.availabilityRequirement,
    ...(row.minimumAvailableQuantity === null
      ? {}
      : { minimumAvailableQuantity: row.minimumAvailableQuantity }),
    requirePickupAvailable: row.requirePickupAvailable,
    state: row.state,
    repeatPolicy: row.repeatPolicy,
    ...(row.resetThresholdAmount === null
      ? {}
      : { resetThreshold: { amount: row.resetThresholdAmount, currency: row.targetCurrency } }),
    ...(row.cooldownSeconds === null ? {} : { cooldownSeconds: row.cooldownSeconds }),
    ...(row.quietHoursStartMinute === null ||
    row.quietHoursEndMinute === null ||
    row.quietHoursTimeZone === null
      ? {}
      : {
          quietHours: {
            startMinute: row.quietHoursStartMinute,
            endMinute: row.quietHoursEndMinute,
            timeZone: row.quietHoursTimeZone,
          },
        }),
    ...(row.locale ? { locale: row.locale } : {}),
    emailOptIn: row.emailOptIn,
    resolution: toResolution(row, splitTargets),
    createdAt: row.createdAt.toISOString(),
    ...(row.lastEvaluatedAt ? { lastEvaluatedAt: row.lastEvaluatedAt.toISOString() } : {}),
    ...(row.lastTriggeredAt ? { lastTriggeredAt: row.lastTriggeredAt.toISOString() } : {}),
    ...(row.lastDeliveredAt ? { lastDeliveredAt: row.lastDeliveredAt.toISOString() } : {}),
    ...(row.lastTriggeredAmount === null
      ? {}
      : {
          lastTriggeredAmount: {
            amount: row.lastTriggeredAmount,
            currency: row.targetCurrency,
          },
        }),
    ...(row.rehomedFromCanonicalProductId
      ? { rehomedFromCanonicalProductId: row.rehomedFromCanonicalProductId }
      : {}),
    ...(row.rehomedAt ? { rehomedAt: row.rehomedAt.toISOString() } : {}),
  };
}

export function toPriceAlertTriggerDTO(
  row: PriceAlertTriggerRow,
  quotes: readonly PriceAlertTriggerQuoteRow[],
): PriceAlertTrigger {
  const projected: PriceAlertTriggerQuote[] = quotes.map((quote) => ({
    component: quote.component,
    snapshot: {
      from: quote.fxFrom as PriceAlertTriggerQuote['snapshot']['from'],
      to: quote.fxTo as PriceAlertTriggerQuote['snapshot']['to'],
      rate: quote.fxRate,
      provider: quote.fxProvider,
      asOf: quote.fxAsOf.toISOString(),
    },
  }));

  return {
    id: row.id,
    alertId: row.alertId,
    offerId: row.offerId,
    canonicalProductId: row.canonicalProductId,
    canonicalVariantId: row.canonicalVariantId,
    observedPriceVersion: row.observedPriceVersion,
    policyVersion: row.alertPolicyVersion,
    basis: row.basis,
    amount: { amount: row.amountAmount, currency: row.amountCurrency },
    target: { amount: row.targetAmount, currency: row.targetCurrency },
    nativeItemPrice: { amount: row.nativeItemAmount, currency: row.nativeItemCurrency },
    ...(row.nativeDeliveryAmount === null || row.nativeDeliveryCurrency === null
      ? {}
      : {
          nativeDeliveryCost: {
            amount: row.nativeDeliveryAmount,
            currency: row.nativeDeliveryCurrency,
          },
        }),
    quotes: projected,
    ...(row.conditionGroup ? { conditionGroup: row.conditionGroup } : {}),
    ...(row.merchantId ? { merchantId: row.merchantId } : {}),
    offerKind: row.offerKind as OfferKind,
    nativeCheckoutEligible: row.nativeCheckoutEligible,
    triggeredAt: row.createdAt.toISOString(),
  };
}

/**
 * One delivery record, with `openedAt` supplied by the caller's JOIN.
 *
 * `openedAt` is a PARAMETER rather than a column read, because it lives on
 * `notifications.read_at` and this domain stores it nowhere — see
 * `PriceAlertNotificationState`, which has no `opened` member for that reason.
 */
export function toPriceAlertNotificationView(
  row: PriceAlertNotificationRow,
  openedAt: Date | null,
): PriceAlertNotificationView {
  return {
    id: row.id,
    triggerId: row.triggerId,
    channel: row.channel,
    state: row.state,
    ...(row.suppressionReason ? { suppressionReason: row.suppressionReason } : {}),
    attempts: row.attempts,
    queuedAt: row.createdAt.toISOString(),
    ...(row.deliveredAt ? { deliveredAt: row.deliveredAt.toISOString() } : {}),
    ...(openedAt ? { openedAt: openedAt.toISOString() } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
  };
}
