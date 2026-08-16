/**
 * Expiry Sweep Registry — the replacement for Mercaria's Mongo TTL indexes.
 *
 * Postgres has no TTL index. Mongo reaped; Postgres does not. A table ported
 * without an entry here grows FOREVER — no error, no failing test, no symptom of
 * any kind until disk — and it is structurally invisible in review, because the
 * thing doing the work was never in this codebase to be seen going missing.
 *
 * Three of the entries below carried a TTL index before the port and all three
 * are represented. `@oxyhq/db`'s `sweepAllExpiredRows` takes this list;
 * `db/expirySweeper.ts` schedules it, beside the outbox dispatcher it runs next
 * to.
 *
 * Two more were born in Postgres and never had one: `payment_outboxes` and
 * `payment_provider_events`. They are here because the rule is about the TABLE,
 * not about the port — anything with an `expires_at` that nothing sweeps grows
 * forever, and a table nobody migrated is no less exposed to that than one
 * somebody did.
 *
 * ## The third one could not be copied, and had to be re-expressed
 *
 * `moderation_outboxes` and `moderation_events` are the easy shape: Mongo's
 * `expireAfterSeconds: 0` on a column that already holds the DEADLINE, which is
 * `retentionSeconds: 0` here — the column IS the deadline.
 *
 * `notifications` was `{createdAt: 1}, expireAfterSeconds: 90d,
 * partialFilterExpression: {status: 'dismissed'}` — a CONDITIONAL delete.
 * `ExpirySweepTarget` is `{table, column, retentionSeconds}` and has no filter,
 * so the condition cannot be handed to it. Rather than reach past the module
 * with a hand-written sweep, the CONDITION became a COLUMN: `dismissed_at` is
 * set only on dismissal, so "90 days past `dismissed_at`" selects exactly the
 * set Mongo's partial filter described, and a notification that was never
 * dismissed has NULL and is never swept.
 *
 * That is not a workaround, it is the more correct rule. Mongo measured its 90
 * days from `createdAt`, so a notification dismissed on day 89 vanished the next
 * day while one dismissed on day 1 survived for 89 more. The retention now
 * measures from the event it is about. A CHECK on `notifications` keeps
 * `dismissed_at` and `status = 'dismissed'` in agreement, so the sweep cannot
 * drift from the condition it replaced.
 *
 * ## Every entry was checked for INTENT, not just replicated
 *
 * A TTL index can be written to mean "mark expired" and quietly destroy history
 * instead. None of these three does:
 *
 *  - `moderation_events` rows are dedupe CLAIMS whose only content is their own
 *    id. Deleting an expired one is the intent exactly — the claim must outlive
 *    every redelivery of its event (30 days, comfortably past CrowdSource's retry
 *    schedule) and nothing afterwards.
 *  - `notifications` past 90 days dismissed are read by nothing.
 *  - `moderation_outboxes` is the one that needs a note, because it is a table
 *    that can still hold UNPROCESSED WORK. `expires_at` is set at insert and
 *    never advanced, so a row that never reaches a terminal state leaves after 14
 *    days whether or not it was ever delivered. That is deliberate — a job stuck
 *    for a fortnight is not going to succeed on day fifteen — but it means a
 *    dispatcher that has been down for two weeks loses its backlog SILENTLY. The
 *    `abuse_reports.local_status` sweep index is what surfaces that: reports
 *    stuck in `queued` are still there and still visible after their outbox rows
 *    are gone.
 *
 * ## Coexistence with reads
 *
 * Mongo's TTL monitor lagged roughly its own check interval; this sweep lags one
 * call. No read path here depends on a swept row already being gone: the outbox
 * claim filters on `status` and `available_at` independently, the dedupe claim is
 * an INSERT that would simply re-win after expiry (correctly — the event is no
 * longer a redelivery by then), and the notification feed filters by status.
 */

import type { ExpirySweepTarget } from '@oxyhq/db/expiry';
import {
  analyticsEvents,
  analyticsExperimentExposures,
  analyticsPseudonymSalts,
  analyticsQueryAggregates,
  analyticsRollups,
  analyticsSearchQueries,
} from './schema/analytics';
import { guestSessions } from './schema/guests';
import {
  guestOrderAccessGrants,
  guestPortalMessages,
  guestRecoveryAttempts,
} from './schema/guestPortal';
import { guestOrderClaimOutbox } from './schema/guestClaims';
import { merchantDemandSnapshots } from './schema/merchantDemand';
import { affiliateOutboundClicks } from './schema/affiliateOutbound.js';
import { catalogSourceRejections } from './schema/ingestion';
import { syncRunRecordFailures } from './schema/connectors';
import {
  feedImportReportEntries,
  feedImportReports,
  feedUploads,
} from './schema/feedImport';
import {
  guestAbuseCounters,
  guestAbuseInterventions,
  guestSecuritySignalCounters,
} from './schema/guestGovernance';
import { moderationEvents, moderationOutboxes } from './schema/moderation';
import { offerPriceSnapshots } from './schema/priceHistory';
import { notifications } from './schema/notifications';
import { paymentOutboxes, paymentProviderEvents } from './schema/payments';
import { referralTouches } from './schema/referrals';
import { referralRiskSignals } from './schema/referralIntegrity';
import { watchlistSnapshots } from './schema/watchlists';
import { searchIntentSessions, searchIntentTurns } from './schema/searchIntent';
import { procurementOutboxes, supplierProviderEvents } from './schema/supplierOrders';

