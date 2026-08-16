/**
 * Resolving a navigation node's label (#367 step 7, ADR 0007 D4).
 *
 * Pure. It takes the rows a repository read and answers with the string plus the
 * locale that actually produced it and that translation's status — D4 requires
 * the effective locale and the status to travel WITH the text, so an internal
 * client can debug a fallback and a public client never renders a raw key.
 *
 * ## A node with no label in the chain is WITHHELD, never keyed
 *
 * {@link resolveNavigationPresentation} returns `undefined` rather than
 * inventing a string. Every alternative is worse in a way somebody ships: the
 * node's `key` is a machine identifier and putting `electronics.phones` in a
 * menu is the exact failure ADR 0007 D1 exists to prevent; the target's own name
 * is a category name in the WRONG language; and an empty label is a menu entry
 * with nothing on it.
 */

import {
  navigationLocaleFallbackChain,
  type NavigationLocalizationProvenance,
  type NavigationLocalizationStatus,
  type NavigationPresentation,
} from '@mercaria/shared-types';

/**
 * The last locale of every fallback chain.
 *
 * ONE constant, stated once. Which locale a deployment falls back to is the
 * localization family's authority (merge-order step 2) — when it lands, this
 * constant is deleted and its own base locale imported in its place, which is a
 * one-line change because nothing else in this domain names a locale.
 */
export const NAVIGATION_BASE_LOCALE = 'en';

/** A localization row, as far as this resolver is concerned. */
export interface NavigationLabelRow {
  readonly locale: string;
  readonly label: string;
  readonly description: string | null;
  readonly accessibilityLabel: string | null;
  readonly status: string;
  readonly provenance: string;
}

/** The fallback chain for a requested locale: exact → language → base (D4). */
export function navigationFallbackChain(requestedLocale: string): readonly string[] {
  return navigationLocaleFallbackChain(requestedLocale, NAVIGATION_BASE_LOCALE);
}

/**
 * The first label in the chain, with the locale that answered.
 *
 * The chain is walked in order and the FIRST hit wins — a `deprecated` or
 * `stale` row included. D4 is explicit that a stale translation is still the
 * best text available and that withdrawing it would show raw keys to shoppers;
 * the status rides along so a surface that wants to mark it can.
 */
export function resolveNavigationPresentation(
  rows: readonly NavigationLabelRow[],
  requestedLocale: string,
  chain: readonly string[] = navigationFallbackChain(requestedLocale),
): NavigationPresentation | undefined {
  for (const locale of chain) {
    const row = rows.find((candidate) => candidate.locale === locale);
    if (row === undefined) continue;
    return {
      label: row.label,
      ...(row.description === null ? {} : { description: row.description }),
      ...(row.accessibilityLabel === null
        ? {}
        : { accessibilityLabel: row.accessibilityLabel }),
      locale: row.locale,
      requestedLocale,
      status: row.status as NavigationLocalizationStatus,
      provenance: row.provenance as NavigationLocalizationProvenance,
      // Derived from the two locales rather than stored beside them, so the flag
      // and the pair it describes cannot disagree.
      fallbackApplied: row.locale !== requestedLocale,
    };
  }
  return undefined;
}
