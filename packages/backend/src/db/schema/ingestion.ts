/**
 * The external ingestion framework — issue #62, bound by ADR 0002 D19/D22:
 * `catalog_source_configs`, `catalog_source_policies`, `catalog_source_objects`,
 * `catalog_source_runs`, `catalog_source_rejections`.
 *
 * #62 is the machinery AROUND observations that already exist. `catalog_sources`
 * and `source_records` (D19) stay the registry and the observation store, #58
 * stays the matcher and #57 stays the offer. Nothing here is a second copy of
 * any of them.
 *
 * The failure mode that shapes this file is an INGESTION THAT LOOKED FINE: a
 * refresh that failed authentication and retired a healthy catalogue, a
 * re-delivery that overwrote today's price with last week's, a payload bag that
 * quietly carried a provider's access token into production, and an adapter
 * that reached past the framework and minted a canonical product from a title.
 * Every decision below exists to make one of those unrepresentable.
 *
 * ## The six properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **A run's intake counters must ADD UP to what it fetched.**
 *    `catalog_source_runs_intake_total_check` is `fetched = stored + unchanged +
 *    rejected + quarantined`, equality and never `<=`. #60's vacuity floor,
 *    ported: a page that swallowed a record cannot write a run row at all, so
 *    "zero rejected over zero fetched" stops being indistinguishable from "zero
 *    rejected over ten thousand fetched".
 * 2. **Only a COMPLETE enumeration may retire anything.**
 *    `catalog_source_runs_retirement_check` refuses a non-zero
 *    `offers_retired` on any outcome outside
 *    `CATALOG_SOURCE_RETIRING_OUTCOMES`. So "do not mass-expire healthy offers
 *    because one refresh failed" holds against the service, a replay and a
 *    hand-written `UPDATE`, rather than depending on the sweep remembering.
 * 3. **An OLDER observation can never overwrite a newer current fact.**
 *    `mercaria_catalog_source_object_monotonic` refuses an UPDATE that moves
 *    `current_observed_at` or `current_source_updated_at` backwards. The upsert
 *    also carries the predicate, so the ordinary path converges silently and
 *    the trigger is what makes it true of every path.
 * 4. **A source-object's identity is a UNIQUE**, `(source_id, external_type,
 *    external_id)` — issue §"SourceRecord persistence" names exactly this, and
 *    it is what makes two concurrent deliveries of one version converge instead
 *    of racing (issue concurrency 1 and 2).
 * 5. **Rights are a VERSION and are frozen once active** (a trigger plus a
 *    one-active-per-source partial unique — the `fee_schedules` mechanism). A
 *    suspension is a NEW version, so `catalog_source_policies` is an audit
 *    trail by construction: nothing is deleted to withdraw a right.
 * 6. **The projected rights on `catalog_sources` can never disagree with the
 *    policy.** `mercaria_catalog_source_rights_agree` is a DEFERRABLE
 *    constraint trigger on all three tables, so the check runs at COMMIT and no
 *    statement ORDER inside the transaction can defeat it.
 *
 * ## What is deliberately NOT here
 *
 * - **No second observation table.** `source_records` is it. This module adds
 *   the CURRENT-fact row per external object, which `source_records` cannot be:
 *   that table is append-only per content hash and answers "what was seen and
 *   when", while a convergence key and a monotonicity guard need a row that
 *   answers "what is true now".
 * - **No canonical product or variant COLUMN on `catalog_source_objects`.** The
 *   canonical attachment of an observation is a `canonical_*_source_links` row
 *   (ADR 0002 D19) and the verdict behind it is a `match_decisions` row.
 *   `last_match_decision_id` is a POINTER to the second; the first is reached
 *   through `source_records`. A copy of either here would be a second
 *   representation that a #59 merge or a re-evaluation could put out of step —
 *   and it would put this table in the merge census for two entities it has no
 *   opinion about.
 * - **No credential, in any column, on any table.** `credential_ref` on the
 *   config names WHERE a secret lives and is CHECK-shaped so a value that looks
 *   like a secret rather than a locator is refused. It is deliberately NOT in
 *   `protectedColumns.ts`: a locator is not a credential, and protecting it
 *   would force explicit column lists through `provenanceRepository`'s
 *   whole-row reads for no secrecy gained. What keeps it out of every response
 *   is that the operator projection names its fields, checked by both a static
 *   scan and a runtime walk (#92's pair).
 * - **No `jsonb` property bag.** The stored payload lives on
 *   `source_records.payload`, is built from `CATALOG_SOURCE_PAYLOAD_FIELDS` and
 *   is bounded; nothing in this module stores provider-shaped data at all.
 */

import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CATALOG_REFRESH_MODES,
  CATALOG_SNAPSHOT_REFRESH_MODES,
  CATALOG_SOURCE_EXTRACTION_MODES,
  CATALOG_SOURCE_HEALTH_STATES,
  CATALOG_SOURCE_OBJECT_STATES,
  CATALOG_SOURCE_POLICY_STATUSES,
  CATALOG_SOURCE_QUARANTINE_REASONS,
  CATALOG_SOURCE_REJECTION_REASONS,
  CATALOG_SOURCE_RETIREMENT_KINDS,
  CATALOG_SOURCE_RETIRING_OUTCOMES,
  CATALOG_SOURCE_RUN_KINDS,
  CATALOG_SOURCE_RUN_STATUSES,
  CATALOG_SOURCE_STATUSES,
  SOURCE_RECORD_EXTERNAL_TYPES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { matchDecisions } from './matching';
import { merchants, storefronts } from './merchants';
import { offers } from './offers';
import { catalogSources, sourceRecords } from './provenance';

/** Bound on any stored error, note or free-text detail in this domain. */
export const CATALOG_SOURCE_MAX_TEXT_LENGTH = 2_000;

