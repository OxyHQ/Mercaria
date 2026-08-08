/**
 * Payout health — the provider moving a SELLER's own balance to their bank.
 *
 * Mercaria is not a party to this movement. ADR 0001 D6 settles the merchant
 * receivable when the TRANSFER is created; from there the money is on the
 * seller's own balance and payout timing is between them and the rail. So this
 * module records and nothing more, and the absence of ledger postings here is
 * the load-bearing part: a failed payout must NOT reopen a receivable that was
 * already settled, or Mercaria would owe a seller twice for one order.
 *
 * ## What #49 added, and what was actually missing before it
 *
 * The events were already subscribed to and already stored (#48); what was
 * missing was the attribution. `provider_accounts` (#46) maps a connected
 * account to a store or an Oxy user, so a payout row is now answerable to a
 * seller — which is what makes it worth writing at all, since an unattributable
 * payout is a row nothing can ever surface.
 *
 * A payout for an account Mercaria has no row for is still RECORDED. It is
 * evidence — an account from another environment, or one whose row a rebuilt
 * database lost — and #45's rule is that an uninterpretable fact is worth more
 * stored than dropped. What it does not get is a domain event, because there is
 * no seller for a consumer to tell.
 */

import type { Money, PayoutStatus } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { upsertPayout, type PayoutRow } from '../../db/payments/paymentRepository.js';
import { findProviderAccountByProviderId } from '../../db/payments/providerAccountRepository.js';
import { enqueuePaymentEvent, payoutChangedEventId } from './payment-outbox.service.js';
import { NATIVE_RAIL, sellerKeyFor } from './provider-account.service.js';
import { log } from '../../lib/logger.js';

/** A payout exactly as the rail reported it, in Mercaria's vocabulary. */
export interface ObservedPayout {
  /** The connected account the payout is FROM — the seller's, not the platform's. */
  providerAccountId: string;
  providerObjectId: string;
  /**
   * The amount, in the SELLER's own settlement currency.
   *
   * Which may be a code Mercaria does not otherwise price in — the reason
   * `payouts.amount_currency` carries no CHECK. Nothing here converts it.
   */
  amount: Money;
  status: PayoutStatus;
  arrivalAt?: Date;
  /** The rail's own failure code, filtered to a safe subset by the caller. */
  failureCode?: string;
}

/** What recording a payout produced. */
export interface RecordedPayout {
  row: PayoutRow;
  /** The seller this payout belongs to, when the account maps to one. */
  sellerKey?: string;
}

/**
 * Record where a payout stands, and tell the rest of Mercaria.
 *
 * The row is an UPSERT, unlike almost everything else in this domain: a payout
 * moves `pending → in_transit → paid | failed` and each step arrives as its own
 * event about the SAME provider object. Nothing here is a ledger fact, so
 * refreshing it destroys no accounting — which is exactly why it is safe to do
 * what the payment aggregate may not.
 */
export async function recordPayout(observed: ObservedPayout): Promise<RecordedPayout> {
  const db = getDb();
  const row = await upsertPayout(db, {
    provider: NATIVE_RAIL,
    providerAccountRef: observed.providerAccountId,
    providerObjectId: observed.providerObjectId,
    amount: observed.amount,
    status: observed.status,
    ...(observed.arrivalAt ? { arrivalAt: observed.arrivalAt } : {}),
    ...(observed.failureCode ? { failureCode: observed.failureCode } : {}),
  });

  const account = await findProviderAccountByProviderId(
    db,
    NATIVE_RAIL,
    observed.providerAccountId,
  );
  if (!account) {
    log.general.warn(
      { payoutId: row.id, providerObjectId: observed.providerObjectId, status: observed.status },
      '[Payments] payout recorded for a connected account Mercaria has no row for; stored as ' +
        'evidence, with no seller to announce it to',
    );
    return { row };
  }

  const sellerKey = sellerKeyFor({ ownerType: account.ownerType, ownerId: account.ownerId });
  await db.transaction(async (tx) => {
    await enqueuePaymentEvent(tx, {
      id: payoutChangedEventId(row.id, observed.status),
      eventType: 'payout_changed',
      payload: {
        payoutId: row.id,
        accountRowId: account.id,
        ownerType: account.ownerType,
        ownerId: account.ownerId,
        sellerKey,
        status: observed.status,
        amountMinor: observed.amount.amount,
        currency: observed.amount.currency,
        ...(observed.arrivalAt ? { arrivalAt: observed.arrivalAt.toISOString() } : {}),
        ...(observed.failureCode ? { failureCode: observed.failureCode } : {}),
      },
    });
  });

  return { row, sellerKey };
}
