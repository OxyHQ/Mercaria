/**
 * How the importer refuses a WHOLE feed, as a closed set of values.
 *
 * A record-level problem is a {@link FeedRecordIssue} and is isolated: the row
 * is dropped, an entry is written and the pass continues (issue processing 3).
 * This file is the other kind — the feed itself cannot be read, so there is no
 * record to isolate. The two are separate vocabularies because the responses
 * are opposite: an issue never stops a pass and a refusal always does.
 *
 * ## Every reason maps onto ONE of #62's five adapter failure kinds
 *
 * `CatalogSourceFetchFailureKind` is deliberately narrower than the framework's
 * health vocabulary — an adapter may report an auth failure, a rate limit, an
 * outage, a drifted schema or an unparseable response, and nothing else,
 * because it can observe nothing else. {@link feedRefusalFetchKind} is that
 * mapping, written once here so the adapter never has to classify: a refusal
 * knows what it is, and turning it into the framework's word is a table lookup
 * rather than a judgement made at the call site.
 *
 * The mapping is worth reading for the two entries that are NOT the obvious
 * ones. A size or ratio cap is `schema_drift`, not `parse_failure`: the bytes
 * parsed fine, the feed simply became something Mercaria will not accept, and
 * that is a change in the source's shape. And a missing staged upload is
 * `source_outage`, not `auth_failure` — the artefact went with the task that
 * received it, which is Mercaria's own infrastructure and is retryable once the
 * merchant re-uploads.
 */

import type { CatalogSourceFetchFailureKind } from '@mercaria/shared-types';

/**
 * Why a whole feed could not be read.
 *
 * `forbidden_container` is separate from `unsupported_format` on purpose: the
 * first names a decision (Mercaria accepts no multi-entry archive, so path
 * traversal has nowhere to live) and the second names an inability. A merchant
 * told "zip archives are not accepted; send the file itself" can act; one told
 * "unsupported format" cannot.
 *
 * `no_records_mapped` was added by #66 and is the one reason here that is not
 * about reading the FILE. A pass that scanned rows and mapped none of them read
 * the bytes perfectly well and could not make a single record out of them,
 * which is a change in the source's SHAPE — a renamed identity column, a
 * relocated record path, a provider that started serving an error page with a
 * 200. An empty feed is different and is not this: `scanned = 0` is a
 * catalogue with nothing in it, which a complete enumeration is entitled to
 * report and which legitimately retires everything the source had.
 */
export type FeedRefusalReason =
  | 'configuration_missing'
  | 'configuration_incomplete'
  | 'unsupported_format'
  | 'forbidden_container'
  | 'insecure_url'
  | 'blocked_address'
  | 'upstream_unavailable'
  | 'upstream_status'
  | 'unauthorized'
  | 'download_too_large'
  | 'decompressed_too_large'
  | 'compression_ratio_exceeded'
  | 'too_many_records'
  | 'record_too_large'
  | 'malformed_feed'
  | 'entity_declaration_refused'
  | 'record_path_not_found'
  | 'no_records_mapped'
  | 'upload_missing'
  | 'stage_unavailable';

export const FEED_REFUSAL_REASONS: readonly FeedRefusalReason[] = [
  'configuration_missing',
  'configuration_incomplete',
  'unsupported_format',
  'forbidden_container',
  'insecure_url',
  'blocked_address',
  'upstream_unavailable',
  'upstream_status',
  'unauthorized',
  'download_too_large',
  'decompressed_too_large',
  'compression_ratio_exceeded',
  'too_many_records',
  'record_too_large',
  'malformed_feed',
  'entity_declaration_refused',
  'record_path_not_found',
  'no_records_mapped',
  'upload_missing',
  'stage_unavailable',
];

/**
 * A feed the importer will not read, and why.
 *
 * The message is composed from the reason and BOUNDED facts — a limit, a status
 * code, a record path. Never a value from the feed and never the URL, because
 * this text reaches a log line and an operator projection, and a feed URL in
 * this domain is a credential (`protectedColumns.ts`).
 */
export class FeedImportRefusal extends Error {
  readonly reason: FeedRefusalReason;
  /** Whether trying the same feed again could plausibly answer differently. */
  readonly retryable: boolean;

  constructor(
    reason: FeedRefusalReason,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FeedImportRefusal';
    this.reason = reason;
    this.retryable = options.retryable ?? RETRYABLE_REFUSALS.includes(reason);
  }
}

/**
 * The refusals worth trying again, and the ones that will answer identically
 * forever.
 *
 * A misconfigured mapping, a forbidden container and a feed that exceeds a cap
 * are stable facts: retrying them burns a provider's rate limit answering the
 * same question. An outage and a missing artefact are not.
 */
const RETRYABLE_REFUSALS: readonly FeedRefusalReason[] = [
  'upstream_unavailable',
  'upstream_status',
  'stage_unavailable',
];

/**
 * The #62 vocabulary for one refusal.
 *
 * Exhaustive by a `Record` over the union, so a new reason is a `tsc` error
 * here rather than a value that silently classifies as an outage and gets
 * retried until somebody notices the feed has been broken for a week.
 */
const FETCH_KIND_BY_REASON: Readonly<Record<FeedRefusalReason, CatalogSourceFetchFailureKind>> = {
  configuration_missing: 'schema_drift',
  configuration_incomplete: 'schema_drift',
  unsupported_format: 'schema_drift',
  forbidden_container: 'schema_drift',
  insecure_url: 'schema_drift',
  blocked_address: 'schema_drift',
  upstream_unavailable: 'source_outage',
  upstream_status: 'source_outage',
  unauthorized: 'auth_failure',
  download_too_large: 'schema_drift',
  decompressed_too_large: 'schema_drift',
  compression_ratio_exceeded: 'schema_drift',
  too_many_records: 'schema_drift',
  record_too_large: 'schema_drift',
  malformed_feed: 'parse_failure',
  entity_declaration_refused: 'parse_failure',
  record_path_not_found: 'schema_drift',
  no_records_mapped: 'schema_drift',
  upload_missing: 'source_outage',
  stage_unavailable: 'source_outage',
};

/** The framework's word for one refusal. See the docblock for the two surprises. */
export function feedRefusalFetchKind(reason: FeedRefusalReason): CatalogSourceFetchFailureKind {
  return FETCH_KIND_BY_REASON[reason];
}
