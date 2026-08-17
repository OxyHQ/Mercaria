/**
 * The unresolved compatibility-claim queue, and the one act that empties it
 * (#367 Workstream 14).
 *
 * ## What was missing, and why a count was not enough
 *
 * `GET /queues` already reported `unresolved_compatibility_claim` as an integer,
 * and `POST /reviews/compatibility-claims/:claimId` already let an operator stamp
 * a state on a claim **whose id they already had**. Between those two there was
 * nothing: no way to learn WHICH claims the count was counting, and no way to
 * turn one into the fitment a shopper is shown. `listUnresolvedClaims` — whose
 * own docblock calls it "the unresolved review queue" — had no HTTP caller, and
 * `promoteClaimToFitment` had no caller at all.
 *
 * So the workflow was broken in the middle, in the direction that reads fine: the
 * dashboard said seven, an operator pressed nothing, and the seven stayed seven.
 *
 * ## The trap this domain is shaped around
 *
 * **An ambiguous fitment must never be silently resolved to the likeliest
 * vehicle.** It is #58's false merge one domain over and it is worse here: a
 * wrong product match shows somebody the wrong page, and a wrong fitment sells
 * them a brake pad that does not fit their car. Nobody finds out but the customer.
 *
 * Four things make that structural rather than a rule in a comment:
 *
 * 1. **The vehicle is REQUIRED INPUT.** `PromoteCompatibilityClaimInput` has a
 *    non-optional `vehicleMakeId` and the scope ladder above it. There is no
 *    shape in which the target is absent, so there is nothing for a default to
 *    fill in.
 * 2. **This service never reads `raw_target_text` to decide anything.** It is
 *    SHOWN to the operator by {@link readCompatibilityClaimQueue} and is not an
 *    input to {@link promoteCompatibilityClaimToFitment} — the promotion takes
 *    ids, and the claim's own words reach no comparison.
 * 3. **`COMPATIBILITY_CLAIM_PROMOTION_FORBIDDEN_INPUTS`** names ten shapes a
 *    convenience would arrive under, and `catalog-governance-isolation.test.ts`
 *    scans this domain AND `services/compatibility/` for every one of them.
 * 4. **`assertClaimMatchesSubject`** already refuses a claim promoted onto a
 *    different SUBJECT. That is the half the domain had; the vehicle half is the
 *    three above.
 *
 * What none of that can prevent is an operator naming the wrong car. That is a
 * human decision, which is why the promotion is audited with a mandatory reason
 * and why the fitment it opens records `operator_review` as its verification
 * method — so the row says a person decided, and which person.
 *
 * ## Why the promotion is `publish` and the review is `review`
 *
 * They sit either side of the one role boundary this domain has, and the line is
 * whether the act CREATES a fact a shopper acts on. A review records a judgement
 * about a claim and publishes nothing; a promotion opens the `automotive_fitments`
 * row a product page reads.
 */

import type {
  CompatibilityApplicability,
  CompatibilityClaimQueueView,
  CompatibilityClaimReasonCount,
  CompatibilityClaimReviewView,
  FitmentPosition,
  FitmentQualifier,
  FitmentTargetScope,
} from '@mercaria/shared-types';
import { notFound, validationError } from '../../lib/errors/index.js';
import type { Database } from '../../db/postgres.js';
import {
  countUnresolvedBySource,
  countUnreviewedClaims,
  findClaimById,
  listUnresolvedClaims,
  type CompatibilityClaimRow,
} from '../../db/compatibility/compatibilityClaimRepository.js';
import { promoteClaimToFitmentWithin } from '../compatibility/claim.service.js';
import type { AutomotiveFitmentRow } from '../../db/compatibility/automotiveFitmentRepository.js';
import { recordAuditEvent } from '../../db/catalogGovernance/auditRepository.js';
import { requireGovernanceRole, roleForAction } from './role.service.js';
import type { CatalogGovernanceActor } from './actor.js';

/** The largest page the queue will serve, and the default. */
export const CLAIM_QUEUE_MAX_LIMIT = 200;
export const CLAIM_QUEUE_DEFAULT_LIMIT = 50;

export interface CompatibilityClaimQueueQuery {
  /** `undefined` reads every source, which is what a queue needs before it knows who to blame. */
  readonly sourceId?: string;
  readonly limit?: number;
}

