/**
 * "Send me a link to my order" — the enumeration-resistant recovery flow
 * (#108 recovery, ADR 0003 T5/T6).
 *
 * ## The answer is the SAME whatever happened
 *
 * The route answers 202 with one fixed sentence before this module runs at all,
 * and there is deliberately no return value a caller could branch on:
 * {@link requestGuestOrderRecovery} resolves `void`. A field saying "we found
 * it" would be the oracle the 202 exists to close, and so would a different
 * status code, a different message, or a measurably different latency — which
 * is why the work happens AFTER the response rather than before it. #108
 * recovery rule 1 is therefore a property of the signature, not of a branch
 * somebody has to keep symmetric.
 *
 * ## The order number is a HINT and never a proof
 *
 * ADR 0003 T6 treats order numbers as public: they are sequential, printed on
 * documents, and guessable by construction. So the number narrows a search that
 * has already been scoped by the email hash — it can never widen one, it cannot
 * be presented without an address, and matching one grants nothing that not
 * matching one would not have granted. Invariant I4 ("order number plus email
 * cannot authorize") holds because the OUTPUT of this flow is a link sent to
 * the stored contact, not access.
 *
 * ## The destination is never a caller's to choose
 *
 * {@link GuestRecoveryRequest} has no destination field, and the send path
 * reads `guest_checkouts.email_ciphertext`. #108 recovery rule 4 ("do not allow
 * a caller to replace the destination email") is unrepresentable rather than
 * refused — the address a caller types is only ever hashed and compared.
 *
 * ## One link per checkout GROUP, never one link for an inbox
 *
 * An address that placed three checkouts gets three independent messages, each
 * with its own single-use token scoped to one group. That is email-verification
 * rule 8 ("do not correlate separate guest checkouts automatically from a
 * matching verified email") made structural: at no point does an authorization
 * context, a response or a message hold two checkouts at once.
 */

import type { GuestRecoveryLimitAxis } from '@mercaria/shared-types';
import { createHmac } from 'node:crypto';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { countRecoveryAttempt } from '../../db/guestPortal/recoveryAttemptRepository.js';
import { findGuestCheckoutsByEmailHash } from '../../db/guestPortal/contactRoutingRepository.js';
import { findOrderByOrderNumber } from '../../db/orders/orderRepository.js';
import { guestEmailHash } from '../../lib/guest-pii.js';
import { log } from '../../lib/logger.js';
import { enqueueGuestMessage } from './message.service.js';

const MINUTE_MS = 60_000;

/**
 * How many checkout groups one recovery request may fan out to.
 *
 * An address that placed fifty checkouts is either a very good customer or a
 * mail amplifier, and an unbounded fan-out is the second one whichever it is.
 * Five is the most recent five, because the group somebody is trying to reach
 * is almost always a recent one — and the order-number hint is exactly how
 * somebody reaches an older one, which is what makes bounding this safe rather
 * than merely convenient.
 */
export const RECOVERY_MAX_GROUPS = 5;

/** What a caller may say. Note the absence of any destination field. */
export interface GuestRecoveryRequest {
  /** The address the caller claims placed an order. Hashed, never stored, never sent to. */
  readonly email: string;
  /** An optional PUBLIC order number, used only to narrow. */
  readonly orderNumber?: string;
  /** The request's source address, for the coarse network axis. */
  readonly clientIp: string;
}

/**
 * Do the recovery work. Resolves `void` and never throws to its caller.
 *
 * Called AFTER the 202 has been written, so nothing it does — a lookup, a
 * throttle, an enqueue, a failure — can be observed in the response's timing or
 * shape. Failures are logged with the axis and the outcome and NEVER with the
 * address, the hash or an order number.
 */
export async function requestGuestOrderRecovery(
  request: GuestRecoveryRequest,
  now: Date,
): Promise<void> {
  try {
    await performRecovery(request, now);
  } catch (err) {
    log.guest.error({ err }, '[GuestPortal] recovery request failed after the 202 was sent');
  }
}

async function performRecovery(request: GuestRecoveryRequest, now: Date): Promise<void> {
  const normalizedEmail = request.email.normalize('NFC').trim().toLowerCase();
  if (normalizedEmail === '') return;
  const emailHash = guestEmailHash(normalizedEmail);
  const windowStartedAt = currentWindowStart(now);

  // Every axis is counted BEFORE any of them is judged, so a request that trips
  // one limit still contributes to the others. Counting lazily would let an
  // attacker keep one axis under its ceiling by deliberately tripping another.
  const emailAttempts = await count('email_hash', emailHash, windowStartedAt);
  const networkAttempts = await count('network', networkPrefix(request.clientIp), windowStartedAt);
  const orderAttempts =
    request.orderNumber === undefined
      ? 0
      : await count('order_reference', request.orderNumber.trim().toUpperCase(), windowStartedAt);

  const limits = config.guest.portal;
  if (
    emailAttempts > limits.recoveryMaxPerEmail ||
    networkAttempts > limits.recoveryMaxPerNetwork ||
    (request.orderNumber !== undefined && orderAttempts > limits.recoveryMaxPerOrder)
  ) {
    // Throttled requests are logged by AXIS and never by subject, so an
    // operator can see a flood without the log becoming the correlation trail
    // the whole domain refuses to keep.
    log.guest.warn(
      { emailAttempts, networkAttempts, orderAttempts },
      '[GuestPortal] recovery request throttled',
    );
    return;
  }

  const db = getDb();
  const contacts = await findGuestCheckoutsByEmailHash(db, emailHash, RECOVERY_MAX_GROUPS);
  if (contacts.length === 0) {
    // The honest non-event. Logged at debug WITHOUT the hash, because "this
    // address has no orders" written down repeatedly is itself a correlation
    // trail — and the 202 already went out, so nothing here is observable.
    log.guest.debug({}, '[GuestPortal] recovery request matched no checkout');
    return;
  }

  const narrowed = await narrowByOrderNumber(contacts, request.orderNumber);

  for (const contact of narrowed) {
    // One message per GROUP, each with its own token. The dedupe suffix is the
    // WINDOW, so five requests inside one window produce one message per group
    // — "make repeated requests converge or throttle predictably" (#108
    // recovery rule 5) — while a request in the next window legitimately
    // produces a fresh link for somebody whose first one expired.
    await enqueueGuestMessage(
      {
        checkoutGroupId: contact.checkoutGroupId,
        kind: 'access_link_recovery',
        dedupeSuffix: String(windowStartedAt.getTime()),
      },
      db,
    );
  }

  log.guest.info(
    { groups: narrowed.length },
    '[GuestPortal] recovery links enqueued (one per checkout group)',
  );
}

