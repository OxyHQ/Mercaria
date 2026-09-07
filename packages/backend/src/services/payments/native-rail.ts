/**
 * WHICH rail a native checkout funds through on this deployment.
 *
 * ## Why this is a resolution and not a constant
 *
 * It used to be `NATIVE_RAIL: Extract<PaymentProviderId, 'stripe'> = 'stripe'`,
 * pinned in the TYPE so that widening it was a type change rather than a value
 * change. The comment beside it said a second rail "would bring its own
 * eligibility, and the seam it needs is a seller-and-listing-aware CHOICE of
 * rail — which is a different function from this one". ADR 0009 brought the
 * second rail, and the choice is not seller-aware at all: it is a property of
 * the DEPLOYMENT, which is a much smaller question than the one that constant
 * was waiting for.
 *
 * Three things read `stripe.enabled` as a proxy for "is there a native rail",
 * and on a Peable-only deployment two of them failed closed (a seller reads as
 * unpayable) while `assertSellerGroupsPaymentReady` failed **open**: it returned
 * before looking at anything, so a checkout admitted every seller including ones
 * with no connected account at all — the exact case ADR 0001 D4 exists to
 * refuse. This module is the one place that answers the question, so the three
 * cannot disagree again.
 *
 * ## No adapter imports, on purpose
 *
 * `registry.ts` resolves a rail to an ADAPTER and therefore imports every
 * adapter module. `provider-account.service.ts` must not reach a Stripe module
 * (its own docblock says why), and it is on the checkout path. So availability
 * lives here — reading configuration and nothing else — and `registry.ts`
 * consults it rather than keeping a second copy of the same three gates.
 */

import {
  PAYMENT_PROVIDER_IDS,
  type CurrencyCode,
  type PaymentProviderId,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';

/**
 * Whether a rail is configured on this deployment.
 *
 * TOTAL over `PaymentProviderId`, so a sixth provider does not compile until it
 * has answered. `external` and `manual_pos` are payments Mercaria RECORDS rather
 * than makes: they are never "configured" because there is nothing to configure,
 * and answering `false` is the truth rather than a stub.
 */
const RAIL_IS_CONFIGURED: Record<PaymentProviderId, () => boolean> = {
  external: () => false,
  manual_pos: () => false,
  mock: () => config.orders.mockPayEnabled,
  peable: () => config.payments.peable.enabled,
  stripe: () => config.payments.stripe.enabled,
};

/** Whether this deployment has configured `provider`. */
export function isRailConfigured(provider: PaymentProviderId): boolean {
  return RAIL_IS_CONFIGURED[provider]();
}

/**
 * The rails that can serve a NATIVE checkout, in preference order — lower rank
 * wins — with `null` for a rail that never can.
 *
 * TOTAL for the same reason as above, and the `null`s carry the real decisions:
 *
 * - `mock` is configured on dev deployments and is deliberately NOT native.
 *   `POST /orders/:id/mock-pay` funds a group from its own endpoint AFTER
 *   checkout, so a mock deployment must behave like one with no rail — which is
 *   what `resolveCheckoutRail` already encodes and what this `null` keeps true
 *   from the other side.
 * - `external` and `manual_pos` are records of money that moved elsewhere.
 *
 * Peable outranks Stripe because ADR 0009 makes it the destination: a deployment
 * with both configured is mid-migration, and a checkout opening TODAY should
 * open on the rail the migration is heading to. Turning `PEABLE_ENABLED` off is
 * therefore the complete rollback, with no second switch to remember.
 */
const NATIVE_CHECKOUT_RANK: Record<PaymentProviderId, number | null> = {
  external: null,
  manual_pos: null,
  mock: null,
  peable: 1,
  stripe: 2,
};

/**
 * Every rail that could serve a native checkout, best first — DERIVED from the
 * rank table rather than listed beside it, so the two cannot drift.
 *
 * Filtered from `PAYMENT_PROVIDER_IDS` rather than from `Object.keys`, because
 * the shared tuple is what every other closed-set consumer in this codebase
 * reads and a key added to the record alone would otherwise be silently live.
 */
export const NATIVE_RAIL_PREFERENCE: readonly PaymentProviderId[] = PAYMENT_PROVIDER_IDS.filter(
  (provider) => NATIVE_CHECKOUT_RANK[provider] !== null,
).sort((a, b) => (NATIVE_CHECKOUT_RANK[a] ?? 0) - (NATIVE_CHECKOUT_RANK[b] ?? 0));

/**
 * The rail this deployment funds a native checkout through, or `undefined` when
 * it has none.
 *
 * `undefined` is an ordinary answer, not a failure: a deployment with no rail
 * places orders exactly as it did before any of this existed. Read it fresh on
 * every call rather than caching — `config` is frozen at boot but a suite that
 * exercises both rails switches it, and a cached answer would make the second
 * suite in a file test the first one's deployment.
 */
export function resolveNativeRail(): PaymentProviderId | undefined {
  return NATIVE_RAIL_PREFERENCE.find((provider) => isRailConfigured(provider));
}

/**
 * What a card checkout on each rail may be denominated in — ADR 0001 D8.
 *
 * TOTAL over `PaymentProviderId` for the same reason the two records above are:
 * a sixth rail must answer, and answering `[]` is a real answer meaning "this
 * rail charges nothing", which `assertCheckoutCurrencyEligible` reads as a
 * refusal rather than as a pass.
 *
 * `external`, `manual_pos` and `mock` never reach that gate — none of them is a
 * native rail — so their empty sets are unreachable rather than restrictive.
 */
const PRESENTMENT_CURRENCIES: Record<PaymentProviderId, () => readonly CurrencyCode[]> = {
  external: () => [],
  manual_pos: () => [],
  mock: () => [],
  peable: () => config.payments.peable.presentmentCurrencies,
  stripe: () => config.payments.stripe.presentmentCurrencies,
};

/**
 * The currencies THIS deployment's native rail can be charged in.
 *
 * Empty when there is no rail, which is the honest answer and not a hazard:
 * `resolveCheckoutRail` has already returned `none` in that case, so the gate
 * that reads this is unreachable.
 */
export function nativeRailPresentmentCurrencies(): readonly CurrencyCode[] {
  const rail = resolveNativeRail();
  return rail ? PRESENTMENT_CURRENCIES[rail]() : [];
}
