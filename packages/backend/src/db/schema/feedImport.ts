/**
 * The universal product-feed importer — issue #63, feeding #62's staged
 * pipeline: `feed_configurations`, `feed_configuration_versions`,
 * `feed_field_mappings`, `feed_value_mappings`, `feed_uploads`,
 * `feed_import_reports`, `feed_import_report_entries`.
 *
 * #62 owns the SOURCE — its lifecycle, its nine versioned rights, its cadence,
 * its freshness TTL, its runs and its observations. This module owns the one
 * thing #62 has no vocabulary for: **how a file of somebody else's rows becomes
 * a `NormalizedSourceRecord`**. There is no second source table, no second run
 * table, no second observation table and no second rights model here, and the
 * two places a reader might expect one are stated below because their absence is
 * a decision rather than an omission.
 *
 * ## The five properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **A mapping cannot carry a program.** `feed_field_mappings` has a
 *    `source_field`, a `constant_value` and a `transform` drawn from a closed
 *    tuple — and no fourth column. There is nowhere to put an expression, a
 *    template or a pattern, so issue security 4 ("never execute formulas,
 *    scripts, templates or source-provided code") is enforced by the shape of
 *    the row rather than by a validator somebody could relax.
 * 2. **An object's IDENTITY is not a mapping decision.**
 *    `feed_configurations.identity_key_fields` is frozen by a trigger:
 *    re-keying a feed re-mints every `catalog_source_objects` row, orphaning
 *    every observation, every canonical attachment and every offer behind the
 *    old ids — silently, and looking exactly like a feed that replaced its
 *    whole catalogue overnight. Changing it means a NEW configuration, which is
 *    honest about what it does.
 * 3. **A version's meaning is frozen once it leaves `draft`**, one is active per
 *    configuration, and activation requires a `validation` report — the
 *    `catalog_source_policies` / `fee_schedules` mechanism, plus the
 *    `validated_report_id` foreign key that makes "activate only after a
 *    successful validation run" (issue Mapping UX 6) a NOT NULL rather than a
 *    service check.
 * 4. **A report's counters add up.**
 *    `feed_import_reports_intake_total_check` is `scanned = valid + invalid`,
 *    equality and never `<=` — #60's vacuity floor, ported for the reason it
 *    exists: a pass that swallowed a row must not be able to write a report at
 *    all, so "zero invalid" stops being indistinguishable from "the loop never
 *    ran".
 * 5. **An error report cannot leak a value.** `feed_import_report_entries`
 *    carries a field NAME, a record INDEX and an issue code. The one exception
 *    is `observed_token`, restricted by CHECK to the three issue codes whose
 *    values come from a closed external vocabulary AND to sixteen characters of
 *    a restricted alphabet — a bound a credential cannot survive. This is
 *    `describeRejection`'s rule (#62) applied to a file a merchant downloads.
 *
 * ## What is deliberately NOT here
 *
 * - **No cadence and no freshness TTL.** Issue §"Feed configuration" 9 asks for
 *   an update schedule and a TTL; `catalog_source_configs.fetch_cadence_seconds`
 *   and `.freshness_ttl_seconds` already are them. A feed IS a source, so a
 *   second pair here would be two answers to one question, and the one that
 *   loses is whichever the dispatcher does not read.
 * - **No data-use policy.** Issue §"Feed configuration" 10 asks for a
 *   feed-specific one; `catalog_source_policies` is a reviewed, versioned,
 *   frozen-once-active rights model over exactly the nine rights that decide
 *   what may be stored, displayed, cached, linked and refreshed. A feed-shaped
 *   copy would be a second rights authority, and #62's deferrable
 *   `mercaria_catalog_source_rights_agree` trigger exists precisely because two
 *   representations of a right can disagree.
 * - **No content-hash column.** Issue processing 5 asks for unchanged-record
 *   detection by content hash; `source_records.content_hash` plus the
 *   `catalog_source_objects` convergence key already perform it, and the
 *   importer's job is to produce the same bytes for the same row so that
 *   machinery converges. A hash stored here would be a second one to keep in
 *   step.
 * - **No credential.** `auth_ciphertext` is an AES-256-GCM envelope and is
 *   registered in `protectedColumns.ts`, as is `feed_url` — a feed URL is a
 *   credential in this domain, because the networks that matter carry the key
 *   in the path or the query string.
 */

