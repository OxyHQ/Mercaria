/**
 * The universal product-feed importer's vocabulary — issue #63, feeding the #62
 * ingestion framework.
 *
 * #63 is not a second ingestion pipeline. `catalog_sources` stays the registry,
 * `source_records` stays the observation store, #58 stays the matcher, #57 stays
 * the offer, and #62's `CatalogSourceAdapter` stays the write boundary. What
 * this file adds is the vocabulary for the thing nobody owned: **how a file of
 * somebody else's rows becomes a `NormalizedSourceRecord`** — the formats it may
 * arrive in, the roles its columns may fill, the transforms that may be applied
 * to a value, the ways one record may be refused, and the two delivery modes
 * whose difference decides whether an omitted row means "deleted" or means
 * nothing at all.
 *
 * Every tuple below is a closed value set the schema's CHECK constraints are
 * rendered from (`text` + CHECK, never a pg enum — `db/schema/CONVENTIONS.md`).
 * Adding a value is a code change plus an additive migration in the same PR.
 *
 * ## The three disjoint unions, and what each makes unrepresentable
 *
 * 1. {@link FEED_FIELD_TRANSFORMS} against
 *    {@link FEED_FORBIDDEN_TRANSFORM_KINDS} — a mapping may TRIM a value, split
 *    a list, or read `19.99` as minor units. It may never evaluate an
 *    expression, a formula, a template, a regular-expression replacement or a
 *    script, because a feed is a stranger's file and a mapping is a stranger's
 *    instruction about it. Issue security 4 ("never execute formulas, scripts,
 *    templates or source-provided code") is this disjointness plus the absence
 *    of any column that could hold one.
 * 2. {@link FEED_TOKEN_BEARING_ISSUE_CODES} — the ONLY issue codes whose report
 *    entry may carry an observed value, and they are exactly the three whose
 *    values are drawn from a closed external vocabulary (a currency code, an
 *    availability word, a condition word). Every other entry carries a field
 *    NAME, a record index and nothing else. Issue acceptance 4 asks for a
 *    downloadable error report "without exposing secrets"; a report that holds
 *    no values cannot expose one, and the three exceptions are shape-bounded to
 *    sixteen characters of a restricted alphabet so a credential cannot survive
 *    the filter.
 * 3. {@link FEED_DELIVERY_MODES} — `snapshot` and `delta` are not a nuance of
 *    one setting. A snapshot's completed enumeration is evidence that an
 *    omitted row is gone; a delta's is evidence of nothing at all. #62's
 *    `CATALOG_SOURCE_RETIRING_OUTCOMES` already decides what may retire; this
 *    tuple decides whether the adapter is even ALLOWED to claim the completed
 *    enumeration that rule reads.
 */

import type { OfferAvailability } from './offer';

/**
 * The five wire formats the importer parses (issue §"Supported inputs" 1–4).
 *
 * `csv` and `tsv` are separate members rather than one `delimited` with a
 * delimiter setting, because the delimiter is what a merchant names when they
 * describe their file and a value set that reads like the thing it describes is
 * the one nobody mis-selects. The delimiter is STILL configurable (a semicolon
 * CSV is the European default), which is why both exist: the format names the
 * family and the delimiter names the byte.
 */
export type FeedFormat = 'csv' | 'tsv' | 'xml' | 'json' | 'jsonl';

export const FEED_FORMATS: readonly FeedFormat[] = ['csv', 'tsv', 'xml', 'json', 'jsonl'];

/** The formats whose records are delimited rows rather than nested documents. */
export const FEED_DELIMITED_FORMATS: readonly FeedFormat[] = ['csv', 'tsv'];

/**
 * The formats that need a RECORD PATH to say where the records live.
 *
 * A `jsonl` file's records are its lines and a delimited file's records are its
 * rows; an XML document and a JSON document both need to be told. The CHECK on
 * `feed_configuration_versions` reads this tuple, so "an XML feed without a
 * record path" is refused by the row rather than discovered on the first fetch.
 */
export const FEED_RECORD_PATH_FORMATS: readonly FeedFormat[] = ['xml', 'json'];

/**
 * Compression, as a property of the TRANSFER rather than of the format (issue
 * §"Supported inputs" 4).
 *
 * `gzip` and nothing else, and that is a security decision rather than a
 * scoping one: a gzip member is ONE stream with no entry names, so there is no
 * path for a path-traversal trick to live in. `zip`, `tar` and their relatives
 * carry an entry path per member, which is where every archive path-traversal
 * bug in history has lived, and refusing the container outright makes the
 * attack unrepresentable instead of something a scanner has to catch. A
 * merchant with a zip is told to send the file, which they can always do.
 */
