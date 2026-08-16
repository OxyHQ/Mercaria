import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import i18n from '@/lib/i18n';
import { syncLayoutDirection } from '@/lib/i18n/rtl';

function getDeviceLocale(): string {
  const locales = getLocales();
  if (!locales || locales.length === 0) return 'en-US';
  return locales[0]?.languageTag || locales[0]?.languageCode || 'en-US';
}

interface I18nState {
  locale: string;
  /**
   * Native only: the locale changed the layout direction, and React Native
   * applies that on the next launch. Web mirrors live and never sets this.
   */
  directionRestartRequired: boolean;
  setLocale: (locale: string) => void;
}

/**
 * Layout direction is applied from the two places the locale actually changes —
 * `setLocale` and rehydration — rather than from an effect in a component.
 *
 * An effect would be the wrong shape twice over: the direction has to be settled
 * before the tree using it renders, and `I18nManager.isRTL` is external mutable
 * state, which is exactly what must never be read from a memoized position.
 *
 * The initial value is applied at module scope below, so the very first paint on
 * web is already mirrored for an Arabic device. Rehydration is asynchronous, so a
 * stored locale that disagrees with the device corrects a moment later; on web
 * that is a re-paint, and on native `I18nManager.isRTL` already carries the
 * direction forced on the previous launch, so the correction is a no-op from the
 * second launch onward.
 */
export const useI18nStore = create<I18nState>()(
  persist(
    (set) => ({
      locale: getDeviceLocale(),
      directionRestartRequired: false,
      setLocale: (locale: string) => {
        i18n.locale = locale;
        const direction = syncLayoutDirection(locale);
        set({ locale, directionRestartRequired: direction.kind === 'restart_required' });
      },
    }),
    {
      name: 'i18n-storage',
      storage: createJSONStorage(() => AsyncStorage),
      // `directionRestartRequired` is a fact about THIS process — the restart it
      // asks for is what clears it. Persisting it would show the notice forever
      // on every launch after the one that resolved it.
      partialize: (state) => ({ locale: state.locale }),
      onRehydrateStorage: () => (state) => {
        if (state?.locale) {
          i18n.locale = state.locale;
          const direction = syncLayoutDirection(state.locale);
          useI18nStore.setState({
            directionRestartRequired: direction.kind === 'restart_required',
          });
        }
      },
    }
  )
);

// The device locale is the best answer available before storage has been read,
// and on web it is what makes the first paint mirror correctly rather than
// flipping after hydration.
syncLayoutDirection(useI18nStore.getState().locale);