import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  FEED_AUTH_KINDS,
  FEED_COMPRESSIONS,
  FEED_CONFIGURATION_OWNER_KINDS,
  FEED_CONFIGURATION_VERSION_STATUSES,
  FEED_DELIMITED_FORMATS,
  FEED_DELIVERY_MODES,
  FEED_ENCODINGS,
  FEED_FETCH_MODES,
  FEED_FIELD_ROLES,
  FEED_FIELD_TRANSFORMS,
  FEED_FORMATS,
  FEED_IMPORT_REPORT_MODES,
  FEED_ISSUE_TOKEN_MAX_LENGTH,
  FEED_ISSUE_SEVERITIES,
  FEED_MAPPABLE_VALUE_ROLES,
  FEED_RECORD_ISSUE_CODES,
  FEED_RECORD_PATH_FORMATS,
  FEED_TOKEN_BEARING_ISSUE_CODES,
  FEED_UPLOAD_STATUSES,
} from '@mercaria/shared-types';
import { inList } from '@oxyhq/db';
import { asEnumValues, checkOneOf } from './columns';
import { catalogSources } from './provenance';
import { stores } from './stores';

/** Bound on any stored note, field name or detail in this domain. */
export const FEED_IMPORT_MAX_TEXT_LENGTH = 512;

/** Bound on a feed URL. `safeFetch`'s own `MAX_URL_LENGTH` is 2048. */
export const FEED_URL_MAX_LENGTH = 2_048;

/**
 * `feed_configurations` — one importable feed, and the two facts about it that
 * are NOT versioned.
 *
 * ### Why it is a table and not columns on `catalog_source_configs`
 *
 * Ownership and object identity are properties of the FEED, and #62's config row
 * describes an ingesting source of any kind — an API, a crawl, a marketplace.
 * Twelve always-null columns on it to serve the file-shaped minority is the same
 * argument `catalog_source_configs` itself makes against living on
 * `catalog_sources`, one layer further down. `UNIQUE(source_id)` keeps there
 * being exactly one source identity.
 *
 * ### `identity_key_fields` is frozen, and that is the load-bearing decision
 *
 * The external id every `catalog_source_objects` row is keyed on is derived from
 * these columns of the merchant's own file (issue processing 4). Change the
 * list and every object in the feed gets a new id: the old ones stop being
 * mentioned by a completed enumeration and are RETIRED, the new ones arrive as
 * first-time observations, and the whole thing looks exactly like a seller who
 * replaced their catalogue overnight. `mercaria_feed_configuration_identity_frozen`
 * refuses the UPDATE. Re-keying a feed is a new configuration — which is
 * honest, because it is a new set of objects.
 */
export const feedConfigurations = pgTable(
  'feed_configurations',
  {
    id: generatedId(),
    /**
     * The #62 source this feed IS. RESTRICT for `catalog_source_configs`'
     * reason: nothing deletes a provenance registry row.
     */
    sourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    ownerKind: text({ enum: asEnumValues(FEED_CONFIGURATION_OWNER_KINDS) }).notNull(),
    /**
     * The Mercaria store that manages this feed, for a `merchant` configuration.
     *
     * A real foreign key, unlike the Oxy account ids elsewhere in this schema: a
     * store is Mercaria's own entity, and this column is the tenant boundary
     * every `/admin/stores/:storeId/feeds` read filters on (issue security 6).
     * RESTRICT rather than CASCADE — a deleted store must not silently take its
     * feed's observations' provenance with it.
     */
    storeId: text().references(() => stores.id, { onDelete: 'restrict' }),
    /** A human label, shown in the mapping UI beside the source's own name. */
    label: text().notNull(),
    /**
     * The feed's own columns whose values compose an object's external id
     * (issue processing 4).
     *
     * A LIST rather than one column because a real feed's stable key is
     * frequently composite — an advertiser id plus a merchant SKU, a shop
     * handle plus a variant id. Order is significant and preserved: it is part
     * of the derived id.
     */
    identityKeyFields: text()
      .array()
      .notNull(),
    // ── Conditional-request state (issue §"Supported inputs" 5) ──────────────
    /**
     * What the source's last successful fetch validated with.
     *
     * On `feed_configurations` rather than on a VERSION, because a version is
     * frozen once active and this moves on every pass. It is not a mapping
     * decision — it is a fact about the last conversation with the host.
     *
     * **A `304 Not Modified` is not an enumeration**, and that is the rule this
     * pair exists to make possible AND the trap it introduces. Answering a
     * conditional request with 304 means the catalogue is unchanged, so a
     * snapshot feed's pass sees ZERO records — and a pass that reports a
     * COMPLETE enumeration of zero records retires every object the source has.
     * `feedCompletionVerdict` therefore never reports `enumeratedFully` on the
     * 304 path, and a realdb case pins exactly that.
     */
    lastEtag: text(),
    lastModifiedHeader: text(),
    lastFetchedAt: timestamptz(),

    createdByOxyUserId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'feed_configurations_owner_kind_check',
      t.ownerKind,
      FEED_CONFIGURATION_OWNER_KINDS,
    ),
    check(
      'feed_configurations_validator_length_check',
      sql`(${t.lastEtag} is null or length(${t.lastEtag}) <= 256)
          and (${t.lastModifiedHeader} is null or length(${t.lastModifiedHeader}) <= 128)`,
    ),
    /**
     * The owner kind and the store agree, in both directions.
     *
     * Stated as a biconditional rather than inferred from `store_id is null`,
     * so a query that filters on the kind and a query that filters on the
     * column can never disagree about which configurations a store owns.
     */
    check(
      'feed_configurations_owner_shape_check',
      sql`(${t.ownerKind} = 'merchant') = (${t.storeId} is not null)`,
    ),
    check(
      'feed_configurations_identity_key_present_check',
      sql`array_length(${t.identityKeyFields}, 1) between 1 and 4`,
    ),
    /**
     * Every identity column is a plain field name.
     *
     * Tested on the array's own TEXT form, the `catalog_source_configs`
     * territories device: a CHECK may not contain a subquery so `unnest` is
     * unavailable, and Postgres QUOTES any element containing a comma — so an
     * element with a comma in it fails on the quote character rather than
     * sneaking past as two elements.
     */
    check(
      'feed_configurations_identity_key_shape_check',
      sql`${t.identityKeyFields}::text ~ '^[{]([A-Za-z0-9_:.-]{1,120}(,[A-Za-z0-9_:.-]{1,120})*)?[}]$'`,
    ),
    check(
      'feed_configurations_label_length_check',
      sql`btrim(${t.label}) <> '' and length(${t.label}) <= ${sql.raw(String(FEED_IMPORT_MAX_TEXT_LENGTH))}`,
    ),
    /** PROPERTY: one feed configuration per #62 source, ever. */
    uniqueIndex('feed_configurations_source_key').on(t.sourceId),
    /** The tenant read: this store's feeds. */
    index('feed_configurations_store_idx')
      .on(t.storeId)
      .where(sql`${t.storeId} is not null`),
  ],
);

