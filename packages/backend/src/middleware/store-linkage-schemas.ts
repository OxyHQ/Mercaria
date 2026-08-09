/**
 * Request schemas for the merchant → native store linkage surfaces (#84).
 *
 * Its own file, following `commerce-graph-schemas.ts` and `payments-schemas.ts`.
 * Every body is `.strict()`, and here that is doing real work rather than
 * following a habit: **`.strict()` is the third of the four walls behind "no
 * name-only automatic linkage"**. There is no `storeName`, `merchantName`,
 * `similarity`, `threshold`, `matchScore` or `autoLink` field in any schema
 * below — so a name cannot reach a linkage decision even from a hand-written
 * HTTP request, and adding a field through which one could is an edit to this
 * file that a reviewer will see.
 *
 * (The other three walls: `STORE_LINKAGE_CANDIDATE_SOURCES` has no `name_match`
 * member, the four tables have no name or score column, and
 * `linkage-candidates.ts` takes no name as a parameter.)
 *
 * Value tuples come from `@mercaria/shared-types`, never retyped — a hand-copied
 * list here could accept a value the database CHECK then refuses.
 */

import { z } from 'zod';
import {
  STORE_LINKAGE_PROFILE_FIELDS,
  type StoreLinkageProfileField,
} from '@mercaria/shared-types';

const PROFILE_FIELD_VALUES = STORE_LINKAGE_PROFILE_FIELDS as readonly [
  StoreLinkageProfileField,
  ...StoreLinkageProfileField[],
];

/** An entity id. Shape only — the service and the foreign keys do the rest. */
const entityId = z.string().trim().min(1).max(64);

/**
 * A reason, on every state-changing request.
 *
 * A ten-character floor rather than a non-empty one: `reason` is an audit field
 * that a person reads months later, and "ok" satisfies non-empty while
 * answering nothing. The same floor `nativeStoreLinkCreateSchema` uses, for the
 * same reason and deliberately not a different number.
 */
const reason = z.string().trim().min(10).max(2_000);

/**
 * `POST /store-linkage/requests` — open a linkage request.
 *
 * `mode` is the two OPENING modes only. `correct_link` and `unlink` are
 * deliberately absent from this schema and reachable only from the operator
 * surface: ending somebody's linkage is not a thing a claimant does to
 * themselves through the same door they created one with, and a mode tuple
 * shared by both surfaces would make that a permission check rather than a
 * shape.
 *
 * The cross-field rule (`storeId` present exactly for `link_existing`) is a
 * `refine` here AND a CHECK in the schema, which is not redundancy: the CHECK is
 * the guarantee and this is the 400 with a message, so a client learns what it
 * did wrong instead of receiving a constraint name.
 */
export const openStoreLinkageRequestSchema = z
  .object({
    claimId: entityId,
    mode: z.enum(['create_store', 'link_existing']),
    storeId: entityId.optional(),
    reason,
  })
  .strict()
  .refine((body) => (body.mode === 'link_existing') === (body.storeId !== undefined), {
    message: '`storeId` is required for link_existing and refused for create_store',
    path: ['storeId'],
  });

/**
 * `POST /store-linkage/requests/:id/apply` — apply it.
 *
 * `adoptFields` is an explicit, closed list. An owner who sends nothing adopts
 * nothing, which is the correct default: linkage is an identity act, and
 * changing a store's public name is a separate decision the owner has to make
 * on purpose (issue existing-store rule 3). There is no `adoptAll` — a flag
 * that adopts whatever the canonical side happens to hold is precisely the
 * silent copy issue store-creation rule 4 forbids.
 */
export const applyStoreLinkageRequestSchema = z
  .object({
    adoptFields: z.array(z.enum(PROFILE_FIELD_VALUES)).max(PROFILE_FIELD_VALUES.length).optional(),
  })
  .strict();

/**
 * `GET /store-linkage/diff` — compare a store against a canonical merchant.
 *
 * Both ids are required and neither has a default: a diff with an implied side
 * would answer a question the caller did not ask, and the caller's permission on
 * the store is checked before either is read.
 */
export const storeLinkageDiffQuerySchema = z
  .object({
    storeId: entityId,
    merchantId: entityId,
  })
  .strict();

/**
 * `POST /internal/commerce-graph/store-linkage/requests/:id/decision` —
 * the operator's verdict on a request waiting for one (issue case 3).
 *
 * An approval must NAME the store. A review that only said "yes" would leave
 * the ambiguity that sent it to review unresolved, and the service refuses a
 * store nobody proposed as a candidate — so the pair (approve, storeId) is the
 * whole decision.
 */
export const storeLinkageDecisionSchema = z
  .object({
    approve: z.boolean(),
    storeId: entityId.optional(),
    reason,
  })
  .strict()
  .refine((body) => !body.approve || body.storeId !== undefined, {
    message: 'Approving a linkage request must name the store to link',
    path: ['storeId'],
  });

/**
 * `POST /internal/commerce-graph/store-linkage/requests/:id/candidates` — record
 * a store an operator believes is right.
 *
 * Its own endpoint rather than a field on the decision, because widening what a
 * review may approve is a different act from approving: the candidate rows are
 * the BOUND on the review's power, and moving that bound belongs on the record
 * with its own reason.
 */
export const storeLinkageCandidateSchema = z
  .object({
    storeId: entityId,
    reason,
  })
  .strict();

/**
 * `POST /internal/commerce-graph/store-linkage/corrections` — correct or end a
 * linkage (issue case 7).
 *
 * `intendedMerchantId` ABSENT means unlink; present means correct to that
 * merchant. One endpoint rather than two, because the operator's question is one
 * question — "this store is linked wrongly" — and the answer differs only in
 * whether they know what it should be instead.
 */
export const storeLinkageCorrectionSchema = z
  .object({
    storeId: entityId,
    intendedMerchantId: entityId.optional(),
    reason,
  })
  .strict();
