/**
 * Affiliate outbound redirects, click records and commission reconciliation
 * (#67, part of #37) — six tables.
 *
 * ## The one that carries the security property
 *
 * `affiliate_outbound_hosts`. Everything else here records what happened;
 * this one decides where a buyer may be SENT. Requirement 2 asks that the
 * redirect "resolve only an allowlisted source, storefront and destination
 * associated with the offer", and this is that allow-list: a host, approved by
 * an operator, scoped to ONE catalog source, revocable, attributable.
 *
 * It is a TABLE and not a config value because which shops a source sells is a
 * fact about a commercial relationship that changes without a deploy. The
 * network's own redirectors are the opposite case and are a CODE constant
 * (`AWIN_TRACKING_HOSTS` and its siblings) for the reason #66 records: a
 * configurable set would make "which hosts may Mercaria redirect to" answerable
 * differently per deployment, which is the shape an open redirect eventually
 * takes.
 *
 * An EMPTY table permits nothing but the network redirectors, which is the
 * correct starting state — a fresh deployment redirects to Awin's own links and
 * to nowhere else until somebody approves a host.
 *
 * ## Why the click row has no foreign keys at all
 *
 * `affiliate_outbound_clicks` names an offer, a variant, a merchant, a
 * storefront and a source, and NOT ONE of them is a foreign key. That is
 * deliberate and it is the same ruling #78 made for
 * `offer_price_series.selected_offer_id`: a click is an immutable record of a
 * redirect that HAPPENED, so every id on it is a value observed at that instant
 * rather than a live reference. A foreign key would make it a live one, with
 * two bad consequences — `offers` CASCADEs from `listings`, so a seller's
 * deletion would silently destroy commercial history, and #59's merge would
 * repoint a past click onto a product it was not for.
 *
 * The columns are therefore registered in `ID_COLUMNS_WITHOUT_FOREIGN_KEY`.
 * `affiliate_outbound_hosts.catalog_source_id` IS a real foreign key, because
 * that row is live configuration rather than history.
 *
 * ## The append-only trail, and the one place DELETE is permitted
 *
 * `affiliate_transaction_observations` and `affiliate_commission_postings`
 * refuse UPDATE **and** DELETE by trigger — acceptance 4 ("reversed commissions
 * update reporting without deleting history") is that pair of refusals, and a
 * posting that could be deleted would let somebody unwind money outside the
 * ledger's own reversing-transaction rule.
 *
 * `affiliate_outbound_clicks` refuses UPDATE and PERMITS DELETE, inverting that
 * posture on purpose and matching `analytics_events`: erasure on a schedule is
 * the retention policy (`retention_expires_at`, swept by the shared expiry
 * sweep), and a trigger refusing DELETE would make retention fail SILENTLY on
 * every row it is obliged to remove.
 *
 * ## What is NOT here
 *
 * No order. Conversion rule "do not create a Mercaria marketplace order for an
 * external conversion" is held by there being no order id anywhere in this
 * schema and no writer that could produce one.
 *
 * No buyer. There is no actor column on any of the six tables — not an Oxy user
 * id, not a guest session id, not a pseudonymous id. #67's click requirement 5
 * offers "signed-in Oxy user id only when permitted and needed, otherwise a
 * short-lived pseudonymous session id", and the answer taken here is NEITHER:
 * nothing this domain reports needs to know who clicked. Every metric #67 names
 * is a COUNT or a SUM over offers, merchants, sources and markets, so a per-person
 * handle on a commercial record retained for accounting would be a correlation
 * key that buys nothing. That makes the consent question small rather than
 * absent — `consent_mode` is recorded because the LAWFUL BASIS for the
 * measurement is still a fact about the request, and it is the coarse three-way
 * word #143 already uses.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  AFFILIATE_COMMISSION_POSTING_KINDS,
  AFFILIATE_MATCH_STATES,
  AFFILIATE_NETWORK_IDS,
  AFFILIATE_OBSERVATION_KINDS,
  AFFILIATE_REPORT_FAILURE_REASONS,
  AFFILIATE_REPORT_RUN_STATES,
  AFFILIATE_TRANSACTION_STATES,
  AFFILIATE_UNMATCHED_REASONS,
  OUTBOUND_CLIENT_SURFACES,
  OUTBOUND_DESTINATION_KINDS,
  OUTBOUND_REDIRECT_DISPOSITIONS,
  OUTBOUND_REDIRECT_REFUSAL_REASONS,
  REFERRAL_CONSENT_MODES,
  REFERRAL_TRAFFIC_CLASSES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, money, optionalMoney } from './columns';
import { catalogSources } from './provenance';
import { ledgerTransactions } from './ledger';

/* -------------------------------------------------------------------------- */
/*  1. The destination allow-list                                              */
/* -------------------------------------------------------------------------- */