/**
 * Read the queue.
 *
 * `view` and not `review`: reading which claims are outstanding is the least
 * privileged thing on this surface, and an operator who may not decide anything
 * still needs to see the backlog to report it.
 */
export async function readCompatibilityClaimQueue(
  db: Database,
  actor: CatalogGovernanceActor,
  query: CompatibilityClaimQueueQuery,
): Promise<CompatibilityClaimQueueView> {
  requireGovernanceRole(actor, 'view');

  const requested = query.limit ?? CLAIM_QUEUE_DEFAULT_LIMIT;
  const examinedLimit = Math.min(Math.max(requested, 1), CLAIM_QUEUE_MAX_LIMIT);
  const sourceId = query.sourceId ?? null;

  // One MORE than the page, so truncation is measured on what the query
  // EXAMINED rather than on what survived it — a full page and a page that
  // happened to end at the limit are otherwise the same answer.
  const rows = await listUnresolvedClaims(sourceId, examinedLimit + 1, db);
  const truncated = rows.length > examinedLimit;
  const page = truncated ? rows.slice(0, examinedLimit) : rows;

  const byReason = await countUnresolvedBySource(sourceId, db);

  return {
    claims: page.map(projectClaimForReview),
    byReason: byReason.map(
      (entry): CompatibilityClaimReasonCount => ({ reason: entry.reason, count: entry.count }),
    ),
    // The WHOLE unreviewed count, not the page's. `GET /queues` already reports
    // this number, and the two reads must agree or an operator is told the
    // backlog is two different sizes on two screens.
    unreviewed: await countUnreviewedClaims(db),
    examinedLimit,
    truncated,
  };
}

/**
 * One claim, as an operator sees it.
 *
 * Names every field explicitly rather than spreading the row — the
 * `provider_accounts` device. A spread would put `fitment_id`, `relation_id` and
 * every future column into an operator response by default, and the point of
 * this projection is that adding a column to `compatibility_claims` is not
 * automatically a disclosure decision.
 */
function projectClaimForReview(row: CompatibilityClaimRow): CompatibilityClaimReviewView {
  return {
    id: row.id,
    subjectProductId: row.subjectProductId,
    subjectVariantId: row.subjectVariantId,
    kind: row.kind,
    rawTargetText: row.rawTargetText,
    rawQualifierText: row.rawQualifierText,
    unresolvedReason: row.unresolvedReason,
    assertedByKind: row.assertedByKind,
    assertedBySourceId: row.assertedBySourceId,
    sourceUrl: row.sourceUrl,
    observedAt: row.observedAt.toISOString(),
    confidence: row.confidence,
    reviewedByOxyUserId: row.reviewedByOxyUserId,
    reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
    reviewNote: row.reviewNote,
  };
}

/**
 * Everything an operator must state to promote a claim.
 *
 * The vehicle is not optional at any rung the scope requires, and there is no
 * member that could carry a suggestion, a candidate list or a confidence — see
 * the header. `reason` is mandatory because the audit row is the only place the
 * decision is explained, and a promotion with no reason is a published fitment
 * nobody can account for.
 */
export interface PromoteCompatibilityClaimInput {
  readonly claimId: string;
  readonly scope: FitmentTargetScope;
  readonly vehicleMakeId: string;
  readonly vehicleModelId?: string;
  readonly vehicleGenerationId?: string;
  readonly vehicleConfigurationId?: string;
  readonly applicability: CompatibilityApplicability;
  readonly position: FitmentPosition;
  readonly qualifiers?: readonly FitmentQualifier[];
  readonly conditionNote?: string;
  readonly yearFrom?: number;
  readonly yearTo?: number;
  readonly reason: string;
}

/**
 * Promote one claim to a canonical fitment, in ONE transaction with its audit.
 *
 * The fitment is opened with `verification: 'verified'` and
 * `verificationMethod: 'operator_review'`, which is the only honest description
 * of what happened: a named person read the claim and decided. It is NOT
 * `manufacturer_publication` — that method's CHECK demands a URL and a digest,
 * and borrowing it would dress a human judgement as a document.
 */
