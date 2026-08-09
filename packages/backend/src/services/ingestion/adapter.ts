/**
 * THE ADAPTER CONTRACT (#62 §"Adapter contract").
 *
 * One interface, and everything provider-specific lives behind it: HTTP, auth,
 * pagination, retries, payload shapes, the lot. #63 (affiliate networks), #65
 * (merchant feeds) and #66 (marketplace APIs) each implement this and add no
 * schema of their own, which is issue acceptance 7.
 *
 * ## The write boundary is the SIGNATURE, not a rule anybody follows
 *
 * A {@link CatalogSourceAdapter} receives a request and returns records. It is
 * handed no database, no transaction, no repository and no service; it returns
 * a {@link NormalizedSourceRecord}, which has no canonical id, no merchant id
 * and no offer id to put one in. So issue write boundary 1 — "adapters never
 * create arbitrary canonical Products/Brands/Merchants" — and boundary 7 — "an
 * external source can never make an external offer checkout-native merely by
 * ingestion" — are not policies a provider module could violate and be caught
 * at review. There is no parameter through which to try.
 *
 * `__tests__/ingestion-isolation.test.ts` holds the other half: no module under
 * `services/ingestion/adapters/` may import a repository, a canonical write
 * service, the offer domain or `db/postgres.js`. Between the two, a provider
 * module's only route into the commerce graph is the value it returns.
 *
 * ## A failure is a VALUE from a closed set, not an exception shape
 *
 * `CatalogSourceFetchError` carries a {@link CatalogSourceFetchFailureKind},
 * and that set is deliberately NARROWER than the framework's health vocabulary:
 * an adapter can observe an auth failure, a rate limit, an outage, a drifted
 * schema or an unparseable response, and it cannot observe a rights suspension
 * (Mercaria's decision), a matching ambiguity (downstream of it) or an
 * anomalous change (a comparison against what Mercaria already held). A
 * provider module that could report any of those three would be classifying a
 * decision it has no access to.
 *
 * Anything else an adapter throws is classified `source_outage` and retried —
 * the honest reading of an unrecognised failure from a system Mercaria does not
 * control. It is never `schema_drift`, because guessing that would quarantine a
 * whole feed over a transient socket error.
 */

import type {
  CatalogRefreshMode,
  CatalogSourceFetchFailureKind,
  CatalogSourceKind,
  NormalizedSourceRecord,
  SourceRecordExternalType,
} from '@mercaria/shared-types';

/** What the framework asks an adapter for. */
export interface AdapterFetchRequest {
  /**
   * WHICH source this pass is for — the `catalog_sources` id.
   *
   * An IDENTIFIER, and deliberately nothing more. There is no repository, no
   * handle and no service behind it, so an adapter holding it can do exactly one
   * thing with it: scope a capability it was already constructed with. #65's
   * eBay adapter needs it for both of its ports — the discovery cohort an
   * operator configured for this source, and the tracked items whose continued
   * existence a verification pass re-reads — and the alternative was overloading
   * `sourceAccountRef`, which names a seat at the PROVIDER and would then have
   * meant two things.
   *
   * It changes nothing about the write boundary: an id is not an authority, and
   * `NormalizedSourceRecord` still has nowhere to put a canonical id.
   */
  readonly sourceId: string;
  /**
   * Where to resume, in the ADAPTER's own cursor space. Opaque to the
   * framework, which only stores and returns it: a page token, an offset, a
   * date — whatever the provider paginates by.
   */
  readonly cursor: string | null;
  /** How many records this page may carry. The config's `pageSize`. */
  readonly pageSize: number;
  /**
   * WHERE the credential lives, never the credential.
   *
   * The adapter resolves it (a `connections` row it may read through the
   * connector domain, an environment variable, an SSM path). The framework
   * never holds a plaintext secret and therefore cannot log one.
   */
  readonly credentialRef: string | null;
  /** Which account/feed/seat at the provider this run is for. */
  readonly sourceAccountRef: string | null;
  /**
   * The incremental watermark, when the run has one. `null` asks for a FULL
   * enumeration — the only kind that may retire anything (see `health.ts`).
   */
  readonly since: Date | null;
  /** Markets the source is configured for. Empty means unrestricted. */
  readonly territories: readonly string[];
  /**
   * WHICH refresh this is (#68 scheduler 1).
   *
   * An adapter that cannot enumerate completely never receives
   * `full_snapshot`, because the scheduler reads {@link
   * CatalogSourceAdapter.refreshModes} before opening the task — so an adapter
   * does not have to defend against a mode it declared it cannot do. It is
   * passed anyway because a provider often has a cheaper call for one of them
   * (eBay's `getItems` batches twenty ids; its search does not).
   */
  readonly mode: CatalogRefreshMode;
  /**
   * The external ids to re-read, for a `targeted` refresh and no other mode.
   *
   * Empty for every whole-source mode, which is what
   * `offer_refresh_tasks_mode_subject_check` guarantees one layer down: a
   * snapshot cannot name an object and a targeted refresh must.
   */
  readonly externalIds: readonly string[];
  /** Bounds the fetch; the run's lease is what sets it. */
  readonly signal?: AbortSignal;
}

