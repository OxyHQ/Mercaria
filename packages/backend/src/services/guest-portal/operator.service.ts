/**
 * The operator surface's behaviour (#108 recovery rule 8, ADR 0003 T15).
 *
 * ## Two actions, and NO third
 *
 * Re-send an access link to the STORED contact, and revoke a group's access.
 * Both are things the buyer can already do themselves, so this surface adds an
 * audited TRIGGER and no new capability — the `payment_repairs` posture. There
 * is deliberately no "read this address", no "send to a different address", no
 * "mark this contact verified" and no "grant access to this group": a Mercaria
 * employee is never in possession of a portal credential, because the only
 * function that mints one from an operator's request puts it in the buyer's
 * inbox.
 *
 * ## The destination is unrepresentable, not refused
 *
 * `ResendAccessLinkRequest` has no destination field and neither does the HTTP
 * schema. T15 permits a support agent to trigger a re-send "to the stored
 * contact" and to "never read or reroute it to another address", and the way to
 * hold the second half is to have nowhere to put another address.
 *
 * ## Every attempt is audited, refusals included
 *
 * `guest_portal_operator_actions` takes one row per ATTEMPT with a mandatory
 * actor and a mandatory reason. A refused attempt is the row worth having: an
 * audit that only recorded successes answers "did anyone try" with silence.
 */

import type { GuestOrderScope, GuestPortalTrace } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { listGrantsForGroup } from '../../db/guestPortal/grantRepository.js';
import { listGuestPortalMessagesForGroup } from '../../db/guestPortal/messageRepository.js';
import { recordGuestPortalOperatorAction } from '../../db/guestPortal/operatorActionRepository.js';
import { findLiveSuppression } from '../../db/guestPortal/suppressionRepository.js';
import { findGuestCheckoutByGroup } from '../../db/guests/guestCheckoutRepository.js';
import { revokeGroupGrants } from '../../db/guestPortal/grantRepository.js';
import { log } from '../../lib/logger.js';
import { enqueueGuestMessage } from './message.service.js';

/** How many rows a trace returns per collection. Bounded, so a trace is a page. */
const TRACE_LIMIT = 50;

/** Why an operator attempt was refused. BOUNDED — the audit column is CHECKed. */
export type GuestPortalOperatorRefusal =
  /** No guest checkout for that group — it is an Oxy or connector purchase. */
  | 'not_a_guest_checkout'
  /** The contact was erased under ADR 0003 D15; there is no address to send to. */
  | 'contact_anonymized'
  /** The address is suppressed; sending would be re-mailing a bounce. */
  | 'contact_suppressed';

/**
 * What an audited attempt returns. A union, so a caller must narrow — on a
 * STRING, for the reason `GuestMessageDeliveryResult` states.
 */
export type GuestPortalOperatorResult =
  | { readonly status: 'performed'; readonly revokedGrantIds?: string[] }
  | { readonly status: 'refused'; readonly refusal: GuestPortalOperatorRefusal };

/**
 * Everything an operator may learn about one checkout group's portal access.
 *
 * Opens from a CHECKOUT GROUP and nothing else — the payment trace's five
 * handles and the analytics trace's two, applied here. "Show me everything this
 * inbox has ever accessed" is not a question this surface can be asked, because
 * there is no parameter for an inbox.
 *
 * The contact appears ONLY as `email_redacted` (T15). The grant list carries no
 * token hash, the message list has no recipient column, and the suppression is
 * reported as a boolean plus a reason rather than as the row that names a hash.
 */
export async function traceGuestPortalAccess(
  checkoutGroupId: string,
): Promise<GuestPortalTrace | null> {
  const db = getDb();
  const contact = await findGuestCheckoutByGroup(db, checkoutGroupId);
  if (!contact) return null;

  const [grants, messages, suppression] = await Promise.all([
    listGrantsForGroup(db, checkoutGroupId, TRACE_LIMIT),
    listGuestPortalMessagesForGroup(db, checkoutGroupId, TRACE_LIMIT),
    contact.emailHash === null
      ? Promise.resolve(null)
      : findLiveSuppression(db, contact.emailHash),
  ]);

  return {
    checkoutGroupId,
    contactRedacted: contact.emailRedacted,
    contactVerifiedAt:
      contact.contactVerifiedAt === null ? null : contact.contactVerifiedAt.toISOString(),
    suppression: {
      suppressed: suppression !== null,
      reason: suppression?.reason ?? null,
    },
    grants: grants.map((grant) => ({
      id: grant.id,
      purpose: grant.purpose,
      createdVia: grant.createdVia,
      exchangeReason: grant.exchangeReason,
      // `text[]` reaches TypeScript as `string[]`; the CHECK
      // `guest_order_access_grants_scopes_check` is what guarantees every element
      // is a member, so the narrowing states a constraint the database enforces
      // rather than one this projection hopes for.
      scopes: grant.scopes as GuestOrderScope[],
      emailVerified: grant.emailVerifiedAt !== null,
      createdAt: grant.createdAt.toISOString(),
      expiresAt: grant.expiresAt.toISOString(),
      consumedAt: grant.consumedAt === null ? null : grant.consumedAt.toISOString(),
      revokedAt: grant.revokedAt === null ? null : grant.revokedAt.toISOString(),
      lastUsedAt: grant.lastUsedAt === null ? null : grant.lastUsedAt.toISOString(),
    })),
    messages: messages.map((message) => ({
      id: message.id,
      kind: message.kind,
      state: message.state,
      attempts: message.attempts,
      lastFailure: message.lastFailure,
      createdAt: message.createdAt.toISOString(),
      sentAt: message.sentAt === null ? null : message.sentAt.toISOString(),
    })),
  };
}

