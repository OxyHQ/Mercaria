/**
 * BCP-47 helpers, in a LEAF module.
 *
 * Its own file rather than a corner of `context.ts` because of what depends on
 * it: `variant-axes.ts` and `comparison.ts` are pure composition and are
 * IMPORTED AND EXECUTED by the backend suite
 * (`src/__tests__/storefront-catalog-composition.test.ts`), which is the only
 * runner this repository has. `context.ts` reads a store, a context and the
 * device; `specifications.ts` reaches `@mercaria/ui` for the `formatMoney`
 * chokepoint. Either would drag a renderer — and JSX the backend's `tsc` has no
 * `--jsx` for — in behind whatever imported it.
 *
 * So this file imports NOTHING, and both things `variant-axes.ts` needs from
 * outside itself live here. That is also why {@link SpecificationLabelSource}
 * is here rather than in `specifications.ts`: a label's PROVENANCE is a fact
 * about locale resolution, and both modules resolve labels.
 */

/**
 * Where a rendered label came from, so a surface can say when it is not the
 * shopper's language — and, on the last branch, not a translated word at all.
 */
export type SpecificationLabelSource =
  /** The definition's own label for this exact locale. */
  | 'definition_locale'
  /** The definition's label for the locale's LANGUAGE, region dropped. */
  | 'definition_language'
  /** The definition's default-locale label. */
  | 'definition_base'
  /**
   * The value projection's own label, or the stable KEY. The server already
   * falls back to the key there, so this is the branch on which a surface must
   * not claim the words a shopper reads were authored for them.
   */
  | 'value_projection';

/** The primary language subtag of a BCP-47 tag, lowercased. */
export function languageOf(locale: string): string {
  const [primary] = locale.split('-');
  return (primary ?? locale).trim().toLowerCase();
}
