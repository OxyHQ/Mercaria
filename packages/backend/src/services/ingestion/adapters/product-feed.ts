/**
 * The universal product-feed adapter (#63) — a `CatalogSourceAdapter` over a
 * merchant's or a network's own file.
 *
 * ## It reaches no database, and its two dependencies are the reason it can
 *
 * `ingestion-isolation.test.ts` scans this DIRECTORY and fails the build if any
 * module in it imports a repository, a database handle or drizzle — so the wall
 * holds for adapters nobody has written yet. This adapter genuinely needs two
 * things from Postgres: the ACTIVE mapping of the feed it is fetching, and
 * somewhere to put the per-record issues an import found. Both arrive as plain
 * FUNCTION TYPES, satisfied at registration time by
 * `services/feed-import/register.ts`, which lives outside this directory.
 *
 * That is not a way around the gate; it is the gate working. What the gate
 * exists to prevent is a provider module writing into the COMMERCE GRAPH — a
 * canonical product, a merchant, an offer, a match — and neither dependency can:
 * one reads a mapping and one writes a report about a file. The signature is
 * still the write boundary, because `AdapterRecord` has no canonical id, no
 * merchant id and no offer id to put one in.
 *
 * ## One pass, staged once, paged afterwards
 *
 * The first page of a run reads the feed ONCE and writes the mapped candidates
 * to a local JSONL stage; every later page seeks into it by byte offset. See
 * `services/feed-import/staging.ts` for why — the short version is that #62's
 * page contract fits an API and a file is not an API, and the alternatives are
 * holding an HTTP connection open for eight hours or re-downloading the feed
 * once per page.
 *
 * ## `complete` is the field that decides whether a catalogue is retired
 *
 * Three things must all hold before this adapter reports one: the version's
 * delivery mode is `snapshot`, the read reached the END of the feed (no cap, no
 * sample limit), and this is the last page. A `delta` feed can never report it —
 * `FeedCompletionVerdict`'s delta branch has no member that could — and neither
 * can a conditional `304`, which is the trap that would otherwise retire every
 * object a source has on the day its host started answering conditionally.
 */

import type { CatalogSourceKind } from '@mercaria/shared-types';
import {
  CatalogSourceFetchError,
  type AdapterFetchPage,
  type AdapterFetchRequest,
  type AdapterRecord,
  type CatalogSourceAdapter,
} from '../adapter.js';
import { feedCompletionVerdict, mayReportCompleteEnumeration } from '../../feed-import/completion.js';
import { FeedImportRefusal, feedRefusalFetchKind } from '../../feed-import/errors.js';
import type { FeedValidators } from '../../feed-import/fetch.js';
import { openFeedOrigin } from '../../feed-import/open.js';
import type { ResolvedFeedImport } from '../../feed-import/resolve.js';
import {
  buildFeedStage,
  readFeedStageManifest,
  readFeedStagePage,
  type FeedStage,
  type FeedStageManifest,
} from '../../feed-import/staging.js';

/** The provider slug `catalog_source_configs.provider` carries for a feed. */
export const PRODUCT_FEED_PROVIDER = 'product_feed';

/** The two things this adapter needs from Postgres, as functions. */
export interface ProductFeedAdapterDependencies {
  /** The ACTIVE mapping of one feed configuration, or `null`. */
  readonly resolveFeed: (configurationId: string) => Promise<ResolvedFeedImport | null>;
  /** Store the validators a conditional request will present next time. */
  readonly recordValidators: (feed: ResolvedFeedImport, validators: FeedValidators) => Promise<void>;
  /** Turn a staged pass's issues into a `feed_import_reports` row. */
  readonly recordImportReport: (feed: ResolvedFeedImport, stage: FeedStage) => Promise<void>;
}

/** The cursor, as this adapter composes it. Opaque to the framework by contract. */
interface FeedCursor {
  /** The stage's content digest — what makes a rebuild verifiable. */
  readonly d: string;
  /** Byte offset into the staged JSONL. */
  readonly o: number;
  /** How many records have been yielded, for the next page's indices. */
  readonly i: number;
}

