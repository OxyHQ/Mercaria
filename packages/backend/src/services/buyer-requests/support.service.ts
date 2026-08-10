/**
 * The bounded transactional support thread (#110 support thread).
 *
 * ## What it exists INSTEAD of
 *
 * "Rather than exposing buyer and seller personal email by default." A thread
 * is how the two sides talk without either learning the other's address, and
 * the enforcement is absence: there is no address column anywhere in the
 * domain, no recipient on a message, and the notification that a reply is
 * waiting goes through `guest_portal_messages`, which decrypts the contact at
 * the moment of sending and never writes it down.
 *
 * ## Three walls, and none of them is a runtime check
 *
 * A support message never becomes a review, a CrowdSource case or a trust
 * signal (support rules 7 and 8): this module writes no `reviews` row, opens no
 * moderation case and imports neither domain, and
 * `buyer-request-isolation.test.ts` fails the build if that changes. Reporting
 * abuse routes to `POST /reports`, which already exists and already delivers
 * through the moderation outbox — and a buyer or a seller reaches it the same
 * way they always did.
 *
 * ## Every body is redacted BEFORE it is stored
 *
 * `redactSupportBody` is pure and runs in the write path, so what lands in the
 * table is the redacted form and the original is dropped. A buyer who pastes a
 * card number has not put one in Mercaria's database for a retention window —
 * support rule 6, done at the earliest moment it can be.
 */

import type { SupportMessageAuthorKind } from '@mercaria/shared-types';
import { SUPPORT_MESSAGE_MAX_LENGTH } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  closeSupportThread as closeThreadRow,
  ensureSupportThread,
  findSupportThread,
  findSupportThreadById,
  insertSupportMessage,
  listSupportMessages,
  listSupportThreadsForOrder,
  type SupportMessageRow,
  type SupportThreadRow,
} from '../../db/buyerRequests/supportRepository.js';
import { findReturnRequestById } from '../../db/buyerRequests/returnRepository.js';
import { findOrderById } from '../../db/orders/orderRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import type { BuyerRequestActor, BuyerRequestDecider } from './authorization.js';
import { notifySupportResponse } from './notifications.js';
import { redactSupportBody } from './redaction.js';

/** A thread and everything in it. */
export interface SupportThreadWithMessages {
  readonly thread: SupportThreadRow;
  readonly messages: SupportMessageRow[];
}

/** Which conversation. An order, optionally narrowed to one return request. */
export interface SupportSubject {
  readonly orderId: string;
  readonly returnRequestId?: string;
}

/**
 * The author identity a writer contributes.
 *
 * A union over the two unforgeable actor types, so a support message can only
 * be written by somebody a gate already authorized — `authorization.ts`'s brand
 * reaching the one surface in this domain that accepts free text.
 */
export type SupportWriter =
  | { readonly side: 'buyer'; readonly actor: BuyerRequestActor }
  | { readonly side: 'seller'; readonly decider: BuyerRequestDecider }
  | { readonly side: 'operator'; readonly decider: BuyerRequestDecider };

/** The author columns a writer produces, in the shape the CHECK accepts. */
function authorColumns(writer: SupportWriter): {
  authorKind: SupportMessageAuthorKind;
  authorOxyUserId?: string;
  authorGrantId?: string;
} {
  if (writer.side === 'buyer') {
    // The two buyer origins collapse into ONE author kind, deliberately: a
    // seller reading the thread must not learn whether they are talking to a
    // guest or an account holder (#110 merchant rule 7). The audit still
    // distinguishes them, in the two protected columns below.
    return {
      authorKind: 'buyer',
      ...(writer.actor.oxyUserId === undefined
        ? {}
        : { authorOxyUserId: writer.actor.oxyUserId }),
      ...(writer.actor.grantId === undefined ? {} : { authorGrantId: writer.actor.grantId }),
    };
  }
  return { authorKind: writer.side, authorOxyUserId: writer.decider.oxyUserId };
}

