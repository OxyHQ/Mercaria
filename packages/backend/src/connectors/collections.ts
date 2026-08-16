/**
 * Building one {@link ExternalCollection} row, for every provider that lists a
 * taxonomy.
 *
 * Two decisions live here rather than in each provider, because getting either
 * wrong produces a mapping that is configured, displayed and silently inert.
 *
 *  - **The id is stringified exactly as the import path stringifies it.** Both
 *    platforms send a collection id as a JSON NUMBER, both providers write
 *    `String(id)` into `NormalizedProduct.collectionRefs`, and the mapping is
 *    keyed on that string. A picker that emitted `12345` where an import emits
 *    `"12345"` would store a key no `collectionRefs` lookup can ever hit — and
 *    `applyCollectionMapping` reports nothing when a ref misses, so the failure
 *    is a merchant watching a correctly-configured mapping do nothing forever.
 *
 *  - **A nameless grouping is KEPT, labelled by its id.** The alternative is
 *    dropping the row, which removes a mappable collection from the picker
 *    entirely; a merchant then cannot map a grouping their imports demonstrably
 *    carry, and nothing on the screen says why. A visible odd label is a far
 *    better failure than an invisible omission.
 */

import type { ExternalCollection } from '@mercaria/shared-types';

/**
 * Build one row from a platform's raw id and title.
 *
 * `parentExternalId` is passed only by a NESTED taxonomy (WooCommerce). A
 * parent id of `0` is WooCommerce's spelling of "root", not a collection, so a
 * caller must resolve that to `undefined` before calling — see the WooCommerce
 * provider, which is the one place that distinction exists.
 */
export function toExternalCollection(
  id: number | string,
  title: string | undefined,
  extra?: { parentExternalId?: string; productCount?: number },
): ExternalCollection {
  const externalId = String(id);
  const trimmed = title?.trim();
  return {
    externalId,
    title: trimmed && trimmed !== '' ? trimmed : `Untitled (${externalId})`,
    ...(extra?.parentExternalId !== undefined
      ? { parentExternalId: extra.parentExternalId }
      : {}),
    ...(extra?.productCount !== undefined ? { productCount: extra.productCount } : {}),
  };
}
