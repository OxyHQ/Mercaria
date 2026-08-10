/**
 * The clarification session, as a stateful thing (#95 clarification rule 4).
 *
 * `clarification.ts` holds the DECISIONS — may this session ask again, does
 * this kind repeat, which question does this answer belong to — and this holds
 * the reading and writing of the row those decisions are made against. The
 * split is the ordinary one in this codebase: the pure half is testable against
 * exact inputs, and the impure half is one place a lock or an ownership
 * predicate can be got right once.
 *
 * ## A session is CREATED lazily, and only when there is a question to ask
 *
 * The `guest_sessions` rule ("issuance is lazy and a WRITE"), applied here: a
 * search that resolves cleanly and asks nothing creates no row, so the ordinary
 * case — most queries — writes nothing at all. A row appears the first time
 * Mercaria has a question worth asking, which is exactly when there is state to
 * keep.
 */

import type { CommerceActor } from '../commerce-actor.js';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  clearOpenClarification,
  createSearchIntentSession,
  findOwnedSession,
  recordClarificationRound,
  type SearchIntentSessionRow,
  type SessionOwner,
} from '../../db/searchIntent/searchIntentRepository.js';
import type { IntentClarificationKind } from '@mercaria/shared-types';

/**
 * The actor, in the shape the ownership predicate needs.
 *
 * A `switch` over `CommerceActor`, which has no common `id` field — so a guest
 * session id can never reach the `oxy_user_id` column and an Oxy id can never
 * reach the guest one. The `cartOwnerForActor` mechanism, one domain over, and
 * for the same reason: the compiler enforces it rather than a reviewer.
 */
export function sessionOwnerForActor(actor: CommerceActor): SessionOwner {
  switch (actor.kind) {
    case 'oxy':
      return { kind: 'oxy', oxyUserId: actor.oxyUserId };
    case 'guest':
      return { kind: 'guest', guestSessionId: actor.guestSessionId };
    case 'anonymous':
      return { kind: 'anonymous' };
  }
}

/** The session this request belongs to, when it named a live one it owns. */
export async function loadSession(
  sessionId: string | undefined,
  actor: CommerceActor,
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<SearchIntentSessionRow | undefined> {
  if (sessionId === undefined) return undefined;
  return findOwnedSession(sessionId, sessionOwnerForActor(actor), now, db);
}

/**
 * Ensure there is a session to attach questions to.
 *
 * Called ONLY when the plan produced at least one clarification, which is what
 * makes creation lazy. An existing session is reused; a request that named an
 * expired or foreign one gets a NEW session rather than an error, because the
 * shopper is asking a shopping question and "your clarification session
 * expired" is not an answer to it.
 */
export async function ensureSession(
  existing: SearchIntentSessionRow | undefined,
  actor: CommerceActor,
  locale: string,
  market: string | undefined,
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<SearchIntentSessionRow> {
  if (existing !== undefined) return existing;
  return createSearchIntentSession(
    {
      owner: sessionOwnerForActor(actor),
      locale,
      ...(market === undefined ? {} : { market }),
      expiresAt: new Date(now.getTime() + config.searchIntent.sessionTtlSeconds * 1_000),
    },
    db,
  );
}

/** Record that a round of questions was asked, and which one is open. */
export async function noteAsked(
  sessionId: string,
  kinds: readonly IntentClarificationKind[],
  openClarificationId: string | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await recordClarificationRound(sessionId, kinds, openClarificationId, db);
}

/** Close the open question — a shopper answered it, or searched anyway. */
export async function noteAnswered(
  sessionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await clearOpenClarification(sessionId, db);
}
