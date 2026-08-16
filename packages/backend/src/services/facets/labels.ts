/**
 * The strings a facet rail renders, and where each of them came from
 * (#367 Workstream 10, ADR 0007 D1/D4).
 *
 * ## A label is never identity
 *
 * Everything a client sends back — a facet key, a bucket key, a category id — is
 * stable and untranslated. Everything a client RENDERS carries a
 * {@link FacetLabelSource} saying whether it is real copy in the reader's
 * language, real copy in a fallback, base-locale text, or the machine key
 * rendered because Mercaria holds no copy at all. A rail that returned bare
 * strings would make those four indistinguishable, and the fourth is the one
 * somebody needs to fix.
 *
 * ## There is exactly one resolver and it is not in this file
 *
 * `services/catalog-localization/resolve.ts` owns the fallback chain and the
 * status rules (ADR D4). This module CALLS it — through `read.service.ts` for
 * categories and controlled values, and through its exported, pure
 * `localeFallbackChain` for attribute names, which is the one localized string
 * in the rail that has no family member to resolve.
 *
 * The attribute-name gap is real and is named rather than papered over:
 * `LOCALIZED_ENTITY_KINDS` is `['category', 'product_type', 'attribute_value']`
 * and `attribute_labels` is the single recorded exemption from the family
 * columns (`LOCALIZATION_FAMILY_COLUMN_EXEMPTIONS`), so it carries no `status`
 * and no `provenance` for a resolution to report. It is walked with the SAME
 * chain, in the same order, and the result is reported as `attribute_label`
 * rather than `localization` so the difference is visible in the response.
 * Making `attribute_definition` a full family member is #367 Workstream 2's, and
 * closing it deletes this module's one bespoke walk.
 */

import type {
  FacetLabel,
  LocalizedResolution,
  SupportedLocale,
} from '@mercaria/shared-types';
import { localeFallbackChain } from '../catalog-localization/resolve.js';

/** The fallback policy every catalog-presentation string in the rail uses. */
export const FACET_LABEL_FALLBACK_POLICY = 'language_then_base';

/** The chain a facet-rail read narrows on, for every localized string in it. */
export function facetLocaleChain(requestedLocale: string): readonly SupportedLocale[] {
  return localeFallbackChain(requestedLocale, FACET_LABEL_FALLBACK_POLICY);
}

/**
 * Present a resolver outcome as a rail label.
 *
 * An `unavailable` resolution falls back to the base text the caller supplies —
 * which is real copy somebody wrote, just not in this language — and says so
 * with `registry_base`. It never falls back to the KEY when base text exists,
 * because a machine key rendered beside translated siblings looks like a bug in
 * exactly the place a reader has least context to judge it.
 */
export function labelFromResolution(
  resolution: LocalizedResolution,
  baseText: string,
): FacetLabel {
  if (resolution.outcome === 'resolved') {
    return {
      text: resolution.value,
      source: 'localization',
      effectiveLocale: resolution.effectiveLocale,
      status: resolution.status,
    };
  }
  return { text: baseText, source: 'registry_base' };
}

/**
 * An attribute NAME, walked over `attribute_labels` with the shared chain.
 *
 * `candidates` is a locale → label map for one attribute. The walk is the
 * resolver's own order — exact locale, then the language truncations, then the
 * base — and it stops at the first hit, so a `es-mx` reader gets `es-mx` if it
 * exists and `es` if it does not. There is no status to consult because the
 * table has no status column; that ABSENCE is why the result is labelled
 * `attribute_label` rather than `localization`.
 */
export function attributeNameLabel(
  candidates: ReadonlyMap<string, string>,
  chain: readonly SupportedLocale[],
  baseLabel: string,
): FacetLabel {
  for (const locale of chain) {
    const text = candidates.get(locale);
    if (text !== undefined && text.trim() !== '') {
      return { text, source: 'attribute_label', effectiveLocale: locale };
    }
  }
  return { text: baseLabel, source: 'registry_base' };
}

/**
 * A label for a concept Mercaria holds NO copy for.
 *
 * Every commerce dimension is in this state: there is no `commerce_dimension`
 * entity, no localization table for one, and no place a translator could put
 * "Precio". Emitting the stable key and SAYING it is the stable key is the
 * honest answer — the client owns that copy, the same way `@mercaria/ui`'s
 * `lib/condition.ts` already owns the nine condition labels precisely so they
 * can change without touching a stored value.
 *
 * Inventing English copy here would be worse than the key: it would look like
 * copy, so nobody would translate it, and a Spanish rail would read "Price" with
 * every value beside it in Spanish.
 */
export function stableKeyLabel(key: string): FacetLabel {
  return { text: key, source: 'stable_key' };
}
