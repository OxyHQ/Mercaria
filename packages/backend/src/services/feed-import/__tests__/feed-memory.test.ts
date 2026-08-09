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

/**
 * How much peak heap may drift between the two passes, as a multiple of the
 * EXTRA bytes the 8x feed contains.
 *
 * DERIVED from the input rather than a constant, so it scales with `SCALE` and
 * with `FEED_IMPORT_MEMORY_SCALE=full` instead of needing a re-tune whenever
 * CI's memory behaviour shifts. `1` states the property directly: a streaming
 * pipeline holds one record at a time, so it must not retain even a single copy
 * of the additional input.
 *
 * The margins, measured on this feed at the CI scale — 16.0 MB and 132.2 MB of
 * generated CSV, so 116.1 MB of extra input:
 *
 *  - a STREAMED run drifts between -12.5 MB and +40.7 MB across eleven samples.
 *    That is GC jitter and not feed size, and the NEGATIVE samples are what
 *    prove it: a run cannot retain less than nothing, so a spread straddling
 *    zero is noise rather than a small leak.
 *  - a BUFFERED run — records collected into an array before any is mapped —
 *    drifts by 1945 MB, which is 16.8x the extra input, because a parsed record
 *    costs far more than the CSV bytes it came from.
 *  - the bound therefore lands at 116.1 MB: 2.8x above the worst observed
 *    noise, and 16.8x below the buffered signal. That gap is the discriminating
 *    power, and it is why the bound can be loose without going blind.
 *
 * The fixed 24 MB bound this replaces sat INSIDE the noise band — three of
 * those eleven samples exceeded it — so it failed at random on unrelated PRs
 * while distinguishing nothing at that margin.
 */
const ALLOWED_DRIFT_PER_EXTRA_INPUT_BYTE = 1;

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

/**
 * The same feed, counting the bytes it actually yields.
 *
 * Counted as it is generated rather than re-derived from `records`: a second
 * expression for the row format would drift from the generator silently, and
 * the bound is computed from this number.
 */
async function* countedFeed(
  records: number,
  onChunk: (bytes: number) => void,
): AsyncGenerator<string> {
  for await (const chunk of syntheticFeed(records)) {
    onChunk(Buffer.byteLength(chunk));
    yield chunk;
  }
}

/** Run the whole pipeline over `records` rows and report peak heap growth. */
async function measure(
  records: number,
): Promise<{ peakBytes: number; mapped: number; feedBytes: number }> {
  global.gc?.();
  const baseline = process.memoryUsage().heapUsed;
  let peak = 0;
  let mapped = 0;
  let feedBytes = 0;

  for await (const record of streamFeedRecords(
    countedFeed(records, (bytes) => {
      feedBytes += bytes;
    }),
    PARSE_OPTIONS,
  )) {
    const result = mapFeedRecord(record, MAPPING);
    if (result.normalized !== null) mapped += 1;
    // Sampling rather than measuring every record: `memoryUsage()` is a
    // syscall, and calling it two million times would measure the measurement.
    if (mapped % 10_000 === 0) {
      const used = process.memoryUsage().heapUsed - baseline;
      if (used > peak) peak = used;
    }
  }
  return { peakBytes: peak, mapped, feedBytes };
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

    // A second vacuity floor, on the bound's own input: a feed that generated
    // nothing would compute an allowance of zero, and the assertion below would
    // then be trivially unsatisfiable rather than trivially true — but stating
    // it here names the cause instead of failing as a mysterious drift.
    expect(large.feedBytes).toBeGreaterThan(small.feedBytes);

    // The real assertion. A buffered implementation shows peak heap tracking
    // the input — roughly eightfold here — where a streamed one shows the same
    // number twice, because the largest live object is one record.
    const allowedDriftBytes =
      (large.feedBytes - small.feedBytes) * ALLOWED_DRIFT_PER_EXTRA_INPUT_BYTE;
    expect(large.peakBytes - small.peakBytes).toBeLessThan(allowedDriftBytes);
  }, 600_000);
});
