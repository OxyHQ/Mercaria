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
 * The merchant dashboard's copy.
 *
 * All twelve of the registry's locales. `ar` was deliberately absent until the
 * layout mirrored: Arabic copy in a left-to-right layout half-mirrors every
 * screen — the row order one way and the padding, the table columns and the
 * sidebar the other — which is worse than English. #434's layout half landed
 * first (logical utilities plus the direction bootstrap below), and this bundle
 * is the second half. `syncLayoutDirection` reads these bundles rather than the
 * language tag, so adding `ar` here is what turns mirroring on.
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
export const DASHBOARD_LOCALES = shippedLocales(bundles);

export const { useTranslation } = createI18nStore({
  i18n,
  persistKey: 'mercaria-dashboard-i18n',
  // The layout mirrors from LOGICAL utilities (#434), which resolve against the
  // platform's direction — so the direction has to be set, or the migration
  // mirrors nothing. Applied from the store's own funnel rather than an effect:
  // it must be settled before the tree renders.
  //
  // `ar` is in `bundles` above as of #434, so this now mirrors for an Arabic
  // locale. On native the direction takes effect on the NEXT launch, which is
  // what `settings.language.description` and the storefront's restart notice
  // exist to say.
  onLocaleApplied: (locale) => syncLayoutDirection(i18n, locale),
});
