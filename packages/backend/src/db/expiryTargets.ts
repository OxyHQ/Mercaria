/**
 * Expiry Sweep Registry — the replacement for Mercaria's Mongo TTL indexes.
 *
 * Postgres has no TTL index. Mongo reaped; Postgres does not. A table ported
 * without an entry here grows FOREVER — no error, no failing test, no symptom of
 * any kind until disk — and it is structurally invisible in review, because the
 * thing doing the work was never in this codebase to be seen going missing.
 *
 * Mercaria's Mongoose models declare exactly THREE `expireAfterSeconds` indexes,
 * and all three are represented below. `@oxyhq/db`'s `sweepAllExpiredRows` takes
 * this list; scheduling it belongs with the job runner in Fase 2, alongside the
 * outbox dispatcher it runs next to.
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
import { moderationEvents, moderationOutboxes } from './schema/moderation';
import { notifications } from './schema/notifications';

/** `MODERATION_OUTBOX_RETENTION_SECONDS` — 14 days, long enough to investigate. */
const MODERATION_OUTBOX_RETENTION_SECONDS = 14 * 24 * 60 * 60;

/** `MODERATION_EVENT_RETENTION_SECONDS` — 30 days, past every CrowdSource retry. */
const MODERATION_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** The notification retention Mongo's TTL index carried, now measured from dismissal. */
const DISMISSED_NOTIFICATION_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * Every table that carried a Mongo TTL index, and nothing else.
 *
 * `retentionSeconds: 0` where the column already holds the deadline — that is
 * the direct translation of `expireAfterSeconds: 0`, not a missing value.
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
    table: notifications,
    column: notifications.dismissedAt,
    retentionSeconds: DISMISSED_NOTIFICATION_RETENTION_SECONDS,
    reason:
      'A notification the user dismissed, 90 days later. Never-dismissed rows have ' +
      'a NULL dismissed_at and are never swept — that NULL is what replaces Mongo’s ' +
      'partialFilterExpression, which this registry has no way to express.',
  },
];

/** Both moderation retentions, exported so the writers that stamp `expires_at` agree with the sweep. */
export const RETENTION_SECONDS = {
  moderationOutbox: MODERATION_OUTBOX_RETENTION_SECONDS,
  moderationEvent: MODERATION_EVENT_RETENTION_SECONDS,
  dismissedNotification: DISMISSED_NOTIFICATION_RETENTION_SECONDS,
} as const;
