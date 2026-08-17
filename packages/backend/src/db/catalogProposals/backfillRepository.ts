/**
 * The writes an approved proposal's backfill performs (#367 step 6,
 * ADR 0007 D9: "On approval the canonical entity is created or linked and
 * affected drafts and listings are backfilled **idempotently**").
 *
 * Two targets, both owned by other domains and both reached through their own
 * tables' rules rather than around them:
 *
 * - `catalog_authoring_draft_values` (#367 step 5) — the local claim an author
 *   typed becomes the typed answer it was asking for.
 * - `native_listing_attribute_claims` (#367 step 4) — the retained claim a
 *   published listing carries gets its resolution.
 *
 * ## Every write is ONE statement, and every one is conditional
 *
 * The idempotency lives on `catalog_proposal_references.backfilled_at`, but a
 * compare-and-swap there is not enough on its own: a reference claimed by a pass
 * that then crashed would be stamped with the value write never made. So each
 * statement here is ALSO conditional on the row still being in the state the
 * backfill is correcting — an unresolved claim, a text-kinded draft value — and
 * reports whether it applied. A write that finds nothing to do is a success, not
 * a failure: it means somebody already answered.
 *
 * ## The draft value's kind changes in the SAME statement as its value
 *
 * `catalog_authoring_draft_values_exactly_one_value_check` counts non-null value
 * columns with `num_nonnulls(...) = 1`, and the per-kind biconditionals name
 * which column each kind uses. Clearing the text and setting the enum id in two
 * statements would leave an intermediate row the CHECKs refuse — which is the
 * constraint working, and the reason this is one `UPDATE` rather than a read, a
 * clear and a set.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AuthoringCanonicalRefKind } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  catalogAuthoringDraftValues,
  catalogAuthoringDrafts,
} from '../schema/catalogAuthoring.js';
import { nativeListingAttributeClaims } from '../schema/variantAxes.js';

/**
 * Rewrite a draft's local claim into the controlled value it was asking for.
 *
 * Conditional on the answer still being `text`: an author who removed it, or a
 * previous pass that already applied it, leaves nothing to do and this returns
 * `false` — which the caller records as applied-by-somebody-else rather than as a
 * failure.
 *
 * @returns whether this statement changed the row.
 */
export async function resolveDraftValueToControlledValue(
  db: DatabaseOrTransaction,
  draftValueId: string,
  enumValueId: string,
): Promise<boolean> {
  const rows = await db
    .update(catalogAuthoringDraftValues)
    .set({ kind: 'controlled_value', valueText: null, valueEnumValueId: enumValueId })
    .where(
      and(
        eq(catalogAuthoringDraftValues.id, draftValueId),
        eq(catalogAuthoringDraftValues.kind, 'text'),
      ),
    )
    .returning({ id: catalogAuthoringDraftValues.id });
  return rows.length > 0;
}

/** The same, for a proposal that resolved to a canonical entity rather than a value. */
export async function resolveDraftValueToCanonicalReference(
  db: DatabaseOrTransaction,
  draftValueId: string,
  refKind: AuthoringCanonicalRefKind,
  refId: string,
): Promise<boolean> {
  const rows = await db
    .update(catalogAuthoringDraftValues)
    .set({
      kind: 'canonical_reference',
      valueText: null,
      canonicalRefKind: refKind,
      canonicalRefId: refId,
    })
    .where(
      and(
        eq(catalogAuthoringDraftValues.id, draftValueId),
        eq(catalogAuthoringDraftValues.kind, 'text'),
      ),
    )
    .returning({ id: catalogAuthoringDraftValues.id });
  return rows.length > 0;
}

/**
 * Bump the draft's optimistic-concurrency token after rewriting one of its
 * answers.
 *
 * A client holding the previous version gets a 409 on its next save and re-reads,
 * which is CORRECT rather than unfortunate: the answer it is holding is not the
 * one stored any more, and letting its stale copy win would put the merchant's
 * old free text back over the value an operator just approved.
 *
 * Only for an OPEN draft. A published one is an audit record of what was
 * published and `catalog_authoring_drafts_published_listing_check` and its two
 * siblings freeze the state around it; the LISTING's own claim is the thing a
 * publication's backfill corrects, and it is the other function here.
 */
