/**
 * The Awin adapter (#66) — a `CatalogSourceAdapter` over ONE advertiser's
 * product feed.
 *
 * ## It is #63's importer with a network in front of it
 *
 * Everything between "bytes arrive" and "a `NormalizedSourceRecord` exists" is
 * #63's and is CALLED rather than copied: `buildFeedStage` (which composes
 * `boundedBytes` → `decompressBytes` → `decodeText` → `streamFeedRecords` →
 * `mapFeedRecord`), `readFeedStagePage`, `feedCompletionVerdict` and
 * `mayReportCompleteEnumeration`. That is issue rule 1, and it is checkable:
 * `awin-isolation.test.ts` fails the build if this domain grows a CSV reader, a
 * money parser, an external-id join or a content-hash scheme of its own.
 *
 * What #66 adds around it is the four things a NETWORK needs and a merchant's
 * own file does not: a per-advertiser mapping built from the columns the feed
 * declared, a fleet-wide call budget keyed on the publisher ACCOUNT, a
 * validated tracking link, and a per-advertiser quality measurement taken in
 * the same pass.
 *
 * ## It reaches no database, and its dependencies are the reason it can
 *
 * `ingestion-isolation.test.ts` scans this DIRECTORY and fails the build if any
 * module in it imports a repository, a database handle or drizzle — so the wall
 * holds for adapters nobody has written yet. This adapter genuinely needs three
 * things from Postgres: which advertiser this source is, somewhere to put the
 * measurement, and the network lease. All three arrive as plain FUNCTION TYPES,
 * satisfied at registration time by `services/awin/register.ts`, which lives
 * outside this directory.
 *
 * That is not a way around the gate; it is the gate working. What the gate
 * exists to prevent is a provider module writing into the COMMERCE GRAPH — a
 * canonical product, a merchant, an offer, a match — and none of the three can.
 * The write boundary is still the SIGNATURE: `AdapterRecord` has no canonical
 * id, no merchant id and no offer id to put one in.
 *
 * ## `complete` is the field that decides whether a catalogue is retired
 *
 * An Awin feed is a SNAPSHOT — the whole of an advertiser's catalogue, every
 * time — so the delivery mode is a constant here where #63 reads it from a
 * merchant's configuration. It is stated through #63's own
 * `feedCompletionVerdict` rather than as a bare `true`, so the three ways a
 * pass can fail to be an enumeration still apply: a conditional `304` is not
 * one (it carries no records, and reading it as a complete enumeration of zero
 * would retire every object the advertiser has), a pass that stopped at a cap
 * is not one, and only the LAST page may report it.
 */

import type { AwinFeedColumn, AwinQualityCounts, CatalogSourceKind } from '@mercaria/shared-types';
import {
  CatalogSourceFetchError,
  type AdapterFetchPage,
  type AdapterFetchRequest,
  type AdapterRecord,
  type CatalogSourceAdapter,
} from '../adapter.js';
import {
  feedCompletionVerdict,
  mayReportCompleteEnumeration,
} from '../../feed-import/completion.js';
import { FeedImportRefusal, feedRefusalFetchKind } from '../../feed-import/errors.js';
import type { FeedValidators } from '../../feed-import/fetch.js';
import {
  buildFeedStage,
  readFeedStageManifest,
  readFeedStagePage,
  type FeedStage,
  type FeedStageManifest,
} from '../../feed-import/staging.js';
import { declaredAwinColumns } from '../../awin/mapping.js';
import {
  assessAwinTrackingLink,
  withAssessedAwinTracking,
} from '../../awin/tracking.js';
import {
  createAwinQualityMeter,
  observeAwinRecord,
  readAwinQualityCounts,
} from '../../awin/quality.js';
import type { ResolvedFeedMapping } from '../../feed-import/mapping.js';
import type { ResolvedAwinFeed } from '../../awin/resolve.js';

/** The provider slug `catalog_source_configs.provider` carries for Awin. */
export const AWIN_FEED_PROVIDER = 'awin_feed';

