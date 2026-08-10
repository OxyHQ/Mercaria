/**
 * Delivering one queued price-alert notification (#79 §"Notifications",
 * acceptance 4 and 6).
 *
 * ## This module cannot evaluate a price, and that is structural
 *
 * It imports no comparison, no qualification and no trigger WRITER — only the
 * trigger reader — so acceptance 6's "delivery retry never reruns price
 * evaluation or creates duplicate triggers" is a property of the import graph
 * rather than a rule somebody follows.
 * `price-alert-isolation.test.ts` fails the build if that changes.
 *
 * ## The destination IS re-checked, and that is not an evaluation
 *
 * Acceptance 4 asks that a stale or expired offer cannot "remain the
 * notification destination", so before sending, the offer is re-read and put
 * back through #74's OWN `evaluateOfferEligibility` — the same derivation the
 * comparison used, not a second copy. It answers one question ("may this offer
 * still be shown") and produces no trigger, no amount and no comparison.
 *
 * A failure there is a SUPPRESSION with a reason and a row, never a silent drop:
 * "how many notifications did we withhold because the price had already gone" is
 * issue operations 3's stale-link measurement, and a table of messages that were
 * sent cannot answer it.
 *
 * ## Quiet hours DEFER, never drop (notification 7)
 *
 * A notification inside the buyer's quiet window is released back to the queue
 * with `available_at` at the end of it. It keeps its attempt count and its
 * identity, so the deferral costs nothing and is invisible afterwards — and a
 * dropped alert would be indistinguishable from one that never qualified, which
 * is the whole reason the delivery job is durable.
 */

