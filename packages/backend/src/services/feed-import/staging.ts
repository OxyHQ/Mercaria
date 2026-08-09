/**
 * The staged pass — ONE streaming read of a feed, paged afterwards (#63
 * acceptance 1, processing 8).
 *
 * ## Why a stage exists at all
 *
 * #62's adapter contract is page-based with an opaque cursor, which fits an API
 * exactly: a page is one request with a page token, independent of every other.
 * A FILE is not like that. A cursor into a stream is a byte offset nobody can
 * seek to over HTTP, and the dispatcher drives ONE page per tick — thirty
 * seconds apart by default — so a feed of a million rows at a thousand rows a
 * page is eight hours. Holding an HTTP connection open across that is not a
 * thing that works, and re-downloading the whole file per page is a thousand
 * downloads and a quadratic parse.
 *
 * So the first page of a run performs the whole read ONCE — fetch, decompress,
 * decode, parse, map, validate — and writes the MAPPED candidates to a local
 * JSONL file. Every later page seeks into that file by byte offset, which is
 * O(1) and holds nothing but the page it returns. Memory is bounded at every
 * step: the stage builder never holds more than one record, and the page reader
 * never holds more than `pageSize`.
 *
 * ## The stage is keyed by the feed's own CONTENT DIGEST
 *
 * A task that dies mid-pass leaves a run another task reclaims, with a cursor
 * and no local file. That task rebuilds the stage — one re-download, not one per
 * page — and compares the digest in the cursor against what it just read. Equal
 * means the offsets are still valid and the pass resumes exactly. DIFFERENT
 * means the merchant republished the feed mid-run, and the pass restarts from
 * record zero: re-yielding records already seen is harmless (every write in
 * #62's pipeline converges on a content hash, so they land as `unchanged`),
 * where seeking a stale offset into new content would silently skip products.
 *
 * ## Nothing here writes to the database
 *
 * The stage is a file, the manifest is a file, the issues are a file. What turns
 * them into a `feed_import_reports` row is a caller with a repository —
 * `report.service.ts` for a preview or a validation, and the adapter's injected
 * `recordImportReport` for an import. That separation is what lets the adapter
 * keep the #62 isolation gate: no module under `services/ingestion/adapters/`
 * reaches a repository, a database handle or drizzle.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  FeedCompression,
  FeedEncoding,
  FeedRecordIssue,
  NormalizedSourceRecord,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { boundedBytes, decodeText, decompressBytes, type FeedByteMeter } from './bytes.js';
import { FeedImportRefusal } from './errors.js';
import { mapFeedRecord, type ResolvedFeedMapping } from './mapping.js';
import { streamFeedRecords, type FeedParseOptions } from './parse/index.js';

/** One mapped candidate, as a stage line holds it. Keys are short on purpose. */
interface StagedLine {
  readonly i: number;
  readonly e: string;
  readonly n: NormalizedSourceRecord;
  readonly u?: string;
  /**
   * sha-256 of the merchant's OWN row, as the parser read it.
   *
   * The raw row is digested and DISCARDED here — #62's rule, applied one layer
   * up. What the framework stores as `source_records.raw_payload_digest` is
   * this value, so the digest identifies the bytes the merchant published
   * rather than Mercaria's reading of them, and a mapping change does not make
   * every row look freshly published.
   */
  readonly d: string;
}

/** What one staged pass found. Written beside the records, read by every page. */
export interface FeedStageManifest {
  readonly digest: string;
  readonly scanned: number;
  readonly valid: number;
  readonly invalid: number;
  readonly warnings: number;
  /** True when the read reached the end of the feed without hitting a cap. */
  readonly enumeratedFully: boolean;
  readonly bytesRead: number;
  readonly durationMs: number;
  readonly createdAt: string;
}

/** A staged pass, ready to be paged. */
export interface FeedStage {
  readonly manifest: FeedStageManifest;
  /** Bounded by `FEED_IMPORT_MAX_REPORT_ENTRIES`; the counters above are not. */
  readonly issues: readonly FeedRecordIssue[];
}

/** One page of staged records. */
export interface FeedStagePage {
  readonly records: readonly StagedRecord[];
  readonly nextByteOffset: number;
  readonly nextRecordIndex: number;
  readonly done: boolean;
}

/** One staged record, in the shape an adapter turns into an `AdapterRecord`. */
export interface StagedRecord {
  readonly index: number;
  readonly externalId: string;
  readonly normalized: NormalizedSourceRecord;
  readonly sourceUpdatedAt: Date | null;
  /** sha-256 of the merchant's own row. See {@link StagedLine.d}. */
  readonly sourceDigest: string;
}