export type FeedCompression = 'none' | 'gzip';

export const FEED_COMPRESSIONS: readonly FeedCompression[] = ['none', 'gzip'];

/**
 * Container formats an upload is refused BY NAME for.
 *
 * Disjoint from {@link FEED_COMPRESSIONS} (a gate asserts it). The refusal
 * naming the container is what turns "unsupported" into an instruction — a
 * merchant who sent a zip is told to send the file, which is an action they can
 * take, where "unsupported compression" is not.
 */
export type FeedForbiddenContainer = 'zip' | 'tar' | 'tar_gz' | 'rar' | 'seven_zip' | 'bzip2' | 'xz';

export const FEED_FORBIDDEN_CONTAINERS: readonly FeedForbiddenContainer[] = [
  'zip',
  'tar',
  'tar_gz',
  'rar',
  'seven_zip',
  'bzip2',
  'xz',
];

/**
 * Text encodings the decoder accepts.
 *
 * Three, and every one of them is an encoding Node's own `TextDecoder`
 * implements — so the decoding is the platform's reading of the bytes and not
 * an approximation of it. A feed in anything else is refused at configuration
 * time with the encoding named, rather than silently mojibaked into a catalogue
 * where every accented product title is wrong and nothing reports an error.
 */
export type FeedEncoding = 'utf-8' | 'utf-16le' | 'latin1';

export const FEED_ENCODINGS: readonly FeedEncoding[] = ['utf-8', 'utf-16le', 'latin1'];

/** Where the bytes come from (issue §"Supported inputs" 5 and 6). */
export type FeedFetchMode = 'url' | 'upload';

export const FEED_FETCH_MODES: readonly FeedFetchMode[] = ['url', 'upload'];

/**
 * What an omitted record MEANS — the most consequential value in this file.
 *
 * A `snapshot` feed publishes the seller's whole catalogue every time, so a row
 * that stops appearing in a COMPLETED enumeration is evidence the seller stopped
 * selling it. A `delta` feed publishes what changed, so a row that does not
 * appear is evidence of nothing whatsoever — and treating its absence as a
 * deletion retires a healthy catalogue on the first successful pass.
 *
 * The two are kept apart here rather than as a boolean on the run because #62's
 * retirement rule is already correct and must not be reimplemented: only a run
 * whose adapter reported `complete` AND whose outcome is in
 * `CATALOG_SOURCE_RETIRING_OUTCOMES` may retire anything. What this tuple
 * decides is whether the adapter may report `complete` at all — a delta feed's
 * completion verdict has no representation that says so
 * (`FeedCompletionVerdict` below), so the framework's rule is reached with the
 * right input rather than bypassed with a second one.
 */
export type FeedDeliveryMode = 'snapshot' | 'delta';

export const FEED_DELIVERY_MODES: readonly FeedDeliveryMode[] = ['snapshot', 'delta'];

/**
 * Whether one pass may authorise retirement.
 *
 * A discriminated union, not a boolean, and its `delta` branch has NO member
 * that could say "complete". So "a delta feed must never expire omitted
 * records" (issue processing 7) is a fact about the type rather than a branch
 * somebody remembered to write — and a future reader looking for the `if` that
 * enforces it will find there is none to get wrong.
 */
export type FeedCompletionVerdict =
  | { readonly deliveryMode: 'snapshot'; readonly enumeratedFully: boolean }
  | { readonly deliveryMode: 'delta' };

/** The lifecycle of one mapping version. The `catalog_source_policies` shape. */
export type FeedConfigurationVersionStatus = 'draft' | 'active' | 'superseded';

export const FEED_CONFIGURATION_VERSION_STATUSES: readonly FeedConfigurationVersionStatus[] = [
  'draft',
  'active',
  'superseded',
];

/**
 * Who manages a configuration, and therefore who may change it.
 *
 * `merchant` configurations are owned by a Mercaria STORE and are reached
 * through `/admin/stores/:storeId/feeds` behind `channels:write` (issue security
 * 6); `operator` configurations have no store and are reached only through the
 * `CATALOG_OPERATOR_OXY_USER_IDS` surface. The two are a column rather than an
 * inference from `store_id is null`, so a query that forgets the tenant
 * predicate is a missing filter on an explicit fact rather than an accident of
 * NULL semantics.
 */
