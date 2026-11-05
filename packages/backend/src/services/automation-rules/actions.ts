/**
 * What an automation rule's action DOES — each one through the service a store
 * member's own request goes through, so a rule inherits every guard that
 * request has and adds no path around one.
 *
 * - Listing status: `catalog-write.service.updateListing`, the funnel that
 *   refuses to set `restricted` and refuses to move a restricted listing at all
 *   (`AGENTS.md`, the moderation escapes). A rule additionally only ever pauses
 *   an `active` listing and only ever republishes a `draft` it paused itself.
 * - Order status: `order.service.transition`, the single lifecycle gate, which
 *   refuses an order held by moderation.
 * - Notification: `sendNotification` to the store's owning Oxy account — the
 *   inbox every other store notification reaches (ADR 0012).
 *
 * Every action answers an {@link ActionOutcome} and never throws: a refusal
 * from the service it called is `skipped` with that service's own message, and
 * anything else is `failed`. The evaluator writes the outcome to the run log.
 */

import type { AutomationRuleRunOutcome } from '@mercaria/shared-types';
import { findListingById } from '../../db/catalog/listingRepository.js';
import { findOrderMatching } from '../../db/orders/orderRepository.js';
import { findStoreById } from '../../db/stores/storeRepository.js';
import type { AutomationRuleRow } from '../../db/automationRules/automationRuleRepository.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { sendNotification } from '../../lib/notification-service.js';
import { log } from '../../lib/logger.js';
import { enqueueProductPush } from '../../queue/producers.js';
import { updateListing } from '../catalog-write.service.js';
import { SYSTEM_ACTOR, transition } from '../order.service.js';

/** How one action ended, and why when it did not succeed. */
export interface ActionOutcome {
  outcome: AutomationRuleRunOutcome;
  detail: string | null;
}

const SUCCEEDED: ActionOutcome = { outcome: 'succeeded', detail: null };

function skipped(detail: string): ActionOutcome {
  return { outcome: 'skipped', detail };
}

/**
 * Turn a thrown error into an outcome. A `MercariaError` below 500 is the
 * called service REFUSING — a conflict, a validation, a not-found — and is
 * recorded as `skipped` with its message, which is written for a merchant. Any
 * other error is logged and recorded as `failed` with a fixed sentence: an
 * internal message or a stack never reaches the run log.
 */
function outcomeOf(err: unknown, context: Record<string, unknown>): ActionOutcome {
  if (isMercariaError(err) && err.httpStatus < 500) return skipped(err.message);
  log.general.warn({ err, ...context }, '[AutomationRules] action failed');
  return { outcome: 'failed', detail: 'The action failed unexpectedly; it will not be retried.' };
}

/** The store's owning Oxy account, or `undefined` for a store that no longer exists. */
async function storeInbox(storeId: string): Promise<string | undefined> {
  return (await findStoreById(storeId))?.oxyAccountId;
}

/** Tell the store owner a listing reached the rule's threshold. */
export async function notifyListingStock(
  rule: AutomationRuleRow,
  listing: { listingId: string; title: string; available: number },
): Promise<ActionOutcome> {
  try {
    const inbox = await storeInbox(rule.storeId);
    if (!inbox) return skipped('The store no longer exists.');
    await sendNotification({
      userId: inbox,
      type: 'low_inventory',
      title: `Automation: ${rule.name}`,
      body: `${listing.title} is down to ${listing.available} in stock.`,
      data: {
        storeId: rule.storeId,
        listingId: listing.listingId,
        available: listing.available,
        automationRuleId: rule.id,
      },
    });
    return SUCCEEDED;
  } catch (err) {
    return outcomeOf(err, { ruleId: rule.id, listingId: listing.listingId });
  }
}

/** Tell the store owner an order matching the rule was paid. */
export async function notifyOrderPaid(
  rule: AutomationRuleRow,
  order: { orderId: string; orderNumber: string },
): Promise<ActionOutcome> {
  try {
    const inbox = await storeInbox(rule.storeId);
    if (!inbox) return skipped('The store no longer exists.');
    await sendNotification({
      userId: inbox,
      type: 'order_paid',
      title: `Automation: ${rule.name}`,
      body: `Order ${order.orderNumber} was paid.`,
      data: {
        storeId: rule.storeId,
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        automationRuleId: rule.id,
      },
    });
    return SUCCEEDED;
  } catch (err) {
    return outcomeOf(err, { ruleId: rule.id, orderId: order.orderId });
  }
}

