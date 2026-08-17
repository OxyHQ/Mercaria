import { createAppI18n, createI18nStore, shippedLocales, syncLayoutDirection } from '@mercaria/ui';
import ar from './locales/ar.json';
import bn from './locales/bn.json';
import ca from './locales/ca.json';
import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import hi from './locales/hi.json';
import ja from './locales/ja.json';
import ptBR from './locales/pt-BR.json';
import ru from './locales/ru.json';
import zhHans from './locales/zh-Hans.json';

/**
 * The storefront's copy.
 *
 * All TWELVE of the registry's locales, `ar` included — this is the app that
 * ships Arabic (#396) and mirrors its layout for it (#397). The dashboard and
 * the POS ship the other eleven and deliberately not `ar` until their own
 * bundles land (#434), which `AppLocaleBundles` being `Partial` is what allows:
 * an app may be ahead of or behind the registry without either of them lying.
 *
 * This file used to build its own `I18n` from a hand-written table of forty
 * region tags, and was the last of the three apps to do so (#435). The table is
 * gone rather than trimmed: every tag in it beyond these twelve was already
 * resolved by `enableFallback`'s own chain (`es-MX` -> `es` -> `en`), so it
 * enumerated behaviour it did not create — which is the shape that eventually
 * omits whichever region nobody thought of and makes the omission look
 * deliberate.
 *
 * ## What converging did NOT change, measured rather than assumed
 *
 * The removed table carried a comment claiming `zh-TW`/`zh-HK` "falls back to
 * the default locale" — i.e. English. It did not: that table registered `zh`,
 * and `zh-TW` -> `zh` is exactly the hop `enableFallback` makes, so Traditional
 * Chinese readers have been served SIMPLIFIED Chinese all along. The registry's
 * `zh` -> `zh-Hans` alias reaches the same place by the same hop, so the
 * convergence moves nobody. A `zh-Hant` bundle is what actually fixes it, and
 * adding one to `SUPPORTED_LOCALES` makes `zh-TW` resolve to it with no alias
 * edit at all.
 */
const bundles = {
  ar,
  bn,
  ca,
  de,
  en,
  es,
  fr,
  hi,
  ja,
  'pt-BR': ptBR,
  ru,
  'zh-Hans': zhHans,
};

const i18n = createAppI18n(bundles);

/** Which locales this app has copy for — what the language picker offers. */
export const STOREFRONT_LOCALES = shippedLocales(bundles);

export const { useTranslation } = createI18nStore({
  i18n,
  // DELIBERATELY the pre-#435 key, not a `mercaria-storefront-i18n` matching the
  // sibling apps' naming. This app is already installed; renaming the key orphans
  // every stored preference in place, and the symptom is a shopper's language
  // silently reverting to their device's on the deploy that "tidied" it. It is
  // already distinct from `mercaria-dashboard-i18n` and `mercaria-pos-i18n`,
  // which is the property that actually matters — three Mercaria apps can sit on
  // one device.
  persistKey: 'i18n-storage',
  // The layout mirrors from LOGICAL utilities (#397/#434), which resolve against
  // the platform's direction — so the direction has to be set, or the utilities
  // mirror nothing. Applied from the store's own funnel rather than an effect:
  // it must be settled before the tree renders, and `I18nManager.isRTL` is
  // external mutable state that must never be read from a memoised position.
  //
  // Unlike the dashboard and the POS this is NOT a no-op: `ar` is in `bundles`,
  // so an Arabic device mirrors here today.
  onLocaleApplied: (locale) => syncLayoutDirection(i18n, locale),
});
