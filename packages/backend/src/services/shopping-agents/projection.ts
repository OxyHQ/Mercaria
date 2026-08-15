/**
 * Rows to DTOs, every field NAMED (#97 privacy 3).
 *
 * The `provider_accounts` precedent: a projection that spreads a row ships
 * whatever somebody adds to the table next, and the two columns this domain
 * holds about a person are exactly the two a spread would ship.
 * `shopping_agents.description` is registered in `protectedColumns.ts`, so the
 * owner's own read names it explicitly and every other read cannot see it at
 * all — not at runtime and not in the row type.
 */

import type {
  ConditionGroup,
  CurrencyCode,
  ShoppingAgent,
  ShoppingAgentFinding,
  ShoppingAgentLine,
  ShoppingAgentNotificationChannel,
  ShoppingAgentNotificationView,
  ShoppingAgentRecordRef,
  ShoppingAgentSelectedLine,
  ShoppingAgentSummary,
  ShoppingAgentTriggerSource,
} from '@mercaria/shared-types';
import type {
  ShoppingAgentFactsRow,
  ShoppingAgentLineRow,
  ShoppingAgentRow,
} from '../../db/shoppingAgents/shoppingAgentRepository.js';
import type {
  ShoppingAgentFindingLineRow,
  ShoppingAgentFindingRow,
} from '../../db/shoppingAgents/shoppingAgentFindingRepository.js';
import type { ShoppingAgentNotificationRow } from '../../db/shoppingAgents/shoppingAgentNotificationRepository.js';

/**
 * One agent, as its owner sees it.
 *
 * The parameter is the UNION of the two row shapes on purpose. `description` is
 * in `PROTECTED_COLUMNS`, so every read but the owner's own detail read comes
 * back as `ShoppingAgentFactsRow` — a type with no such property — and the
 * `'description' in row` guard is what lets one projection serve both without
 * an `as` that would put the column back into a list response.
 */
export function toShoppingAgentDTO(
  row: ShoppingAgentRow | ShoppingAgentFactsRow,
  lines: readonly ShoppingAgentLineRow[],
): ShoppingAgent {
  const description = 'description' in row ? row.description : null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    ...(description === null ? {} : { description }),
    state: row.state,
    revision: row.revision,
    displayCurrency: row.displayCurrency as CurrencyCode,
    priceBasis: row.priceBasis,
    channelPolicy: row.channelPolicy,
    ...(row.market === null ? {} : { market: row.market }),
    conditionGroups: row.conditionGroups as readonly ConditionGroup[],
    excludedMerchantIds: row.excludedMerchantIds,
    ...(row.targetAmount === null || row.targetCurrency === null
      ? {}
      : { target: { amount: row.targetAmount, currency: row.targetCurrency as CurrencyCode } }),
    lines: lines.map(toShoppingAgentLineDTO),
    constraints: row.constraintSet,
    triggerSources: row.triggerSources as readonly ShoppingAgentTriggerSource[],
    notificationChannels:
      row.notificationChannels as readonly ShoppingAgentNotificationChannel[],
    cooldownSeconds: row.cooldownSeconds,
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
    ambiguityState: row.ambiguityState,
    ...(row.splitJobId === null ? {} : { splitJobId: row.splitJobId }),
    ...(row.splitTargetCanonicalProductId === null
      ? {}
      : { splitTargetCanonicalProductId: row.splitTargetCanonicalProductId }),
    ...(row.rehomedFromCanonicalProductId === null
      ? {}
      : { rehomedFromCanonicalProductId: row.rehomedFromCanonicalProductId }),
    authorization: {
      authorizedAt: row.authorizedAt.toISOString(),
      termsVersion: row.termsVersion,
      constraintDigest: row.constraintDigest,
    },
    versions: {
      agentPolicyVersion: row.agentPolicyVersion,
      constraintEvaluationVersion: row.constraintEvaluationVersion,
      normalizationRuleVersion: row.normalizationRuleVersion,
      comparisonPolicyVersion: row.comparisonPolicyVersion,
      // The agent itself was never RANKED, so it carries no ranking version —
      // a finding does, because a finding was. Filling this from anywhere would
      // attribute an ordering to weights nothing consulted.
      rankingPolicyVersion: '',
      ...(row.parserVersion === null ? {} : { parserVersion: row.parserVersion }),
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.lastEvaluatedAt === null
      ? {}
      : { lastEvaluatedAt: row.lastEvaluatedAt.toISOString() }),
    ...(row.lastNotifiedAt === null ? {} : { lastNotifiedAt: row.lastNotifiedAt.toISOString() }),
    ...(row.nextScheduledAt === null
      ? {}
      : { nextScheduledAt: row.nextScheduledAt.toISOString() }),
  };
}

