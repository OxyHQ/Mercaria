/**
 * Reading a PROVIDER's own timestamp text into a `Date`, or answering that it
 * could not be read.
 *
 * `new Date(text)` never throws: unreadable text yields an INVALID `Date`, which
 * behaves like a `Date` everywhere except where it matters. Assigned to a
 * `NormalizedProduct.externalUpdatedAt` it travels all the way into
 * `listings.source_external_updated_at`, where drizzle throws while mapping it
 * to a `timestamptz` parameter — so one bad character in one product's
 * timestamp failed that product's whole import (#221).
 *
 * ## Omitting is the LAST resort, not the first
 *
 * An omission is not free, and that is the half worth stating: `buildSource`
 * writes `sourceExternalUpdatedAt: … ?? null` by design, so a field this module
 * declines to read is not merely absent from one sync — it ERASES the stored
 * freshness on every sync, and the newer-than comparison the column exists for
 * has nothing to compare against from then on. So an unreadable value is
 * omitted, and a value that is merely written in a shape we did not expect must
 * be READ rather than thrown away. {@link parseZonelessUtcTimestamp} is where
 * that distinction lives.
 *
 * Where an omission IS the answer, it is `undefined` and never a substitute:
 * `now`, the create time or epoch would each write a claim about the platform
 * that nothing observed. Callers assign the field only when a `Date` comes
 * back — the `if` is the omission.
 */

/**
 * A trailing zone designator on a TIMESTAMP: `Z`, `+02`, `+02:00`, `-0500`.
 *
 * The point of the anchor is what it lets the regex MATCH, not what it excludes.
 * Measured under `TZ=America/New_York`:
 *
 *   * `2026-01-02T03:04:05+02:00` and `…+0200` parse correctly as they stand,
 *     and appending `Z` makes each of them an INVALID date — so a classifier
 *     that missed them would omit a perfectly good instant on every sync, which
 *     is the erasure the module header is about. Neither ends in sign-plus-two-
 *     digits, so the obvious `/[+-]\d{2}$/` does not match either one; requiring
 *     a preceding `HH:MM` is what makes the optional `(?::?\d{2})?` tail
 *     reachable, and that tail is the whole point.
 *   * The naive half DOES match a bare `2026-01-02` (its last three characters
 *     are `-02`). That misclassification costs nothing — a date-only ISO string
 *     is ALREADY UTC per ECMAScript, so `new Date('2026-01-02')` and
 *     `new Date('2026-01-02Z')` are the same instant, delta 0 ms. Do not restore
 *     that reading on the strength of this note: it is harmless here and wrong
 *     as a description of the value.
 *   * The five-hour local-time hazard is real and belongs to the date-TIME form
 *     `2026-01-02T03:04:05`, which is parsed as LOCAL. The naive regex never
 *     matched that shape either way; what protects it is that it carries no zone
 *     designator, so {@link parseZonelessUtcTimestamp} appends the `Z`.
 */
const ZONED_TIMESTAMP = /\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * An hour-only UTC offset (`+02`, `-05`) and the time it trails.
 *
 * ISO 8601 permits it and `new Date` cannot parse it — measured: both
 * `2026-01-02T03:04:05+02` and `…+02Z` are INVALID, while the same instant
 * written `+02:00` reads fine. Left alone it is classified zoned (correctly, so
 * no `Z` is appended), fails to parse, and is OMITTED — erasing stored freshness
 * on every later sync for a value whose meaning is not in doubt. Padding the
 * minutes is the smallest reading that keeps it.
 */
const HOUR_ONLY_OFFSET = /(\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)([+-]\d{2})$/;

/**
 * Parse a provider timestamp exactly as published, or `undefined`.
 *
 * For a provider that publishes a complete ISO-8601 instant (Shopify). Blank
 * and unreadable are the same answer on purpose: a platform that sends `""`,
 * `null` or `"0000-00-00 00:00:00"` is telling us nothing in three spellings,
 * and no downstream column can carry the distinction.
 *
 * The one rewrite it makes is {@link HOUR_ONLY_OFFSET}'s minute padding, and it
 * can only WIDEN what is read: the shape it repairs does not parse at all today,
 * so no value that currently yields a `Date` takes a different path. A date-only
 * field is KEPT, as midnight UTC — the honest reading of what was published, and
 * omitting it would erase a freshness the platform did state.
 */
export function parseProviderTimestamp(raw: string | null | undefined): Date | undefined {
  const text = raw?.trim();
  if (!text) {
    return undefined;
  }
  const parsed = new Date(text.replace(HOUR_ONLY_OFFSET, '$1$2:00'));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Parse a timestamp from a provider that publishes UTC with NO zone designator
 * (WooCommerce's `*_gmt` fields), or `undefined`.
 *
 * `Z` is appended ONLY when the value carries no zone of its own, which is the
 * correction that matters here. Appending it unconditionally turns
 * `2026-01-02T03:04:05+02:00` into `…+02:00Z` — not a date at all — and #221's
 * first fix then omitted the field, which reads as diligence and is a data loss:
 * that value is perfectly well-formed and says exactly what instant it means, so
 * refusing it erases a freshness the platform did state. A zone appearing in a
 * field named `_gmt` is a WordPress plugin or a proxy rewriting the response,
 * and the instant is unambiguous either way.
 *
 * A value that is still unreadable after that — genuine garbage, WordPress's
 * `0000-00-00` empty date — is omitted, because there is no instant in it to
 * preserve. A DATE-ONLY field is not in that set and is deliberately kept:
 * `2026-01-02` reads as `2026-01-02T00:00:00.000Z` (measured; the appended `Z`
 * changes nothing, since a date-only ISO string is already UTC). Midnight UTC is
 * what the platform published, and the alternative is the erasure above.
 */
export function parseZonelessUtcTimestamp(raw: string | null | undefined): Date | undefined {
  const text = raw?.trim();
  if (!text) {
    return undefined;
  }
  return parseProviderTimestamp(ZONED_TIMESTAMP.test(text) ? text : `${text}Z`);
}
