/**
 * The guest-checkout rollout gates (#107 acceptance 13, fraud rule 8) and the
 * #85 merchant-activation seam.
 *
 * ## Where this sits, and why it is not one more clause in the eligibility gate
 *
 * `fulfilment-eligibility.ts` answers questions about the WORLD — can this
 * address be delivered to, may a guest buy from an individual, can this method
 * be priced. This file answers a question about the DEPLOYMENT: has an operator
 * currently withdrawn guest checkout from this platform, market, merchant or
 * fulfilment path. The two look alike from a buyer's side (both are a 409 before
 * anything is reserved) and are opposite in every way that matters to whoever
 * maintains them: an eligibility rule is a decision that survives a restart,
 * and a kill switch is a lever somebody pulls at 3am and un-pulls at 9.
 *
 * Keeping them apart is also what keeps the eligibility gate honest. A rollout
 * lever mixed into it would eventually be read as a policy — "we do not serve
 * guests in Portugal" — when the truth was "somebody turned it off during an
 * incident and nobody turned it back on".
 *
 * ## Every lever is a BLOCK list and every one is empty by default
 *
 * So this whole module is a no-op on a deployment that has configured nothing,
 * which is the only acceptable default for something that runs on the checkout
 * path. See `GuestCheckoutRolloutConfig` in `config/index.ts` for why block
 * lists rather than the allow-lists the rest of the checkout path uses.
 *
 * ## What these levers may NOT reach
 *
 * ADR 0006 G17, and it is the property `guest-rollout-isolation.test.ts`
 * enforces by scan: nothing in the webhook ingress, the payment outbox,
 * settlement, refunds or reconciliation may read this configuration. A guest
 * checkout blocked while a PaymentIntent is already open must still drain to a
 * terminal state — orders paid, transfers made, the portal event emitted —
 * because the money has already moved and a flag is not a reason to strand it.
 * "Gate the loop, never the durable record", applied to a rollout switch.
 *
 * ## The refusals name no lever
 *
 * One reason code (`guest_rollout_blocked`) covers four dimensions. A refusal
 * that named the dimension would let a client enumerate the levers by varying
 * one input at a time — which market is off, which merchant — and the buyer
 * cannot act on the answer anyway. WHICH lever fired is logged, beside the
 * operator who set it.
 */

import type { ShippingMethod } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import type { CommerceActor, GuestActor } from '../commerce-actor.js';
import { checkoutRefusal } from './refusal.js';
import type { EligibilitySellerGroup } from './fulfilment-eligibility.js';

/**
 * Which client a guest checkout came from, as the rollout lever sees it.
 *
 * DERIVED from the credential's carriage (ADR 0003 D9: the `__Host-` cookie is
 * the web transport, the `X-Mercaria-Guest-Token` header is the native one), so
 * the value is server-observed rather than read off a name a client chose. It
 * is still an operational lever and not a security boundary — a native build
 * that presented a cookie would be counted as web — which is precisely why
 * every gate that carries security weight (seller readiness, the P2P exclusion,
 * the currency and market gates) is derived from server state and none of them
 * appears on a rollout list.
 *
 * Two values rather than four (`web | ios | android | other`, the
 * `GuestClientClass` vocabulary): the client class is DECLARED by a header and
 * is therefore a client's own claim, and a kill switch keyed on a claim can be
 * walked around by editing one string. The transport cannot be, without also
 * changing how the credential is stored.
 */
export type GuestCheckoutPlatform = 'web' | 'native';

/** The platform a guest actor's credential arrived on. */
export function guestCheckoutPlatform(actor: GuestActor): GuestCheckoutPlatform {
  return actor.transport === 'cookie' ? 'web' : 'native';
}

/**
 * What #85 will answer about one seller, and what it answers today.
 *
 * `activated` is unrepresentable on purpose. #85 owns merchant activation
 * readiness, no table records it, and a member meaning "yes" would be a value
 * this version could return — which is exactly the stub that lies. So the union
 * has the two answers that are TRUE today, and #85's author adds the third
 * beside a repository read.
 */
export type GuestSellerActivation =
  /**
   * No activation state exists for this seller because none exists for anyone:
   * #85 has not landed. Whether that refuses a checkout is
   * `GUEST_SELLER_ACTIVATION_REQUIRED`'s decision, not this function's.
   */
  | { readonly state: 'unrecorded' }
  /** An operator has withdrawn this seller from guest checkout by hand. */
  | { readonly state: 'blocked_by_operator' };

/**
 * The #85 seam — the ONE function that decides whether a seller may sell to a
 * guest, beyond what payment readiness already decided.
 *
 * Today it can only report `unrecorded` or an operator's explicit block, and
 * both facts are read from configuration rather than from a table, because
 * there is no table: #85 is what creates one. When it lands, THIS function
 * grows a repository read and nothing else in the checkout path changes — the
 * gate below, the refusal shape and the reason code are already in place around
 * it — the way #93's pickup seam was held and then filled: that one was a
 * function that refused unconditionally until the facts existed, and #93
 * replaced its body without touching a caller.
 *
 * The property that makes it a seam rather than a stub: there is no input and
 * no configuration that makes it return "activated", so a deployment cannot
 * accidentally satisfy #85's requirement before #85 exists.
 */
