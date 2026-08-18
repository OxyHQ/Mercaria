/**
 * Detecting the collisions a merge would hit, and applying the operator's
 * decision about each one (#59 merge invariant 4).
 *
 * ## Detection runs BEFORE anything moves, and application runs before the
 * phases that would collide
 *
 * The alternative — attempt the merge and catch `23505` — produces a HALF-MERGED
 * entity: four phases have already moved rows by the time the violation is
 * raised, and unwinding them is a second merge nobody planned. So the `plan`
 * phase probes every unique the merge would touch, the job BLOCKS while any
 * probe is undecided, and `awaiting_resolution` applies the decisions in the
 * losing row's own domain terms — retired, revoked, retired-offer — never by
 * deleting anything.
 *
 * ## Nothing here decides. It records and it executes.
 *
 * `keep_winner` and `keep_loser` are an operator's words; this module turns them
 * into the one statement each domain uses for "this row is no longer the current
 * one". A default that picked a side would be the false merge #58 spends nine
 * tables preventing, arriving through the door marked "conflict resolution".
 */

import { and, eq, isNull } from 'drizzle-orm';
import type {
  CatalogMergeConflictResolution,
  MergeableEntityType,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  detectActiveOfferConflicts,
  detectCompatibilityEndpointCollapse,
  detectDefaultVariantConflicts,
  detectIdentifierConflicts,
  detectRelationshipEndpointConflicts,
  detectVariantSignatureConflicts,
  detectVerifiedBrandOwnerConflicts,
  detectVerifiedClaimConflicts,
  type DetectedConflict,
} from '../../db/curation/conflictRepository.js';
import { insertConflict, type InsertConflictInput } from '../../db/curation/jobRepository.js';
import type { CatalogMergeConflictRow } from '../../db/schema/curation.js';
import { canonicalVariants, productIdentifiers } from '../../db/schema/canonicalCatalog.js';
import { genericCompatibilityRelations } from '../../db/schema/compatibility.js';
import { commerceRelationships } from '../../db/schema/relationships.js';
import { merchantClaims } from '../../db/schema/merchantClaims.js';
import { offers } from '../../db/schema/offers.js';
import { validationError } from '../../lib/errors/error-codes.js';

/**
 * Which detectors apply to which mergeable entity.
 *
 * A TABLE rather than a `switch`, the `claim-methods.ts` device, so "does a
 * storefront merge probe identifiers" is answered by reading one place. An
 * entity with no entry probes nothing, which is only correct when it genuinely
 * has no unique to violate — and the census test is what makes that claim
 * checkable, because every `conflict_gated` plan entry must name a kind some
 * detector produces.
 */
