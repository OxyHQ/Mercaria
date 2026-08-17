import { createAppI18n, createI18nStore, syncLayoutDirection } from '@mercaria/ui';
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
 * The POS register's copy.
 *
 * All twelve of the registry's locales. `ar` was deliberately absent until the
 * till mirrored: right-to-left text in a left-to-right till puts the row order
 * one way and the padding, the numeric keypad and the cart totals the other,
 * which is worse than English. #434's layout half landed first, #429 item 4
 * gave `SheetContent` a logical side so the variant picker mirrors with
 * everything else, and this bundle is the last step. `syncLayoutDirection`
 * reads these bundles rather than the language tag, so adding `ar` here is what
 * turns mirroring on.
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

// There is deliberately no `POS_LOCALES` export and no language picker: the
// till follows the device, and the POS has no settings surface to put one on.
// A picker arrives with the screen that hosts it, reading `shippedLocales`
// exactly as the dashboard's does.
export const { useTranslation } = createI18nStore({
  i18n,
  // Distinct from the dashboard's and the storefront's: three Mercaria apps can
  // sit on one device, and a cashier's till language is not the merchant's
  // admin language.
  persistKey: 'mercaria-pos-i18n',
  // The layout mirrors from LOGICAL utilities (#434), which resolve against the
  // platform's direction — so the direction has to be set, or the migration
  // mirrors nothing. Applied from the store's own funnel rather than an effect:
  // it must be settled before the tree renders. The till has no picker, so the
  // locale here only ever comes from the device or from rehydration, which is
  // exactly why the hook has to cover both and not just `setLocale`.
  //
  // `ar` is in `bundles` above as of #434, so this now mirrors for an Arabic
  // locale. The till has no picker, so that direction comes from the device or
  // from rehydration — and on native it takes effect on the NEXT launch, which
  // for a till means the next time the app is opened.
  onLocaleApplied: (locale) => syncLayoutDirection(i18n, locale),
});
