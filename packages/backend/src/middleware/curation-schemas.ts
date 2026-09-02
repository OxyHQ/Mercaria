/**
 * Request schemas for `/internal/commerce-graph/*`'s curation half (#59).
 *
 * Every one is `.strict()`, so an unknown key is a 400 rather than an ignored
 * one — the `matching-schemas.ts` rule, for the same reason: a field a client
 * thinks it is sending and the server silently drops is the shape of a
 * correction that quietly did something else.
 *
 * ## What these schemas deliberately CANNOT carry
 *
 * No `status`, no `mergedIntoId`, no `phase`, no `appliedAt`, no impact figure.
 * A caller cannot post a job into a phase, cannot mark a conflict applied, and
 * cannot supply the impact its own four-eyes threshold is measured against —
 * those are all computed server-side from the graph, and
 * `curation-isolation.test.ts` fails the build if one of the field names appears
 * here. A route that can post a merge's end state is a route around every gate
 * between the request and it.
 *
 * A `reason` is required on every mutating schema. #59 security 2 asks for it,
 * and the CHECK on each table refuses an empty one — this is where the caller
 * gets a sentence instead of a constraint violation.
 */

import { z } from 'zod';
import {
  CATALOG_MERGE_CONFLICT_RESOLUTIONS,
  CATALOG_SPLIT_ITEM_TYPES,
  CATALOG_SPLIT_TARGET_MODES,
  CATALOG_SUPPRESSIBLE_TYPES,
  CATALOG_SUPPRESSION_REASONS,
  CURATION_RESOLUTIONS,
  CURATION_REVIEW_KINDS,
  CURATION_REVIEW_STATES,
  CURATION_SUBJECT_TYPES,
  MERGEABLE_ENTITY_TYPES,
  SPLITTABLE_ENTITY_TYPES,
} from '@mercaria/shared-types';
import { CURATION_MAX_TEXT_LENGTH } from '../db/schema/curation.js';

/** A tuple as a zod enum, so the wire vocabulary and the CHECK share one source. */
function enumOf<T extends string>(values: readonly T[]) {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('enumOf received an empty tuple');
  return z.enum([first, ...rest]);
}

const id = z.string().trim().min(1).max(64);
const reason = z.string().trim().min(1).max(CURATION_MAX_TEXT_LENGTH);
const note = z.string().trim().max(CURATION_MAX_TEXT_LENGTH);

export const reviewQueueQuerySchema = z
  .object({
    kind: enumOf(CURATION_REVIEW_KINDS).optional(),
    state: enumOf(CURATION_REVIEW_STATES).optional(),
    assignedToOxyUserId: id.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const raiseReviewItemSchema = z
  .object({
    kind: enumOf(CURATION_REVIEW_KINDS),
    subjectType: enumOf(CURATION_SUBJECT_TYPES),
    subjectId: id,
    counterpartType: enumOf(CURATION_SUBJECT_TYPES).optional(),
    counterpartId: id.optional(),
    note,
  })
  .strict()
  .refine(
    (value) => (value.counterpartType === undefined) === (value.counterpartId === undefined),
    { message: 'A counterpart is a type AND an id, or it is neither.' },
  );

export const resolveReviewItemSchema = z
  .object({
    resolution: enumOf(CURATION_RESOLUTIONS),
    reason,
  })
  .strict();

export const runDetectorsSchema = z
  .object({ limit: z.number().int().min(1).max(1_000).optional() })
  .strict();

export const mergePreviewQuerySchema = z
  .object({
    entityType: enumOf(MERGEABLE_ENTITY_TYPES),
    entityId: id,
  })
  .strict();

export const requestMergeSchema = z
  .object({
    entityType: enumOf(MERGEABLE_ENTITY_TYPES),
    loserId: id,
    winnerId: id,
    reason,
    reviewItemId: id.optional(),
  })
  .strict()
  .refine((value) => value.loserId !== value.winnerId, {
    message: 'A thing cannot be merged into itself.',
  });

export const approveJobSchema = z.object({ reason }).strict();

export const resolveConflictSchema = z
  .object({
    resolution: enumOf(CATALOG_MERGE_CONFLICT_RESOLUTIONS),
    reason,
  })
  .strict();

export const requestSplitSchema = z
  .object({
    entityType: enumOf(SPLITTABLE_ENTITY_TYPES),
    sourceEntityId: id,
    targetMode: enumOf(CATALOG_SPLIT_TARGET_MODES),
    targetEntityId: id.optional(),
    targetSlug: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'A slug is lowercase words joined by single hyphens.')
      .optional(),
    targetName: z.string().trim().min(1).max(300).optional(),
    reason,
    reversesMergeJobId: id.optional(),
    reviewItemId: id.optional(),
    items: z
      .array(
        z
          .object({ itemType: enumOf(CATALOG_SPLIT_ITEM_TYPES), itemRef: id })
          .strict(),
      )
      .min(1)
      .max(1_000),
  })
  .strict()
  .refine(
    (value) =>
      value.targetMode === 'new_entity'
        ? value.targetSlug !== undefined && value.targetName !== undefined
        : value.targetEntityId !== undefined,
    {
      message:
        'A new entity needs a slug and a name; a tombstone revival names the tombstone it brings back.',
    },
  );

export const reassignIdentifierSchema = z
  .object({
    targetProductId: id.optional(),
    targetVariantId: id.optional(),
    reason,
  })
  .strict()
  .refine((value) => (value.targetProductId === undefined) !== (value.targetVariantId === undefined), {
    message: 'Name a product OR a variant — an identifier belongs to exactly one grain.',
  });

export const selectAttributeValueSchema = z.object({ reason }).strict();

export const suppressEntitySchema = z
  .object({
    entityType: enumOf(CATALOG_SUPPRESSIBLE_TYPES),
    entityId: id,
    reason: enumOf(CATALOG_SUPPRESSION_REASONS),
    note: note.optional(),
  })
  .strict();

export const liftSuppressionSchema = z
  .object({
    entityType: enumOf(CATALOG_SUPPRESSIBLE_TYPES),
    entityId: id,
    reason,
  })
  .strict();

export const compensateRevisionSchema = z.object({ reason, note: note.optional() }).strict();

export const revisionQuerySchema = z
  .object({
    entityType: enumOf(CURATION_SUBJECT_TYPES),
    entityId: id,
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const drainCurationSchema = z
  .object({ batchSize: z.number().int().min(1).max(50).optional() })
  .strict();
