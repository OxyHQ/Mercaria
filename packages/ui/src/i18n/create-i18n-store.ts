import AsyncStorage from '@react-native-async-storage/async-storage';
import type { I18n } from 'i18n-js';
import { useCallback } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { resolveDeviceLocale, type Translate } from './create-app-i18n';

export interface I18nStoreState {
  /** The locale in force: the stored preference if there is one, else the device's. */
  locale: string;
  /** Choose a locale explicitly. Persisted, so it outlives the device setting. */
  setLocale: (locale: string) => void;
}

export interface CreateI18nStoreOptions {
  /** The i18n instance the store drives. */
  i18n: I18n;
  /** AsyncStorage key. Distinct per app, or two apps on one device share a preference. */
  persistKey: string;
}

/*
 * There is deliberately no `onLocaleApplied` hook here yet.
 *
 * The storefront mirrors its layout when the locale changes (#397's
 * `syncLayoutDirection`), so converging it onto this factory (#435) needs one.
 * Adding it NOW would ship a parameter no caller passes and no test exercises,
 * which reads as coverage of a mechanism nothing has ever run. It arrives in the
 * change that has a caller for it.
 */

/**
 * One app's locale store and the hook its screens call.
 *
 * The hook is deliberately NOT suspenseful and touches no promise: it reads a
 * zustand slice and calls a synchronous `i18n.t`. A provider that suspended at
 * boot deadlocks an Expo app into a permanent white screen with no error, so the
 * mechanism that avoids it is worth stating rather than rediscovering.
 *
 * The store — rather than a bare module-level `i18n` — is what makes a locale
 * change re-render every screen; `i18n.locale` is still kept in step so any
 * direct reader agrees, but nothing in a render path reads it.
 */
export function createI18nStore({ i18n, persistKey }: CreateI18nStoreOptions) {
  const apply = (locale: string) => {
    i18n.locale = locale;
  };

  const useI18nStore = create<I18nStoreState>()(
    persist(
      (set) => ({
        locale: resolveDeviceLocale(),
        setLocale: (locale: string) => {
          apply(locale);
          set({ locale });
        },
      }),
      {
        name: persistKey,
        storage: createJSONStorage(() => AsyncStorage),
        onRehydrateStorage: () => (state) => {
          if (state?.locale) apply(state.locale);
        },
      },
    ),
  );

  // The device locale is the best answer available before storage has been read.
  // Rehydration is asynchronous, so a stored preference that disagrees corrects a
  // moment later; without this line the first paint would be the i18n instance's
  // constructor locale rather than the store's.
  apply(useI18nStore.getState().locale);

  function useTranslation(): { t: Translate; locale: string; setLocale: (locale: string) => void } {
    const locale = useI18nStore((state) => state.locale);
    const setLocale = useI18nStore((state) => state.setLocale);
    // The locale is passed EXPLICITLY rather than left to `i18n.locale`. Reading
    // it off the instance would be reading external mutable state from inside a
    // render, which the React Compiler is free to memoise around — the screen
    // would then keep rendering the previous language with nothing to blame.
    // Taking it from the store instead makes `t` a pure function of reactive
    // state, so a locale change invalidates every caller by construction.
    const t: Translate = useCallback(
      (key, options) => i18n.t(key, { locale, ...options }),
      [locale],
    );
    return { t, locale, setLocale };
  }

  return { useI18nStore, useTranslation };
}