/**
 * `catalog_source_configs` — everything that makes a registry row an INGESTING
 * source (issue §"Source definition" 2–12).
 *
 * ### A 1:1 extension, not a fork
 *
 * `catalog_sources` is provenance for EVERY fact in the graph, including the
 * ones an operator typed and the ones #60's backfill minted. Those rows have no
 * cadence, no credential, no rate limit and no health, and pushing twelve
 * always-null columns onto them to serve the minority that do would make the
 * registry describe ingestion rather than provenance. `UNIQUE(source_id)` means
 * there is still exactly ONE source identity and one id; this row is the
 * ingestion half of it, the `provider_accounts` relationship to a seller.
 *
 * It also keeps the module graph acyclic, which is not a cosmetic concern:
 * `merchants.ts` already imports `provenance.ts` for its source links, so a
 * `merchant_id` on `catalog_sources` would close a cycle between two table
 * modules that drizzle-kit evaluates eagerly.
 *
 * ### A source with no config ingests NOTHING
 *
 * `resolveIngestionSource` returns nothing for a registry row with no config,
 * and the run path refuses before any fetch. That is the fail-closed direction:
 * adopting #62 cannot accidentally start crawling the `operator` source.
 */
export const catalogSourceConfigs = pgTable(
  'catalog_source_configs',
  {
    id: generatedId(),
    /**
     * The registry row this configures. CASCADE is wrong here and RESTRICT is
     * right: nothing deletes a `catalog_sources` row (the provenance registry
     * must survive everything that cites it), so this names the relationship
     * honestly rather than describing a deletion that never happens.
     */
    sourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    /**
     * The ADAPTER id — an OPEN set with a machine-slug shape CHECK, exactly as
     * `offers.provider` is and for its reason: external key spaces are not
     * Mercaria's to enumerate, and gating the durable CONFIG of a source on
     * Mercaria having shipped an adapter for it would invert "gate the loop,
     * never the record". `resolveCatalogSourceAdapter` answers whether one is
     * registered; the row does not.
     */
    provider: text().notNull(),
    /**
     * WHICH account/feed/seat at that provider. Part of what an adapter needs
     * and never a credential — a feed id, a shop handle, a network programme.
     * No foreign key: a foreign system's key space, named `_ref` so it reads
     * as one.
     */
    sourceAccountRef: text(),
    /**
     * The seller of record every offer from this source belongs to (issue
     * source definition 3).
     *
     * This is the whole of "offers are upserted only after merchant resolution"
     * (issue write boundary 2): the merchant is a property of the AGREEMENT
     * with the source, bound once by an operator, and an adapter has no field
     * through which to name one. A source with no merchant produces no offers,
     * which is a refusal an operator can read rather than a merchant nobody
     * authorised.
     */
    merchantId: text().references(() => merchants.id, { onDelete: 'restrict' }),
    /** The channel, when the source publishes on one. Same binding, same reasoning. */
    storefrontId: text().references(() => storefronts.id, { onDelete: 'restrict' }),
    /**
     * ISO 3166-1 alpha-2 markets this source's facts apply to (issue source
     * definition 4).
     *
     * EMPTY means UNRESTRICTED — the `commerce_relationships.territories`
     * scoped-down semantics, not the `supplier_agreements` grant semantics. A
     * feed that does not say which market it serves serves the ones its offers
     * name, and narrowing it to nothing would silently drop every offer.
     */
    territories: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * WHERE the credential lives, never the credential (issue source definition
     * 5, "secrets are never stored in public source records").
     *
     * A `<scheme>:<locator>` pair — `connection:<id>` for a credential the
     * connector domain already holds encrypted, `env:<NAME>` or `ssm:<path>`
     * for a deployment secret. The CHECK is what makes a pasted token refused
     * rather than stored: a bearer token has no `<lowercase scheme>:` prefix
     * from the tiny closed set below, and the length bound refuses anything
     * long enough to be a JWT.
     */
    credentialRef: text(),
    /** How often a refresh is due, in seconds (issue source definition 7). */
    fetchCadenceSeconds: integer(),
    /**
     * How long an observation from this source stays trustworthy (issue source
     * definition 8) — the TTL that becomes `offers.stale_at` and
     * `source_records.stale_at`.
     *
     * NOT NULL with a default, unlike the cadence: a source may legitimately
     * have no schedule (a webhook-driven one), and no source may legitimately
     * have facts that never go stale.
     */
    freshnessTtlSeconds: integer().notNull().default(86_400),
    /** Rate-limit policy (issue source definition 9). All three optional. */
    rateLimitPerMinute: integer(),
    rateLimitConcurrency: integer(),
    rateLimitMinIntervalMs: integer(),
    /** How many records one page may carry. Bounds the adapter, not the source. */
    pageSize: integer().notNull().default(200),

    status: text({ enum: asEnumValues(CATALOG_SOURCE_STATUSES) }).notNull().default('draft'),
    /** Who last moved the status, and why. An Oxy account id — no foreign key. */
    statusChangedByOxyUserId: text(),
    statusChangedAt: timestamptz(),
    statusReason: text(),

    // ── Source health (issue source definition 12, observability 6/7) ─────────
    healthState: text({ enum: asEnumValues(CATALOG_SOURCE_HEALTH_STATES) })
      .notNull()
      .default('unknown'),
    healthChangedAt: timestamptz(),
    lastAttemptAt: timestamptz(),
    lastSuccessAt: timestamptz(),
    /**
     * Consecutive non-success outcomes. The input to backoff and to the
     * "is this source degraded" read; reset to 0 by any `full_feed_success`.
     */
    consecutiveFailures: integer().notNull().default(0),
    /** Rolling counters an operator reads without joining every run. */
    lastFetchDurationMs: integer(),
    lastRateLimitHits: integer().notNull().default(0),
    lastError: text(),

    // ── The dispatcher's own scheduling and lease ────────────────────────────
    /**
     * When this source is next due. The claim orders on it, so a rate-limited
     * source pushes its own next attempt out without blocking any other.
     */
    nextRunAt: timestamptz(),
    /** Which task holds the run lease. An opaque worker identity — no FK. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('catalog_source_configs_status_check', t.status, CATALOG_SOURCE_STATUSES),
    checkOneOf(
      'catalog_source_configs_health_state_check',
      t.healthState,
      CATALOG_SOURCE_HEALTH_STATES,
    ),
    check(
      'catalog_source_configs_provider_shape_check',
      sql`${t.provider} ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`,
    ),
    /**
     * A locator, never a secret.
     *
     * Three schemes and nothing else, a bounded locator, and no whitespace. A
     * token pasted into this column fails on the scheme; a JWT fails on the
     * length as well. It is a shape check and not a secret detector, and it is
     * the second line — the first is that no code path writes a credential
     * here, and the third is that the operator projection never emits it.
     */
    check(
      'catalog_source_configs_credential_ref_shape_check',
      sql`${t.credentialRef} is null
          or ${t.credentialRef} ~ '^(connection|env|ssm):[A-Za-z0-9_./-]{1,120}$'`,
    ),
    /**
     * Every element is ISO 3166-1 alpha-2, tested on the array's own TEXT form.
     *
     * A CHECK may not contain a subquery, so `unnest` is unavailable and the
     * usual `checkEveryElementOf` needs a closed tuple this vocabulary does not
     * have. Casting the array renders `{ES,PT}`, and Postgres QUOTES any
     * element containing a comma — so `{"ES,PT"}` fails on the quote character
     * and the test is exact rather than merely close. The shape is
     * `offers.country`'s, one table over, which is the point: two validations
     * of one vocabulary inside one graph is the disagreement these conventions
     * exist to prevent.
     */
    check(
      'catalog_source_configs_territories_shape_check',
      sql`${t.territories}::text ~ '^[{]([A-Z]{2}(,[A-Z]{2})*)?[}]$'`,
    ),
    check(
      'catalog_source_configs_cadence_check',
      sql`${t.fetchCadenceSeconds} is null or ${t.fetchCadenceSeconds} >= 60`,
    ),
    check('catalog_source_configs_ttl_check', sql`${t.freshnessTtlSeconds} >= 60`),
    check('catalog_source_configs_page_size_check', sql`${t.pageSize} between 1 and 1000`),
    check(
      'catalog_source_configs_rate_limits_check',
      sql`(${t.rateLimitPerMinute} is null or ${t.rateLimitPerMinute} >= 1)
          and (${t.rateLimitConcurrency} is null or ${t.rateLimitConcurrency} >= 1)
          and (${t.rateLimitMinIntervalMs} is null or ${t.rateLimitMinIntervalMs} >= 0)`,
    ),
    check('catalog_source_configs_failures_check', sql`${t.consecutiveFailures} >= 0`),
    check('catalog_source_configs_rate_limit_hits_check', sql`${t.lastRateLimitHits} >= 0`),
    check(
      'catalog_source_configs_duration_check',
      sql`${t.lastFetchDurationMs} is null or ${t.lastFetchDurationMs} >= 0`,
    ),
    check(
      'catalog_source_configs_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(CATALOG_SOURCE_MAX_TEXT_LENGTH))}`,
    ),
    check(
      'catalog_source_configs_status_reason_length_check',
      sql`${t.statusReason} is null or length(${t.statusReason}) <= ${sql.raw(String(CATALOG_SOURCE_MAX_TEXT_LENGTH))}`,
    ),
    /**
     * A status a person chose carries WHO and WHY; the two statuses the system
     * itself writes do not.
     *
     * `failed` is set by a run and `draft` is the initial value, so demanding an
     * actor for them would make the framework unable to record its own
     * observations. Every other transition is somebody's decision — pausing a
     * source, revoking its rights, putting it live — and an unattributed one is
     * the `payment_repairs` refusal.
     */
    check(
      'catalog_source_configs_status_attribution_check',
      sql`${t.status} in ('draft', 'failed')
          or (${t.statusChangedByOxyUserId} is not null and ${t.statusChangedAt} is not null)`,
    ),
    /** Half a lease is unrepresentable — the `reconciliation_cursors` CHECK. */
    check(
      'catalog_source_configs_lease_complete_check',
      sql`num_nonnulls(${t.leaseOwner}, ${t.leaseUntil}) in (0, 2)`,
    ),
    /** PROPERTY: one configuration per registry row, ever. */
    uniqueIndex('catalog_source_configs_source_key').on(t.sourceId),
    /**
     * The provider identity an adapter converges on. Partial on
     * `status <> 'revoked'` so a revoked source's binding does not block a
     * successor being configured for the same feed — the revoked row stays as
     * the audit trail issue acceptance 6 protects.
     */
    uniqueIndex('catalog_source_configs_provider_account_key')
      .on(t.provider, t.sourceAccountRef)
      .where(sql`${t.sourceAccountRef} is not null and ${t.status} <> 'revoked'`),
    /** The dispatcher's claim: due work, soonest first. */
    index('catalog_source_configs_due_idx')
      .on(t.nextRunAt)
      .where(sql`${t.status} in ('active', 'failed')`),
    /** Reclaiming a dead task's lease — its own partial index, the outbox shape. */
    index('catalog_source_configs_reclaim_idx')
      .on(t.leaseUntil)
      .where(sql`${t.leaseOwner} is not null`),
    /** The health board: every source in a non-success state. */
    index('catalog_source_configs_health_idx').on(t.healthState, t.healthChangedAt),
    index('catalog_source_configs_merchant_idx')
      .on(t.merchantId)
      .where(sql`${t.merchantId} is not null`),
  ],
);