export type FeedConfigurationOwnerKind = 'merchant' | 'operator';

export const FEED_CONFIGURATION_OWNER_KINDS: readonly FeedConfigurationOwnerKind[] = [
  'merchant',
  'operator',
];

/**
 * Every target a feed column may be mapped ONTO (issue §"Feed configuration" 6
 * and 8).
 *
 * These are Mercaria's field names, not Google's: the importer maps a merchant's
 * columns onto the framework's `NormalizedSourceRecord`, and a vocabulary
 * borrowed from one specification would make every other feed read as a
 * deviation from it. Google Merchant conventions are supported by SUGGESTION
 * (`suggestFeedFieldMappings`) rather than by naming — which is issue
 * §"Supported inputs" 7 exactly: "common Google Merchant-style field
 * conventions where they can be mapped without claiming full protocol
 * compatibility".
 */
export type FeedFieldRole =
  // Descriptive
  | 'title'
  | 'description'
  | 'brand'
  | 'model'
  | 'category'
  // Identifiers
  | 'gtin'
  | 'ean'
  | 'upc'
  | 'isbn'
  | 'mpn'
  | 'sku'
  // Commercial
  | 'price'
  | 'price_currency'
  | 'sale_price'
  | 'sale_price_currency'
  | 'availability'
  | 'available_quantity'
  | 'condition'
  // Media and destinations
  | 'image'
  | 'additional_images'
  | 'destination_url'
  | 'affiliate_url'
  // Who is selling
  | 'merchant'
  | 'storefront'
  // Delivery and returns
  | 'delivery_cost'
  | 'delivery_cost_currency'
  | 'delivery_min_days'
  | 'delivery_max_days'
  | 'return_window_days'
  | 'return_policy_url'
  // Market
  | 'country'
  | 'region'
  | 'language'
  // Variant options — three slots, each a name and a value
  | 'option_name_1'
  | 'option_value_1'
  | 'option_name_2'
  | 'option_value_2'
  | 'option_name_3'
  | 'option_value_3'
  // The source's own timestamps
  | 'source_created_at'
  | 'source_updated_at';

export const FEED_FIELD_ROLES: readonly FeedFieldRole[] = [
  'title',
  'description',
  'brand',
  'model',
  'category',
  'gtin',
  'ean',
  'upc',
  'isbn',
  'mpn',
  'sku',
  'price',
  'price_currency',
  'sale_price',
  'sale_price_currency',
  'availability',
  'available_quantity',
  'condition',
  'image',
  'additional_images',
  'destination_url',
  'affiliate_url',
  'merchant',
  'storefront',
  'delivery_cost',
  'delivery_cost_currency',
  'delivery_min_days',
  'delivery_max_days',
  'return_window_days',
  'return_policy_url',
  'country',
  'region',
  'language',
  'option_name_1',
  'option_value_1',
  'option_name_2',
  'option_value_2',
  'option_name_3',
  'option_value_3',
  'source_created_at',
  'source_updated_at',
];

/**
 * The one role without which a record cannot become an observation at all.
 *
 * A title, because `canonicalizeNormalizedRecord` has no absent form for it and
 * a record with none is not a product observation. Everything else a
 * specification calls required is reported as a WARNING on the validation
 * report rather than refused, because a feed missing a description is a worse
 * feed and still a usable one — and refusing it would mean Mercaria declining
 * inventory over a field it does not read.
 *
 * **There is deliberately no `external_id` ROLE.** An object's external id is
 * derived from `feed_configurations.identity_key_fields`, which names the
 * feed's own columns and is frozen by a trigger: identity is not a mapping
 * decision, because a version that changed it would re-mint every object and
 * retire the whole catalogue behind the old ids. A role AND a frozen key would
 * be two answers to one question, and the one that loses is whichever the
 * derivation does not read.
 *
 * **There is deliberately no `variant_group` ROLE either**, and the reason is
 * #58's. Variant grouping reaches the framework as the three option AXES
 * (`option_name_N` / `option_value_N`) plus the identifiers, which is what the
 * matcher resolves canonical identity from. A group id invented by a stranger's
 * exporter is not evidence about Mercaria's catalogue, and storing it where a
 * matcher could read it is the false merge #58 exists to prevent.
 */
export const FEED_REQUIRED_FIELD_ROLES: readonly FeedFieldRole[] = ['title'];

/**
 * Roles whose absence is reported and never refused.
 *
 * The Google Merchant "required" set minus the two above, which is where the
 * distinction between "the framework cannot proceed" and "this feed will sell
 * badly" actually falls.
 */
