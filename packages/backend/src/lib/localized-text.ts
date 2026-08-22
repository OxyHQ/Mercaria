/**
 * Enforcing {@link LOCALIZED_TEXT_FIELDS} — what a localized text column may
 * carry, at the boundary where it enters (#367 line 187).
 *
 * `lib/authored-text.ts` is the sibling and the contrast is the whole point.
 * That module CLEANS: it strips markup out of a base-locale title or
 * description and stores what is left, which is right for a surface that has
 * been accepting pasted markup since before the control existed. This module
 * REFUSES, because a localization surface has never accepted markup and there is
 * no shipped client that sends any. Cleaning silently accepts input the contract
 * forbids — a translation vendor, a bulk importer or a seller's editor sends
 * `<b>Rebajas</b>` and is told it succeeded, and nothing anywhere reports that
 * what was stored is not what was sent.
 *
 * ## One rule, and the plain/rich asymmetry falls out of the DATA
 *
 * A descriptor's `structures` IS the permitted set. A value is refused when it
 * exhibits a structure the field does not permit, and markup is refused for
 * every field because it is not a member of `LOCALIZED_RICH_TEXT_STRUCTURES` at
 * all. A `plain` field is exactly a field whose permitted set is empty, so there
 * is no `if (format === 'plain')` here to get backwards — which is the branch a
 * reviewer would have to check on every future field.
 *
 * ## The markup detector is the OWNER's pattern, not a copy of it
 *
 * `services/feed-import/transforms.ts` owns the one tag pattern and the one
 * entity table in this repository, and `lib/authored-text.ts` composes them
 * rather than restating them. Writing `/<[a-z]/` here would be a second pattern
 * that can disagree with the one under test, in the direction where the DETECTOR
 * keeps passing after somebody tightens the STRIPPER. So markup is detected by
 * asking the stripper: a tag-shaped substring is present exactly when stripping
 * changes the decoded text. Tighten `stripHtmlTags` and this tightens with it,
 * with nothing to remember.
 *
 * Entities are decoded FIRST, for `authored-text.ts`'s reason: decoding after
 * stripping can MANUFACTURE the markup the strip removed, so a check in that
 * order would pass `&lt;script&gt;` and store it for a consumer that decodes.
 */

import {
  LOCALIZED_TEXT_FIELDS,
  type LocalizedRichTextStructure,
  type LocalizedTextColumnKey,
} from '@mercaria/shared-types';
import { decodeHtmlEntities, stripHtmlTags } from '../services/feed-import/transforms.js';

/**
 * Does this value carry a tag-shaped substring, in any encoding this repository
 * decodes?
 *
 * Exported for the census and the mutation self-tests; every production caller
 * goes through {@link assertLocalizedText}.
 */
export function containsMarkup(value: string): boolean {
  const decoded = decodeHtmlEntities(value);
  return stripHtmlTags(decoded) !== decoded;
}

/**
 * Which structures a value actually exhibits.
 *
 * `paragraph_break` implies `line_break`, so a value carrying a blank line
 * reports both — which is what makes an allow-list containing only
 * `paragraph_break` unsatisfiable, and why `localized-text-format.test.ts`
 * refuses a descriptor declaring one.
 */
export function structuresIn(value: string): readonly LocalizedRichTextStructure[] {
  const found: LocalizedRichTextStructure[] = [];
  if (/[\n\r]/u.test(value)) found.push('line_break');
  // A blank line: a newline, optional horizontal whitespace, another newline.
  if (/[\n\r][^\S\n\r]*[\n\r]/u.test(value)) found.push('paragraph_break');
  return found;
}

/** What a refusal says, so a schema and a repository phrase it identically. */
function refusal(key: LocalizedTextColumnKey, because: string): string {
  const field = LOCALIZED_TEXT_FIELDS[key];
  return (
    `${key} is declared ${field.format} localized text and ${because} ` +
    `Declared in \`LOCALIZED_TEXT_FIELDS\` (@mercaria/shared-types).`
  );
}

/**
 * Refuse a localized value that carries more than its field permits.
 *
 * Returns the value unchanged — it never cleans, never truncates and never
 * shortens, so a caller's own `.max()` still bounds exactly what is stored.
 * Throws a plain `Error`; the zod builders in
 * `middleware/localized-text-schemas.ts` turn it into the 400 an HTTP caller
 * sees, and a repository caller lets it surface as the defect it is.
 */
export function assertLocalizedText(key: LocalizedTextColumnKey, value: string): string {
  if (containsMarkup(value)) {
    throw new Error(
      refusal(
        key,
        'markup is permitted in no localized field. Send the text itself — it is ' +
          'stored and rendered as written, so a tag would be shown rather than applied.',
      ),
    );
  }
  const permitted = new Set(LOCALIZED_TEXT_FIELDS[key].structures);
  const offending = structuresIn(value).filter((structure) => !permitted.has(structure));
  if (offending.length > 0) {
    throw new Error(
      refusal(key, `it may not carry ${offending.join(' or ')}. It is rendered on one line.`),
    );
  }
  return value;
}

/**
 * The same rule for a value that may be absent.
 *
 * `null` and `undefined` pass through untouched: whether a localized field may
 * be empty is its own table's CHECK (`_missing_text_check`,
 * `_text_not_blank_check`) and restating it here would be a second answer to a
 * question the database already answers.
 */
export function assertOptionalLocalizedText<T extends string | null | undefined>(
  key: LocalizedTextColumnKey,
  value: T,
): T {
  if (typeof value === 'string') assertLocalizedText(key, value);
  return value;
}
