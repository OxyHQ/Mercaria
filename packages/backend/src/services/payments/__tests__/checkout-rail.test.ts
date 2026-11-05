/**
 * Which rail a checkout funds through, and what the client is told about it.
 *
 * The rail is resolved (ADR 0009 D19) and the type names the SURFACE rather than
 * the acquirer, so a client asks for `card` and the deployment decides what is
 * behind it. The payment surfaces a client may render are a checkout fact
 * (`CHECKOUT_PAYMENT_SURFACE_METHODS`), pinned here as never empty on a
 * deployment that can take a card.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rails = { peable: false, mock: false };
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
        paymentSurfaceMethods: surfaces,
        peable: {
          ...actual.config.payments.peable,
          presentmentCurrencies: ['EUR', 'GBP'],
          get enabled() {
            return rails.peable;
          },
        },
      },
    },
  };
});

const { assertCheckoutCurrencyEligible, checkoutPaymentSurfaces, resolveCheckoutRail } =
  await import('../checkout-payment.service.js');

beforeEach(() => {
  rails.peable = false;
  rails.mock = false;
});

describe('resolveCheckoutRail', () => {
  it('defaults to the card rail whenever the deployment has one', () => {
    rails.peable = true;
    expect(resolveCheckoutRail(undefined)).toBe('card');
    expect(resolveCheckoutRail('card')).toBe('card');
  });

  it('defaults to none when the deployment has no rail', () => {
    expect(resolveCheckoutRail(undefined)).toBe('none');
  });

  /** Naming an unavailable rail is refused, never downgraded to a silent 201. */
  it('refuses a card request on a deployment with no rail', () => {
    expect(() => resolveCheckoutRail('card')).toThrow(/not available/);
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
  it('reads the configured rail’s presentment set', () => {
    rails.peable = true;
    expect(() => assertCheckoutCurrencyEligible('card', 'GBP')).not.toThrow();
    expect(() => assertCheckoutCurrencyEligible('card', 'USD')).toThrow(/not available in USD/);
  });

  it('checks nothing on a checkout with no rail', () => {
    expect(() => assertCheckoutCurrencyEligible('none', 'JPY')).not.toThrow();
  });
});

describe('checkoutPaymentSurfaces', () => {
  /**
   * The handoff contract says `methods` is never empty, because a handoff with
   * nothing to render is a checkout that cannot be paid.
   */
  it('names the configured surfaces, and never none', () => {
    rails.peable = true;
    expect(checkoutPaymentSurfaces()).toEqual(surfaces);
    expect(checkoutPaymentSurfaces().length).toBeGreaterThan(0);
  });
});
