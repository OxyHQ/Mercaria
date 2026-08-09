/**
 * Row → DTO projections for the backfill's operator surface.
 *
 * Every field is named explicitly rather than spread, the `payments` status
 * projection's rule: a column added to one of these tables must be a DECISION to
 * expose, not an automatic consequence of existing. The one thing that would
 * otherwise leak here is the lease pair — `lease_owner` is a task identity, and
 * publishing it invites somebody to reason about which ECS task is doing what,
 * which is not a fact this surface should make load-bearing.
 */

import type {
  CatalogBackfillRecord,
  CatalogBackfillRun,
  CatalogConsistencyFinding,
} from '@mercaria/shared-types';
import type { CatalogBackfillRunRow } from '../../db/backfill/backfillRunRepository.js';
import type { CatalogBackfillRecordRow } from '../../db/backfill/backfillRecordRepository.js';
import type { CatalogConsistencyFindingRow } from '../../db/backfill/consistencyFindingRepository.js';

export function toBackfillRunDTO(row: CatalogBackfillRunRow): CatalogBackfillRun {
  return {
    id: row.id,
    stage: row.stage,
    mode: row.mode,
    mappingVersion: row.mappingVersion,
    cohortKind: row.cohortKind,
    cohortValue: row.cohortValue,
    status: row.status,
    cursor: row.cursor,
    scanned: row.scanned,
    matched: row.matched,
    created: row.created,
    enqueued: row.enqueued,
    reviewRequired: row.reviewRequired,
    unmatched: row.unmatched,
    skipped: row.skipped,
    failed: row.failed,
    unchanged: row.unchanged,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastError: row.lastError,
    requestedByOxyUserId: row.requestedByOxyUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toBackfillRecordDTO(row: CatalogBackfillRecordRow): CatalogBackfillRecord {
  return {
    id: row.id,
    runId: row.runId,
    stage: row.stage,
    mode: row.mode,
    mappingVersion: row.mappingVersion,
    subjectKind: row.subjectKind,
    subjectKey: row.subjectKey,
    outcome: row.outcome,
    reasonCode: row.reasonCode,
    detail: row.detail,
    canonicalProductId: row.canonicalProductId,
    canonicalVariantId: row.canonicalVariantId,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toConsistencyFindingDTO(
  row: CatalogConsistencyFindingRow,
): CatalogConsistencyFinding {
  return {
    id: row.id,
    kind: row.kind,
    subjectKind: row.subjectKind,
    subjectKey: row.subjectKey,
    detail: row.detail,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}
