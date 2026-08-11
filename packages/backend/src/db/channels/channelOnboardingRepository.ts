/**
 * `channel_onboarding_sessions` — the resumable wizard state (#87 wizard 12).
 *
 * ## Opening a session converges rather than creating
 *
 * `openSession` is `ON CONFLICT DO NOTHING` on the partial unique that permits
 * ONE `in_progress` session per store per channel type, followed by a read. A
 * merchant who opens the wizard in two tabs, or whose client retries a request
 * whose response was lost, gets the session they already have — which is #87
 * acceptance 2 ("previewing or retrying a connection creates no duplicate
 * channel") held at the first step rather than defended at the last.
 *
 * A read-then-insert would satisfy the words and lose both cases that actually
 * happen: two tabs, and a retry after a timeout the client never saw.
 *
 * ## The partial unique's predicate must be repeated
 *
 * `channel_onboarding_sessions_live_key` is `WHERE state = 'in_progress'`, and
 * Postgres refuses to infer a partial index as an `ON CONFLICT` arbiter unless
 * the statement repeats its predicate. Omitting it does not fall back to
 * something looser — the insert fails outright, which is how `ensureCart` (#104)
 * learned the same lesson.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  ChannelActivationBlocker,
  ChannelOnboardingStep,
  ChannelPreviewCounts,
  ChannelTypeId,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { channelOnboardingSessions } from '../schema/channels.js';

/** One row of `channel_onboarding_sessions`. */
export type ChannelOnboardingSessionRow = InferSelectModel<typeof channelOnboardingSessions>;

/** What `openSession` needs. Deliberately no credential of any kind. */
export interface OpenChannelOnboardingSessionInput {
  storeId: string;
  channelType: ChannelTypeId;
  startedByOxyUserId: string;
}

/**
 * What a step may change.
 *
 * Every field is optional and `undefined` means "leave alone", so a step that
 * knows one fact does not have to restate the rest — and cannot blank a fact an
 * earlier step established by omitting it.
 */
export interface PatchChannelOnboardingSessionInput {
  step?: ChannelOnboardingStep;
  connectionId?: string;
  feedConfigurationId?: string;
  merchantId?: string;
  storefrontId?: string;
  preview?: ChannelPreviewCounts;
  previewedAt?: Date;
  activationBlockers?: readonly ChannelActivationBlocker[];
}

/**
 * Open a session, or return the live one this store already has for this
 * channel type.
 */
export async function openChannelOnboardingSession(
  input: OpenChannelOnboardingSessionInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<ChannelOnboardingSessionRow> {
  await db
    .insert(channelOnboardingSessions)
    .values({
      storeId: input.storeId,
      channelType: input.channelType,
      startedByOxyUserId: input.startedByOxyUserId,
    })
    .onConflictDoNothing({
      target: [channelOnboardingSessions.storeId, channelOnboardingSessions.channelType],
      where: sql`${channelOnboardingSessions.state} = 'in_progress'`,
    });

  const [row] = await db
    .select()
    .from(channelOnboardingSessions)
    .where(
      and(
        eq(channelOnboardingSessions.storeId, input.storeId),
        eq(channelOnboardingSessions.channelType, input.channelType),
        eq(channelOnboardingSessions.state, 'in_progress'),
      ),
    )
    .limit(1);

  if (!row) {
    // Unreachable: the insert either wrote the row or found one already there,
    // and nothing between the two statements can end a session but this store's
    // own request. Reported rather than returned as a null the caller would have
    // to invent a meaning for.
    throw new Error('Channel onboarding session vanished between insert and read');
  }
  return row;
}

/** This store's session by id, or `null` — including for another store's id. */
export async function findChannelOnboardingSession(
  storeId: string,
  sessionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ChannelOnboardingSessionRow | null> {
  const [row] = await db
    .select()
    .from(channelOnboardingSessions)
    .where(
      and(
        eq(channelOnboardingSessions.id, sessionId),
        eq(channelOnboardingSessions.storeId, storeId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** This store's sessions, newest first. */
export async function listChannelOnboardingSessions(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ChannelOnboardingSessionRow[]> {
  return await db
    .select()
    .from(channelOnboardingSessions)
    .where(eq(channelOnboardingSessions.storeId, storeId))
    .orderBy(desc(channelOnboardingSessions.createdAt));
}

/**
 * Advance a LIVE session.
 *
 * The `state = 'in_progress'` predicate is what makes an activated session
 * immutable: a stale tab pressing "save" after somebody activated on another
 * device matches nothing and gets `null`, rather than rewriting the record of
 * what was activated.
 */
export async function patchChannelOnboardingSession(
  storeId: string,
  sessionId: string,
  patch: PatchChannelOnboardingSessionInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<ChannelOnboardingSessionRow | null> {
  const values: Partial<typeof channelOnboardingSessions.$inferInsert> = {};
  if (patch.step !== undefined) values.step = patch.step;
  if (patch.connectionId !== undefined) values.connectionId = patch.connectionId;
  if (patch.feedConfigurationId !== undefined) {
    values.feedConfigurationId = patch.feedConfigurationId;
  }
  if (patch.merchantId !== undefined) values.merchantId = patch.merchantId;
  if (patch.storefrontId !== undefined) values.storefrontId = patch.storefrontId;
  if (patch.activationBlockers !== undefined) {
    values.activationBlockers = [...patch.activationBlockers];
  }
  if (patch.preview !== undefined) {
    values.previewScanned = patch.preview.scanned;
    values.previewMatched = patch.preview.matched;
    values.previewCreated = patch.preview.created;
    values.previewReview = patch.preview.review;
    values.previewInvalid = patch.preview.invalid;
    values.previewDuplicate = patch.preview.duplicate;
    values.previewedAt = patch.previewedAt ?? new Date();
  }
  if (Object.keys(values).length === 0) {
    return await findChannelOnboardingSession(storeId, sessionId, db);
  }

  const [row] = await db
    .update(channelOnboardingSessions)
    .set(values)
    .where(
      and(
        eq(channelOnboardingSessions.id, sessionId),
        eq(channelOnboardingSessions.storeId, storeId),
        eq(channelOnboardingSessions.state, 'in_progress'),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Close a session, one way or the other.
 *
 * A CAS on `in_progress`, so two devices pressing activate converge: the loser
 * gets `null` and reads back the session the winner closed, rather than stamping
 * a second terminal instant over the first. The `activated` branch clears the
 * blockers because a session that activated had none — leaving a stale list
 * beside a terminal state is how a merchant reads "connected" and "blocked" at
 * once.
 */
export async function closeChannelOnboardingSession(
  storeId: string,
  sessionId: string,
  outcome: 'activated' | 'abandoned',
  at: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<ChannelOnboardingSessionRow | null> {
  const [row] = await db
    .update(channelOnboardingSessions)
    .set(
      outcome === 'activated'
        ? { state: 'activated', activatedAt: at, step: 'activate', activationBlockers: [] }
        : { state: 'abandoned', abandonedAt: at },
    )
    .where(
      and(
        eq(channelOnboardingSessions.id, sessionId),
        eq(channelOnboardingSessions.storeId, storeId),
        eq(channelOnboardingSessions.state, 'in_progress'),
      ),
    )
    .returning();
  return row ?? null;
}
