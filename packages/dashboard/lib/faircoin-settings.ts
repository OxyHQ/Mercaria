import type { FaircoinUnavailableReason, SellerPaymentSettings } from '@mercaria/shared-types';

/**
 * What the store's FairCoin card says (ADR 0019 D2/D4) — pure, so it is
 * unit-tested where the screen cannot be.
 *
 * FairCoin is a payment method buyers can always choose; the store receives it
 * into the Peable wallet of the Oxy account that OWNS the store, which confirms
 * that on Peable's own page. There is no key or address to enter anywhere —
 * Peable never holds keys or coins (Peable ADR 0021 D5) — so the only action
 * this card offers is opening that page.
 *
 * KEYS, never sentences: the maps are evaluated at import, before the locale
 * store has rehydrated (#398).
 */

/** The card's four headings: the three stored states, and `active` that cannot be paid right now. */
export type FaircoinCardState = 'not_connected' | 'pending' | 'active' | 'active_unavailable';

const HEADING_KEYS: Record<FaircoinCardState, { headingKey: string; bodyKey: string }> = {
  not_connected: {
    headingKey: 'settings.payments.faircoin.states.notConnected.heading',
    bodyKey: 'settings.payments.faircoin.states.notConnected.body',
  },
  pending: {
    headingKey: 'settings.payments.faircoin.states.pending.heading',
    bodyKey: 'settings.payments.faircoin.states.pending.body',
  },
  active: {
    headingKey: 'settings.payments.faircoin.states.active.heading',
    bodyKey: 'settings.payments.faircoin.states.active.body',
  },
  active_unavailable: {
    headingKey: 'settings.payments.faircoin.states.activeUnavailable.heading',
    bodyKey: 'settings.payments.faircoin.states.activeUnavailable.body',
  },
};

/** Every reason FairCoin cannot be paid, in words (ADR 0019 D4). A Record, so a new reason fails `tsc`. */
const REASON_KEYS: Record<FaircoinUnavailableReason, string> = {
  faircoin_wallet_missing: 'settings.payments.faircoin.reasons.walletMissing',
  faircoin_network_closed: 'settings.payments.faircoin.reasons.networkClosed',
  price_unavailable: 'settings.payments.faircoin.reasons.priceUnavailable',
  temporarily_unavailable: 'settings.payments.faircoin.reasons.temporarilyUnavailable',
  seller_not_connected: 'settings.payments.faircoin.reasons.sellerNotConnected',
  seller_not_confirmed: 'settings.payments.faircoin.reasons.sellerNotConfirmed',
  rail_disabled: 'settings.payments.faircoin.reasons.railDisabled',
};

/** Reasons the heading already says — repeating them under it adds nothing. */
const SAID_BY_THE_HEADING: ReadonlySet<FaircoinUnavailableReason> = new Set([
  'seller_not_connected',
  'seller_not_confirmed',
]);

export const FAIRCOIN_NETWORK_KEYS = {
  mainnet: 'settings.payments.faircoin.network.mainnet',
  testnet: 'settings.payments.faircoin.network.testnet',
} as const;

export interface FaircoinCard {
  readonly state: FaircoinCardState;
  readonly headingKey: string;
  readonly bodyKey: string;
  /** The reason in words, when it says more than the heading. */
  readonly reasonKey: string | null;
  /** Whether "Receive FairCoin in your Peable wallet" is offered. */
  readonly offersSetup: boolean;
}

export function faircoinCard(settings: SellerPaymentSettings): FaircoinCard {
  const { faircoin, onboardingAvailable } = settings;
  const state: FaircoinCardState =
    faircoin.state === 'active'
      ? faircoin.payable
        ? 'active'
        : 'active_unavailable'
      : faircoin.state;
  const reason = faircoin.payable ? undefined : faircoin.unavailableReason;
  return {
    state,
    ...HEADING_KEYS[state],
    reasonKey: reason && !SAID_BY_THE_HEADING.has(reason) ? REASON_KEYS[reason] : null,
    // The server refuses the link on a deployment without the rail or without
    // the gateway's account events, and once the seller has confirmed.
    offersSetup: faircoin.state !== 'active' && onboardingAvailable && reason !== 'rail_disabled',
  };
}