/**
 * One object the source says is GONE (#68 acceptance 2, freshness input 5).
 *
 * The critical distinction this type exists to make: a removal is a POSITIVE
 * STATEMENT and is therefore evidence from ANY run, complete or not — an eBay
 * item that 404s on a targeted re-read, a feed row carrying a deletion marker.
 * An OMISSION is an inference and is only evidence when the enumeration was
 * complete, which is why omissions are not expressible here at all: an adapter
 * reports what it SAW, and what it did not see is the framework's to interpret
 * against `AdapterFetchPage.complete`.
 *
 * eBay's API License Agreement makes the difference operational rather than
 * pedantic: content must be DELETED once the listing is no longer publicly
 * available, which is a removal, not a staleness.
 */
export interface AdapterRemoval {
  readonly externalType: SourceRecordExternalType;
  readonly externalId: string;
  /** When the source said so. Set by the adapter so a batch shares one instant. */
  readonly observedAt: Date;
}

/** One record, exactly as one adapter read it. */
export interface AdapterRecord {
  /** What the source says this object is. */
  readonly externalType: SourceRecordExternalType;
  /**
   * The source's own id for it, and it must be STABLE across deliveries
   * (contract case 1). An adapter that synthesises one from a position, a
   * timestamp or a hash of the payload makes every refresh look like a new
   * object, which is the failure the contract suite's first case exists to
   * catch.
   */
  readonly externalId: string;
  /** When Mercaria READ it. Set by the adapter so a batch shares one instant. */
  readonly observedAt: Date;
  /** The source's own last-modified, when it publishes one. */
  readonly sourceUpdatedAt?: Date;
  /**
   * The provider's payload, verbatim.
   *
   * It is DIGESTED and then discarded — `redactSourcePayload` builds what is
   * stored from `normalized` alone, and this value never reaches a column or a
   * log line. Keeping it on the record is what lets the digest identify the
   * bytes without retaining them.
   */
  readonly raw: unknown;
  /** The framework's own vocabulary. See {@link NormalizedSourceRecord}. */
  readonly normalized: NormalizedSourceRecord;
}

/** One bounded page. */
export interface AdapterFetchPage {
  readonly records: readonly AdapterRecord[];
  /**
   * Objects the source EXPLICITLY declared gone during this page (#68).
   *
   * Optional because most feeds never say it — a CSV that simply stops
   * containing a row has made no statement — and an adapter that cannot observe
   * a removal must not have to fabricate an empty promise about it.
   */
  readonly removals?: readonly AdapterRemoval[];
  /** `null` when there are no further pages. */
  readonly nextCursor: string | null;
  /**
   * True on the last page of a run that enumerated the source COMPLETELY.
   *
   * This is the single most consequential field an adapter sets, because it is
   * what authorises retirement: "the source no longer publishes this" is only
   * establishable by having read all of it. An adapter that sets it on a
   * partial or incremental pass would mass-expire a healthy catalogue, so
   * `health.ts` requires the run's own outcome to agree, and
   * `catalog_source_runs_retirement_check` requires both.
   */
  readonly complete: boolean;
  /** How long the provider call took, for the latency metric. */
  readonly fetchDurationMs?: number;
  /** How many times the provider answered with a rate limit during this page. */
  readonly rateLimitHits?: number;
}

