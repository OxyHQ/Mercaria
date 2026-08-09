/**
 * Bytes in, bounded text out — the layer beneath every parser (#63 acceptance
 * 1, security 2 and 3).
 *
 * Three jobs, and the reason they are one file is that all three are places a
 * "just read the whole thing" would be shorter and would be the bug:
 *
 *  1. **A byte cap that refuses rather than truncates.** A truncated feed is a
 *     COMPLETE-looking enumeration over half a catalogue, and #62's retirement
 *     rule would then expire the other half. So every cap here throws, and no
 *     caller has an option that makes it truncate.
 *  2. **Decompression bounded in BOTH dimensions.** An absolute output cap and
 *     a ratio cap, because either alone is defeatable: a cap alone lets a
 *     40 KB member expand to whatever the cap is (and it must be large — a real
 *     feed is gigabytes), and a ratio alone lets a large input expand
 *     proportionally forever. The pair is what makes a bomb a refusal.
 *  3. **Incremental decoding.** A multi-byte character split across two chunks
 *     must not become two replacement characters, so the decoder is stateful
 *     and streamed (`TextDecoder` with `{ stream: true }`) rather than applied
 *     per chunk.
 *
 * ## Nothing here ever holds the feed
 *
 * Every function is an async generator over chunks. The largest thing in memory
 * at any moment is one chunk plus one partial record, which is what makes issue
 * acceptance 1 ("a multi-gigabyte synthetic feed processes with bounded
 * memory") a property of the shape rather than something measured once and
 * hoped for. `__tests__/feed-import-memory.test.ts` measures peak heap at two
 * scales and asserts it does not GROW with the feed, which is the honest form
 * of that claim.
 */

import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import type { FeedCompression, FeedEncoding } from '@mercaria/shared-types';
import { FeedImportRefusal } from './errors.js';

/** The caps a byte pipeline is bounded by. All refusals, never truncations. */
export interface FeedByteLimits {
  /** Bytes read from the source, BEFORE decompression. */
  readonly maxDownloadBytes: number;
  /** Bytes produced BY decompression. */
  readonly maxDecompressedBytes: number;
  /** Decompressed ÷ compressed. Checked continuously, not at the end. */
  readonly maxCompressionRatio: number;
}

/** What a bounded read observed, for the report's `bytesRead`. */
export interface FeedByteMeter {
  compressedBytes: number;
  decompressedBytes: number;
}

/**
 * Pass bytes through, refusing past the download cap.
 *
 * The cap is checked BEFORE the chunk is yielded, so the consumer never sees a
 * byte past the limit — which matters because the consumer is a parser that
 * would otherwise emit a half-record from the last partial chunk.
 */
export async function* boundedBytes(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
  meter: FeedByteMeter,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    meter.compressedBytes += chunk.byteLength;
    if (meter.compressedBytes > maxBytes) {
      throw new FeedImportRefusal(
        'download_too_large',
        `The feed exceeded the ${maxBytes}-byte download limit and was refused rather than truncated.`,
      );
    }
    yield chunk;
  }
}

/**
 * Decompress, bounded in both dimensions.
 *
 * The ratio is evaluated continuously against the bytes seen SO FAR rather than
 * once at the end, because a bomb's whole point is that the end never arrives.
 * It is deliberately not applied until a floor of compressed input has been
 * read (`RATIO_FLOOR_BYTES`): gzip's own header plus a highly compressible
 * first block legitimately produces a huge early ratio on a perfectly ordinary
 * feed, and a check that fires there would refuse real catalogues.
 */
export async function* decompressBytes(
  source: AsyncIterable<Uint8Array>,
  compression: FeedCompression,
  limits: FeedByteLimits,
  meter: FeedByteMeter,
): AsyncGenerator<Uint8Array> {
  if (compression === 'none') {
    for await (const chunk of source) {
      meter.decompressedBytes += chunk.byteLength;
      if (meter.decompressedBytes > limits.maxDecompressedBytes) {
        throw new FeedImportRefusal(
          'decompressed_too_large',
          `The feed exceeded the ${limits.maxDecompressedBytes}-byte content limit.`,
        );
      }
      yield chunk;
    }
    return;
  }

  const gunzip = createGunzip();
  // `Readable.from` over the bounded source, piped through zlib: the pipe is
  // what applies backpressure, so a fast upstream cannot outrun a slow parser
  // and fill memory with queued chunks. Reading the source into the transform
  // by hand would lose exactly that.
  const inflated = Readable.from(source, { objectMode: false }).pipe(gunzip);

  try {
    for await (const chunk of inflated) {
      const buffer = chunk as Buffer;
      meter.decompressedBytes += buffer.byteLength;
      if (meter.decompressedBytes > limits.maxDecompressedBytes) {
        throw new FeedImportRefusal(
          'decompressed_too_large',
          `Decompression exceeded the ${limits.maxDecompressedBytes}-byte content limit; the ` +
            'feed was refused as a decompression bomb.',
        );
      }
      if (
        meter.compressedBytes >= RATIO_FLOOR_BYTES &&
        meter.decompressedBytes > meter.compressedBytes * limits.maxCompressionRatio
      ) {
        throw new FeedImportRefusal(
          'compression_ratio_exceeded',
          `Decompression exceeded the ${limits.maxCompressionRatio}× ratio limit; the feed was ` +
            'refused as a decompression bomb.',
        );
      }
      yield buffer;
    }
  } catch (error: unknown) {
    if (error instanceof FeedImportRefusal) throw error;
    throw new FeedImportRefusal(
      'malformed_feed',
      'The feed could not be decompressed; it is not a single-member gzip stream.',
      { cause: error },
    );
  } finally {
    // A refusal abandons the iterator mid-stream; without this the transform
    // and the socket behind it stay open until the process exits.
    gunzip.destroy();
  }
}

/**
 * Below this many compressed bytes the ratio check is not applied.
 *
 * A gzip member's first block on repetitive text legitimately exceeds any
 * sensible ratio; refusing there would reject real feeds while catching nothing
 * a bomb does that the absolute cap does not already catch at that size.
 */
const RATIO_FLOOR_BYTES = 64 * 1024;

/** Node's own name for each encoding this importer accepts. */
const DECODER_LABEL: Readonly<Record<FeedEncoding, string>> = {
  'utf-8': 'utf-8',
  'utf-16le': 'utf-16le',
  latin1: 'windows-1252',
};

/**
 * Decode bytes to text, incrementally.
 *
 * `{ stream: true }` is the whole point: a UTF-8 character split across a chunk
 * boundary is held until its remaining bytes arrive, where a per-chunk decode
 * would emit two replacement characters and silently corrupt every accented
 * product title at a 64 KB boundary — a bug that appears in maybe one row in
 * ten thousand and never in a small fixture.
 *
 * The leading BOM is dropped once, at the start. A BOM inside a CSV's first
 * header cell is the single most common reason a mapping that looks right
 * matches nothing: the column is named `<BOM>id`, not `id`.
 */
export async function* decodeText(
  source: AsyncIterable<Uint8Array>,
  encoding: FeedEncoding,
): AsyncGenerator<string> {
  const decoder = new TextDecoder(DECODER_LABEL[encoding]);
  let first = true;
  for await (const chunk of source) {
    let text = decoder.decode(chunk, { stream: true });
    if (first && text.length > 0) {
      first = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (text.length > 0) yield text;
  }
  const tail = decoder.decode();
  if (tail.length > 0) yield tail;
}
