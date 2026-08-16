/**
 * The queue an unmapped or ambiguous token goes to (#367 Workstream 11).
 *
 * There is no default mapping and no fallback that invents one, so every token
 * this domain cannot answer arrives here. That is the whole of "an unmapped or
 * ambiguous value goes to REVIEW, never to a guess", and the reason it is worth
 * a table rather than a log line is #58's: a false merge looks exactly like a
 * correct match, contaminates every page downstream and is discovered by a
 * customer. A taxonomy guess is the same failure one layer up, and the only
 * thing that catches it is a person being shown what the source actually wrote.
 *
 * ## Priority is a stored integer computed when the row is opened
 *
 * #94's decision, for #94's reason: "how much does this matter" is a product
 * judgement made against the catalogue as it was, and re-deriving it later
 * against a changed catalogue silently reorders a queue somebody is working
 * through. What it is computed FROM is stated in {@link reviewPriority} rather
 * than hidden in a constant.
 */

import type {
  CatalogExternalMappingDimension,
  CatalogExternalReviewReason,
  CatalogExternalReviewView,
  CatalogExternalSubjectKind,
  CatalogExternalUnresolvedReason,
} from '@mercaria/shared-types';
import { conflict, validationError } from '../../lib/errors/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findExternalMapping,
  readOpenExternalMappingReviews,
  settleExternalMappingReview,
  upsertExternalMappingReview,
  type ExternalMappingReviewRow,
} from '../../db/catalogExternalMappings/externalMappingRepository.js';

/**
 * How a resolution refusal becomes a review reason.
 *
 * An exhaustive `Record`, so an eighth unresolved reason fails `tsc` here rather
 * than falling into a bucket nobody reads — the `ANALYTICS_REASON_CODES` device
 * (#106). Two reasons deliberately map to the SAME review reason and two
 * deliberately do not:
 *
 * - `mapping_not_approved` and `mapping_expired` both become `unmapped`,
 *   because the reviewer's job in both cases is to decide what the token should
 *   mean now.
 * - `registry_unavailable` keeps its own reason: it is a fact about the
 *   deployment, not about the token, and a reviewer cannot fix it by choosing a
 *   target. Filing it as `unmapped` would fill the queue with rows nobody can
 *   action.
 */
const REVIEW_REASON_FOR: Readonly<
  Record<CatalogExternalUnresolvedReason, CatalogExternalReviewReason>
> = Object.freeze({
  unmapped: 'unmapped',
  ambiguous: 'ambiguous_candidates',
  mapping_not_approved: 'unmapped',
  mapping_expired: 'unmapped',
  target_unresolvable: 'target_unresolvable',
  registry_unavailable: 'registry_unavailable',
  transform_refused: 'transform_refused',
});

/**
 * The priority a review opens at.
 *
 * Written out rather than tuned, because the ordering it produces is what an
 * operator works through. A `target_unresolvable` outranks an `unmapped`: the
 * first means a mapping that was approved has stopped working, which is a
 * regression somebody caused, while the second is the ordinary first sighting of
 * a new token. `registry_unavailable` sits at the BOTTOM — it is real, it is
 * worth recording, and no reviewer can do anything about it until an issue
 * lands.
 */
export function reviewPriority(reason: CatalogExternalReviewReason): number {
  switch (reason) {
    case 'target_unresolvable':
      return 40;
    case 'legacy_disagreement':
      return 30;
    case 'fan_out_unapproved':
      return 20;
    case 'ambiguous_candidates':
      return 15;
    case 'transform_refused':
      return 10;
    case 'unmapped':
      return 5;
    case 'registry_unavailable':
      return 0;
  }
}

/** What was seen, and why it could not be answered. */
export interface OpenReviewForRefusalInput {
  readonly catalogSourceId: string;
  readonly dimension: CatalogExternalMappingDimension;
  readonly externalKey: string;
  readonly externalLabel?: string;
  readonly externalPath?: readonly string[];
  /** The source's value VERBATIM. The whole point of the queue is that a person sees it. */
  readonly observedRawValue?: string;
  readonly sourceRecordId?: string;
  readonly reason: CatalogExternalUnresolvedReason;
  readonly candidateMappingIds?: readonly string[];
  readonly subject?: { readonly kind: CatalogExternalSubjectKind; readonly key: string };
  readonly observedAt: Date;
}

/**
 * Open a review for a token that did not resolve, or count another sighting
 * against the one already open.
 *
 * Converges on the partial unique rather than on a read-then-write, so two
 * ingestion workers meeting the same unknown value a millisecond apart cannot
 * open two rows for a reviewer to settle one of.
 */