/** What one staged Awin pass produced, beside #63's own stage. */
export interface AwinStagedPass {
  readonly stage: FeedStage;
  readonly declaredColumns: readonly AwinFeedColumn[];
  readonly counts: AwinQualityCounts;
  readonly validators: FeedValidators;
}

/** The three things this adapter needs from outside `adapters/`. */
export interface AwinAdapterDependencies {
  /** Which advertiser, account, feed, rights and budget this run is for. */
  readonly resolveFeed: (sourceAccountRef: string | null) => Promise<ResolvedAwinFeed>;
  /**
   * Open the feed, stage it, and measure it — all under the network lease.
   *
   * ONE function rather than three, because the lease has to be HELD across the
   * whole download: a lease released at the response headers would let N tasks
   * stream N feeds concurrently under a concurrency bound of two, which is the
   * arithmetic that gets a publisher account suspended. Splitting it would make
   * that a call-ordering rule somebody has to remember.
   *
   * `null` is a conditional `304` — no bytes, and NOT an enumeration.
   */
  readonly stageFeed: (
    resolved: ResolvedAwinFeed,
    signal: AbortSignal | undefined,
  ) => Promise<AwinStagedPass | null>;
  /** Persist what the pass read and what it measured. */
  readonly recordImport: (resolved: ResolvedAwinFeed, pass: AwinStagedPass) => Promise<void>;
}

/** The cursor, as this adapter composes it. Opaque to the framework by contract. */
interface AwinCursor {
  /** The stage's content digest — what makes a rebuild verifiable. */
  readonly d: string;
  /** Byte offset into the staged JSONL. */
  readonly o: number;
  /** How many records have been yielded, for the next page's indices. */
  readonly i: number;
}

