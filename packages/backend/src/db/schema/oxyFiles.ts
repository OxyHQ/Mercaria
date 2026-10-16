/**
 * Oxy Files usage registration — Mercaria's half of Oxy ADR 0041.
 *
 * Oxy keeps an APPLICATION-owned file only while some application references it
 * (D5: unreferenced for 24 hours → trash → purged 30 days later), and tells every
 * referencing application when a file is blocked or deleted (D9). So every
 * Mercaria row that holds an Oxy file id has to be told to Oxy, and taken back
 * when the row stops holding it. Four tables:
 *
 * - `oxy_file_reference_outboxes` — "this entity's file usage may have changed".
 *   One row per `(entity_type, entity_id)`, written by a TRIGGER on every table
 *   that holds a file id (migration `0170`), in the writer's own transaction.
 * - `oxy_file_references` — what Oxy has acknowledged: the references Mercaria
 *   registered and has not yet removed.
 * - `oxy_file_reference_reconciliations` — the nightly safety net (D6), one row
 *   per entity type.
 * - `oxy_file_events` + `oxy_file_event_actions` — the file events Oxy delivered
 *   and what Mercaria did to each holding row: the audit trail of a takedown.
 *
 * ## Why the enqueue is a trigger, not an `enqueue*` call
 *
 * `house-invariants.md` says an enqueue takes its handle as a required parameter
 * so the row commits with the write it describes. A trigger is the stronger form
 * of the same rule: the population of writers of these columns is not a list
 * anybody can keep — a listing deletion CASCADES its gallery, a canonical merge
 * moves images, a backfill and an operator's SQL write the same columns — and a
 * writer this module did not know about is exactly a removal never sent, which
 * is a file Oxy keeps forever (account) or a file Oxy collects while a page
 * still shows it (application). The trigger fires for every one of them, inside
 * its transaction, so a rolled-back write leaves no request behind and a
 * committed one cannot lose its request.
 *
 * ## Why the outbox names an ENTITY and the worker DERIVES the file set
 *
 * The trigger cannot know the file ids of an HTML description (they are `src`
 * attributes), and an `entity_type`'s set of files is often more than one
 * column. So the row says only WHICH entity changed — the offer outbox's fixed
 * point: "whatever this entity holds when you run, make Oxy's references say
 * that" — and the worker computes the desired set from the live rows, diffs it
 * against `oxy_file_references` and sends the difference. Five writes in a second
 * owe one convergence; the revision pair (`requested_revision` /
 * `claimed_revision`) keeps a write that lands mid-run from being lost.
 *
 * ## `oxy_file_references` is not a second verdict of the usage fact
 *
 * The usage fact is the holding row (ONE stored verdict per fact). This table
 * records a DIFFERENT fact: what Oxy has been told and acknowledged — which is
 * exactly what a removal needs (the row that held the file is already gone) and
 * what the live rows cannot say. When it drifts from Oxy (a crash between the
 * Oxy call and the ledger write) the cost is a repeated idempotent call or a
 * removal deferred to the nightly reconciliation, which rewrites it.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import {
  OXY_FILE_EVENT_ACTIONS,
  OXY_FILE_EVENT_TYPES,
  OXY_FILE_REFERENCE_ENTITY_TYPES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';

/** A converged job is DELETED, so there is no `done`: the table holds only owed work. */
export const OXY_FILE_REFERENCE_OUTBOX_STATUSES = ['pending', 'processing', 'dead_letter'] as const;
export type OxyFileReferenceOutboxStatus = (typeof OXY_FILE_REFERENCE_OUTBOX_STATUSES)[number];

/**
 * `registered` — Oxy answered `created` or `exists`. `refused` — Oxy answered
 * `not_found` to an add: the file does not exist, or Mercaria may not reference it
 * (another application's private file, a person's private file). Kept so the
 * worker does not ask again on every write; the nightly reconciliation asks again.
 */
export const OXY_FILE_REFERENCE_STATES = ['registered', 'refused'] as const;
export type OxyFileReferenceState = (typeof OXY_FILE_REFERENCE_STATES)[number];

