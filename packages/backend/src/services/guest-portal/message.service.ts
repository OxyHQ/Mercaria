/**
 * Enqueuing and delivering guest transactional messages (#108 notifications).
 *
 * ## Two halves that never share a transaction
 *
 * ENQUEUE is a durable write inside whatever commerce transaction decided the
 * message is owed; DELIVERY is a leased worker reading that row minutes later.
 * That split is the moderation and payment outbox posture, and the reason is
 * the same: a provider call living in the request would evaporate on a restart
 * after the fact it describes had already committed.
 *
 * ## What is enqueued today, and what is a named seam
 *
 * {@link GUEST_PORTAL_MESSAGE_TRIGGERS} names the enqueuer for every kind, or
 * the issue that owes one. `guest-portal-message-triggers.test.ts` fails the
 * build if a kind is neither triggered nor deferred with an issue number — the
 * `deferred: #NN` device from the Stripe event ingress, applied to a
 * notification catalogue instead of an event router. A kind with no trigger is
 * a template nobody has proved works, and the honest way to say so is a table
 * rather than silence.
 *
 * ## Delivery cannot send today
 *
 * `transport.ts` has no registered transport (see its docblock), so every
 * attempt fails `transport_unconfigured` and goes terminal. Everything before
 * that point is real: the row, the locale, the template, the suppression check,
 * the decryption, the freshly minted single-use link. The seam is one module
 * and one `registerGuestMessageTransport` call.
 */

import type { Order, OrderBuyerOrigin } from '@mercaria/shared-types';
import type { GuestPortalMessageKind } from '@mercaria/shared-types';
import { GUEST_PORTAL_PERMANENT_FAILURES } from '@mercaria/shared-types';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { RETENTION_SECONDS } from '../../db/expiryTargets.js';
import {
  claimGuestPortalMessages,
  enqueueGuestPortalMessage,
  guestPortalMessageId,
  markGuestPortalMessageFailed,
  markGuestPortalMessageSent,
  type GuestPortalMessageRow,
} from '../../db/guestPortal/messageRepository.js';
import { findLiveSuppression, suppressGuestContact } from '../../db/guestPortal/suppressionRepository.js';
import {
  findGuestCheckoutByGroup,
  findGuestCheckoutById,
} from '../../db/guests/guestCheckoutRepository.js';
import {
  findOrdersInCheckoutGroup,
  type OrderRecord,
} from '../../db/orders/orderRepository.js';
import { decryptGuestPii } from '../../lib/guest-pii.js';
import { log } from '../../lib/logger.js';
import { hydrateOrders } from '../order-hydration.service.js';
import { mintExchangeGrant } from './grant.service.js';
import {
  buildPortalUrl,
  messageCarriesAccessLink,
  renderGuestMessage,
  type GuestMessageFacts,
} from './templates.js';
import { deliverGuestMessage } from './transport.js';

/**
 * Who enqueues each kind, or which issue owes it.
 *
 * `null` means DEFERRED and the string beside it names the owner. This is data
 * rather than prose so a test can assert the mapping is total, and so a kind
 * added to the vocabulary without a decision fails the build instead of sitting
 * in a catalogue nobody sends.
 */
export const GUEST_PORTAL_MESSAGE_TRIGGERS: Record<
  GuestPortalMessageKind,
  { readonly trigger: string | null; readonly note: string }