function stageDirectory(): string {
  return join(config.feedImport.stagingDir, 'stages');
}

function recordsPath(digest: string): string {
  assertDigest(digest);
  return join(stageDirectory(), `${digest}.records.jsonl`);
}

function manifestPath(digest: string): string {
  assertDigest(digest);
  return join(stageDirectory(), `${digest}.manifest.json`);
}

/**
 * A digest is 64 hex characters and nothing else.
 *
 * The value comes from this module's own hash on the write path and from an
 * adapter CURSOR on the read path — and a cursor is a string the framework
 * stored and handed back, so it is checked before it becomes a path. A digest
 * that fails this is a corrupted cursor, not a traversal, and either way it
 * must not reach the filesystem.
 */
function assertDigest(digest: string): void {
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new FeedImportRefusal('stage_unavailable', 'The staged pass reference is not usable.');
  }
}

export interface BuildStageInput {
  /** Opens the RAW bytes. Called once; the caller owns closing them. */
  readonly openBytes: () => Promise<AsyncIterable<Uint8Array>>;
  readonly compression: FeedCompression;
  readonly encoding: FeedEncoding;
  readonly parseOptions: FeedParseOptions;
  readonly mapping: ResolvedFeedMapping;
  /** Stop after this many records — a PREVIEW's bound (issue Mapping UX 1). */
  readonly sampleLimit?: number;
}

/**
 * Read a feed once, all the way through, writing a stage.
 *
 * The digest is computed over the RAW bytes, so it identifies the artefact the
 * merchant published rather than Mercaria's reading of it — two mapping
 * versions over one file share a digest, which is correct: the stage holds
 * MAPPED records, so it is written under the digest of the bytes AND is
 * rewritten whenever a build runs, and a build only runs at the start of a pass.
 */
export async function buildFeedStage(input: BuildStageInput): Promise<FeedStage> {
  await mkdir(stageDirectory(), { recursive: true });
  const startedAt = Date.now();
  const hash = createHash('sha256');
  const meter: FeedByteMeter = { compressedBytes: 0, decompressedBytes: 0 };

  const temporary = join(stageDirectory(), `pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jsonl`);
  const handle = createWriteStream(temporary);

  let scanned = 0;
  let valid = 0;
  let invalid = 0;
  let warnings = 0;
  let enumeratedFully = false;
  const issues: FeedRecordIssue[] = [];

  const raw = await input.openBytes();
  async function* digested(): AsyncGenerator<Uint8Array> {
    for await (const chunk of raw) {
      hash.update(chunk);
      yield chunk;
    }
  }

  try {
    const bounded = boundedBytes(digested(), config.feedImport.maxDownloadBytes, meter);
    const inflated = decompressBytes(
      bounded,
      input.compression,
      {
        maxDownloadBytes: config.feedImport.maxDownloadBytes,
        maxDecompressedBytes: config.feedImport.maxDecompressedBytes,
        maxCompressionRatio: config.feedImport.maxCompressionRatio,
      },
      meter,
    );
    const text = decodeText(inflated, input.encoding);

    for await (const record of streamFeedRecords(text, input.parseOptions)) {
      scanned += 1;
      const mapped = mapFeedRecord(record, input.mapping);
      for (const issue of mapped.issues) {
        if (issue.severity === 'warning') warnings += 1;
        if (issues.length < config.feedImport.maxReportEntries) issues.push(issue);
      }
      if (mapped.normalized === null || mapped.externalId === null) {
        invalid += 1;
      } else {
        valid += 1;
        const line: StagedLine = {
          i: mapped.index,
          e: mapped.externalId,
          n: mapped.normalized,
          d: digestRawRecord(record.fields),
          ...(mapped.sourceUpdatedAt === null ? {} : { u: mapped.sourceUpdatedAt.toISOString() }),
        };
        if (!handle.write(`${JSON.stringify(line)}\n`)) {
          await new Promise<void>((resolve) => handle.once('drain', () => { resolve(); }));
        }
      }
      if (input.sampleLimit !== undefined && scanned >= input.sampleLimit) break;
    }
    enumeratedFully = input.sampleLimit === undefined;
  } catch (error: unknown) {
    handle.destroy();
    await rm(temporary, { force: true });
    throw error;
  }

  await new Promise<void>((resolve, reject) => {
    handle.end(() => {
      resolve();
    });
    handle.once('error', reject);
  });

  const digest = hash.digest('hex');
  const manifest: FeedStageManifest = {
    digest,
    scanned,
    valid,
    invalid,
    warnings,
    enumeratedFully,
    bytesRead: meter.compressedBytes,
    durationMs: Date.now() - startedAt,
    createdAt: new Date().toISOString(),
  };

  await rm(recordsPath(digest), { force: true });
  await writeFile(manifestPath(digest), JSON.stringify(manifest), 'utf8');
  await rename(temporary, recordsPath(digest));

  return { manifest, issues };
}

