/**
 * Delivering one notification (#97 notification 3, 7 and 9).
 *
 * The delivery half of the domain, and it deliberately imports NOTHING that
 * evaluates. That is #97's "evaluation and delivery are separate durable jobs"
 * pointed the way that matters: a delivery retried a hundred times re-reads
 * THIS row and never the catalogue, so a retry can never produce a second
 * finding or a second observation. `shopping-agent-isolation.test.ts` asserts
 * it, because it is a property of the import graph and nothing else would keep
 * it true.
 *
 * ## The order of the checks is the order of the cheapest DEFINITIVE answer
 *
 * The agent's own state first (one indexed read, and a deleted agent must never
 * reach a transport), then quiet hours (pure), then the send. #79's order, and
 * re-ordering it would spend reads discovering something the first check
 * already settled.
 *
 * ## #97 notification 3 is answered by the FINDING, not by a re-read here
 *
 * "Revalidate the destination before opening a finding" is satisfied upstream:
 * the finding's own offers came through #74's `evaluateOfferEligibility` at
 * evaluation time, and a notification carries no destination to revalidate —
 * it carries canonical product ids and the client resolves a Mercaria page from
 * them. There is no URL in the payload precisely so there is nothing here that
 * could have gone stale into an outbound hop.
 */

import type { ShoppingAgentDeliveryFailure } from '@mercaria/shared-types';
import { withinShoppingAgentQuietHours, shoppingAgentQuietHoursReleaseAt } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { sendNotification } from '../../lib/notification-service.js';
import { findShoppingAgentById } from '../../db/shoppingAgents/shoppingAgentRepository.js';
import {
  findShoppingAgentFindingById,
  listShoppingAgentFindingLines,
} from '../../db/shoppingAgents/shoppingAgentFindingRepository.js';
import {
  markShoppingAgentNotificationDelivered,
  markShoppingAgentNotificationSuppressed,
  releaseShoppingAgentNotification,
  type ShoppingAgentNotificationRow,
} from '../../db/shoppingAgents/shoppingAgentNotificationRepository.js';
import { shoppingAgentNotificationCopy, shoppingAgentNotificationPayload } from './notification.js';
import { resolveShoppingAgentEmailTransport } from './transport.js';
import { renderShoppingAgentSummaryTemplate } from './summary.js';

/** What one attempt did, so the dispatcher counts without re-reading. */
export type ShoppingAgentDeliveryOutcome =
  | { readonly outcome: 'delivered' }
  | { readonly outcome: 'suppressed' }
  | { readonly outcome: 'deferred' }
  | { readonly outcome: 'failed'; readonly failure: ShoppingAgentDeliveryFailure };

/** Capped exponential backoff. */
export function backoffMs(attempts: number): number {
  const base = 30_000;
  const exponential = base * 2 ** Math.max(0, attempts - 1);
  return Math.min(exponential, config.shoppingAgents.notificationMaxBackoffMs);
}

