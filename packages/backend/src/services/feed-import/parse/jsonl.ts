/**
 * Streaming JSON Lines (#63 §"Supported inputs" 3, acceptance 3).
 *
 * The one format whose record boundary is a byte, which makes it the cheapest
 * to stream and the easiest to get subtly wrong: a `split('\n')` over the whole
 * decoded text is a whole-feed buffer, and a `split` per chunk drops the record
 * straddling every chunk boundary. The loop below holds one partial line.
 *
 * A blank line is skipped rather than refused — a trailing newline is universal
 * and several exporters separate batches with one. A line that is not valid
 * JSON is a MALFORMED RECORD, not a malformed feed: it produces one issue and
 * the pass continues, which is issue processing 3. That is the distinction this
 * file exists to make, because the same bad bytes in a JSON *array* feed take
 * the whole document with them.
 */

import { FeedImportRefusal } from '../errors.js';
import { flattenJsonRecord } from './flatten.js';
import { type FeedParseOptions, type FeedRawRecord } from './types.js';

/** A line that failed to parse. Carried as a field so the mapper reports it. */
export const MALFORMED_RECORD_FIELD = '__malformed__';

export async function* parseJsonLinesFeed(
  text: AsyncIterable<string>,
  options: FeedParseOptions,
): AsyncGenerator<FeedRawRecord> {
  let pending = '';
  let index = 0;
  let emitted = 0;

  async function* flush(line: string): AsyncGenerator<FeedRawRecord> {
    const trimmed = line.trim();
    if (trimmed === '') return;
    emitted += 1;
    if (emitted > options.maxRecords) {
      throw new FeedImportRefusal(
        'too_many_records',
        `The feed exceeded the ${options.maxRecords}-record limit and was refused rather than truncated.`,
      );
    }
    yield readJsonRecord(trimmed, index, options);
    index += 1;
  }

  for await (const chunk of text) {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      yield* flush(line);
      newline = pending.indexOf('\n');
    }
    if (pending.length > options.maxRecordBytes) {
      throw new FeedImportRefusal(
        'record_too_large',
        `A JSON Lines record exceeded the ${options.maxRecordBytes}-character limit. A whole ` +
          'JSON document sent as a single line is the usual cause; configure the feed as `json`.',
      );
    }
  }
  yield* flush(pending);
}

/**
 * One JSON text → one record.
 *
 * A parse failure becomes a record carrying only {@link MALFORMED_RECORD_FIELD},
 * which the mapper turns into a `malformed_record` issue against that record's
 * index. Returning `null` instead would make the record vanish, and a vanished
 * record is the one thing the report's `scanned = valid + invalid` floor exists
 * to make impossible.
 */
export function readJsonRecord(
  text: string,
  index: number,
  options: FeedParseOptions,
): FeedRawRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { index, fields: new Map([[MALFORMED_RECORD_FIELD, 'unparseable']]) };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { index, fields: new Map([[MALFORMED_RECORD_FIELD, 'not_an_object']]) };
  }
  return { index, fields: flattenJsonRecord(parsed, options) };
}
