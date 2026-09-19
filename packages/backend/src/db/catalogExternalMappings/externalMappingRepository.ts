/**
 * The ONLY writer of the five external-mapping tables (#367 Workstream 11).
 *
 * Every write here is a decision somebody made — proposing a mapping, approving
 * one, superseding one, opening or settling a review, opening a run, recording
 * what a run concluded — so each carries an actor or is explicitly an
 * observation, and none of them is reachable from a buyer-facing route.
 *
 * There is deliberately no `updateMapping`, no `setMappingTarget` and no
 * `deleteMapping`. A mapping's meaning is frozen once it leaves `proposed`
 * (a trigger refuses the update anyway) and nothing here is ever deleted (a
 * trigger refuses that too): a change is a NEW version, and the record of a
 * rejection is the most useful row in a mapping's history, because it is what
 * stops the same proposal coming back on every crawl.
 *
 * ## Normalization has ONE authority and it is Postgres
 *
 * Every lookup below compares the indexed `external_key_normalized` generated
 * column against `lower(btrim($1))`. The TypeScript mirror of that expression is
 * not the same function (see the note at the foot of
 * `services/catalog-external-mappings/target.ts`), and the failure mode of
 * getting it wrong is a silent miss that reads like "this source has never
 * published that value".
 */

import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  CatalogExternalMappingDimension,
  CatalogExternalMappingProvenance,
  CatalogExternalMappingState,
  CatalogExternalReprocessMode,
  CatalogExternalReprocessOutcome,
  CatalogExternalResolutionOutcome,
  CatalogExternalReviewReason,
  CatalogExternalSubjectKind,
  CatalogExternalTransformRule,
  CatalogExternalUnresolvedReason,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  catalogExternalMappingReviews,
  catalogExternalMappingRunItems,
  catalogExternalMappingRuns,
  catalogExternalMappings,
  catalogExternalTokenObservations,
} from '../schema/catalogExternalMappings.js';
import { attributeSourceMappings } from '../schema/attributeRegistry.js';
import type { TargetColumns } from '../../services/catalog-external-mappings/target.js';

/** `lower(btrim($1))` — the generated column's own expression, on the query side. */
function normalizedKeyExpression(externalKey: string) {
  return sql<string>`lower(btrim(${externalKey}))`;
}

const MAPPING_COLUMNS = {
  id: catalogExternalMappings.id,
  catalogSourceId: catalogExternalMappings.catalogSourceId,
  dimension: catalogExternalMappings.dimension,
  externalKey: catalogExternalMappings.externalKey,
  externalKeyNormalized: catalogExternalMappings.externalKeyNormalized,
  externalLabel: catalogExternalMappings.externalLabel,
  externalPath: catalogExternalMappings.externalPath,
  externalLocale: catalogExternalMappings.externalLocale,
  targetProductTypeKey: catalogExternalMappings.targetProductTypeKey,
  targetAttributeKey: catalogExternalMappings.targetAttributeKey,
  targetControlledValue: catalogExternalMappings.targetControlledValue,
  targetUnitFamily: catalogExternalMappings.targetUnitFamily,
  targetUnitCode: catalogExternalMappings.targetUnitCode,
  targetSizeSystemKey: catalogExternalMappings.targetSizeSystemKey,
  reviewedProductTypeDefinitionId: catalogExternalMappings.reviewedProductTypeDefinitionId,
  transformRule: catalogExternalMappings.transformRule,
  transformRuleVersion: catalogExternalMappings.transformRuleVersion,
  version: catalogExternalMappings.version,
  supersedesMappingId: catalogExternalMappings.supersedesMappingId,
  state: catalogExternalMappings.state,
  provenance: catalogExternalMappings.provenance,
  confidence: catalogExternalMappings.confidence,
  evidenceSourceRecordId: catalogExternalMappings.evidenceSourceRecordId,
  evidenceNote: catalogExternalMappings.evidenceNote,
  validFrom: catalogExternalMappings.validFrom,
  validTo: catalogExternalMappings.validTo,
  proposedByOxyUserId: catalogExternalMappings.proposedByOxyUserId,
  reviewedByOxyUserId: catalogExternalMappings.reviewedByOxyUserId,
  reviewedAt: catalogExternalMappings.reviewedAt,
  approvedByOxyUserId: catalogExternalMappings.approvedByOxyUserId,
  approvedAt: catalogExternalMappings.approvedAt,
  rejectedReason: catalogExternalMappings.rejectedReason,
  fanOutApprovedByOxyUserId: catalogExternalMappings.fanOutApprovedByOxyUserId,
  fanOutApprovedAt: catalogExternalMappings.fanOutApprovedAt,
  fanOutRationale: catalogExternalMappings.fanOutRationale,
  createdAt: catalogExternalMappings.createdAt,
} as const;

/** One mapping row, exactly as the domain reads it. */
export type ExternalMappingRow = {
  [K in keyof typeof MAPPING_COLUMNS]: (typeof MAPPING_COLUMNS)[K]['_']['data'];
};