/** Read the manifest of a previously staged pass, or nothing. */
export async function readFeedStageManifest(digest: string): Promise<FeedStageManifest | null> {
  try {
    const text = await readFile(manifestPath(digest), 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as FeedStageManifest;
  } catch {
    return null;
  }
}

/**
 * Read one page of staged records, from a byte offset.
 *
 * The offset is a BYTE offset into the JSONL file, so the seek is O(1) whatever
 * page this is — which is the property the whole stage exists for. A partial
 * final line is not emitted: the stream is read until a newline, so a page never
 * hands back half a record.
 */
export async function readFeedStagePage(
  digest: string,
  byteOffset: number,
  limit: number,
  firstRecordIndex: number,
): Promise<FeedStagePage> {
  const path = recordsPath(digest);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new FeedImportRefusal(
      'stage_unavailable',
      'The staged pass is no longer on this task. It will be rebuilt from the source.',
    );
  }
  if (byteOffset >= size) {
    return { records: [], nextByteOffset: byteOffset, nextRecordIndex: firstRecordIndex, done: true };
  }

  const records: StagedRecord[] = [];
  let consumed = 0;
  let pending = '';
  const stream = createReadStream(path, { start: byteOffset, encoding: 'utf8' });

  try {
    for await (const chunk of stream) {
      pending += chunk as string;
      let newline = pending.indexOf('\n');
      while (newline !== -1 && records.length < limit) {
        const line = pending.slice(0, newline);
        consumed += Buffer.byteLength(line, 'utf8') + 1;
        pending = pending.slice(newline + 1);
        const parsed = readStagedLine(line);
        if (parsed !== null) records.push(parsed);
        newline = pending.indexOf('\n');
      }
      if (records.length >= limit) break;
    }
  } finally {
    stream.destroy();
  }

  const nextByteOffset = byteOffset + consumed;
  return {
    records,
    nextByteOffset,
    nextRecordIndex: firstRecordIndex + records.length,
    done: nextByteOffset >= size,
  };
}

function readStagedLine(line: string): StagedRecord | null {
  if (line.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const value = parsed as StagedLine;
  if (typeof value.e !== 'string' || value.n === undefined) return null;
  return {
    index: typeof value.i === 'number' ? value.i : 0,
    externalId: value.e,
    normalized: value.n,
    sourceUpdatedAt: typeof value.u === 'string' ? new Date(value.u) : null,
    sourceDigest: typeof value.d === 'string' ? value.d : '',
  };
}

/**
 * Digest one raw record, deterministically.
 *
 * The field names are SORTED before hashing, so two deliveries whose parser
 * happened to encounter the columns in a different order (an XML feed reordering
 * its children, a JSON exporter changing key order) produce the same digest.
 * Without the sort, a cosmetic reordering would make every row look changed and
 * the whole convergence machinery downstream would re-write the catalogue.
 */
function digestRawRecord(fields: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const name of [...fields.keys()].sort()) {
    hash.update(name);
    hash.update('\u0000');
    hash.update(fields.get(name) ?? '');
    hash.update('\u0001');
  }
  return hash.digest('hex');
}

/**
 * Remove staged passes older than the TTL.
 *
 * A stage is disposable by construction — losing one costs a re-download and
 * nothing else — so the sweep is unconditional and needs no lease. It runs from
 * the same expiry sweeper the retention targets do, because a task whose disk
 * fills with abandoned stages stops serving requests, and that is the failure a
 * feed importer with no sweep produces after a fortnight of interrupted runs.
 */
export async function sweepFeedStages(now: Date = new Date()): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(stageDirectory());
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(stageDirectory(), entry);
    try {
      const info = await stat(path);
      if (now.getTime() - info.mtimeMs > config.feedImport.stageTtlMs) {
        await rm(path, { force: true });
        removed += 1;
      }
    } catch {
      // A stage removed by a concurrent sweep is the outcome this loop wants.
      continue;
    }
  }
  return removed;
}