export function createProductFeedAdapter(
  dependencies: ProductFeedAdapterDependencies,
): CatalogSourceAdapter {
  const kind: CatalogSourceKind = 'feed';

  return {
    provider: PRODUCT_FEED_PROVIDER,
    kind,
    // A feed is fetched from a URL its owner published or from a file its owner
    // uploaded. Neither is extraction, and declaring it as such would make
    // `assertMayFetch` demand an extraction policy nobody needs to review.
    extraction: false,

    // What a feed TRANSPORT can do, which is not the same question as what one
    // configured feed MEANS (#68 scheduler 1). This adapter serves both a
    // snapshot feed and a delta feed and cannot declare per source, so it
    // declares the union and each source's policy narrows it —
    // `permitted_refresh_modes` is exactly where "this URL publishes deltas"
    // belongs, because it is a fact about that publisher rather than about
    // reading a CSV.
    //
    // Declaring `full_snapshot` here is therefore NOT what authorises retiring
    // an omitted record: `complete` is, and it is computed from the version's
    // own `FeedCompletionVerdict`, so a delta feed handed a `full_snapshot` run
    // by a misconfigured policy still reports an incomplete pass and still
    // retires nothing. Neither `targeted` nor `query_driven` is declared, and
    // that is a capability statement rather than a preference: a feed is one
    // file at one URL, with no call that re-reads a named list of ids and none
    // that answers a query.
    refreshModes: ['full_snapshot', 'incremental'],

    async fetchPage(request: AdapterFetchRequest): Promise<AdapterFetchPage> {
      try {
        return await fetchFeedPage(dependencies, request);
      } catch (error: unknown) {
        if (error instanceof FeedImportRefusal) {
          // A refusal already knows what it is; the framework's vocabulary is a
          // table lookup rather than a judgement made here.
          throw new CatalogSourceFetchError(feedRefusalFetchKind(error.reason), error.message, {
            retryable: error.retryable,
            cause: error,
          });
        }
        throw error;
      }
    },
  };
}

async function fetchFeedPage(
  dependencies: ProductFeedAdapterDependencies,
  request: AdapterFetchRequest,
): Promise<AdapterFetchPage> {
  // A feed source binds its configuration id as its account reference when it
  // is configured, so an absent one and an unresolvable one are the same fact:
  // this run has no mapping. ONE refusal for both, because splitting them would
  // put the distinction in a message nobody can act on differently.
  const feed = await dependencies.resolveFeed(request.sourceAccountRef ?? '');
  if (feed === null) {
    throw new FeedImportRefusal(
      'configuration_missing',
      'This source has no ACTIVE feed mapping. A draft is not a mapping anybody validated, so ' +
        'the pass refuses rather than reading the file under it.',
    );
  }

  const cursor = decodeCursor(request.cursor);
  const startedAt = Date.now();

  if (cursor === null) {
    const built = await stageFeed(dependencies, feed, request.signal);
    if (built === null) {
      // A 304. Zero records, and — critically — NOT an enumeration: reporting
      // one here would retire every object this source has.
      return { records: [], nextCursor: null, complete: false, fetchDurationMs: Date.now() - startedAt };
    }
    await dependencies.recordImportReport(feed, built.stage);
    return page(feed, built.stage.manifest, 0, 0, request.pageSize, Date.now() - startedAt);
  }

  const manifest = await readFeedStageManifest(cursor.d);
  if (manifest !== null) {
    return page(feed, manifest, cursor.o, cursor.i, request.pageSize, Date.now() - startedAt);
  }

  // The stage is gone: this task did not build it, or it was swept. Rebuild it
  // ONCE — not once per page — and resume only if the feed is byte-identical.
  const rebuilt = await stageFeed(dependencies, feed, request.signal);
  if (rebuilt === null) {
    throw new FeedImportRefusal(
      'stage_unavailable',
      'The staged pass is gone and the host answered 304, so it cannot be rebuilt. The next ' +
        'pass starts from the beginning.',
    );
  }
  if (rebuilt.stage.manifest.digest !== cursor.d) {
    // The merchant republished mid-run. Restarting is safe — every write in
    // #62's pipeline converges on a content hash, so records already seen land
    // as `unchanged` — where seeking a stale offset into new content would
    // silently skip products.
    return page(feed, rebuilt.stage.manifest, 0, 0, request.pageSize, Date.now() - startedAt);
  }
  return page(feed, rebuilt.stage.manifest, cursor.o, cursor.i, request.pageSize, Date.now() - startedAt);
}

