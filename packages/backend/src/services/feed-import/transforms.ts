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
 * Remove tag-shaped substrings, without parsing HTML.
 *
 * A bounded, non-backtracking replacement rather than a parser: the job is to
 * stop a `<script>` block and a table of markup reaching a product card, and a
 * real HTML parser here would be a dependency and an attack surface for a
 * cosmetic outcome. The `<` in `12 < 15` survives because the pattern requires a
 * name character after it.
 *
 * `[^>]` cannot cross a `>`, so the match is always the shortest run to the next
 * one and removing a tag never JOINS its neighbours into a new one: `<scr<b>ipt>`
 * loses `<scr<b>` and leaves `ipt>`, not `<script>`.
 *
 * Exported because it is the one tag pattern in this repository and
 * `lib/authored-text.ts` composes it in a different ORDER for a different job —
 * one regex with two callers rather than two regexes that can disagree, which is
 * the direction they would disagree in the first time somebody tightens one.
 */
export function stripHtmlTags(value: string): string {
  return value.replace(/<\/?[A-Za-z][^>]{0,2000}>/gu, ' ');
}

/**
 * Decode the five named entities plus `&nbsp;`.
 *
 * A closed table rather than a general decoder: a numeric-reference decoder is
 * the other half of an XSS primitive and nothing in a product feed needs one.
 * `&nbsp;` becomes a plain space, which is what the whitespace collapse below
 * would do to it anyway.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|nbsp);/gu, (_match, entity: string) => {
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
  });
}

/**
 * `strip_html`, unchanged: tags out, entities decoded, whitespace collapsed.
 *
 * The ORDER is strip-then-decode and stays that way here, because this is a
 * COSMETIC transform a merchant configured on a feed column and changing what it
 * emits would change stored descriptions for every advertiser using it. Note
 * what that order means and where it matters: decoding after stripping can
 * PRODUCE a tag, so `&lt;script&gt;` in a feed reaches the listing row as
 * `<script>`. Every Mercaria consumer escapes on output, so nothing renders it —
 * but a control that can manufacture markup is not a sanitizer, which is exactly
 * why `sanitizeAuthoredText` decodes FIRST and does not reuse this function.
 */
function stripHtml(value: string): string {
  return decodeHtmlEntities(stripHtmlTags(value))
    .replace(/\s+/gu, ' ')
    .trim();
}
