import { createAppI18n, createI18nStore, shippedLocales, syncLayoutDirection } from '@mercaria/ui';
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
 * The merchant dashboard's copy.
 *
 * Eleven of the registry's twelve locales. `ar` is deliberately ABSENT for the
 * same reason as in the POS: the storefront mirrors its layout for Arabic (#397)
 * and this app does not, so Arabic copy here would half-mirror every screen —
 * the row order one way and the padding, the table columns and the sidebar the
 * other. Adding `ar.json` is the last step of mirroring the layout (#434).
 */
const bundles = {
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
export const DASHBOARD_LOCALES = shippedLocales(bundles);

export const { useTranslation } = createI18nStore({
  i18n,
  persistKey: 'mercaria-dashboard-i18n',
  // The layout mirrors from LOGICAL utilities (#434), which resolve against the
  // platform's direction — so the direction has to be set, or the migration
  // mirrors nothing. Applied from the store's own funnel rather than an effect:
  // it must be settled before the tree renders.
  //
  // `ar` is absent from `bundles` above, and `syncLayoutDirection` reads the
  // bundles rather than the tag, so this is a no-op today by construction — an
  // Arabic device gets English copy in an unmirrored layout, which is coherent,
  // instead of English copy in a mirrored one, which is not. It starts mirroring
  // on the commit that adds `ar.json`, with no edit here.
  onLocaleApplied: (locale) => syncLayoutDirection(i18n, locale),
});
