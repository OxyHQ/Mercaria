/**
 * Which rail a native checkout funds through.
 *
 * The predecessor of this module was a constant pinned in the type
 * (`NATIVE_RAIL: Extract<PaymentProviderId, 'stripe'>`), and three separate
 * places read `config.payments.stripe.enabled` as a proxy for "does this
 * deployment have a native rail". Two of them then failed CLOSED on a
 * Peable-only deployment and one — `assertSellerGroupsPaymentReady` — failed
 * OPEN. So the cases below are about the disagreement, not about the lookup.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rails = { peable: false, stripe: false, mock: false };

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
          get enabled() {
            return rails.peable;
          },
        },
        stripe: {
          ...actual.config.payments.stripe,
          get enabled() {
            return rails.stripe;
          },
        },
      },
    },
  };
});

const { PAYMENT_PROVIDER_IDS } = await import('@mercaria/shared-types');
const { NATIVE_RAIL_PREFERENCE, isRailConfigured, resolveNativeRail } = await import(
  '../native-rail.js'
);

beforeEach(() => {
  rails.peable = false;
  rails.stripe = false;
  rails.mock = false;
});

describe('the native rail', () => {
  it('is undefined on a deployment that configured none', () => {
    expect(resolveNativeRail()).toBeUndefined();
  });

  it('is the one rail a single-rail deployment configured', () => {
    rails.stripe = true;
    expect(resolveNativeRail()).toBe('stripe');

    rails.stripe = false;
    rails.peable = true;
    expect(resolveNativeRail()).toBe('peable');
  });

  /**
   * The preference, which is a decision rather than an accident of ordering: a
   * deployment with both configured is mid-migration, and a checkout opening
   * today should open on the rail the migration is heading to (ADR 0009). It
   * also makes `PEABLE_ENABLED=false` the complete rollback, with no second
   * switch to remember.
   */
  it('prefers Peable when a mid-migration deployment has both', () => {
    rails.peable = true;
    rails.stripe = true;
    expect(resolveNativeRail()).toBe('peable');
  });

  /**
   * The dev seam is configured on dev deployments and is deliberately NOT
   * native: `POST /orders/:id/mock-pay` funds a group from its own endpoint
   * AFTER checkout, so a mock deployment must behave like one with no rail.
   * Without this, enabling `mockPay` would silently start gating seller
   * readiness — and every seller would read as unready against a rail that
   * issues no accounts.
   */
  it('is never the mock seam, however configured that is', () => {
    rails.mock = true;
    expect(isRailConfigured('mock')).toBe(true);
    expect(resolveNativeRail()).toBeUndefined();
    expect(NATIVE_RAIL_PREFERENCE).not.toContain('mock');
  });

  /**
   * `external` and `manual_pos` are payments Mercaria RECORDS rather than makes.
   * There is nothing to configure, so `false` is the truth rather than a stub —
   * and a deployment can never resolve one of them as the rail it charges on.
   */
  it('never configures or chooses a rail that only records', () => {
    rails.peable = true;
    rails.stripe = true;
    rails.mock = true;
    for (const provider of ['external', 'manual_pos'] as const) {
      expect(isRailConfigured(provider)).toBe(false);
      expect(NATIVE_RAIL_PREFERENCE).not.toContain(provider);
    }
  });

  /**
   * Vacuity floor, and the one that matters most here.
   *
   * `resolveNativeRail` is a `.find` over a DERIVED list. If that list were ever
   * empty — a filter that stopped matching, a rank table that lost its
   * entries — every call would answer `undefined`, every readiness gate would
   * return early, and a checkout would admit every seller while reporting
   * nothing wrong. That is precisely the fail-open this module was written to
   * remove, so the list is asserted non-empty and against the shared tuple
   * rather than against a copy of itself.
   */
  it('derives a non-empty preference from the shared provider tuple', () => {
    expect(NATIVE_RAIL_PREFERENCE.length).toBeGreaterThan(0);
    for (const provider of NATIVE_RAIL_PREFERENCE) {
      expect(PAYMENT_PROVIDER_IDS).toContain(provider);
    }
    // Every configurable rail answers `isRailConfigured`, so a sixth provider
    // cannot reach production having answered neither question.
    for (const provider of PAYMENT_PROVIDER_IDS) {
      expect(typeof isRailConfigured(provider)).toBe('boolean');
    }
  });
});