> = {
  order_confirmation: {
    trigger: 'services/payments/outbox-handlers.ts (guest_portal_initialization)',
    note: 'Enqueued when a guest payment is VERIFIED (#107 → #108). Deterministic on the ' +
      'checkout group, so duplicate webhooks converge on one message.',
  },
  payment_delayed_success: {
    trigger: null,
    note: '#111. A payment that succeeds long after the buyer left produces the SAME verified ' +
      'event the confirmation is enqueued from, and the deterministic id makes it the same ' +
      'message — so a second kind would either duplicate the confirmation or replace it. ' +
      'Distinguishing "late" needs a delay threshold nobody has chosen, which is a rollout ' +
      'decision rather than a portal one.',
  },
  payment_pending: {
    trigger: null,
    note: '#111. Needs a threshold for how long "still processing" has to last before telling ' +
      'somebody about it; sending immediately would mail every 3-D Secure challenge.',
  },
  payment_failed: {
    trigger: null,
    note: '#111. The payment domain knows the failure; what it does not know is whether the ' +
      'buyer is still on the page retrying, and mailing somebody mid-retry is worse than ' +
      'silence. Needs the same rollout threshold as payment_pending.',
  },
  order_processing: {
    trigger: 'services/guest-portal/message.service.ts (notifyGuestOrderLifecycle)',
    note: 'Enqueued from the order status transition, guest-origin orders only.',
  },
  order_shipped: {
    trigger: 'services/guest-portal/message.service.ts (notifyGuestOrderLifecycle)',
    note: 'Enqueued from the order status transition, guest-origin orders only.',
  },
  order_delivered: {
    trigger: 'services/guest-portal/message.service.ts (notifyGuestOrderLifecycle)',
    note: 'Enqueued from the order status transition, guest-origin orders only.',
  },
  order_cancelled: {
    trigger: 'services/guest-portal/message.service.ts (notifyGuestOrderLifecycle)',
    note: 'Enqueued from the order status transition, guest-origin orders only.',
  },
  refund_completed: {
    trigger: 'services/guest-portal/message.service.ts (notifyGuestOrderLifecycle)',
    note: 'The `refunded` status transition. A PARTIAL refund is deliberately not this kind — ' +
      'it leaves the order in `partially_refunded`, which is a different fact.',
  },
  refund_pending: {
    trigger: null,
    note: '#49 owns the provider-side refund lifecycle and #110 owns the buyer-facing return ' +
      'flow. The commerce record commits before the rail is called (ADR 0001 D7), so ' +
      '"pending" here would mean the RAIL has not paid yet — a distinction the buyer cannot ' +
      'act on and that the portal already shows.',
  },
  tracking_updated: {
    trigger: null,
    note: '#110. Shipping is Moovo’s and is HIDDEN everywhere; the order carries a snapshot ' +
      'with cost zero and no carrier events, so there is nothing to notify about until Moovo ' +
      'lands and a carrier event exists to describe.',
  },
  order_ready_for_pickup: {
    trigger: null,
    note: '#93. Pickup is representable and fails closed at checkout ' +
      '(`assertPickupLocationEligible` refuses every pickup), so no order can reach this state.',
  },
  return_request_updated: {
    trigger: null,
    note: '#110 owns guest returns. The scope (`returns:request`) is already granted, so the ' +
      'only missing piece is the flow that changes a request’s state.',
  },
  claim_completed: {
    trigger: 'services/guest-claims/claim-outbox.service.ts (notifyClaimCompleted)',
    note: 'Enqueued from the claim’s durable outbox rather than from the claim transaction, so ' +
      'a mail failure can never roll back an ownership change. It is the security notice a ' +
      'claim owes: the claim revoked every outstanding portal credential (ADR 0003 D14), and ' +
      'somebody reading their order through a link needs to know why it stopped working and ' +
      'where the order went.',
  },
  access_link_recovery: {
    trigger: 'services/guest-portal/recovery.service.ts',
    note: 'One per matching checkout group, each with its own single-use link.',
  },
  access_link_step_up: {
    trigger: 'services/guest-portal/recovery.service.ts (requestStepUpLink)',
    note: 'Requested from a live portal session before a sensitive mutation.',
  },
  access_security_notice: {
    trigger: 'services/guest-portal/portal.service.ts (secureAccess)',
    note: 'Sent when a buyer revokes every other credential for their group.',
  },
};

/** Order statuses that produce a guest lifecycle message, and which kind. */
const LIFECYCLE_MESSAGE_KINDS: Partial<Record<string, GuestPortalMessageKind>> = {
  processing: 'order_processing',
  shipped: 'order_shipped',
  delivered: 'order_delivered',
  cancelled: 'order_cancelled',
  refunded: 'refund_completed',
};

/**
 * Enqueue one message, if the group has a guest contact to send it to.
 *
 * Takes a transaction handle when the caller has one, so a message owed because
 * of a commerce fact commits with that fact. Returns whether a row was CREATED,
 * so a caller can log "enqueued" and "already owed" as the different facts they
 * are.
 *
 * An `oxy`-origin group has no `guest_checkouts` row and is silently skipped —
 * not an error: an authenticated buyer's transactional channel is Oxy's own
 * notifications, and this domain deliberately knows nothing about it.
 */
