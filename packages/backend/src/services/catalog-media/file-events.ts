/**
 * Handle a file event Oxy delivered (ADR 0041 D9/D10).
 *
 * `file.blocked` (a rights or privacy takedown) and `file.deleted` make
 * Mercaria stop SHOWING the file: each registry entry's `detach` removes the
 * gallery image, clears the artwork column, removes the `<img>`, or suppresses a
 * canonical image / condition photo whose row is evidence. Evidence, order
 * snapshots and private deliverables are history and are only recorded
 * (`retained`) — financial history is never rewritten.
 *
 * Every other event (`trashed`, `restored`, `visibility_changed`, `unblocked`)
 * is recorded and changes nothing: an account's owner may restore what they
 * trashed, and a removal already made is not reversed automatically — Mercaria
 * cannot know the gallery position or the merchant's intent any more.
 *
 * ONE transaction: the dedupe claim, every presentation change and every audit
 * row commit together, so a failure leaves nothing behind and Oxy's retry does
 * the whole thing again. The presentation changes fire the reference triggers,
 * so the references of what was removed are withdrawn by the outbox.
 */

import {
  OXY_FILE_DETACHING_EVENT_TYPES,
  OXY_FILE_EVENT_TYPES,
  isOxyFileId,
  type OxyFileEventAction,
  type OxyFileEventType,
  type OxyFileReferenceEntityType,
} from '@mercaria/shared-types';
import type { FileEvent } from '@oxy.so/core/server';
import { getDb, type Database } from '../../db/postgres.js';
import {
  claimOxyFileEvent,
  recordOxyFileEventActions,
} from '../../db/oxyFiles/fileEventRepository.js';
import { findEntitiesHoldingFile, fileReferenceDefinitions } from './file-reference-registry.js';

/** The part of Oxy's payload Mercaria reads. An ALLOW-list: nothing else is kept. */
export interface OxyFileEvent {
  readonly id: string;
  readonly type: OxyFileEventType;
  readonly fileId: string;
  readonly occurredAt: Date | undefined;
}

/**
 * The allow-listed half of a VERIFIED delivery (`verifyOxyFileDelivery`), or
 * `undefined` when it names no file id Mercaria could hold. Only the id, the
 * type, the file and the time are kept; the owner kind, visibility and the
 * references Oxy lists are not needed to act, so they are not stored.
 */
export function toOxyFileEvent(event: FileEvent): OxyFileEvent | undefined {
  if (
    typeof event.id !== 'string' ||
    event.id.length === 0 ||
    event.id.length > 256 ||
    !(OXY_FILE_EVENT_TYPES as readonly string[]).includes(event.type) ||
    !isOxyFileId(event.file?.id) ||
    event.file.id.length > 64
  )
    return undefined;
  const occurred = typeof event.occurredAt === 'string' ? new Date(event.occurredAt) : undefined;
  return {
    id: event.id,
    type: event.type as OxyFileEventType,
    fileId: event.file.id,
    occurredAt: occurred && !Number.isNaN(occurred.getTime()) ? occurred : undefined,
  };
}

export interface OxyFileEventResult {
  readonly duplicate: boolean;
  readonly actions: readonly {
    entityType: OxyFileReferenceEntityType;
    entityId: string;
    action: OxyFileEventAction;
  }[];
}

export async function handleOxyFileEvent(
  event: OxyFileEvent,
  db: Database = getDb(),
): Promise<OxyFileEventResult> {
  return db.transaction(async (tx) => {
    const claimed = await claimOxyFileEvent(
      {
        eventId: event.id,
        type: event.type,
        fileId: event.fileId,
        ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
      },
      tx,
    );
    if (!claimed) return { duplicate: true, actions: [] };
    const actions: {
      entityType: OxyFileReferenceEntityType;
      entityId: string;
      action: OxyFileEventAction;
    }[] = [];
    if ((OXY_FILE_DETACHING_EVENT_TYPES as readonly string[]).includes(event.type)) {
      for (const definition of fileReferenceDefinitions()) {
        const acted = new Set<string>();
        if (definition.detach) {
          const outcome = await definition.detach(tx, event.fileId, event.type);
          for (const entityId of outcome.entityIds) {
            acted.add(entityId);
            actions.push({ entityType: definition.entityType, entityId, action: outcome.action });
          }
        }
        // Whatever still holds the file — history, or a row its detach leaves
        // (a published authoring draft) — is recorded as deliberately kept.
        if (definition.sources.length === 0) continue;
        for (const entityId of await findEntitiesHoldingFile(definition, event.fileId, tx)) {
          if (acted.has(entityId)) continue;
          actions.push({ entityType: definition.entityType, entityId, action: 'retained' });
        }
      }
      await recordOxyFileEventActions(claimed, actions, tx);
    }
    return { duplicate: false, actions };
  });
}