/**
 * `feed_uploads` — an explicitly uploaded feed artefact (issue §"Supported
 * inputs" 6).
 *
 * ### Path traversal is unrepresentable rather than scanned for
 *
 * Issue security 3 asks for archives to be scanned for "decompression bombs and
 * path tricks". Only a single-member gzip and a plain file are accepted
 * (`FEED_COMPRESSIONS`), and a gzip member has no entry NAME — so there is no
 * path for a traversal to live in, and the scan has nothing to miss. The one
 * name that does exist is the merchant's own filename, and
 * `feed_uploads_filename_shape_check` refuses a separator, a `..`, a control
 * character and a leading dot, so it is a label rather than a location.
 * Decompression bombs are bounded at read time by an absolute output cap AND a
 * ratio cap, because either alone is defeatable.
 *
 * ### The artefact is EPHEMERAL and the row says so
 *
 * Mercaria has no blob store of its own, so a staged upload lives on the task's
 * own disk. `status = 'missing'` is a real state rather than an error: a run
 * whose artefact was staged by a task that has since been replaced refuses with
 * that reason named, instead of importing zero records and reporting a
 * successful enumeration — which is the shape that retires a catalogue.
 */
export const feedUploads = pgTable(
  'feed_uploads',
  {
    id: generatedId(),
    configurationId: text()
      .notNull()
      .references(() => feedConfigurations.id, { onDelete: 'cascade' }),
    /** The merchant's own filename, reduced to a label. */
    filename: text().notNull(),
    /** Bytes as received, before decompression. `bigint` — a feed is not small. */
    byteSize: bigint({ mode: 'number' }).notNull(),
    /** sha-256 of the received bytes, so a re-upload of the same file is recognisable. */
    contentDigest: text().notNull(),
    /**
     * WHERE the staged bytes are, on the task that received them. A path
     * fragment, never an absolute path a caller supplied — composed from the
     * row id by `feed-import/upload.ts`.
     */
    storageKey: text().notNull(),
    compression: text({ enum: asEnumValues(FEED_COMPRESSIONS) }).notNull(),
    status: text({ enum: asEnumValues(FEED_UPLOAD_STATUSES) }).notNull().default('staged'),
    uploadedByOxyUserId: text().notNull(),
    consumedAt: timestamptz(),
    /** The retention deadline. Swept by `expiryTargets.ts`. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('feed_uploads_status_check', t.status, FEED_UPLOAD_STATUSES),
    checkOneOf('feed_uploads_compression_check', t.compression, FEED_COMPRESSIONS),
    /**
     * A filename is a LABEL, not a location.
     *
     * No `/`, no `\`, no `..` anywhere, no leading dot, no control character,
     * bounded. Written as a positive character class rather than a list of
     * forbidden sequences, because a denylist over path syntax is exactly the
     * thing every traversal bug has walked around.
     */
    check(
      'feed_uploads_filename_shape_check',
      sql`${t.filename} ~ '^[A-Za-z0-9][A-Za-z0-9 _.-]{0,199}$' and ${t.filename} !~ '\\.\\.'`,
    ),
    check(
      'feed_uploads_digest_shape_check',
      sql`${t.contentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check('feed_uploads_byte_size_check', sql`${t.byteSize} >= 0`),
    check(
      'feed_uploads_storage_key_shape_check',
      sql`${t.storageKey} ~ '^[A-Za-z0-9_-]{8,128}$'`,
    ),
    check(
      'feed_uploads_consumed_shape_check',
      sql`(${t.status} = 'consumed') = (${t.consumedAt} is not null)`,
    ),
    index('feed_uploads_configuration_idx').on(t.configurationId, t.createdAt),
    /**
     * The EXPIRY SWEEP's own index, leading on the deadline.
     * `findUnsupportedExpiryColumns` fails the build without it.
     */
    index('feed_uploads_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * `feed_configuration_versions` — one mapping VERSION (issue §"Feed
 * configuration" 1–12, Mapping UX 5 and 6).
 *
 * ### Frozen once it leaves `draft`
 *
 * `mercaria_feed_configuration_version_immutable` refuses an UPDATE that changes
 * any format, mapping, auth or activation field on a row past `draft`, and a
 * partial unique keeps one `active` version per configuration. The mechanism is
 * `catalog_source_policies`' and the reason is the same: every stored
 * observation cites the version it was read under, so a version whose meaning
 * could change would silently reinterpret facts already in the catalogue.
 * Rolling back is a NEW version copying an old one (issue Mapping UX 5), never
 * a resurrection — which keeps the chain readable backwards in time.
 *
 * ### Activation cites the run that justified it
 *
 * `validated_report_id` is NOT NULL on an active version, and
 * `feed_import_reports.mode` is CHECKed against
 * `FEED_ACTIVATING_REPORT_MODES` at the service before it is cited. A CHECK
 * cannot reach across tables, so the pair is a NOT NULL foreign key plus a
 * service refusal that names the rule — which is strictly more than a boolean
 * `validated` column, because the report is still there to read.
 */
export const feedConfigurationVersions = pgTable(
  'feed_configuration_versions',
  {
    id: generatedId(),
    configurationId: text()
      .notNull()
      .references(() => feedConfigurations.id, { onDelete: 'cascade' }),
    /** Monotonic per configuration. Cited by every report and every run. */
    version: integer().notNull(),
    status: text({ enum: asEnumValues(FEED_CONFIGURATION_VERSION_STATUSES) })
      .notNull()
      .default('draft'),

    // ── Where the bytes come from (issue feed configuration 2) ───────────────
    fetchMode: text({ enum: asEnumValues(FEED_FETCH_MODES) }).notNull(),
    /**
     * HTTPS only, by CHECK.
     *
     * `safeFetch` validates every hop against the private-range denylist and
     * pins the connection, which is the SSRF defence; this is the separate
     * confidentiality one. A feed fetched over cleartext can be rewritten by
     * anyone on the path, and a rewritten feed is a catalogue of somebody
     * else's choosing — including its prices and its outbound links.
     */
    feedUrl: text(),
    uploadId: text().references(() => feedUploads.id, { onDelete: 'restrict' }),

    // ── How to read them (issue feed configuration 4, 5) ─────────────────────
    format: text({ enum: asEnumValues(FEED_FORMATS) }).notNull(),
    /** One byte, for a delimited format. `\t` is spelled by the `tsv` format. */
    delimiter: text(),
    /** The quote character, for a delimited format. RFC 4180 says `"`. */
    quoteChar: text(),
    encoding: text({ enum: asEnumValues(FEED_ENCODINGS) }).notNull().default('utf-8'),
    compression: text({ enum: asEnumValues(FEED_COMPRESSIONS) }).notNull().default('none'),
    /** Where the records live, for a nested format (issue feed configuration 5). */
    recordPath: text(),
    hasHeaderRow: boolean().notNull().default(false),
    /** What `split_list` splits on, and what joins a multi-image column. */
    listSeparator: text().notNull().default(','),

    // ── Defaults (issue feed configuration 7) ────────────────────────────────
    /**
     * The currency every money value is read in when the feed does not say.
     *
     * Shape-checked and NOT validated against `ALL_CURRENCY_CODES`, exactly as
     * `offers.price_currency` and #62's normalization are: a merchant trades in
     * whatever they trade in. What DOES refuse an unlistable currency is the
     * money parser, which needs `CURRENCY_PRECISION` to read major units as
     * minor ones and reports `unsupported_currency` on the record rather than
     * inventing a precision (issue Mapping UX 4).
     */
    defaultCurrency: text(),
    defaultCountry: text(),
    defaultLanguage: text(),

    // ── What an omitted record means (issue processing 6 and 7) ──────────────
    deliveryMode: text({ enum: asEnumValues(FEED_DELIVERY_MODES) }).notNull().default('delta'),

    // ── Authentication, encrypted (issue feed configuration 3) ───────────────
    authKind: text({ enum: asEnumValues(FEED_AUTH_KINDS) }).notNull().default('none'),
    /** AES-256-GCM, self-describing, key-id prefixed. A PROTECTED column. */
    authCiphertext: text(),
    /** The header or query-parameter NAME. Not a secret; the value is. */
    authParamName: text(),

    // ── Activation (issue Mapping UX 6) ──────────────────────────────────────
    validatedReportId: text().references(() => feedImportReports.id, { onDelete: 'restrict' }),
    activatedAt: timestamptz(),
    activatedByOxyUserId: text(),
    supersededAt: timestamptz(),
    /** The version this one replaced, so the chain reads backwards in time. */
    supersedesVersion: integer(),
    mappingNote: text(),

    createdByOxyUserId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'feed_configuration_versions_status_check',
      t.status,
      FEED_CONFIGURATION_VERSION_STATUSES,
    ),
    checkOneOf('feed_configuration_versions_fetch_mode_check', t.fetchMode, FEED_FETCH_MODES),
    checkOneOf('feed_configuration_versions_format_check', t.format, FEED_FORMATS),
    checkOneOf('feed_configuration_versions_encoding_check', t.encoding, FEED_ENCODINGS),
    checkOneOf('feed_configuration_versions_compression_check', t.compression, FEED_COMPRESSIONS),
    checkOneOf(
      'feed_configuration_versions_delivery_mode_check',
      t.deliveryMode,
      FEED_DELIVERY_MODES,
    ),
    checkOneOf('feed_configuration_versions_auth_kind_check', t.authKind, FEED_AUTH_KINDS),
    check('feed_configuration_versions_version_check', sql`${t.version} >= 1`),
    check(
      'feed_configuration_versions_supersedes_check',
      sql`${t.supersedesVersion} is null or ${t.supersedesVersion} < ${t.version}`,
    ),
    /** Exactly one origin, stated in both directions so neither can be forgotten. */
    check(
      'feed_configuration_versions_fetch_shape_check',
      sql`(${t.fetchMode} = 'url') = (${t.feedUrl} is not null)
          and (${t.fetchMode} = 'upload') = (${t.uploadId} is not null)`,
    ),
    check(
      'feed_configuration_versions_url_shape_check',
      sql`${t.feedUrl} is null
          or (${t.feedUrl} ~ '^https://[^[:space:]]+$'
              and length(${t.feedUrl}) <= ${sql.raw(String(FEED_URL_MAX_LENGTH))})`,
    ),
    /**
     * A nested format states where its records are; a flat one has nothing to
     * state. Both directions, so an XML feed cannot be configured without a
     * record path and a CSV cannot carry a meaningless one.
     */
    check(
      'feed_configuration_versions_record_path_check',
      sql`(${t.format} in (${sql.raw(inList(FEED_RECORD_PATH_FORMATS))})) = (${t.recordPath} is not null)`,
    ),
    check(
      'feed_configuration_versions_record_path_shape_check',
      sql`${t.recordPath} is null or ${t.recordPath} ~ '^[A-Za-z0-9_:.\\[\\]-]{1,200}$'`,
    ),
    /**
     * A delimiter and a quote character belong to a delimited format, and are
     * exactly one character.
     *
     * A multi-character delimiter is not a delimiter, it is a separator regular
     * expression wearing a disguise — which is the transform prohibition
     * arriving through the parser instead of the mapping.
     */
    check(
      'feed_configuration_versions_delimiter_check',
      sql`(${t.format} in (${sql.raw(inList(FEED_DELIMITED_FORMATS))}))
          = (${t.delimiter} is not null and ${t.quoteChar} is not null)`,
    ),
    check(
      'feed_configuration_versions_delimiter_shape_check',
      sql`(${t.delimiter} is null or length(${t.delimiter}) = 1)
          and (${t.quoteChar} is null or length(${t.quoteChar}) = 1)
          and length(${t.listSeparator}) = 1`,
    ),
    /** A header row is a property a delimited feed has and a document does not. */
    check(
      'feed_configuration_versions_header_check',
      sql`${t.format} in (${sql.raw(inList(FEED_DELIMITED_FORMATS))}) or ${t.hasHeaderRow} = false`,
    ),
    check(
      'feed_configuration_versions_currency_shape_check',
      sql`${t.defaultCurrency} is null or ${t.defaultCurrency} ~ '^[A-Z]{3,4}$'`,
    ),
    check(
      'feed_configuration_versions_country_shape_check',
      sql`${t.defaultCountry} is null or ${t.defaultCountry} ~ '^[A-Z]{2}$'`,
    ),
    check(
      'feed_configuration_versions_language_shape_check',
      sql`${t.defaultLanguage} is null or ${t.defaultLanguage} ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`,
    ),
    /**
     * A credential exists exactly when the auth kind says one does, and the
     * two kinds that name a carrier state its name.
     *
     * The half-configuration rule at the row: an `authKind` of `bearer` with no
     * ciphertext is a feed that will fetch unauthenticated and report a 401 as
     * a source outage, forever.
     */
    check(
      'feed_configuration_versions_auth_shape_check',
      sql`(${t.authKind} = 'none') = (${t.authCiphertext} is null)
          and (${t.authKind} in ('header', 'query_param')) = (${t.authParamName} is not null)`,
    ),
    check(
      'feed_configuration_versions_auth_param_shape_check',
      sql`${t.authParamName} is null or ${t.authParamName} ~ '^[A-Za-z0-9_-]{1,64}$'`,
    ),
    /**
     * An active version was ACTIVATED by somebody, on a date, citing the
     * validation report that justified it (issue Mapping UX 6).
     *
     * The report is a foreign key rather than a boolean, so the evidence is
     * still readable months later — which is the difference between "somebody
     * ticked validated" and "here is the run, its counts and its failures".
     */
    check(
      'feed_configuration_versions_activation_check',
      sql`${t.status} = 'draft'
          or (${t.activatedAt} is not null and ${t.activatedByOxyUserId} is not null
              and ${t.validatedReportId} is not null)`,
    ),
    check(
      'feed_configuration_versions_superseded_shape_check',
      sql`(${t.status} = 'superseded') = (${t.supersededAt} is not null)`,
    ),
    check(
      'feed_configuration_versions_note_length_check',
      sql`${t.mappingNote} is null
          or length(${t.mappingNote}) <= ${sql.raw(String(FEED_IMPORT_MAX_TEXT_LENGTH))}`,
    ),
    /** PROPERTY 3 — one version number per configuration, and one ACTIVE version. */
    uniqueIndex('feed_configuration_versions_version_key').on(t.configurationId, t.version),
    uniqueIndex('feed_configuration_versions_active_key')
      .on(t.configurationId)
      .where(sql`${t.status} = 'active'`),
    index('feed_configuration_versions_configuration_idx').on(t.configurationId, t.version),
  ],
);

