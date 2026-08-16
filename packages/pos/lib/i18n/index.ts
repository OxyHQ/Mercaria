import { createAppI18n, createI18nStore, shippedLocales } from '@mercaria/ui';
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
 * Eleven of the registry's twelve locales. `ar` is deliberately ABSENT: the
 * storefront mirrors its layout for Arabic (#397) and this app does not, so
 * shipping Arabic copy here would put right-to-left text into a left-to-right
 * till — the row order one way, the padding, the numeric keypad and the cart
 * totals the other. That is worse than English, which at least reads
 * consistently. Adding `ar.json` is the LAST step of mirroring the layout
 * (#434), not a separate favour.
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

/** Which locales this app has copy for — what a language picker may offer. */
export const POS_LOCALES = shippedLocales(bundles);

export const { useI18nStore, useTranslation } = createI18nStore({
  i18n,
  // Distinct from the dashboard's and the storefront's: three Mercaria apps can
  // sit on one device, and a cashier's till language is not the merchant's
  // admin language.
  persistKey: 'mercaria-pos-i18n',
});
