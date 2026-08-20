/**
 * What the wizard renders when catalogue text has no translation.
 *
 * ## The decision this replaces
 *
 * Every authoring surface used to terminate its fallback in `?? someKey` — an
 * attribute key, a product-type key, a controlled-value token, or, on the review
 * screen a merchant reads before publishing, a raw category UUID. That is a real
 * choice made badly rather than an oversight: `AuthoringLocalizedText` is
 * OPTIONAL on every carrier precisely because the text can be genuinely absent
 * (`LocalizedResolution`'s `unavailable` branch, reached whenever the
 * `exact_locale_only` policy withholds the base column), so something has to
 * render. Substituting an internal identifier is the one option that tells the
 * merchant nothing and reads like a bug.
 *
 * Epic #367's acceptance criterion names it: *locale fallback … never exposes
 * raw keys to normal users*. **Raw** is the operative word. A key rendered bare,
 * in the slot where a NAME goes, is indistinguishable from copy somebody wrote —
 * that is what makes it raw. The same key rendered inside a translated
 * affordance that says it is untranslated is an identifier the merchant has been
 * told is an identifier, which is a different thing.
 *
 * ## Why the key is KEPT where one exists
 *
 * The tempting alternatives are all worse. An empty string makes a labelled
 * field look broken; a bare "Unknown" throws away the one fact the key carried;
 * and hiding the row removes something the author selected. Worse still on a
 * form: a product type with six untranslated field labels would render six
 * identical "Untranslated field" labels, and the form stops being fillable at
 * all. The key is the only thing that tells those six apart, so it stays —
 * marked, never bare.
 *
 * ## Why the UUID sites keep NOTHING
 *
 * `AuthoringSchema` carries `categoryId` and no category key, so the two
 * category sites had only a database id to fall back on. A UUID distinguishes
 * nothing for a merchant — it is not even the identifier they picked the
 * category BY, since `CategoryBrowser` selects on `category.key` — so marking it
 * would be honest and still useless. {@link AuthoringLabelFallback}'s
 * `unidentifiable` branch has no `key` property at all, which is what makes
 * "render the id instead" unrepresentable here rather than merely discouraged.
 *
 * A `categoryKey` on the schema DTO would upgrade those two sites to the `key`
 * branch and is the right follow-up; it is deliberately not done here, because
 * widening a wire contract does not fix this bug — the marked render is needed
 * either way — and it would put a `shared-types` change in a fix that needs none.
 *
 * ## One authority
 *
 * Thirteen sites need this decision, so they get one function and no
 * conditionals of their own. It takes `translate` rather than calling a hook, so
 * it stays pure and testable — which is the only way it is testable at all, the
 * dashboard's runner having no renderer.
 */

import type { AuthoringLocalizedText } from "@mercaria/shared-types";
import type { Translate } from "@mercaria/ui";

/**
 * Copy keys, as literals.
 *
 * `validate:i18n-strings` part C resolves keys from STRING LITERALS in source,
 * so a key assembled at runtime is invisible to it — the key reads as unused,
 * the guard fails, and the remedy somebody reaches for is deleting the copy.
 */
const UNTRANSLATED_WITH_KEY = "products.wizard.untranslated.withKey";
const UNTRANSLATED_UNNAMED = "products.wizard.untranslated.unnamed";

/** The sentence a surface shows once when any of its labels came back untranslated. */
export const UNTRANSLATED_NOTICE_KEY = "products.wizard.untranslated.notice";

/**
 * What is left to identify the thing when its name is unavailable.
 *
 * Two members, and the asymmetry is the point: `key` carries a stable, meaningful
 * identifier a merchant can act on, `unidentifiable` carries nothing because
 * nothing meaningful exists. The second branch has no property that could hold a
 * database id.
 */
export type AuthoringLabelFallback =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "unidentifiable" };

/**
 * A label, and whether it is really this merchant's language.
 *
 * A string discriminant, mirroring `LocalizedResolution.outcome` upstream. `text`
 * is on both branches and is always renderable, so a caller that only needs a
 * string reads it and asks nothing else; `outcome` exists for the one caller that
 * shows a notice, and re-deriving "was anything untranslated" from the text would
 * be a second representation of a fact this already states.
 */
export type AuthoringLabel =
  | { readonly outcome: "translated"; readonly text: string }
  | { readonly outcome: "untranslated"; readonly text: string };

/**
 * Resolve one piece of catalogue text into something a merchant can read.
 *
 * A BLANK value counts as untranslated. `?.value ?? key` treats `""` as a
 * successful resolution and renders an empty label, which is the "looks broken"
 * failure one step removed from the one this module exists for; the trim mirrors
 * the house `displayName?.trim() || handle` coalesce for the same reason.
 */
export function authoringLabel(
  text: AuthoringLocalizedText | undefined,
  fallback: AuthoringLabelFallback,
  translate: Translate,
): AuthoringLabel {
  const value = text?.value?.trim() ?? "";
  if (value.length > 0) return { outcome: "translated", text: value };

  if (fallback.kind === "unidentifiable") {
    return { outcome: "untranslated", text: translate(UNTRANSLATED_UNNAMED) };
  }

  const key = fallback.key.trim();
  // A key that is itself blank leaves nothing to mark up, so it lands on the
  // same copy as the `unidentifiable` branch rather than rendering " (not
  // translated)" with a hole where the identifier goes.
  if (key.length === 0) {
    return { outcome: "untranslated", text: translate(UNTRANSLATED_UNNAMED) };
  }
  return { outcome: "untranslated", text: translate(UNTRANSLATED_WITH_KEY, { key }) };
}

/** Whether any of these labels needs {@link UNTRANSLATED_NOTICE_KEY} shown beside it. */
export function anyUntranslated(labels: readonly AuthoringLabel[]): boolean {
  return labels.some((entry) => entry.outcome === "untranslated");
}
