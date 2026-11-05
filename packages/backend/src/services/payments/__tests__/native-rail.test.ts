/**
 * Which rail a native checkout funds through.
 *
 * Peable is the only native rail (ADR 0009, D13 executed). The cases below pin
 * the two properties a single-rail world can still get wrong: the rail is a
 * DEPLOYMENT fact (configured or not, nothing in between), and the rails that
 * are configured on dev deployments or that only RECORD money are never mistaken
 * for one — `assertSellerGroupsPaymentReady` failing open on a deployment whose
 * rail it could not see is the defect this module was written to remove.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rails = { peable: false, mock: false };

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
      },
    },
  };
});

const { PAYMENT_PROVIDER_IDS } = await import('@mercaria/shared-types');
const { NATIVE_RAIL, isRailConfigured, nativeRailPresentmentCurrencies, resolveNativeRail } =
  await import('../native-rail.js');

beforeEach(() => {
  rails.peable = false;
  rails.mock = false;
});

describe('the native rail', () => {
  it('is undefined on a deployment that configured none', () => {
    expect(resolveNativeRail()).toBeUndefined();
    expect(nativeRailPresentmentCurrencies()).toEqual([]);
  });

  it('is Peable when Peable is configured', () => {
    rails.peable = true;
    expect(NATIVE_RAIL).toBe('peable');
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
  });

  /**
   * `external` and `manual_pos` are payments Mercaria RECORDS rather than makes.
   * There is nothing to configure, so `false` is the truth rather than a stub —
   * and a deployment can never resolve one of them as the rail it charges on.
   */
  it('never configures or chooses a rail that only records', () => {
    rails.peable = true;
    rails.mock = true;
    for (const provider of ['external', 'manual_pos'] as const) {
      expect(isRailConfigured(provider)).toBe(false);
      expect(resolveNativeRail()).not.toBe(provider);
    }
  });

  /**
   * Every provider answers `isRailConfigured`, so a new provider cannot reach
   * production having answered nothing, and the native rail is a member of the
   * shared tuple the CHECKs render from rather than a string beside it.
   */
  it('is a member of the shared provider tuple, which every rail answers', () => {
    expect(PAYMENT_PROVIDER_IDS).toContain(NATIVE_RAIL);
    for (const provider of PAYMENT_PROVIDER_IDS) {
      expect(typeof isRailConfigured(provider)).toBe('boolean');
    }
  });
});
