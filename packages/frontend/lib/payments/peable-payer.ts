/**
 * The pure half of the storefront's Peable card step (ADR 0009 D13).
 *
 * Everything here is a decision that does not need a DOM, a provider frame or
 * React, so it is unit-tested where the component cannot be (`vitest.config.ts`
 * runs `lib/**` only). It imports TYPES from Peable's browser entry and no
 * value at all, which is what lets the native card step use the hosted-page
 * helper without bundling the DOM-only checkout code.
 *
 * Nothing here decides that a payment succeeded. The paid state is Mercaria's
 * payment aggregate, moved only by a verified gateway event and read through
 * `GET /checkout/:checkoutGroupId/payment-status`.
 */

import type {
  CheckoutPaymentHandoff,
  CheckoutPaymentSurfaceMethod,
  GuestPaymentMethodCategory,
} from '@mercaria/shared-types';
import type { Appearance, PeableConfirmError } from '@peable.to/sdk/checkout';

/** What `createPeableElements({ paymentIntent })` and `confirmPayment` take. */
export function peablePaymentIntent(payment: CheckoutPaymentHandoff): {
  id: string;
  client_secret: string;
} {
  return { id: payment.providerPaymentId, client_secret: payment.clientSecret };
}

/**
 * Which wallets the server PERMITS the Express Checkout element to offer.
 *
 * The server names an upper bound and the device narrows it (#107): a wallet
 * the handoff leaves out is `never` whatever the device supports. `link` is not
 * mapped: Peable turns the acquirer's own consumer wallet off on every
 * checkout, so there is nothing for it to permit.
 */
export function permittedWallets(methods: readonly CheckoutPaymentSurfaceMethod[]): {
  applePay: boolean;
  googlePay: boolean;
} {
  return { applePay: methods.includes('apple_pay'), googlePay: methods.includes('google_pay') };
}

/**
 * The Express Checkout element's provider options: Peable's own base
 * configuration with the two wallets narrowed to what the server permits.
 *
 * The base is passed in rather than imported (see this file's docblock), and
 * its `paymentMethods` is spread FIRST: `createPeableElements` merges a
 * caller's options over its base shallowly, so an object that named only the
 * two wallets would silently drop the base's explicit `never`s.
 */
export function expressCheckoutOptions(
  base: Readonly<Record<string, unknown>>,
  methods: readonly CheckoutPaymentSurfaceMethod[],
): Record<string, unknown> {
  const wallets = permittedWallets(methods);
  const basePaymentMethods =
    typeof base.paymentMethods === 'object' && base.paymentMethods !== null
      ? (base.paymentMethods as Record<string, unknown>)
      : {};
  return {
    paymentMethods: {
      ...basePaymentMethods,
      applePay: wallets.applePay ? 'auto' : 'never',
      googlePay: wallets.googlePay ? 'auto' : 'never',
    },
    // ADR 0006 G12: the wallet is PAYMENT-ONLY. The order was snapshotted from
    // the contact and destination checkout validated before this mounted.
    shippingAddressRequired: false,
    billingAddressRequired: false,
    emailRequired: false,
    phoneNumberRequired: false,
  };
}

/**
 * Where a redirect-based confirmation (3-D Secure) returns the buyer: the
 * storefront's return route, which only POLLS the server. The return proves
 * nothing (ADR 0006 G10); the group id authorizes nothing either — the status
 * endpoint scopes its answer to the caller.
 */
export function checkoutReturnUrl(origin: string, checkoutGroupId: string): string {
  const url = new URL('/checkout/return', origin);
  url.searchParams.set('checkoutGroupId', checkoutGroupId);
  return url.toString();
}

/**
 * Peable's hosted pay page for one payment — the native apps' card path.
 *
 * The secret rides in the FRAGMENT, which a browser never sends to a server or
 * a CDN log; that is Peable's own contract for the page (`/i/:intentId`).
 */
export function hostedPayUrl(checkoutOrigin: string, payment: CheckoutPaymentHandoff): string {
  const url = new URL(`/i/${encodeURIComponent(payment.providerPaymentId)}`, checkoutOrigin);
  url.hash = `client_secret=${encodeURIComponent(payment.clientSecret)}`;
  return url.toString();
}

/** A colour as `#rrggbb` — the only colour form Peable's appearance accepts. */
export function toHexColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const value = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const [r, g, b] = value.slice(1);
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  // `rgb(1 2 3)`, `rgb(1, 2, 3)`, `rgba(1, 2, 3, 0.5)`, `rgb(1 2 3 / 50%)`:
  // Bloom resolves its theme to `rgb(...)`. Alpha is dropped — Peable draws
  // the fields on an opaque surface.
  const match = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i.exec(value);
  if (!match) return undefined;
  const channels = match.slice(1, 4).map(Number);
  if (channels.some((channel) => channel > 255)) return undefined;
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** The theme facts the appearance reads, as Bloom's `useTheme()` returns them. */
export interface PayerTheme {
  isDark: boolean;
  colors: { primary: string; background: string; text: string; error: string };
}

/**
 * Peable's appearance from Mercaria's theme, so the card fields read as part
 * of the page. A colour Peable cannot accept is left out (its theme default
 * stands) rather than guessed.
 */
export function peableAppearance(theme: PayerTheme): Appearance {
  const variables: NonNullable<Appearance['variables']> = { borderRadius: '12px' };
  const primary = toHexColor(theme.colors.primary);
  const background = toHexColor(theme.colors.background);
  const text = toHexColor(theme.colors.text);
  const danger = toHexColor(theme.colors.error);
  if (primary) variables.colorPrimary = primary;
  if (background) variables.colorBackground = background;
  if (text) variables.colorText = text;
  if (danger) variables.colorDanger = danger;
  return { theme: theme.isDark ? 'night' : 'peable', variables };
}

/**
 * The provider locale for one of the storefront's locales. The registry's
 * `zh-Hans` is the provider's `zh`; every other shipped tag is passed as is,
 * and one the provider does not know falls back to its own detection.
 */
export function peableLocale(locale: string): string {
  return locale === 'zh-Hans' ? 'zh' : locale;
}

/**
 * Whether a confirmation error's own message may be shown.
 *
 * A card or validation error is the acquirer's sentence about the fields,
 * localized by the provider to the locale the fields were mounted with. Every
 * other kind is Peable's English prose about its own state, which the step
 * replaces with Mercaria's translated sentence.
 */
export function showsProviderMessage(error: PeableConfirmError): boolean {
  return error.type === 'card_error' || error.type === 'validation_error';
}

/**
 * The BOUNDED analytics category for a wallet the Express Checkout element
 * reports (`expressPaymentType`). The provider's own string is never sent; an
 * unrecognised one becomes `other` so the denominators stay whole.
 */
export function walletMethodCategory(expressPaymentType: unknown): GuestPaymentMethodCategory {
  switch (expressPaymentType) {
    case 'apple_pay':
      return 'wallet_apple_pay';
    case 'google_pay':
      return 'wallet_google_pay';
    default:
      return 'other';
  }
}