/**
 * `WATCHLIST_SNAPSHOT_RETENTION_SECONDS` — 400 days, matching #78's price-history
 * query span.
 *
 * A basket history is only useful against a seasonal comparison ("what did this
 * build cost me last Black Friday"), so anything under a year answers the one
 * question people actually ask with a gap. 400 rather than 365 so a year-ago
 * comparison still resolves on the day it is made.
 */
const WATCHLIST_SNAPSHOT_RETENTION_SECONDS = 400 * 24 * 60 * 60;

/** `MODERATION_OUTBOX_RETENTION_SECONDS` — 14 days, long enough to investigate. */
const MODERATION_OUTBOX_RETENTION_SECONDS = 14 * 24 * 60 * 60;

/** `MODERATION_EVENT_RETENTION_SECONDS` — 30 days, past every CrowdSource retry. */
const MODERATION_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** The notification retention Mongo's TTL index carried, now measured from dismissal. */
const DISMISSED_NOTIFICATION_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * `PAYMENT_OUTBOX_RETENTION_SECONDS` — 14 days, the moderation outbox's figure
 * for the same reason: a job stuck for a fortnight is not going to succeed on
 * day fifteen, and the payment it belongs to is still there to be reconciled.
 */
const PAYMENT_OUTBOX_RETENTION_SECONDS = 14 * 24 * 60 * 60;

/**
 * `PAYMENT_PROVIDER_EVENT_RETENTION_SECONDS` — 90 days, longer than either
 * moderation retention, because these rows are EVIDENCE rather than claims.
 *
 * 90 days is past every provider's redelivery schedule and past the dispute
 * windows the events describe, which is the interval in which someone might
 * actually need to read one. After it, a re-arriving event is genuinely new and
 * re-processing it is a no-op anyway: the payment status transition is a
 * compare-and-swap that finds nothing to change.
 */
const PAYMENT_PROVIDER_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * `GUEST_SESSION_PURGE_GRACE_SECONDS` — 7 days past expiry or revocation
 * (ADR 0003 D11). The grace is operational headroom for incident forensics,
 * not a soft-delete: after it the row is GONE, and everything downstream is
 * built to survive that (`order_status_history.actor_guest_session_id` is
 * correlation text, and the #104 cart FK will CASCADE so purge correctness is
 * schema, not sweep code).
 */
const GUEST_SESSION_PURGE_GRACE_SECONDS = 7 * 24 * 60 * 60;

/**
 * `REFERRAL_TOUCH_EVIDENCE_MARGIN_SECONDS` — 30 days BEYOND a touch's own
 * attribution-window expiry, not a fixed retention from creation.
 *
 * The touch writer stamps `expires_at = attribution_window_expires_at + this`,
 * and a CHECK on the table holds that ordering, so raw touch evidence always
 * outlives its eligibility (a resolver may still be citing it) and never
 * outlives it by more than the audit margin. This is issue #142's
 * "keep raw high-volume touch data separately retainable from durable
 * attribution and financial records": the durable attribution snapshots its
 * winning evidence, and the raw stream leaves on this clock (ADR 0005 D6).
 */
const REFERRAL_TOUCH_EVIDENCE_MARGIN_SECONDS = 30 * 24 * 60 * 60;

/**
 * `GUEST_RECOVERY_ATTEMPT_RETENTION_SECONDS` — 7 days past a counting window's
 * START (#108 recovery rule 2).
 *
 * These rows are a THROTTLE, not a history: once the longest window has passed,
 * a counter's only remaining property is that somebody once asked about an
 * inbox, which is precisely the correlation this domain refuses to keep
 * anywhere else. Seven days is the longest configured window plus a wide margin
 * for a paused sweep, so the throttle can never be reset by the retention that
 * cleans up after it.
 *
 * The column swept is `window_started_at`, and its retention is expressed HERE
 * rather than as a deadline column because — unlike a grant — the value is a
 * window boundary the counter itself needs to read, so a second deadline column
 * beside it would be arithmetic over a value already present.
 */
const GUEST_RECOVERY_ATTEMPT_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/**
 * `GUEST_PORTAL_MESSAGE_RETENTION_SECONDS` — 14 days from enqueue, the
 * moderation and payment outbox figure for the same reason: a message stuck for
 * a fortnight is not going to send on day fifteen.
 *
 * The consequence is the one `moderation_outboxes` states and is worth
 * repeating here because the record it drops is a person's order confirmation:
 * a dispatcher down for the whole window loses its backlog SILENTLY. What
 * surfaces that is the ORDER — still placed, still paid, still fully readable
 * through the portal, which is exactly why #108 privacy rule 10 requires every
 * critical fact to be in the portal and not only in an email.
 */
const GUEST_PORTAL_MESSAGE_RETENTION_SECONDS = 14 * 24 * 60 * 60;