export const FEED_RECOMMENDED_FIELD_ROLES: readonly FeedFieldRole[] = [
  'description',
  'image',
  'price',
  'availability',
  'destination_url',
];

/** Roles that carry a money AMOUNT and therefore need a currency beside them. */
export const FEED_MONEY_FIELD_ROLES: readonly FeedFieldRole[] = [
  'price',
  'sale_price',
  'delivery_cost',
];

/** The currency role paired with each money role. Rendered into the validator. */
export const FEED_MONEY_CURRENCY_ROLE: Readonly<Record<string, FeedFieldRole>> = {
  price: 'price_currency',
  sale_price: 'sale_price_currency',
  delivery_cost: 'delivery_cost_currency',
};

/**
 * Roles whose values are drawn from a CLOSED vocabulary and may therefore carry
 * a per-source value map (`feed_value_mappings`).
 *
 * A value map exists for exactly the case where a merchant writes `In Stock`
 * and Mercaria stores `in_stock`. It is deliberately not available for a title
 * or a brand: a per-value rewrite table over free text is a find-and-replace
 * engine, which is the transform prohibition arriving through a different door.
 */
export const FEED_MAPPABLE_VALUE_ROLES: readonly FeedFieldRole[] = ['availability', 'condition'];

/**
 * The transforms a mapping may apply to a value.
 *
 * Every one is a TOTAL function of one string with no configuration, which is
 * what keeps them out of the expression business: `split_list` splits on the
 * configured list separator, `strip_identifier_separators` removes the hyphens
 * a publisher pretty-prints an ISBN with. None of them takes a pattern, a
 * template or a second value, so none of them can be handed a program.
 *
 * `money_minor_units` is the one that reads as an odd member and is the most
 * load-bearing. Money on a money role is read as MAJOR units by default
 * (`19.99` at the currency's own precision), because that is what every
 * published feed specification means by a price. A feed that publishes `1999`
 * meaning nineteen euros ninety-nine has to say so, and this transform is how —
 * the alternative is a heuristic on the magnitude, which reads a genuine
 * €1,999.00 as €19.99 and is wrong in the direction that sells things too
 * cheaply.
 */
export type FeedFieldTransform =
  | 'trim'
  | 'collapse_whitespace'
  | 'upper'
  | 'lower'
  | 'strip_html'
  | 'strip_identifier_separators'
  | 'split_list'
  | 'first_of_list'
  | 'money_minor_units'
  | 'parse_integer';

export const FEED_FIELD_TRANSFORMS: readonly FeedFieldTransform[] = [
  'trim',
  'collapse_whitespace',
  'upper',
  'lower',
  'strip_html',
  'strip_identifier_separators',
  'split_list',
  'first_of_list',
  'money_minor_units',
  'parse_integer',
];

/**
 * Transform kinds that may NEVER exist here, stated as a value.
 *
 * Disjoint from {@link FEED_FIELD_TRANSFORMS} by a gate, so a plausible future
 * addition that happens to be an evaluator fails the build. This tuple is not
 * the enforcement — the absence of any column that could hold an expression is,
 * and so is the fact that `applyFeedTransform` takes a transform NAME from a
 * closed set and never a string to interpret. What it buys is that "the
 * importer executes nothing a feed or a mapping supplies" is checkable rather
 * than a claim in a comment. `regex_replace` is in the list on purpose: a
 * source-supplied pattern is both a small language and a denial-of-service
 * primitive.
 */
export type FeedForbiddenTransformKind =
  | 'expression'
  | 'formula'
  | 'template'
  | 'script'
  | 'javascript'
  | 'python'
  | 'jsonata'
  | 'jmespath'
  | 'jsonpath_script'
  | 'xslt'
  | 'xpath_function'
  | 'regex_replace'
  | 'shell'
  | 'sql'
  | 'http_lookup'
  | 'eval';

export const FEED_FORBIDDEN_TRANSFORM_KINDS: readonly FeedForbiddenTransformKind[] = [
  'expression',
  'formula',
  'template',
  'script',
  'javascript',
  'python',
  'jsonata',
  'jmespath',
  'jsonpath_script',
  'xslt',
  'xpath_function',
  'regex_replace',
  'shell',
  'sql',
  'http_lookup',
  'eval',
];

