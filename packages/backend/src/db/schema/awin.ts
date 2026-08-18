/**
 * The Awin retailer-network source — issue #66, source selected by #64:
 * `awin_accounts`, `awin_advertisers`, `awin_feeds`, `awin_advertiser_quality`,
 * `awin_link_samples`, `awin_network_leases`.
 *
 * Awin is a NETWORK: one publisher credential in front of thirty thousand
 * advertisers, each publishing its own feed under its own commercial
 * relationship. #62 owns a source's configuration, rights, health and
 * lifecycle; #63 owns turning a file into records; #68 owns freshness and
 * anomaly quarantine. Nothing here is a second copy of any of them.
 *
 * ## The one structural decision everything else follows from
 *
 * **One Awin advertiser is one `catalog_sources` row.** Not one source called
 * "Awin". That single choice is what makes four otherwise-hard properties
 * free:
 *
 * - a malformed advertiser feed fails ITS run and marks ITS source, so there is
 *   no shared enumeration for it to make incomplete (issue feed lifecycle 7);
 * - each retailer is a distinct merchant AND storefront, because the binding is
 *   `catalog_source_configs.merchant_id`/`storefront_id`, per source
 *   (acceptance 3);
 * - the per-advertiser kill switch, rights withdrawal, freshness TTL, cadence
 *   and territory scoping are all things #62 and #68 already do PER SOURCE
 *   (quality control 5, and issue design item 10);
 * - advertiser health and NETWORK health are separately observable
 *   (acceptance 5) — the first is `catalog_source_configs.health_state`, the
 *   second is `awin_accounts`, and had "Awin" been one source they would have
 *   been one number.
 *
 * The cost is stated rather than hidden: fifty advertisers is fifty registry
 * rows, fifty rights policies to review and fifty freshness versions to publish
 * if they differ. That is the correct amount of work — each of those IS a
 * separate commercial relationship with separate terms — and the alternative
 * makes the fifty share one review nobody performed for forty-nine of them.
 *
 * ## The five properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **A network's rate limit binds the FLEET and is keyed on the ACCOUNT.**
 *    `awin_network_leases` is #68's `catalog_source_refresh_leases` — itself
 *    #122's `supplier_call_leases` — pointed at a publisher account. #68's is
 *    keyed on `source_id`, which with one source per advertiser bounds each
 *    advertiser separately and the network not at all: fifty advertisers with
 *    an allowance of twenty each is a thousand calls a minute at one host under
 *    one key. Both are claimed; they answer different questions.
 * 2. **What Awin SAYS and what Mercaria DECIDED are different columns.**
 *    `membership_status` is the network's answer, `activation` is Mercaria's,
 *    and no code path writes an opinion into the first. Collapsing them makes
 *    "Awin suspended us" indistinguishable from "we paused them".
 * 3. **An advertiser cannot be activated without a recorded PASSED sample.**
 *    `awin_advertisers_activation_sample_check` refuses `active` without a
 *    sample id, and `awin_link_samples` is append-only. Issue quality control 4
 *    asks that destination URLs and tracking behaviour be sampled before
 *    activation; a lifecycle without a sampling state makes that a checklist
 *    item somebody remembers.
 * 4. **A quality snapshot's counters must ADD UP.**
 *    `awin_advertiser_quality_totals_check` is `scanned = mapped + rejected`,
 *    equality and never `<=` — #60's vacuity floor, so a pass that swallowed
 *    rows cannot write the snapshot at all. "Zero rejected over zero scanned"
 *    and "zero rejected over fifty thousand" are the two readings a bare
 *    rejection count cannot tell apart.
 * 5. **An advertiser's network identity is FROZEN.** A trigger refuses to move
 *    `account_id` or `advertiser_id` — #124's `supplier_accounts` decision, for
 *    its reason: every feed, quality snapshot, sample and `catalog_sources` row
 *    NAMES this advertiser rather than snapshotting which one it was, so
 *    re-pointing it silently reinterprets every historical row.
 *
 * ## What is deliberately NOT here
 *
 * - **No `commissionable` column, and no second derivation of the offer's
 *   KIND.** The first would be a second representation of a membership status,
 *   a #62 rights verdict and a tracking verdict that all already exist; the
 *   second would duplicate #62's own `offerKindFor`. What #66 owns is the
 *   narrower question #62 cannot see — may Mercaria hand the network's tracking
 *   URL over at all — and the answer is applied by WITHHOLDING the URL, so
 *   #62's `affiliate_params`-absent branch produces the right offer with no new
 *   mechanism.
 * - **No transactions table.** #67 owns commission reconciliation, and a
 *   transaction row Mercaria cannot attribute to a click it recorded is a
 *   number with nothing to compare it against. The seam fails closed by
 *   ABSENCE, which is the strongest form — there is nothing to mistake for a
 *   working feature.
 * - **No feed URL, anywhere.** Awin puts the product-data API key in the PATH
 *   (`productdata.awin.com/datafeed/list/apikey/<KEY>`), so a feed URL in this
 *   domain is a credential wearing a hostname — #63's rule, inherited. What is
 *   stored is a LOCATOR (`env:`/`ssm:`), shape-CHECKed so a pasted key is
 *   refused by the database, and the URL is composed at fetch time.
 * - **No `feed_configurations` row.** #63's configuration surface belongs to a
 *   STORE's own inventory arriving by file. An Awin advertiser has no store and
 *   no members; its mapping is built in memory from its declared columns, which
 *   is exactly the contract `docs/feed-importer.md` publishes for #66.
 * - **No threshold or detector for a feed-wide price-scale mistake.** #68
 *   already has one, and it runs BEFORE any of the page is applied. What #66
 *   supplies is the per-source freshness policy those numbers live on.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  AWIN_ACCOUNT_STATE_REASONS,
  AWIN_ACCOUNT_STATES,
  AWIN_ACTIVATIONS,
  AWIN_FEED_COLUMNS,
  AWIN_MEMBERSHIP_STATUSES,
  AWIN_SAMPLE_FINDINGS,
  AWIN_SAMPLE_VERDICTS,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import { catalogSources } from './provenance';
import { catalogSourceRuns } from './ingestion';

/** Bound on any stored note, reason or detail in this domain. */
export const AWIN_MAX_TEXT_LENGTH = 2_000;

