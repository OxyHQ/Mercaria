/**
 * `oxy_file_events` and `oxy_file_event_actions` — the file events Oxy
 * delivered, and what handling each did to every holding row: the audit trail
 * of a takedown. Append-only (`mercaria_oxy_file_events_append_only`, migration
 * `0170`); kept, like every audit record here, with no expiry.
 */

import type {
  OxyFileEventAction,
  OxyFileEventType,
  OxyFileReferenceEntityType,
} from '@mercaria/shared-types';
import { and, asc, eq } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { oxyFileEventActions, oxyFileEvents } from '../schema/oxyFiles.js';

/**
 * Claim an event by Oxy's id. The empty result IS "already handled": a
 * redelivery writes nothing, and a concurrent duplicate waits on the unique
 * index until the first commits, then finds the row.
 */
export async function claimOxyFileEvent(
  input: { eventId: string; type: OxyFileEventType; fileId: string; occurredAt?: Date },
  db: DatabaseOrTransaction,
): Promise<string | undefined> {
  const rows = await db
    .insert(oxyFileEvents)
    .values({
      eventId: input.eventId,
      type: input.type,
      fileId: input.fileId,
      occurredAt: input.occurredAt ?? null,
    })
    .onConflictDoNothing({ target: oxyFileEvents.eventId })
    .returning({ id: oxyFileEvents.id });
  return rows[0]?.id;
}

export async function recordOxyFileEventActions(
  oxyFileEventId: string,
  actions: readonly {
    entityType: OxyFileReferenceEntityType;
    entityId: string;
    action: OxyFileEventAction;
  }[],
  db: DatabaseOrTransaction,
): Promise<void> {
  for (let start = 0; start < actions.length; start += 500) {
    await db
      .insert(oxyFileEventActions)
      .values(actions.slice(start, start + 500).map((action) => ({ oxyFileEventId, ...action })))
      .onConflictDoNothing();
  }
}

/** What handling one event did — the operator's and the tests' read. */
export async function findOxyFileEventActions(
  eventId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<
  { entityType: OxyFileReferenceEntityType; entityId: string; action: OxyFileEventAction }[]
> {
  return db
    .select({
      entityType: oxyFileEventActions.entityType,
      entityId: oxyFileEventActions.entityId,
      action: oxyFileEventActions.action,
    })
    .from(oxyFileEventActions)
    .innerJoin(oxyFileEvents, eq(oxyFileEvents.id, oxyFileEventActions.oxyFileEventId))
    .where(and(eq(oxyFileEvents.eventId, eventId)))
    .orderBy(asc(oxyFileEventActions.entityType), asc(oxyFileEventActions.entityId));
}
