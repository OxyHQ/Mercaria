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

import type {
  ProviderAccountOwnerType,
  ProviderAccountStatus,
  RefusedCheckoutSeller,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { findStoresByIds } from '../../db/stores/storeRepository.js';
import {
  findProviderAccountByOwner,
  findProviderAccountsByOwners,
  type ProviderAccountRow,
} from '../../db/payments/providerAccountRepository.js';
import { checkoutRefusal } from '../checkout/refusal.js';
import { getProfiles } from '../oxy-user.service.js';
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
 * A stored row as the ONLY thing Mercaria says about a provider account.
 *
 * Every field is named explicitly rather than spread, which is the point: the
 * row carries the gateway's account id and this projection does not, and a
 * spread would have carried it the day someone added a column. `paymentReady`
 * is derived here and never stored — see `@mercaria/shared-types`'s
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
  };
}

/**
 * What a seller who has never started looks like.
 *
 * A real DTO rather than a 404, because "you have no payment account" is the
 * FIRST state of the onboarding surface, not a missing resource — the screen
 * renders it as the connect call to action.
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
    requirements: { currentlyDue: 0, eventuallyDue: 0, pastDue: 0, pendingVerification: 0 },
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
 * The sellers a refusal names, each by the name a buyer knows them by.
 *
 * A store by its `name`, a private seller by their Oxy display name — the same
 * two sources the cart's group header reads (`cart.service`'s `buildGroups`),
 * so the refusal names the seller exactly as the line above the items does.
 * Read only on the refusal path: an admitted checkout never pays for it.
 *
 * A name that cannot be read is ABSENT, never replaced by the key. Oxy not
 * answering for a person is the only way that happens (a listing's store row is
 * behind a foreign key), and the buyer is then told "a seller" — the key
 * stays in `sellerKey`, the machine field.
 */
async function nameRefusedSellers(sellerKeys: readonly string[]): Promise<RefusedCheckoutSeller[]> {
  const owners = sellerKeys.map((sellerKey) => ({ sellerKey, owner: parseSellerKey(sellerKey) }));
  const storeIds = owners.flatMap(({ owner }) =>
    owner?.ownerType === 'store' ? [owner.ownerId] : [],
  );
  const userIds = owners.flatMap(({ owner }) =>
    owner?.ownerType === 'user' ? [owner.ownerId] : [],
  );
  const [stores, profiles] = await Promise.all([findStoresByIds(storeIds), getProfiles(userIds)]);
  const storeNames = new Map(stores.map((store) => [store.id, store.name.trim()]));

  return owners.map(({ sellerKey, owner }) => {
    const name =
      owner?.ownerType === 'store'
        ? storeNames.get(owner.ownerId)
        : owner?.ownerType === 'user'
          ? profiles.get(owner.ownerId)?.displayName.trim()
          : undefined;
    return name ? { sellerKey, name } : { sellerKey };
  });
}

/** The English refusal sentence. Clients localize it from `details`; this is the fallback. */
function sellersNotPaymentReadyMessage(sellers: readonly RefusedCheckoutSeller[]): string {
  const names = sellers.map((seller) => seller.name ?? 'a seller');
  if (names.length === 1) {
    return (
      `${sellers[0]?.name ?? 'A seller'} cannot accept payment right now. ` +
      'Remove their items from your order to check out with the rest.'
    );
  }
  const list = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(names);
  return (
    `These sellers cannot accept payment right now: ${list}. ` +
    'Remove their items from your order to check out with the rest.'
  );
}

/**
 * Refuse a checkout whose sellers cannot be paid — BEFORE anything is reserved.
 *
 * ADR 0001 D4: a seller who lost eligibility between cart and checkout has their
 * group refused, and the buyer deselects it through the existing `sellerKeys`
 * partial-checkout mechanism. The MESSAGE names each seller by its public name
 * (never `store:<id>`); the KEYS ride `details.sellers`, so a client can
 * highlight and deselect those groups without a second round trip, and renders
 * the sentence in the buyer's own language from the same field.
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

  // A CLASSIFIED refusal (#106): the 409 and the reason code are what lets #77
  // count a rejected checkout without matching on this sentence. The import is
  // one type and one factory from the checkout domain — this module still knows
  // nothing about an adapter or about analytics.
  const sellers = await nameRefusedSellers(unready);
  throw checkoutRefusal('seller_not_payment_ready', sellersNotPaymentReadyMessage(sellers), {
    reason: 'seller_not_payment_ready',
    sellers,
  });
}