export function toShoppingAgentLineDTO(row: ShoppingAgentLineRow): ShoppingAgentLine {
  return {
    id: row.id,
    canonicalProductId: row.canonicalProductId,
    ...(row.canonicalVariantId === null ? {} : { canonicalVariantId: row.canonicalVariantId }),
    quantity: row.quantity,
    conditionGroups: row.conditionGroups as readonly ConditionGroup[],
    ...(row.merchantId === null ? {} : { merchantId: row.merchantId }),
    position: row.position,
  };
}

/** One finding, with its plan, its summary and its deliveries. */
export function toShoppingAgentFindingDTO(input: {
  readonly row: ShoppingAgentFindingRow;
  readonly lines: readonly ShoppingAgentFindingLineRow[];
  readonly notifications: readonly ShoppingAgentNotificationRow[];
  readonly summary: ShoppingAgentSummary;
}): ShoppingAgentFinding {
  const { row } = input;
  return {
    id: row.id,
    agentId: row.agentId,
    evaluationKey: row.evaluationKey,
    triggerSource: row.triggerSource,
    triggeredAt: row.triggeredAt.toISOString(),
    evaluatedAt: row.evaluatedAt.toISOString(),
    outcome: row.outcome,
    incompleteReasons: row.incompleteReasons,
    completeness: row.completeness,
    freshness: row.freshness,
    ...(row.optimality === null ? {} : { optimality: row.optimality }),
    lifecycle: row.lifecycle,
    inputDigest: row.inputDigest,
    versions: {
      agentPolicyVersion: row.agentPolicyVersion,
      constraintEvaluationVersion: row.constraintEvaluationVersion,
      normalizationRuleVersion: row.normalizationRuleVersion,
      comparisonPolicyVersion: row.comparisonPolicyVersion,
      rankingPolicyVersion: row.rankingPolicyVersion,
    },
    satisfiedConstraintIds: row.satisfiedConstraintIds,
    failedConstraintIds: row.failedConstraintIds,
    unknownConstraintIds: row.unknownConstraintIds,
    ...(row.objectiveAmount === null || row.objectiveCurrency === null
      ? {}
      : {
          objectiveValue: {
            amount: row.objectiveAmount,
            currency: row.objectiveCurrency as CurrencyCode,
          },
        }),
    ...(row.objectiveDeltaAmount === null || row.objectiveCurrency === null
      ? {}
      : {
          objectiveDelta: {
            amount: row.objectiveDeltaAmount,
            currency: row.objectiveCurrency as CurrencyCode,
          },
        }),
    records: row.recordRefs as readonly ShoppingAgentRecordRef[],
    selection: input.lines.map(toShoppingAgentSelectedLine),
    summary: input.summary,
    notifications: input.notifications.map(toShoppingAgentNotificationView),
  };
}

export function toShoppingAgentSelectedLine(
  row: ShoppingAgentFindingLineRow,
): ShoppingAgentSelectedLine {
  return {
    lineId: row.lineId,
    canonicalProductId: row.canonicalProductId,
    offerRef: row.offerRef,
    quantity: row.quantity,
    ...(row.unitItemPriceAmount === null || row.unitItemPriceCurrency === null
      ? {}
      : {
          unitItemPrice: {
            amount: row.unitItemPriceAmount,
            currency: row.unitItemPriceCurrency as CurrencyCode,
          },
        }),
    ...(row.conditionGroup === null ? {} : { conditionGroup: row.conditionGroup }),
    nativeCheckoutEligible: row.nativeCheckoutEligible,
    officialChannel: row.officialChannel,
  };
}

/**
 * One delivery, as its owner sees it.
 *
 * `openedAt` is deliberately absent: whether somebody read it is stored once,
 * on `notifications.read_at`, and the join that answers it belongs to the feed
 * rather than to this domain. A second column would be a second answer.
 */
export function toShoppingAgentNotificationView(
  row: ShoppingAgentNotificationRow,
): ShoppingAgentNotificationView {
  return {
    id: row.id,
    channel: row.channel,
    state: row.state,
    ...(row.suppressionReason === null ? {} : { suppressionReason: row.suppressionReason }),
    ...(row.failureReason === null ? {} : { failureReason: row.failureReason }),
    ...(row.deliveredAt === null ? {} : { deliveredAt: row.deliveredAt.toISOString() }),
    createdAt: row.createdAt.toISOString(),
  };
}
