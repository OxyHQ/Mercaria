/**
 * The zod builder every localized text field is declared with (#367 line 187).
 *
 * A field's policy lives in `LOCALIZED_TEXT_FIELDS` and its BOUND lives at the
 * call site, because a length is a property of the surface — `listing_localizations.title`
 * takes 500 characters and `category_localizations.name` takes 512, and neither
 * number is a fact about what a title MAY CONTAIN. So the key selects the
 * policy, the caller states the bound, and there is exactly one place either can
 * be read from.
 *
 * ## Why the check is a `superRefine` and not a `transform`
 *
 * `catalog-authoring-schemas.ts` uses `.transform(sanitizeAuthoredText)` and
 * that is the right shape for what it does — it CLEANS a surface that has been
 * accepting pasted markup for as long as it has existed, and turning that into a
 * 400 would start refusing sellers mid-session. A localization surface has
 * accepted markup from nobody: `PUT /seller/listings/:id/localizations/:locale`
 * and its three operator siblings landed inside this epic, no shipped client
 * sends markup to any of them, and there is no population to break. A refusal is
 * therefore available here and is the stronger contract — the caller learns that
 * what it sent is not what would have been stored, which a transform can never
 * tell it.
 *
 * The divergence is deliberate and it is not permanent: converging the
 * base-locale authoring path onto a refusal is a change to a live seller surface
 * with its own migration of expectations, and it belongs to whoever owns #367
 * steps 5 and 6 rather than being smuggled in beside a declaration.
 */

import { z } from 'zod';
import type { LocalizedTextColumnKey } from '@mercaria/shared-types';
import { assertLocalizedText } from '../lib/localized-text.js';

/** What a localized text field's own surface decides, as opposed to its policy. */
export interface LocalizedTextBounds {
  /** The maximum RAW length, checked before the policy and never relaxed by it. */
  readonly max: number;
  /** A floor, where the surface has one. Omitted rather than defaulted to zero. */
  readonly min?: number;
}

/**
 * One localized text field, bounded by its surface and policed by its
 * declaration.
 *
 * Refuses rather than cleans, so the returned value is byte-identical to the
 * trimmed input and the `.max()` above still bounds exactly what is stored.
 */
export function localizedText(
  key: LocalizedTextColumnKey,
  bounds: LocalizedTextBounds,
): z.ZodEffects<z.ZodString, string, string> {
  const base =
    bounds.min === undefined
      ? z.string().trim().max(bounds.max)
      : z.string().trim().min(bounds.min).max(bounds.max);
  return base.superRefine((value, ctx) => {
    refineLocalizedText(ctx, key, [], value);
  });
}

/**
 * The same policy applied from an OBJECT-level refinement, where the column a
 * value belongs to is decided by a sibling key.
 *
 * `reviewLocalizationSchema` is the case: one body writes `category_localizations`
 * or `product_type_localizations` depending on its own `entity`, and the two
 * tables' policies happen to coincide today. Picking either key and calling it
 * close enough is how a policy stops describing the column it is applied to, so
 * the caller resolves the real key from the real body and this applies it.
 *
 * `path` is where the issue is reported, so a caller gets `["description"]`
 * rather than a message about the whole body.
 */
export function refineLocalizedText(
  ctx: z.RefinementCtx,
  key: LocalizedTextColumnKey,
  path: readonly (string | number)[],
  value: unknown,
): void {
  if (typeof value !== 'string') return;
  try {
    assertLocalizedText(key, value);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path],
      message: err instanceof Error ? err.message : 'This value is not permitted here.',
    });
  }
}
