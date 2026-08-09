/**
 * ONE entry point for all five formats (#63 §"Supported inputs" 1–4).
 *
 * The dispatch is exhaustive over `FeedFormat` by a `switch` with no `default`,
 * so adding a format to the shared-types tuple fails `tsc` here until somebody
 * writes the parser — which is the opposite of a `default: throw`, where the new
 * format compiles, ships, and refuses every feed at runtime.
 *
 * Nothing above this line knows which format it is reading, and nothing below it
 * knows what a mapping is. That seam is what makes the parsing layer reusable by
 * #66's Awin adapter, which needs the streaming gzip CSV reader and none of the
 * configuration machinery around it.
 */

import type { FeedFormat } from '@mercaria/shared-types';
import { parseDelimitedFeed } from './delimited.js';
import { parseJsonFeed } from './json.js';
import { parseJsonLinesFeed } from './jsonl.js';
import { parseXmlFeed } from './xml.js';
import type { FeedParseOptions, FeedRawRecord } from './types.js';

export type { FeedParseOptions, FeedRawRecord } from './types.js';
export { MALFORMED_RECORD_FIELD } from './jsonl.js';

/**
 * Stream a feed's records, in feed order, holding at most one at a time.
 *
 * The generator is the contract: a caller that wanted all of them would have to
 * write the array itself, which is a change a reviewer sees. A function
 * returning `FeedRawRecord[]` would make issue acceptance 1 unenforceable at
 * every call site at once.
 */
export function streamFeedRecords(
  text: AsyncIterable<string>,
  options: FeedParseOptions,
): AsyncGenerator<FeedRawRecord> {
  const format: FeedFormat = options.format;
  switch (format) {
    case 'csv':
    case 'tsv':
      return parseDelimitedFeed(text, options);
    case 'jsonl':
      return parseJsonLinesFeed(text, options);
    case 'json':
      return parseJsonFeed(text, options);
    case 'xml':
      return parseXmlFeed(text, options);
  }
}
