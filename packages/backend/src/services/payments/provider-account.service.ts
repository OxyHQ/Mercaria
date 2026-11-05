/**
 * Payment readiness, provider-neutrally — the half of #46 checkout may see.
 *
 * `checkout.service` must not import an adapter module. ADR 0001's last
 * consequence is that everything provider-specific stays behind the payment
 * domain's own boundary; an adapter import in the checkout path would make the
 * card rail structural to placing an order, which is the coupling the
 * `PaymentProvider` interface exists to prevent.
 *
 * So the split is by VOCABULARY, not by convenience: this file knows what a
 * seller key is, what `ready` means and what a client may be told. It does not
 * know what a provider account id is, how a capability becomes active, or that
 * requirements have names; the synchronisation that writes a `provider_accounts`
 * row has already collapsed all of that into `onboarding_state`.
 *
 * ## Readiness is READ, never computed here
 *
 * ADR 0001 D9's conjunction is evaluated once, at synchronisation, and stored.
 * This file compares a stored verdict to one literal. Re-deriving it from the
 * boolean columns beside it would be a second implementation of the same rule,
 * living in the one place where getting it wrong admits an unpayable seller to a
 * checkout.
 */

import type { ProviderAccountOwnerType } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  findProviderAccountByOwner,
  findProviderAccountsByOwners,
  type ProviderAccountRow,
} from '../../db/payments/providerAccountRepository.js';
import { checkoutRefusal } from '../checkout/refusal.js';
import { NATIVE_RAIL, resolveNativeRail } from './native-rail.js';

/** The rail a native checkout funds through — see `native-rail.ts`. */
export { resolveNativeRail } from './native-rail.js';

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
  // Deliberately NOT gated on the rail being configured. Which account a seller
  // is connected to is a different question from whether this deployment can
  // charge on it today, and only the second is configuration-dependent: turning
  // a rail off during an incident must not make Mercaria forget the account. The
  // gates above and below DO return early, which is where that property belongs.
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
 * The same verdict as {@link isSellerPaymentReady}, for MANY sellers in one
 * query — the offer domain's read (#57 native rule 2).
 *
 * A comparison page can name twenty sellers, and asking one at a time would make
 * a read of twenty offers twenty-one round trips. The verdict is identical:
 * ADR 0001 D9's one stored `onboarding_state`, never re-derived here.
 *
 * With no native rail configured it returns before touching Postgres, exactly as
 * {@link assertSellerGroupsPaymentReady} does and for the same reason: there is
 * no rail to be ready for, so no account can exist and the question is not
 * merely unanswered but meaningless. Every key maps to `false`, which is the
 * fail-closed direction for a checkout affordance — and native checkout on that
 * deployment goes through the dev-only `mockPay` seam anyway, which does not
 * consult this.
 *
 * Keys this function cannot parse, and sellers with no account, are absent from
 * the map rather than present as `false`. The caller's `?? false` is the same
 * default either way, and an absent entry says "no account" while a stored
 * `false` would claim a verdict nobody made.
 */
export async function readSellerPaymentReadiness(
  sellerKeys: readonly string[],
): Promise<Map<string, boolean>> {
  const readiness = new Map<string, boolean>();
  const rail = resolveNativeRail();
  if (!rail || sellerKeys.length === 0) return readiness;

  const owners = sellerKeys.flatMap((sellerKey) => {
    const owner = parseSellerKey(sellerKey);
    return owner ? [{ sellerKey, owner }] : [];
  });
  if (owners.length === 0) return readiness;

  const rows = await findProviderAccountsByOwners(
    getDb(),
    rail,
    owners.map(({ owner }) => owner),
  );
  const byKey = new Map(rows.map((row) => [sellerKeyFor(row), row.onboardingState]));

  for (const { sellerKey } of owners) {
    const state = byKey.get(sellerKey);
    if (state !== undefined) readiness.set(sellerKey, state === 'ready');
  }
  return readiness;
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
 * With no native rail configured there is no rail to be ready for: no account can
 * exist, no webhook is mounted, and the only path to `paid` is the dev-only
 * `mockPay` seam. Returning here — before `getDb()`, before any query — is what
 * makes "checkout behaves exactly as it did" a mechanism rather than a claim,
 * and it is pinned from both sides in the checkout suite.
 */
export async function assertSellerGroupsPaymentReady(sellerKeys: readonly string[]): Promise<void> {
  if (!resolveNativeRail()) return;

  const unready: string[] = [];
  for (const sellerKey of sellerKeys) {
    if (!(await isSellerPaymentReady(sellerKey))) unready.push(sellerKey);
  }
  if (unready.length === 0) return;

  // A CLASSIFIED refusal (#106): the message is unchanged and so is the 409,
  // but the reason code is what lets #77 count a rejected checkout without
  // matching on this sentence. The import is one type and one factory from the
  // checkout domain — this module still knows nothing about an adapter or about
  // analytics.
  throw checkoutRefusal(
    'seller_not_payment_ready',
    `These sellers cannot accept payment right now: ${unready.join(', ')}. ` +
      'Remove them from your order to check out with the rest.',
  );
}