export async function bumpDraftVersionAfterBackfill(
  db: DatabaseOrTransaction,
  draftId: string,
): Promise<void> {
  await db
    .update(catalogAuthoringDrafts)
    .set({ version: sql`${catalogAuthoringDrafts.version} + 1` })
    .where(and(eq(catalogAuthoringDrafts.id, draftId), eq(catalogAuthoringDrafts.status, 'open')));
}

/**
 * Settle a published listing's retained claim (ADR 0007 D7).
 *
 * BOTH halves in one statement, because
 * `native_listing_attribute_claims_value_depends_on_attribute_check` refuses a
 * resolved value beside an unresolved attribute: the value is a value OF
 * something, and typing it while nobody knows what it is a value of is the false
 * merge the claim layer exists to prevent. The refusal columns are cleared in the
 * same `set` — a settled half carrying a refusal reason is refused by
 * `…_refusal_shape_check`, which is the constraint working.
 *
 * Conditional on the value half still being `unresolved`, so a claim an operator
 * already settled by hand is left exactly as they settled it.
 */
export async function resolveListingClaimToControlledValue(
  db: DatabaseOrTransaction,
  claimId: string,
  input: {
    readonly attributeDefinitionId: string;
    readonly attributeDefinitionVersion: number;
    readonly enumValueId: string;
    readonly normalizedValue: string;
    readonly resolvedByOxyUserId: string;
    readonly resolvedAt: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(nativeListingAttributeClaims)
    .set({
      attributeResolution: 'resolved',
      attributeRefusal: null,
      attributeDefinitionId: input.attributeDefinitionId,
      attributeDefinitionVersion: input.attributeDefinitionVersion,
      valueResolution: 'resolved',
      valueRefusal: null,
      enumValueId: input.enumValueId,
      normalizedValue: input.normalizedValue,
      resolvedByOxyUserId: input.resolvedByOxyUserId,
      resolvedAt: input.resolvedAt,
    })
    .where(
      and(
        eq(nativeListingAttributeClaims.id, claimId),
        eq(nativeListingAttributeClaims.valueResolution, 'unresolved'),
      ),
    )
    .returning({ id: nativeListingAttributeClaims.id });
  return rows.length > 0;
}

/** The draft a value belongs to, and its current kind. Read before a rewrite. */
export async function findDraftValueForBackfill(
  db: DatabaseOrTransaction,
  draftValueId: string,
): Promise<{ readonly id: string; readonly draftId: string; readonly kind: string } | null> {
  const rows = await db
    .select({
      id: catalogAuthoringDraftValues.id,
      draftId: catalogAuthoringDraftValues.draftId,
      kind: catalogAuthoringDraftValues.kind,
    })
    .from(catalogAuthoringDraftValues)
    .where(eq(catalogAuthoringDraftValues.id, draftValueId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The unresolved claims a listing carries for one raw value under one attribute.
 *
 * Used by the operator surface to ATTACH claims to an approved proposal — the
 * step that turns "this listing has been saying `Verde Bosque` for a month" into
 * a reference the backfill can settle. Bounded by the caller's page size and
 * narrowed by the review-queue partial index.
 */
export async function listUnresolvedClaimsForRawValue(
  db: DatabaseOrTransaction,
  rawValueKey: string,
  limit: number,
): Promise<{ readonly id: string; readonly listingId: string }[]> {
  return db
    .select({
      id: nativeListingAttributeClaims.id,
      listingId: nativeListingAttributeClaims.listingId,
    })
    .from(nativeListingAttributeClaims)
    .where(
      and(
        eq(nativeListingAttributeClaims.rawValueKey, rawValueKey),
        eq(nativeListingAttributeClaims.valueResolution, 'unresolved'),
        isNull(nativeListingAttributeClaims.enumValueId),
      ),
    )
    .limit(limit);
}
