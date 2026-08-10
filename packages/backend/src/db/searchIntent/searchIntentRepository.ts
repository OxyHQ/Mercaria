/**
 * `search_intent_sessions` and `search_intent_turns` — the only writer of
 * either (#95).
 *
 * ## Ownership is a PREDICATE, never a check the caller remembers
 *
 * `findOwnedSession` takes the actor's own identity and puts it in the WHERE
 * clause, so a session belonging to somebody else is not found rather than
 * found-and-refused. There is deliberately no `findSession(id)` beside it: a
 * function that returns a row the caller then has to check is a function
 * somebody will eventually call without checking, and the failure would be a
 * shopper steering another shopper's clarification state.
 *
 * The `anonymous` branch is the one to read. An anonymous session has no owner
 * columns at all, so its predicate is `actor_kind = 'anonymous'` plus the id —
 * which means the id alone is the capability, and that is stated on the table
 * itself rather than left implicit here.
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  IntentActorKind,
  IntentClarificationKind,
  IntentFallbackReason,
  InterpretationMode,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { searchIntentSessions, searchIntentTurns } from '../schema/searchIntent.js';

/** One row of `search_intent_sessions`. */
export type SearchIntentSessionRow = InferSelectModel<typeof searchIntentSessions>;

/** One row of `search_intent_turns`. */
export type SearchIntentTurnRow = InferSelectModel<typeof searchIntentTurns>;

/** Who is asking, in the shape the owner predicate needs. */
export type SessionOwner =
  | { readonly kind: 'oxy'; readonly oxyUserId: string }
  | { readonly kind: 'guest'; readonly guestSessionId: string }
  | { readonly kind: 'anonymous' };

/** Everything a new session carries. */
export interface NewSearchIntentSession {
  readonly owner: SessionOwner;
  readonly locale: string;
  readonly market?: string;
  readonly expiresAt: Date;
}

/** Create one session. */
export async function createSearchIntentSession(
  input: NewSearchIntentSession,
  db: DatabaseOrTransaction = getDb(),
): Promise<SearchIntentSessionRow> {
  const [row] = await db
    .insert(searchIntentSessions)
    .values({
      actorKind: input.owner.kind satisfies IntentActorKind,
      ...(input.owner.kind === 'oxy' ? { oxyUserId: input.owner.oxyUserId } : {}),
      ...(input.owner.kind === 'guest' ? { guestSessionId: input.owner.guestSessionId } : {}),
      locale: input.locale,
      ...(input.market === undefined ? {} : { market: input.market }),
      expiresAt: input.expiresAt,
    })
    .returning();
  if (row === undefined) throw new Error('Failed to create a search intent session.');
  return row;
}

/**
 * The session with this id that belongs to this actor and has not expired.
 *
 * Expiry is in the PREDICATE rather than checked afterwards, for the same
 * reason ownership is: an expired session that is returned and then discarded
 * is one a caller can forget to discard, and a stale clarification state is
 * exactly the repetitive loop rule 7 exists to prevent.
 */
