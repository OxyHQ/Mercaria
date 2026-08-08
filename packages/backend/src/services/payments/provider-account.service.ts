/**
 * Payment readiness, provider-neutrally — the half of #46 checkout may see.
 *
 * ## Why this is not in `stripe/account.service.ts`
 *
 * `checkout.service` must not import a Stripe module. ADR 0001's last
 * consequence is that everything provider-specific stays behind the payment
 * domain's own boundary, so that #51's Faircoin rail plugs into the same seams;
 * a `import { … } from './payments/stripe/…'` in the checkout path would make
 * the card rail structural to placing an order, which is the coupling the
 * `PaymentProvider` interface exists to prevent.
 *
 * So the split is by VOCABULARY, not by convenience: this file knows what a
 * seller key is, what `ready` means and what a client may be told. It does not
 * know what an `acct_…` is, how a capability becomes active, or that requirements
 * have names. The Stripe adapter owns all of that and has already collapsed its
 * answer into `onboarding_state` by the time anything here reads a row.
 *
 * ## Readiness is READ, never computed here
 *
 * ADR 0001 D9's conjunction is evaluated once, at synchronisation, and stored.
 * This file compares a stored verdict to one literal. Re-deriving it from the
 * boolean columns beside it would be a second implementation of the same rule,
 * living in the one place where getting it wrong admits an unpayable seller to a
 * checkout.
 */

import type {
  PaymentProviderId,
  ProviderAccountOwnerType,
  ProviderAccountStatus,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  findProviderAccountByOwner,
  type ProviderAccountRow,
} from '../../db/payments/providerAccountRepository.js';
import { conflict } from '../../lib/errors/error-codes.js';

/**
 * The rail a native checkout funds through.
 *
 * A constant rather than a parameter because there is exactly one today and
 * pretending otherwise would be an abstraction with a single implementation.
 * #51 adds a second rail with its own eligibility, and the seam it needs is a
 * seller-and-listing-aware CHOICE of rail — which is a different function from
 * this one, not a wider signature on it.
 */
export const NATIVE_RAIL: Extract<PaymentProviderId, 'stripe'> = 'stripe';

/** Which seller a group belongs to, decomposed from its key. */
export interface SellerAccountOwner {
  ownerType: ProviderAccountOwnerType;
  ownerId: string;
}

/**
 * Split a checkout seller key (`store:<id>` / `user:<id>`) into its owner.
 *
 * The format is `checkout.service`'s `sellerKeyForListing`, and this is the only
 * other place that knows it. `undefined` for anything else — a key shape this
 * version does not understand is not a seller to look up, and guessing would
 * turn a malformed input into a lookup for the WRONG owner.
 */
export function parseSellerKey(sellerKey: string): SellerAccountOwner | undefined {
  const separator = sellerKey.indexOf(':');
  if (separator <= 0) return undefined;
  const prefix = sellerKey.slice(0, separator);
  const ownerId = sellerKey.slice(separator + 1);
  if (ownerId === '') return undefined;
  if (prefix === 'store') return { ownerType: 'store', ownerId };
  if (prefix === 'user') return { ownerType: 'user', ownerId };
  return undefined;
}

/** The seller key for an owner — the inverse of {@link parseSellerKey}. */
export function sellerKeyFor(owner: SellerAccountOwner): string {
  return `${owner.ownerType}:${owner.ownerId}`;
}

/** The seller's account on the native rail, or `undefined` if they have none. */
export async function findSellerAccount(
  owner: SellerAccountOwner,
): Promise<ProviderAccountRow | undefined> {
  return await findProviderAccountByOwner(getDb(), { provider: NATIVE_RAIL, ...owner });
}

/**
 * Whether this seller may be paid, and therefore may be sold through.
 *
 * ADR 0001 D9: an account that exists and whose stored verdict is `ready`.
 * Everything else — never started, mid-onboarding, under review, restricted,
 * disabled — is not ready, and the difference between them is the seller's to
 * see, not the checkout's to act on.
 */
export async function isSellerPaymentReady(sellerKey: string): Promise<boolean> {
  const owner = parseSellerKey(sellerKey);
  if (!owner) return false;
  const account = await findSellerAccount(owner);
  return account?.onboardingState === 'ready';
}

