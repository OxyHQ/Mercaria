/**
 * Telling the CURRENT verified operator that something high-impact happened to
 * their claim (#83 security control 7).
 *
 * Two events qualify and no others: somebody contested the claim, and the
 * claim was revoked. Both are things the operator cannot discover any other
 * way — a merchant page they still administer looks identical until they try
 * to act — and both are things they may need to answer.
 *
 * ## What these messages deliberately do NOT say
 *
 * Not who contested, not what evidence they brought, not which reviewer
 * decided, and never a contact address of any kind. A marketplace operator
 * told "contested by <person>" learns something about a competitor or a
 * customer, and the moderation domain already settled that this class of
 * disclosure belongs to an appeals surface with a human in it rather than to
 * an automatic notification. The revocation message carries the coded REASON,
 * because "your verification was withdrawn" without one is unactionable.
 *
 * Best-effort by design, the `seller-notification.ts` contract: the dispute or
 * the revocation has already committed, and re-running it to retry a push
 * message would risk a double transition to fix a courtesy.
 */

import type { MerchantClaimRevokeReason } from '@mercaria/shared-types';
import { sendNotification } from '../../lib/notification-service.js';
import { log } from '../../lib/logger.js';

/** Reason codes rendered for a human, so the message is actionable. */
const REVOKE_REASON_TEXT: Record<MerchantClaimRevokeReason, string> = {
  domain_loss: 'the domain that proved it is no longer under your control',
  platform_disconnect: 'the platform connection that proved it was disconnected',
  fraud: 'a fraud finding',
  operator_correction: 'a correction by the Mercaria team',
  claimant_request: 'your own request',
};

/** Tell the incumbent that their claim is being contested. */
export async function notifyOperatorOfContest(params: {
  incumbentOxyUserId: string;
  merchantId: string;
}): Promise<void> {
  try {
    await sendNotification({
      userId: params.incumbentOxyUserId,
      type: 'merchant_claim_contested',
      title: 'Someone is contesting your merchant claim',
      body:
        'A claim you hold on a merchant is being contested and is now under review. ' +
        'You keep management access while the Mercaria team looks at it.',
      priority: 'high',
      data: { merchantId: params.merchantId },
    });
  } catch (error: unknown) {
    log.general.warn(
      { err: error, merchantId: params.merchantId },
      '[MerchantClaim] failed to notify the verified operator of a contest',
    );
  }
}

/** Tell the former operator that their verification was withdrawn. */
export async function notifyOperatorOfRevocation(params: {
  formerOperatorOxyUserId: string;
  merchantId: string;
  reason: MerchantClaimRevokeReason;
}): Promise<void> {
  try {
    await sendNotification({
      userId: params.formerOperatorOxyUserId,
      type: 'merchant_claim_revoked',
      title: 'Your merchant claim was revoked',
      body:
        'Your verified claim on a merchant has been withdrawn because ' +
        `${REVOKE_REASON_TEXT[params.reason]}. You can start a new claim once that is resolved.`,
      priority: 'high',
      data: { merchantId: params.merchantId, reason: params.reason },
    });
  } catch (error: unknown) {
    log.general.warn(
      { err: error, merchantId: params.merchantId },
      '[MerchantClaim] failed to notify the former operator of a revocation',
    );
  }
}
