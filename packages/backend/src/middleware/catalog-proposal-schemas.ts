/**
 * Request schemas for catalog proposals (#367 step 6, ADR 0007 D9).
 *
 * Every object is `.strict()`, so an undeclared key is REFUSED rather than
 * stripped — #63's ruling, and it matters more here than almost anywhere else:
 * the whole domain rests on a submitter being unable to supply identity, and a
 * schema that silently dropped a `key` would make that a property of zod's
 * default rather than a property of the contract.
 *
 * ## The forbidden-field refusal names the FIELD
 *
 * `CATALOG_PROPOSAL_FORBIDDEN_SUBMITTER_FIELDS` lists fourteen things a
 * submitter may never send, and `refuseForbiddenSubmitterFields` is mounted
 * BEFORE `.strict()` so a body carrying `key` is answered "a proposal cannot
 * carry `key`" rather than "unrecognized key". That is the `forbidden-evidence`
 * device from #121, and its point is that the second message tells a merchant to
 * try a different spelling while the first tells them the truth.
 *
 * ## What no schema here can carry
 *
 * - A `key` or a `slug`. ADR 0007 D1 makes both identity; the operator mints the
 *   key at approval, on a route only an operator can reach.
 * - A `state`, a `resolvedEntityId`, a `confidence` or a `verified`. Every one is
 *   a decision, and a submission is a request.
 * - An `attributeDefinitionVersion`. It is DERIVED from the definition the
 *   submitter names — a supplied version could cite one whose controlled-value
 *   set is not the set they were shown.
 */

import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  CATALOG_PROPOSAL_FORBIDDEN_SUBMITTER_FIELDS,
  CATALOG_PROPOSAL_REJECTION_REASONS,
  CATALOG_PROPOSAL_STATES,
  CATALOG_PROPOSAL_TYPES,
} from '@mercaria/shared-types';
import { ErrorCodes, sendError } from '../utils/api-response.js';

/** A shared-types list as the non-empty tuple `z.enum` requires. */
function tuple<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('An empty enum accepts nothing and types every value never');
  }
  return [first, ...rest];
}

const entityId = z.string().trim().min(1).max(64);

/**
 * A LABEL, and the length bound is not decoration.
 *
 * 200 characters is long enough for every real concept name in the catalogue and
 * short enough that a proposal cannot become a place to store a paragraph — the
 * `submitterNote` is where a submitter explains themselves, and keeping the two
 * apart is what stops a label that is really a sentence becoming a controlled
 * value's label on approval.
 */
const proposedLabel = z.string().trim().min(1).max(200);

/** The stored form the localization family uses. Folded, never a display tag. */
const locale = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/u, 'a BCP 47 language tag');

/**
 * Refuse a body carrying anything from
 * `CATALOG_PROPOSAL_FORBIDDEN_SUBMITTER_FIELDS`, by NAME.
 *
 * Mounted before the `.strict()` schema, which would otherwise answer
 * "unrecognized key" — a message that reads as a typo and sends an integrator
 * looking for the right spelling of a field that must never exist. A test pins
 * this by MESSAGE, because the whole value of the middleware is the sentence.
 */
