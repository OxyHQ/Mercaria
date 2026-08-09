/**
 * The ONE writer of `catalog_revisions` (#59 acceptance 4, security 3).
 *
 * Every operator act in this domain goes through here, so "does this action
 * appear in the timeline" is answered by reading one function's call sites
 * rather than by auditing every service. The table's trigger then makes what it
 * wrote permanent.
 *
 * ## The actor rule is enforced here as well as by the CHECK
 *
 * `catalog_revisions_actor_presence_check` already refuses an operator revision
 * with no person and a machine revision with one. This function refuses the same
 * thing one layer earlier so the error names the CALLER's mistake instead of
 * surfacing a constraint violation — the constraint is the guarantee, and this
 * is the message.
 */

import type {
  CatalogRevisionAction,
  CatalogRevisionActorKind,
  CurationSubjectType,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  insertRevision,
  findCompensationFor,
  findRevisionById,
  type InsertRevisionInput,
} from '../../db/curation/curationRepository.js';
import type { CatalogRevisionRow } from '../../db/schema/curation.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';

export interface RecordRevisionInput {
  readonly entityType: CurationSubjectType;
  readonly entityId: string;
  readonly action: CatalogRevisionAction;
  readonly actorKind: CatalogRevisionActorKind;
  readonly actorOxyUserId?: string | null;
  readonly reason: string;
  readonly note?: string | null;
  readonly sourceRecordId?: string | null;
  readonly policyVersionId?: string | null;
  readonly mergeJobId?: string | null;
  readonly splitJobId?: string | null;
  readonly reviewItemId?: string | null;
  readonly compensatesRevisionId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
}

/** Append one revision. */
export async function recordRevision(
  input: RecordRevisionInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogRevisionRow> {
  if (input.reason.trim() === '') {
    throw validationError('Every catalogue revision needs a reason; an unexplained change is not auditable.');
  }
  const actor = input.actorOxyUserId ?? null;
  if (input.actorKind === 'operator' && (actor === null || actor.trim() === '')) {
    throw validationError('An operator revision must name the operator.');
  }
  if (input.actorKind !== 'operator' && actor !== null) {
    throw validationError(
      `A ${input.actorKind} revision must not name a person: an Oxy id on it would read as ` +
        'somebody having decided what a feed merely asserted.',
    );
  }
  const payload: InsertRevisionInput = {
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    actorKind: input.actorKind,
    actorOxyUserId: actor,
    reason: input.reason,
    note: input.note ?? null,
    sourceRecordId: input.sourceRecordId ?? null,
    policyVersionId: input.policyVersionId ?? null,
    mergeJobId: input.mergeJobId ?? null,
    splitJobId: input.splitJobId ?? null,
    reviewItemId: input.reviewItemId ?? null,
    compensatesRevisionId: input.compensatesRevisionId ?? null,
    before: input.before,
    after: input.after,
  };
  return insertRevision(payload, db);
}

export interface CompensateInput {
  readonly revisionId: string;
  readonly reason: string;
  readonly actorOxyUserId: string;
  readonly note?: string;
}

/**
 * Record a COMPENSATING correction (#59 operator action 10).
 *
 * ## It records the undo; it does not perform it
 *
 * The graph change that reverses an action is an ordinary operator act — a
 * split reverses a merge, a lift reverses a suppression, a new identifier
 * assignment reverses a reassignment — and each has its own endpoint with its
 * own validation. What this adds is the LINK: a revision naming the one it
 * undoes, so the timeline reads as a pair rather than as two unrelated events.
 *
 * A generic "apply the inverse of `before`/`after`" would be the alternative and
 * it is unsafe in exactly the case it would be reached for: the snapshot may
 * describe a schema that has since changed, and replaying it would write columns
 * whose meaning moved. The audit trail is a record, not an undo log.
 *
 * One compensation per revision, because two would each claim to have undone the
 * same act and neither would be able to say what state the entity is in.
 */
export async function recordCompensation(input: CompensateInput): Promise<CatalogRevisionRow> {
  const db = getDb();
  const original = await findRevisionById(input.revisionId, db);
  if (!original) throw notFound(`No catalogue revision ${input.revisionId}.`);
  if (original.action === 'compensate') {
    throw validationError(
      'A compensating correction cannot itself be compensated; record a NEW act instead, so the ' +
        'timeline reads forwards.',
    );
  }
  const existing = await findCompensationFor(input.revisionId, db);
  if (existing) {
    throw conflict(
      `Revision ${input.revisionId} was already compensated by ${existing.id}.`,
    );
  }
  return recordRevision(
    {
      entityType: original.entityType,
      entityId: original.entityId,
      action: 'compensate',
      actorKind: 'operator',
      actorOxyUserId: input.actorOxyUserId,
      reason: input.reason,
      note: input.note ?? null,
      compensatesRevisionId: original.id,
      before: original.after,
      after: original.before,
    },
    db,
  );
}