/**
 * Bound on a provider-supplied identifier, name or host.
 *
 * Generous enough for every real advertiser name and tight enough that a feed
 * row cannot make a column into a payload. Awin ids are short integers; the
 * bound is not about them.
 */
const AWIN_MAX_HANDLE_LENGTH = 200;

/**
 * `awin_accounts` — one publisher account: its credentials' LOCATORS, its
 * network-level state and its fleet-wide call budget.
 *
 * ### Why this exists at all, when there will realistically be one row
 *
 * Acceptance 5 asks that source and advertiser health be observable
 * separately, and with one source per advertiser there is otherwise nowhere for
 * the NETWORK's health to live: the feed-list poll, the deauthorization state
 * and the shared budget are facts about Awin rather than about any one
 * retailer. Putting them in configuration would make "when did the key stop
 * working" unanswerable from a row afterwards, which is the first question an
 * incident asks.
 */
export const awinAccounts = pgTable(
  'awin_accounts',
  {
    id: generatedId(),
    /** Awin's own numeric publisher id. A foreign system's key — no FK. */
    publisherId: text().notNull(),
    /** What an operator calls it. Never sent anywhere. */
    label: text().notNull(),

    /**
     * WHERE the product-data feed key lives, never the key.
     *
     * The same shape and the same reasoning as
     * `catalog_source_configs.credential_ref` (#62): `connection:`, `env:` or
     * `ssm:`, length-bounded, so a pasted key is refused by the database rather
     * than by a reviewer. It is not in `protectedColumns.ts` — a locator is not
     * a credential — and what keeps it out of a response is that the operator
     * projection names its fields.
     */
    feedCredentialRef: text(),
    /** WHERE the Publisher API token lives. #67 spends it; #66 never reads it. */
    publisherApiCredentialRef: text(),

    state: text({ enum: asEnumValues(AWIN_ACCOUNT_STATES) }).notNull().default('active'),
    stateReason: text({ enum: asEnumValues(AWIN_ACCOUNT_STATE_REASONS) }),
    stateChangedAt: timestamptz(),
    stateChangedByOxyUserId: text(),
    stateNote: text(),

    /**
     * The fleet-wide budget this account's slots are provisioned from.
     *
     * Defaulted to Awin's own published limit rather than to a Mercaria guess,
     * and configurable per account because a network can raise an individual
     * publisher's allowance and a hard-coded twenty would then be Mercaria
     * declining throughput it was granted.
     */
    maxConcurrency: integer().notNull().default(2),
    maxCallsPerMinute: integer().notNull().default(20),

    /** When the feed list was last read, and what it looked like. */
    lastListPolledAt: timestamptz(),
    lastListDigest: text(),
    lastListFeedCount: integer(),
    /** The last list poll that FAILED, and why. Bounded text, never a URL. */
    lastListError: text(),
    lastListErrorAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('awin_accounts_state_check', t.state, AWIN_ACCOUNT_STATES),
    checkOneOf('awin_accounts_state_reason_check', t.stateReason, AWIN_ACCOUNT_STATE_REASONS),
    check('awin_accounts_publisher_id_shape_check', sql`${t.publisherId} ~ '^[0-9]{1,20}$'`),
    check(
      'awin_accounts_label_check',
      sql`btrim(${t.label}) <> '' and length(${t.label}) <= ${sql.raw(String(AWIN_MAX_HANDLE_LENGTH))}`,
    ),
    /**
     * A locator, never a secret. `catalog_source_configs`' own shape CHECK,
     * repeated rather than shared because a CHECK needs the table name.
     */
    check(
      'awin_accounts_feed_credential_shape_check',
      sql`${t.feedCredentialRef} is null
          or ${t.feedCredentialRef} ~ '^(connection|env|ssm):[A-Za-z0-9_./-]{1,120}$'`,
    ),
    check(
      'awin_accounts_publisher_api_credential_shape_check',
      sql`${t.publisherApiCredentialRef} is null
          or ${t.publisherApiCredentialRef} ~ '^(connection|env|ssm):[A-Za-z0-9_./-]{1,120}$'`,
    ),
    check(
      'awin_accounts_budget_check',
      sql`${t.maxConcurrency} >= 1 and ${t.maxCallsPerMinute} >= 1`,
    ),
    /**
     * A state that is not `active` names WHY and WHEN.
     *
     * Without it, an account sitting `deauthorized` with no reason sends
     * somebody to rotate a key that was never rejected — the difference between
     * `credential_rejected` and `account_closed` is a key to rotate versus a
     * relationship to re-establish.
     */
    check(
      'awin_accounts_state_shape_check',
      sql`(${t.state} = 'active')
          or (${t.stateReason} is not null and ${t.stateChangedAt} is not null)`,
    ),
    check(
      'awin_accounts_note_length_check',
      sql`(${t.stateNote} is null or length(${t.stateNote}) <= ${sql.raw(String(AWIN_MAX_TEXT_LENGTH))})
          and (${t.lastListError} is null or length(${t.lastListError}) <= ${sql.raw(String(AWIN_MAX_TEXT_LENGTH))})`,
    ),
    check(
      'awin_accounts_list_digest_shape_check',
      sql`${t.lastListDigest} is null or ${t.lastListDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    /** One row per Awin publisher id. Two would be two budgets for one key. */
    uniqueIndex('awin_accounts_publisher_key').on(t.publisherId),
  ],
);

/**
 * `awin_advertisers` — one Awin advertiser, and the #62 source that IS it.
 *
 * ### `catalog_source_id` is nullable, and that is the discovery boundary
 *
 * A discovery pass finds four hundred advertisers and registers none of them.
 * Creating a source would mean creating a merchant and a storefront for a
 * retailer nobody reviewed, and #62's rule is that a source with no merchant
 * produces no offers — so the honest shape is an advertiser row with no source
 * until an operator binds one. That is also what makes the pre-join preview
 * useful: an advertiser can be discovered, its identifier coverage measured and
 * its deep links sampled before any application is sent.
 *
 * Once bound the link is `UNIQUE` on both sides, so one source can never serve
 * two advertisers.
 */
export const awinAdvertisers = pgTable(
  'awin_advertisers',
  {
    id: generatedId(),
    accountId: text()
      .notNull()
      .references(() => awinAccounts.id, { onDelete: 'restrict' }),
    /** Awin's own advertiser id. A foreign system's key — no FK. */
    advertiserId: text().notNull(),
    displayName: text().notNull(),

    /**
     * The #62 registry row this advertiser IS, once an operator binds one.
     *
     * RESTRICT, like every other reference to a provenance row: an observation
     * chain must be able to block a delete rather than vanish with it.
     */
    catalogSourceId: text().references(() => catalogSources.id, { onDelete: 'restrict' }),

    /** What AWIN says. Mercaria never writes an opinion into this column. */
    membershipStatus: text({ enum: asEnumValues(AWIN_MEMBERSHIP_STATUSES) })
      .notNull()
      .default('not_joined'),
    membershipChangedAt: timestamptz(),

    /** What MERCARIA decided. The per-advertiser kill switch lives here. */
    activation: text({ enum: asEnumValues(AWIN_ACTIVATIONS) }).notNull().default('candidate'),
    activationChangedAt: timestamptz(),
    activationChangedByOxyUserId: text(),
    activationNote: text(),

    /**
     * The sample that authorised activation (issue quality control 4).
     *
     * A NOT NULL requirement whenever `activation = 'active'`, held by a CHECK
     * below — the `match_category_gates` device: a gate that cites its
     * measurement cannot be opened without one. It is nullable in general
     * because a `candidate` has taken no sample and a `closed` advertiser's
     * sample is history rather than authority.
     */
    activatingSampleId: text(),

    /** What the feed list said about this advertiser, verbatim. */
    primaryRegion: text(),
    vertical: text(),
    /**
     * There is deliberately NO `declared_host`, and there is no expectation
     * column of any kind (#589).
     *
     * It existed for the pre-activation sample's destination check and had no
     * production writer for its whole life. The feed list publishes no host
     * column; Awin publishes an advertiser display URL only on the Publisher
     * API's programme-details endpoint, which Mercaria neither calls nor has an
     * account for; and deriving one from the feed's own destinations is
     * circular. So the check it fed returned `null` on every real input.
     *
     * What replaced it catches the failure this table's sample comment names —
     * the two URL columns mapped to each other's roles — from the FEED ALONE:
     * `assessAwinDestination`, counted into `awin_advertiser_quality`.
     *
     * What it LOSES, stated rather than glossed: advertiser A's feed carrying
     * links to retailer B, a genuine cross-retailer mismatch with no
     * tracking-host signature. Nothing available to Mercaria can supply the host
     * to catch it with. If it is later judged worth catching, it returns as a
     * column, a writer and a caller in ONE change.
     */

    /** When the list last mentioned it. Absence is what closure is inferred from. */
    lastSeenInListAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'awin_advertisers_membership_check',
      t.membershipStatus,
      AWIN_MEMBERSHIP_STATUSES,
    ),
    checkOneOf('awin_advertisers_activation_check', t.activation, AWIN_ACTIVATIONS),
    check('awin_advertisers_advertiser_id_shape_check', sql`${t.advertiserId} ~ '^[0-9]{1,20}$'`),
    check(
      'awin_advertisers_display_name_check',
      sql`btrim(${t.displayName}) <> ''
          and length(${t.displayName}) <= ${sql.raw(String(AWIN_MAX_HANDLE_LENGTH))}`,
    ),
    check(
      'awin_advertisers_note_length_check',
      sql`${t.activationNote} is null
          or length(${t.activationNote}) <= ${sql.raw(String(AWIN_MAX_TEXT_LENGTH))}`,
    ),
    /**
     * ISSUE QUALITY CONTROL 4, as a constraint rather than a habit.
     *
     * An advertiser cannot be `active` without naming the sample that
     * authorised it. There is deliberately no "activate anyway" column: an
     * advertiser whose sample failed is re-sampled after its feed or its
     * mapping changes, and a waiver would be a second, quieter way to reach the
     * one state that puts a tracked link in front of a buyer.
     */
    check(
      'awin_advertisers_activation_sample_check',
      sql`${t.activation} <> 'active' or ${t.activatingSampleId} is not null`,
    ),
    /**
     * A moved activation names WHO and WHEN.
     *
     * `candidate` is the birth state and needs neither; everything else is
     * somebody's decision, and an unattributed kill switch is one nobody can
     * ask about.
     */
    check(
      'awin_advertisers_activation_attribution_check',
      sql`${t.activation} = 'candidate'
          or (${t.activationChangedAt} is not null and ${t.activationChangedByOxyUserId} is not null)`,
    ),
    /** One row per advertiser per account. Two would be two of one retailer. */
    uniqueIndex('awin_advertisers_account_advertiser_key').on(t.accountId, t.advertiserId),
    /** One #62 source can never serve two advertisers. */
    uniqueIndex('awin_advertisers_catalog_source_key').on(t.catalogSourceId),
    /** The discovery reconciliation's read: this account's advertisers. */
    index('awin_advertisers_account_activation_idx').on(t.accountId, t.activation),
  ],
);

/**
 * `awin_feeds` — one feed an advertiser publishes, and everything needed to
 * decide whether to download it.
 *
 * An advertiser may publish several (a per-language feed, a per-vertical feed),
 * so this is a child table rather than columns on the advertiser.
 *
 * ### Two unchanged-feed detectors, and neither is redundant
 *
 * `imported_last_imported_at` is the `Last Imported` value of the last pass that
 * actually CONSUMED this feed; the scheduler skips a feed whose list value has
 * not moved past it, which costs one CSV for the whole network. `http_etag` /
 * `http_last_modified` are #63's conditional-request validators, whose
 * `not_modified` branch carries no bytes and — critically — no enumeration.
 *
 * The first is a claim by the provider about its own pipeline; the second is a
 * claim about the bytes. Trusting only the first re-downloads fifty megabytes
 * every time Awin re-runs a job that changed nothing; trusting only the second
 * fetches the whole network hourly to find that out.
 */
export const awinFeeds = pgTable(
  'awin_feeds',
  {
    id: generatedId(),
    advertiserRowId: text()
      .notNull()
      .references(() => awinAdvertisers.id, { onDelete: 'restrict' }),
    /** Awin's own feed id. A foreign system's key — no FK. */
    feedId: text().notNull(),
    feedName: text().notNull(),

    language: text(),
    /**
     * The feed's own currency, as Awin declares it.
     *
     * NO `CurrencyCode` CHECK, deliberately, and this is the
     * `offers.price_currency` exception (ADR 0002 D18) one layer up: an
     * external platform trades in whatever it trades in, and refusing a feed
     * because its currency is outside Mercaria's presentment set would decline
     * inventory over a display concern. A row whose currency Mercaria cannot
     * READ is refused per record by #63's money reader, with the code named.
     */
    currency: text(),

    /** What the list last said about this feed. */
    productCount: integer(),
    listedLastImportedAt: timestamptz(),
    lastSeenInListAt: timestamptz(),

    /**
     * The columns this feed's header row actually carried, last time it was
     * read.
     *
     * Awin ships only the columns an advertiser MAPPED, so identifier coverage
     * is a per-advertiser FACT and never an assumption (#64 §6, Awin rule 2:
     * "never fabricate absent identifiers"). Constrained to the allow-list, so
     * a column Mercaria does not read cannot be recorded as one it does.
     */
    declaredColumns: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /**
     * There is deliberately NO per-feed identity-column set.
     *
     * `AWIN_IDENTITY_COLUMNS` is a code constant naming ONE column
     * (`aw_product_id`), which is #63's frozen `identity_key_fields` rule taken
     * one step further: a column here would be a configuration surface for the
     * one decision that re-mints and retires an entire catalogue when it moves,
     * and no such surface should exist. Mercaria requests a fixed column set on
     * every download, so the column is present by construction rather than by
     * negotiation with each advertiser.
     */

    /** What the last SUCCESSFUL import consumed. The cheap staleness detector. */
    importedLastImportedAt: timestamptz(),
    lastImportAt: timestamptz(),
    /** sha-256 of the feed's own bytes, from #63's stage manifest. */
    lastImportDigest: text(),
    /** #63's conditional-request validators. The correct staleness detector. */
    httpEtag: text(),
    httpLastModified: text(),

    /** The mapping procedure version this feed was last read under. */
    mappingVersion: integer().notNull().default(1),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('awin_feeds_feed_id_shape_check', sql`${t.feedId} ~ '^[0-9]{1,20}$'`),
    check(
      'awin_feeds_feed_name_check',
      sql`btrim(${t.feedName}) <> ''
          and length(${t.feedName}) <= ${sql.raw(String(AWIN_MAX_HANDLE_LENGTH))}`,
    ),
    check('awin_feeds_product_count_check', sql`${t.productCount} is null or ${t.productCount} >= 0`),
    check('awin_feeds_mapping_version_check', sql`${t.mappingVersion} >= 1`),
    check(
      'awin_feeds_import_digest_shape_check',
      sql`${t.lastImportDigest} is null or ${t.lastImportDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    /** Every recorded column is one Mercaria asked for. See the column's docblock. */
    checkEveryElementOf('awin_feeds_declared_columns_check', t.declaredColumns, AWIN_FEED_COLUMNS),
    /** One row per feed per advertiser. */
    uniqueIndex('awin_feeds_advertiser_feed_key').on(t.advertiserRowId, t.feedId),
  ],
);

/**
 * `awin_advertiser_quality` — what one import MEASURED about one advertiser's
 * data (issue quality control 1 and 2).
 *
 * APPEND-ONLY by trigger, against UPDATE and DELETE alike. A quality history
 * whose rows can be edited answers "was this feed always like this" with
 * whatever somebody most recently believed, and the question is usually asked
 * during an argument about whether a regression is new.
 *
 * It cites the #62 run that produced it rather than standing alone, so a
 * snapshot is always traceable to a pass with its own outcome, its own counters
 * and its own rejections.
 */
export const awinAdvertiserQuality = pgTable(
  'awin_advertiser_quality',
  {
    id: generatedId(),
    advertiserRowId: text()
      .notNull()
      .references(() => awinAdvertisers.id, { onDelete: 'restrict' }),
    feedRowId: text()
      .notNull()
      .references(() => awinFeeds.id, { onDelete: 'restrict' }),
    /**
     * The pass this was measured on.
     *
     * `set null` rather than RESTRICT, and it is the one FK here worth arguing
     * about: the measurement is a fact about the ADVERTISER and the run pointer
     * is provenance for it, so a run that is one day swept must not take the
     * quality history with it. `catalog_source_distributions.run_id` (#68) made
     * the same call for the same reason.
     */
    runId: text().references(() => catalogSourceRuns.id, { onDelete: 'set null' }),
    measuredAt: timestamptz().notNull(),
    mappingVersion: integer().notNull(),

    scanned: integer().notNull(),
    mapped: integer().notNull(),
    rejected: integer().notNull(),

    withGtin: integer().notNull().default(0),
    withMpn: integer().notNull().default(0),
    withBrand: integer().notNull().default(0),
    withImage: integer().notNull().default(0),
    withPrice: integer().notNull().default(0),

    duplicateExternalIds: integer().notNull().default(0),
    duplicateGtins: integer().notNull().default(0),

    rejectedCurrency: integer().notNull().default(0),
    rejectedPrice: integer().notNull().default(0),
    contradictoryAvailability: integer().notNull().default(0),

    trackingApproved: integer().notNull().default(0),
    trackingRejected: integer().notNull().default(0),

    /**
     * The swapped-URL-columns detector, counted over the whole feed (#589).
     *
     * `destination_tracking_host` is the observation: this row's DESTINATION was
     * one of `AWIN_TRACKING_HOSTS` while its deep link was not.
     * `destination_tracked_only` is the other arm of the conjunction — both
     * columns tracked, which is a tracked-only feed and not a swap — and it is
     * here as the detector's POSITIVE CONTROL. A zero in the first column reads
     * the same on a clean feed and on one where the conjunction could never
     * fire; the second column is the only thing that tells those apart.
     */
    destinationTrackingHost: integer().notNull().default(0),
    destinationTrackedOnly: integer().notNull().default(0),

    /**
     * The two HOSTS the first flagged row disagreed about, so the person reading
     * the counter can see what the detector saw.
     *
     * The residual is that a tracked destination beside a retailer deep link
     * cannot be told from a deliberate configuration by inspection, so an
     * operator has to look at the values. **They are not obtainable from the
     * offer**, which is why these columns exist: on exactly the rows this
     * counter flags, the deep-link column holds a RETAILER url,
     * `assessAwinTrackingLink` refuses it as `rejected_host`, and
     * `withAssessedAwinTracking` withholds it — so
     * `offers.affiliate_tracking_template` is NULL and only the tracked
     * destination survives.
     *
     * HOSTS and never URLs. This schema stores no URL of any kind because the
     * product-data API key lives in the PATH of a feed URL, and
     * `awin-isolation.test.ts` fails the build on any column here whose name
     * reads as one. A host has no path and no query, so the hazard is removed
     * rather than excused — and nothing is lost, because a host is exactly what
     * the detector compared.
     *
     * ONE example rather than a list: this is a fact about the feed's column
     * MAPPING and every flagged row in a pass says the same thing about it.
     */
    swapExampleDestinationHost: text(),
    swapExampleDeepLinkHost: text(),

    createdAt: createdAt(),
  },
  (t) => [
    /**
     * THE VACUITY FLOOR, as a CHECK (#60's device).
     *
     * Equality and never `<=`: a page that swallowed a record cannot write the
     * snapshot at all, so "zero rejected over zero scanned" stops being
     * indistinguishable from "zero rejected over fifty thousand scanned" —
     * which is the difference between a clean feed and a traversal that read
     * nothing, and they produce the same tidy report.
     */
    check(
      'awin_advertiser_quality_totals_check',
      sql`${t.scanned} = ${t.mapped} + ${t.rejected}`,
    ),
    check(
      'awin_advertiser_quality_nonnegative_check',
      sql`${t.scanned} >= 0 and ${t.mapped} >= 0 and ${t.rejected} >= 0
          and ${t.withGtin} >= 0 and ${t.withMpn} >= 0 and ${t.withBrand} >= 0
          and ${t.withImage} >= 0 and ${t.withPrice} >= 0
          and ${t.duplicateExternalIds} >= 0 and ${t.duplicateGtins} >= 0
          and ${t.rejectedCurrency} >= 0 and ${t.rejectedPrice} >= 0
          and ${t.contradictoryAvailability} >= 0
          and ${t.trackingApproved} >= 0 and ${t.trackingRejected} >= 0
          and ${t.destinationTrackingHost} >= 0 and ${t.destinationTrackedOnly} >= 0`,
    ),
    /**
     * A completeness count cannot exceed what was mapped.
     *
     * A row is only counted as carrying a GTIN if it became a record, so
     * `with_gtin > mapped` is arithmetically impossible and its appearance
     * would mean the counter was incremented somewhere the record was not —
     * which is exactly the shape a partially-refactored measurement takes.
     */
    check(
      'awin_advertiser_quality_coverage_check',
      sql`${t.withGtin} <= ${t.mapped} and ${t.withMpn} <= ${t.mapped}
          and ${t.withBrand} <= ${t.mapped} and ${t.withImage} <= ${t.mapped}
          and ${t.withPrice} <= ${t.mapped}
          and ${t.trackingApproved} + ${t.trackingRejected} <= ${t.mapped}
          and ${t.destinationTrackingHost} + ${t.destinationTrackedOnly} <= ${t.mapped}`,
    ),
    check('awin_advertiser_quality_mapping_version_check', sql`${t.mappingVersion} >= 1`),
    /**
     * The swap evidence is BOUNDED, PAIRED and EARNED.
     *
     * Bounded by the handle length every provider-supplied host in this schema
     * carries, because these are values a stranger writes into a CSV. Paired,
     * because a deep-link host with no destination beside it describes nothing.
     * And earned: an example may only sit on a snapshot that actually flagged
     * something, so a row cannot carry evidence for a finding it did not make.
     */
    check(
      'awin_advertiser_quality_swap_example_check',
      sql`(${t.swapExampleDestinationHost} is null
           or (length(${t.swapExampleDestinationHost})
               <= ${sql.raw(String(AWIN_MAX_HANDLE_LENGTH))}
               and ${t.destinationTrackingHost} > 0))
          and (${t.swapExampleDeepLinkHost} is null
               or (length(${t.swapExampleDeepLinkHost})
                   <= ${sql.raw(String(AWIN_MAX_HANDLE_LENGTH))}
                   and ${t.swapExampleDestinationHost} is not null))`,
    ),
    /** The board's read: this advertiser's history, newest first. */
    index('awin_advertiser_quality_advertiser_measured_idx').on(
      t.advertiserRowId,
      t.measuredAt,
    ),
  ],
);

/**
 * `awin_link_samples` — a bounded check of an advertiser's destination and
 * tracking behaviour, taken before it may be activated (issue quality
 * control 4).
 *
 * APPEND-ONLY by trigger, for the reason every audited decision in this
 * codebase is: a sample that can be edited after the activation it authorised
 * is not evidence, and the edit would be invisible beside an advertiser that
 * has been live for a month.
 *
 * The findings are a closed set, so "it failed" always names which of six
 * things failed. `destination_is_tracking_host` is the subtle one: a deep link
 * and a destination that disagree about which retailer this is means the feed's
 * two URL columns were mapped to each other's roles, which produces a catalogue
 * that works perfectly until somebody audits where the money went. It is the one
 * finding a production code path MEASURES — `assessAwinDestination`, counted per
 * import into `awin_advertiser_quality.destination_tracking_host` — while the
 * verdict and the rest of the array remain an operator's attestation. Those are
 * different kinds of claim and this table stores the second; see
 * `docs/catalog-sources/awin.md` §"Sampling before activation".
 */
export const awinLinkSamples = pgTable(
  'awin_link_samples',
  {
    id: generatedId(),
    advertiserRowId: text()
      .notNull()
      .references(() => awinAdvertisers.id, { onDelete: 'restrict' }),
    feedRowId: text()
      .notNull()
      .references(() => awinFeeds.id, { onDelete: 'restrict' }),

    verdict: text({ enum: asEnumValues(AWIN_SAMPLE_VERDICTS) }).notNull().default('pending'),
    /** How many rows were examined. The sample's own vacuity floor. */
    sampled: integer().notNull(),
    /** How many carried an APPROVED tracking link and a consistent destination. */
    passedRows: integer().notNull().default(0),

    findings: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /** WHO took it. A sample nobody signed is one nobody can be asked about. */
    takenByOxyUserId: text().notNull(),
    takenAt: timestamptz().notNull(),
    note: text(),

    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('awin_link_samples_verdict_check', t.verdict, AWIN_SAMPLE_VERDICTS),
    checkEveryElementOf('awin_link_samples_findings_check', t.findings, AWIN_SAMPLE_FINDINGS),
    check(
      'awin_link_samples_counts_check',
      sql`${t.sampled} >= 1 and ${t.passedRows} >= 0 and ${t.passedRows} <= ${t.sampled}`,
    ),
    /**
     * A PASS has no findings, and a FAIL has at least one.
     *
     * `coalesce(array_length(col, 1), 0)`, never `array_length(col, 1) >= 1`:
     * on an EMPTY array `array_length` is NULL and a CHECK reads NULL as
     * SATISFIED, so the obvious spelling admits exactly the row it exists to
     * refuse. Measured twice in #68; every array-non-emptiness CHECK in this
     * schema reads the coalesced form.
     */
    check(
      'awin_link_samples_verdict_shape_check',
      sql`(${t.verdict} <> 'passed' or coalesce(array_length(${t.findings}, 1), 0) = 0)
          and (${t.verdict} <> 'failed' or coalesce(array_length(${t.findings}, 1), 0) >= 1)`,
    ),
    check(
      'awin_link_samples_note_length_check',
      sql`${t.note} is null or length(${t.note}) <= ${sql.raw(String(AWIN_MAX_TEXT_LENGTH))}`,
    ),
    index('awin_link_samples_advertiser_taken_idx').on(t.advertiserRowId, t.takenAt),
  ],
);

/**
 * `awin_network_leases` — the FLEET-WIDE bound on how hard Mercaria may knock on
 * Awin, keyed on the publisher ACCOUNT.
 *
 * #68's `catalog_source_refresh_leases`, itself #122's `supplier_call_leases`,
 * pointed one level up. The argument is the same and the reason it has to be
 * REPEATED here rather than reused is the key: #68's lease is keyed on
 * `source_id`, and #66 gives every advertiser its own source — so #68's budget
 * bounds each advertiser separately and the network not at all. Fifty
 * advertisers with an allowance of twenty each is a thousand calls a minute at
 * one host under one key, which is how a publisher account gets suspended.
 *
 * Both leases are claimed and they answer different questions: #68's is "how
 * hard may Mercaria knock on THIS advertiser's feed", this one is "how hard may
 * Mercaria knock on AWIN".
 *
 * CONCURRENCY is exact because a slot is a row and a claim is a row lock. RATE
 * is exact because each slot carries its own equal share of the account's
 * per-minute allowance and one row's counter is serialized by that same lock.
 * The trade is stated rather than hidden: an uneven arrival pattern can spend
 * one slot's share while another sits idle, so the limiter can UNDER-admit —
 * which errs toward not exceeding a published limit, the direction a provider
 * punishes.
 */
export const awinNetworkLeases = pgTable(
  'awin_network_leases',
  {
    id: generatedId(),
    accountId: text()
      .notNull()
      .references(() => awinAccounts.id, { onDelete: 'restrict' }),
    /** 0-based concurrency slot. The row count IS the concurrency bound. */
    slot: integer().notNull(),
    /** The claiming process. NULL = free. */
    leaseOwner: text(),
    /** When the claim lapses and another task may reclaim it. */
    leaseUntil: timestamptz(),
    /** The start of the minute this slot's counter is counting. */
    windowStart: timestamptz().notNull(),
    /** Calls this slot has STARTED inside `window_start`. */
    callsInWindow: integer().notNull().default(0),
    /** This slot's share of the account's per-minute allowance, snapshotted. */
    windowAllowance: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('awin_network_leases_slot_check', sql`${t.slot} >= 0`),
    /**
     * A lease is an owner AND a deadline, together. Half of one is a slot no
     * task can prove it holds and no sweep can safely reclaim.
     */
    check(
      'awin_network_leases_lease_shape_check',
      sql`num_nonnulls(${t.leaseOwner}, ${t.leaseUntil}) in (0, 2)`,
    ),
    check(
      'awin_network_leases_window_check',
      sql`${t.callsInWindow} >= 0 and ${t.windowAllowance} >= 1
          and ${t.callsInWindow} <= ${t.windowAllowance}`,
    ),
    uniqueIndex('awin_network_leases_account_slot_key').on(t.accountId, t.slot),
    /** The claim: this account's free slots. */
    index('awin_network_leases_account_free_idx').on(t.accountId, t.leaseUntil),
  ],
);