export async function detectMergeConflicts(
  entityType: MergeableEntityType,
  loserId: string,
  winnerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly DetectedConflict[]> {
  switch (entityType) {
    case 'organization':
      return detectRelationshipEndpointConflicts(
        commerceRelationships.organizationId,
        loserId,
        winnerId,
        db,
      );
    case 'brand':
      return [
        ...(await detectRelationshipEndpointConflicts(
          commerceRelationships.brandId,
          loserId,
          winnerId,
          db,
        )),
        ...(await detectRelationshipEndpointConflicts(
          commerceRelationships.relatedBrandId,
          loserId,
          winnerId,
          db,
        )),
        ...(await detectVerifiedBrandOwnerConflicts(loserId, winnerId, db)),
      ];
    case 'merchant':
      return [
        ...(await detectRelationshipEndpointConflicts(
          commerceRelationships.merchantId,
          loserId,
          winnerId,
          db,
        )),
        ...(await detectActiveOfferConflicts(offers.merchantId, loserId, winnerId, db)),
        ...(await detectVerifiedClaimConflicts(loserId, winnerId, db)),
      ];
    case 'storefront':
      return [
        ...(await detectRelationshipEndpointConflicts(
          commerceRelationships.storefrontId,
          loserId,
          winnerId,
          db,
        )),
        ...(await detectActiveOfferConflicts(offers.storefrontId, loserId, winnerId, db)),
      ];
    case 'canonical_product_family':
      return detectRelationshipEndpointConflicts(
        commerceRelationships.productFamilyId,
        loserId,
        winnerId,
        db,
      );
    case 'canonical_product':
      return [
        ...(await detectIdentifierConflicts(productIdentifiers.productId, loserId, winnerId, db)),
        ...(await detectVariantSignatureConflicts(loserId, winnerId, db)),
        ...(await detectDefaultVariantConflicts(loserId, winnerId, db)),
        ...(await detectCompatibilityEndpointCollapse(
          genericCompatibilityRelations.subjectProductId,
          genericCompatibilityRelations.targetProductId,
          loserId,
          winnerId,
          db,
        )),
      ];
    case 'canonical_variant':
      return [
        ...(await detectIdentifierConflicts(productIdentifiers.variantId, loserId, winnerId, db)),
        ...(await detectActiveOfferConflicts(offers.canonicalVariantId, loserId, winnerId, db)),
        // The SAME CHECK's second conjunct, one grain down. Shipping only the
        // product grain would leave a variant merge failing with the identical
        // `23514` in a change whose title says it was fixed.
        ...(await detectCompatibilityEndpointCollapse(
          genericCompatibilityRelations.subjectVariantId,
          genericCompatibilityRelations.targetVariantId,
          loserId,
          winnerId,
          db,
        )),
      ];
  }
}

/** Turn a detection into the FK pair `catalog_merge_conflicts` stores. */
function conflictColumns(jobId: string, detected: DetectedConflict): InsertConflictInput {
  const base = { jobId, kind: detected.kind, detail: detected.detail };
  switch (detected.kind) {
    case 'identifier':
      return { ...base, loserIdentifierId: detected.loserRowId, winnerIdentifierId: detected.winnerRowId };
    case 'variant_signature':
    case 'default_variant':
      return { ...base, loserVariantId: detected.loserRowId, winnerVariantId: detected.winnerRowId };
    case 'relationship_endpoint':
      return {
        ...base,
        loserRelationshipId: detected.loserRowId,
        winnerRelationshipId: detected.winnerRowId,
      };
    case 'active_offer':
      return { ...base, loserOfferId: detected.loserRowId, winnerOfferId: detected.winnerRowId };
    case 'verified_claim':
      return { ...base, loserClaimId: detected.loserRowId, winnerClaimId: detected.winnerRowId };
    case 'compatibility_endpoint_collapse':
      return { ...base, collapsingRelationId: detected.collapsingRowId };
  }
}

/** Record everything the probes found. Idempotent per (job, kind, pair). */
export async function recordMergeConflicts(
  jobId: string,
  detected: readonly DetectedConflict[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  for (const conflict of detected) {
    await insertConflict(conflictColumns(jobId, conflict), db);
  }
  return detected.length;
}

/**
 * Which of the two colliding rows an operator's decision retires.
 *
 * Naming it once is what keeps the branches below from each re-deciding the
 * mapping — and `merge_pair` returns null because nothing is retired: the two
 * rows become one through a child job. `close_relation` returns null for a
 * different reason: there are not two sides. Answering it with the `keep_loser`
 * default would hand the collapse branch a "retire the winner" instruction about
 * a row that does not exist, which is a wrong answer sitting in a variable
 * waiting for somebody to read it.
 */
function retiredSide(
  row: CatalogMergeConflictRow,
  resolution: CatalogMergeConflictResolution,
): { readonly loser: string | null; readonly winner: string | null } {
  if (resolution === 'merge_pair' || resolution === 'close_relation') {
    return { loser: null, winner: null };
  }
  return resolution === 'keep_winner' ? { loser: 'retire', winner: null } : { loser: null, winner: 'retire' };
}

/**
 * Apply ONE decided conflict to the graph.
 *
 * Every branch retires, revokes or unsets — none deletes, and none writes the
 * surviving row. That asymmetry is the whole safety property: a resolution can
 * only ever remove a row from a unique's predicate, so applying one twice is a
 * no-op and applying the wrong one is undoable by a compensating correction.
 */
export async function applyConflictResolution(
  row: CatalogMergeConflictRow,
  actorOxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<void> {
  const resolution = row.resolution;
  if (!resolution) {
    throw validationError(`Merge conflict ${row.id} has no resolution to apply.`);
  }
  const side = retiredSide(row, resolution);
  const reason = `merge conflict ${row.id}: ${resolution}`;

  switch (row.kind) {
    case 'identifier': {
      const target = side.loser === 'retire' ? row.loserIdentifierId : row.winnerIdentifierId;
      if (!target) return;
      // `product_identifiers_values_immutable` permits exactly two updates: a
      // STATUS transition and an owner change. This is the first of them, which
      // is why a correction retires rather than editing the value (ADR 0002 D14).
      await db
        .update(productIdentifiers)
        .set({ status: 'retired', note: reason })
        .where(and(eq(productIdentifiers.id, target), eq(productIdentifiers.status, 'active')));
      return;
    }
    case 'variant_signature':
      // Nothing is retired: the pair is merged by a CHILD job, which the parent
      // waits on. Creating that job is the resolution service's act, not this
      // function's, so applying it here would open a second one on a retry.
      return;
    case 'default_variant': {
      const target = side.loser === 'retire' ? row.loserVariantId : row.winnerVariantId;
      if (!target) return;
      await db
        .update(canonicalVariants)
        .set({ isDefault: false })
        .where(eq(canonicalVariants.id, target));
      return;
    }
    case 'relationship_endpoint': {
      const target = side.loser === 'retire' ? row.loserRelationshipId : row.winnerRelationshipId;
      if (!target) return;
      // Revoked rather than expired: time did not run out, a person decided the
      // claim should no longer stand. `commerce_relationships_revoked_state_check`
      // requires all three columns, so the revocation is auditable by construction.
      await db
        .update(commerceRelationships)
        .set({
          status: 'revoked',
          validTo: now,
          revokedAt: now,
          revokedByOxyUserId: actorOxyUserId,
          revokeReason: reason,
        })
        .where(eq(commerceRelationships.id, target));
      return;
    }
    case 'active_offer': {
      const target = side.loser === 'retire' ? row.loserOfferId : row.winnerOfferId;
      if (!target) return;
      await db
        .update(offers)
        .set({ status: 'retired', retirementReason: 'superseded', retiredAt: now })
        .where(and(eq(offers.id, target), eq(offers.status, 'active')));
      return;
    }
    case 'verified_claim': {
      const target = side.loser === 'retire' ? row.loserClaimId : row.winnerClaimId;
      if (!target) return;
      // Revoking a claim removes MANAGEMENT ACCESS and preserves public history
      // (#83). The merchant it names is about to become a tombstone anyway, so
      // the surviving merchant keeps exactly one verified operator.
      await db
        .update(merchantClaims)
        .set({
          state: 'revoked',
          revokedAt: now,
          revokedByOxyUserId: actorOxyUserId,
          // The reason is a CLOSED set (#83), and this is the member that means
          // "an operator decided", which is exactly what a conflict resolution
          // is. The free-text `reason` above rides on the audit revision.
          revokeReason: 'operator_correction',
        })
        .where(and(eq(merchantClaims.id, target), eq(merchantClaims.state, 'verified')));
      return;
    }
    case 'compatibility_endpoint_collapse': {
      const target = row.collapsingRelationId;
      if (!target) return;
      // CLOSED, in this domain's own terms: `valid_to` is what takes a relation
      // out of `generic_compatibility_relations_open_key`, and `revoked` plus
      // its attribution is what `..._revoked_state_check` demands of a claim a
      // person ended. Revoked rather than merely expired for the
      // `relationship_endpoint` reason one domain over — time did not run out,
      // an operator decided this claim should no longer stand.
      //
      // The row is NOT deleted and NOT moved: `collapseGuard` leaves it on the
      // tombstone, where a closed claim about what the losing identity was
      // compatible with is exactly the history `retained_by_tombstone` keeps.
      // Repointing it is the statement the CHECK refuses.
      //
      // `valid_to is null` in the predicate makes a second application a no-op
      // rather than a re-revocation under a later timestamp — the `identifier`
      // branch's `status = 'active'`, and what lets `markConflictApplied` run
      // after the write.
      await db
        .update(genericCompatibilityRelations)
        .set({
          verification: 'revoked',
          validTo: now,
          revokedAt: now,
          revokedByOxyUserId: actorOxyUserId,
          revokeReason: reason,
        })
        .where(
          and(
            eq(genericCompatibilityRelations.id, target),
            isNull(genericCompatibilityRelations.validTo),
          ),
        );
      return;
    }
  }
}

/** The two ids a `merge_pair` resolution opens a child merge job over. */
export function mergePairSubjects(
  row: CatalogMergeConflictRow,
): { readonly loserId: string; readonly winnerId: string } {
  if (row.kind !== 'variant_signature' || !row.loserVariantId || !row.winnerVariantId) {
    throw validationError(
      `Merge conflict ${row.id} cannot be resolved by merging the pair: only a variant-signature ` +
        'collision names two rows that are the same configuration.',
    );
  }
  return { loserId: row.loserVariantId, winnerId: row.winnerVariantId };
}