/**
 * How a feed URL is authenticated (issue §"Feed configuration" 3).
 *
 * `query_param` is in the set because it is how the real world works — Awin's
 * feed download URL carries the key as a path segment and several networks put
 * it in the query string — and its presence is exactly why
 * {@link FEED_REDACTED_PLACEHOLDER} and the URL redactor exist: a credential in
 * a URL is a credential in every log line, every error message and every
 * operator projection unless something removes it.
 */
export type FeedAuthKind = 'none' | 'basic' | 'bearer' | 'header' | 'query_param';

export const FEED_AUTH_KINDS: readonly FeedAuthKind[] = [
  'none',
  'basic',
  'bearer',
  'header',
  'query_param',
];

/** What a redacted credential is replaced by, everywhere, in one spelling. */
export const FEED_REDACTED_PLACEHOLDER = '[redacted]';

/**
 * Why ONE record was refused (issue processing 3, acceptance 4).
 *
 * A record-level vocabulary, deliberately separate from #62's
 * `CatalogSourceRejectionReason`: that one classifies what the FRAMEWORK did
 * with a record an adapter handed over, and this one classifies what the
 * IMPORTER found wrong with a row before it ever became one. Collapsing them
 * would make "the source published its feed out of order" and "column 14 is not
 * a number" the same fact.
 */
export type FeedRecordIssueCode =
  | 'missing_required_field'
  | 'empty_value'
  | 'value_too_long'
  | 'unparseable_number'
  | 'negative_amount'
  | 'amount_out_of_range'
  | 'missing_currency'
  | 'unsupported_currency'
  | 'invalid_url'
  | 'insecure_url'
  | 'invalid_identifier'
  | 'unknown_availability'
  | 'unknown_condition'
  | 'duplicate_external_id'
  | 'record_too_large'
  | 'unmapped_role'
  | 'malformed_record';

export const FEED_RECORD_ISSUE_CODES: readonly FeedRecordIssueCode[] = [
  'missing_required_field',
  'empty_value',
  'value_too_long',
  'unparseable_number',
  'negative_amount',
  'amount_out_of_range',
  'missing_currency',
  'unsupported_currency',
  'invalid_url',
  'insecure_url',
  'invalid_identifier',
  'unknown_availability',
  'unknown_condition',
  'duplicate_external_id',
  'record_too_large',
  'unmapped_role',
  'malformed_record',
];

/**
 * The three issue codes whose report entry may carry the OBSERVED value.
 *
 * Each of the three is a value drawn from a closed external vocabulary — a
 * currency code, an availability word, a condition word — so knowing which one
 * arrived is the whole diagnosis and the value cannot be a credential, an
 * address or a customer's name. Every other code carries a field NAME, a record
 * index and nothing else, which is `describeRejection`'s rule (#62) applied to
 * the report a merchant downloads.
 *
 * The column additionally enforces {@link FEED_ISSUE_TOKEN_MAX_LENGTH} and a
 * restricted alphabet by CHECK, so the exception is bounded by the schema and
 * not by whoever writes the next issue code.
 */
export const FEED_TOKEN_BEARING_ISSUE_CODES: readonly FeedRecordIssueCode[] = [
  'unsupported_currency',
  'unknown_availability',
  'unknown_condition',
];

/** How much of an observed token a report entry may carry. A currency code is 3. */
export const FEED_ISSUE_TOKEN_MAX_LENGTH = 16;

/**
 * Whether a record-level issue REFUSES the record or merely annotates it.
 *
 * `error` means the record produced no observation; `warning` means it did and
 * something about it is worth a merchant's attention. Both appear in the
 * downloadable report, and the report's own counters partition on this — which
 * is what makes "invalid records are isolated" (acceptance 4) a number a person
 * can check rather than an impression.
 */
export type FeedIssueSeverity = 'error' | 'warning';

export const FEED_ISSUE_SEVERITIES: readonly FeedIssueSeverity[] = ['error', 'warning'];

/** What produced a report (issue processing 9 and 10, Mapping UX 1 and 6). */
export type FeedImportReportMode = 'preview' | 'validation' | 'import';

export const FEED_IMPORT_REPORT_MODES: readonly FeedImportReportMode[] = [
  'preview',
  'validation',
  'import',
];

/**
 * The mode a version must have been reported on before it may be ACTIVATED.
 *
 * `validation`, and only `validation` — a `preview` reads a bounded SAMPLE, so
 * activating on one would mean activating on the first fifty rows of a feed
 * whose fifty-thousandth row is where the mapping breaks. Issue Mapping UX 6
 * ("activate only after a successful validation run") is this tuple plus the
 * `feed_configuration_versions_activation_check` constraint that reads it.
 */
