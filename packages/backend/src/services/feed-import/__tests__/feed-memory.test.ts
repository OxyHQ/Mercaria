/**
 * Bounded memory over a large feed (#63 acceptance 1: "a multi-gigabyte
 * synthetic feed processes with bounded memory").
 *
 * ## Peak heap is measured at TWO scales, and the assertion is that it does not
 * grow
 *
 * "It fit in memory once" is a fact about the machine the test ran on. The
 * property that actually matters is that peak heap is INDEPENDENT of feed size,
 * and the only way to observe independence is to vary the size — so this runs
 * the same pipeline at a scale and at eight times that scale and asserts the
 * difference is noise. A run that buffered the feed would show peak heap
 * tracking the input; a run that streams shows the same number twice.
 *
 * That is strictly stronger than one big run, and it is why the CI scale is
 * modest. The multi-gigabyte pass is available and opt-in
 * (`FEED_IMPORT_MEMORY_SCALE=full`), which follows `MATCH_BENCHMARK_SCALE` and
 * the graph benchmark: a fifteen-minute test in the ordinary suite is a test
 * whoever hits it next disables.
 *
 * ## The bytes are GENERATED, never held
 *
 * The synthetic feed is an async generator that yields rows as they are
 * consumed, so the TEST does not buffer the feed either. Building a fixture
 * string first would put the gigabyte in the harness instead of the parser and
 * prove nothing about the parser.
 */

import { describe, expect, it } from 'vitest';
import type { FeedFieldMapping, FeedFieldRole } from '@mercaria/shared-types';
import { mapFeedRecord, type ResolvedFeedMapping } from '../mapping.js';
import { streamFeedRecords, type FeedParseOptions } from '../parse/index.js';

/**
 * Records per pass.
 *
 * At the CI scale the two passes are 200k and 1.6M records — around 20 MB and
 * 160 MB of generated CSV. `full` is 2M and 16M, which is a multi-gigabyte feed
 * and takes minutes.
 */
const SCALE = process.env.FEED_IMPORT_MEMORY_SCALE === 'full' ? 2_000_000 : 200_000;

/** How much peak heap may differ between the two scales, in bytes. */
const ALLOWED_DRIFT_BYTES = 24 * 1024 * 1024;

const PARSE_OPTIONS: FeedParseOptions = {
  format: 'csv',
  delimiter: ',',
  quoteChar: '"',
  hasHeaderRow: true,
  recordPath: null,
  listSeparator: ',',
  maxRecordBytes: 64 * 1024,
  maxRecords: 100_000_000,
};

const MAPPING: ResolvedFeedMapping = {
  fieldMappings: new Map<FeedFieldRole, FeedFieldMapping>([
    ['title', { role: 'title', sourceField: 'title' }],
    ['brand', { role: 'brand', sourceField: 'brand' }],
    ['price', { role: 'price', sourceField: 'price' }],
    ['price_currency', { role: 'price_currency', constantValue: 'EUR' }],
    ['destination_url', { role: 'destination_url', sourceField: 'link' }],
  ]),
  valueMappings: new Map(),
  identityKeyFields: ['id'],
  listSeparator: ',',
  defaultCurrency: 'EUR',
  defaultCountry: null,
  defaultLanguage: null,
};

/** A synthetic CSV, generated as it is read. Never materialised. */
async function* syntheticFeed(records: number): AsyncGenerator<string> {
  yield 'id,title,brand,price,link\n';
  const chunk: string[] = [];
  for (let index = 0; index < records; index += 1) {
    chunk.push(
      `SKU-${index},"Widget ${index}, model ${index % 97}",Brand${index % 500},${(index % 9_000) / 100 + 1},https://retailer.example/p/${index}\n`,
    );
    if (chunk.length === 1_000) {
      yield chunk.join('');
      chunk.length = 0;
    }
  }
  if (chunk.length > 0) yield chunk.join('');
}

/** Run the whole pipeline over `records` rows and report peak heap growth. */
async function measure(records: number): Promise<{ peakBytes: number; mapped: number }> {
  global.gc?.();
  const baseline = process.memoryUsage().heapUsed;
  let peak = 0;
  let mapped = 0;

  for await (const record of streamFeedRecords(syntheticFeed(records), PARSE_OPTIONS)) {
    const result = mapFeedRecord(record, MAPPING);
    if (result.normalized !== null) mapped += 1;
    // Sampling rather than measuring every record: `memoryUsage()` is a
    // syscall, and calling it two million times would measure the measurement.
    if (mapped % 10_000 === 0) {
      const used = process.memoryUsage().heapUsed - baseline;
      if (used > peak) peak = used;
    }
  }
  return { peakBytes: peak, mapped };
}

describe('a large feed processes with bounded memory (acceptance 1)', () => {
  it('holds peak heap FLAT as the feed grows eightfold', async () => {
    const small = await measure(SCALE);
    const large = await measure(SCALE * 8);

    // The vacuity floor: a measurement over nothing is bounded trivially, and a
    // pipeline that silently produced no records would pass every assertion
    // below without processing a byte.
    expect(small.mapped).toBe(SCALE);
    expect(large.mapped).toBe(SCALE * 8);

    // The real assertion. A buffered implementation shows peak heap tracking
    // the input — roughly eightfold here — where a streamed one shows the same
    // number twice, because the largest live object is one record.
    expect(large.peakBytes - small.peakBytes).toBeLessThan(ALLOWED_DRIFT_BYTES);
  }, 600_000);
});
