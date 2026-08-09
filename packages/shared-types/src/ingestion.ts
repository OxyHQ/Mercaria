/**
 * The external ingestion framework's vocabulary — issue #62, bound by ADR 0002
 * D19/D22.
 *
 * #62 is the provider-neutral machinery around observations that already exist:
 * `catalog_sources` and `source_records` (D19) are the store, #58 is the
 * matcher, #57 is the offer. What this file adds is the vocabulary for the
 * things NOBODY owned yet — a source's configuration and status, its versioned
 * RIGHTS, the health class of one refresh, the outcome of one fetched record,
 * and the normalized shape an adapter must hand over.
 *
 * Every tuple below is a closed value set the schema's CHECK constraints are
 * rendered from (`text` + CHECK, never a pg enum — `db/schema/CONVENTIONS.md`).
 * Adding a value is a code change plus an additive migration in the same PR.
 *
 * ## The two disjoint unions, and what they make unrepresentable
 *
 * {@link CATALOG_SOURCE_RIGHTS} names the nine things Mercaria may be permitted
 * to do with a source's data. {@link CATALOG_SOURCE_PAYLOAD_FIELDS} names every
 * key that may be STORED from a provider payload, and
 * {@link CATALOG_SOURCE_FORBIDDEN_PAYLOAD_FIELDS} names credential-shaped keys
 * that may never join it. The two payload tuples are DISJOINT and a gate fails
 * the build if they ever intersect — the `RetailCostComponentKind` /
 * `RetailForbiddenComponentKind` device (#120), applied to the one place a
 * provider's access token realistically reaches production: a payload bag
 * somebody stored wholesale.
 */

import type { OfferAvailability } from './offer';

/**
 * The lifecycle of one ingesting source (issue source definition 11).
 *
 * `draft` is where a source is CONFIGURED but authorises nothing: a freshly
 * registered source permits no display, no storage and no refresh until a
 * policy version is reviewed and activated, which is the "controlled extraction
 * must have an explicit policy/terms review before activation" rule holding for
 * every source kind rather than only for extraction.
 *
 * `paused` and `failed` are deliberately different. `paused` is somebody's
 * decision to stop refreshing; `failed` is the source's own doing and stays
 * refreshable, because a source that answered 500 once must retry without a
 * person re-enabling it. Collapsing them would make an outage indistinguishable
 * from an operator's intervention, which is exactly the distinction an incident
 * needs.
 */
export type CatalogSourceStatus = 'draft' | 'active' | 'paused' | 'revoked' | 'failed';

export const CATALOG_SOURCE_STATUSES: readonly CatalogSourceStatus[] = [
  'draft',
  'active',
  'paused',
  'revoked',
  'failed',
];

/** The statuses under which a source may still be refreshed automatically. */
export const CATALOG_SOURCE_REFRESHABLE_STATUSES: readonly CatalogSourceStatus[] = [
  'active',
  'failed',
];

/** The statuses under which a source's already-stored facts may still be shown. */
export const CATALOG_SOURCE_DISPLAYABLE_STATUSES: readonly CatalogSourceStatus[] = [
  'active',
  'paused',
  'failed',
];

/**
 * The nine rights issue §"Rights and controlled extraction" enumerates.
 *
 * They are NAMES rather than booleans in a bag so a refusal can say which one
 * is missing: "this source may not have affiliate parameters appended" is
 * actionable and "forbidden" is not. `services/ingestion/rights.ts` answers in
 * these terms and `catalog_source_policies` carries one column per member.
 */
export type CatalogSourceRight =
  | 'store'
  | 'cache'
  | 'display_price'
  | 'display_media'
  | 'outbound_link'
  | 'affiliate_params'
  | 'index'
  | 'automated_refresh'
  | 'extraction';

export const CATALOG_SOURCE_RIGHTS: readonly CatalogSourceRight[] = [
  'store',
  'cache',
  'display_price',
  'display_media',
  'outbound_link',
  'affiliate_params',
  'index',
  'automated_refresh',
  'extraction',
];

/**
 * How much freedom an extraction source has (issue rights 9).
 *
 * `disallowed` is the default and the only value a source may hold without a
 * recorded terms review. There is deliberately no `unrestricted`: extraction is
 * the source type of last resort, so its most permissive value still names the
 * agreement (`contracted`) that authorises it.
 */
export type CatalogSourceExtractionMode = 'disallowed' | 'robots_respecting' | 'contracted';

export const CATALOG_SOURCE_EXTRACTION_MODES: readonly CatalogSourceExtractionMode[] = [
  'disallowed',
  'robots_respecting',
  'contracted',
];

/** The lifecycle of one rights/terms policy version. */
export type CatalogSourcePolicyStatus = 'draft' | 'active' | 'superseded';