export async function openReviewForRefusal(
  input: OpenReviewForRefusalInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingReviewRow> {
  const reason = REVIEW_REASON_FOR[input.reason];
  const candidates = reason === 'ambiguous_candidates' ? (input.candidateMappingIds ?? []) : [];
  return upsertExternalMappingReview(
    {
      catalogSourceId: input.catalogSourceId,
      dimension: input.dimension,
      externalKey: input.externalKey,
      ...(input.externalLabel === undefined ? {} : { externalLabel: input.externalLabel }),
      ...(input.externalPath === undefined ? {} : { externalPath: input.externalPath }),
      ...(input.observedRawValue === undefined
        ? {}
        : { observedRawValue: input.observedRawValue }),
      ...(input.sourceRecordId === undefined ? {} : { sourceRecordId: input.sourceRecordId }),
      reason,
      priority: reviewPriority(reason),
      summary: summarize(input, reason),
      candidateMappingIds: candidates,
      observedAt: input.observedAt,
    },
    db,
  );
}

/**
 * One line a reviewer reads in a list.
 *
 * It names the DIMENSION and the token and says what happened, and it carries no
 * suggestion of what the answer should be. A summary that proposed a target
 * would be a nearest-match guess arriving through the copy — which is what this
 * queue exists so that nobody does.
 */
function summarize(
  input: OpenReviewForRefusalInput,
  reason: CatalogExternalReviewReason,
): string {
  const token = input.externalLabel ?? input.externalKey;
  switch (reason) {
    case 'unmapped':
      return `No approved ${input.dimension} mapping covers '${token}'.`;
    case 'ambiguous_candidates':
      return `'${token}' has several candidate ${input.dimension} targets and no decision between them.`;
    case 'fan_out_unapproved':
      return `'${token}' already resolves; a second target needs a fan-out approval.`;
    case 'target_unresolvable':
      return `The approved mapping for '${token}' names a Mercaria concept that no longer resolves.`;
    case 'legacy_disagreement':
      return `The governed mapping for '${token}' disagrees with this source's legacy registry entry.`;
    case 'transform_refused':
      return `The transform rule cited for '${token}' refused this source's value.`;
    case 'registry_unavailable':
      return `No Mercaria ${input.dimension} registry is available in this deployment.`;
  }
}

/**
 * Open a review because the governed mapping and #94's registry disagree.
 *
 * A separate entry point rather than a member of
 * {@link CatalogExternalUnresolvedReason}, because a disagreement is not a
 * RESOLUTION failure: the token resolves perfectly well, and what is wrong is
 * that two records of one fact say different things. Routing it through
 * `openReviewForRefusal` would file it as `unmapped`, which is the one reading
 * that would send a reviewer to create the mapping that already exists.
 */
export async function openLegacyDisagreementReview(
  input: {
    readonly catalogSourceId: string;
    readonly sourceField: string;
    readonly legacyAttributeKey: string;
    readonly governedAttributeKey: string;
    readonly at: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingReviewRow> {
  return upsertExternalMappingReview(
    {
      catalogSourceId: input.catalogSourceId,
      dimension: 'attribute',
      externalKey: input.sourceField,
      reason: 'legacy_disagreement',
      priority: reviewPriority('legacy_disagreement'),
      summary:
        `This source's legacy registry entry says '${input.legacyAttributeKey}' while the ` +
        `governed mapping says '${input.governedAttributeKey}'.`,
      observedAt: input.at,
    },
    db,
  );
}

/**
 * Settle a review by naming the mapping that answers it.
 *
 * The mapping must be APPROVED. Letting a proposal close a review would mean the
 * queue reports a token as settled while it still does not resolve — which is
 * the one thing a review queue must never do, because the row disappearing is
 * how anybody knows the work was finished.
 */
export async function resolveReview(
  input: {
    readonly id: string;
    readonly mappingId: string;
    readonly actorOxyUserId: string;
    readonly at: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingReviewRow> {
  const mapping = await findExternalMapping(input.mappingId, db);
  if (mapping === null) throw validationError('No such mapping.');
  if (mapping.state !== 'approved') {
    throw conflict('A review is settled by an APPROVED mapping, not by a proposal.');
  }
  const row = await settleExternalMappingReview(
    {
      id: input.id,
      state: 'resolved',
      actorOxyUserId: input.actorOxyUserId,
      at: input.at,
      resolvedMappingId: input.mappingId,
    },
    db,
  );
  if (row === null) throw conflict('That review is no longer open.');
  return row;
}

/**
 * Close a review without mapping anything.
 *
 * A real outcome and NOT a resolution: "this source publishes a field we do not
 * model and never will" is a different fact from "here is what it maps to", and
 * collapsing them would make the queue's throughput indistinguishable from its
 * abandonment rate.
 */
export async function dismissReview(
  input: { readonly id: string; readonly actorOxyUserId: string; readonly at: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingReviewRow> {
  const row = await settleExternalMappingReview(
    { id: input.id, state: 'dismissed', actorOxyUserId: input.actorOxyUserId, at: input.at },
    db,
  );
  if (row === null) throw conflict('That review is no longer open.');
  return row;
}

/** The open queue for a source, worst first. */
export async function listOpenReviews(
  input: {
    readonly catalogSourceId: string;
    readonly dimension?: CatalogExternalMappingDimension;
    readonly limit?: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogExternalReviewView[]> {
  const rows = await readOpenExternalMappingReviews(
    {
      catalogSourceId: input.catalogSourceId,
      ...(input.dimension === undefined ? {} : { dimension: input.dimension }),
      limit: Math.min(Math.max(input.limit ?? 50, 1), 200),
    },
    db,
  );
  return rows.map(toReviewView);
}

/**
 * The projection names every field explicitly.
 *
 * The `provider_accounts` device (#46): a `select()` of the row followed by a
 * spread would put `source_record_id` and every future column into an operator
 * response the moment somebody adds one.
 */
export function toReviewView(row: ExternalMappingReviewRow): CatalogExternalReviewView {
  return {
    id: row.id,
    catalogSourceId: row.catalogSourceId,
    dimension: row.dimension,
    externalKey: row.externalKey,
    ...(row.externalLabel === null ? {} : { externalLabel: row.externalLabel }),
    externalPath: row.externalPath,
    ...(row.observedRawValue === null ? {} : { observedRawValue: row.observedRawValue }),
    reason: row.reason,
    state: row.state,
    priority: row.priority,
    occurrences: row.occurrences,
    firstObservedAt: row.firstObservedAt.toISOString(),
    lastObservedAt: row.lastObservedAt.toISOString(),
    candidateMappingIds: row.candidateMappingIds,
    summary: row.summary,
  };
}
