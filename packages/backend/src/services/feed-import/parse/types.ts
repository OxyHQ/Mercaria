/**
 * What every parser produces, and what every parser is bounded by.
 *
 * One shape for all five formats, because the MAPPING layer above must not know
 * which one it is reading: a merchant's column is a name and a value whether it
 * arrived as a CSV cell, an XML child element or a JSON key, and a mapping
 * engine that branched on format would need five of every rule.
 */

import type { FeedFormat } from '@mercaria/shared-types';

/**
 * One record, as the feed published it.
 *
 * A `Map` rather than an object literal: a feed's column names are attacker-
 * influenced strings, and `__proto__`, `constructor` and `toString` are all
 * legitimate-looking header names that a plain object would treat as something
 * other than data. A `Map` has no prototype chain to walk into.
 *
 * A REPEATED name — three `g:additional_image_link` elements, two columns both
 * called `price` — is JOINED with the configuration's list separator rather
 * than last-one-wins, because the repeats in a real feed are lists (a Google XML
 * feed publishes additional images exactly this way) and the `split_list`
 * transform is what reads them back.
 */
export interface FeedRawRecord {
  /** The record's ordinal in the feed, from 0. What an error report cites. */
  readonly index: number;
  readonly fields: ReadonlyMap<string, string>;
}

/** How to read one feed. Every field comes from the active mapping version. */
export interface FeedParseOptions {
  readonly format: FeedFormat;
  /** One character. Required for a delimited format, unused otherwise. */
  readonly delimiter: string;
  /** One character. Required for a delimited format, unused otherwise. */
  readonly quoteChar: string;
  readonly hasHeaderRow: boolean;
  /** Where the records live, for `xml` and `json`. `null` for the flat formats. */
  readonly recordPath: string | null;
  /** What joins repeated values, and what `split_list` splits on. */
  readonly listSeparator: string;
  /** Cap on ONE record's serialized size. Bounds the parser's own memory. */
  readonly maxRecordBytes: number;
  /** Cap on records in one feed. Exceeding it REFUSES; it never truncates. */
  readonly maxRecords: number;
}

/**
 * How deep a nested value is flattened into a field name.
 *
 * Three levels covers every real feed shape — `shipping.country`,
 * `price.value` — and stops a hostile document turning one record into a
 * hundred thousand field names through nesting alone.
 */
export const MAX_FLATTEN_DEPTH = 3;

/** Cap on how many distinct field names one record may contribute. */
export const MAX_RECORD_FIELDS = 500;

/**
 * Add a value under a name, joining a repeat rather than replacing it.
 *
 * The join is what makes `additional_image_link` work, and the field cap is
 * what stops a document with a hundred thousand distinct child names becoming a
 * hundred thousand map entries. Past the cap the record keeps what it has: a
 * refusal here would reject the whole feed over one pathological row, which is
 * the opposite of the per-record isolation the issue asks for.
 */
export function addRawField(
  fields: Map<string, string>,
  name: string,
  value: string,
  listSeparator: string,
): void {
  if (name.length === 0) return;
  const existing = fields.get(name);
  if (existing === undefined) {
    if (fields.size >= MAX_RECORD_FIELDS) return;
    fields.set(name, value);
    return;
  }
  fields.set(name, `${existing}${listSeparator}${value}`);
}
