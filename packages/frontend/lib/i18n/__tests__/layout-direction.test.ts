import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18n } from 'i18n-js';

// Model the native boundary only: isRTL is frozen for this process, while
// forceRTL persists a preference for the next launch. This is not a render test.
const native = vi.hoisted(() => ({
  isRTL: false,
  nextLaunchRTL: false,
  allowRTL: vi.fn(),
  forceRTL: vi.fn((rtl: boolean) => {
    native.nextLaunchRTL = rtl;
  }),
}));
vi.mock('react-native', () => ({ I18nManager: native, Platform: { OS: 'android' } }));

import { syncLayoutDirection } from '../../../../ui/src/i18n/layout-direction';

const i18n = new I18n({ en: {}, ar: {} });

beforeEach(() => {
  native.isRTL = false;
  native.nextLaunchRTL = false;
  vi.clearAllMocks();
});

describe('native locale direction persistence', () => {
  it('retains a saved Arabic preference after the provisional English device locale', () => {
    native.isRTL = true;
    native.nextLaunchRTL = true;
    expect(syncLayoutDirection(i18n, 'en').kind).toBe('restart_required');
    expect(syncLayoutDirection(i18n, 'ar').kind).toBe('applied');
    expect(native.nextLaunchRTL).toBe(true);
  });

  it('retains a saved English preference after the provisional Arabic device locale', () => {
    expect(syncLayoutDirection(i18n, 'ar').kind).toBe('restart_required');
    expect(syncLayoutDirection(i18n, 'en').kind).toBe('applied');
    expect(native.nextLaunchRTL).toBe(false);
  });

  it('cancels a requested direction change when the user switches back before restarting', () => {
    syncLayoutDirection(i18n, 'ar');
    syncLayoutDirection(i18n, 'en');
    expect(native.nextLaunchRTL).toBe(false);
    expect(native.isRTL).toBe(false);
  });

  it('reports the outstanding restart without pretending the running layout changed', () => {
    expect(syncLayoutDirection(i18n, 'ar')).toEqual({ kind: 'restart_required', rtl: true });
    expect(native.nextLaunchRTL).toBe(true);
    expect(native.isRTL).toBe(false);
  });
});
