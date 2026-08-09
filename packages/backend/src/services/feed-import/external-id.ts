/**
 * The deterministic external id (#63 processing 4).
 *
 * `catalog_source_objects` is keyed on `(source_id, external_type,
 * external_id)`, and #62's contract case 1 says an adapter that synthesises an
 * id "from a position, a timestamp or a hash of the payload makes every refresh
 * look like a new object". So the id here is derived from the merchant's own
 * STABLE key columns and from nothing else — not the row number, not the
 * observation time, not the content.
 *
 * ## Two shapes, and the rule for choosing between them
 *
 * A short key is used verbatim, because an id a person can read is an id a
 * person can trace: `/internal/ingestion/sources/:id/objects/trace` opens from
 * an external id, and a merchant who says "SKU-4471 is wrong" can be answered
 * without a lookup table. Past {@link MAX_READABLE_EXTERNAL_ID} it becomes
 * `k:<sha-256>` — a prefix, so the two shapes are distinguishable forever and a
 * digest can never be mistaken for a merchant's own value.
 *
 * The digest is over the SAME escaped join, so the choice of shape is a pure
 * function of length, and a key that grows past the bound changes an id exactly
 * once. That event is indistinguishable from re-keying the feed, which is why
 * `feed_configurations.identity_key_fields` is frozen by a trigger rather than
 * merely validated: both re-mint every object and retire the catalogue behind
 * the old ids.
 *
 * ## The join is INJECTIVE, which a plain separator is not
 *
 * Parts are escaped before they are joined, so `('a', 'b|c')` and `('a|b', 'c')`
 * produce different ids. A plain join collides there, and a collision is two of
 * a merchant's products sharing one `catalog_source_objects` row — a false merge
 * inside their own inventory, arriving as "the price of one SKU keeps changing
 * to another SKU's price". The escape covers the separator AND the escape
 * character, which is what makes it reversible and therefore collision-free.
 */

import { createHash } from 'node:crypto';

/** Above this length the id is a digest. Comfortably past any real composite key. */
export const MAX_READABLE_EXTERNAL_ID = 120;

/** The joiner, applied to ESCAPED parts. */
const KEY_SEPARATOR = '|';

/** What a derivation could not do, when it could not. */
export interface ExternalIdFailure {
  readonly missingField: string;
}

/**
 * The discriminant is a STRING, not an `ok: boolean`.
 *
 * `services/canonical/identifiers.ts` states the reason and it applies verbatim:
 * this backend compiles with `strict: false`, and under `strictNullChecks: false`
 * TypeScript does not narrow a boolean-discriminated union by truthiness, so
 * `if (!result.ok) return result.failure` fails to compile while
 * `result.kind === 'invalid'` succeeds. A union whose safe use depends on
 * remembering which spelling the compiler happens to accept is a trap for the
 * next caller.
 */
export type ExternalIdResult =
  | { readonly kind: 'derived'; readonly externalId: string }
  | { readonly kind: 'incomplete'; readonly failure: ExternalIdFailure };

/**
 * Derive one record's external id from the configuration's frozen key columns.
 *
 * A missing or blank key column is a REFUSAL naming the column, never a
 * fallback: an id derived from the columns that happened to be present would
 * differ between two deliveries of the same product, which is the exact failure
 * this function exists to prevent. The caller turns it into a
 * `missing_required_field` issue and the record is isolated.
 */
export function deriveFeedExternalId(
  fields: ReadonlyMap<string, string>,
  identityKeyFields: readonly string[],
): ExternalIdResult {
  const parts: string[] = [];
  for (const field of identityKeyFields) {
    const value = fields.get(field)?.trim() ?? '';
    if (value === '') return { kind: 'incomplete', failure: { missingField: field } };
    parts.push(escapePart(value));
  }
  const joined = parts.join(KEY_SEPARATOR);
  if (joined.length <= MAX_READABLE_EXTERNAL_ID) {
    return { kind: 'derived', externalId: joined };
  }
  return {
    kind: 'derived',
    externalId: `k:${createHash('sha256').update(joined).digest('hex')}`,
  };
}

/** Backslash-escape the separator and the escape character, in that order. */
function escapePart(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|');
}