/** Validate that a return-scoped thread's return actually belongs to the order. */
async function assertSubjectIsCoherent(subject: SupportSubject): Promise<void> {
  if (subject.returnRequestId === undefined) return;
  const request = await findReturnRequestById(subject.returnRequestId);
  // A 404 rather than a 400 for a mismatch: "that return exists but not on this
  // order" is a fact about somebody else's purchase, and the two answers must
  // not be distinguishable.
  if (!request || request.orderId !== subject.orderId) {
    throw notFound('Return request not found');
  }
}

/**
 * Post a message, creating the thread if this is the first one.
 *
 * The thread and the message commit together, so a failed write leaves no empty
 * conversation — and a retry that lost its response creates neither a second
 * thread (the partial uniques converge) nor, if the caller supplies the same
 * text twice, anything worse than a duplicate line a person can read past.
 * Messages are deliberately NOT deduplicated on content: two identical "any
 * news?" messages a day apart are two real messages.
 */
export async function postSupportMessage(input: {
  subject: SupportSubject;
  writer: SupportWriter;
  body: string;
}): Promise<SupportThreadWithMessages> {
  const trimmed = input.body.trim();
  if (trimmed.length === 0) throw validationError('A support message cannot be empty');
  if (trimmed.length > SUPPORT_MESSAGE_MAX_LENGTH) {
    throw validationError('The support message is too long');
  }
  await assertSubjectIsCoherent(input.subject);

  const redacted = redactSupportBody(trimmed);

  const threadId = await getDb().transaction(async (tx) => {
    const thread = await ensureSupportThread(tx, input.subject);
    const message = await insertSupportMessage(tx, {
      threadId: thread.id,
      ...authorColumns(input.writer),
      body: redacted.body,
      redactions: redacted.redactions,
    });
    return { threadId: thread.id, messageId: message.id };
  });

  // Only a REPLY notifies, and only the buyer is notified: a buyer writing to
  // their own thread does not need an email about it, and a seller has the
  // dashboard. #110 communication item 9.
  if (input.writer.side !== 'buyer') {
    const order = await findOrderById(input.subject.orderId);
    if (order) notifySupportResponse(order, threadId.threadId, threadId.messageId);
  }

  return readSupportThreadById(threadId.threadId);
}

/** One thread and its messages, by id. */
export async function readSupportThreadById(id: string): Promise<SupportThreadWithMessages> {
  const thread = await findSupportThreadById(id);
  if (!thread) throw notFound('Support thread not found');
  return { thread, messages: await listSupportMessages(thread.id) };
}

/** The thread for a subject, or `null` when nobody has written yet. */
export async function readSupportThread(
  subject: SupportSubject,
): Promise<SupportThreadWithMessages | null> {
  const thread = await findSupportThread(subject);
  if (!thread) return null;
  return { thread, messages: await listSupportMessages(thread.id) };
}

/** Every thread attached to one order, newest first. */
export async function listSupportThreads(orderId: string): Promise<SupportThreadRow[]> {
  return listSupportThreadsForOrder(orderId);
}

/**
 * Close a thread.
 *
 * Writes two columns on one row and reads nothing else — support rule 9's "does
 * not remove financial or dispute records" held by what the statement cannot
 * reach. Reopening is not a separate operation: a reply reopens it, because a
 * closed thread that cannot be reopened only teaches people to start a second
 * one.
 */
export async function closeSupportThread(input: {
  threadId: string;
  now: Date;
}): Promise<SupportThreadWithMessages> {
  const closed = await getDb().transaction(async (tx) =>
    closeThreadRow(tx, input.threadId, input.now),
  );
  if (!closed) {
    const existing = await findSupportThreadById(input.threadId);
    if (!existing) throw notFound('Support thread not found');
    // Already closed. Idempotent rather than a conflict: the client that
    // retried cannot tell its first call from a lost response.
    if (existing.state === 'closed') return readSupportThreadById(input.threadId);
    throw conflict('The thread could not be closed');
  }
  return readSupportThreadById(input.threadId);
}
