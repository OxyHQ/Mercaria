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
import { catalogSourceRejections } from './schema/ingestion';
import { moderationEvents, moderationOutboxes } from './schema/moderation';
import { notifications } from './schema/notifications';
import { paymentOutboxes, paymentProviderEvents } from './schema/payments';
import { referralTouches } from './schema/referrals';

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
    retentionSeconds: ANALYTICS_SALT_RETENTION_SECONDS,
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
} as const;