export async function enqueueGuestMessage(
  input: {
    checkoutGroupId: string;
    kind: GuestPortalMessageKind;
    orderId?: string;
    /**
     * Appended to the deterministic id. The ONLY way to enqueue a second
     * message of a kind for one subject, and it is deliberately awkward: an
     * operator re-send passes one, and nothing else does.
     */
    dedupeSuffix?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const contact = await findGuestCheckoutByGroup(db, input.checkoutGroupId);
  if (!contact) return false;

  const now = new Date();
  const subject = input.orderId ?? input.checkoutGroupId;
  const dedupeKey =
    input.dedupeSuffix === undefined ? subject : `${subject}:${input.dedupeSuffix}`;

  const created = await enqueueGuestPortalMessage(db, {
    id: guestPortalMessageId(input.kind, dedupeKey),
    checkoutGroupId: input.checkoutGroupId,
    guestCheckoutId: contact.id,
    kind: input.kind,
    ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
    ...(contact.locale === null ? {} : { locale: contact.locale }),
    availableAt: now,
    expiresAt: new Date(now.getTime() + RETENTION_SECONDS.guestPortalMessage * 1_000),
  });
  return created;
}

/**
 * Tell a guest their order moved — called from the order status transition.
 *
 * Returns `void` and never throws, the `emitAnalyticsEvent` guarantee: a
 * notification failure must not roll back a fulfilment transition a seller
 * already performed. The signature is what enforces it — there is nothing to
 * await, so a caller who tried would get a `tsc` error.
 *
 * Short-circuits on `buyer_origin !== 'guest'` BEFORE touching the database, so
 * an authenticated order's transition costs one property read. That is not an
 * optimisation: it is what keeps this call out of the hot path for the
 * overwhelming majority of orders, and out of every existing mocked test whose
 * fixtures are `oxy`-origin.
 *
 * Takes the ROW's three relevant columns structurally rather than a hydrated
 * `Order`: the transition already holds the row, and hydrating one to read an
 * origin would put an Oxy profile fetch inside a fulfilment write.
 */
export function notifyGuestOrderLifecycle(
  order: {
    readonly id: string;
    readonly buyerOrigin: OrderBuyerOrigin;
    readonly checkoutGroupId: string | null;
  },
  status: string,
): void {
  if (order.buyerOrigin !== 'guest') return;
  const kind = LIFECYCLE_MESSAGE_KINDS[status];
  if (kind === undefined) return;
  const checkoutGroupId = order.checkoutGroupId;
  if (checkoutGroupId === null) return;

  void enqueueGuestMessage({ checkoutGroupId, kind, orderId: order.id }).catch((err: unknown) => {
    log.guest.error(
      { err, orderId: order.id, kind },
      '[GuestPortal] failed to enqueue a lifecycle message; the order transition stands',
    );
  });
}

/** The worker identity a lease is taken under. One per process. */
const DISPATCHER_OWNER = `guest-portal-${randomUUID()}`;

/**
 * Deliver one claimed message.
 *
 * The order of the checks is the policy, and each one exists because the
 * alternative is a real failure:
 *
 *  1. **The contact record** — an erased contact (D15) has no address, and
 *     `contact_anonymized` is permanent because erasure does not reverse.
 *  2. **Suppression** — asked before decrypting, so a suppressed address is
 *     never turned back into plaintext at all.
 *  3. **Decryption** — a key that cannot read its own ciphertext is a
 *     configuration fault, and `contact_unreadable` is permanent because
 *     retrying will not find the key.
 *  4. **The link** — minted here, so a plaintext token exists for the length of
 *     one delivery attempt and never rests in a queue row. A failed delivery
 *     wastes the grant, which expires in fifteen minutes; the alternative,
 *     minting at enqueue, would keep a live credential in a table for however
 *     long the queue is deep.
 */
async function deliverOne(message: GuestPortalMessageRow, now: Date): Promise<void> {
  const db = getDb();
  const contact = await findGuestCheckoutById(db, message.guestCheckoutId);

  if (!contact || contact.emailCiphertext === null || contact.emailHash === null) {
    await failMessage(message, 'contact_anonymized', now);
    return;
  }

  const suppression = await findLiveSuppression(db, contact.emailHash);
  if (suppression !== null) {
    await failMessage(message, 'contact_suppressed', now);
    return;
  }

  let recipient: string;
  try {
    recipient = decryptGuestPii(contact.emailCiphertext);
  } catch (err) {
    log.guest.error(
      { err, checkoutGroupId: message.checkoutGroupId },
      '[GuestPortal] stored contact could not be decrypted; message is terminal',
    );
    await failMessage(message, 'contact_unreadable', now);
    return;
  }

  // The group's own orders, read once: the count every template needs, and the
  // one order a per-order message names. Reading them here rather than inside
  // the composer keeps the number of database round trips a delivery makes
  // visible in one function.
  const orders = await findOrdersInCheckoutGroup(message.checkoutGroupId, db);
  const facts = await composeFacts(message, orders, now);
  if (facts === null) {
    await failMessage(message, 'transport_unconfigured', now);
    return;
  }

  const rendered = renderGuestMessage(facts, message.locale);
  const result = await deliverGuestMessage({
    kind: message.kind,
    to: recipient,
    locale: rendered.locale,
    subject: rendered.subject,
    body: rendered.body,
  });

  if (result.status === 'delivered') {
    await markGuestPortalMessageSent(db, {
      id: message.id,
      owner: DISPATCHER_OWNER,
      now,
    });
    return;
  }

  // A hard bounce or an explicit rejection is evidence about the ADDRESS, so it
  // suppresses — which stops every future message to it, including ones for
  // other checkouts by the same inbox. That widening is deliberate: a mailbox
  // that does not exist does not exist for any order.
  if (result.failure === 'transport_rejected') {
    await suppressGuestContact(db, {
      emailHash: contact.emailHash,
      reason: 'permanent_failure',
    });
  }
  await failMessage(message, result.failure, now);
}

/** Record a failed attempt and decide whether it may be retried. */
async function failMessage(
  message: GuestPortalMessageRow,
  failure: (typeof GUEST_PORTAL_PERMANENT_FAILURES)[number] | 'transport_unavailable',
  now: Date,
): Promise<void> {
  const permanent = GUEST_PORTAL_PERMANENT_FAILURES.includes(failure);
  const attempts = message.attempts + 1;
  const exhausted = attempts >= config.guest.portal.messageMaxAttempts;

  // Capped exponential backoff, the payment-outbox curve: 2^n seconds, never
  // past an hour. A retryable failure that has run out of attempts becomes a
  // `dead_letter` rather than retrying forever, because an invisible permanent
  // retry is how a confirmation nobody received stays unnoticed.
  const delayMs = Math.min(2 ** attempts * 1_000, 60 * 60 * 1_000);
  const nextState = permanent
    ? failure === 'contact_suppressed'
      ? ('suppressed' as const)
      : ('failed' as const)
    : exhausted
      ? ('dead_letter' as const)
      : ('pending' as const);

  await markGuestPortalMessageFailed(getDb(), {
    id: message.id,
    owner: DISPATCHER_OWNER,
    failure,
    nextState,
    availableAt: new Date(now.getTime() + delayMs),
  });

  log.guest.warn(
    { messageId: message.id, kind: message.kind, failure, nextState, attempts },
    '[GuestPortal] message delivery attempt failed',
  );
}

/**
 * Build the template facts, minting a single-use link for the kinds that carry
 * one. `null` when the deployment cannot build a portal URL at all.
 */
async function composeFacts(
  message: GuestPortalMessageRow,
  orders: readonly OrderRecord[],
  now: Date,
): Promise<GuestMessageFacts | null> {
  const base = config.guest.portal.magicLinkBaseUrl;
  if (base.trim() === '') {
    log.guest.error(
      { messageId: message.id },
      '[GuestPortal] GUEST_MAGIC_LINK_BASE_URL is unset; a message cannot link to a portal',
    );
    return null;
  }

  let portalUrl: string;
  if (messageCarriesAccessLink(message.kind)) {
    const { token } = await mintExchangeGrant(getDb(), {
      checkoutGroupId: message.checkoutGroupId,
      guestCheckoutId: message.guestCheckoutId,
      reason: message.kind === 'access_link_step_up' ? 'sensitive_action' : exchangeReasonFor(message.kind),
      now,
    });
    portalUrl = buildPortalUrl(base, token);
  } else {
    portalUrl = buildPortalUrl(base);
  }

  const detail = await orderDetail(message.orderId, orders);
  return {
    kind: message.kind,
    ...(detail.orderNumber === undefined ? {} : { orderNumber: detail.orderNumber }),
    ...(detail.sellerLabel === undefined ? {} : { sellerLabel: detail.sellerLabel }),
    orderCount: orders.length,
    portalUrl,
  };
}

/** Which exchange reason a link-bearing kind mints under. */
function exchangeReasonFor(kind: GuestPortalMessageKind): 'initial_confirmation' | 'recovery' {
  return kind === 'order_confirmation' ? 'initial_confirmation' : 'recovery';
}

/**
 * The order number and seller label a per-order message names, if it names one.
 *
 * Selects from the orders ALREADY loaded for the group, so a per-order message
 * cannot name an order outside its own checkout group even if a row's
 * `order_id` were wrong — which is #108 privacy rule 8 ("do not disclose one
 * seller's order data to another seller") holding through a data fault and not
 * only through correct data.
 */
async function orderDetail(
  orderId: string | null,
  orders: readonly OrderRecord[],
): Promise<{ orderNumber?: string; sellerLabel?: string }> {
  if (orderId === null) return {};
  const match = orders.find((order) => order.id === orderId);
  if (!match) return {};
  const [hydrated] = await hydrateOrders([match]);
  if (!hydrated) return {};
  const label = sellerLabel(hydrated);
  return {
    orderNumber: hydrated.orderNumber,
    ...(label === undefined ? {} : { sellerLabel: label }),
  };
}

/** The seller's public display name. Never a payout account and never a contact. */
export function sellerLabel(order: Order): string | undefined {
  return order.store?.name ?? order.seller?.displayName;
}

/**
 * One dispatcher pass. Exported so a test and the operator surface can drive it
 * without waiting for the interval.
 */
export async function dispatchGuestPortalMessages(): Promise<number> {
  const now = new Date();
  const claimed = await claimGuestPortalMessages(getDb(), {
    owner: DISPATCHER_OWNER,
    now,
    leaseUntil: new Date(now.getTime() + config.guest.portal.messageLeaseMs),
    limit: config.guest.portal.messageBatchSize,
  });

  for (const message of claimed) {
    try {
      await deliverOne(message, now);
    } catch (err) {
      // Per-message isolation, the backfill runner's `examineSubject` shape: a
      // pass that aborted on its worst row would leave the rest of the batch
      // leased and unprocessed until the lease expired.
      log.guest.error(
        { err, messageId: message.id },
        '[GuestPortal] message delivery threw; recording a retryable failure',
      );
      await failMessage(message, 'transport_unavailable', now).catch(() => undefined);
    }
  }
  return claimed.length;
}

let dispatcherTimer: NodeJS.Timeout | undefined;

/**
 * Start the dispatcher on this task.
 *
 * Gated by `GUEST_PORTAL_MESSAGE_DELIVERY_ENABLED`, which stops the LOOP and
 * never the row: messages keep being enqueued while it is off and drain when it
 * is switched back on. That is the incident lever — mail must sometimes stop
 * going out — and losing the record of what was owed would turn a two-hour
 * pause into a permanent gap.
 *
 * `.unref?.()` immediately after `setInterval`, the house rule: a housekeeping
 * interval that keeps the event loop alive non-deterministically hangs a Jest
 * or vitest run under load.
 */
export function startGuestPortalMessageDispatcher(): void {
  if (dispatcherTimer !== undefined) return;
  if (!config.guest.portal.deliveryEnabled) {
    log.guest.info(
      {},
      '[GuestPortal] message dispatcher not started (GUEST_PORTAL_MESSAGE_DELIVERY_ENABLED=false); ' +
        'messages continue to be enqueued durably',
    );
    return;
  }
  dispatcherTimer = setInterval(() => {
    void dispatchGuestPortalMessages().catch((err: unknown) => {
      log.guest.error({ err }, '[GuestPortal] message dispatcher pass failed');
    });
  }, config.guest.portal.messagePollIntervalMs);
  dispatcherTimer.unref?.();
}

/** Stop the dispatcher — used by the test harness and a graceful shutdown. */
export function stopGuestPortalMessageDispatcher(): void {
  if (dispatcherTimer === undefined) return;
  clearInterval(dispatcherTimer);
  dispatcherTimer = undefined;
}
