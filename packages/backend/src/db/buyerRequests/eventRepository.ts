/**
 * The buyer-request audit trail — `buyer_request_events` (#110).
 *
 * One writer, no updater and no deleter, which is the whole of the module: the
 * table is append-only by trigger, so an `update` here would compile, ship and
 * then raise in production. Not offering one is the cheaper guarantee.
 *
 * Every write takes a transaction handle, because an audit row that commits
 * separately from the fact it describes is a trail with holes in exactly the
 * cases anybody would read it for — a decision that rolled back, a completion
 * that half-happened.
 */

import { asc, eq } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import type {
  BuyerRequestActorKind,
  BuyerRequestEventKind,
} from '@mercaria/shared-types';
import { buyerRequestEvents } from '../schema/buyerRequests.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** One recorded attempt. Exactly one of the two subject ids is present. */
export interface NewBuyerRequestEvent {
  cancellationRequestId?: string;
  returnRequestId?: string;
  kind: BuyerRequestEventKind;
  actorKind: BuyerRequestActorKind;
  actorOxyUserId?: string;
  actorGrantId?: string;
  /** A BOUNDED code, never an exception message. */
  detail?: string;
  at: Date;
}

/**
 * A trail entry as a reader gets it — without the two protected actor columns.
 *
 * `publicColumns` withholds them at runtime AND at the type level, so a
 * projection that reaches for the buyer's Oxy id or their grant id fails `tsc`
 * rather than shipping a correlation key into a merchant's dashboard.
 */
export type BuyerRequestEventRow = Awaited<ReturnType<typeof listBuyerRequestEvents>>[number];

/** Append one attempt. Takes a transaction handle — see the module docblock. */
export async function recordBuyerRequestEvent(
  tx: DatabaseOrTransaction,
  event: NewBuyerRequestEvent,
): Promise<void> {
  await tx.insert(buyerRequestEvents).values({
    ...(event.cancellationRequestId === undefined
      ? {}
      : { cancellationRequestId: event.cancellationRequestId }),
    ...(event.returnRequestId === undefined ? {} : { returnRequestId: event.returnRequestId }),
    kind: event.kind,
    actorKind: event.actorKind,
    ...(event.actorOxyUserId === undefined ? {} : { actorOxyUserId: event.actorOxyUserId }),
    ...(event.actorGrantId === undefined ? {} : { actorGrantId: event.actorGrantId }),
    ...(event.detail === undefined ? {} : { detail: event.detail }),
    at: event.at,
  });
}

/** One request's trail, oldest first. Both subjects share one reader. */
export async function listBuyerRequestEvents(
  subject: { cancellationRequestId: string } | { returnRequestId: string },
  db: DatabaseOrTransaction = getDb(),
) {
  return db
    .select(publicColumns(buyerRequestEvents, PROTECTED_COLUMNS))
    .from(buyerRequestEvents)
    .where(
      'cancellationRequestId' in subject
        ? eq(buyerRequestEvents.cancellationRequestId, subject.cancellationRequestId)
        : eq(buyerRequestEvents.returnRequestId, subject.returnRequestId),
    )
    .orderBy(asc(buyerRequestEvents.at), asc(buyerRequestEvents.id));
}
