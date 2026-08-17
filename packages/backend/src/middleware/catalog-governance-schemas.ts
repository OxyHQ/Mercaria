/**
 * Request schemas for the catalog governance surface (#367 Workstream 12).
 *
 * Every schema is `.strict()`, and every value tuple is imported from
 * `@mercaria/shared-types` rather than retyped — the same tuple the column's
 * CHECK is rendered from, so a schema and a constraint cannot disagree about
 * what a legal value is.
 *
 * `reason` is required on every mutating schema and is bounded at both ends. A
 * governance act with no stated reason is not one, and the CHECK on the row
 * says so too; requiring it here is what turns a constraint violation into a
 * 400 that names the field.
 */

import { z } from 'zod';
import {
  CATALOG_GOVERNANCE_ACTIONS,
  CATALOG_GOVERNANCE_CHANGE_STATES,
  CATALOG_GOVERNANCE_DOMAINS,
  CATALOG_GOVERNANCE_ROLES,
  CATALOG_GOVERNANCE_SNAPSHOT_SCOPES,
  CATALOG_GOVERNANCE_SUBJECT_KINDS,
  COMPATIBILITY_CLAIM_STATES,
  LOCALIZATION_STATUSES,
  SUPPORTED_LOCALES,
} from '@mercaria/shared-types';

/** `z.enum` wants a non-empty tuple; the shared constants are readonly arrays. */
function tuple<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  return values as unknown as readonly [T, ...T[]];
}

/**
 * A stated reason.
 *
 * The upper bound is not tidiness — `parameters`, `reason` and the audit
 * `before`/`after` all reach a jsonb or text column with no length limit of its
 * own, and an unbounded operator field is the one place a request body can
 * become a storage problem.
 */
const reason = z.string().trim().min(3).max(2000);

/** An opaque id. Bounded rather than uuid-shaped: pre-cutover ids are ObjectId hex. */
const id = z.string().trim().min(1).max(64);

const pagination = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

/**
 * A change request's own parameters.
 *
 * `z.unknown()` values under a bounded record rather than a per-action union:
 * the seventeen actions take genuinely different parameters, `apply.ts` reads
 * each one by name and refuses a missing or malformed value with a message
 * naming the action AND the key, and a seventeen-branch discriminated schema
 * here would be a second statement of the same requirement that goes stale the
 * first time a driver's parameter is renamed.
 *
 * What IS enforced here is the shape: a flat object, at most twenty keys, so a
 * caller cannot post a nested document into the frozen snapshot column.
 */
const parameters = z
  .record(z.string().max(64), z.unknown())
  .refine((value) => Object.keys(value).length <= 20, {
    message: 'A change request takes at most twenty parameters.',
  })
  .default({});

/** `POST /internal/catalog-governance/changes` */
export const planChangeSchema = z
  .object({
    action: z.enum(tuple(CATALOG_GOVERNANCE_ACTIONS)),
    subjectId: id,
    parameters,
    reason,
  })
  .strict();

/** `POST .../changes/:changeId/{approve,reject,withdraw,apply}` */
export const decideChangeSchema = z.object({ reason }).strict();

/** `GET .../changes` */
export const changeQuerySchema = z
  .object({
    state: z.enum(tuple(CATALOG_GOVERNANCE_CHANGE_STATES)).optional(),
    domain: z.enum(tuple(CATALOG_GOVERNANCE_DOMAINS)).optional(),
    subjectKind: z.enum(tuple(CATALOG_GOVERNANCE_SUBJECT_KINDS)).optional(),
    subjectId: id.optional(),
    ...pagination,
  })
  .strict();

/** `GET .../impact` — the preview an operator reads BEFORE planning. */
export const impactQuerySchema = z
  .object({
    subjectKind: z.enum(tuple(CATALOG_GOVERNANCE_SUBJECT_KINDS)),
    subjectId: id,
  })
  .strict();

/** `GET .../audit` */
export const auditQuerySchema = z
  .object({
    subjectKind: z.enum(tuple(CATALOG_GOVERNANCE_SUBJECT_KINDS)).optional(),
    subjectId: id.optional(),
    domain: z.enum(tuple(CATALOG_GOVERNANCE_DOMAINS)).optional(),
    actorOxyUserId: id.optional(),
    changeRequestId: id.optional(),
    ...pagination,
  })
  .strict();

/** `GET .../diff/product-types/:key` and `.../diff/attributes/:key` */
export const diffQuerySchema = z
  .object({
    fromVersion: z.coerce.number().int().min(1),
    toVersion: z.coerce.number().int().min(1),
  })
  .strict();

/** `POST .../roles` */
export const grantRoleSchema = z
  .object({
    subjectOxyUserId: id,
    role: z.enum(tuple(CATALOG_GOVERNANCE_ROLES)),
    reason,
  })
  .strict();

/** `POST .../roles/revoke` — a POST rather than a DELETE, because it carries a reason. */
export const revokeRoleSchema = grantRoleSchema;

/** `GET .../roles` */
export const roleQuerySchema = z.object(pagination).strict();

/** `POST .../snapshots` */
export const exportSnapshotSchema = z
  .object({
    scope: z.enum(tuple(CATALOG_GOVERNANCE_SNAPSHOT_SCOPES)),
    reason,
  })
  .strict();

/** `GET .../snapshots` */
export const snapshotQuerySchema = z.object(pagination).strict();

/**
 * `POST .../snapshots/:snapshotId/restore`
 *
 * `apply` defaults to FALSE. A restore that defaulted to writing would be one
 * keystroke from a catalogue an operator did not intend, and the plan is the
 * thing they actually want first.
 */
export const restoreSnapshotSchema = z
  .object({
    apply: z.boolean().default(false),
    reason,
  })
  .strict();

/** `POST .../vertical-packages/:packageName` — same default, same reason. */
export const verticalPackageSchema = z
  .object({
    namespace: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]{0,32}$/u)
      .optional(),
    apply: z.boolean().default(false),
    reason,
  })
  .strict();

/** `GET .../vertical-packages/:packageName/census` */
export const verticalPackageCensusQuerySchema = z
  .object({
    namespace: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]{0,32}$/u),
  })
  .strict();

/** `POST .../reviews/localization` */
export const reviewLocalizationSchema = z
  .object({
    entity: z.enum(['category', 'product_type']),
    entityId: id,
    locale: z.enum(tuple(SUPPORTED_LOCALES)),
    status: z.enum(tuple(LOCALIZATION_STATUSES)),
    name: z.string().trim().min(1).max(512).optional(),
    description: z.string().trim().min(1).max(4000).optional(),
    reason,
  })
  .strict();

/** `POST .../reviews/external-mappings/:mappingId` */
export const reviewExternalMappingSchema = z
  .object({
    decision: z.enum(['approve', 'reject', 'fan_out_approve']),
    reason,
  })
  .strict();

/** `POST .../reviews/compatibility-claims/:claimId` */
export const reviewCompatibilityClaimSchema = z
  .object({
    state: z.enum(tuple(COMPATIBILITY_CLAIM_STATES)),
    reviewNote: z.string().trim().min(1).max(2000).nullable().default(null),
    reason,
  })
  .strict();

/** `GET .../quality/orphans` */
export const orphanQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(500).default(200) })
  .strict();
