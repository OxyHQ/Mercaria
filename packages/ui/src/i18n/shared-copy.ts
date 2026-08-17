/**
 * `@mercaria/ui`'s OWN reader-facing copy, in every locale the registry names
 * (#437).
 *
 * ## The decision this file records
 *
 * The shared package holds sentence maps for domains whose KEYS live in
 * `@mercaria/shared-types` — the condition taxonomy, the comparison labels,
 * pickup, price signals, referrals. That split is right and is not being
 * undone: a stored key is what a column, a CHECK and a wire contract carry, a
 * sentence is what a person reads, and only one of the two may change without a
 * contract change. What was never decided is where those sentences live once
 * they have to exist in twelve languages, and the answer is HERE rather than in
 * each app's bundle.
 *
 * The alternative — the maps hold keys and each app carries the copy — is the
 * `NavItem.labelKey` pattern one layer up, and it is wrong for this package
 * specifically: the same twelve translations of "Used — like new" would be
 * copied into three bundles that nothing keeps in step, and the drift is
 * INVISIBLE, because each app's parity check passes independently against its
 * own `en.json`. One shared sentence, translated once, cannot drift from
 * itself.
 *
 * The other alternative — the components take their strings as props — moves
 * the exhaustive-`Record` property out of this package's typecheck and into
 * every caller, and that property is the whole reason the maps exist.
 *
 * ## Why this is TOTAL over `SUPPORTED_LOCALES` and an app's bundles are not
 *
 * `AppLocaleBundles` is `Partial` on purpose: an app is allowed to be ahead of
 * or behind the registry (the dashboard and the POS ship eleven locales and
 * deliberately not `ar`, which waits on their layout mirroring — #434). This
 * map is NOT partial, so a locale in the registry with no shared copy is a
 * COMPILE error rather than a screen that renders English inside an otherwise
 * Spanish page.
 *
 * That asymmetry is what makes the merge safe in both directions:
 *
 *   * an app can never ask for shared copy in a locale this package lacks,
 *     because there is no such locale; and
 *   * this package shipping `ar` can never give the dashboard an Arabic
 *     locale, because `createAppI18n` registers the INTERSECTION — the shared
 *     copy rides along with the locales the APP ships and no others. An Arabic
 *     device on the dashboard still resolves `ar` → unregistered → `en` and
 *     gets a whole English screen in a left-to-right layout, which is the
 *     state #434 chose deliberately.
 */

import type { SupportedLocale } from "./locales";
import ar from "./locales/ar.json";
import bn from "./locales/bn.json";
import ca from "./locales/ca.json";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import hi from "./locales/hi.json";
import ja from "./locales/ja.json";
import ptBR from "./locales/pt-BR.json";
import ru from "./locales/ru.json";
import zhHans from "./locales/zh-Hans.json";

/**
 * The one top-level key every bundle in this directory has, and the one key an
 * app's own bundle may NOT have.
 *
 * A reserved namespace rather than a flat merge: an app naming a key `condition`
 * is not doing anything wrong, and a merge where the last spread wins would let
 * that silently replace a shared sentence — or be replaced by one — with
 * nothing in either tree to read. `mergeSharedUiCopy` refuses the collision
 * instead, and `validate:i18n-strings` fails the build before it can ship.
 */
export const SHARED_UI_COPY_NAMESPACE = "ui";

/**
 * Every locale's shared copy, keyed exactly as `SUPPORTED_LOCALES` spells it.
 *
 * `Record`, never `Partial<Record>` — see the module note.
 */
export const SHARED_UI_COPY: Readonly<Record<SupportedLocale, object>> = {
  ar,
  bn,
  ca,
  de,
  en,
  es,
  fr,
  hi,
  ja,
  "pt-BR": ptBR,
  ru,
  "zh-Hans": zhHans,
};
