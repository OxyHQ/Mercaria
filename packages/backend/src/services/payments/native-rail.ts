/**
 * WHICH rail a native checkout funds through on this deployment.
 *
 * ## Why this is a resolution and not a constant
 *
 * The rail is a property of the DEPLOYMENT (ADR 0009 D19): Peable when it is
 * configured, and none otherwise. This module is the one place that answers
 * "is there a native rail", so checkout's readiness gate, the seller-facing
 * readiness read and the rail choice cannot disagree — the failure that made it
 * a module was `assertSellerGroupsPaymentReady` failing OPEN while the other two
 * failed closed, admitting sellers with no connected account at all, which ADR
 * 0001 D4 exists to refuse.
 *
 * ## No adapter imports, on purpose
 *
 * `registry.ts` resolves a rail to an ADAPTER and therefore imports every
 * adapter module. `provider-account.service.ts` is on the checkout path and must
 * stay free of adapter code, so availability lives here — reading configuration
 * and nothing else — and `registry.ts` consults it rather than keeping a second
 * copy of the same gates.
 */

import type { CheckoutPaymentRail, CurrencyCode, PaymentProviderId } from '@mercaria/shared-types';
import { config } from '../../config/index.js';

/**
 * Whether a rail is configured on this deployment.
 *
 * TOTAL over `PaymentProviderId`, so a new provider does not compile until it
 * has answered. `external` and `manual_pos` are payments Mercaria RECORDS rather
 * than makes: they are never "configured" because there is nothing to configure,
 * and answering `false` is the truth rather than a stub.
 */
const RAIL_IS_CONFIGURED: Record<PaymentProviderId, () => boolean> = {
  external: () => false,
  manual_pos: () => false,
  mock: () => config.orders.mockPayEnabled,
  peable: () => config.payments.peable.enabled,
  // The same gateway's FairCoin rail (ADR 0019). Configured exactly when the
  // card rail is, and never separately: FairCoin is always offered and there is
  // no switch that turns it off (Peable ADR 0021 D1).
  peable_faircoin: () => config.payments.peable.enabled,
};

/** Whether this deployment has configured `provider`. */
export function isRailConfigured(provider: PaymentProviderId): boolean {
  return RAIL_IS_CONFIGURED[provider]();
}

/**
 * The one rail that can serve a NATIVE checkout — ADR 0009.
 *
 * Pinned in the TYPE, so a second native rail is a type change rather than a
 * value change. The others never can: `mock` is configured on dev deployments
 * and is deliberately NOT native (`POST /orders/:id/mock-pay` funds a group from
 * its own endpoint AFTER checkout, so a mock deployment must behave like one
 * with no rail), and `external` and `manual_pos` are records of money that moved
 * elsewhere.
 *
 * It is also the subject of a seller's readiness on a deployment whose rail is
 * switched off: which account a seller holds does not depend on whether this
 * deployment can charge on it today.
 */
export const NATIVE_RAIL: Extract<PaymentProviderId, 'peable'> = 'peable';

/**
 * The rail this deployment funds a native checkout through, or `undefined` when
 * it has none.
 *
 * `undefined` is an ordinary answer, not a failure: a deployment with no rail
 * places orders exactly as it did before any of this existed. Read it fresh on
 * every call rather than caching — `config` is frozen at boot but a suite that
 * exercises the rail switches it, and a cached answer would make the second
 * suite in a file test the first one's deployment.
 */
export function resolveNativeRail(): PaymentProviderId | undefined {
  return isRailConfigured(NATIVE_RAIL) ? NATIVE_RAIL : undefined;
}

/**
 * The currencies THIS deployment's CARD rail can be charged in — ADR 0001 D8.
 * FairCoin is the other native rail and is paid in `FAIR` alone
 * ({@link nativeCheckoutCurrencies} is the union).
 *
 * Empty when there is no rail, which is the honest answer and not a hazard:
 * `resolveCheckoutRail` has already returned `none` in that case, so the gate
 * that reads this is unreachable. An empty CONFIGURED set is a real answer
 * meaning "this rail charges nothing", which `assertCheckoutCurrencyEligible`
 * reads as a refusal rather than as a pass.
 */
export function nativeRailPresentmentCurrencies(): readonly CurrencyCode[] {
  return resolveNativeRail() ? config.payments.peable.presentmentCurrencies : [];
}

/**
 * The rail that pays a seller in FairCoin — ADR 0019. Pinned in the type for the
 * reason {@link NATIVE_RAIL} is.
 */
export const FAIRCOIN_RAIL: Extract<PaymentProviderId, 'peable_faircoin'> = 'peable_faircoin';

/** The one currency the FairCoin rail is paid in. */
export const FAIRCOIN_CURRENCY: CurrencyCode = 'FAIR';

/**
 * Which rail a checkout in `currency` is paid on — ADR 0019 D1, and the ONE
 * place the rule is written: `FAIR` is paid in FairCoin (no card can settle
 * FAIR, Peable ADR 0021 D1), every other currency by card, in which the card
 * rail's own currency gate then decides.
 */
export function railForCurrency(currency: CurrencyCode): CheckoutPaymentRail {
  return currency === FAIRCOIN_CURRENCY ? 'faircoin' : 'card';
}

/** The provider behind a checkout rail on this deployment, or `undefined` without one. */
export function resolveRailProvider(rail: CheckoutPaymentRail): PaymentProviderId | undefined {
  const provider = rail === 'faircoin' ? FAIRCOIN_RAIL : NATIVE_RAIL;
  return isRailConfigured(provider) ? provider : undefined;
}

/** Whether this deployment can take FairCoin for a seller at all. */
export function isFaircoinRailConfigured(): boolean {
  return isRailConfigured(FAIRCOIN_RAIL);
}

/**
 * Every currency a NATIVE checkout can be paid in on this deployment: the card
 * rail's presentment set, plus `FAIR` wherever the FairCoin rail is (ADR 0019).
 * What merchant activation asks of a store's default currency; the card-only
 * set stays {@link nativeRailPresentmentCurrencies}, which fee selection and the
 * card gate read.
 */
export function nativeCheckoutCurrencies(): readonly CurrencyCode[] {
  const card = nativeRailPresentmentCurrencies();
  return isFaircoinRailConfigured() && !card.includes(FAIRCOIN_CURRENCY)
    ? [...card, FAIRCOIN_CURRENCY]
    : card;
}
