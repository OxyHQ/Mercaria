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
  CatalogSourceFetchFailureKind,
  CatalogSourceKind,
  NormalizedSourceRecord,
  SourceRecordExternalType,
} from '@mercaria/shared-types';

/** What the framework asks an adapter for. */
export interface AdapterFetchRequest {
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
  /** Bounds the fetch; the run's lease is what sets it. */
  readonly signal?: AbortSignal;
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
