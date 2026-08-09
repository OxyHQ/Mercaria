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
import { guestSessions } from './schema/guests';
import { moderationEvents, moderationOutboxes } from './schema/moderation';
import { notifications } from './schema/notifications';
import { paymentOutboxes, paymentProviderEvents } from './schema/payments';

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
];

/** Every retention, exported so the writers that stamp `expires_at` agree with the sweep. */
export const RETENTION_SECONDS = {
  moderationOutbox: MODERATION_OUTBOX_RETENTION_SECONDS,
  moderationEvent: MODERATION_EVENT_RETENTION_SECONDS,
  dismissedNotification: DISMISSED_NOTIFICATION_RETENTION_SECONDS,
  paymentOutbox: PAYMENT_OUTBOX_RETENTION_SECONDS,
  paymentProviderEvent: PAYMENT_PROVIDER_EVENT_RETENTION_SECONDS,
  guestSessionPurgeGrace: GUEST_SESSION_PURGE_GRACE_SECONDS,
} as const;