import {
  mayAppearInComparison,
  withinQuietHours,
  quietHoursReleaseAt,
  type CurrencyCode,
  type PriceAlertDeliveryFailure,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import {
  markPriceAlertNotificationDelivered,
  markPriceAlertNotificationSuppressed,
  releasePriceAlertNotification,
  type PriceAlertNotificationRow,
} from '../../db/priceAlerts/priceAlertNotificationRepository.js';
import {
  findPriceAlertById,
  recordPriceAlertDelivered,
} from '../../db/priceAlerts/priceAlertRepository.js';
import {
  findPriceAlertTrigger,
  listPriceAlertTriggerQuotes,
} from '../../db/priceAlerts/priceAlertTriggerRepository.js';
import { getRates } from '../fx.service.js';
import { getOffer } from '../offers/offer.service.js';
import { evaluateOfferEligibility } from '../ranking/eligibility.js';
import { buildRankingFactContext } from '../ranking/facts.js';
import { sendNotification } from '../../lib/notification-service.js';
import { log } from '../../lib/logger.js';
import { toPriceAlertTriggerDTO } from './projection.js';
import { priceAlertNotificationCopy, priceAlertNotificationPayload } from './notification.js';
import { resolvePriceAlertEmailTransport } from './transport.js';

/** What one delivery attempt did, so the dispatcher can count without re-reading. */
export type PriceAlertDeliveryOutcome =
  | { readonly outcome: 'delivered' }
  | { readonly outcome: 'suppressed' }
  | { readonly outcome: 'deferred' }
  | { readonly outcome: 'failed'; readonly failure: PriceAlertDeliveryFailure };

/**
 * Whether the offer this notification points at may still be shown.
 *
 * #74's own eligibility derivation over a ONE-offer page, with the market taken
 * from the offer itself so a market-scoped rule cannot refuse an offer for being
 * published somewhere the re-check invented. Every reason it can return is a
 * reason not to send: retired, expired, unavailable, restricted, suppressed.
 */
async function destinationStillEligible(
  offerId: string,
  comparisonCurrency: CurrencyCode,
  now: Date,
): Promise<boolean> {
  const offer = await getOffer(offerId, now);
  if (offer === undefined) return false;
  if (offer.status !== 'active') return false;
  // Cheap and decisive first — #68's contract is what "an old price cannot fire
  // a new alert" rests on, and an offer that fails it needs no further reads.
  if (!mayAppearInComparison(offer.freshness)) return false;

  const rates = await getRates(comparisonCurrency, []);
  const context = await buildRankingFactContext({
    offers: [offer],
    comparisonCurrency,
    rates,
    ...(offer.country ? { market: offer.country } : {}),
    now,
  });

  const evaluation = evaluateOfferEligibility(offer, {
    canonicalVariantIds: new Set([offer.canonicalVariantId]),
    ...(offer.country ? { market: offer.country } : {}),
    customerClasses: [],
    experience: 'buy_now',
    suppressedMerchantIds: context.suppressedMerchantIds,
    suppressedStorefrontIds: context.suppressedStorefrontIds,
  });
  return evaluation.reasons.length === 0;
}

/**
 * Deliver one claimed notification.
 *
 * The order of the checks is the order of the cheapest DEFINITIVE answer: the
 * alert's own state (one indexed read, and a deleted alert must never reach a
 * transport), then quiet hours (pure), then the destination (several reads),
 * then the send. Re-ordering it would spend an offer read to discover the buyer
 * had deleted the alert.
 */
export async function deliverPriceAlertNotification(
  row: PriceAlertNotificationRow,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<PriceAlertDeliveryOutcome> {
  const alert = await findPriceAlertById(row.alertId);
  if (alert === undefined) {
    // The alert was hard-DELETED (an erasure), which cascades this row away in
    // the same statement — so this is unreachable in practice and is answered
    // rather than thrown, because a worker holding a lease on a row that no
    // longer exists must release it rather than retry forever.
    await markPriceAlertNotificationSuppressed(
      { id: row.id, leaseOwner, reason: 'alert_deleted', now },
    );
    return { outcome: 'suppressed' };
  }
  if (alert.state === 'deleted') {
    await markPriceAlertNotificationSuppressed(
      { id: row.id, leaseOwner, reason: 'alert_deleted', now },
    );
    return { outcome: 'suppressed' };
  }
  if (alert.state === 'paused') {
    await markPriceAlertNotificationSuppressed(
      { id: row.id, leaseOwner, reason: 'alert_paused', now },
    );
    return { outcome: 'suppressed' };
  }

  if (
    alert.quietHoursStartMinute !== null &&
    alert.quietHoursEndMinute !== null &&
    alert.quietHoursTimeZone !== null
  ) {
    const quietHours = {
      startMinute: alert.quietHoursStartMinute,
      endMinute: alert.quietHoursEndMinute,
      timeZone: alert.quietHoursTimeZone,
    };
    if (withinQuietHours(quietHours, now)) {
      await releasePriceAlertNotification({
        id: row.id,
        leaseOwner,
        deadLettered: false,
        availableAt: quietHoursReleaseAt(quietHours, now),
        // The row goes back to `failed`, which is what the queue's retry state
        // is called; the REASON says it was not a failure. A separate `deferred`
        // state would be a fourth queue state whose only difference is a word.
        failure: 'transport_unavailable',
        now,
      });
      return { outcome: 'deferred' };
    }
  }

  const trigger = await findPriceAlertTrigger(row.triggerId);
  if (trigger === undefined) {
    await releasePriceAlertNotification({
      id: row.id,
      leaseOwner,
      deadLettered: true,
      availableAt: now,
      failure: 'trigger_unreadable',
      now,
    });
    return { outcome: 'failed', failure: 'trigger_unreadable' };
  }

  if (!(await destinationStillEligible(trigger.offerId, trigger.amountCurrency, now))) {
    await markPriceAlertNotificationSuppressed(
      { id: row.id, leaseOwner, reason: 'destination_no_longer_eligible', now },
    );
    return { outcome: 'suppressed' };
  }

  const quotes = await listPriceAlertTriggerQuotes(trigger.id);
  const dto = toPriceAlertTriggerDTO(trigger, quotes);
  const payload = priceAlertNotificationPayload(dto, alert.locale);
  const copy = priceAlertNotificationCopy(dto);

  if (row.channel === 'email') {
    const transport = resolvePriceAlertEmailTransport();
    if (transport === undefined) {
      // The shipped state. VISIBLE, with the row intact — see `transport.ts`.
      await releasePriceAlertNotification({
        id: row.id,
        leaseOwner,
        deadLettered: row.attempts >= config.priceAlerts.notificationMaxAttempts,
        availableAt: new Date(now.getTime() + backoffMs(row.attempts)),
        failure: 'transport_unconfigured',
        now,
      });
      return { outcome: 'failed', failure: 'transport_unconfigured' };
    }

    const sent = await transport({
      oxyUserId: alert.oxyUserId,
      subject: copy.title,
      body: copy.body,
      payload,
    });
    switch (sent.outcome) {
      case 'sent':
        // No `notificationId`: an email produces no feed row — see the
        // repository's own docblock for why the absence is the honest shape.
        await markPriceAlertNotificationDelivered({ id: row.id, leaseOwner, now });
        await recordPriceAlertDelivered(alert.id, now);
        return { outcome: 'delivered' };
      case 'no_address':
        await markPriceAlertNotificationSuppressed({
          id: row.id,
          leaseOwner,
          reason: 'channel_unavailable',
          now,
        });
        return { outcome: 'suppressed' };
      case 'rejected':
        await releasePriceAlertNotification({
          id: row.id,
          leaseOwner,
          deadLettered: true,
          availableAt: now,
          failure: 'transport_rejected',
          now,
        });
        return { outcome: 'failed', failure: 'transport_rejected' };
      case 'unavailable':
        await releasePriceAlertNotification({
          id: row.id,
          leaseOwner,
          deadLettered: row.attempts >= config.priceAlerts.notificationMaxAttempts,
          availableAt: new Date(now.getTime() + backoffMs(row.attempts)),
          failure: 'transport_unavailable',
          now,
        });
        return { outcome: 'failed', failure: 'transport_unavailable' };
    }
  }

  try {
    /**
     * The ecosystem channel (notification 1).
     *
     * `sendNotification` COMMITS the row before attempting any channel, so a
     * buyer with no push registration still finds the alert in their feed — and
     * the per-channel outcomes it records are what stops this domain claiming a
     * push succeeded when none was registered (acceptance 7). The delivery is
     * `delivered` because the notification reached the buyer's feed, which is
     * the channel that always exists; whether a push also went out is the
     * notification row's own `delivery_status`.
     */
    const notification = await sendNotification({
      userId: alert.oxyUserId,
      type: 'price_alert',
      title: copy.title,
      body: copy.body,
      priority: 'normal',
      data: { ...payload },
    });
    await markPriceAlertNotificationDelivered({
      id: row.id,
      leaseOwner,
      notificationId: notification.id,
      now,
    });
    await recordPriceAlertDelivered(alert.id, now);
    return { outcome: 'delivered' };
  } catch (error: unknown) {
    log.general.warn(
      { err: error, priceAlertNotificationId: row.id },
      '[PriceAlerts] notification delivery failed',
    );
    await releasePriceAlertNotification({
      id: row.id,
      leaseOwner,
      deadLettered: row.attempts >= config.priceAlerts.notificationMaxAttempts,
      availableAt: new Date(now.getTime() + backoffMs(row.attempts)),
      failure: 'unexpected_error',
      now,
    });
    return { outcome: 'failed', failure: 'unexpected_error' };
  }
}

/** Capped exponential backoff — the moderation outbox's, with this domain's ceiling. */
export function backoffMs(attempts: number): number {
  const base = 30_000;
  const exponential = base * 2 ** Math.max(0, attempts - 1);
  return Math.min(exponential, config.priceAlerts.notificationMaxBackoffMs);
}