export function createAwinFeedAdapter(
  dependencies: AwinAdapterDependencies,
): CatalogSourceAdapter {
  // `affiliate_network`, which is what makes #62's own `offerKindFor` produce an
  // `affiliate` offer when the rights permit affiliate parameters. It is a
  // statement about what this source IS, not a preference: an Awin advertiser's
  // catalogue reaches Mercaria through a network that attributes the click.
  const kind: CatalogSourceKind = 'affiliate_network';

  return {
    provider: AWIN_FEED_PROVIDER,
    kind,
    // A feed downloaded from the URL its publisher documented is not extraction,
    // and declaring it as such would make `assertMayFetch` demand an extraction
    // policy nobody needs to review — while quietly implying Mercaria crawls a
    // network that publishes a download endpoint.
    extraction: false,
    // What a feed TRANSPORT can do (#68 scheduler 1). An Awin feed is one file
    // at one URL: there is no call that re-reads a named list of ids and none
    // that answers a query, so neither `targeted` nor `query_driven` is
    // declared. Declaring `full_snapshot` is NOT what authorises retiring an
    // omitted record — `complete` is, and it comes from the verdict below.
    refreshModes: ['full_snapshot', 'incremental'],

    async fetchPage(request: AdapterFetchRequest): Promise<AdapterFetchPage> {
      try {
        return await fetchAwinPage(dependencies, request);
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

async function fetchAwinPage(
  dependencies: AwinAdapterDependencies,
  request: AdapterFetchRequest,
): Promise<AdapterFetchPage> {
  const resolved = await dependencies.resolveFeed(request.sourceAccountRef);
  const cursor = decodeCursor(request.cursor);
  const startedAt = Date.now();

  if (cursor === null) {
    const pass = await dependencies.stageFeed(resolved, request.signal);
    if (pass === null) {
      // A 304. Zero records, and — critically — NOT an enumeration: reporting
      // one here would retire every object this advertiser has.
      return {
        records: [],
        nextCursor: null,
        complete: false,
        fetchDurationMs: Date.now() - startedAt,
      };
    }
    await dependencies.recordImport(resolved, pass);
    return page(pass.stage.manifest, 0, 0, request.pageSize, Date.now() - startedAt, resolved);
  }

  const manifest = await readFeedStageManifest(cursor.d);
  if (manifest !== null) {
    return page(manifest, cursor.o, cursor.i, request.pageSize, Date.now() - startedAt, resolved);
  }

  // The stage is gone: this task did not build it, or it was swept. Rebuild it
  // ONCE — not once per page — and resume only if the feed is byte-identical.
  const rebuilt = await dependencies.stageFeed(resolved, request.signal);
  if (rebuilt === null) {
    throw new FeedImportRefusal(
      'stage_unavailable',
      'The staged pass is gone and Awin answered 304, so it cannot be rebuilt. The next pass ' +
        'starts from the beginning.',
    );
  }
  await dependencies.recordImport(resolved, rebuilt);
  if (rebuilt.stage.manifest.digest !== cursor.d) {
    // The advertiser republished mid-run. Restarting is safe — every write in
    // #62's pipeline converges on a content hash, so records already seen land
    // as `unchanged` — where seeking a stale offset into new content would
    // silently skip products.
    return page(rebuilt.stage.manifest, 0, 0, request.pageSize, Date.now() - startedAt, resolved);
  }
  return page(
    rebuilt.stage.manifest,
    cursor.o,
    cursor.i,
    request.pageSize,
    Date.now() - startedAt,
    resolved,
  );
}

/**
 * Read one page out of a staged pass and shape it as the framework expects.
 *
 * This is where the tracking assessment is APPLIED, which is deliberately not
 * where it is measured. A verdict computed at stage time and carried in the
 * staged line would be a stored copy of a derivation over three inputs — the
 * rights, the membership and the URL — and a pass that spans hours can outlive
 * a rights withdrawal or a suspension. Re-deriving it here means the LAST
 * decision before a record leaves the adapter is made against what is true now,
 * and `assessAwinTrackingLink` is pure so the two calls cannot disagree about
 * one row.
 */
async function page(
  manifest: FeedStageManifest,
  byteOffset: number,
  recordIndex: number,
  pageSize: number,
  fetchDurationMs: number,
  resolved: ResolvedAwinFeed,
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
    // The advertiser's row is DIGESTED and discarded at stage time; what the
    // framework hashes is that digest, so `source_records.raw_payload_digest`
    // identifies the bytes Awin published rather than Mercaria's reading of
    // them.
    raw: { feedRecordIndex: staged.index, sourceDigest: staged.sourceDigest },
    // A deep link Mercaria may not hand over never reaches the framework at
    // all, so #62's own `affiliate_params` branch produces the right offer with
    // no new mechanism and no second authority for the offer's kind. The
    // DESTINATION is untouched — adapter rule 10, and why disclosure and
    // reconciliation both have an answer no tracking layer can rewrite.
    normalized: withAssessedAwinTracking(
      staged.normalized,
      assessAwinTrackingLink({
        candidate: staged.normalized.affiliateUrl,
        membershipStatus: resolved.advertiser.membershipStatus,
        rights: resolved.rights,
      }),
    ),
  }));

  return {
    records,
    nextCursor: read.done
      ? null
      : encodeCursor({ d: manifest.digest, o: read.nextByteOffset, i: read.nextRecordIndex }),
    // An Awin feed IS a snapshot — the whole of an advertiser's catalogue, every
    // time — so the mode is a constant here where #63 reads it from a merchant's
    // configuration. Stated through #63's own verdict rather than as a bare
    // `true`, so a pass that stopped at a cap still reports an incomplete
    // enumeration and still retires nothing.
    complete:
      read.done &&
      mayReportCompleteEnumeration(feedCompletionVerdict('snapshot', manifest.enumeratedFully)),
    fetchDurationMs,
    rateLimitHits: 0,
  };
}

/**
 * Stage one advertiser's feed, mapping and measuring it in the SAME pass.
 *
 * Exported so `services/awin/register.ts` can satisfy `stageFeed` without this
 * module holding a network client or a database handle: the caller opens the
 * bytes under the lease and hands them in, and everything from there is #63's
 * pipeline plus #66's per-record observation.
 *
 * It MEASURES and changes nothing. The tracking assessment it takes feeds the
 * quality snapshot; the one that decides what leaves the adapter is taken in
 * `page`, against what is true when the record is handed over. See `page`'s
 * docblock for why that separation is load-bearing rather than duplication.
 */
export async function stageAwinFeed(input: {
  resolved: ResolvedAwinFeed;
  mapping: ResolvedFeedMapping;
  openBytes: () => Promise<AsyncIterable<Uint8Array>>;
  validators: FeedValidators;
  /**
   * Stop after this many records — what a pre-activation SAMPLE reads
   * (`AWIN_SAMPLE_SIZE`), and #63's own `sampleLimit` passed straight through.
   *
   * A capped pass sets `enumeratedFully: false` on the manifest, so it can
   * never report a completed enumeration and can never retire anything. That is
   * the third of the three ways a pass fails to be an enumeration, and it is
   * what makes sampling a real advertiser's feed safe to do before it is
   * activated.
   */
  sampleLimit?: number;
}): Promise<AwinStagedPass> {
  const meter = createAwinQualityMeter();
  const observedColumns = new Set<string>();

  const stage = await buildFeedStage({
    openBytes: input.openBytes,
    // Awin's download parameter is `compression=gzip`, and `openFeedStream`
    // asks for `accept-encoding: identity` — so the gzip is the BODY rather
    // than a transport encoding, which is exactly what `decompressBytes`
    // expects to be handed.
    compression: 'gzip',
    encoding: 'utf-8',
    parseOptions: input.resolved.parseOptions,
    mapping: input.mapping,
    ...(input.sampleLimit === undefined ? {} : { sampleLimit: input.sampleLimit }),
    observe: (raw, mapped) => {
      // Which columns this advertiser actually publishes, read from the rows
      // rather than from a configuration. Awin ships only the columns an
      // advertiser MAPPED (#64 §6, Awin rule 2), so this is a per-advertiser
      // FACT that changes when they edit their own feed — and the union across
      // rows rather than the first row's keys, because a CSV row with trailing
      // empty cells legitimately parses to fewer fields.
      for (const name of raw.fields.keys()) observedColumns.add(name);

      // The same assessment `page` applies, taken here for the MEASUREMENT.
      // Both call `assessAwinTrackingLink` with the same three inputs rather
      // than one storing a verdict for the other to read, because a verdict
      // carried across a staged pass is a second representation that a mapping
      // change or a membership change can make stale — and the function is pure.
      observeAwinRecord(meter, {
        raw,
        mapped,
        tracking: assessAwinTrackingLink({
          candidate: mapped.normalized?.affiliateUrl,
          membershipStatus: input.resolved.advertiser.membershipStatus,
          rights: input.resolved.rights,
        }),
      });
    },
  });

  // A pass that scanned rows and mapped NONE of them read the bytes perfectly
  // well and could not make a record out of any of them, which is a change in
  // the source's shape rather than a catalogue of nothing: a renamed identity
  // column, a relocated record path, an error page served with a 200. An EMPTY
  // feed (`scanned = 0`) is deliberately not this — it is a catalogue with
  // nothing in it, which a complete enumeration is entitled to report and which
  // legitimately retires everything the advertiser had.
  if (stage.manifest.scanned > 0 && stage.manifest.valid === 0) {
    throw new FeedImportRefusal(
      'no_records_mapped',
      `This feed produced ${String(stage.manifest.scanned)} rows and no usable records. The pass ` +
        'refuses rather than reporting a complete enumeration of nothing, which would retire ' +
        'the advertiser’s whole catalogue.',
    );
  }

  return {
    stage,
    declaredColumns: declaredAwinColumns(observedColumns),
    counts: readAwinQualityCounts(meter),
    validators: input.validators,
  };
}

function encodeCursor(cursor: AwinCursor): string {
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
function decodeCursor(raw: string | null): AwinCursor | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const value = parsed as Partial<AwinCursor>;
    if (typeof value.d !== 'string' || typeof value.o !== 'number' || typeof value.i !== 'number') {
      return null;
    }
    return { d: value.d, o: value.o, i: value.i };
  } catch {
    return null;
  }
}
