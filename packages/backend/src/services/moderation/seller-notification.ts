/**
 * Telling a seller their listing needs changes.
 *
 * `request_changes` is the only enforcement outcome the seller can act on
 * themselves, which makes the notification part of the action rather than a
 * courtesy: a listing silently moved to `draft` looks to its owner like a bug in
 * Mercaria, and they will either re-publish it unchanged or open a support ticket.
 * Both waste the decision.
 *
 * ## What this deliberately does NOT say
 *
 * Not the allegation, not the finding, not the reporter, not the jury's reasoning.
 * A seller told "reported for counterfeit by a buyer" learns something about who
 * is looking at them, and in a marketplace that is an invitation to retaliate
 * against a competitor or a customer. The message says the listing needs changes
 * to meet the marketplace rules and points at the listing. Anything more is a
 * disclosure decision that belongs to an appeals surface with a human in it, not
 * to an automatic webhook handler.
 *
 * Best-effort by design. A notification failure must never roll back an
 * enforcement that already committed — the listing IS down, and re-running the
 * action to retry a push message would risk double-enforcement to fix a courtesy.
 */

import mongoose from 'mongoose';
import { Store } from '../../models/store.js';
import { sendNotification } from '../../lib/notification-service.js';
import { log } from '../../lib/logger.js';

export interface RequestedChangesNotificationInput {
  listingId: string;
  listingTitle?: string;
  ownerType?: string;
  oxyUserId?: string;
  storeId?: string;
}

/**
 * Who to tell.
 *
 * A P2P listing has its seller. A store listing goes to the store's OWNER,
 * resolved server-side from the member list — never to whoever happened to edit
 * it last, and never to an id taken from a request.
 */
async function resolveRecipient(
  input: RequestedChangesNotificationInput,
): Promise<string | undefined> {
  if (input.ownerType === 'user') return input.oxyUserId;
  if (input.storeId === undefined || !mongoose.isValidObjectId(input.storeId)) {
    return undefined;
  }
  const store = await Store.findById(input.storeId)
    .select('members.oxyUserId members.role')
    .lean<{ members?: { oxyUserId: string; role: string }[] } | null>();
  return store?.members?.find((member) => member.role === 'owner')?.oxyUserId;
}

export async function notifySellerOfRequestedChanges(
  input: RequestedChangesNotificationInput,
): Promise<void> {
  try {
    const recipient = await resolveRecipient(input);
    if (recipient === undefined) {
      log.moderation.warn(
        { listingId: input.listingId },
        '[Moderation] no seller to notify about requested changes',
      );
      return;
    }

    await sendNotification({
      userId: recipient,
      type: 'listing_changes_requested',
      title: 'Your listing needs changes',
      body:
        `"${input.listingTitle ?? 'Your listing'}" has been moved back to drafts because it ` +
        'needs changes to meet the marketplace rules. Update it and publish again.',
      priority: 'high',
      data: { listingId: input.listingId },
    });
  } catch (error: unknown) {
    // Never surfaced to the caller: the enforcement it accompanies has already
    // committed, and failing here must not undo it.
    log.moderation.warn(
      { err: error, listingId: input.listingId },
      '[Moderation] failed to notify seller of requested changes',
    );
  }
}