export async function findOwnedSession(
  sessionId: string,
  owner: SessionOwner,
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<SearchIntentSessionRow | undefined> {
  const ownerPredicate =
    owner.kind === 'oxy'
      ? eq(searchIntentSessions.oxyUserId, owner.oxyUserId)
      : owner.kind === 'guest'
        ? eq(searchIntentSessions.guestSessionId, owner.guestSessionId)
        : and(
            isNull(searchIntentSessions.oxyUserId),
            isNull(searchIntentSessions.guestSessionId),
          );
  const [row] = await db
    .select()
    .from(searchIntentSessions)
    .where(
      and(
        eq(searchIntentSessions.id, sessionId),
        eq(searchIntentSessions.actorKind, owner.kind),
        gt(searchIntentSessions.expiresAt, now),
        ownerPredicate,
      ),
    )
    .limit(1);
  return row;
}

/**
 * Record that a round of questions was asked.
 *
 * `asked_kinds` is UNIONED in SQL rather than read, merged and written back,
 * so two turns racing on one session cannot lose one another's kinds — the
 * losing writer would otherwise overwrite a kind the winner had just recorded,
 * and that kind would then be askable again, which is the repetition the bound
 * exists to prevent.
 */
export async function recordClarificationRound(
  sessionId: string,
  askedKinds: readonly IntentClarificationKind[],
  openClarificationId: string | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(searchIntentSessions)
    .set({
      askedKinds: sql`(
        select coalesce(array_agg(distinct kind), '{}'::text[])
        from unnest(${searchIntentSessions.askedKinds} || ${sql.param([...askedKinds])}::text[]) as kind
      )`,
      rounds: sql`${searchIntentSessions.rounds} + 1`,
      openClarificationId: openClarificationId ?? null,
    })
    .where(eq(searchIntentSessions.id, sessionId));
}

/** Close the open question — a shopper answered it, or searched anyway. */
export async function clearOpenClarification(
  sessionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(searchIntentSessions)
    .set({ openClarificationId: null })
    .where(eq(searchIntentSessions.id, sessionId));
}

/** Everything a recorded turn carries. */
export interface NewSearchIntentTurn {
  readonly sessionId?: string;
  readonly queryEventId?: string;
  readonly mode: InterpretationMode;
  readonly fallbackReason?: IntentFallbackReason;
  readonly provider: string;
  readonly model?: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly parserVersion: string;
  /** #77's redacted form. There is no parameter an original could arrive in. */
  readonly redactedQuery: string;
  readonly locale: string;
  readonly language: string;
  readonly categoryId?: string;
  readonly hardConstraintCount: number;
  readonly preferenceCount: number;
  readonly unresolvedCount: number;
  readonly clarificationCount: number;
  readonly latencyMs: number;
  readonly expiresAt: Date;
}

/** Record one served interpretation. */
export async function recordSearchIntentTurn(
  input: NewSearchIntentTurn,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(searchIntentTurns).values({
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.queryEventId === undefined ? {} : { queryEventId: input.queryEventId }),
    mode: input.mode,
    ...(input.fallbackReason === undefined ? {} : { fallbackReason: input.fallbackReason }),
    provider: input.provider,
    ...(input.model === undefined ? {} : { model: input.model }),
    promptVersion: input.promptVersion,
    schemaVersion: input.schemaVersion,
    parserVersion: input.parserVersion,
    redactedQuery: input.redactedQuery,
    locale: input.locale,
    language: input.language,
    ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
    hardConstraintCount: input.hardConstraintCount,
    preferenceCount: input.preferenceCount,
    unresolvedCount: input.unresolvedCount,
    clarificationCount: input.clarificationCount,
    latencyMs: input.latencyMs,
    expiresAt: input.expiresAt,
  });
}

/** One mode's share of the turns in a window, with the reasons behind it. */
export interface FallbackRateReport {
  readonly total: number;
  readonly modelCount: number;
  readonly deterministicCount: number;
  /** Every reason that occurred, with its count. Never a free-text sample. */
  readonly reasons: readonly { readonly reason: IntentFallbackReason; readonly count: number }[];
}

/**
 * The fallback rate over a window (#95 deterministic-fallback rule 8).
 *
 * Computed from the ROWS rather than from a process-local counter, because a
 * counter answers only about the task that happened to serve the traffic and
 * this question is about the deployment. The process-local counters in
 * `metrics.ts` exist beside it and answer a different question — what is
 * happening right now, during an incident, on this task.
 *
 * `count(*)` returns a `bigint`, which postgres.js decodes as a STRING, so
 * every count here is coerced at the boundary. A test that aggregates once
 * cannot catch the difference; two rows and a sum can.
 */
export async function readFallbackRate(
  since: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<FallbackRateReport> {
  const modeRows = await db
    .select({ mode: searchIntentTurns.mode, count: sql<string>`count(*)` })
    .from(searchIntentTurns)
    .where(gt(searchIntentTurns.createdAt, since))
    .groupBy(searchIntentTurns.mode);
  const reasonRows = await db
    .select({ reason: searchIntentTurns.fallbackReason, count: sql<string>`count(*)` })
    .from(searchIntentTurns)
    .where(
      and(gt(searchIntentTurns.createdAt, since), sql`${searchIntentTurns.fallbackReason} is not null`),
    )
    .groupBy(searchIntentTurns.fallbackReason);

  const modelCount = Number(modeRows.find((row) => row.mode === 'model')?.count ?? 0);
  const deterministicCount = Number(
    modeRows.find((row) => row.mode === 'deterministic')?.count ?? 0,
  );
  return {
    total: modelCount + deterministicCount,
    modelCount,
    deterministicCount,
    reasons: reasonRows
      .filter((row): row is { reason: IntentFallbackReason; count: string } => row.reason !== null)
      .map((row) => ({ reason: row.reason, count: Number(row.count) })),
  };
}

/**
 * One turn, for an operator trace.
 *
 * Opens from a TURN id and nothing else. There is no lookup by shopper, by
 * session owner or by query text — "show me everything this person searched
 * for" is not a question this surface can be asked, which is the
 * `/internal/analytics` trace's own posture applied to the same kind of data.
 */
export async function findTurn(
  turnId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SearchIntentTurnRow | undefined> {
  const [row] = await db
    .select()
    .from(searchIntentTurns)
    .where(eq(searchIntentTurns.id, turnId))
    .limit(1);
  return row;
}
