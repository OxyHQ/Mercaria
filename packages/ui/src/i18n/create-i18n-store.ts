import AsyncStorage from '@react-native-async-storage/async-storage';
import type { I18n } from 'i18n-js';
import { useCallback } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { resolveDeviceLocale, type Translate } from './create-app-i18n';
import type { DirectionSyncResult } from './layout-direction';

export interface I18nStoreState {
  /** The locale in force: the stored preference if there is one, else the device's. */
  locale: string;
  /**
   * Native only: the locale that was just applied changed the layout DIRECTION,
   * and React Native applies that on the next launch. Web mirrors live and never
   * sets this.
   *
   * Derived from what `onLocaleApplied` returns, so an app that passes no hook —
   * or one whose hook returns nothing — leaves it permanently `false` rather
   * than claiming a restart nobody owes.
   *
   * NOT persisted: it is a fact about THIS process, and the restart it asks for
   * is what clears it. Persisting a `true` would show the notice forever, on
   * every launch after the one that resolved it.
   */
  directionRestartRequired: boolean;
  /** Choose a locale explicitly. Persisted, so it outlives the device setting. */
  setLocale: (locale: string) => void;
}

export interface CreateI18nStoreOptions {
  /** The i18n instance the store drives. */
  i18n: I18n;
  /** AsyncStorage key. Distinct per app, or two apps on one device share a preference. */
  persistKey: string;
  /**
   * Run whenever a locale TAKES EFFECT — `setLocale`, rehydration, and the
   * module-scope initial apply below. All three, because a hook wired to only
   * the first would leave a stored Arabic preference unmirrored on every launch
   * after the one that chose it.
   *
   * `syncLayoutDirection` (`./layout-direction`) is what this exists for and the
   * shape it takes, which is why the RESULT is now read rather than discarded.
   *
   * It was typed `=> void` when #434 added it, on the ground that a store field
   * nothing reads is "coverage of a mechanism nothing has run". That was correct
   * then and is not now: converging the storefront (#435) brought with it a
   * picker that RENDERS the pending-restart notice, so the fact has a reader.
   * The two sibling apps already pass a function returning a
   * `DirectionSyncResult` and simply had it thrown away, so reading it changes
   * no call site — it stops discarding something that was always there.
   *
   * `| void` is kept so the hook stays a general seam: an app whose hook does
   * something other than mirror still assigns, and gets a permanent `false`.
   *
   * Deliberately NOT an effect in a component: the direction must be settled
   * before the tree using it renders, and `I18nManager.isRTL` is external mutable
   * state, which must never be read from a memoised position.
   */
  onLocaleApplied?: (locale: string) => DirectionSyncResult | void;
}

/**
 * One app's locale store, and the ONE hook its screens call.
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
export function createI18nStore({ i18n, persistKey, onLocaleApplied }: CreateI18nStoreOptions) {
  // The ONE funnel every locale change passes through: `setLocale`,
  // `onRehydrateStorage`, and the module-scope call at the bottom. Hooking it
  // here rather than at those three sites is what stops a fourth one being added
  // later that mirrors the strings and not the layout.
  // Returns whether the platform now owes a RESTART for the direction to show,
  // rather than setting state itself: each of the three funnels below already
  // writes state, and a second write from in here would be an extra render on
  // every locale change plus a second place the flag is decided.
  const apply = (locale: string): boolean => {
    i18n.locale = locale;
    return onLocaleApplied?.(locale)?.kind === 'restart_required';
  };

  const useI18nStore = create<I18nStoreState>()(
    persist(
      (set) => ({
        locale: resolveDeviceLocale(),
        directionRestartRequired: false,
        setLocale: (locale: string) => {
          const directionRestartRequired = apply(locale);
          set({ locale, directionRestartRequired });
        },
      }),
      {
        name: persistKey,
        storage: createJSONStorage(() => AsyncStorage),
        // Only the locale is persisted. `directionRestartRequired` describes the
        // RUNNING process — see the field's own note.
        partialize: (state) => ({ locale: state.locale }),
        onRehydrateStorage: () => (state) => {
          if (!state?.locale) return;
          useI18nStore.setState({ directionRestartRequired: apply(state.locale) });
        },
      },
    ),
  );

  // The device locale is the best answer available before storage has been read.
  // Rehydration is asynchronous, so a stored preference that disagrees corrects a
  // moment later; without this line the first paint would be the i18n instance's
  // constructor locale rather than the store's.
  useI18nStore.setState({ directionRestartRequired: apply(useI18nStore.getState().locale) });

  function useTranslation(): {
    t: Translate;
    locale: string;
    setLocale: (locale: string) => void;
    directionRestartRequired: boolean;
  } {
    const locale = useI18nStore((state) => state.locale);
    const setLocale = useI18nStore((state) => state.setLocale);
    // Subscribed through a selector like the others, NOT read off `getState()`:
    // the notice has to appear on the render caused by the locale change that
    // asked for the restart, and a non-reactive read would leave it invisible
    // until something else happened to re-render the picker.
    const directionRestartRequired = useI18nStore((state) => state.directionRestartRequired);
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
    return { t, locale, setLocale, directionRestartRequired };
  }

  // Only the hook is returned. The store itself is an implementation detail —
  // `useTranslation` already exposes the locale and the setter, which is
  // everything a screen needs, and a second exported handle onto the same state
  // is a way for one to be read outside React while the other is memoised
  // around it. A caller that genuinely needs `getState()` adds it in the change
  // that has one.
  return { useTranslation };
}
