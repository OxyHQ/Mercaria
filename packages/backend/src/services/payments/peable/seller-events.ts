/**
 * The marketplace's SELLER-side events, as Peable delivers them: a seller's
 * connected account changing.
 *
 * They ride the same signed ingress, dedupe key, lease and replay as the
 * payment events (`event-router.ts` merges this table), and like every handler
 * there none applies a PAYLOAD: deliveries are unordered, so each handler takes
 * the object id the verifier stored unredacted and re-reads the gateway.
 */

import { PaymentProviderError } from '../provider.js';
import { redactAccountId, syncPeableAccount } from './accounts.js';
import type { PeableEventContext, PeableEventHandler, PeableEventOutcome } from './event-router.js';

/** An event naming an object this handler cannot work from — never retryable. */
function malformed(message: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'peable',
    stage: 'verifyEvent',
    message,
    retryable: false,
  });
}

/**
 * A seller's connected account changed: requirements, capabilities, payouts.
 *
 * An account Mercaria has no row for is `ignored`: one the gateway opened for
 * another environment, or one whose create answer this task has not finished
 * recording — and that create applies its own read, so nothing is lost.
 */
async function handleConnectedAccount(context: PeableEventContext): Promise<PeableEventOutcome> {
  const accountId = context.objectIds.connected_account;
  if (accountId === undefined) {
    throw malformed(`Peable event ${context.providerEventId} names no connected account.`);
  }
  const row = await syncPeableAccount(accountId);
  if (!row) {
    return {
      kind: 'ignored',
      note: `${redactAccountId(accountId)} is not a seller account Mercaria opened`,
    };
  }
  return {
    kind: 'applied',
    note: `seller account ${redactAccountId(accountId)} re-read; it is '${row.onboardingState}'`,
  };
}

/** Seller-side event types and their handlers. */
export const PEABLE_SELLER_EVENT_HANDLERS: Readonly<Record<string, PeableEventHandler>> = {
  'connected_account.updated': handleConnectedAccount,
};