export const FEED_ACTIVATING_REPORT_MODES: readonly FeedImportReportMode[] = ['validation'];

/** The lifecycle of an uploaded feed artefact. */
export type FeedUploadStatus = 'staged' | 'consumed' | 'expired' | 'missing';

export const FEED_UPLOAD_STATUSES: readonly FeedUploadStatus[] = [
  'staged',
  'consumed',
  'expired',
  'missing',
];

/**
 * One mapping instruction: a role, and exactly one way of filling it.
 *
 * `sourceField` XOR `constantValue` — there is no third member, and in
 * particular no expression, no template and no fallback CHAIN. A chain would be
 * a small conditional language and the place it would end up is the place every
 * mapping engine ends up.
 */
export interface FeedFieldMapping {
  readonly role: FeedFieldRole;
  /** The feed's own column name / element name / JSON key. */
  readonly sourceField?: string;
  /** A fixed value for every record — how "every row of this feed is EUR" is said. */
  readonly constantValue?: string;
  readonly transform?: FeedFieldTransform;
}

/** One per-source value rewrite, for a role with a closed target vocabulary. */
export interface FeedValueMapping {
  readonly role: FeedFieldRole;
  readonly sourceValue: string;
  readonly targetValue: string;
}

/**
 * One record's refusal or annotation, as the report stores it.
 *
 * `recordIndex` is the record's ordinal in the feed, which is what lets a
 * merchant find the row in their own file — the file they already have, which
 * is why the report does not need to carry its contents.
 */
export interface FeedRecordIssue {
  readonly code: FeedRecordIssueCode;
  readonly severity: FeedIssueSeverity;
  readonly recordIndex: number;
  readonly role?: FeedFieldRole;
  /** The feed's own column name, when the issue is about a mapped column. */
  readonly sourceField?: string;
  /** Present only for {@link FEED_TOKEN_BEARING_ISSUE_CODES}. */
  readonly observedToken?: string;
  readonly externalId?: string;
}

/**
 * The counts issue processing 10 asks a dry run to report.
 *
 * `matched`, `created` and `review` are IDENTIFIER-stage projections and say so:
 * a dry run that consulted #58's matcher would write `match_decisions` rows and
 * blocked-pair records, which is a change, and a dry run that changes something
 * is not one. What can be answered from reads alone is whether a record's
 * identifiers resolve to exactly one canonical variant (`matched`), to more than
 * one (`review`), or to none (`created`, which is a RECOMMENDATION #60 owns
 * acting on). Anything a heuristic stage would have decided is outside what a
 * dry run can honestly claim, and the report says so rather than guessing.
 */
export interface FeedDryRunCounts {
  readonly scanned: number;
  readonly valid: number;
  readonly invalid: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly matched: number;
  readonly created: number;
  readonly review: number;
}

/** One sample record as the mapping UI renders it (issue Mapping UX 1 and 3). */
export interface FeedPreviewRecord {
  readonly recordIndex: number;
  readonly externalId?: string;
  /** The feed's own values for the mapped columns, bounded and redacted. */
  readonly sourceValues: Readonly<Record<string, string>>;
  /** What the mapping produced, in Mercaria's vocabulary. */
  readonly normalizedTitle?: string;
  readonly normalizedBrand?: string;
  readonly normalizedPriceMinor?: number;
  readonly normalizedCurrency?: string;
  readonly normalizedAvailability?: OfferAvailability;
  readonly issues: readonly FeedRecordIssue[];
}

/**
 * A suggested mapping the operator has NOT accepted (issue Mapping UX 2).
 *
 * A suggestion is data, never an applied mapping: `suggestFeedFieldMappings`
 * returns these and writes nothing, and the only way a mapping reaches a version
 * is a caller sending it. "Suggest mappings without applying them silently" is
 * the absence of a code path, not a flag.
 */
export interface FeedMappingSuggestion {
  readonly role: FeedFieldRole;
  readonly sourceField: string;
  /** Why it was suggested — an exact header match, a known Google alias, a namespace-stripped match. */
  readonly basis: FeedMappingSuggestionBasis;
}

export type FeedMappingSuggestionBasis =
  | 'exact_role_name'
  | 'google_merchant_alias'
  | 'namespace_stripped'
  | 'normalized_header';

export const FEED_MAPPING_SUGGESTION_BASES: readonly FeedMappingSuggestionBasis[] = [
  'exact_role_name',
  'google_merchant_alias',
  'namespace_stripped',
  'normalized_header',
];