/**
 * Refuse a checkout whose sellers cannot be paid — BEFORE anything is reserved.
 *
 * ADR 0001 D4: a seller who lost eligibility between cart and checkout has their
 * group refused, and the buyer deselects it through the existing `sellerKeys`
 * partial-checkout mechanism. The refusal names the keys so a client can do
 * exactly that without a second round trip — the message is the only channel a
 * `MercariaError` has, and inventing a structured one for a single call site
 * would be a wider error contract than the codebase has anywhere else.
 *
 * ## The gate is the RAIL, and the disabled branch touches nothing
 *
 * With `STRIPE_ENABLED` off there is no rail to be ready for: no account can
 * exist, no webhook is mounted, and the only path to `paid` is the dev-only
 * `mockPay` seam. Returning here — before `getDb()`, before any query — is what
 * makes "checkout behaves exactly as it did" a mechanism rather than a claim,
 * and it is pinned from both sides in the checkout suite.
 */
export async function assertSellerGroupsPaymentReady(sellerKeys: readonly string[]): Promise<void> {
  if (!config.payments.stripe.enabled) return;

  const unready: string[] = [];
  for (const sellerKey of sellerKeys) {
    if (!(await isSellerPaymentReady(sellerKey))) unready.push(sellerKey);
  }
  if (unready.length === 0) return;

  throw conflict(
    `These sellers cannot accept payment right now: ${unready.join(', ')}. ` +
      'Remove them from your order to check out with the rest.',
  );
}

/**
 * A stored row as the ONLY thing Mercaria says about a provider account.
 *
 * Every field is named explicitly rather than spread, which is the point: the
 * row carries the provider's account id and this projection does not, and a
 * spread would have carried it the day someone added a column. `paymentReady` is
 * derived here and never stored — see `@mercaria/shared-types`'s
 * `provider-account.ts` for why there is exactly one verdict.
 */
export function toProviderAccountStatus(row: ProviderAccountRow): ProviderAccountStatus {
  return {
    provider: row.provider,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    onboardingState: row.onboardingState,
    paymentReady: row.onboardingState === 'ready',
    chargesEnabled: row.chargesEnabled,
    payoutsEnabled: row.payoutsEnabled,
    ...(row.transfersCapability ? { transfersCapability: row.transfersCapability } : {}),
    country: row.country,
    ...(row.defaultCurrency ? { payoutCurrency: row.defaultCurrency } : {}),
    ...(row.payoutScheduleInterval
      ? {
          payoutSchedule: {
            interval: row.payoutScheduleInterval,
            ...(row.payoutScheduleDelayDays !== null
              ? { delayDays: row.payoutScheduleDelayDays }
              : {}),
          },
        }
      : {}),
    requirements: {
      currentlyDue: row.requirementsCurrentlyDue,
      eventuallyDue: row.requirementsEventuallyDue,
      pastDue: row.requirementsPastDue,
      pendingVerification: row.requirementsPendingVerification,
      ...(row.requirementsDeadlineAt
        ? { currentDeadline: row.requirementsDeadlineAt.toISOString() }
        : {}),
    },
    disabledReasonCodes: row.disabledReasonCodes,
    ...(row.lastSyncedAt ? { lastSyncedAt: row.lastSyncedAt.toISOString() } : {}),
    ...(row.activatedAt ? { activatedAt: row.activatedAt.toISOString() } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
  };
}

/**
 * What a seller who has never started looks like.
 *
 * A real DTO rather than a 404, because "you have no payment account" is the
 * FIRST state of the onboarding surface, not a missing resource — the dashboard
 * renders it as the connect call to action. A 404 would make the client's first
 * render an error path.
 */
export function notConnectedStatus(owner: SellerAccountOwner): ProviderAccountStatus {
  return {
    provider: NATIVE_RAIL,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    onboardingState: 'not_connected',
    paymentReady: false,
    chargesEnabled: false,
    payoutsEnabled: false,
    requirements: {
      currentlyDue: 0,
      eventuallyDue: 0,
      pastDue: 0,
      pendingVerification: 0,
    },
    disabledReasonCodes: [],
  };
}

/** The seller's account status, or the `not_connected` shape when there is none. */
export async function readSellerAccountStatus(
  owner: SellerAccountOwner,
): Promise<ProviderAccountStatus> {
  const account = await findSellerAccount(owner);
  return account ? toProviderAccountStatus(account) : notConnectedStatus(owner);
}