export async function promoteCompatibilityClaimToFitment(
  db: Database,
  actor: CatalogGovernanceActor,
  input: PromoteCompatibilityClaimInput,
): Promise<AutomotiveFitmentRow> {
  requireGovernanceRole(actor, roleForAction('compatibility_claim_promote'));
  assertScopeNamesItsVehicle(input);

  const at = new Date();

  return db.transaction(async (tx) => {
    const claim = await findClaimById(input.claimId, tx);
    if (claim === null) throw notFound('Compatibility claim not found.');

    const opened = await promoteClaimToFitmentWithin(
      tx,
      input.claimId,
      {
        ...(claim.subjectProductId === null ? {} : { subjectProductId: claim.subjectProductId }),
        ...(claim.subjectVariantId === null ? {} : { subjectVariantId: claim.subjectVariantId }),
        scope: input.scope,
        vehicleMakeId: input.vehicleMakeId,
        ...(input.vehicleModelId === undefined ? {} : { vehicleModelId: input.vehicleModelId }),
        ...(input.vehicleGenerationId === undefined
          ? {}
          : { vehicleGenerationId: input.vehicleGenerationId }),
        ...(input.vehicleConfigurationId === undefined
          ? {}
          : { vehicleConfigurationId: input.vehicleConfigurationId }),
        applicability: input.applicability,
        position: input.position,
        ...(input.qualifiers === undefined ? {} : { qualifiers: [...input.qualifiers] }),
        ...(input.conditionNote === undefined ? {} : { conditionNote: input.conditionNote }),
        ...(input.yearFrom === undefined ? {} : { yearFrom: input.yearFrom }),
        ...(input.yearTo === undefined ? {} : { yearTo: input.yearTo }),
        verification: 'verified',
        verificationMethod: 'operator_review',
        verifiedAt: at,
        verifiedByOxyUserId: actor.oxyUserId,
        assertedByKind: 'operator',
        observedAt: at,
      },
      at,
    );

    await recordAuditEvent(tx, {
      domain: 'compatibility',
      action: 'compatibility_claim_promote',
      subjectKind: 'compatibility_claim',
      subjectId: input.claimId,
      actorKind: 'operator',
      actorOxyUserId: actor.oxyUserId,
      reason: input.reason,
      source: 'operator_console',
      changeRequestId: null,
      before: null,
      // The vehicle the OPERATOR named, recorded beside the fitment it opened —
      // so "which car did somebody decide this was" is answerable from the trail
      // rather than by re-reading a row that may since have been superseded.
      after: {
        claimId: input.claimId,
        fitmentId: opened.id,
        scope: input.scope,
        vehicleMakeId: input.vehicleMakeId,
        vehicleModelId: input.vehicleModelId ?? null,
        vehicleGenerationId: input.vehicleGenerationId ?? null,
        vehicleConfigurationId: input.vehicleConfigurationId ?? null,
        applicability: input.applicability,
      },
      at,
    });

    return opened;
  });
}

/**
 * Refuse a promotion whose scope and vehicle ids disagree.
 *
 * `automotive_fitments_scope_shape_check` refuses the same rows, and this is not
 * redundant: the CHECK's message names a constraint, and an operator who omitted
 * a generation needs to be told which rung is missing. It is also the ladder
 * stated once in a place a reader can find, rather than inferred from SQL.
 */
function assertScopeNamesItsVehicle(input: PromoteCompatibilityClaimInput): void {
  const present = {
    model: input.vehicleModelId !== undefined,
    generation: input.vehicleGenerationId !== undefined,
    configuration: input.vehicleConfigurationId !== undefined,
  };
  const required: Record<FitmentTargetScope, typeof present> = {
    vehicle_make: { model: false, generation: false, configuration: false },
    vehicle_model: { model: true, generation: false, configuration: false },
    vehicle_generation: { model: true, generation: true, configuration: false },
    vehicle_configuration: { model: true, generation: true, configuration: true },
  };
  const want = required[input.scope];
  if (
    present.model !== want.model ||
    present.generation !== want.generation ||
    present.configuration !== want.configuration
  ) {
    throw validationError(
      `A ${input.scope} fitment names exactly: make${want.model ? ', model' : ''}` +
        `${want.generation ? ', generation' : ''}${want.configuration ? ', configuration' : ''}. ` +
        'Every rung above the scope is required and every rung below it must be absent.',
    );
  }
}