/**
 * `feed_field_mappings` — one column of the feed, mapped onto one role (issue
 * §"Feed configuration" 6 and 8).
 *
 * ### There is no fourth column, and that is the security property
 *
 * A mapping says WHERE a value comes from (`source_field`) or WHAT it always is
 * (`constant_value`), and optionally which of ten total, configuration-free
 * transforms to apply. There is nowhere to put an expression, a template, a
 * pattern or a fallback chain — and a fallback chain is excluded on purpose,
 * because "use column A, else column B, else the constant" is a conditional
 * language and every mapping engine that grew one kept going.
 */
export const feedFieldMappings = pgTable(
  'feed_field_mappings',
  {
    id: generatedId(),
    versionId: text()
      .notNull()
      .references(() => feedConfigurationVersions.id, { onDelete: 'cascade' }),
    role: text({ enum: asEnumValues(FEED_FIELD_ROLES) }).notNull(),
    /** The feed's own column name, element name or JSON key. */
    sourceField: text(),
    /** A fixed value for every record — how "every row of this feed is EUR" is said. */
    constantValue: text(),
    transform: text({ enum: asEnumValues(FEED_FIELD_TRANSFORMS) }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('feed_field_mappings_role_check', t.role, FEED_FIELD_ROLES),
    checkOneOf('feed_field_mappings_transform_check', t.transform, FEED_FIELD_TRANSFORMS),
    /** Exactly one source of the value. Never zero, never both. */
    check(
      'feed_field_mappings_source_shape_check',
      sql`num_nonnulls(${t.sourceField}, ${t.constantValue}) = 1`,
    ),
    check(
      'feed_field_mappings_source_field_shape_check',
      sql`${t.sourceField} is null or ${t.sourceField} ~ '^[A-Za-z0-9_:.\\[\\] -]{1,200}$'`,
    ),
    check(
      'feed_field_mappings_constant_length_check',
      sql`${t.constantValue} is null
          or length(${t.constantValue}) <= ${sql.raw(String(FEED_IMPORT_MAX_TEXT_LENGTH))}`,
    ),
    /** One mapping per role per version — a role filled twice has no answer. */
    uniqueIndex('feed_field_mappings_role_key').on(t.versionId, t.role),
  ],
);

/**
 * `feed_value_mappings` — one per-source value rewrite (issue §"Feed
 * configuration" 8).
 *
 * Restricted by CHECK to `FEED_MAPPABLE_VALUE_ROLES`, which is availability and
 * condition and nothing else: those two have closed target vocabularies, so a
 * rewrite table is a translation. Allowing one over a title or a brand would be
 * a find-and-replace engine, which is the transform prohibition arriving through
 * a different door.
 */
export const feedValueMappings = pgTable(
  'feed_value_mappings',
  {
    id: generatedId(),
    versionId: text()
      .notNull()
      .references(() => feedConfigurationVersions.id, { onDelete: 'cascade' }),
    role: text({ enum: asEnumValues(FEED_MAPPABLE_VALUE_ROLES) }).notNull(),
    /** The feed's own word, compared case-insensitively after trimming. */
    sourceValue: text().notNull(),
    /** Mercaria's word. Validated against the role's own vocabulary at write. */
    targetValue: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('feed_value_mappings_role_check', t.role, FEED_MAPPABLE_VALUE_ROLES),
    check(
      'feed_value_mappings_value_shape_check',
      sql`btrim(${t.sourceValue}) <> '' and length(${t.sourceValue}) <= 120
          and btrim(${t.targetValue}) <> '' and length(${t.targetValue}) <= 120`,
    ),
    /**
     * One rewrite per (version, role, source value). The source value is stored
     * already lower-cased by the writer, so the unique is what makes `In Stock`
     * and `in stock` converge rather than two rules racing.
     */
    uniqueIndex('feed_value_mappings_key').on(t.versionId, t.role, t.sourceValue),
  ],
);

/**
 * `feed_import_reports` — what one preview, validation or import pass found
 * (issue processing 9 and 10, acceptance 4, Mapping UX 7).
 *
 * ### The counters are a PARTITION and a set of tallies, and the CHECK says which
 *
 * `scanned = valid + invalid` is equality — every record read gets exactly one
 * verdict, so a page that swallowed a row cannot write a report at all. #60's
 * vacuity floor, ported for the reason it exists: a report of zero problems over
 * zero records reads exactly like a clean run.
 *
 * `changed`, `unchanged`, `matched`, `created` and `review` are TALLIES bounded
 * by `valid`, because they answer different questions about the same records —
 * a record can be changed AND match. Writing them as one partition would have
 * been a prettier constraint and a false one.
 */
export const feedImportReports = pgTable(
  'feed_import_reports',
  {
    id: generatedId(),
    configurationId: text()
      .notNull()
      .references(() => feedConfigurations.id, { onDelete: 'cascade' }),
    /**
     * The version this pass read the feed under.
     *
     * RESTRICT, not CASCADE: an active version cites its validating report, so
     * the report must outlive nothing — but a report whose version vanished
     * would be evidence about a mapping nobody can read.
     */
    versionId: text()
      .notNull()
      .references(() => feedConfigurationVersions.id, { onDelete: 'restrict' }),
    mode: text({ enum: asEnumValues(FEED_IMPORT_REPORT_MODES) }).notNull(),

    // ── The intake partition ─────────────────────────────────────────────────
    scanned: integer().notNull().default(0),
    valid: integer().notNull().default(0),
    invalid: integer().notNull().default(0),

    // ── Tallies over the valid records ───────────────────────────────────────
    changed: integer().notNull().default(0),
    unchanged: integer().notNull().default(0),
    matched: integer().notNull().default(0),
    created: integer().notNull().default(0),
    review: integer().notNull().default(0),
    warnings: integer().notNull().default(0),

    /**
     * Whether the pass read the WHOLE feed.
     *
     * A preview reads a bounded sample and is never complete; a validation over
     * a truncated download is not complete either. Retirement never consults
     * this column — #62's run outcome does — but an operator reading a report
     * that says "0 invalid" needs to know whether that was over the whole file.
     */
    enumerationComplete: boolean().notNull().default(false),
    /** Bytes read from the source, before decompression. */
    bytesRead: bigint({ mode: 'number' }).notNull().default(0),
    durationMs: integer().notNull().default(0),
    /** A bounded, redacted note. Never a value from the feed. */
    failureNote: text(),
    requestedByOxyUserId: text().notNull(),
    /** The retention deadline. Swept by `expiryTargets.ts`. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('feed_import_reports_mode_check', t.mode, FEED_IMPORT_REPORT_MODES),
    check(
      'feed_import_reports_counters_non_negative_check',
      sql`${t.scanned} >= 0 and ${t.valid} >= 0 and ${t.invalid} >= 0 and ${t.changed} >= 0
          and ${t.unchanged} >= 0 and ${t.matched} >= 0 and ${t.created} >= 0
          and ${t.review} >= 0 and ${t.warnings} >= 0 and ${t.bytesRead} >= 0
          and ${t.durationMs} >= 0`,
    ),
    /** PROPERTY 4 — the vacuity floor, as a constraint. Equality, never `<=`. */
    check(
      'feed_import_reports_intake_total_check',
      sql`${t.scanned} = ${t.valid} + ${t.invalid}`,
    ),
    check(
      'feed_import_reports_tally_bound_check',
      sql`${t.changed} + ${t.unchanged} <= ${t.valid}
          and ${t.matched} <= ${t.valid} and ${t.created} <= ${t.valid}
          and ${t.review} <= ${t.valid}`,
    ),
    check(
      'feed_import_reports_failure_note_length_check',
      sql`${t.failureNote} is null
          or length(${t.failureNote}) <= ${sql.raw(String(FEED_IMPORT_MAX_TEXT_LENGTH))}`,
    ),
    /** The status read: this configuration's reports, newest first. */
    index('feed_import_reports_configuration_idx').on(t.configurationId, t.createdAt),
    index('feed_import_reports_version_idx').on(t.versionId, t.mode),
    /** The EXPIRY SWEEP's own index, leading on the deadline. */
    index('feed_import_reports_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * `feed_import_report_entries` — the RESIDUAL: every record that was refused or
 * annotated, and why (issue processing 3, acceptance 4).
 *
 * ### It carries no value, and the three exceptions are shape-bounded
 *
 * A field NAME, a record INDEX, an issue code and the record's own external id.
 * A merchant has the file; the index is what lets them find the row, and the
 * report does not need to hand back the contents of something they already
 * hold. That is what makes "downloadable as an error report without exposing
 * secrets" (acceptance 4) a property of the schema rather than of a redactor
 * somebody has to keep current.
 *
 * `observed_token` is the one exception and it is doubly bounded:
 * `feed_import_report_entries_token_shape_check` restricts it to the three issue
 * codes whose values come from a closed external vocabulary, and to sixteen
 * characters of a restricted alphabet. A currency code is three characters and a
 * credential is not sixteen characters of `[A-Za-z0-9 _./-]`.
 *
 * ### Bounded by TRAFFIC, so it is the second table here with a deadline
 *
 * A feed that starts returning malformed rows writes one of these per record per
 * pass. `expires_at` plus an `expiryTargets.ts` entry is what stops that, and it
 * is the reason these are a separate table from the report rather than an array
 * on it: the counts must survive, the per-record detail need not.
 */
export const feedImportReportEntries = pgTable(
  'feed_import_report_entries',
  {
    id: generatedId(),
    reportId: text()
      .notNull()
      .references(() => feedImportReports.id, { onDelete: 'cascade' }),
    /** The record's ordinal in the feed — what a merchant looks up in their file. */
    recordIndex: integer().notNull(),
    issueCode: text({ enum: asEnumValues(FEED_RECORD_ISSUE_CODES) }).notNull(),
    severity: text({ enum: asEnumValues(FEED_ISSUE_SEVERITIES) }).notNull(),
    /** Which Mercaria role the issue is about, when it is about one. */
    role: text({ enum: asEnumValues(FEED_FIELD_ROLES) }),
    /** The feed's own column name. A NAME, never its contents. */
    sourceField: text(),
    /** The record's external id, when the mapping got far enough to derive one. */
    externalId: text(),
    /** See the docblock. Permitted for three issue codes and nothing else. */
    observedToken: text(),
    /** The retention deadline. Swept by `expiryTargets.ts`. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('feed_import_report_entries_code_check', t.issueCode, FEED_RECORD_ISSUE_CODES),
    checkOneOf('feed_import_report_entries_severity_check', t.severity, FEED_ISSUE_SEVERITIES),
    checkOneOf('feed_import_report_entries_role_check', t.role, FEED_FIELD_ROLES),
    check('feed_import_report_entries_index_check', sql`${t.recordIndex} >= 0`),
    check(
      'feed_import_report_entries_source_field_shape_check',
      sql`${t.sourceField} is null
          or length(${t.sourceField}) <= ${sql.raw(String(FEED_IMPORT_MAX_TEXT_LENGTH))}`,
    ),
    check(
      'feed_import_report_entries_external_id_shape_check',
      sql`${t.externalId} is null or length(${t.externalId}) <= 200`,
    ),
    /**
     * PROPERTY 5 — the value exception, bounded twice.
     *
     * Rendered from `FEED_TOKEN_BEARING_ISSUE_CODES` and
     * `FEED_ISSUE_TOKEN_MAX_LENGTH`, the SAME constants the composer reads, so
     * the constraint and the service cannot drift. A token on any other code is
     * refused by the row — including one written by a repair in `psql` during
     * the incident that made somebody want to.
     */
    check(
      'feed_import_report_entries_token_shape_check',
      sql`${t.observedToken} is null
          or (${t.issueCode} in (${sql.raw(inList(FEED_TOKEN_BEARING_ISSUE_CODES))})
              and length(${t.observedToken}) <= ${sql.raw(String(FEED_ISSUE_TOKEN_MAX_LENGTH))}
              and ${t.observedToken} ~ '^[A-Za-z0-9 _./-]+$')`,
    ),
    /** The download read: one report's entries, in feed order. */
    index('feed_import_report_entries_report_idx').on(t.reportId, t.recordIndex),
    /** The diagnosis read: which issue dominates this report. */
    index('feed_import_report_entries_code_idx').on(t.reportId, t.issueCode),
    /** The EXPIRY SWEEP's own index, leading on the deadline. */
    index('feed_import_report_entries_expiry_idx').on(t.expiresAt),
  ],
);
