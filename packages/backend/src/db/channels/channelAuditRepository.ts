/**
 * `channel_audit_events` — the append-only channel audit trail (#87 security 7).
 *
 * ## The write signature is the redaction
 *
 * `recordChannelAuditEvent` takes a list of field NAMES and has no parameter a
 * value could go in. That is the #63 error-report rule ("an error report carries
 * no VALUES") held by a type rather than by a filter somebody has to remember to
 * apply — and the values in question here are a consumer secret and an API key
 * pair, so a `details` bag would be a plaintext credential store wearing an
 * audit trail's name.
 *
 * ## There is no update and no delete
 *
 * Not merely absent from this module: `mercaria_channel_audit_append_only`
 * raises on both, so a trail entry cannot be edited through drizzle, through a
 * future repository, or through `psql`.
 */

import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { ChannelAuditAction, ChannelTypeId } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { channelAuditEvents } from '../schema/channels.js';

/** One row of `channel_audit_events`. */
export type ChannelAuditEventRow = InferSelectModel<typeof channelAuditEvents>;

/** One audited act. Field NAMES only — there is nowhere to put a value. */
export interface NewChannelAuditEvent {
  storeId: string;
  action: ChannelAuditAction;
  actorOxyUserId: string;
  channelType?: ChannelTypeId;
  connectionId?: string;
  feedConfigurationId?: string;
  /** The names of the fields that changed. Never their values. */
  changedFields?: readonly string[];
}

/** Append one entry. */
export async function recordChannelAuditEvent(
  event: NewChannelAuditEvent,
  db: DatabaseOrTransaction = getDb(),
): Promise<ChannelAuditEventRow> {
  const [row] = await db
    .insert(channelAuditEvents)
    .values({
      storeId: event.storeId,
      action: event.action,
      actorOxyUserId: event.actorOxyUserId,
      channelType: event.channelType ?? null,
      connectionId: event.connectionId ?? null,
      feedConfigurationId: event.feedConfigurationId ?? null,
      changedFields: [...(event.changedFields ?? [])],
    })
    .returning();
  return row;
}

/**
 * One store's trail, newest first, keyset-paginated.
 *
 * The cursor is `(createdAt, id)` rather than an offset, because the trail grows
 * while it is being read and an offset would skip or repeat whatever was
 * appended between two pages.
 */
export async function listChannelAuditEvents(
  storeId: string,
  options: { limit: number; before?: { createdAt: Date; id: string } },
  db: DatabaseOrTransaction = getDb(),
): Promise<ChannelAuditEventRow[]> {
  const cursor = options.before;
  return await db
    .select()
    .from(channelAuditEvents)
    .where(
      cursor
        ? and(
            eq(channelAuditEvents.storeId, storeId),
            or(
              lt(channelAuditEvents.createdAt, cursor.createdAt),
              and(
                eq(channelAuditEvents.createdAt, cursor.createdAt),
                lt(channelAuditEvents.id, cursor.id),
              ),
            ),
          )
        : eq(channelAuditEvents.storeId, storeId),
    )
    .orderBy(desc(channelAuditEvents.createdAt), desc(channelAuditEvents.id))
    .limit(options.limit);
}
