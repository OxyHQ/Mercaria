import { describe, expect, it } from 'vitest';
import type { CheckoutPaymentHandoff } from '@mercaria/shared-types';
import {
  checkoutReturnUrl,
  expressCheckoutOptions,
  hostedPayUrl,
  peableAppearance,
  peableLocale,
  peablePaymentIntent,
  permittedWallets,
  showsProviderMessage,
  toHexColor,
  walletMethodCategory,
} from '../peable-payer';

const HANDOFF: CheckoutPaymentHandoff = {
  paymentId: 'payment-1',
  provider: 'peable',
  providerPaymentId: 'pi_0193b8f2c1a87d3e9f4a',
  clientSecret: 'pi_0193b8f2c1a87d3e9f4a_secret_3c9f2a',
  amount: { amount: 4_500, currency: 'EUR' },
  methods: ['card', 'apple_pay', 'google_pay', 'link'],
};

describe('the payer material', () => {
  it('is the gateway PaymentIntent and its own secret, as the payer SDK takes them', () => {
    expect(peablePaymentIntent(HANDOFF)).toEqual({
      id: 'pi_0193b8f2c1a87d3e9f4a',
      client_secret: 'pi_0193b8f2c1a87d3e9f4a_secret_3c9f2a',
    });
  });
});

describe('the wallets the server permits', () => {
  it('maps the two card wallets and ignores link', () => {
    expect(permittedWallets(['card', 'link'])).toEqual({ applePay: false, googlePay: false });
    expect(permittedWallets(['card', 'google_pay'])).toEqual({ applePay: false, googlePay: true });
  });

  it('narrows the base configuration without dropping its explicit nevers', () => {
    const base = {
      paymentMethods: { applePay: 'auto', googlePay: 'auto', link: 'never', paypal: 'never' },
    };
    const options = expressCheckoutOptions(base, ['card', 'apple_pay']);
    expect(options.paymentMethods).toEqual({
      applePay: 'auto',
      googlePay: 'never',
      link: 'never',
      paypal: 'never',
    });
    // ADR 0006 G12: payment only — the order already holds the destination.
    expect(options).toMatchObject({
      shippingAddressRequired: false,
      billingAddressRequired: false,
      emailRequired: false,
      phoneNumberRequired: false,
    });
  });
});

describe('the URLs', () => {
  it('returns a 3-D Secure redirect to the polling route with the group only', () => {
    expect(checkoutReturnUrl('https://mercaria.co', 'group-1')).toBe(
      'https://mercaria.co/checkout/return?checkoutGroupId=group-1',
    );
  });

  it('puts the hosted page secret in the fragment, never the query', () => {
    const url = new URL(hostedPayUrl('https://checkout.peable.to', HANDOFF));
    expect(url.origin + url.pathname).toBe('https://checkout.peable.to/i/pi_0193b8f2c1a87d3e9f4a');
    expect(url.search).toBe('');
    expect(new URLSearchParams(url.hash.slice(1)).get('client_secret')).toBe(HANDOFF.clientSecret);
  });
});

describe('the appearance', () => {
  it('converts Bloom rgb() colours to the hex Peable accepts', () => {
    expect(toHexColor('rgb(16 185 129)')).toBe('#10b981');
    expect(toHexColor('rgba(239, 68, 68, 0.5)')).toBe('#ef4444');
    expect(toHexColor('#ABC')).toBe('#aabbcc');
    expect(toHexColor('#0A7CFF')).toBe('#0a7cff');
    expect(toHexColor('var(--primary)')).toBeUndefined();
    expect(toHexColor('rgb(300 0 0)')).toBeUndefined();
  });

  it('follows the colour scheme and leaves out what it cannot express', () => {
    expect(
      peableAppearance({
        isDark: true,
        colors: {
          primary: 'rgb(10 124 255)',
          background: 'var(--background)',
          text: '#ffffff',
          error: 'rgb(239 68 68)',
        },
      }),
    ).toEqual({
      theme: 'night',
      variables: {
        borderRadius: '12px',
        colorPrimary: '#0a7cff',
        colorText: '#ffffff',
        colorDanger: '#ef4444',
      },
    });
  });

  it('names the provider locale for the registry tag that differs', () => {
    expect(peableLocale('zh-Hans')).toBe('zh');
    expect(peableLocale('pt-BR')).toBe('pt-BR');
  });
});

describe('the errors and analytics', () => {
  it('shows only the acquirer field messages, never Peable prose', () => {
    expect(showsProviderMessage({ type: 'card_error', message: 'x' })).toBe(true);
    expect(showsProviderMessage({ type: 'validation_error', message: 'x' })).toBe(true);
    expect(showsProviderMessage({ type: 'payment_failed', message: 'x' })).toBe(false);
    expect(showsProviderMessage({ type: 'unavailable', message: 'x' })).toBe(false);
  });

  it('bounds the wallet category', () => {
    expect(walletMethodCategory('apple_pay')).toBe('wallet_apple_pay');
    expect(walletMethodCategory('google_pay')).toBe('wallet_google_pay');
    expect(walletMethodCategory('link')).toBe('other');
    expect(walletMethodCategory(undefined)).toBe('other');
  });
});