export const CATALOG_SOURCE_POLICY_STATUSES: readonly CatalogSourcePolicyStatus[] = [
  'draft',
  'active',
  'superseded',
];

/**
 * The ten health classes issue §"Health / error states" asks to be
 * DIFFERENTIATED, plus `unknown` for a source nothing has yet run against.
 *
 * They are the outcome of one RUN, not a mood: `catalog_source_runs.outcome`
 * carries one and `catalog_source_configs.health_state` carries the latest. The
 * distinction that costs money is `full_feed_success` versus everything else —
 * {@link CATALOG_SOURCE_RETIRING_OUTCOMES} is the only set that may retire
 * offers the source stopped publishing, so a rate limit or a parse failure can
 * never mass-expire a healthy catalogue.
 */
export type CatalogSourceHealthState =
  | 'unknown'
  | 'full_feed_success'
  | 'partial_feed'
  | 'auth_failure'
  | 'rate_limit'
  | 'source_outage'
  | 'schema_drift'
  | 'rights_suspended'
  | 'parse_failure'
  | 'matching_ambiguity'
  | 'anomalous_change';

export const CATALOG_SOURCE_HEALTH_STATES: readonly CatalogSourceHealthState[] = [
  'unknown',
  'full_feed_success',
  'partial_feed',
  'auth_failure',
  'rate_limit',
  'source_outage',
  'schema_drift',
  'rights_suspended',
  'parse_failure',
  'matching_ambiguity',
  'anomalous_change',
];

/**
 * The ONLY outcome that authorises retirement of unseen offers.
 *
 * A retirement sweep says "the source no longer publishes this", and a run that
 * did not enumerate the whole feed has not established that about anything. A
 * `partial_feed` is deliberately excluded even though it succeeded in part:
 * "the half I read did not mention it" is not evidence about the half I did not
 * read. This tuple IS issue §"Health" rule "do not mass-expire healthy offers
 * because one refresh failed", and `health.ts` reads no other list.
 */
export const CATALOG_SOURCE_RETIRING_OUTCOMES: readonly CatalogSourceHealthState[] = [
  'full_feed_success',
];

/**
 * A fetch failure an adapter may report, in the framework's own vocabulary.
 *
 * A SUBSET of the health states: an adapter can observe an auth failure, a rate
 * limit, an outage, a drifted schema or an unparseable page, and it cannot
 * observe a rights suspension (Mercaria's own decision), a matching ambiguity
 * (downstream of the adapter) or an anomalous change (a comparison against what
 * Mercaria already held). Keeping the adapter's vocabulary narrower than the
 * framework's is what stops a provider module classifying a Mercaria decision.
 */
export type CatalogSourceFetchFailureKind =
  | 'auth_failure'
  | 'rate_limit'
  | 'source_outage'
  | 'schema_drift'
  | 'parse_failure';

export const CATALOG_SOURCE_FETCH_FAILURE_KINDS: readonly CatalogSourceFetchFailureKind[] = [
  'auth_failure',
  'rate_limit',
  'source_outage',
  'schema_drift',
  'parse_failure',
];

/** What kind of pass a run is. */
export type CatalogSourceRunKind = 'backfill' | 'incremental' | 'webhook' | 'manual';

export const CATALOG_SOURCE_RUN_KINDS: readonly CatalogSourceRunKind[] = [
  'backfill',
  'incremental',
  'webhook',
  'manual',
];

/** The lifecycle of one run. */
export type CatalogSourceRunStatus = 'pending' | 'running' | 'completed' | 'failed';

export const CATALOG_SOURCE_RUN_STATUSES: readonly CatalogSourceRunStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
];

/**
 * What happened to ONE fetched record at intake — a partition, not a list.
 *
 * Every record an adapter hands over gets exactly one of these, which is what
 * makes `catalog_source_runs_intake_total_check` (`fetched = stored + unchanged
 * + rejected + quarantined`) a real vacuity floor rather than a bound. #60's
 * counters CHECK, ported: a page that swallowed a record cannot write a run row
 * at all.
 */
export type CatalogSourceIntakeOutcome = 'stored' | 'unchanged' | 'rejected' | 'quarantined';

export const CATALOG_SOURCE_INTAKE_OUTCOMES: readonly CatalogSourceIntakeOutcome[] = [
  'stored',
  'unchanged',
  'rejected',
  'quarantined',
];

/**
 * Why a record never became an observation.
 *
 * `stale_observation` is the one worth reading twice: a delivery carrying an
 * OLDER `sourceUpdatedAt` than the current fact is refused rather than applied,
 * which is issue §"PostgreSQL concurrency" rule 3, and it is recorded rather
 * than dropped so a source publishing its feed out of order is visible.
 */