/**
 * Queue a fresh access link to the stored contact, audited.
 *
 * The `dedupeSuffix` is the operator's own id plus the minute, so a support
 * agent re-sending after a buyer says "it never arrived" gets a NEW message
 * rather than converging on the one that already failed — which is the only
 * legitimate reason to bypass the deterministic id, and it stays an explicit
 * act by an identified person rather than a duplicate slipping through.
 *
 * Refuses before enqueuing when there is nothing to send to. That ordering
 * matters: a message enqueued against an anonymized contact would fail its
 * delivery attempt anyway, and the operator would learn the answer from a
 * dead-lettered row rather than from the response to their own action.
 */
export async function resendGuestAccessLink(input: {
  checkoutGroupId: string;
  actorOxyUserId: string;
  reason: string;
  now: Date;
}): Promise<GuestPortalOperatorResult> {
  const db = getDb();
  const contact = await findGuestCheckoutByGroup(db, input.checkoutGroupId);

  const refusal = await refusalFor(contact);
  if (refusal !== null) {
    await recordGuestPortalOperatorAction(db, {
      checkoutGroupId: input.checkoutGroupId,
      action: 'resend_access_link',
      actorOxyUserId: input.actorOxyUserId,
      reason: input.reason,
      outcome: 'refused',
      refusalCode: refusal,
    });
    return { status: 'refused', refusal };
  }

  await enqueueGuestMessage(
    {
      checkoutGroupId: input.checkoutGroupId,
      kind: 'access_link_recovery',
      dedupeSuffix: `op:${input.actorOxyUserId}:${Math.floor(input.now.getTime() / 60_000)}`,
    },
    db,
  );
  await recordGuestPortalOperatorAction(db, {
    checkoutGroupId: input.checkoutGroupId,
    action: 'resend_access_link',
    actorOxyUserId: input.actorOxyUserId,
    reason: input.reason,
    outcome: 'performed',
  });

  log.guest.info(
    { checkoutGroupId: input.checkoutGroupId, actorOxyUserId: input.actorOxyUserId },
    '[GuestPortal] operator re-sent an access link to the stored contact',
  );
  return { status: 'performed' };
}

/**
 * Revoke every live credential for a group, audited.
 *
 * The incident action: a buyer reports a forwarded link, or a shared device.
 * Unlike the buyer's own "secure my access" this spares NOTHING — an operator
 * is not holding one of the credentials, so there is nothing to keep, and
 * keeping one would mean an employee's session survived a revocation the buyer
 * asked for.
 */
export async function revokeGuestGroupAccess(input: {
  checkoutGroupId: string;
  actorOxyUserId: string;
  reason: string;
  now: Date;
}): Promise<GuestPortalOperatorResult> {
  const db = getDb();
  const contact = await findGuestCheckoutByGroup(db, input.checkoutGroupId);
  if (!contact) {
    await recordGuestPortalOperatorAction(db, {
      checkoutGroupId: input.checkoutGroupId,
      action: 'revoke_group_access',
      actorOxyUserId: input.actorOxyUserId,
      reason: input.reason,
      outcome: 'refused',
      refusalCode: 'not_a_guest_checkout',
    });
    return { status: 'refused', refusal: 'not_a_guest_checkout' };
  }

  const revokedGrantIds = await revokeGroupGrants(db, input.checkoutGroupId, input.now);
  await recordGuestPortalOperatorAction(db, {
    checkoutGroupId: input.checkoutGroupId,
    action: 'revoke_group_access',
    actorOxyUserId: input.actorOxyUserId,
    reason: input.reason,
    outcome: 'performed',
  });

  log.guest.info(
    {
      checkoutGroupId: input.checkoutGroupId,
      actorOxyUserId: input.actorOxyUserId,
      revokedGrantIds,
    },
    '[GuestPortal] operator revoked every credential for a checkout group',
  );
  return { status: 'performed', revokedGrantIds };
}

/** Why a re-send cannot happen, or `null` when it can. */
async function refusalFor(
  contact: { emailCiphertext: string | null; emailHash: string | null } | null,
): Promise<GuestPortalOperatorRefusal | null> {
  if (!contact) return 'not_a_guest_checkout';
  if (contact.emailCiphertext === null || contact.emailHash === null) return 'contact_anonymized';
  const suppression = await findLiveSuppression(getDb(), contact.emailHash);
  return suppression === null ? null : 'contact_suppressed';
}