/**
 * The listing's status change, through the merchant funnel, with the store's
 * owning account as the actor and the same best-effort connector push a
 * merchant's own edit schedules.
 */
async function setListingStatus(
  rule: AutomationRuleRow,
  listingId: string,
  status: 'draft' | 'active',
): Promise<void> {
  const inbox = await storeInbox(rule.storeId);
  if (!inbox) throw new Error('store vanished between read and write');
  await updateListing(listingId, { status }, { kind: 'seller', oxyUserId: inbox });
  try {
    await enqueueProductPush({ storeId: rule.storeId, listingId });
  } catch (err) {
    log.general.warn({ err, listingId }, '[AutomationRules] failed to enqueue product push');
  }
}

/**
 * Move an `active` listing of the rule's store to `draft`.
 *
 * Re-reads the listing: the candidate query is a snapshot, and a jury, a
 * merchant or another rule may have moved it since. Anything but `active` is
 * skipped, so a `restricted` listing is never written to — and `updateListing`
 * would refuse it if it were.
 */
export async function pauseListing(
  rule: AutomationRuleRow,
  listingId: string,
): Promise<ActionOutcome> {
  try {
    const listing = await findListingById(listingId);
    if (listing?.ownerType !== 'store' || listing.storeId !== rule.storeId) {
      return skipped('The listing is not this store’s.');
    }
    if (listing.status !== 'active') {
      return skipped(`The listing is ${listing.status}, not active.`);
    }
    await setListingStatus(rule, listingId, 'draft');
    return SUCCEEDED;
  } catch (err) {
    return outcomeOf(err, { ruleId: rule.id, listingId });
  }
}

/**
 * Put a listing THIS rule paused back on sale. The caller only asks for a
 * listing whose episode says the rule paused it; this re-reads it and acts only
 * if it is still a `draft`, so a merchant who archived or republished it in the
 * meantime — or a jury that restricted it — is never overridden.
 */
export async function republishListing(
  rule: AutomationRuleRow,
  listingId: string,
): Promise<ActionOutcome> {
  try {
    const listing = await findListingById(listingId);
    if (listing?.ownerType !== 'store' || listing.storeId !== rule.storeId) {
      return skipped('The listing is not this store’s.');
    }
    if (listing.status !== 'draft') {
      return skipped(`The listing is ${listing.status}; only a paused draft is republished.`);
    }
    await setListingStatus(rule, listingId, 'active');
    return SUCCEEDED;
  } catch (err) {
    return outcomeOf(err, { ruleId: rule.id, listingId });
  }
}

/** The fulfilment methods `processing` means something for. */
const SHIPPED_METHODS: ReadonlySet<string> = new Set(['standard', 'express']);

/**
 * Move a `paid`, shipped order of the rule's store to `processing`, through
 * `order.service.transition` with the system actor and a note naming the rule.
 *
 * A digital order (`paid → digitally_delivered`) and a pickup are skipped:
 * neither is "being packed". A held order is refused by `transition` itself —
 * the moderation freeze outranks the transition graph — and lands here as
 * `skipped` with its message.
 */
export async function markOrderProcessing(
  rule: AutomationRuleRow,
  orderId: string,
): Promise<ActionOutcome> {
  try {
    const order = await findOrderMatching({ id: orderId, storeId: rule.storeId });
    if (!order) return skipped('The order is not this store’s.');
    if (order.status !== 'paid') return skipped(`The order is ${order.status}, not paid.`);
    if (!SHIPPED_METHODS.has(order.shippingMethod)) {
      return skipped(`A ${order.shippingMethod} order is not marked processing.`);
    }
    await transition(order, 'processing', {
      actor: SYSTEM_ACTOR,
      note: `Automation rule: ${rule.name}`,
    });
    return SUCCEEDED;
  } catch (err) {
    return outcomeOf(err, { ruleId: rule.id, orderId });
  }
}