/**
 * Hosts an operator has approved as outbound destinations for one catalog
 * source.
 *
 * The `host` column is a bare, lower-cased hostname and the CHECK says so: no
 * scheme, no path, no port, no userinfo, no wildcard. A stored `*.example.com`
 * or `https://example.com/` would each require the admission code to interpret
 * the row, and an allow-list that needs interpreting is one whose meaning can
 * drift from what the operator who typed it believed. Comparison at redirect
 * time is EXACT against a parsed `URL.hostname` — never `endsWith`, under which
 * `example.com.evil.test` matches, which is the one host shape this table
 * exists for.
 */
export const affiliateOutboundHosts = pgTable(
  'affiliate_outbound_hosts',
  {
    id: generatedId(),
    /**
     * The source this approval is scoped to. A real foreign key — this row is
     * live configuration, not history — and `restrict`, so a source carrying
     * approved destinations cannot be dropped out from under them.
     */
    catalogSourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    /** A bare lower-cased hostname. See the table docblock. */
    host: text().notNull(),
    kind: text({ enum: asEnumValues(OUTBOUND_DESTINATION_KINDS) }).notNull(),
    /** Why this host was approved, in the operator's own words. Mandatory. */
    reason: text().notNull(),
    approvedByOxyUserId: text().notNull(),
    approvedAt: timestamptz().notNull().defaultNow(),
    /** Revocation keeps the row — an approval that was withdrawn is history. */
    revokedAt: timestamptz(),
    revokedByOxyUserId: text(),
    revokedReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('affiliate_outbound_hosts_kind_check', t.kind, OUTBOUND_DESTINATION_KINDS),
    /**
     * ONE live approval per (source, host). PARTIAL on `revoked_at is null`, so
     * a host can be approved, revoked and approved again — a plain unique would
     * forbid the second approval forever, and Postgres treats NULLs as distinct
     * so it would not even converge two concurrent operators.
     */
    uniqueIndex('affiliate_outbound_hosts_live_key')
      .on(t.catalogSourceId, t.host)
      .where(sql`${t.revokedAt} is null`),
    index('affiliate_outbound_hosts_source_idx').on(t.catalogSourceId),
    /*
     * A bare hostname: at least one label and a DOT-separated tail, lower-case
     * ASCII, digits and hyphens only. Rejects a scheme, a path, a port, a
     * wildcard, userinfo, a single-label internal name and an empty string in
     * one predicate.
     *
     * ## The literal dot is `[.]` and MUST NOT be written `\.`
     *
     * This is a tagged TEMPLATE LITERAL, so JavaScript processes escapes in the
     * cooked string before drizzle ever sees it. `\.` is not a recognised
     * escape, so the backslash is silently DROPPED and what reaches Postgres is
     * `(.[a-z0-9]…)`, where `.` matches ANY character — which admits
     * `localhost`, the exact single-label internal name this predicate exists
     * to make unrepresentable.
     *
     * Measured, not reasoned: the shipped spelling admitted `localhost`,
     * `example.test/deals`, `example.test:443` and `user:pass@example.test`.
     * Three of those are stored-but-dead because a parsed `URL.hostname` can
     * never contain `/`, `:` or `@`; `localhost` is REACHABLE.
     *
     * NOTHING in the build could see it. `tsc` type-checks a template literal,
     * drizzle-kit renders whatever string it is handed, and the migration
     * applies cleanly. A character class cannot be mangled by an escape-
     * processing layer, which is why it is used here rather than `\\.` — that
     * spelling is correct today and one well-meant "simplification" away from
     * being wrong again.
     */
    check(
      'affiliate_outbound_hosts_shape_check',
      sql`${t.host} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
        and length(${t.host}) <= 253`,
    ),
    check('affiliate_outbound_hosts_reason_check', sql`length(${t.reason}) > 0`),
    // Revocation is attributable, dated and explained, or it is not a
    // revocation anybody can audit — and a live row carrying any of the three
    // would read as one.
    check(
      'affiliate_outbound_hosts_revocation_check',
      sql`(${t.revokedAt} is null) = (${t.revokedByOxyUserId} is null)
        and (${t.revokedAt} is null) = (${t.revokedReason} is null)`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/*  2. The click record                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One request for `/out/:token`, redirected or refused.
 *
 * Written on BOTH paths. A refusal that stored nothing would make "why is this
 * merchant's button dead" unanswerable, which is the question an operator
 * actually gets — so `disposition` plus `refusal_reason` is the row's shape and
 * a CHECK ties them.
 *
 * Bots, previews and internal traffic get a row and a redirect and are excluded
 * from every human metric by `traffic_class`. They are NOT refused: varying the
 * destination by user agent is cloaking, and #143's classifier is built so its
 * verdict can never change where somebody is sent.
 */
export const affiliateOutboundClicks = pgTable(
  'affiliate_outbound_clicks',
  {
    /** The Mercaria click id (click requirement 1). */
    id: generatedId(),

    // ── The offer and its commercial context, SNAPSHOTTED (requirement 2) ────
    // Recorded values, not references. See the module docblock.
    offerId: text().notNull(),
    canonicalVariantId: text(),
    merchantId: text(),
    storefrontId: text(),
    catalogSourceId: text(),
    /**
     * The network as the OFFER declared it — free text, mirroring
     * `offers.affiliate_network`, and deliberately NOT the narrower
     * `AFFILIATE_NETWORK_IDS`. A click on an offer from a network Mercaria
     * cannot reconcile is still a click, and a CHECK here would refuse to
     * record it.
     */
    affiliateNetwork: text(),
    affiliateProgramRef: text(),
    affiliatePublisherRef: text(),

    // ── Where it went (requirement 5, and the trace acceptance 5 asks for) ───
    /**
     * The destination HOST and never the URL.
     *
     * The URL is reproducible from `offer_id` — and storing it would put a
     * network's tracked address, which can carry a publisher credential in its
     * path, into a table an operator surface reads whole.
     */
    destinationHost: text(),
    /** How that host earned admission. NULL on a refusal that never got there. */
    destinationKind: text({ enum: asEnumValues(OUTBOUND_DESTINATION_KINDS) }),

    // ── The request, coarsely (requirement 4) ───────────────────────────────
    /** ISO 3166-1 alpha-2 of the offer's market, from the OFFER, not the caller. */
    market: text(),
    clientSurface: text({ enum: asEnumValues(OUTBOUND_CLIENT_SURFACES) }).notNull(),
    /** #143's four-way class. `organic` is the only one that is a human click. */
    trafficClass: text({ enum: asEnumValues(REFERRAL_TRAFFIC_CLASSES) }).notNull(),
    /**
     * WHICH signal produced the class — a bounded enum, never the header.
     *
     * #143's rule, restated because it is the one that would erode: copying a
     * `User-Agent` into a row is how an unbounded, identifying blob enters a
     * domain whose whole design is that it holds none.
     */
    trafficSignal: text().notNull(),
    /** The lawful basis for the measurement (requirement 6). */
    consentMode: text({ enum: asEnumValues(REFERRAL_CONSENT_MODES) }).notNull(),

    // ── The outcome (requirement 7) ─────────────────────────────────────────
    disposition: text({ enum: asEnumValues(OUTBOUND_REDIRECT_DISPOSITIONS) }).notNull(),
    refusalReason: text({ enum: asEnumValues(OUTBOUND_REDIRECT_REFUSAL_REASONS) }),

    occurredAt: timestamptz().notNull().defaultNow(),
    /**
     * When this row may be swept. Stamped at write time; the shared expiry
     * sweep is the only deleter.
     *
     * A COLUMN rather than a policy the sweep interprets, because
     * `@oxyhq/db`'s sweep takes `{table, column, retentionSeconds}` and has no
     * predicate — a conditional retention expressed anywhere but a column
     * cannot be handed to it.
     */
    retentionExpiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'affiliate_outbound_clicks_surface_check',
      t.clientSurface,
      OUTBOUND_CLIENT_SURFACES,
    ),
    checkOneOf(
      'affiliate_outbound_clicks_traffic_check',
      t.trafficClass,
      REFERRAL_TRAFFIC_CLASSES,
    ),
    checkOneOf(
      'affiliate_outbound_clicks_consent_check',
      t.consentMode,
      REFERRAL_CONSENT_MODES,
    ),
    checkOneOf(
      'affiliate_outbound_clicks_disposition_check',
      t.disposition,
      OUTBOUND_REDIRECT_DISPOSITIONS,
    ),
    checkOneOf(
      'affiliate_outbound_clicks_refusal_check',
      t.refusalReason,
      OUTBOUND_REDIRECT_REFUSAL_REASONS,
    ),
    checkOneOf(
      'affiliate_outbound_clicks_destination_kind_check',
      t.destinationKind,
      OUTBOUND_DESTINATION_KINDS,
    ),
    /**
     * A redirect names its destination and no reason; a refusal names its
     * reason and no destination.
     *
     * TWO biconditionals rather than one over their conjunction. The obvious
     * single-predicate spelling is SATISFIED by a row that is neither — both
     * sides evaluate false — which admits exactly the row this exists to
     * refuse. Measured twice in this schema already (#108's portal grants,
     * #126's delivery promises); written the long way here from the start.
     */
    check(
      'affiliate_outbound_clicks_outcome_shape_check',
      sql`(${t.disposition} = 'redirected') = (${t.refusalReason} is null)
        and (${t.disposition} = 'redirected') = (${t.destinationHost} is not null)
        and (${t.disposition} = 'redirected') = (${t.destinationKind} is not null)`,
    ),
    check('affiliate_outbound_clicks_signal_check', sql`length(${t.trafficSignal}) > 0`),
    check(
      'affiliate_outbound_clicks_market_check',
      sql`${t.market} is null or ${t.market} ~ '^[A-Z]{2}$'`,
    ),
    // The two reads: a source's own clicks over a window (the operator report,
    // and the merchant-facing aggregate), and one offer's clicks (the trace).
    index('affiliate_outbound_clicks_source_time_idx').on(t.catalogSourceId, t.occurredAt),
    index('affiliate_outbound_clicks_offer_time_idx').on(t.offerId, t.occurredAt),
    index('affiliate_outbound_clicks_retention_idx').on(t.retentionExpiresAt),
  ],
);

/* -------------------------------------------------------------------------- */
/*  3. One poll of a network's report                                          */
/* -------------------------------------------------------------------------- */

/**
 * One request to a network for one window of transactions.
 *
 * Exists so "when did we last hear from Awin, and for what period" is a row
 * rather than an inference from the newest transaction — which is exactly the
 * inference that reads a silent network as a quiet week. Reporting item 8
 * ("data freshness and report lag") is answered from here.
 *
 * The counters carry the vacuity floor #60 established as a CHECK rather than a
 * comment: `seen` must EQUAL the sum of the five outcomes, so a page that
 * swallowed a transaction cannot write a row at all.
 */
export const affiliateReportRuns = pgTable(
  'affiliate_report_runs',
  {
    id: generatedId(),
    network: text({ enum: asEnumValues(AFFILIATE_NETWORK_IDS) }).notNull(),
    /** Which account the report was drawn under — a publisher id, never a secret. */
    accountRef: text().notNull(),
    /** The window REQUESTED, both ends inclusive, as the network understands it. */
    windowFrom: timestamptz().notNull(),
    windowTo: timestamptz().notNull(),
    state: text({ enum: asEnumValues(AFFILIATE_REPORT_RUN_STATES) }).notNull(),
    failureReason: text({ enum: asEnumValues(AFFILIATE_REPORT_FAILURE_REASONS) }),

    transactionsSeen: integer().notNull().default(0),
    transactionsCreated: integer().notNull().default(0),
    transactionsStateChanged: integer().notNull().default(0),
    transactionsAmountChanged: integer().notNull().default(0),
    transactionsRestated: integer().notNull().default(0),
    transactionsUnchanged: integer().notNull().default(0),

    startedAt: timestamptz().notNull().defaultNow(),
    completedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('affiliate_report_runs_network_check', t.network, AFFILIATE_NETWORK_IDS),
    checkOneOf('affiliate_report_runs_state_check', t.state, AFFILIATE_REPORT_RUN_STATES),
    checkOneOf(
      'affiliate_report_runs_failure_check',
      t.failureReason,
      AFFILIATE_REPORT_FAILURE_REASONS,
    ),
    /**
     * The vacuity floor, as EQUALITY and never `<=`.
     *
     * Scoped to a COMPLETED run: a `running` row has counters that are still
     * moving, and a `failed` one legitimately read some of a page before the
     * failure. Only a run claiming it finished must account for everything it
     * saw.
     */
    check(
      'affiliate_report_runs_counters_total_check',
      sql`${t.state} <> 'completed' or ${t.transactionsSeen} =
        ${t.transactionsCreated} + ${t.transactionsStateChanged} + ${t.transactionsAmountChanged}
        + ${t.transactionsRestated} + ${t.transactionsUnchanged}`,
    ),
    check(
      'affiliate_report_runs_failure_shape_check',
      sql`(${t.state} = 'failed') = (${t.failureReason} is not null)`,
    ),
    check(
      'affiliate_report_runs_completion_shape_check',
      sql`(${t.state} = 'running') = (${t.completedAt} is null)`,
    ),
    check('affiliate_report_runs_window_check', sql`${t.windowFrom} <= ${t.windowTo}`),
    index('affiliate_report_runs_network_time_idx').on(t.network, t.startedAt),
  ],
);

/* -------------------------------------------------------------------------- */
/*  4. The network-reported transaction                                        */
/* -------------------------------------------------------------------------- */

/**
 * One transaction a network reports, in its CURRENT state.
 *
 * The row is the network's word and Mercaria's bookkeeping about it, and the
 * two are kept in separate columns: `state` and the amounts are theirs;
 * `match_state`, `unmatched_reason` and the postings are ours.
 *
 * ## Amounts are SOURCE-REPORTED and are never converted
 *
 * Two `Money` pairs, each naming its own currency (conversion requirement 3).
 * Mercaria performs no FX here — a network reports in the advertiser's currency
 * and a rate moving between the report and a payout would change an amount
 * somebody else decided. The ledger posting is booked in the commission's own
 * currency, which is what makes "sums to zero PER currency" hold with no rate
 * involved at all.
 *
 * ## Dedup is the DATABASE's
 *
 * `UNIQUE(network, network_transaction_id)` plus `ON CONFLICT … DO UPDATE …
 * RETURNING` on a predicate. A re-poll of an overlapping window is the NORMAL
 * case — windows are chunked to 31 days and re-polled to catch corrections — so
 * "already seen" is an answer the index gives, never an error a catch
 * interprets. One failed statement aborts the whole transaction in Postgres, so
 * a duplicate-key catch could not be recovered from anyway.
 */
export const affiliateTransactions = pgTable(
  'affiliate_transactions',
  {
    id: generatedId(),
    network: text({ enum: asEnumValues(AFFILIATE_NETWORK_IDS) }).notNull(),
    /** The network's own id for the transaction (conversion requirement 2). */
    networkTransactionId: text().notNull(),
    /** The advertiser/programme the conversion happened at (requirement 4). */
    advertiserRef: text(),
    /** The publisher id Mercaria was paid under. */
    publisherRef: text(),

    state: text({ enum: asEnumValues(AFFILIATE_TRANSACTION_STATES) }).notNull(),

    // Source-reported amounts. Both optional: a network can report a
    // conversion whose order value it does not disclose.
    ...optionalMoney('orderValue'),
    ...money('commission'),

    /** When the conversion happened, per the network (requirement 4). */
    eventAt: timestamptz().notNull(),
    /** When the network processed it, when it says. */
    networkProcessedAt: timestamptz(),

    // ── Attribution (conversion requirement 6) ───────────────────────────────
    /** The click reference the NETWORK reported, if any. Never one Mercaria sent. */
    networkClickRef: text(),
    /** The Mercaria click this was tied to. A recorded value, not a reference. */
    matchedClickId: text(),
    matchState: text({ enum: asEnumValues(AFFILIATE_MATCH_STATES) }).notNull(),
    unmatchedReason: text({ enum: asEnumValues(AFFILIATE_UNMATCHED_REASONS) }),

    /** First and latest observation, so report lag is measurable per row. */
    firstObservedAt: timestamptz().notNull().defaultNow(),
    lastObservedAt: timestamptz().notNull().defaultNow(),
    /**
     * A digest of every source-reported field, so "did anything change" is one
     * comparison rather than six, and a re-poll that changed nothing is
     * countable as `unchanged` rather than guessed at.
     */
    contentDigest: text().notNull(),
    observationCount: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('affiliate_transactions_network_check', t.network, AFFILIATE_NETWORK_IDS),
    checkOneOf('affiliate_transactions_state_check', t.state, AFFILIATE_TRANSACTION_STATES),
    checkOneOf('affiliate_transactions_match_check', t.matchState, AFFILIATE_MATCH_STATES),
    checkOneOf(
      'affiliate_transactions_unmatched_reason_check',
      t.unmatchedReason,
      AFFILIATE_UNMATCHED_REASONS,
    ),
    ...currencyChecks('affiliate_transactions', [t.orderValueCurrency, t.commissionCurrency]),
    /** Deduplication (conversion requirement 5), as an index rather than a rule. */
    uniqueIndex('affiliate_transactions_network_key').on(t.network, t.networkTransactionId),
    /**
     * An unmatched transaction names WHY; a matched one names the click.
     *
     * Two biconditionals again, for the reason the click table gives.
     */
    check(
      'affiliate_transactions_match_shape_check',
      sql`(${t.matchState} = 'matched') = (${t.matchedClickId} is not null)
        and (${t.matchState} = 'unmatched') = (${t.unmatchedReason} is not null)`,
    ),
    // An optional Money is two columns and they are absent TOGETHER. Without
    // this an amount could sit beside a NULL currency, which is a number nobody
    // can interpret and which `currencyChecks` reads as legitimate absence.
    check(
      'affiliate_transactions_order_value_shape_check',
      sql`(${t.orderValueAmount} is null) = (${t.orderValueCurrency} is null)`,
    ),
    check('affiliate_transactions_digest_check', sql`length(${t.contentDigest}) = 64`),
    check(
      'affiliate_transactions_observation_order_check',
      sql`${t.firstObservedAt} <= ${t.lastObservedAt}`,
    ),
    check('affiliate_transactions_observation_count_check', sql`${t.observationCount} >= 1`),
    index('affiliate_transactions_network_event_idx').on(t.network, t.eventAt),
    index('affiliate_transactions_state_idx').on(t.network, t.state),
    index('affiliate_transactions_click_idx').on(t.matchedClickId),
  ],
);

/* -------------------------------------------------------------------------- */
/*  5. Every observation of that transaction, append-only                      */
/* -------------------------------------------------------------------------- */

/**
 * What one poll saw about one transaction — the history acceptance 4 asks for.
 *
 * Append-only against UPDATE **and** DELETE. A reversal is a NEW row saying the
 * network now reports `reversed`; the previous row saying it reported
 * `approved` stays exactly as it was. That is the whole of "reversed
 * commissions update reporting without deleting history", and it is a trigger
 * rather than a convention because the tempting shortcut — updating the
 * transaction row and moving on — leaves nothing anywhere saying the commission
 * was ever approved, which is the number a publisher statement is reconciled
 * against.
 */
export const affiliateTransactionObservations = pgTable(
  'affiliate_transaction_observations',
  {
    id: generatedId(),
    transactionId: text()
      .notNull()
      .references(() => affiliateTransactions.id, { onDelete: 'restrict' }),
    reportRunId: text()
      .notNull()
      .references(() => affiliateReportRuns.id, { onDelete: 'restrict' }),
    /** 1 for the first observation, then monotonically per transaction. */
    revision: integer().notNull(),
    kind: text({ enum: asEnumValues(AFFILIATE_OBSERVATION_KINDS) }).notNull(),

    /** What the network said THIS time. */
    state: text({ enum: asEnumValues(AFFILIATE_TRANSACTION_STATES) }).notNull(),
    ...optionalMoney('orderValue'),
    ...money('commission'),
    eventAt: timestamptz().notNull(),
    networkProcessedAt: timestamptz(),
    contentDigest: text().notNull(),

    observedAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('affiliate_tx_observations_kind_check', t.kind, AFFILIATE_OBSERVATION_KINDS),
    checkOneOf('affiliate_tx_observations_state_check', t.state, AFFILIATE_TRANSACTION_STATES),
    ...currencyChecks('affiliate_tx_observations', [t.orderValueCurrency, t.commissionCurrency]),
    /**
     * One revision number per transaction. Makes a double-apply of the same
     * observation converge on the index rather than appending a duplicate — the
     * `ON CONFLICT DO NOTHING RETURNING` answer, one table over.
     */
    uniqueIndex('affiliate_tx_observations_revision_key').on(t.transactionId, t.revision),
    check(
      'affiliate_tx_observations_order_value_shape_check',
      sql`(${t.orderValueAmount} is null) = (${t.orderValueCurrency} is null)`,
    ),
    check('affiliate_tx_observations_revision_check', sql`${t.revision} >= 1`),
    check('affiliate_tx_observations_digest_check', sql`length(${t.contentDigest}) = 64`),
    index('affiliate_tx_observations_run_idx').on(t.reportRunId),
  ],
);

/* -------------------------------------------------------------------------- */
/*  6. What was booked to the ledger for it                                    */
/* -------------------------------------------------------------------------- */

/**
 * The link between a network transaction and the balanced ledger transaction it
 * produced.
 *
 * A TABLE and not a column pair on `affiliate_transactions`, because one
 * transaction produces several postings over its life — an accrual when the
 * network approves it, a reversal when it takes it back, a settlement when it
 * pays — and each is a separate balanced movement. A column would hold the
 * latest and lose the rest, which is the history that makes a publisher
 * statement reconcilable.
 *
 * ## Idempotency is the index
 *
 * `UNIQUE(transaction_id, kind, revision)`. The posting is claimed with
 * `ON CONFLICT DO NOTHING RETURNING` in the SAME transaction as the ledger
 * write, so the empty result IS the "already booked" answer and a re-poll that
 * re-observes an approval cannot double-credit revenue. `revision` is in the
 * key because a network may approve, reverse and approve again — the second
 * accrual is a DIFFERENT posting from the first, and without the revision it
 * would be silently swallowed as a duplicate.
 */
export const affiliateCommissionPostings = pgTable(
  'affiliate_commission_postings',
  {
    id: generatedId(),
    transactionId: text()
      .notNull()
      .references(() => affiliateTransactions.id, { onDelete: 'restrict' }),
    /**
     * The balanced ledger transaction. `restrict`, so nothing can delete a
     * ledger transaction that a commission record points at — the ledger's own
     * trigger already refuses the DELETE, and this makes the refusal reachable
     * from the other side too.
     */
    ledgerTransactionId: text()
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(AFFILIATE_COMMISSION_POSTING_KINDS) }).notNull(),
    /** The observation revision that caused it. See the docblock. */
    revision: integer().notNull(),
    /**
     * SIGNED minor units, in the ledger's own convention: positive is a debit.
     * A `bigint` for the reason every money column here is one — and read back
     * as a JS number, which `MAX_MONEY_MINOR_UNITS` already bounds.
     */
    amountMinor: bigint({ mode: 'number' }).notNull(),
    currency: text().notNull(),
    postedAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'affiliate_commission_postings_kind_check',
      t.kind,
      AFFILIATE_COMMISSION_POSTING_KINDS,
    ),
    ...currencyChecks('affiliate_commission_postings', [t.currency]),
    uniqueIndex('affiliate_commission_postings_key').on(t.transactionId, t.kind, t.revision),
    check('affiliate_commission_postings_revision_check', sql`${t.revision} >= 1`),
    // Zero is not a movement. The ledger says the same thing about its own
    // entries; a posting recording that nothing moved would be a row whose only
    // effect is to make a sum look accounted for.
    check('affiliate_commission_postings_amount_check', sql`${t.amountMinor} <> 0`),
    index('affiliate_commission_postings_ledger_idx').on(t.ledgerTransactionId),
  ],
);