/** Fetch and stage the whole feed, or report a 304 as `null`. */
async function stageFeed(
  dependencies: ProductFeedAdapterDependencies,
  feed: ResolvedFeedImport,
  signal: AbortSignal | undefined,
): Promise<{ stage: FeedStage } | null> {
  const opened = await openFeedOrigin(feed.origin, signal);
  if (opened.kind === 'not_modified') return null;

  try {
    const stage = await buildFeedStage({
      openBytes: async () => opened.bytes,
      compression: feed.compression,
      encoding: feed.encoding,
      parseOptions: feed.parseOptions,
      mapping: feed.mapping,
    });
    await dependencies.recordValidators(feed, opened.validators);
    return { stage };
  } finally {
    // Every branch, including a refusal mid-stream: a socket left open holds a
    // connection to a merchant's host until the process exits.
    opened.close();
  }
}

/** Read one page out of a staged pass and shape it as the framework expects. */
async function page(
  feed: ResolvedFeedImport,
  manifest: FeedStageManifest,
  byteOffset: number,
  recordIndex: number,
  pageSize: number,
  fetchDurationMs: number,
): Promise<AdapterFetchPage> {
  const read = await readFeedStagePage(manifest.digest, byteOffset, pageSize, recordIndex);
  // One instant for the whole pass, from the stage rather than the clock: #62's
  // contract says an adapter sets `observedAt` "so a batch shares one instant",
  // and a per-page `new Date()` would make the ordering of two pages of one
  // file depend on how long the dispatcher took between ticks.
  const observedAt = new Date(manifest.createdAt);

  const records: AdapterRecord[] = read.records.map((staged) => ({
    externalType: 'offer' as const,
    externalId: staged.externalId,
    observedAt,
    ...(staged.sourceUpdatedAt === null ? {} : { sourceUpdatedAt: staged.sourceUpdatedAt }),
    // The merchant's row is DIGESTED and discarded at stage time; what the
    // framework hashes is that digest, so `source_records.raw_payload_digest`
    // identifies the bytes the merchant published rather than Mercaria's
    // reading of them.
    raw: { feedRecordIndex: staged.index, sourceDigest: staged.sourceDigest },
    normalized: staged.normalized,
  }));

  const complete =
    read.done &&
    mayReportCompleteEnumeration(
      feedCompletionVerdict(feed.deliveryMode, manifest.enumeratedFully),
    );

  return {
    records,
    nextCursor: read.done
      ? null
      : encodeCursor({ d: manifest.digest, o: read.nextByteOffset, i: read.nextRecordIndex }),
    complete,
    fetchDurationMs,
    rateLimitHits: 0,
  };
}

function encodeCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Read a cursor back, or treat it as absent.
 *
 * A cursor that will not decode restarts the pass rather than failing it: the
 * value came from this adapter and went through the framework, so a corrupted
 * one is a bug and re-reading the feed is the recoverable answer. The digest is
 * shape-checked by `staging.ts` before it becomes a path, so a forged cursor
 * cannot name a file.
 */
function decodeCursor(raw: string | null): FeedCursor | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const value = parsed as Partial<FeedCursor>;
    if (typeof value.d !== 'string' || typeof value.o !== 'number' || typeof value.i !== 'number') {
      return null;
    }
    return { d: value.d, o: value.o, i: value.i };
  } catch {
    return null;
  }
}