/**
 * How long a claim's durable follow-up job survives (#109).
 *
 * The same 14 days as the two outboxes above, and the same reasoning applies
 * unchanged — but the record that surfaces a stalled dispatcher is different
 * and worth naming: `guest_order_claims` is retained indefinitely, so a claim
 * whose eligibility grant was never performed is still visible in the operator
 * trace long after the job that owed it has aged out. That asymmetry is why
 * the job may expire at all: nothing about the ownership it recorded goes with
 * it.
 *
 * The CLAIM tables themselves are deliberately NEVER swept — a claim is a
 * commercial-ownership record and a revocation is the audit of a correction
 * somebody made to one, and both must outlive every credential and every
 * session involved in producing them.
 */
const GUEST_CLAIM_OUTBOX_RETENTION_SECONDS = 14 * 24 * 60 * 60;

/**
 * The analytics retention constants (#77 data-lifecycle rules 1, 2 and 7).
 *
 * Every one of these columns already HOLDS its deadline — the writer stamps
 * `expires_at` from the event's own class, so the registry entry below is
 * `retentionSeconds: 0` and the class decides the age, not this list. That is
 * what "retention by event class, never one blanket TTL" means mechanically:
 * the sweep is one rule and the CLASSES are where the policy lives
 * (`services/analytics/retention.ts`).
 *
 * The order below is a policy statement and is worth reading as one. A
 * pseudonym SALT is deleted long before the events derived under it — 45 days
 * against a discovery event's 90 — so for the second half of an event's life
 * its actor dimension is already permanently unlinkable to any session handle.
 * That is deliberate and it is the strongest form data-lifecycle rule 7 can
 * take: rotating an identifier and keeping the key that reproduces it would
 * rotate nothing.
 *
 * This constant is the WRITER's stamping offset and is consumed by
 * `services/analytics/identity.ts`, which sets `expires_at = opened_at + 45d`
 * when it opens an epoch. It must NOT also be the registry's `retentionSeconds`:
 * the sweep deletes where `column <= now() - retentionSeconds`, so naming it in
 * both places applies the window TWICE and retires the salt at 90 days — the
 * exact shape `identity.ts` says it is avoiding, and one that makes the salt
 * live precisely as long as the discovery events derived under it. Measured,
 * not assumed; `expirySweeper.realdb.test.ts` seeds a salt one hour past its
 * stamped deadline and fails if it survives the tick.
 */
const ANALYTICS_SALT_RETENTION_SECONDS = 45 * 24 * 60 * 60;

/**
 * `CATALOG_SOURCE_REJECTION_RETENTION_SECONDS` — 30 days past the deadline the
 * writer stamps, which it sets to the rejection's own moment.
 *
 * #62's rejection residual is the ONE table in the ingestion domain bounded by
 * TRAFFIC rather than by the catalogue: a provider that starts returning
 * malformed rows writes one row per record per run, forever. Every other table
 * there is one row per source or one per external object and must NEVER be
 * swept — the objects and their runs are the audit history issue acceptance 6
 * protects.
 *
 * Thirty days is chosen against what the rows are FOR: telling schema drift
 * from a bad page needs the last few runs of a source, not last quarter's. The
 * counters that survive them live on `catalog_source_runs`, which is bounded by
 * the number of passes and is not swept, so deleting the detail never deletes
 * the fact that records were rejected.
 */
