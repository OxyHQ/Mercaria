/**
 * The payment rails, guest commerce, Mercaria Retail and paid digital checkout
 * have NO `*_ENABLED` switch: each is on exactly when the deployment holds what
 * it cannot work without. These cases pin each derivation from the environment
 * through the frozen config, both directions, so a reintroduced boolean or a
 * dropped prerequisite fails here rather than in production.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function read(env: Record<string, string>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return (await import('../index.js')).config;
}

const STRIPE = {
  STRIPE_SECRET_KEY: 'sk_test_fixture',
  STRIPE_WEBHOOK_SECRET: 'whsec_platform_fixture',
  STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect_fixture',
};

describe('the Stripe rail', () => {
  it('is on with the secret key and both webhook secrets', async () => {
    expect((await read(STRIPE)).payments.stripe.enabled).toBe(true);
  });

  for (const name of Object.keys(STRIPE))
    it(`is off without ${name}`, async () => {
      expect((await read({ ...STRIPE, [name]: '' })).payments.stripe.enabled).toBe(false);
    });

  it('is off with nothing configured', async () => {
    expect(
      (
        await read({
          STRIPE_SECRET_KEY: '',
          STRIPE_WEBHOOK_SECRET: '',
          STRIPE_CONNECT_WEBHOOK_SECRET: '',
        })
      ).payments.stripe.enabled,
    ).toBe(false);
  });
});

describe('the Peable rail', () => {
  const identity = {
    OXY_APPLICATION_KEY: 'fixture-public',
    OXY_APPLICATION_SECRET: 'fixture-secret',
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '',
    AWS_CONTAINER_CREDENTIALS_FULL_URI: '',
  };

  it('is on with the webhook secret and an Oxy identity, with no base URL configured', async () => {
    const config = await read({
      ...identity,
      PEABLE_WEBHOOK_SECRET: 'whsec_peable',
      PEABLE_BASE_URL: '',
    });
    expect(config.payments.peable.enabled).toBe(true);
    expect(config.payments.peable.baseUrl).toBe('https://api.peable.to');
  });

  it('is off without the webhook secret', async () => {
    expect((await read({ ...identity, PEABLE_WEBHOOK_SECRET: '' })).payments.peable.enabled).toBe(
      false,
    );
  });

  it('is off without an Oxy identity to authenticate with', async () => {
    const config = await read({
      ...identity,
      OXY_APPLICATION_KEY: '',
      OXY_APPLICATION_SECRET: '',
      PEABLE_WEBHOOK_SECRET: 'whsec_peable',
    });
    expect(config.payments.peable.enabled).toBe(false);
  });
});

describe('guest commerce', () => {
  const keys = { GUEST_PII_ENCRYPTION_KEY: 'a'.repeat(64), GUEST_EMAIL_HASH_KEY: 'b'.repeat(64) };

  it('is on when both M8 keys resolve', async () => {
    expect((await read(keys)).guest.enabled).toBe(true);
  });

  for (const name of Object.keys(keys))
    it(`is off without ${name}`, async () => {
      expect((await read({ ...keys, [name]: '' })).guest.enabled).toBe(false);
    });
});

describe('Mercaria Retail checkout entry', () => {
  const prerequisites = {
    SUPPLIER_PREFLIGHT_ENABLED: 'true',
    SUPPLIER_PREFLIGHT_FINGERPRINT_KEY: 'fixture-fingerprint-key',
    RETAIL_OPERATOR_OXY_USER_IDS: 'retail-operator',
    MERCARIA_RETAIL_SELLER_LEGAL_ENTITY: 'Mercaria Fixture S.L.',
    MERCARIA_RETAIL_SELLER_COUNTRY: 'es',
  };

  it('is on when every prerequisite holds', async () => {
    const config = await read(prerequisites);
    expect(config.retail.enabled).toBe(true);
    expect(config.retail.sellerLegalEntityCountry).toBe('ES');
  });

  for (const name of Object.keys(prerequisites))
    it(`is off without ${name}`, async () => {
      expect((await read({ ...prerequisites, [name]: '' })).retail.enabled).toBe(false);
    });

  it('is off for a seller country that is not two letters', async () => {
    expect(
      (await read({ ...prerequisites, MERCARIA_RETAIL_SELLER_COUNTRY: 'Spain' })).retail.enabled,
    ).toBe(false);
  });
});

describe('paid digital checkout', () => {
  it('has no lever of its own: the enabled verticals are the whole gate', async () => {
    const config = await read({ DIGITAL_ENABLED_VERTICALS: 'three_d' });
    expect(config.digital.enabledVerticals).toEqual(['three_d']);
    expect(config.digital).not.toHaveProperty('paidCheckoutEnabled');
  });

  async function paidDigitalCheckout(verticals: string) {
    await read({ DIGITAL_ENABLED_VERTICALS: verticals });
    const { assertDigitalCheckoutCoherent } = await import(
      '../../services/checkout/digital-lines.js'
    );
    return () =>
      assertDigitalCheckoutCoherent({
        fulfilment: { kind: 'digital' },
        variantIds: ['variant-1'],
        digitalByVariant: new Map([
          [
            'variant-1',
            {
              variantId: 'variant-1',
              assetId: 'asset-1',
              packageId: 'package-1',
              assetVersionId: 'version-1',
              licenceVersionId: 'licence-1',
              updatePolicy: 'purchased_version_only',
              vertical: 'three_d',
            },
          ],
        ]),
        consent: true,
        chargesMoney: true,
      });
  }

  it('refuses a paid digital line while no vertical is enabled', async () => {
    expect(await paidDigitalCheckout('')).toThrow(/not on sale/);
  });

  it('accepts a paid digital line in an enabled vertical', async () => {
    expect(await paidDigitalCheckout('three_d')).not.toThrow();
  });
});