/**
 * `catalog_source_policies` — one reviewed rights/terms version (issue
 * §"Rights and controlled extraction", source definition 6 and 10).
 *
 * ### A version, frozen once active — and that is what makes suspension safe
 *
 * `mercaria_catalog_source_policy_immutable` refuses an UPDATE that changes any
 * right, terms field or review stamp on a row past `draft`; a partial unique
 * keeps one `active` version per source. Withdrawing a right is therefore a NEW
 * version superseding the old one, and the old one survives with its reviewer,
 * its date and its terms URL intact. Issue acceptance 6 — "source rights/policy
 * can disable display/refresh without deleting audit history" — is that
 * sentence read backwards: there is no UPDATE that could delete the history,
 * and no DELETE anywhere in this domain.
 *
 * ### The review stamp is NOT NULL on an active version
 *
 * "Controlled extraction must have an explicit policy/terms review before
 * activation" generalises here to every source kind, because the reason applies
 * to every source kind: a right nobody reviewed is a right nobody granted.
 * `catalog_source_policies_active_review_check` is what makes activation
 * impossible without a reviewer and a date.
 */
export const catalogSourcePolicies = pgTable(
  'catalog_source_policies',
  {
    id: generatedId(),
    sourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    /** Monotonic per source. Cited by `source_records.policy_version`. */
    version: integer().notNull(),
    status: text({ enum: asEnumValues(CATALOG_SOURCE_POLICY_STATUSES) })
      .notNull()
      .default('draft'),

    // ── The nine rights, one column each (issue rights 1–9) ──────────────────
    /**
     * The umbrella: may this source's facts be shown to buyers at ALL.
     *
     * Not one of the issue's nine — those name what may be shown and how — but
     * the thing they narrow, and the value `catalog_sources.may_display`
     * projects. The CHECK below makes the price and media rights imply it, so a
     * policy cannot grant "show the price" while forbidding display.
     */
    mayDisplay: boolean().notNull().default(false),
    mayStore: boolean().notNull().default(false),
    mayCache: boolean().notNull().default(false),
    /** Present EXACTLY when caching is permitted — a biconditional CHECK. */
    cacheTtlSeconds: integer(),
    mayDisplayPrice: boolean().notNull().default(false),
    mayDisplayMedia: boolean().notNull().default(false),
    mayLinkOut: boolean().notNull().default(false),
    mayAppendAffiliateParams: boolean().notNull().default(false),
    mayIndex: boolean().notNull().default(false),
    mayRefreshAutomatically: boolean().notNull().default(false),
    /**
     * Extraction is a MODE and not a boolean, because "may we scrape" and
     * "under what constraints" are one decision (issue rights 9). `disallowed`
     * is the default and the only value that needs no constraint beside it.
     */
    extractionMode: text({ enum: asEnumValues(CATALOG_SOURCE_EXTRACTION_MODES) })
      .notNull()
      .default('disallowed'),
    extractionMaxRequestsPerDay: integer(),
    extractionUserAgent: text(),

    /** Whether showing this source's facts requires naming the source. */
    attributionRequired: boolean().notNull().default(true),

    // ── The terms review (issue source definition 10) ────────────────────────
    /** The SOURCE's own terms version or label, in its words. */
    termsVersion: text(),
    termsUrl: text(),
    reviewedAt: timestamptz(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    reviewedByOxyUserId: text(),
    reviewNote: text(),

    activatedAt: timestamptz(),
    supersededAt: timestamptz(),
    /** The version this one replaced, so the chain reads backwards in time. */
    supersedesVersion: integer(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('catalog_source_policies_status_check', t.status, CATALOG_SOURCE_POLICY_STATUSES),
    checkOneOf(
      'catalog_source_policies_extraction_mode_check',
      t.extractionMode,
      CATALOG_SOURCE_EXTRACTION_MODES,
    ),
    check('catalog_source_policies_version_check', sql`${t.version} >= 1`),
    check(
      'catalog_source_policies_supersedes_check',
      sql`${t.supersedesVersion} is null or ${t.supersedesVersion} < ${t.version}`,
    ),
    /** Caching is a right plus a duration, or it is not a caching policy. */
    check(
      'catalog_source_policies_cache_shape_check',
      sql`(${t.mayCache}) = (${t.cacheTtlSeconds} is not null)
          and (${t.cacheTtlSeconds} is null or ${t.cacheTtlSeconds} >= 0)`,
    ),
    /** Showing a price or an image is a way of DISPLAYING. */
    check(
      'catalog_source_policies_display_implication_check',
      sql`${t.mayDisplay} or (not ${t.mayDisplayPrice} and not ${t.mayDisplayMedia})`,
    ),
    /** Affiliate parameters are appended to an outbound link; without one there is nothing to append them to. */
    check(
      'catalog_source_policies_affiliate_implication_check',
      sql`${t.mayLinkOut} or not ${t.mayAppendAffiliateParams}`,
    ),
    /**
     * Extraction beyond `disallowed` needs its constraints stated. A permitted
     * crawl with no request budget and no identifying user agent is exactly the
     * "controlled extraction" that is not controlled.
     */
    check(
      'catalog_source_policies_extraction_shape_check',
      sql`${t.extractionMode} = 'disallowed'
          or (${t.extractionMaxRequestsPerDay} is not null and ${t.extractionMaxRequestsPerDay} >= 1
              and ${t.extractionUserAgent} is not null and btrim(${t.extractionUserAgent}) <> '')`,
    ),
    /** An active version was reviewed by somebody, on a date. */
    check(
      'catalog_source_policies_active_review_check',
      sql`${t.status} = 'draft'
          or (${t.reviewedAt} is not null and ${t.reviewedByOxyUserId} is not null
              and ${t.activatedAt} is not null)`,
    ),
    check(
      'catalog_source_policies_superseded_shape_check',
      sql`(${t.status} = 'superseded') = (${t.supersededAt} is not null)`,
    ),
    check(
      'catalog_source_policies_review_note_length_check',
      sql`${t.reviewNote} is null or length(${t.reviewNote}) <= ${sql.raw(String(CATALOG_SOURCE_MAX_TEXT_LENGTH))}`,
    ),
    /** PROPERTY 5 — one version number per source, and one ACTIVE version. */
    uniqueIndex('catalog_source_policies_version_key').on(t.sourceId, t.version),
    uniqueIndex('catalog_source_policies_active_key')
      .on(t.sourceId)
      .where(sql`${t.status} = 'active'`),
    index('catalog_source_policies_source_idx').on(t.sourceId, t.version),
  ],
);

/**
 * `catalog_source_objects` — the CURRENT fact about one external object (issue
 * §"SourceRecord persistence" 10–13).
 *
 * ### Why this is not a column on `source_records`
 *
 * `source_records` is append-only and mints a new row per content change, so it
 * answers "what was seen, and when". A convergence key and a monotonicity guard
 * need a row that answers "what is true NOW", and there is exactly one of those
 * per external object however many times it has been observed. Putting the
 * current-fact columns on the observation would mean either rewriting history
 * (which the append-only contract forbids) or reading the newest row and hoping
 * nothing raced (which is the guard's whole job).
 *
 * ### The monotonicity guard is the one that pays for itself
 *
 * Feeds arrive out of order. A retry of yesterday's page, a webhook redelivered
 * after a newer one, a network with two mirrors — all of them present as an
 * older observation of an object Mercaria has already updated. Applying it
 * silently replaces today's price with last week's and looks exactly like a
 * successful refresh. `mercaria_catalog_source_object_monotonic` refuses it at
 * the row, and the upsert's own `WHERE` makes the ordinary path converge to a
 * no-op instead of an error, so a legitimate replay is quiet and a bug is loud.
 */
export const catalogSourceObjects = pgTable(
  'catalog_source_objects',
  {
    id: generatedId(),
    sourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    externalType: text({ enum: asEnumValues(SOURCE_RECORD_EXTERNAL_TYPES) }).notNull(),
    /** The source's own id for the object — a foreign system's key, no FK. */
    externalId: text().notNull(),

    /**
     * The observation these current facts came from (issue observation 13).
     * RESTRICT (D19): provenance must be able to block a delete rather than
     * vanish with it.
     */
    currentSourceRecordId: text()
      .notNull()
      .references(() => sourceRecords.id, { onDelete: 'restrict' }),
    /**
     * The last observation that made it all the way through the pipeline
     * (issue observation 13, the other half).
     *
     * Distinct from the current one: an object whose newest delivery was
     * quarantined still has a last-known-good, and telling them apart is what
     * lets an operator see how long a source has been publishing something
     * Mercaria refuses.
     */
    lastSuccessfulSourceRecordId: text().references(() => sourceRecords.id, {
      onDelete: 'restrict',
    }),

    /** When the current observation was READ. Never moves backwards. */
    currentObservedAt: timestamptz().notNull(),
    /** The SOURCE's own last-modified for the current fact, when it publishes one. */
    currentSourceUpdatedAt: timestamptz(),
    /** sha-256 of the current stored payload — `source_records.content_hash`, denormalized for the convergence read. */
    currentContentHash: text().notNull(),
    firstObservedAt: timestamptz().notNull(),
    /** The last time ANY delivery mentioned this object, changed or not. */
    lastSeenAt: timestamptz().notNull(),
    /** When these facts stop being trustworthy — the config's TTL, applied. */
    staleAt: timestamptz().notNull(),

    state: text({ enum: asEnumValues(CATALOG_SOURCE_OBJECT_STATES) }).notNull().default('observed'),
    /**
     * The matcher's verdict, as a POINTER (issue observation 10/11).
     *
     * Never a copy of the outcome or the confidence: two representations of one
     * verdict can disagree, and the place that must not happen is a comparison
     * page showing an attachment a re-evaluation has since withdrawn.
     * RESTRICT — the decision is the evidence for this row's state.
     */
    lastMatchDecisionId: text().references(() => matchDecisions.id, { onDelete: 'restrict' }),
    /**
     * The offer these facts currently price, when one exists. RESTRICT: an
     * offer is retired, never deleted (#57), so this can only be blocked by a
     * deletion that does not happen.
     */
    offerId: text().references(() => offers.id, { onDelete: 'restrict' }),

    quarantineReason: text({ enum: asEnumValues(CATALOG_SOURCE_QUARANTINE_REASONS) }),
    quarantinedAt: timestamptz(),
    quarantineDetail: text(),
    /** Set when the source stopped publishing it; the row and its history stay. */
    retiredAt: timestamptz(),
    /**
     * On what EVIDENCE it was retired (#68 acceptance 2 and 3).
     *
     * `retired_at` says that it happened; this says why anybody was entitled to
     * conclude it. The three are not interchangeable — an explicit removal is a
     * positive statement from any run, a snapshot omission is an inference that
     * only a COMPLETE enumeration licenses, and a TTL expiry is nobody saying
     * anything for longer than the source's own policy permits. Collapsing them
     * would make "did this merchant delist, or did our crawler stop" a question
     * the row cannot answer, which is the first thing an operator opens the
     * trace to ask.
     */
    retirementKind: text({ enum: asEnumValues(CATALOG_SOURCE_RETIREMENT_KINDS) }),

    /** How many deliveries have named this object. A poison object climbs it. */
    observationCount: integer().notNull().default(1),
    /**
     * The last price this object was seen at, in minor units of
     * `last_price_currency`. The ONLY reason it exists is the anomalous-change
     * detector (issue health 8): "did this jump by more than the configured
     * factor" is not answerable without the previous value, and reading it out
     * of the previous `source_records` payload would mean parsing jsonb on
     * every ingest. `bigint` for the `columns.ts` reason — FAIR's eight
     * decimals overflow a signed `integer` at 21.47 ⊜.
     */
    lastPriceAmount: bigint({ mode: 'number' }),
    lastPriceCurrency: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_source_objects_external_type_check',
      t.externalType,
      SOURCE_RECORD_EXTERNAL_TYPES,
    ),
    checkOneOf('catalog_source_objects_state_check', t.state, CATALOG_SOURCE_OBJECT_STATES),
    checkOneOf(
      'catalog_source_objects_quarantine_reason_check',
      t.quarantineReason,
      CATALOG_SOURCE_QUARANTINE_REASONS,
    ),
    check(
      'catalog_source_objects_content_hash_shape_check',
      sql`${t.currentContentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check('catalog_source_objects_external_id_check', sql`btrim(${t.externalId}) <> ''`),
    check('catalog_source_objects_observation_count_check', sql`${t.observationCount} >= 1`),
    /** Quarantine carries its reason and its time, or it is not one anybody can audit. */
    check(
      'catalog_source_objects_quarantine_shape_check',
      sql`(${t.state} = 'quarantined')
          = (${t.quarantineReason} is not null and ${t.quarantinedAt} is not null)`,
    ),
    check(
      'catalog_source_objects_retired_shape_check',
      sql`(${t.state} = 'retired') = (${t.retiredAt} is not null)`,
    ),
    checkOneOf(
      'catalog_source_objects_retirement_kind_check',
      t.retirementKind,
      CATALOG_SOURCE_RETIREMENT_KINDS,
    ),
    /**
     * A retirement states its evidence (#68).
     *
     * A biconditional, so neither half can exist alone: a `retired_at` with no
     * kind is a retirement nobody can account for, and a kind with no
     * `retired_at` claims an object was retired when it is still live. It is a
     * `post` statement because the image before #68 wrote the first half and
     * not the second.
     */
    check(
      'catalog_source_objects_retirement_evidence_check',
      sql`(${t.retiredAt} is not null) = (${t.retirementKind} is not null)`,
    ),
    /**
     * An object claiming a CURRENT offer must name one.
     *
     * This is issue write boundary 2 at the row: `offer_current` is the only
     * state that asserts an offer exists, and it cannot be written without the
     * id of one. The reverse is deliberately NOT constrained — an object whose
     * offer was retired by a later run keeps the pointer while moving out of
     * `offer_current`, which is how the trace stays answerable.
     */
    check(
      'catalog_source_objects_offer_state_check',
      sql`${t.state} <> 'offer_current' or ${t.offerId} is not null`,
    ),
    /**
     * A matched, reviewed or unmatched object cites the decision that said so.
     *
     * Without it, `review_required` would be a state a service bug could write
     * with nothing behind it — and "ambiguous matches do not silently publish
     * incorrect canonical links" (issue acceptance 5) depends on the review
     * queue being reachable FROM the object.
     */
    check(
      'catalog_source_objects_decision_shape_check',
      sql`${t.state} not in ('matched', 'review_required', 'unmatched', 'offer_current')
          or ${t.lastMatchDecisionId} is not null`,
    ),
    check(
      'catalog_source_objects_price_paired_check',
      sql`(${t.lastPriceAmount} is null) = (${t.lastPriceCurrency} is null)`,
    ),
    check(
      'catalog_source_objects_price_shape_check',
      sql`${t.lastPriceAmount} is null
          or (${t.lastPriceAmount} >= 0 and ${t.lastPriceCurrency} ~ '^[A-Z]{3,4}$')`,
    ),
    check(
      'catalog_source_objects_quarantine_detail_length_check',
      sql`${t.quarantineDetail} is null
          or length(${t.quarantineDetail}) <= ${sql.raw(String(CATALOG_SOURCE_MAX_TEXT_LENGTH))}`,
    ),
    check(
      'catalog_source_objects_seen_order_check',
      sql`${t.lastSeenAt} >= ${t.firstObservedAt} and ${t.currentObservedAt} >= ${t.firstObservedAt}`,
    ),
    /**
     * PROPERTY 4 — the source-object identity, exactly as issue §"SourceRecord
     * persistence" specifies it.
     *
     * A plain (not partial) unique: an object retired by one run and
     * re-published by the next is the SAME object, and minting a second row
     * would strand its history and its blocked-pair record on the first.
     */
    uniqueIndex('catalog_source_objects_identity_key').on(
      t.sourceId,
      t.externalType,
      t.externalId,
    ),
    /** The retirement sweep: which of this source's objects a run did not mention. */
    index('catalog_source_objects_source_seen_idx').on(t.sourceId, t.lastSeenAt),
    /** The freshness read, and the refresh sweep's own order. */
    index('catalog_source_objects_freshness_idx').on(t.sourceId, t.staleAt),
    /** The review backlog and the quarantine board, per source. */
    index('catalog_source_objects_state_idx').on(t.sourceId, t.state),
    index('catalog_source_objects_offer_idx')
      .on(t.offerId)
      .where(sql`${t.offerId} is not null`),
  ],
);

/**
 * `catalog_source_runs` — one bounded, resumable, leased ingestion pass (issue
 * §"Observability", §"PostgreSQL concurrency" 5).
 *
 * ### The ROW is the job
 *
 * `payment_provider_events`' arrangement rather than an outbox pointing at a
 * run: there is nothing to deliver, only work to resume. The lease columns,
 * the cursor and the counters live together, so a task that dies mid-pass
 * leaves a reclaimable row that says exactly where it got to — and `attempts`
 * plus `available_at` give it the same capped backoff and visible `dead_letter`
 * every other Mercaria worker has.
 *
 * ### The counters split into a PARTITION and a set of tallies
 *
 * `fetched = stored + unchanged + rejected + quarantined` is equality, because
 * every fetched record gets exactly one intake outcome. Everything downstream —
 * matched, review-required, unmatched, offers upserted, offers retired — is a
 * TALLY bounded by `fetched`, because one record can produce an offer and a
 * review decision in the same pass. Writing them as one partition would have
 * been a prettier CHECK and a false one.
 */
export const catalogSourceRuns = pgTable(
  'catalog_source_runs',
  {
    id: generatedId(),
    sourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(CATALOG_SOURCE_RUN_KINDS) }).notNull(),
    status: text({ enum: asEnumValues(CATALOG_SOURCE_RUN_STATUSES) }).notNull().default('pending'),
    /**
     * The health class this pass ended in. NULL while it runs — a CHECK, so a
     * finished run always says what happened and a running one never pretends
     * to know.
     */
    outcome: text({ enum: asEnumValues(CATALOG_SOURCE_HEALTH_STATES) }),

    /** Where the NEXT page starts, in the adapter's own cursor space. */
    cursor: text(),
    /** True once the adapter reported the last page of a COMPLETE enumeration. */
    enumerationComplete: boolean().notNull().default(false),
    /** The incremental watermark this pass asked from. */
    since: timestamptz(),
    /**
     * WHICH refresh this pass is (#68 scheduler 1).
     *
     * Stored rather than derived from `since`, even though the two agree for
     * every run #62 opened. A `targeted` pass and a `query_driven` pass both
     * carry a watermark and neither enumerates anything, so `since is null`
     * cannot tell the four apart — and the one that must not be guessed is
     * `full_snapshot`, since it is the only mode whose OUTCOME may authorise
     * retiring what the pass did not see.
     */
    refreshMode: text({ enum: asEnumValues(CATALOG_REFRESH_MODES) }).notNull(),
    /**
     * The external ids a TARGETED pass was opened for, and nothing else.
     *
     * A priority refresh re-reads a named list — eBay's `getItems` takes twenty
     * ids in one call — and the list has to survive a task dying mid-pass, so it
     * lives on the run rather than in the dispatcher's memory. Empty for every
     * whole-source mode, a CHECK.
     */
    targetExternalIds: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    // ── The intake partition (issue observability 2) ─────────────────────────
    fetched: integer().notNull().default(0),
    stored: integer().notNull().default(0),
    unchanged: integer().notNull().default(0),
    rejected: integer().notNull().default(0),
    quarantined: integer().notNull().default(0),

    // ── Downstream tallies (issue observability 3, 4, 8) ─────────────────────
    matched: integer().notNull().default(0),
    reviewRequired: integer().notNull().default(0),
    unmatched: integer().notNull().default(0),
    offersUpserted: integer().notNull().default(0),
    offersRetired: integer().notNull().default(0),
    /**
     * Offers retired because the source EXPLICITLY declared them gone (#68).
     *
     * A SEPARATE counter from `offers_retired`, which
     * `catalog_source_runs_retirement_check` reserves for retirements inferred
     * from a complete enumeration's silence. A removal is a positive statement
     * and is licensed by any run at all, so putting the two in one column would
     * either make the CHECK refuse a legitimate deletion notice or make the
     * CHECK meaningless — and it would leave an operator unable to tell "the
     * merchant delisted forty items" from "our snapshot missed forty items".
     */
    offersRemoved: integer().notNull().default(0),

    // ── Fetch statistics (issue observability 1, 7) ──────────────────────────
    fetchCount: integer().notNull().default(0),
    fetchDurationMs: integer().notNull().default(0),
    rateLimitHits: integer().notNull().default(0),

    /** Which task holds the lease. An opaque worker identity — no FK. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),

    startedAt: timestamptz(),
    finishedAt: timestamptz(),
    lastError: text(),
    /**
     * The Oxy operator who asked for a `manual` run. NULL for every other kind,
     * a CHECK: the dispatcher opens the scheduled ones and attributing those to
     * a person would be a false audit trail.
     */
    requestedByOxyUserId: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('catalog_source_runs_kind_check', t.kind, CATALOG_SOURCE_RUN_KINDS),
    checkOneOf('catalog_source_runs_refresh_mode_check', t.refreshMode, CATALOG_REFRESH_MODES),
    /**
     * A TARGETED pass names objects; every other mode cannot (#68).
     *
     * The biconditional matters in both directions: a targeted run with an
     * empty list would fetch nothing and report a clean pass, and a snapshot
     * carrying ids would read as targeted while spending a snapshot's quota.
     */
    check(
      'catalog_source_runs_target_shape_check',
      // `coalesce(array_length(…), 0)`: `array_length` of an EMPTY array is
      // NULL, so the bare comparison yields `true = NULL` → NULL for a targeted
      // run with no ids, and a CHECK rejects only FALSE — the row this
      // constraint exists to refuse would have been admitted. Measured.
      sql`(${t.refreshMode} = 'targeted')
          = (coalesce(array_length(${t.targetExternalIds}, 1), 0) >= 1)`,
    ),
    checkOneOf('catalog_source_runs_status_check', t.status, CATALOG_SOURCE_RUN_STATUSES),
    checkOneOf('catalog_source_runs_outcome_check', t.outcome, CATALOG_SOURCE_HEALTH_STATES),
    check(
      'catalog_source_runs_counters_non_negative_check',
      sql`${t.fetched} >= 0 and ${t.stored} >= 0 and ${t.unchanged} >= 0 and ${t.rejected} >= 0
          and ${t.quarantined} >= 0 and ${t.matched} >= 0 and ${t.reviewRequired} >= 0
          and ${t.unmatched} >= 0 and ${t.offersUpserted} >= 0 and ${t.offersRetired} >= 0
          and ${t.offersRemoved} >= 0
          and ${t.fetchCount} >= 0 and ${t.fetchDurationMs} >= 0 and ${t.rateLimitHits} >= 0
          and ${t.attempts} >= 0`,
    ),
    /**
     * PROPERTY 1 — the vacuity floor, as a constraint.
     *
     * Equality and never `<=`. `<=` would admit the run that fetched ten
     * thousand records and classified none of them, which is exactly the shape
     * of a broken page reporting success.
     */
    check(
      'catalog_source_runs_intake_total_check',
      sql`${t.fetched} = ${t.stored} + ${t.unchanged} + ${t.rejected} + ${t.quarantined}`,
    ),
    /** The downstream tallies are bounded by what was fetched, one by one. */
    check(
      'catalog_source_runs_downstream_bound_check',
      sql`${t.matched} <= ${t.fetched} and ${t.reviewRequired} <= ${t.fetched}
          and ${t.unmatched} <= ${t.fetched} and ${t.offersUpserted} <= ${t.fetched}`,
    ),
    /**
     * #68 — and only a SNAPSHOT could ever be a complete enumeration.
     *
     * `enumeration_complete` is the adapter's claim and PROPERTY 2 below is the
     * outcome's; this is the third leg, about the MODE. An incremental or
     * targeted pass that set the flag would satisfy both of the others while
     * having asked the source for a fraction of its catalogue, which is
     * acceptance 3's failure exactly.
     */
    check(
      'catalog_source_runs_complete_mode_check',
      sql`not ${t.enumerationComplete}
          or ${t.refreshMode} in (${sql.raw(inList(CATALOG_SNAPSHOT_REFRESH_MODES))})`,
    ),
    /**
     * PROPERTY 2 — only a COMPLETE enumeration may retire anything.
     *
     * `CATALOG_SOURCE_RETIRING_OUTCOMES` is rendered into the CHECK from the
     * SAME tuple `health.ts` reads, so the constraint and the service cannot
     * drift. This is issue §"Health" rule "do not mass-expire healthy offers
     * because one refresh failed", held against the service, a replay and
     * `psql` alike: a run that ended in `auth_failure` cannot store a non-zero
     * retirement count at all.
     */
    check(
      'catalog_source_runs_retirement_check',
      sql`${t.offersRetired} = 0
          or (${t.enumerationComplete}
              and ${t.outcome} in (${sql.raw(inList(CATALOG_SOURCE_RETIRING_OUTCOMES))}))`,
    ),
    /** A finished run says what happened; a running one does not pretend to know. */
    check(
      'catalog_source_runs_outcome_shape_check',
      sql`(${t.status} in ('completed', 'failed')) = (${t.outcome} is not null)`,
    ),
    check(
      'catalog_source_runs_finished_shape_check',
      sql`(${t.status} in ('completed', 'failed')) = (${t.finishedAt} is not null)`,
    ),
    /**
     * Anything past `pending` has STARTED — and the converse is deliberately
     * NOT asserted.
     *
     * A run released for retry returns to `pending` with its `started_at` and
     * its cursor intact, which is the whole point of releasing rather than
     * failing it: the next claim resumes from the page that failed. A
     * biconditional here would refuse exactly that write, and the failure would
     * surface as a 23514 on the retry path of a source that had merely been
     * rate-limited. Measured — the contract suite's auth/rate-limit case fails
     * on the biconditional form.
     */
    check(
      'catalog_source_runs_started_shape_check',
      sql`${t.status} = 'pending' or ${t.startedAt} is not null`,
    ),
    check(
      'catalog_source_runs_lease_complete_check',
      sql`num_nonnulls(${t.leaseOwner}, ${t.leaseUntil}) in (0, 2)`,
    ),
    check(
      'catalog_source_runs_requested_by_check',
      sql`(${t.requestedByOxyUserId} is not null) = (${t.kind} = 'manual')`,
    ),
    check(
      'catalog_source_runs_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(CATALOG_SOURCE_MAX_TEXT_LENGTH))}`,
    ),
    /**
     * ONE open run per source. Partial on the unfinished statuses, so a
     * completed run is history and the next pass is a new row — the
     * `catalog_backfill_runs_open_key` shape. Without it two dispatchers
     * opening a pass would each get a cursor and each enumerate the whole feed.
     */
    uniqueIndex('catalog_source_runs_open_key')
      .on(t.sourceId)
      .where(sql`${t.status} in ('pending', 'running')`),
    /** The dispatcher's claim: due pending work, oldest first. */
    index('catalog_source_runs_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    /** Reclaiming a dead task's lease — the outbox shape, its own partial index. */
    index('catalog_source_runs_reclaim_idx')
      .on(t.leaseUntil, t.createdAt)
      .where(sql`${t.status} = 'running'`),
    /** The observability read: this source's runs, newest first. */
    index('catalog_source_runs_source_idx').on(t.sourceId, t.createdAt),
  ],
);

/**
 * `catalog_source_rejections` — the RESIDUAL: every record that never became an
 * observation, and why.
 *
 * ### Why a table and not a counter
 *
 * `~/Oxy/AGENTS.md` states the rule this table exists for: an inventory whose
 * output is "nothing is wrong" cannot distinguish finding less from there BEING
 * less, and the defence is to print what the scan could not classify and make a
 * person explain it. A `rejected` counter says a page dropped eleven records; it
 * cannot say that all eleven were the same field renamed by the provider, which
 * is what tells schema drift from a bad page.
 *
 * ### The one table in this domain with a retention deadline
 *
 * Every other table here is bounded by the catalogue — one config per source,
 * one object per external id. This one is bounded by TRAFFIC: a provider that
 * starts returning malformed rows writes one per record per run, forever.
 * `expires_at` plus an `expiryTargets.ts` entry is what stops that, and it is
 * the reason this is a separate table rather than more columns on the object:
 * the objects must NOT be swept, and a table with two retention rules has one
 * of them wrong.
 */
export const catalogSourceRejections = pgTable(
  'catalog_source_rejections',
  {
    id: generatedId(),
    runId: text()
      .notNull()
      .references(() => catalogSourceRuns.id, { onDelete: 'cascade' }),
    sourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    /** What the source said it was. NULL when the record did not say. */
    externalType: text({ enum: asEnumValues(SOURCE_RECORD_EXTERNAL_TYPES) }),
    /** NULL is the point for `missing_external_id` — the record had none. */
    externalId: text(),
    reasonCode: text({ enum: asEnumValues(CATALOG_SOURCE_REJECTION_REASONS) }).notNull(),
    /**
     * A bounded, redacted note. Built by `describeRejection`, which composes
     * FIELD NAMES and never values — a rejection detail carrying the payload
     * that caused it would put exactly the unstorable content into the one
     * table nobody thought to check.
     */
    detail: text(),
    /** sha-256 of the raw record, so a repeat of the same bad row is recognisable. */
    rawPayloadDigest: text(),
    /** The retention deadline. Swept by `expiryTargets.ts`; see the docblock. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_source_rejections_external_type_check',
      t.externalType,
      SOURCE_RECORD_EXTERNAL_TYPES,
    ),
    checkOneOf(
      'catalog_source_rejections_reason_check',
      t.reasonCode,
      CATALOG_SOURCE_REJECTION_REASONS,
    ),
    check(
      'catalog_source_rejections_digest_shape_check',
      sql`${t.rawPayloadDigest} is null or ${t.rawPayloadDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'catalog_source_rejections_detail_length_check',
      sql`${t.detail} is null or length(${t.detail}) <= ${sql.raw(String(CATALOG_SOURCE_MAX_TEXT_LENGTH))}`,
    ),
    /** The diagnosis read: this source's rejections by reason, newest first. */
    index('catalog_source_rejections_source_idx').on(t.sourceId, t.reasonCode, t.createdAt),
    index('catalog_source_rejections_run_idx').on(t.runId),
    /**
     * The EXPIRY SWEEP's own index, leading on the deadline.
     *
     * `findUnsupportedExpiryColumns` fails the build without it, and the reason
     * it does is worth restating: the sweep is `delete … where expires_at <=
     * now()`, so an unindexed deadline turns a retention pass into a sequential
     * scan of the one table here that grows with traffic — which is the exact
     * table where that matters.
     */
    index('catalog_source_rejections_expiry_idx').on(t.expiresAt),
  ],
);