const CATALOG_SOURCE_REJECTION_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * `SYNC_RUN_RECORD_FAILURE_RETENTION_SECONDS` — 30 days, and the figure is the
 * one above for the same reason rather than by coincidence (#303).
 *
 * `sync_run_record_failures` is the connector domain's residual, and it is the
 * ONE table in `connectors.ts` bounded by TRAFFIC: a platform publishing a field
 * Mercaria refuses writes one row per product per run, forever. `connections` is
 * bounded by a merchant's channels and `sync_runs` by their cadence, and both
 * are the activity log the dashboard reads — neither may ever be swept.
 *
 * Thirty days is chosen against what a merchant DOES with these rows. They come
 * looking when a product stops appearing on their storefront, which is days to
 * weeks, and what they need is the last few runs of that channel rather than
 * last quarter's. Longer would not answer a different question; it would keep a
 * catalogue's worth of refusals per broken feed.
 *
 * Deleting the detail never deletes the SIGNAL: `counts_failed` and the summary
 * in `sync_runs.error` are on the run row, which nothing here sweeps, so an
 * expired page still shows that records were refused and roughly why.
 */
const SYNC_RUN_RECORD_FAILURE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * `GUEST_SECURITY_EVIDENCE_RETENTION_SECONDS` — 90 days past a counting
 * window's START, for the abuse counters, the interventions they produced and
 * the security signal counts (#111 retention class `security_audit_event`).
 *
 * `guest_recovery_attempts` is the precedent and this is deliberately LONGER
 * than its seven days, for a reason worth stating because the two look like the
 * same table. That one is purely a THROTTLE: after its longest window it counts
 * nothing, and its only remaining property is that somebody once asked about an
 * inbox — which is exactly the correlation the portal domain refuses to keep.
 * These are also EVIDENCE. "Was this happening in March" is a question an
 * incident review asks in June, and an intervention somebody is contesting as a
 * false positive has to still be there when they contest it.
 *
 * Ninety days is bounded on the other side by the same reasoning: none of these
 * rows is worth keeping for a year, and the aggregate a dashboard reads is
 * written by the rollup long before the counters expire.
 */
const GUEST_SECURITY_EVIDENCE_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * A staged upload artefact (#63). Seven days, which is a deliberately SHORT
 * deadline: the bytes live on one ECS task's own disk, so the row outliving the
 * file it names is the normal case rather than the exception, and a
 * three-month-old upload row whose artefact went with the task that received it
 * is a `missing` refusal waiting to confuse somebody.
 */
const FEED_UPLOAD_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/**
 * A feed import, validation or preview report (#63), 90 days later.
 *
 * The report is the evidence an ACTIVE mapping version cites
 * (`feed_configuration_versions.validated_report_id`), which is why the foreign
 * key is RESTRICT and why the deadline is generous: an activation nobody can
 * read the justification for is an activation nobody can review. It is still
 * bounded, because these are written per pass and a daily feed writes 365 a
 * year.
 */
const FEED_IMPORT_REPORT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * One record's refusal inside a report (#63), 30 days later — deliberately
 * SHORTER than the report that summarizes it.
 *
 * The COUNTS are what an operator reads months later; the per-record detail is
 * what a merchant downloads this week to fix their file. This table is the only
 * one in the domain bounded by TRAFFIC rather than by the catalogue: a feed that
 * starts returning malformed rows writes one row per record per pass, forever,
 * and a report whose entries have been swept still reports how many there were.
 */
const FEED_IMPORT_REPORT_ENTRY_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * Every table with an expiring column, and nothing else.
 *
 * `retentionSeconds: 0` where the column already holds the deadline — the column
 * IS the deadline, so zero is the whole rule, not a missing value.
 *
 * Each column has a supporting leading btree index; `findUnsupportedExpiryColumns`
 * from `@oxyhq/db/assert` checks that against the real catalogue once the
 * Postgres test harness is wired in, because a convention ("index the column you
 * register") does not notice a migration dropping the index later.
 */
export const EXPIRY_TARGETS: readonly ExpirySweepTarget[] = [
  {
    table: moderationOutboxes,
    column: moderationOutboxes.expiresAt,
    retentionSeconds: 0,
    reason:
      'A delivered or dead-lettered moderation job, 14 days after it was enqueued. ' +
      'Deleting one that is still PENDING loses that work silently — the report it ' +
      'owes stays visible in abuse_reports.local_status, which is where a stalled ' +
      'dispatcher must be noticed.',
  },
  {
    table: moderationEvents,
    column: moderationEvents.expiresAt,
    retentionSeconds: 0,
    reason:
      'A webhook dedupe claim, 30 days after it was made. Its only content is its ' +
      'own id; after 30 days CrowdSource has stopped retrying, so a re-arriving ' +
      'event is genuinely new rather than a redelivery.',
  },
  {
    table: paymentOutboxes,
    column: paymentOutboxes.expiresAt,
    retentionSeconds: 0,
    reason:
      'A delivered or dead-lettered payment domain event, 14 days after it was enqueued. ' +
      'Deleting one that is still PENDING loses that work silently, exactly as it would ' +
      'for moderation — the payment it belongs to stays visible in `payments.status`, ' +
      'which is where a stalled dispatcher must be noticed.',
  },
  {
    table: paymentProviderEvents,
    column: paymentProviderEvents.expiresAt,
    retentionSeconds: 0,
    reason:
      'An inbound provider event, 90 days after receipt — past every redelivery schedule ' +
      'and past the dispute windows these events describe. The payment, its attempts and ' +
      'its ledger entries are permanent; this is the raw envelope they were derived from.',
  },
  {
    table: referralTouches,
    column: referralTouches.expiresAt,
    retentionSeconds: 0,
    reason:
      'Raw referral touch evidence, 30 days past its own attribution-window expiry. The ' +
      'attribution a touch may have won has already snapshotted the winning evidence into ' +
      'its own columns and carries winning_touch_id without a foreign key, so this sweep ' +
      'erases the evidence trail’s live end and never an earned attribution (ADR 0005 D6).',
  },
  {
    table: referralRiskSignals,
    column: referralRiskSignals.expiresAt,
    retentionSeconds: 0,
    reason:
      'A referral risk signal is an OBSERVATION about behaviour, not a financial record, ' +
      'and `REFERRAL_RETENTION_POLICY.risk_signal` keeps it 400 days — a full year plus a ' +
      'review cycle — before deleting it. The `expires_at` column carries that deadline, ' +
      'stamped by the evaluator from the same policy table, so the margin is zero here. ' +
      'The enforcement ACTION a signal informed survives it and stays explicable: the ' +
      'action snapshots its own reason, and #148 draws that division deliberately, so a ' +
      'decision outlives its working papers rather than becoming unreadable with them.',
  },
  {
    table: notifications,
    column: notifications.dismissedAt,
    retentionSeconds: DISMISSED_NOTIFICATION_RETENTION_SECONDS,
    reason:
      'A notification the user dismissed, 90 days later. Never-dismissed rows have ' +
      'a NULL dismissed_at and are never swept — that NULL is how the retention is ' +
      'made conditional, since this registry has no way to express a filter.',
  },
  // `guest_sessions` appears TWICE, one entry per purge trigger, because a
  // session leaves for either of two independent reasons and this registry has
  // no way to express OR. The pair cannot double-delete: a row matched by both
  // predicates is deleted by whichever target runs first and the other finds
  // nothing — the sweep is idempotent per row.
  {
    table: guestSessions,
    column: guestSessions.expiresAt,
    retentionSeconds: GUEST_SESSION_PURGE_GRACE_SECONDS,
    reason:
      'A guest session 7 days past its ABSOLUTE expiry (ADR 0003 D11). Hard delete: ' +
      'authorization ended at expires_at (the resolver refuses it from that moment), ' +
      'and the audit trail lives in other tables as correlation text, never here.',
  },
  {
    table: guestSessions,
    column: guestSessions.revokedAt,
    retentionSeconds: GUEST_SESSION_PURGE_GRACE_SECONDS,
    reason:
      'A revoked (including converted — conversion revokes, D3) guest session 7 days ' +
      'later. Revoked rows retain only the audit timestamps until purge; the ' +
      'conversion stamp a claim needs long-term lives on the ORDER side, not here.',
  },
  // The guest order portal (#108). Three entries; two of its five tables are
  // deliberately NEVER swept. `guest_contact_suppressions` holds a person's
  // request to stop receiving mail, which does not expire because they waited;
  // `guest_portal_operator_actions` is an append-only audit of what staff did
  // on a buyer's behalf, and an audit with a retention shorter than the record
  // it is about answers the only question it exists for with silence.
  {
    table: guestOrderAccessGrants,
    column: guestOrderAccessGrants.purgeAt,
    retentionSeconds: 0,
    reason:
      'A portal or exchange credential at the deadline its own PURPOSE stamped (ADR 0003 D11 ' +
      '— exchange 24 h past expiry, portal 90 days). Authorization ended at expires_at, which ' +
      'the resolver enforces independently, so this delete removes an audit record and never ' +
      'a live credential. The grant row IS that audit: nothing else records who could reach ' +
      'which checkout group.',
  },
  {
    table: guestPortalMessages,
    column: guestPortalMessages.expiresAt,
    retentionSeconds: 0,
    reason:
      'A sent, suppressed or dead-lettered transactional message, 14 days after it was ' +
      'enqueued. Deleting one still PENDING loses that send silently, exactly as it would for ' +
      'moderation — the order it is about stays placed, paid and readable in the portal, ' +
      'which is where a stalled dispatcher must be noticed.',
  },
  // Guest order CLAIMING (#109). ONE entry, and the two claim tables it leaves
  // out are the point: `guest_order_claims` records who owns a purchase and
  // `guest_order_claim_revocations` records an operator correcting that, and a
  // retention shorter than the orders themselves would answer "who claimed
  // this, and did anyone detach it" with silence — the same reasoning that
  // keeps `guest_portal_operator_actions` unswept.
  {
    table: guestOrderClaimOutbox,
    column: guestOrderClaimOutbox.expiresAt,
    retentionSeconds: 0,
    reason:
      'A completed, failed or dead-lettered claim follow-up job, 14 days after the claim was ' +
      'made. Deleting one still PENDING loses that work silently — exactly as it would for ' +
      'moderation — and what surfaces it is the CLAIM, which is retained indefinitely and ' +
      'still shows in the operator trace with no eligibility grant beside it.',
  },
  {
    table: guestRecoveryAttempts,
    column: guestRecoveryAttempts.windowStartedAt,
    retentionSeconds: GUEST_RECOVERY_ATTEMPT_RETENTION_SECONDS,
    reason:
      'A recovery throttle counter, 7 days past its window start. After the window it counts ' +
      'nothing and is only a record that somebody asked about an inbox — the correlation this ' +
      'domain refuses to keep. The retention is far longer than any window, so cleanup can ' +
      'never reset a live throttle.',
  },
  // The analytics domain (#77). Six entries, because six tables carry their own
  // deadline and this registry has no way to express "everything in a schema".
  // `analytics_search_queries` appears ONCE here and has a SECOND deadline the
  // registry cannot serve — `text_expires_at` nulls the redacted text while the
  // row survives, which is a redaction and not a delete, so it is the retention
  // sweep in `services/analytics/retention.ts` that performs it.
  {
    table: analyticsEvents,
    column: analyticsEvents.expiresAt,
    retentionSeconds: 0,
    reason:
      'A discovery or funnel event, at the deadline its own event CLASS stamped (#77 ' +
      'data-lifecycle rule 1). Deleting one costs no report: the rollup that reads it runs ' +
      'first and writes `analytics_rollups`, so the numbers outlive the rows they came from ' +
      '(rule 2). Financial truth was never in here — it is in payments, orders and refunds.',
  },
  {
    table: analyticsSearchQueries,
    column: analyticsSearchQueries.expiresAt,
    retentionSeconds: 0,
    reason:
      'A search record, after its own deadline. The redacted TEXT is already gone by then — ' +
      '`text_expires_at` nulls it 30 days in — so this sweep removes the tokens and counts, ' +
      'which `analytics_query_aggregates` has aggregated ahead of it (privacy rules 1 and 6).',
  },
  {
    table: analyticsQueryAggregates,
    column: analyticsQueryAggregates.expiresAt,
    retentionSeconds: 0,
    reason:
      'A thresholded query aggregate. It outlives the raw rows it summarizes and still ' +
      'expires: "preserve aggregate metrics" (rule 9) is not "keep them forever", and an ' +
      'aggregate below the reporting floor was never readable in the first place.',
  },
  {
    table: analyticsRollups,
    column: analyticsRollups.expiresAt,
    retentionSeconds: 0,
    reason:
      'A metric bucket. The longest analytics retention there is, because these are the ' +
      'numbers every dashboard reads and they contain no actor dimension finer than a market, ' +
      'a surface and an actor KIND — nothing about any person survives in one.',
  },
  {
    table: analyticsExperimentExposures,
    column: analyticsExperimentExposures.expiresAt,
    retentionSeconds: 0,
    reason:
      'An experiment exposure. Outlives discovery events so a finished test stays analysable, ' +
      'and no longer — the unit reference is a rotating pseudonym or an Oxy id, and keeping ' +
      'either past the analysis is keeping an identifier for no stated purpose.',
  },
  {
    table: analyticsPseudonymSalts,
    column: analyticsPseudonymSalts.expiresAt,
    // ZERO, like every other analytics target: `identity.ts` already stamped
    // `expires_at = opened_at + 45d` from `RETENTION_SECONDS.analyticsSalt`.
    // Naming the same window here too applied it twice and retired the salt at
    // 90 days, which is exactly as long as a discovery event lives — so the
    // guarantee below was false for the largest event class, and
    // `countOverdueSalts` (which reads the stamped deadline) reported every
    // epoch overdue for 45 days, permanently, turning the one health counter
    // that can see this failure into noise somebody mutes.
    retentionSeconds: 0,
    reason:
      'A retired pseudonym salt, 45 days after the epoch was created — deliberately SHORTER ' +
      'than the events derived under it live. This delete is what makes rotation real: after ' +
      'it, no one including Mercaria can recompute an old epoch’s pseudonym from a session ' +
      'handle, so two epochs cannot be joined even in principle (#77 data-lifecycle rule 7).',
  },
  {
    table: catalogSourceRejections,
    column: catalogSourceRejections.expiresAt,
    retentionSeconds: 0,
    reason:
      'One record an ingestion run refused, 30 days later (#62). The deadline is stamped at ' +
      'write time so this registry needs no filter. It is the only #62 table with a ' +
      'retention: configs, policies, objects and runs are bounded by the catalogue and are ' +
      'the audit history a rights suspension must not delete.',
  },
  {
    table: syncRunRecordFailures,
    column: syncRunRecordFailures.expiresAt,
    retentionSeconds: 0,
    reason:
      'One record a CONNECTOR sync run refused, 30 days later (#303). The deadline is stamped ' +
      'at write time so this registry needs no filter. It is the only `connectors.ts` table ' +
      'with a retention, because it is the only one bounded by traffic rather than by a ' +
      'merchant’s channels: `connections` and `sync_runs` are the activity log the dashboard ' +
      'reads and must never be swept. Expiring these rows costs the per-record detail and ' +
      'never the signal — the tally and the summary stay on the run.',
  },
  // The supplier order orchestration (#124). TWO entries, and the two omissions
  // beside them are the point: `supplier_order_attempts`,
  // `purchase_order_line_outcomes`, `purchase_order_tracking_events`,
  // `purchase_order_documents` and `procurement_exceptions` carry NO deadline,
  // because they are the evidence that a supplier order was placed, what it
  // cost and what happened to it — the record #128 reconciles an invoice
  // against and the one an operator reads during a chargeback. They are bounded
  // by the number of purchase orders, not by traffic.
  {
    table: procurementOutboxes,
    column: procurementOutboxes.expiresAt,
    retentionSeconds: 0,
    reason:
      'A delivered or dead-lettered procurement job, 14 days after it was enqueued — the ' +
      'payment outbox’s figure and reasoning. Deleting a PENDING one would lose a supplier ' +
      'order a customer has already paid for; that cannot happen silently, because the ' +
      'purchase order it owes stays visible in `purchase_orders.status = draft`, which is ' +
      'where a stalled dispatcher must be noticed.',
  },
  {
    table: supplierProviderEvents,
    column: supplierProviderEvents.expiresAt,
    retentionSeconds: 0,
    reason:
      'An inbound supplier event, 90 days after receipt — the payment provider event’s ' +
      'figure, chosen against the same question: how long might someone need to read the ' +
      'raw envelope. What it was interpreted INTO is permanent (the purchase order, its ' +
      'append-only transitions, its line outcomes and its tracking trail), so this sweep ' +
      'removes the envelope and never the fact.',
  },
  {
    table: feedUploads,
    column: feedUploads.expiresAt,
    retentionSeconds: 0,
    reason:
      'A staged feed upload (#63), seven days after it was received. The bytes it names live ' +
      'on one task\'s disk and do not survive a deployment, so a long-lived row here would ' +
      'only ever be a `missing` refusal with a plausible-looking date on it.',
  },
  {
    table: feedImportReports,
    column: feedImportReports.expiresAt,
    retentionSeconds: 0,
    reason:
      'One preview, validation or import pass over a feed (#63), 90 days later. Generous ' +
      'because an ACTIVE mapping version cites its validating report by foreign key, and an ' +
      'activation nobody can read the justification for is an activation nobody can review.',
  },
  {
    table: feedImportReportEntries,
    column: feedImportReportEntries.expiresAt,
    retentionSeconds: 0,
    reason:
      'One record a feed pass refused (#63), 30 days later — SHORTER than the report that ' +
      'counts it, because the counts are what is read months later and the per-record detail ' +
      'is what a merchant downloads this week. The only #63 table bounded by traffic.',
  },
  // Price history (#78). ONE entry, and the three omissions beside it are the
  // decision: `offer_price_series`, `offer_price_points` and
  // `offer_price_write_metrics` carry no deadline of their own. Points are
  // removed by CASCADE when the observation they cite is, which is what keeps
  // "every point traces to an immutable observation" true at every instant
  // rather than true until a sweep; a series is one row per question anybody
  // asked and is bounded by the catalogue; and the metrics are the counters
  // that make a broken dedup visible, which is exactly the thing that must not
  // quietly age out.
  // Guest-commerce governance (#111). THREE entries, and the six omissions
  // beside them are the decision. `guest_retention_policy_versions` is the
  // policy itself — a retention that deleted the record of what the retention
  // WAS would answer the only question an auditor asks with silence.
  // `guest_retention_runs` is the auditable count of what each pass did
  // (retention rule 6), `guest_legal_holds` is why a deletion did NOT happen,
  // `guest_data_requests` and `guest_data_class_dispositions` are the audit of
  // an erasure — all four must outlive the data they are about, or the erasure
  // and the failure to perform one become indistinguishable. The two rollout
  // tables are a decision history that is bounded by the number of stages.
  {
    table: guestAbuseCounters,
    column: guestAbuseCounters.windowStartedAt,
    retentionSeconds: GUEST_SECURITY_EVIDENCE_RETENTION_SECONDS,
    reason:
      'One abuse counter, 90 days past its window start. Bounded by TRAFFIC rather than by ' +
      'purchases — the only table in this domain that is — so it is the one that grows forever ' +
      'without an entry here. Deleting it can never reset a live throttle: the longest ' +
      'configured window is 24 hours.',
  },
  {
    table: guestAbuseInterventions,
    column: guestAbuseInterventions.expiresAt,
    retentionSeconds: GUEST_SECURITY_EVIDENCE_RETENTION_SECONDS,
    reason:
      'One applied friction, 90 days after it stopped applying. Swept on expires_at rather than ' +
      'created_at so the clock runs from the end of the intervention: a 24-hour manual review ' +
      'raised on day one is retained for 90 days from the day it lapsed, not from the day it ' +
      'fired. The false-positive RATE it feeds is a rollup, written long before this.',
  },
  {
    table: guestSecuritySignalCounters,
    column: guestSecuritySignalCounters.windowStartedAt,
    retentionSeconds: GUEST_SECURITY_EVIDENCE_RETENTION_SECONDS,
    reason:
      'One security signal count, 90 days past its window. It names nobody — there is no ' +
      'subject column on this table at all — so what expires is a number, and what an alert ' +
      'needed it for happened at the time.',
  },
  {
    table: offerPriceSnapshots,
    column: offerPriceSnapshots.retentionExpiresAt,
    retentionSeconds: 0,
    reason:
      'One price observation, at the deadline its SOURCE’s own rights policy set (#78 ' +
      'snapshot policy 8). The column is NULL for a source with no contractual cache cap, ' +
      'which is the ordinary case, and the sweep never touches a NULL — the ' +
      '`notifications.dismissed_at` shape. Stamped at write time, so a later policy change ' +
      'cannot retroactively shorten what was lawfully kept and cannot lengthen it either.',
  },
  // Private watchlists (#81). ONE entry, and the three omissions are the
  // decision: `watchlists` and `watchlist_items` are a person's own data and are
  // removed when they remove them, and `watchlist_snapshot_items` CASCADE from
  // the snapshot they belong to — so the sweep never has to know they exist and
  // a line can never outlive the evaluation it describes.
  {
    table: watchlistSnapshots,
    column: watchlistSnapshots.retentionExpiresAt,
    retentionSeconds: 0,
    reason:
      'One recorded evaluation of one private list (#81 snapshot policy). The column IS the ' +
      'deadline, stamped at write time from `WATCHLIST_SNAPSHOT_RETENTION_SECONDS`, so a later ' +
      'change to that window cannot retroactively shorten history somebody was shown. It is ' +
      'the only table in the domain whose size is a function of how often a buyer opens a ' +
      'list, which is why it is the only one with a deadline — and why the write DEDUPLICATES ' +
      'an unchanged evaluation rather than relying on the sweep to clean up after it.',
  },
  // #95's two query-side tables. Both carry a deadline the WRITER stamps, and
  // neither has an append-only trigger — a trigger refusing DELETE would make
  // the retention this domain most needs fail silently, which is
  // `analytics_events`' own reasoning and applies with more force here: a turn
  // holds a redacted shopping query, so the sweep is the erasure.
  {
    table: searchIntentSessions,
    column: searchIntentSessions.expiresAt,
    retentionSeconds: 0,
    reason:
      'One shopper’s bounded clarification conversation (#95). The column IS the deadline, ' +
      'stamped at creation from `SEARCH_INTENT_SESSION_TTL_SECONDS`. A session outliving ' +
      'the shopping trip it belongs to is a clarification history nobody is using and ' +
      'everybody would rather not keep.',
  },
  {
    table: searchIntentTurns,
    column: searchIntentTurns.expiresAt,
    retentionSeconds: 0,
    reason:
      'One recorded interpretation (#95), holding #77’s REDACTED query form and the mode ' +
      'and reason a fallback rate is computed from. Its deadline is #77’s own ' +
      '`ANALYTICS_QUERY_TEXT_RETENTION_DAYS`, stamped at write time, so the redacted text ' +
      'here and the redacted text in `analytics_search_queries` leave on the same clock ' +
      'rather than one outliving the other under a policy nobody wrote down.',
  },
  // Merchant demand snapshots (#86). ONE entry, and the two child tables have
  // none: `merchant_demand_metrics` and `merchant_demand_products` CASCADE from
  // the snapshot, so a swept report leaves no metric row pointing at a report
  // that is gone. The four `merchant_acquisition_*` tables deliberately carry no
  // `expires_at` at all — an outreach log and an operator audit are the record
  // of what people decided, and a retention clock on them destroys the evidence
  // they exist to keep.
  {
    table: merchantDemandSnapshots,
    column: merchantDemandSnapshots.expiresAt,
    retentionSeconds: 0,
    reason:
      'A merchant demand report, at the deadline its writer stamped from ' +
      '`MERCHANT_DEMAND_SNAPSHOT_RETENTION_DAYS`. It holds aggregate counts and product ids ' +
      'and no actor dimension of any kind, so nothing about a person survives in one — the ' +
      'retention exists because a superseded report accumulates, not because it is sensitive. ' +
      'DELETE is deliberately PERMITTED on all three tables (the `analytics_events` posture): ' +
      'erasure on a schedule is the policy, and a trigger refusing it would make this sweep ' +
      'fail silently on every row it was supposed to remove.',
  },
  // ── Affiliate outbound clicks (#67) ───────────────────────────────────────
  {
    table: affiliateOutboundClicks,
    column: affiliateOutboundClicks.retentionExpiresAt,
    retentionSeconds: 0,
    reason:
      'One outbound click, at the deadline its writer stamped from ' +
      '`AFFILIATE_CLICK_RETENTION_DAYS`. The column IS the deadline, so the retention is 0 ' +
      'here — the conditional form this sweep cannot express does not arise, because the ' +
      'condition was resolved at write time. A click carries no actor of any kind (no Oxy id, ' +
      'no session, no pseudonym, no IP, no user agent), so what accumulates is commercial ' +
      'telemetry rather than anything about a person; the retention is long (400 days by ' +
      'default) precisely because it must outlive every network correction window, and it is ' +
      'still SHORTER than the commission records it supports, which are accounting. UPDATE is ' +
      'refused by trigger and DELETE is deliberately PERMITTED (the `analytics_events` ' +
      'posture): erasure on a schedule is the policy, and a trigger refusing it would make ' +
      'this sweep fail silently on every row it was obliged to remove.',
  },
];

/** Every retention, exported so the writers that stamp `expires_at` agree with the sweep. */
export const RETENTION_SECONDS = {
  moderationOutbox: MODERATION_OUTBOX_RETENTION_SECONDS,
  moderationEvent: MODERATION_EVENT_RETENTION_SECONDS,
  dismissedNotification: DISMISSED_NOTIFICATION_RETENTION_SECONDS,
  paymentOutbox: PAYMENT_OUTBOX_RETENTION_SECONDS,
  paymentProviderEvent: PAYMENT_PROVIDER_EVENT_RETENTION_SECONDS,
  guestSessionPurgeGrace: GUEST_SESSION_PURGE_GRACE_SECONDS,
  referralTouchEvidenceMargin: REFERRAL_TOUCH_EVIDENCE_MARGIN_SECONDS,
  analyticsSalt: ANALYTICS_SALT_RETENTION_SECONDS,
  catalogSourceRejection: CATALOG_SOURCE_REJECTION_RETENTION_SECONDS,
  syncRunRecordFailure: SYNC_RUN_RECORD_FAILURE_RETENTION_SECONDS,
  guestRecoveryAttempt: GUEST_RECOVERY_ATTEMPT_RETENTION_SECONDS,
  guestPortalMessage: GUEST_PORTAL_MESSAGE_RETENTION_SECONDS,
  guestClaimOutbox: GUEST_CLAIM_OUTBOX_RETENTION_SECONDS,
  feedUpload: FEED_UPLOAD_RETENTION_SECONDS,
  feedImportReport: FEED_IMPORT_REPORT_RETENTION_SECONDS,
  feedImportReportEntry: FEED_IMPORT_REPORT_ENTRY_RETENTION_SECONDS,
  watchlistSnapshot: WATCHLIST_SNAPSHOT_RETENTION_SECONDS,
  guestSecurityEvidence: GUEST_SECURITY_EVIDENCE_RETENTION_SECONDS,
} as const;