export function readGuestSellerActivation(sellerKey: string): GuestSellerActivation {
  return config.guest.checkoutRollout.blockedSellerKeys.includes(sellerKey)
    ? { state: 'blocked_by_operator' }
    : { state: 'unrecorded' };
}

/**
 * Refuse a guest checkout an operator has switched off — BEFORE anything is
 * reserved and long before a payment exists.
 *
 * A no-op for every non-guest actor: these are guest-commerce levers, and an
 * authenticated checkout in a market where guest checkout is paused must keep
 * working, or the lever is a marketplace outage wearing a rollout's name.
 *
 * The four dimensions are checked in the order a refusal is most likely to be
 * actionable: the platform (nothing the buyer can change — they are told to try
 * later), the market, the sellers, the fulfilment method (which they CAN
 * change). Only the first failing dimension is reported, because a buyer acts
 * on one remedy at a time.
 */
export function assertGuestCheckoutRolloutAllowed(input: {
  actor: CommerceActor;
  /** The resolved destination's ISO-3166 alpha-2 country, already upper-cased. */
  destinationCountry: string;
  groups: readonly EligibilitySellerGroup[];
}): void {
  if (input.actor.kind !== 'guest') return;
  const rollout = config.guest.checkoutRollout;

  const platform = guestCheckoutPlatform(input.actor);
  if (rollout.blockedPlatforms.includes(platform)) {
    refuse('platform', { platform });
  }

  if (rollout.blockedMarkets.includes(input.destinationCountry)) {
    refuse('market', { market: input.destinationCountry });
  }

  const blockedSellers = input.groups
    .filter((group) => readGuestSellerActivation(group.sellerKey).state === 'blocked_by_operator')
    .map((group) => group.sellerKey);
  if (blockedSellers.length > 0) {
    refuse('merchant', { sellerKeys: blockedSellers.sort() });
  }

  const blockedMethods = uniqueMethods(input.groups).filter((method) =>
    rollout.blockedFulfilmentMethods.includes(method),
  );
  if (blockedMethods.length > 0) {
    refuse('fulfilment', { methods: blockedMethods });
  }

  assertGuestSellersActivated(input.groups);
}

/**
 * The #85 gate proper: with `GUEST_SELLER_ACTIVATION_REQUIRED` on, a seller
 * with no activation record cannot sell to a guest.
 *
 * Since `readGuestSellerActivation` cannot return "activated" until #85 lands,
 * turning the flag on today refuses EVERY guest checkout — by name, in a
 * message that says why. That is the fail-closed direction and it is the whole
 * value of shipping the lever before the feature: a deployment cannot decide it
 * is enforcing merchant activation and quietly be enforcing nothing.
 *
 * A separate function from the four levers above because it is a different KIND
 * of refusal — a policy this deployment has chosen to enforce, not an incident
 * switch — and it earns its own reason code for the same reason
 * `seller_not_payment_ready` has one: the remedy is a merchant action, and a
 * merchant sent to the wrong screen stays stuck.
 */
function assertGuestSellersActivated(groups: readonly EligibilitySellerGroup[]): void {
  if (!config.guest.checkoutRollout.sellerActivationRequired) return;

  const unactivated = groups
    .filter((group) => readGuestSellerActivation(group.sellerKey).state !== 'blocked_by_operator')
    .map((group) => group.sellerKey)
    .sort();
  if (unactivated.length === 0) return;

  log.guest.warn(
    { sellerKeys: unactivated },
    '[Guest] GUEST_SELLER_ACTIVATION_REQUIRED is on and no seller carries an activation record ' +
      '(#85 has not landed), so every guest checkout is refused',
  );
  throw checkoutRefusal(
    'guest_seller_not_activated',
    `These sellers have not been activated for guest checkout: ${unactivated.join(', ')}. ` +
      'Sign in to buy from them, or remove them to check out with the rest.',
  );
}

/** Every distinct fulfilment method the selected groups asked for, sorted. */
function uniqueMethods(groups: readonly EligibilitySellerGroup[]): ShippingMethod[] {
  return [...new Set(groups.map((group) => group.shippingMethod))].sort();
}

/**
 * Log which lever fired, then refuse with a message that does not say.
 *
 * The asymmetry is the point (see the module docblock): an operator needs to
 * know which switch is costing them checkouts, and a client must not be able to
 * map the switchboard by varying one input per request. The buyer's remedy is
 * the same for all four — wait, or sign in — so nothing actionable is withheld.
 */
function refuse(dimension: string, details: Record<string, unknown>): never {
  log.guest.warn(
    { dimension, ...details },
    '[Guest] checkout refused by a rollout kill switch',
  );
  throw checkoutRefusal(
    'guest_rollout_blocked',
    'Guest checkout is temporarily unavailable for this order. Sign in to continue, or try ' +
      'again later.',
  );
}