export type CatalogSourceRejectionReason =
  | 'missing_external_id'
  | 'missing_title'
  | 'unsupported_object_kind'
  | 'schema_drift'
  | 'parse_failure'
  | 'payload_too_large'
  | 'rights_withheld'
  | 'stale_observation'
  | 'duplicate_in_page'
  | 'anomalous_change';

export const CATALOG_SOURCE_REJECTION_REASONS: readonly CatalogSourceRejectionReason[] = [
  'missing_external_id',
  'missing_title',
  'unsupported_object_kind',
  'schema_drift',
  'parse_failure',
  'payload_too_large',
  'rights_withheld',
  'stale_observation',
  'duplicate_in_page',
  'anomalous_change',
];

/**
 * How far one external OBJECT has got through the staged pipeline.
 *
 * This is the ingestion domain's own state machine and deliberately NOT a copy
 * of `match_decisions.outcome`: it spans stages the matcher knows nothing about
 * (an offer materialized, an object retired, a payload quarantined) and it is
 * never read as the matcher's verdict. The verdict is reachable through
 * `catalog_source_objects.last_match_decision_id` and is never re-derived from
 * this column — the `orders.payment` pointer relationship, one domain over.
 */
export type CatalogSourceObjectState =
  | 'observed'
  | 'matched'
  | 'review_required'
  | 'unmatched'
  | 'offer_current'
  | 'quarantined'
  | 'retired';

export const CATALOG_SOURCE_OBJECT_STATES: readonly CatalogSourceObjectState[] = [
  'observed',
  'matched',
  'review_required',
  'unmatched',
  'offer_current',
  'quarantined',
  'retired',
];

/** Why an object is being held out of the pipeline. */
export type CatalogSourceQuarantineReason =
  | 'schema_drift'
  | 'parse_failure'
  | 'rights_withheld'
  | 'anomalous_change';

export const CATALOG_SOURCE_QUARANTINE_REASONS: readonly CatalogSourceQuarantineReason[] = [
  'schema_drift',
  'parse_failure',
  'rights_withheld',
  'anomalous_change',
];

/** An identifier scheme a source may assert, in the source's own words. */
export type NormalizedIdentifierScheme = 'gtin' | 'ean' | 'upc' | 'isbn' | 'mpn';

export const NORMALIZED_IDENTIFIER_SCHEMES: readonly NormalizedIdentifierScheme[] = [
  'gtin',
  'ean',
  'upc',
  'isbn',
  'mpn',
];

/** One identifier assertion, as the adapter read it. Validation is #58's. */
export interface NormalizedSourceIdentifier {
  readonly scheme: NormalizedIdentifierScheme;
  readonly value: string;
}

/** One observed option assignment — "Colour: Black". */
export interface NormalizedSourceOption {
  readonly name: string;
  readonly value: string;
}

/** A money pair in the SOURCE's own currency. Never converted here. */
export interface NormalizedSourceMoney {
  readonly amount: number;
  readonly currency: string;
}

/**
 * What every adapter must produce, and the whole of issue §"Normalization".
 *
 * Fifteen groups, every one optional except the title, because a feed that does
 * not declare a brand has not declared a brand — and #58 rule 5 says a missing
 * attribute LOWERS confidence rather than being invented. An adapter that
 * cannot fill a field leaves it absent; nothing here has a zero or an empty
 * string standing in for silence.
 *
 * **It carries no canonical id, no merchant id and no offer id, and that is the
 * write boundary as a TYPE.** An adapter has nothing to say about which
 * canonical product this is (#58 decides), which merchant is selling (the
 * source's own binding decides) or what the resulting offer looks like (#57
 * decides). There is no field here through which a provider module could
 * express one.
 */
export interface NormalizedSourceRecord {
  /** The source's own words for who is selling. A HINT; it resolves nothing. */
  readonly merchantHint?: string;
  /** The source's own words for the channel. A hint, same reasoning. */
  readonly storefrontHint?: string;
  /** The source's own words for the brand or manufacturer. */
  readonly brandHint?: string;
  readonly title: string;
  readonly description?: string;
  readonly model?: string;
  readonly identifiers: readonly NormalizedSourceIdentifier[];
  /** The seller's own SKU. Source-scoped and never compared across sources. */
  readonly merchantSku?: string;
  readonly options: readonly NormalizedSourceOption[];
  readonly price?: NormalizedSourceMoney;
  readonly compareAtPrice?: NormalizedSourceMoney;
  /** The source's own condition WORDING, verbatim. #90 maps it; adapters never do. */
  readonly conditionLabel?: string;
  readonly availability?: OfferAvailability;
  readonly availableQuantity?: number;
  readonly delivery?: {
    readonly cost?: NormalizedSourceMoney;
    readonly freeOver?: NormalizedSourceMoney;
    readonly minDays?: number;
    readonly maxDays?: number;
  };
  readonly returnPolicy?: {
    readonly url?: string;
    readonly windowDays?: number;
    readonly policyRef?: string;
  };
  /** ISO 3166-1 alpha-2. */
  readonly country?: string;
  readonly region?: string;
  /** BCP-47. */
  readonly language?: string;
  /** Oxy file ids or absolute media URLs, as the source published them. */
  readonly media: readonly string[];
  /** The canonical/source URL of the offer page, exactly as given. */
  readonly sourceUrl?: string;
  /** An affiliate URL the network supplied SEPARATELY, when it did. */
  readonly affiliateUrl?: string;
  readonly categoryKey?: string;
  /** ISO-8601, the source's own timestamps. */
  readonly sourceCreatedAt?: string;
  readonly sourceUpdatedAt?: string;
}

