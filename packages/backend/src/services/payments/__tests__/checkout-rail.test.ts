/**
 * Which rail a checkout funds through, and what the client is told about it.
 *
 * `CheckoutRail` was `'stripe' | 'none'` and `resolveCheckoutRail` read
 * `config.payments.stripe.enabled` directly, so on a Peable-only deployment it
 * answered `'none'` — orders placed, no payment opened, and nothing anywhere
 * saying why. The rail is now resolved (ADR 0009 D19) and the type names the
 * SURFACE rather than the acquirer.
 *
 * The two `STRIPE_`-named variables that are read on EVERY rail are pinned here
 * too. They are misnamed rather than misused — which wallets to render and
 * where a buyer lands after authentication are checkout facts, not acquirer
 * facts — and gating them on the resolved rail would leave a Peable deployment
 * with no configured surfaces and no return url. The rename is a task-definition
 * change this repository cannot make, so the behaviour is pinned instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rails = { peable: false, stripe: false, mock: false };
const surfaces = ['card', 'apple_pay', 'google_pay'] as const;

vi.mock('../../../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config/index.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      orders: {
        ...actual.config.orders,
        get mockPayEnabled() {
          return rails.mock;
        },
      },
      payments: {
        ...actual.config.payments,
        peable: {
          ...actual.config.payments.peable,
          presentmentCurrencies: ['EUR', 'GBP'],
          get enabled() {
            return rails.peable;
          },
        },
        stripe: {
          ...actual.config.payments.stripe,
          presentmentCurrencies: ['EUR', 'USD'],
          paymentSurfaceMethods: surfaces,
          get enabled() {
            return rails.stripe;
          },
        },
      },
    },
  };
});

const {
  assertCheckoutCurrencyEligible,
  checkoutPaymentSurfaces,
  resolveCheckoutRail,
} = await import('../checkout-payment.service.js');

beforeEach(() => {
  rails.peable = false;
  rails.stripe = false;
  rails.mock = false;
});

describe('resolveCheckoutRail', () => {
  it('defaults to the card rail whenever the deployment has one', () => {
    rails.stripe = true;
    expect(resolveCheckoutRail(undefined)).toBe('card');

    rails.stripe = false;
    rails.peable = true;
    expect(resolveCheckoutRail(undefined)).toBe('card');
  });

  it('defaults to none when the deployment has no rail', () => {
    expect(resolveCheckoutRail(undefined)).toBe('none');
  });

  /**
   * THE regression. `'stripe'` is what every shipped client sends, and a
   * Peable-only deployment must not refuse them — that is the exact moment the
   * vocabulary changed, and refusing there would break checkout for every
   * client written before this PR.
   */
  it('serves a client that still asks for `stripe` on the Peable rail', () => {
    rails.peable = true;
    expect(resolveCheckoutRail('stripe')).toBe('card');
    expect(resolveCheckoutRail('card')).toBe('card');
  });

  /** Naming an unavailable rail is refused, never downgraded to a silent 201. */
  it('refuses a card request on a deployment with no rail', () => {
    expect(() => resolveCheckoutRail('card')).toThrow(/not available/);
    expect(() => resolveCheckoutRail('stripe')).toThrow(/not available/);
  });

  /**
   * The dev seam does not open a payment at checkout, so it behaves exactly
   * like a deployment with no rail — and enabling it must not make the default
   * request start opening card payments.
   */
  it('treats the mock seam as no rail at checkout time', () => {
    rails.mock = true;
    expect(resolveCheckoutRail('mock')).toBe('none');
    expect(resolveCheckoutRail(undefined)).toBe('none');
  });
});

describe('assertCheckoutCurrencyEligible', () => {
  it('reads the RESOLVED rail’s set, not Stripe’s', () => {
    // GBP is eligible on Peable and not on Stripe; USD is the reverse. Either
    // rail reading the other's list would pass one of these and fail the other,
    // which is what makes this pair the check rather than either alone.
    rails.peable = true;
    expect(() => assertCheckoutCurrencyEligible('card', 'GBP')).not.toThrow();
    expect(() => assertCheckoutCurrencyEligible('card', 'USD')).toThrow(/not available in USD/);

    rails.peable = false;
    rails.stripe = true;
    expect(() => assertCheckoutCurrencyEligible('card', 'USD')).not.toThrow();
    expect(() => assertCheckoutCurrencyEligible('card', 'GBP')).toThrow(/not available in GBP/);
  });

  it('checks nothing on a checkout with no rail', () => {
    expect(() => assertCheckoutCurrencyEligible('none', 'JPY')).not.toThrow();
  });
});

describe('the two STRIPE_-named variables read on every rail', () => {
  /**
   * Pinned so a later change does not "tidy" these into a Stripe-only read.
   * Doing so would hand a Peable deployment an empty `methods` array — and the
   * handoff contract says that array is never empty, because a handoff with
   * nothing to render is a checkout that cannot be paid.
   */
  it('names the same payment surfaces on the Peable rail as on Stripe', () => {
    rails.stripe = true;
    const onStripe = checkoutPaymentSurfaces();

    rails.stripe = false;
    rails.peable = true;
    expect(checkoutPaymentSurfaces()).toEqual(onStripe);
    expect(checkoutPaymentSurfaces().length).toBeGreaterThan(0);
  });
});