/**
 * Apply the order-number hint.
 *
 * Narrows to the group that order belongs to, IF that group is already in the
 * set the email hash produced. A number naming somebody else's order narrows to
 * nothing and the request quietly does nothing — which is the correct answer,
 * because the alternative (ignoring a non-matching hint) would let a caller
 * discover that a guessed number belongs to a different inbox by observing that
 * they still got a mail.
 */
async function narrowByOrderNumber<T extends { checkoutGroupId: string }>(
  contacts: readonly T[],
  orderNumber: string | undefined,
): Promise<T[]> {
  if (orderNumber === undefined) return [...contacts];
  const trimmed = orderNumber.trim();
  if (trimmed === '') return [...contacts];

  const order = await findOrderByOrderNumber(trimmed);
  const group = order?.checkoutGroupId;
  if (group === undefined || group === null) return [];
  return contacts.filter((contact) => contact.checkoutGroupId === group);
}

/**
 * Request a fresh step-up link for a live portal session (#108 authorization
 * rule 3).
 *
 * Unlike recovery this is NOT enumeration-sensitive: the caller already holds a
 * credential that proves the inbox, so there is nothing a response could reveal
 * that they do not already know. It still sends to the STORED contact and takes
 * no destination, for the same structural reason.
 */
export async function requestStepUpLink(
  input: { checkoutGroupId: string; now: Date },
): Promise<boolean> {
  return await enqueueGuestMessage({
    checkoutGroupId: input.checkoutGroupId,
    kind: 'access_link_step_up',
    // A step-up is requested at the moment of an action, so a caller who
    // abandons one and comes back an hour later must get a new link rather than
    // converging on an expired one.
    dedupeSuffix: String(currentWindowStart(input.now).getTime()),
  });
}

/** Count one attempt on one axis and return the running total. */
async function count(
  axis: GuestRecoveryLimitAxis,
  subject: string,
  windowStartedAt: Date,
): Promise<number> {
  return await countRecoveryAttempt(getDb(), {
    axis,
    subjectHash: recoverySubjectHash(axis, subject),
    windowStartedAt,
  });
}

/**
 * The keyed digest a throttle counts against.
 *
 * The AXIS is part of the preimage, so an email hash and an order number that
 * happened to collide would still count separately — and, more usefully, so a
 * digest taken from one axis cannot be tested against another's rows. The key
 * is `GUEST_EMAIL_HASH_KEY`, reused rather than adding a fourth secret: it
 * already exists, it is already separate from the encryption key, and its
 * purpose (make a low-entropy value unguessable at rest) is exactly this one.
 */
function recoverySubjectHash(axis: GuestRecoveryLimitAxis, subject: string): string {
  return createHmac('sha256', keyMaterial()).update(`${axis}:${subject}`, 'utf8').digest('hex');
}

function keyMaterial(): string {
  const key = config.guest.emailHashKey.trim();
  if (key === '') {
    throw new Error(
      'GUEST_EMAIL_HASH_KEY is not set. Recovery throttling cannot store an unkeyed digest of ' +
        'an email address — a plain hash column would be offline-reversible the day it leaked.',
    );
  }
  return key;
}

/**
 * The current counting window's start, floored to the window size.
 *
 * A FIXED window rather than a sliding one, deliberately: a sliding window
 * needs the per-attempt event log this domain refuses to keep, and the cost of
 * the fixed one — a caller may get one window's allowance twice across a
 * boundary — is bounded by the ceiling being small.
 */
function currentWindowStart(now: Date): Date {
  const windowMs = config.guest.portal.recoveryWindowMinutes * MINUTE_MS;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * The COARSE network prefix an address belongs to: IPv4 /24, IPv6 /64.
 *
 * Coarse on purpose. A whole office, a mobile carrier's NAT pool and a
 * university share one of these, which makes it useless as an identifier and
 * adequate as a flood bound — and a /64 rather than a full IPv6 address is what
 * stops a client walking its own allocation around the limit one address at a
 * time. Nothing else about the client is read: no user agent, no TLS
 * characteristic, no header beyond the address the socket already carries.
 */
export function networkPrefix(clientIp: string): string {
  const address = clientIp.trim().toLowerCase();
  if (address.includes(':')) {
    // IPv6: the first four hextets are the /64. An address written with `::`
    // expands to fewer parts, and taking what is there is correct — a shortened
    // address has zeros in the omitted positions, so two addresses that share a
    // /64 still share this prefix.
    return address.split(':').slice(0, 4).join(':');
  }
  return address.split('.').slice(0, 3).join('.');
}