export interface InsertExternalMappingInput extends TargetColumns {
  readonly catalogSourceId: string;
  readonly dimension: CatalogExternalMappingDimension;
  readonly externalKey: string;
  readonly externalLabel?: string;
  readonly externalPath?: readonly string[];
  readonly externalLocale?: string;
  readonly transformRule: CatalogExternalTransformRule;
  readonly transformRuleVersion: number;
  readonly version: number;
  readonly supersedesMappingId?: string;
  readonly provenance: CatalogExternalMappingProvenance;
  readonly confidence: number;
  readonly evidenceSourceRecordId?: string;
  readonly evidenceNote?: string;
  readonly validFrom: Date;
  readonly proposedByOxyUserId?: string;
  /** Provenance for a product-type mapping: which VERSION it was reviewed against. */
  readonly reviewedProductTypeDefinitionId?: string;
}

/**
 * Record a proposal. Always `proposed` — this repository offers no way to insert
 * a row that is already approved.
 *
 * That is not defensiveness: approval is a separate statement with a separate
 * actor, and an insert that could arrive pre-approved would let one call both
 * propose and approve, which is exactly what the fan-out's four-eyes CHECK is
 * priced to prevent one dimension over.
 */
export async function insertExternalMapping(
  input: InsertExternalMappingInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingRow> {
  const [row] = await db
    .insert(catalogExternalMappings)
    .values({
      catalogSourceId: input.catalogSourceId,
      dimension: input.dimension,
      externalKey: input.externalKey,
      externalLabel: input.externalLabel ?? null,
      externalPath: [...(input.externalPath ?? [])],
      externalLocale: input.externalLocale ?? null,
      targetProductTypeKey: input.targetProductTypeKey,
      targetAttributeKey: input.targetAttributeKey,
      targetControlledValue: input.targetControlledValue,
      targetUnitFamily: input.targetUnitFamily,
      targetUnitCode: input.targetUnitCode,
      targetSizeSystemKey: input.targetSizeSystemKey,
      reviewedProductTypeDefinitionId: input.reviewedProductTypeDefinitionId ?? null,
      transformRule: input.transformRule,
      transformRuleVersion: input.transformRuleVersion,
      version: input.version,
      supersedesMappingId: input.supersedesMappingId ?? null,
      state: 'proposed',
      provenance: input.provenance,
      confidence: input.confidence,
      evidenceSourceRecordId: input.evidenceSourceRecordId ?? null,
      evidenceNote: input.evidenceNote ?? null,
      validFrom: input.validFrom,
      proposedByOxyUserId: input.proposedByOxyUserId ?? null,
    })
    .returning(MAPPING_COLUMNS);
  if (row === undefined) throw new Error('insertExternalMapping returned no row');
  return row;
}

/** The highest version any decision about this token has reached. 0 when none has. */
export async function readHighestMappingVersion(
  catalogSourceId: string,
  dimension: CatalogExternalMappingDimension,
  externalKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ highest: sql<number | null>`max(${catalogExternalMappings.version})` })
    .from(catalogExternalMappings)
    .where(
      and(
        eq(catalogExternalMappings.catalogSourceId, catalogSourceId),
        eq(catalogExternalMappings.dimension, dimension),
        eq(catalogExternalMappings.externalKeyNormalized, normalizedKeyExpression(externalKey)),
      ),
    );
  return row?.highest ?? 0;
}

/**
 * Every mapping that RESOLVES for this token at this instant.
 *
 * `approved`, `valid_from <= at`, and either open-ended or not yet closed. The
 * partial unique guarantees at most one of these carries no fan-out approval, so
 * a result of two or more means somebody deliberately fanned the token out.
 */