/** Deliver one claimed notification. */
export async function deliverShoppingAgentNotification(
  row: ShoppingAgentNotificationRow,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<ShoppingAgentDeliveryOutcome> {
  const agent = await findShoppingAgentById(row.agentId);
  if (agent === undefined || agent.state === 'deleted') {
    await markShoppingAgentNotificationSuppressed({
      id: row.id,
      leaseOwner,
      reason: 'agent_deleted',
      now,
    });
    return { outcome: 'suppressed' };
  }
  if (agent.state !== 'enabled') {
    await markShoppingAgentNotificationSuppressed({
      id: row.id,
      leaseOwner,
      reason: 'agent_not_enabled',
      now,
    });
    return { outcome: 'suppressed' };
  }

  // Quiet hours DEFER and never drop (#97 notification 7): the news is still
  // news in the morning, and a dropped notification is indistinguishable from
  // an agent that found nothing.
  if (
    agent.quietHoursStartMinute !== null &&
    agent.quietHoursEndMinute !== null &&
    agent.quietHoursTimeZone !== null
  ) {
    const quietHours = {
      startMinute: agent.quietHoursStartMinute,
      endMinute: agent.quietHoursEndMinute,
      timeZone: agent.quietHoursTimeZone,
    };
    if (withinShoppingAgentQuietHours(quietHours, now)) {
      await releaseShoppingAgentNotification({
        id: row.id,
        leaseOwner,
        deadLettered: false,
        availableAt: shoppingAgentQuietHoursReleaseAt(quietHours, now),
        failure: null,
        now,
      });
      return { outcome: 'deferred' };
    }
  }

  const finding = await findShoppingAgentFindingById(row.findingId);
  if (finding === undefined) {
    await releaseShoppingAgentNotification({
      id: row.id,
      leaseOwner,
      // Terminal on the FIRST attempt: a finding that cannot be read will not
      // become readable, and retrying spends a claim to learn the same thing.
      deadLettered: true,
      availableAt: now,
      failure: 'finding_unreadable',
      now,
    });
    return { outcome: 'failed', failure: 'finding_unreadable' };
  }

  const lines = await listShoppingAgentFindingLines(finding.id);
  const payload = shoppingAgentNotificationPayload({
    agentId: agent.id,
    findingId: finding.id,
    kind: agent.kind,
    priceBasis: agent.priceBasis,
    ...(finding.objectiveAmount === null ? {} : { objectiveAmountMinor: finding.objectiveAmount }),
    ...(finding.objectiveCurrency === null
      ? {}
      : { objectiveCurrency: finding.objectiveCurrency }),
    ...(finding.objectiveDeltaAmount === null
      ? {}
      : { objectiveDeltaMinor: finding.objectiveDeltaAmount }),
    completeness: finding.completeness,
    freshness: finding.freshness,
    agentPolicyVersion: finding.agentPolicyVersion,
    selection: lines.map((line) => ({
      lineId: line.lineId,
      canonicalProductId: line.canonicalProductId,
      offerRef: line.offerRef,
      quantity: line.quantity,
      ...(line.unitItemPriceAmount === null || line.unitItemPriceCurrency === null
        ? {}
        : {
            unitItemPrice: {
              amount: line.unitItemPriceAmount,
              currency: line.unitItemPriceCurrency,
            },
          }),
      ...(line.conditionGroup === null ? {} : { conditionGroup: line.conditionGroup }),
      nativeCheckoutEligible: line.nativeCheckoutEligible,
      officialChannel: line.officialChannel,
    })),
  });

  // The words come from the finding's own deterministic summary, so a
  // notification cannot say something the timeline does not.
  const copy = shoppingAgentNotificationCopy({
    kind: agent.kind,
    summary: renderShoppingAgentSummaryTemplate({
      findingId: finding.id,
      kind: agent.kind,
      outcome: finding.outcome,
      completeness: finding.completeness,
      freshness: finding.freshness,
      lineCount: lines.length,
      satisfiedConstraintCount: finding.satisfiedConstraintIds.length,
      failedConstraintCount: finding.failedConstraintIds.length,
      unknownConstraintCount: finding.unknownConstraintIds.length,
      records: finding.recordRefs,
      validRefs: finding.recordRefs.map((record) => record.ref),
      numericTokens: [],
    }),
  });

  if (row.channel === 'email') {
    const transport = resolveShoppingAgentEmailTransport();
    if (transport === undefined) {
      // The shipped state. VISIBLE, with the row intact — see `transport.ts`.
      await releaseShoppingAgentNotification({
        id: row.id,
        leaseOwner,
        deadLettered: row.attempts >= config.shoppingAgents.notificationMaxAttempts,
        availableAt: new Date(now.getTime() + backoffMs(row.attempts)),
        failure: 'transport_unconfigured',
        now,
      });
      return { outcome: 'failed', failure: 'transport_unconfigured' };
    }
    const sent = await transport({
      oxyUserId: agent.oxyUserId,
      subject: copy.title,
      body: copy.body,
      payload,
    });
    if (sent.outcome === 'sent') {
      await markShoppingAgentNotificationDelivered({ id: row.id, leaseOwner, now });
      return { outcome: 'delivered' };
    }
    if (sent.outcome === 'no_address') {
      await markShoppingAgentNotificationSuppressed({
        id: row.id,
        leaseOwner,
        reason: 'channel_unavailable',
        now,
      });
      return { outcome: 'suppressed' };
    }
    const failure: ShoppingAgentDeliveryFailure =
      sent.outcome === 'rejected' ? 'transport_rejected' : 'transport_unavailable';
    await releaseShoppingAgentNotification({
      id: row.id,
      leaseOwner,
      deadLettered:
        sent.outcome === 'rejected' ||
        row.attempts >= config.shoppingAgents.notificationMaxAttempts,
      availableAt: new Date(now.getTime() + backoffMs(row.attempts)),
      failure,
      now,
    });
    return { outcome: 'failed', failure };
  }

  try {
    const notification = await sendNotification({
      userId: agent.oxyUserId,
      type: 'shopping_agent_finding',
      title: copy.title,
      body: copy.body,
      priority: 'normal',
      data: { ...payload },
    });
    await markShoppingAgentNotificationDelivered({
      id: row.id,
      leaseOwner,
      notificationId: notification.id,
      now,
    });
    return { outcome: 'delivered' };
  } catch (err: unknown) {
    log.general.warn({ err, agentId: agent.id }, '[ShoppingAgents] notification delivery failed');
    await releaseShoppingAgentNotification({
      id: row.id,
      leaseOwner,
      deadLettered: row.attempts >= config.shoppingAgents.notificationMaxAttempts,
      availableAt: new Date(now.getTime() + backoffMs(row.attempts)),
      failure: 'unexpected_error',
      now,
    });
    return { outcome: 'failed', failure: 'unexpected_error' };
  }
}