/**
 * The ALLOW-LIST of keys that may be written into `source_records.payload`.
 *
 * `services/payments/redact.ts` is the precedent and the reasoning is the same
 * one it states: a deny-list is correct only until the provider adds a field,
 * which is exactly when a sensitive one appears. Nothing outside this tuple is
 * stored, so a provider that starts returning `access_token` beside its prices
 * changes nothing about what Mercaria holds.
 *
 * The key NAMES are `services/matching/subject-loader.ts`'s read contract, not
 * a fresh invention: that loader already reads `title`, `brand`, `gtin`, `sku`,
 * `attributes` and the rest off a stored payload, so the normalized projection
 * is written in exactly the vocabulary the matcher expects. A second naming
 * here would mean every ingested record matched on a title and nothing else.
 */
export const CATALOG_SOURCE_PAYLOAD_FIELDS = [
  'title',
  'description',
  'brand',
  'model',
  'gtin',
  'ean',
  'upc',
  'isbn',
  'mpn',
  'sku',
  'category',
  'condition',
  'attributes',
  'merchant',
  'storefront',
  'price',
  'currency',
  'compareAtPrice',
  'compareAtCurrency',
  'availability',
  'availableQuantity',
  'delivery',
  'returnPolicy',
  'country',
  'region',
  'language',
  'media',
  'url',
  'affiliateUrl',
  'sourceCreatedAt',
  'sourceUpdatedAt',
] as const;

export type CatalogSourcePayloadField = (typeof CATALOG_SOURCE_PAYLOAD_FIELDS)[number];

/**
 * Keys that may NEVER be stored or logged from a provider payload.
 *
 * Disjoint from {@link CATALOG_SOURCE_PAYLOAD_FIELDS} by a gate, so a plausible
 * future addition to the allow-list that happens to be a credential fails the
 * build. This tuple is not the enforcement — the allow-list is, and it is the
 * only thing the redactor reads. This is the statement of the prohibition as a
 * VALUE, which is what makes "a source's access token is unstorable" checkable
 * rather than a claim in a comment.
 */
export const CATALOG_SOURCE_FORBIDDEN_PAYLOAD_FIELDS = [
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'apiKey',
  'api_key',
  'clientSecret',
  'client_secret',
  'password',
  'secret',
  'authorization',
  'cookie',
  'setCookie',
  'set_cookie',
  'signature',
  'privateKey',
  'private_key',
  'sessionId',
  'session_id',
  'cardNumber',
  'card_number',
  'cvv',
  'iban',
] as const;

export type CatalogSourceForbiddenPayloadField =
  (typeof CATALOG_SOURCE_FORBIDDEN_PAYLOAD_FIELDS)[number];

/**
 * The effective rights of one source at one moment — the answer
 * `services/ingestion/rights.ts` computes and every consumer reads.
 *
 * A RECORD over the nine rights rather than nine booleans, so a consumer asking
 * for a right it forgot to handle is a `tsc` error rather than `undefined`.
 */
export type CatalogSourceRightsVerdict = Readonly<Record<CatalogSourceRight, boolean>>;

/**
 * The PUBLIC provenance answer for one external offer — issue §"Provenance
 * invariant" made a type.
 *
 * Every question that section asks has a field here, and there is deliberately
 * no field for anything else: no source id, no credential reference, no policy
 * note, no internal confidence. `SourceFreshness` (`provenance.ts`) is the
 * narrower public projection this one extends for OPERATORS.
 */
export interface CatalogSourceProvenance {
  readonly sourceName: string;
  readonly sourceKind: string;
  readonly observedAt: string;
  readonly staleAt?: string;
  readonly sourceUpdatedAt?: string;
  readonly normalizationVersion: number;
  readonly policyVersion?: number;
  readonly rights: CatalogSourceRightsVerdict;
  readonly merchantId?: string;
  readonly storefrontId?: string;
  readonly matchDecisionId?: string;
}