export async function readLiveMappings(
  catalogSourceId: string,
  dimension: CatalogExternalMappingDimension,
  externalKey: string,
  at: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly ExternalMappingRow[]> {
  return db
    .select(MAPPING_COLUMNS)
    .from(catalogExternalMappings)
    .where(
      and(
        eq(catalogExternalMappings.catalogSourceId, catalogSourceId),
        eq(catalogExternalMappings.dimension, dimension),
        eq(catalogExternalMappings.externalKeyNormalized, normalizedKeyExpression(externalKey)),
        eq(catalogExternalMappings.state, 'approved'),
        lte(catalogExternalMappings.validFrom, at),
        or(
          isNull(catalogExternalMappings.validTo),
          // `gt`, never a `sql` template. A bare `Date` interpolated into a
          // template is NOT passed through the column's mapper, so postgres.js
          // is handed a `Date` object and throws `ERR_INVALID_ARG_TYPE` — while
          // the `lte(validFrom, at)` on the line above, over the same value,
          // binds correctly. So the statement failed on every call for every
          // dimension and the two halves of one window disagreed about how to
          // send one instant. Invisible until #367's size-system registry gave
          // the resolver its first real-server test: nothing calls
          // `resolveExternalToken` yet, and the existing realdb suite exercises
          // the schema rather than this read.
          gt(catalogExternalMappings.validTo, at),
        ),
      ),
    )
    .orderBy(asc(catalogExternalMappings.version));
}

/**
 * Every mapping of one DIMENSION that resolves for a source right now.
 *
 * The reconciliation report's other half. Computed as its own statement rather
 * than by walking the legacy table's field list, because the interesting
 * population is exactly the one that list does NOT name — deriving it from the
 * legacy fields would make the count structurally zero, which is a number that
 * looks like agreement and measures nothing.
 */
export async function readLiveMappingsForDimension(
  catalogSourceId: string,
  dimension: CatalogExternalMappingDimension,
  at: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly ExternalMappingRow[]> {
  return db
    .select(MAPPING_COLUMNS)
    .from(catalogExternalMappings)
    .where(
      and(
        eq(catalogExternalMappings.catalogSourceId, catalogSourceId),
        eq(catalogExternalMappings.dimension, dimension),
        eq(catalogExternalMappings.state, 'approved'),
        lte(catalogExternalMappings.validFrom, at),
        or(
          isNull(catalogExternalMappings.validTo),
          // `gt` rather than a `sql` template, for the reason spelled out in
          // `readLiveMappings` above: a bare `Date` in a template bypasses the
          // column mapper and the driver refuses it.
          gt(catalogExternalMappings.validTo, at),
        ),
      ),
    )
    .orderBy(asc(catalogExternalMappings.externalKeyNormalized), asc(catalogExternalMappings.version));
}

/**
 * Every mapping for this token in ANY state, newest decision first.
 *
 * The resolver needs it to tell `unmapped` (nobody has decided) from
 * `mapping_not_approved` (somebody has, and the answer was not yet yes) and
 * `mapping_expired` (it was yes and the window has closed). Those route to three
 * different next actions and collapsing them would send an operator to open a
 * review for a token that already has one.
 */
export async function readMappingHistory(
  catalogSourceId: string,
  dimension: CatalogExternalMappingDimension,
  externalKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly ExternalMappingRow[]> {
  return db
    .select(MAPPING_COLUMNS)
    .from(catalogExternalMappings)
    .where(
      and(
        eq(catalogExternalMappings.catalogSourceId, catalogSourceId),
        eq(catalogExternalMappings.dimension, dimension),
        eq(catalogExternalMappings.externalKeyNormalized, normalizedKeyExpression(externalKey)),
      ),
    )
    .orderBy(desc(catalogExternalMappings.version));
}

/** One mapping by id. */
export async function findExternalMapping(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingRow | null> {
  const [row] = await db
    .select(MAPPING_COLUMNS)
    .from(catalogExternalMappings)
    .where(eq(catalogExternalMappings.id, id));
  return row ?? null;
}

/** Several mappings by id, for a projection that already holds their ids. */
export async function readExternalMappingsByIds(
  ids: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly ExternalMappingRow[]> {
  if (ids.length === 0) return [];
  return db
    .select(MAPPING_COLUMNS)
    .from(catalogExternalMappings)
    .where(inArray(catalogExternalMappings.id, [...ids]));
}

/**
 * Move a mapping's state, and nothing else.
 *
 * A compare-and-swap on the state it is expected to be in, so two operators
 * acting on one proposal converge on one outcome instead of the second silently
 * overwriting the first's decision. The empty result IS the "somebody got there
 * first" answer — the moderation-outbox reading of a conditional UPDATE.
 *
 * The trigger enforces which moves are legal; this enforces that the caller knew
 * what it was moving FROM.
 */
export async function transitionExternalMapping(
  input: {
    readonly id: string;
    readonly expectedState: CatalogExternalMappingState;
    readonly nextState: CatalogExternalMappingState;
    readonly actorOxyUserId: string;
    readonly at: Date;
    readonly rejectedReason?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingRow | null> {
  const approving = input.nextState === 'approved';
  const rejecting = input.nextState === 'rejected';
  const [row] = await db
    .update(catalogExternalMappings)
    .set({
      state: input.nextState,
      reviewedByOxyUserId: input.actorOxyUserId,
      reviewedAt: input.at,
      ...(approving ? { approvedByOxyUserId: input.actorOxyUserId, approvedAt: input.at } : {}),
      ...(rejecting ? { rejectedReason: input.rejectedReason ?? null } : {}),
    })
    .where(
      and(
        eq(catalogExternalMappings.id, input.id),
        eq(catalogExternalMappings.state, input.expectedState),
      ),
    )
    .returning(MAPPING_COLUMNS);
  return row ?? null;
}

/**
 * Record the SECOND operator's fan-out approval.
 *
 * Separate from {@link transitionExternalMapping} because it is a separate act
 * by a separate person — the CHECK requires `fan_out_approved_by <>
 * approved_by`, so a single call that did both could never satisfy it, and one
 * that took two actor ids as parameters would be a four-eyes rule one caller can
 * fill in twice.
 */
export async function approveExternalMappingFanOut(
  input: {
    readonly id: string;
    readonly approverOxyUserId: string;
    readonly rationale: string;
    readonly at: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingRow | null> {
  const [row] = await db
    .update(catalogExternalMappings)
    .set({
      fanOutApprovedByOxyUserId: input.approverOxyUserId,
      fanOutApprovedAt: input.at,
      fanOutRationale: input.rationale,
    })
    .where(
      and(
        eq(catalogExternalMappings.id, input.id),
        isNull(catalogExternalMappings.fanOutApprovedAt),
      ),
    )
    .returning(MAPPING_COLUMNS);
  return row ?? null;
}

/** Close a live mapping's validity window. NULL → a value, once; the trigger refuses a second move. */
export async function closeExternalMappingWindow(
  id: string,
  validTo: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingRow | null> {
  const [row] = await db
    .update(catalogExternalMappings)
    .set({ validTo, state: 'superseded' })
    .where(and(eq(catalogExternalMappings.id, id), isNull(catalogExternalMappings.validTo)))
    .returning(MAPPING_COLUMNS);
  return row ?? null;
}

// ─── Reviews ─────────────────────────────────────────────────────────────────

const REVIEW_COLUMNS = {
  id: catalogExternalMappingReviews.id,
  catalogSourceId: catalogExternalMappingReviews.catalogSourceId,
  dimension: catalogExternalMappingReviews.dimension,
  externalKey: catalogExternalMappingReviews.externalKey,
  externalLabel: catalogExternalMappingReviews.externalLabel,
  externalPath: catalogExternalMappingReviews.externalPath,
  observedRawValue: catalogExternalMappingReviews.observedRawValue,
  sourceRecordId: catalogExternalMappingReviews.sourceRecordId,
  reason: catalogExternalMappingReviews.reason,
  state: catalogExternalMappingReviews.state,
  priority: catalogExternalMappingReviews.priority,
  occurrences: catalogExternalMappingReviews.occurrences,
  firstObservedAt: catalogExternalMappingReviews.firstObservedAt,
  lastObservedAt: catalogExternalMappingReviews.lastObservedAt,
  candidateMappingIds: catalogExternalMappingReviews.candidateMappingIds,
  summary: catalogExternalMappingReviews.summary,
  resolvedMappingId: catalogExternalMappingReviews.resolvedMappingId,
  resolvedByOxyUserId: catalogExternalMappingReviews.resolvedByOxyUserId,
  resolvedAt: catalogExternalMappingReviews.resolvedAt,
} as const;

/** One review row, exactly as the domain reads it. */
export type ExternalMappingReviewRow = {
  [K in keyof typeof REVIEW_COLUMNS]: (typeof REVIEW_COLUMNS)[K]['_']['data'];
};

/**
 * Open a review, or count another sighting against the one already open.
 *
 * `ON CONFLICT DO UPDATE` on the partial unique over open rows. A read-then-write
 * would let two ingestion workers meeting the same unknown value a millisecond
 * apart open two rows, and a reviewer would settle one of them — #94's
 * `attribute_value_reviews` decision, for the same reason.
 *
 * Both partial-unique predicate columns are repeated in `.onConflictDoUpdate`'s
 * `targetWhere`: Postgres refuses to infer a PARTIAL index as an arbiter without
 * its predicate, and the failure is a 500 at runtime rather than a compile error
 * (measured on `carts` in #104).
 *
 * `occurrences` is incremented IN SQL and `last_observed_at` takes the later of
 * the two instants, so an out-of-order delivery cannot walk the clock backwards.
 */
export async function upsertExternalMappingReview(
  input: {
    readonly catalogSourceId: string;
    readonly dimension: CatalogExternalMappingDimension;
    readonly externalKey: string;
    readonly externalLabel?: string;
    readonly externalPath?: readonly string[];
    readonly observedRawValue?: string;
    readonly sourceRecordId?: string;
    readonly reason: CatalogExternalReviewReason;
    readonly priority: number;
    readonly summary: string;
    readonly candidateMappingIds?: readonly string[];
    readonly observedAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingReviewRow> {
  const [row] = await db
    .insert(catalogExternalMappingReviews)
    .values({
      catalogSourceId: input.catalogSourceId,
      dimension: input.dimension,
      externalKey: input.externalKey,
      externalLabel: input.externalLabel ?? null,
      externalPath: [...(input.externalPath ?? [])],
      observedRawValue: input.observedRawValue ?? null,
      sourceRecordId: input.sourceRecordId ?? null,
      reason: input.reason,
      state: 'open',
      priority: input.priority,
      occurrences: 1,
      firstObservedAt: input.observedAt,
      lastObservedAt: input.observedAt,
      candidateMappingIds: [...(input.candidateMappingIds ?? [])],
      summary: input.summary,
    })
    .onConflictDoUpdate({
      target: [
        catalogExternalMappingReviews.catalogSourceId,
        catalogExternalMappingReviews.dimension,
        catalogExternalMappingReviews.externalKeyNormalized,
      ],
      targetWhere: sql`${catalogExternalMappingReviews.state} = 'open'`,
      set: {
        occurrences: sql`${catalogExternalMappingReviews.occurrences} + 1`,
        lastObservedAt: sql`greatest(${catalogExternalMappingReviews.lastObservedAt}, ${input.observedAt})`,
        priority: sql`greatest(${catalogExternalMappingReviews.priority}, ${input.priority})`,
      },
    })
    .returning(REVIEW_COLUMNS);
  if (row === undefined) throw new Error('upsertExternalMappingReview returned no row');
  return row;
}

/** Settle a review. `resolved` cites the mapping that answers it; `dismissed` cites none. */
export async function settleExternalMappingReview(
  input: {
    readonly id: string;
    readonly state: 'resolved' | 'dismissed';
    readonly actorOxyUserId: string;
    readonly at: Date;
    readonly resolvedMappingId?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingReviewRow | null> {
  const [row] = await db
    .update(catalogExternalMappingReviews)
    .set({
      state: input.state,
      resolvedByOxyUserId: input.actorOxyUserId,
      resolvedAt: input.at,
      resolvedMappingId: input.state === 'resolved' ? (input.resolvedMappingId ?? null) : null,
    })
    .where(
      and(
        eq(catalogExternalMappingReviews.id, input.id),
        eq(catalogExternalMappingReviews.state, 'open'),
      ),
    )
    .returning(REVIEW_COLUMNS);
  return row ?? null;
}

/** The open queue for a source, worst first. */
export async function readOpenExternalMappingReviews(
  input: {
    readonly catalogSourceId: string;
    readonly dimension?: CatalogExternalMappingDimension;
    readonly limit: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly ExternalMappingReviewRow[]> {
  return db
    .select(REVIEW_COLUMNS)
    .from(catalogExternalMappingReviews)
    .where(
      and(
        eq(catalogExternalMappingReviews.catalogSourceId, input.catalogSourceId),
        eq(catalogExternalMappingReviews.state, 'open'),
        ...(input.dimension === undefined
          ? []
          : [eq(catalogExternalMappingReviews.dimension, input.dimension)]),
      ),
    )
    .orderBy(
      desc(catalogExternalMappingReviews.priority),
      desc(catalogExternalMappingReviews.occurrences),
    )
    .limit(input.limit);
}

/** How many open reviews this exact token has. The preview's `openReviewsAnswered`. */
export async function countOpenReviewsForToken(
  catalogSourceId: string,
  dimension: CatalogExternalMappingDimension,
  externalKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(catalogExternalMappingReviews)
    .where(
      and(
        eq(catalogExternalMappingReviews.catalogSourceId, catalogSourceId),
        eq(catalogExternalMappingReviews.dimension, dimension),
        eq(
          catalogExternalMappingReviews.externalKeyNormalized,
          normalizedKeyExpression(externalKey),
        ),
        eq(catalogExternalMappingReviews.state, 'open'),
      ),
    );
  return row?.total ?? 0;
}

// ─── Observations ────────────────────────────────────────────────────────────

const OBSERVATION_COLUMNS = {
  id: catalogExternalTokenObservations.id,
  catalogSourceId: catalogExternalTokenObservations.catalogSourceId,
  dimension: catalogExternalTokenObservations.dimension,
  externalKey: catalogExternalTokenObservations.externalKey,
  externalKeyNormalized: catalogExternalTokenObservations.externalKeyNormalized,
  subjectKind: catalogExternalTokenObservations.subjectKind,
  subjectKey: catalogExternalTokenObservations.subjectKey,
  observedRawValue: catalogExternalTokenObservations.observedRawValue,
  resolvedMappingId: catalogExternalTokenObservations.resolvedMappingId,
  resolutionOutcome: catalogExternalTokenObservations.resolutionOutcome,
  unresolvedReason: catalogExternalTokenObservations.unresolvedReason,
  firstObservedAt: catalogExternalTokenObservations.firstObservedAt,
  lastObservedAt: catalogExternalTokenObservations.lastObservedAt,
  occurrences: catalogExternalTokenObservations.occurrences,
  reprocessRequestedAt: catalogExternalTokenObservations.reprocessRequestedAt,
  reprocessedAt: catalogExternalTokenObservations.reprocessedAt,
} as const;

/** One observation row, exactly as the domain reads it. */
export type ExternalTokenObservationRow = {
  [K in keyof typeof OBSERVATION_COLUMNS]: (typeof OBSERVATION_COLUMNS)[K]['_']['data'];
};

/**
 * Record that a subject carried a token, and what it resolved to.
 *
 * `ON CONFLICT DO UPDATE` on `(source, dimension, normalized key, subject kind,
 * subject key)`. That key is what makes a re-delivery converge instead of
 * multiplying the impact figures — an ingestion pass that re-reads the same
 * catalogue every hour must not make one token look like a thousand.
 *
 * The resolution is OVERWRITTEN on each observation rather than appended,
 * because this table answers "what does this token resolve to now"; the history
 * of what it used to resolve to lives in the mapping versions, which are
 * immutable.
 */
export async function recordExternalTokenObservation(
  input: {
    readonly catalogSourceId: string;
    readonly dimension: CatalogExternalMappingDimension;
    readonly externalKey: string;
    readonly subjectKind: CatalogExternalSubjectKind;
    readonly subjectKey: string;
    readonly observedRawValue?: string;
    readonly resolvedMappingId: string | null;
    readonly resolutionOutcome: CatalogExternalResolutionOutcome;
    readonly unresolvedReason: CatalogExternalUnresolvedReason | null;
    readonly observedAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalTokenObservationRow> {
  const [row] = await db
    .insert(catalogExternalTokenObservations)
    .values({
      catalogSourceId: input.catalogSourceId,
      dimension: input.dimension,
      externalKey: input.externalKey,
      subjectKind: input.subjectKind,
      subjectKey: input.subjectKey,
      observedRawValue: input.observedRawValue ?? null,
      resolvedMappingId: input.resolvedMappingId,
      resolutionOutcome: input.resolutionOutcome,
      unresolvedReason: input.unresolvedReason,
      firstObservedAt: input.observedAt,
      lastObservedAt: input.observedAt,
      occurrences: 1,
    })
    .onConflictDoUpdate({
      target: [
        catalogExternalTokenObservations.catalogSourceId,
        catalogExternalTokenObservations.dimension,
        catalogExternalTokenObservations.externalKeyNormalized,
        catalogExternalTokenObservations.subjectKind,
        catalogExternalTokenObservations.subjectKey,
      ],
      set: {
        resolvedMappingId: input.resolvedMappingId,
        resolutionOutcome: input.resolutionOutcome,
        unresolvedReason: input.unresolvedReason,
        observedRawValue: input.observedRawValue ?? null,
        occurrences: sql`${catalogExternalTokenObservations.occurrences} + 1`,
        lastObservedAt: sql`greatest(${catalogExternalTokenObservations.lastObservedAt}, ${input.observedAt})`,
      },
    })
    .returning(OBSERVATION_COLUMNS);
  if (row === undefined) throw new Error('recordExternalTokenObservation returned no row');
  return row;
}

/** How the observations of one token currently resolve. The preview's exact counts. */
export interface TokenObservationTally {
  readonly total: number;
  readonly resolvedElsewhere: number;
  readonly unresolved: number;
}

/**
 * Count the observations of one token, split by how they resolve TODAY relative
 * to a candidate target.
 *
 * Counted in SQL rather than by loading the rows: a popular token has as many
 * observation rows as the source has objects, and a preview must not be the most
 * expensive statement in the domain.
 */
export async function tallyTokenObservations(
  input: {
    readonly catalogSourceId: string;
    readonly dimension: CatalogExternalMappingDimension;
    readonly externalKey: string;
    /** Mappings whose target equals the candidate's. Observations on these are unchanged. */
    readonly equivalentMappingIds: readonly string[];
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<TokenObservationTally> {
  const equivalent = input.equivalentMappingIds;
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unresolved: sql<number>`count(*) filter (where ${catalogExternalTokenObservations.resolutionOutcome} = 'unresolved')::int`,
      resolvedElsewhere: sql<number>`count(*) filter (
        where ${catalogExternalTokenObservations.resolutionOutcome} = 'resolved'
          and ${
            equivalent.length === 0
              ? sql`true`
              : sql`${catalogExternalTokenObservations.resolvedMappingId} <> all(${sql.param(equivalent)}::text[])`
          }
      )::int`,
    })
    .from(catalogExternalTokenObservations)
    .where(
      and(
        eq(catalogExternalTokenObservations.catalogSourceId, input.catalogSourceId),
        eq(catalogExternalTokenObservations.dimension, input.dimension),
        eq(
          catalogExternalTokenObservations.externalKeyNormalized,
          normalizedKeyExpression(input.externalKey),
        ),
      ),
    );
  return {
    total: row?.total ?? 0,
    unresolved: row?.unresolved ?? 0,
    resolvedElsewhere: row?.resolvedElsewhere ?? 0,
  };
}

/**
 * Whether this domain has EVER recorded an observation for a source and
 * dimension.
 *
 * The preview's `coverage` reads it, and the distinction it draws is the whole
 * reason it exists: no observations means the impact is UNKNOWN, not zero. A
 * preview that printed `0` there would be a confident number computed off
 * nothing — #82's `unmeasured`, applied to an impact estimate.
 */
export async function hasRecordedObservations(
  catalogSourceId: string,
  dimension: CatalogExternalMappingDimension,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ present: sql<number>`1` })
    .from(catalogExternalTokenObservations)
    .where(
      and(
        eq(catalogExternalTokenObservations.catalogSourceId, catalogSourceId),
        eq(catalogExternalTokenObservations.dimension, dimension),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * One page of a source's observations, ordered by the key a run resumes from.
 *
 * The keyset is the normalized external key plus the subject key, which together
 * are unique within a source and dimension — so a resumed run cannot re-read a
 * page or skip one.
 */
export async function readObservationPage(
  input: {
    readonly catalogSourceId: string;
    readonly dimension?: CatalogExternalMappingDimension;
    readonly afterExternalKey: string | null;
    readonly limit: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly ExternalTokenObservationRow[]> {
  return db
    .select(OBSERVATION_COLUMNS)
    .from(catalogExternalTokenObservations)
    .where(
      and(
        eq(catalogExternalTokenObservations.catalogSourceId, input.catalogSourceId),
        ...(input.dimension === undefined
          ? []
          : [eq(catalogExternalTokenObservations.dimension, input.dimension)]),
        ...(input.afterExternalKey === null
          ? []
          : [
              sql`(${catalogExternalTokenObservations.externalKeyNormalized}, ${catalogExternalTokenObservations.subjectKey}) > (${input.afterExternalKey}, '')`,
            ]),
      ),
    )
    .orderBy(
      asc(catalogExternalTokenObservations.externalKeyNormalized),
      asc(catalogExternalTokenObservations.subjectKey),
    )
    .limit(input.limit);
}

/**
 * Apply a re-resolution to one observation and stamp it for reprocessing.
 *
 * The stamp is what makes the change reprocessable downstream: the row IS the
 * job (#48's `payment_provider_events` decision), so there is no second outbox
 * row that could disagree with it. Nothing drains the queue today — a gated
 * LOOP, never a gated record.
 */
export async function applyObservationResolution(
  input: {
    readonly id: string;
    readonly resolvedMappingId: string | null;
    readonly resolutionOutcome: CatalogExternalResolutionOutcome;
    readonly unresolvedReason: CatalogExternalUnresolvedReason | null;
    readonly requestReprocessAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(catalogExternalTokenObservations)
    .set({
      resolvedMappingId: input.resolvedMappingId,
      resolutionOutcome: input.resolutionOutcome,
      unresolvedReason: input.unresolvedReason,
      reprocessRequestedAt: input.requestReprocessAt,
      reprocessedAt: null,
    })
    .where(eq(catalogExternalTokenObservations.id, input.id));
}

// ─── Runs ────────────────────────────────────────────────────────────────────

const RUN_COLUMNS = {
  id: catalogExternalMappingRuns.id,
  catalogSourceId: catalogExternalMappingRuns.catalogSourceId,
  dimension: catalogExternalMappingRuns.dimension,
  mappingId: catalogExternalMappingRuns.mappingId,
  mappingVersion: catalogExternalMappingRuns.mappingVersion,
  mode: catalogExternalMappingRuns.mode,
  state: catalogExternalMappingRuns.state,
  requestedByOxyUserId: catalogExternalMappingRuns.requestedByOxyUserId,
  cursorExternalKey: catalogExternalMappingRuns.cursorExternalKey,
  scanned: catalogExternalMappingRuns.scanned,
  unchanged: catalogExternalMappingRuns.unchanged,
  retargeted: catalogExternalMappingRuns.retargeted,
  newlyMapped: catalogExternalMappingRuns.newlyMapped,
  unmappedNow: catalogExternalMappingRuns.unmappedNow,
  refused: catalogExternalMappingRuns.refused,
  skipped: catalogExternalMappingRuns.skipped,
  startedAt: catalogExternalMappingRuns.startedAt,
  finishedAt: catalogExternalMappingRuns.finishedAt,
  lastError: catalogExternalMappingRuns.lastError,
} as const;

/** One run row, exactly as the domain reads it. */
export type ExternalMappingRunRow = {
  [K in keyof typeof RUN_COLUMNS]: (typeof RUN_COLUMNS)[K]['_']['data'];
};

/**
 * Open a run.
 *
 * The partial unique on `(source, mode) WHERE state in ('pending','running')`
 * makes a second live run of the same mode a database refusal rather than a
 * service comparison two requests can race past. `null` is that refusal.
 */
export async function openExternalMappingRun(
  input: {
    readonly catalogSourceId: string;
    readonly dimension?: CatalogExternalMappingDimension;
    readonly mappingId?: string;
    readonly mappingVersion?: number;
    readonly mode: CatalogExternalReprocessMode;
    readonly requestedByOxyUserId: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingRunRow | null> {
  const [row] = await db
    .insert(catalogExternalMappingRuns)
    .values({
      catalogSourceId: input.catalogSourceId,
      dimension: input.dimension ?? null,
      mappingId: input.mappingId ?? null,
      mappingVersion: input.mappingVersion ?? null,
      mode: input.mode,
      state: 'pending',
      requestedByOxyUserId: input.requestedByOxyUserId,
    })
    .onConflictDoNothing()
    .returning(RUN_COLUMNS);
  return row ?? null;
}

/** Advance a run's cursor and counters together, so the two cannot disagree. */
export async function advanceExternalMappingRun(
  input: {
    readonly id: string;
    readonly cursorExternalKey: string | null;
    readonly delta: Readonly<Record<CatalogExternalReprocessOutcome, number>>;
    readonly at: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingRunRow | null> {
  const scannedDelta =
    input.delta.unchanged +
    input.delta.retargeted +
    input.delta.newly_mapped +
    input.delta.unmapped_now +
    input.delta.refused +
    input.delta.skipped;
  const [row] = await db
    .update(catalogExternalMappingRuns)
    .set({
      state: 'running',
      startedAt: sql`coalesce(${catalogExternalMappingRuns.startedAt}, ${input.at})`,
      cursorExternalKey: input.cursorExternalKey,
      scanned: sql`${catalogExternalMappingRuns.scanned} + ${scannedDelta}`,
      unchanged: sql`${catalogExternalMappingRuns.unchanged} + ${input.delta.unchanged}`,
      retargeted: sql`${catalogExternalMappingRuns.retargeted} + ${input.delta.retargeted}`,
      newlyMapped: sql`${catalogExternalMappingRuns.newlyMapped} + ${input.delta.newly_mapped}`,
      unmappedNow: sql`${catalogExternalMappingRuns.unmappedNow} + ${input.delta.unmapped_now}`,
      refused: sql`${catalogExternalMappingRuns.refused} + ${input.delta.refused}`,
      skipped: sql`${catalogExternalMappingRuns.skipped} + ${input.delta.skipped}`,
    })
    .where(
      and(
        eq(catalogExternalMappingRuns.id, input.id),
        inArray(catalogExternalMappingRuns.state, ['pending', 'running']),
      ),
    )
    .returning(RUN_COLUMNS);
  return row ?? null;
}

/** Close a run. `failed` must name what failed — the CHECK refuses a silent one. */
export async function finishExternalMappingRun(
  input: {
    readonly id: string;
    readonly state: 'completed' | 'failed';
    readonly at: Date;
    readonly lastError?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingRunRow | null> {
  const [row] = await db
    .update(catalogExternalMappingRuns)
    .set({
      state: input.state,
      finishedAt: input.at,
      startedAt: sql`coalesce(${catalogExternalMappingRuns.startedAt}, ${input.at})`,
      lastError: input.lastError ?? null,
    })
    .where(
      and(
        eq(catalogExternalMappingRuns.id, input.id),
        inArray(catalogExternalMappingRuns.state, ['pending', 'running']),
      ),
    )
    .returning(RUN_COLUMNS);
  return row ?? null;
}

/** One run by id. */
export async function findExternalMappingRun(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingRunRow | null> {
  const [row] = await db
    .select(RUN_COLUMNS)
    .from(catalogExternalMappingRuns)
    .where(eq(catalogExternalMappingRuns.id, id));
  return row ?? null;
}

/**
 * Record what a run concluded about one subject.
 *
 * `ON CONFLICT DO NOTHING` on `(run_id, subject_key)`: that is what makes a run
 * RESUMABLE and IDEMPOTENT at once. A reclaimed run re-reads the page it was on,
 * writes nothing for the subjects already recorded, and the empty result is the
 * signal not to count them again. A `DO UPDATE` would let a resumed page double
 * the counters against the same subjects.
 */
export async function recordExternalMappingRunItem(
  input: {
    readonly runId: string;
    readonly subjectKind: CatalogExternalSubjectKind;
    readonly subjectKey: string;
    readonly externalKey: string;
    readonly outcome: CatalogExternalReprocessOutcome;
    readonly previousMappingId: string | null;
    readonly nextMappingId: string | null;
    readonly detail?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .insert(catalogExternalMappingRunItems)
    .values({
      runId: input.runId,
      subjectKind: input.subjectKind,
      subjectKey: input.subjectKey,
      externalKey: input.externalKey,
      outcome: input.outcome,
      previousMappingId: input.previousMappingId,
      nextMappingId: input.nextMappingId,
      detail: input.detail ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: catalogExternalMappingRunItems.id });
  return rows.length > 0;
}

/**
 * The counts taken from a run's ITEMS rather than from its own counters.
 *
 * #60's `scannedFromRecords` device: a counter that only ever agrees with itself
 * measures nothing, so the metrics surface reports both and whether they agree.
 */
export async function tallyRunItems(
  runId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Readonly<Record<CatalogExternalReprocessOutcome, number>> & { readonly total: number }> {
  const rows = await db
    .select({
      outcome: catalogExternalMappingRunItems.outcome,
      total: sql<number>`count(*)::int`,
    })
    .from(catalogExternalMappingRunItems)
    .where(eq(catalogExternalMappingRunItems.runId, runId))
    .groupBy(catalogExternalMappingRunItems.outcome);

  const tally = {
    unchanged: 0,
    retargeted: 0,
    newly_mapped: 0,
    unmapped_now: 0,
    refused: 0,
    skipped: 0,
    total: 0,
  };
  for (const row of rows) {
    tally[row.outcome] = row.total;
    tally.total += row.total;
  }
  return tally;
}

// ─── #94's registry, read as a LEGACY input and never written ────────────────

/** One `attribute_source_mappings` row, as this domain reads it. */
export interface LegacyAttributeMappingRow {
  readonly sourceField: string;
  readonly attributeKey: string;
  readonly assumedUnit: string | null;
}

/**
 * Read #94's `attribute_source_mappings` for one source.
 *
 * READ ONLY, and `external-mapping-isolation.test.ts` fails the build if any
 * module in this domain writes that table. It predates this layer and carries no
 * version, confidence, review state, provenance or validity window — so it
 * cannot BE the governed mapping — but a deployment that already configured it
 * must not have its fields silently un-mapped by adopting this domain. It is
 * therefore a lower-precedence input, surfaced under its own
 * `legacy_registry` origin, and a disagreement between the two is RECORDED as a
 * review rather than settled by a rule about which one wins.
 */
export async function readLegacyAttributeMappings(
  catalogSourceId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly LegacyAttributeMappingRow[]> {
  return db
    .select({
      sourceField: attributeSourceMappings.sourceField,
      attributeKey: attributeSourceMappings.attributeKey,
      assumedUnit: attributeSourceMappings.assumedUnit,
    })
    .from(attributeSourceMappings)
    .where(eq(attributeSourceMappings.catalogSourceId, catalogSourceId));
}

/** One legacy row for one field, when there is one. */
export async function findLegacyAttributeMapping(
  catalogSourceId: string,
  sourceField: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<LegacyAttributeMappingRow | null> {
  const [row] = await db
    .select({
      sourceField: attributeSourceMappings.sourceField,
      attributeKey: attributeSourceMappings.attributeKey,
      assumedUnit: attributeSourceMappings.assumedUnit,
    })
    .from(attributeSourceMappings)
    .where(
      and(
        eq(attributeSourceMappings.catalogSourceId, catalogSourceId),
        eq(attributeSourceMappings.sourceField, sql`lower(btrim(${sourceField}))`),
      ),
    );
  return row ?? null;
}