/** Bound on a stored dispatch or reconciliation error. */
export const OXY_FILE_REFERENCE_MAX_LAST_ERROR_LENGTH = 2_000;

/**
 * Oxy's own bounds on a reference (`serviceReferenceSchema`): an entity id of at
 * most 256 characters and a file id of at most 64. CHECKed here so a row Oxy
 * would refuse wholesale (a 400 for the whole batch of 100) cannot be enqueued.
 */
const MAX_ENTITY_ID_LENGTH = 256;
const MAX_FILE_ID_LENGTH = 64;

export const oxyFileReferenceOutboxes = pgTable(
  'oxy_file_reference_outboxes',
  {
    id: generatedId(),
    entityType: text({ enum: asEnumValues(OXY_FILE_REFERENCE_ENTITY_TYPES) }).notNull(),
    /** The holding row's id (or its parent's — `docs/catalog-media.md` says which). No FK: the row may be gone, which is the removal. */
    entityId: text().notNull(),
    /** Bumped by every enqueue. Monotonic per row; never a clock. */
    requestedRevision: bigint({ mode: 'number' }).notNull().default(1),
    /** The revision this claim is answering. NULL before the first claim. */
    claimedRevision: bigint({ mode: 'number' }),
    status: text({ enum: asEnumValues(OXY_FILE_REFERENCE_OUTBOX_STATUSES) })
      .notNull()
      .default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    /** Which task holds the lease. An opaque worker identity — no foreign key. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'oxy_file_reference_outboxes_entity_type_check',
      t.entityType,
      OXY_FILE_REFERENCE_ENTITY_TYPES,
    ),
    checkOneOf(
      'oxy_file_reference_outboxes_status_check',
      t.status,
      OXY_FILE_REFERENCE_OUTBOX_STATUSES,
    ),
    check(
      'oxy_file_reference_outboxes_entity_id_check',
      sql`length(${t.entityId}) between 1 and ${sql.raw(String(MAX_ENTITY_ID_LENGTH))}`,
    ),
    check('oxy_file_reference_outboxes_attempts_check', sql`${t.attempts} >= 0`),
    check('oxy_file_reference_outboxes_requested_revision_check', sql`${t.requestedRevision} >= 1`),
    check(
      'oxy_file_reference_outboxes_claimed_revision_check',
      sql`${t.claimedRevision} is null or ${t.claimedRevision} <= ${t.requestedRevision}`,
    ),
    check(
      'oxy_file_reference_outboxes_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(OXY_FILE_REFERENCE_MAX_LAST_ERROR_LENGTH))}`,
    ),
    /** The convergence key: one outstanding job per entity, ever. */
    uniqueIndex('oxy_file_reference_outboxes_entity_key').on(t.entityType, t.entityId),
    // The moderation/offer outboxes' two-branch claim, one partial index per branch.
    index('oxy_file_reference_outboxes_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index('oxy_file_reference_outboxes_reclaim_idx')
      .on(t.leaseUntil, t.createdAt)
      .where(sql`${t.status} = 'processing'`),
  ],
);

export const oxyFileReferences = pgTable(
  'oxy_file_references',
  {
    id: generatedId(),
    entityType: text({ enum: asEnumValues(OXY_FILE_REFERENCE_ENTITY_TYPES) }).notNull(),
    entityId: text().notNull(),
    /** An Oxy file id. Oxy owns the file; no foreign key. */
    fileId: text().notNull(),
    state: text({ enum: asEnumValues(OXY_FILE_REFERENCE_STATES) }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'oxy_file_references_entity_type_check',
      t.entityType,
      OXY_FILE_REFERENCE_ENTITY_TYPES,
    ),
    checkOneOf('oxy_file_references_state_check', t.state, OXY_FILE_REFERENCE_STATES),
    check(
      'oxy_file_references_entity_id_check',
      sql`length(${t.entityId}) between 1 and ${sql.raw(String(MAX_ENTITY_ID_LENGTH))}`,
    ),
    check(
      'oxy_file_references_file_id_check',
      sql`${t.fileId} ~ '^[A-Za-z0-9_-]+$' and length(${t.fileId}) <= ${sql.raw(String(MAX_FILE_ID_LENGTH))}`,
    ),
    uniqueIndex('oxy_file_references_entity_file_key').on(t.entityType, t.entityId, t.fileId),
    // A file event names a FILE; this is how it finds every entity told about it.
    index('oxy_file_references_file_id_idx').on(t.fileId),
  ],
);

export const oxyFileReferenceReconciliations = pgTable(
  'oxy_file_reference_reconciliations',
  {
    id: generatedId(),
    entityType: text({ enum: asEnumValues(OXY_FILE_REFERENCE_ENTITY_TYPES) }).notNull(),
    /** When the next run is due. A run that fails is retried with backoff, not tomorrow. */
    nextRunAt: timestamptz().notNull(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    attempts: integer().notNull().default(0),
    lastStartedAt: timestamptz(),
    lastCompletedAt: timestamptz(),
    /** Whether the last COMPLETED run was a dry run — what its counts mean. */
    lastDryRun: boolean(),
    lastAdded: integer(),
    lastRemoved: integer(),
    lastUnchanged: integer(),
    lastRefused: integer(),
    lastInventory: integer(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'oxy_file_reference_reconciliations_entity_type_check',
      t.entityType,
      OXY_FILE_REFERENCE_ENTITY_TYPES,
    ),
    check('oxy_file_reference_reconciliations_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'oxy_file_reference_reconciliations_counts_check',
      sql`coalesce(${t.lastAdded}, 0) >= 0 and coalesce(${t.lastRemoved}, 0) >= 0
          and coalesce(${t.lastUnchanged}, 0) >= 0 and coalesce(${t.lastRefused}, 0) >= 0
          and coalesce(${t.lastInventory}, 0) >= 0`,
    ),
    check(
      'oxy_file_reference_reconciliations_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(OXY_FILE_REFERENCE_MAX_LAST_ERROR_LENGTH))}`,
    ),
    uniqueIndex('oxy_file_reference_reconciliations_entity_type_key').on(t.entityType),
  ],
);

export const oxyFileEvents = pgTable(
  'oxy_file_events',
  {
    id: generatedId(),
    /** Oxy's event id, as delivered — a provider id, never this table's key. */
    eventId: text().notNull(),
    type: text({ enum: asEnumValues(OXY_FILE_EVENT_TYPES) }).notNull(),
    /** An Oxy file id. Oxy owns the file; no foreign key. */
    fileId: text().notNull(),
    /** When Oxy says the event happened. */
    occurredAt: timestamptz(),
    receivedAt: createdAt(),
  },
  (t) => [
    checkOneOf('oxy_file_events_type_check', t.type, OXY_FILE_EVENT_TYPES),
    check('oxy_file_events_event_id_check', sql`length(${t.eventId}) between 1 and 256`),
    check(
      'oxy_file_events_file_id_check',
      sql`${t.fileId} ~ '^[A-Za-z0-9_-]+$' and length(${t.fileId}) <= ${sql.raw(String(MAX_FILE_ID_LENGTH))}`,
    ),
    /** The dedupe claim: a redelivered event writes nothing. */
    uniqueIndex('oxy_file_events_event_id_key').on(t.eventId),
    index('oxy_file_events_file_id_idx').on(t.fileId),
  ],
);

export const oxyFileEventActions = pgTable(
  'oxy_file_event_actions',
  {
    id: generatedId(),
    oxyFileEventId: text()
      .notNull()
      .references(() => oxyFileEvents.id, { onDelete: 'restrict' }),
    entityType: text({ enum: asEnumValues(OXY_FILE_REFERENCE_ENTITY_TYPES) }).notNull(),
    entityId: text().notNull(),
    action: text({ enum: asEnumValues(OXY_FILE_EVENT_ACTIONS) }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'oxy_file_event_actions_entity_type_check',
      t.entityType,
      OXY_FILE_REFERENCE_ENTITY_TYPES,
    ),
    checkOneOf('oxy_file_event_actions_action_check', t.action, OXY_FILE_EVENT_ACTIONS),
    uniqueIndex('oxy_file_event_actions_event_entity_key').on(
      t.oxyFileEventId,
      t.entityType,
      t.entityId,
    ),
  ],
);