/**
 * What a provider module implements. Data in, data out.
 *
 * There is deliberately no `write`, no `push` and no lifecycle hook. Ingestion
 * is one-directional here: pushing Mercaria's state back to a platform is the
 * CONNECTOR domain's job (`connector-sync.service.ts`), which owns a store's
 * own shop and has a store's authority to write to it. A source is somebody
 * else's catalogue.
 */
export interface CatalogSourceAdapter {
  /** The machine slug `catalog_source_configs.provider` holds. */
  readonly provider: string;
  /** Which kind of place this is, for the registry row it configures. */
  readonly kind: CatalogSourceKind;
  /**
   * Whether this adapter fetches by CRAWLING rather than through an API or a
   * feed. Read by `assertMayFetch`, which refuses an extraction adapter whose
   * policy does not permit extraction — the "controlled extraction is a source
   * type of last resort" rule enforced at the source of the request rather than
   * by hoping the operator configured the right kind.
   */
  readonly extraction: boolean;
  /**
   * Which refresh modes this adapter can actually perform (#68 scheduler 1).
   *
   * NOT optional, and that is the point. #68 asks that refresh work be
   * "scheduled according to adapter capability", and a defaulted list would
   * make every adapter claim every capability by silence — including
   * `full_snapshot`, the ONE mode that authorises retiring what a pass did not
   * see. An Awin CSV feed declares `full_snapshot`.
   *
   * #65's eBay Browse adapter declares `full_snapshot`, `query_driven` and
   * `targeted`, and the first of those needs its reason stated, because the
   * obvious reading is that it should not: no Browse call enumerates a
   * MARKETPLACE, and none claims to. What `full_snapshot` means here is #68's
   * own definition — the mode that ESTABLISHES ABSENCE — and an eBay pass
   * establishes it by asking eBay about every item MERCARIA TRACKS, twenty ids
   * at a time, which is the set a retirement could act on and the exact
   * question the API License Agreement's deletion obligation turns on. Its
   * discovery half is separately unable to report completeness at all
   * (`services/ebay/cursor.ts`), so the entitlement this declaration grants is
   * still spent only on the half that earns it.
   *
   * A source's own policy may NARROW this (`permitted_refresh_modes`) and can
   * never widen it: a capability is a fact about somebody else's API, and no
   * Mercaria row makes an API able to do something.
   */
  readonly refreshModes: readonly CatalogRefreshMode[];
  fetchPage(request: AdapterFetchRequest): Promise<AdapterFetchPage>;
}

/**
 * A fetch that failed, classified in the adapter's own narrow vocabulary.
 *
 * `retryable` is the adapter's judgement about the PROVIDER, and the framework
 * decides what to do with it. `retryAfterMs` is honoured when the provider
 * supplied one (a `Retry-After` header), because guessing a backoff against a
 * rate limit that told you the answer is how an integration gets banned.
 */
export class CatalogSourceFetchError extends Error {
  readonly kind: CatalogSourceFetchFailureKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: CatalogSourceFetchFailureKind,
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CatalogSourceFetchError';
    this.kind = kind;
    // Auth and schema drift are NOT retryable by default: a wrong credential
    // and a renamed field both fail identically on every attempt, and retrying
    // them is how a source burns its rate limit answering the same 401.
    this.retryable = options.retryable ?? (kind === 'rate_limit' || kind === 'source_outage');
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Read any thrown value as a classified failure.
 *
 * An unrecognised throw becomes a RETRYABLE `source_outage`. That is the honest
 * reading — something in a system Mercaria does not control went wrong and
 * nobody said what — and it is deliberately not `schema_drift`, which would
 * quarantine a whole feed over a socket reset.
 */
export function classifyFetchError(error: unknown): CatalogSourceFetchError {
  if (error instanceof CatalogSourceFetchError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CatalogSourceFetchError('source_outage', message, {
    retryable: true,
    cause: error,
  });
}
