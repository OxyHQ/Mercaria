/**
 * The ten transforms, and the reason there is no eleventh mechanism (#63
 * security 4).
 *
 * `applyFeedTransform` takes a transform NAME from a closed union and a string.
 * It does not take a pattern, a template, an expression or a second value, so
 * there is no parameter through which a feed or a mapping could hand this
 * module a program to run. That is the whole enforcement of "never execute
 * formulas, scripts, templates or source-provided code": not a sandbox, not an
 * allow-list of safe functions, but the absence of any input that could be one.
 *
 * The `switch` is exhaustive over `FeedFieldTransform` with no `default`, so
 * adding a member to the shared-types tuple fails `tsc` here until somebody
 * implements it — where a `default: return value` would silently make the new
 * transform a no-op that a merchant configured and nobody applied.
 */

import type { FeedFieldTransform } from '@mercaria/shared-types';

/**
 * Apply one transform to one value.
 *
 * `money_minor_units` and `parse_integer` are deliberately NOT arithmetic here:
 * they are DECLARATIONS the money and integer readers consult
 * (`readsMinorUnits`), because converting `19.99` to `1999` needs the
 * currency's precision and this function has no currency. A transform that
 * guessed one would produce a price in a denomination nobody published.
 */
export function applyFeedTransform(value: string, transform: FeedFieldTransform, listSeparator: string): string {
  switch (transform) {
    case 'trim':
      return value.trim();
    case 'collapse_whitespace':
      return value.replace(/\s+/gu, ' ').trim();
    case 'upper':
      return value.toUpperCase();
    case 'lower':
      return value.toLowerCase();
    case 'strip_html':
      return stripHtml(value);
    case 'strip_identifier_separators':
      return value.replace(/[\s._-]/gu, '');
    case 'split_list':
      // Already the storage convention: a repeat is joined by the separator, so
      // "split" means "normalize the separators a publisher used", not "return
      // an array" — a mapping produces one value per role by construction.
      return value
        .split(listSeparator)
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .join(listSeparator);
    case 'first_of_list': {
      const first = value.split(listSeparator)[0];
      return first === undefined ? '' : first.trim();
    }
    case 'money_minor_units':
    case 'parse_integer':
      return value.trim();
  }
}

/** Does this transform declare the column is already in minor units? */
export function readsMinorUnits(transform: FeedFieldTransform | null): boolean {
  return transform === 'money_minor_units';
}

/**
 * Remove tags from a description, without parsing HTML.
 *
 * A bounded, non-backtracking replacement rather than a parser: the job is to
 * stop a `<script>` block and a table of markup reaching a product card, and a
 * real HTML parser here would be a dependency and an attack surface for a
 * cosmetic outcome. The `<` in `12 < 15` survives because the pattern requires a
 * name character after it, and the entity forms are decoded afterwards so
 * `&amp;` in a description reads as `&`.
 */
function stripHtml(value: string): string {
  return value
    .replace(/<\/?[A-Za-z][^>]{0,2000}>/gu, ' ')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gu, (_match, entity: string) => {
      switch (entity) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          return ' ';
      }
    })
    .replace(/\s+/gu, ' ')
    .trim();
}