export function refuseForbiddenSubmitterFields(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const body: unknown = req.body;
  if (body === null || typeof body !== 'object') {
    next();
    return;
  }
  const keys = Object.keys(body as Record<string, unknown>);
  const offending = CATALOG_PROPOSAL_FORBIDDEN_SUBMITTER_FIELDS.filter((field) =>
    keys.includes(field),
  );
  if (offending.length > 0) {
    sendError(
      res,
      ErrorCodes.VALIDATION_ERROR,
      `A proposal cannot carry ${offending.map((field) => `\`${field}\``).join(', ')}: ` +
        'a proposal names a label and never an identity, a decision or a score.',
      400,
    );
    return;
  }
  next();
}

/** `POST /catalog-proposals` — the submission. */
export const submitCatalogProposalSchema = z
  .object({
    type: z.enum(tuple(CATALOG_PROPOSAL_TYPES)),
    storeId: entityId,
    proposedLabel,
    sourceLocale: locale,
    proposedDescription: z.string().trim().max(2000).optional(),
    submitterNote: z.string().trim().max(2000).optional(),
    categoryId: entityId.optional(),
    productTypeDefinitionId: entityId.optional(),
    attributeDefinitionId: entityId.optional(),
    draftId: entityId.optional(),
    draftValueId: entityId.optional(),
  })
  .strict();

/** `POST /catalog-proposals/duplicates` — the pre-submission scan. */
export const previewCatalogProposalDuplicatesSchema = z
  .object({
    type: z.enum(tuple(CATALOG_PROPOSAL_TYPES)),
    storeId: entityId,
    proposedLabel,
    categoryId: entityId.optional(),
    productTypeDefinitionId: entityId.optional(),
    attributeDefinitionId: entityId.optional(),
  })
  .strict();

/** `GET /catalog-proposals?storeId=` — a store's own feed. */
export const listCatalogProposalsQuerySchema = z
  .object({
    storeId: entityId,
    state: z.enum(tuple(CATALOG_PROPOSAL_STATES)).optional(),
    type: z.enum(tuple(CATALOG_PROPOSAL_TYPES)).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/** `POST /catalog-proposals/:proposalId/withdraw`. */
export const withdrawCatalogProposalSchema = z
  .object({
    storeId: entityId,
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

/** `POST /catalog-proposals/:proposalId/information`. */
export const supplyCatalogProposalInformationSchema = z
  .object({
    storeId: entityId,
    response: z.string().trim().min(1).max(2000),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* The operator surface                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A stable machine key (ADR 0007 D1), minted by the OPERATOR.
 *
 * The same shape `attribute_enum_values_normalized_check` holds, stated here so
 * a key this surface accepts and a key the database stores cannot diverge, and
 * so the refusal names the rule rather than surfacing a 23514 the surface cannot
 * attribute.
 */
const machineKey = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9][a-z0-9_.-]*$/u,
    'a stable machine key (ADR 0007 D1) — lower-case letters, digits, `_`, `.` and `-`',
  );

/**
 * Every operator action carries a REASON and it is required.
 *
 * `catalog_proposals_decision_audit_check` refuses a decision with an empty one,
 * so an optional field here would surface as a 23514 on the row rather than as a
 * message naming the rule. A decision nobody explained is a decision nobody can
 * review.
 */
const decisionReason = z.string().trim().min(1).max(2000);

/** `POST /internal/catalog-proposals/:proposalId/approve`. */
export const approveCatalogProposalSchema = z
  .object({
    key: machineKey,
    label: z.string().trim().min(1).max(200).optional(),
    recordSubmittedSpellingAsAlias: z.boolean().optional(),
    reason: decisionReason,
  })
  .strict();

/** `POST /internal/catalog-proposals/:proposalId/merge`. */
export const mergeCatalogProposalSchema = z
  .object({
    resolvedEntityId: entityId,
    reason: decisionReason,
  })
  .strict();

/** `POST /internal/catalog-proposals/:proposalId/reject`. */
export const rejectCatalogProposalSchema = z
  .object({
    rejectionReason: z.enum(tuple(CATALOG_PROPOSAL_REJECTION_REASONS)),
    reason: decisionReason,
  })
  .strict();

/** `POST /internal/catalog-proposals/:proposalId/request-information`. */
export const requestCatalogProposalInformationSchema = z
  .object({ reason: decisionReason })
  .strict();

/** `POST /internal/catalog-proposals/:proposalId/defer`. */
export const deferCatalogProposalSchema = z
  .object({
    until: z.string().datetime(),
    reason: decisionReason,
  })
  .strict();

/** `POST /internal/catalog-proposals/:proposalId/redirect`. */
export const redirectCatalogProposalSchema = z
  .object({
    toType: z.enum(tuple(CATALOG_PROPOSAL_TYPES)),
    attributeDefinitionId: entityId.optional(),
    attributeDefinitionVersion: z.coerce.number().int().min(1).optional(),
    reason: decisionReason,
  })
  .strict();

/** `POST /internal/catalog-proposals/:proposalId/backfill`. */
export const backfillCatalogProposalSchema = z
  .object({ pageSize: z.coerce.number().int().min(1).max(1000).optional() })
  .strict();

/** `GET /internal/catalog-proposals` — the review queue. */
export const listCatalogProposalQueueSchema = z
  .object({
    state: z.enum(tuple(CATALOG_PROPOSAL_STATES)).optional(),
    type: z.enum(tuple(CATALOG_PROPOSAL_TYPES)).optional(),
    storeId: entityId.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();
