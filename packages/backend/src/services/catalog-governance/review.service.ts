/**
 * Single-row review decisions (#367 Workstream 12).
 *
 * The three domains here — localization, external mappings and compatibility —
 * each landed with a complete write path and NO operator HTTP surface at all.
 * That is the gap this module fills: it routes an operator's decision straight
 * through to the domain's own writer and records it in the governance audit
 * trail. It re-decides nothing and re-implements nothing.
 *
 * These are deliberately NOT change requests. A change request exists to put an
 * impact measurement and a second operator in front of an act with a blast
 * radius; reviewing one translation affects one row, and wrapping it in a
 * two-phase plan would buy an impact count that is always exactly one and a
 * queue nobody would use.
 *
 * ## Proposals are consumed and deliberately NOT re-routed
 *
 * `/internal/catalog-proposals/*` already exposes all seven decisions
 * (approve, merge, reject, request-information, defer, redirect, backfill),
 * behind the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list, writing the same
 * `catalog_review_events` trail. Adding a second route to one decision is how
 * two surfaces come to disagree about what a decision means, so this domain
 * consumes proposals by COUNTING their backlog on the desk
 * (`readGovernanceQueues`) and reading their queue — and by not offering a
 * second way to decide one. That is what "consume it, do not fork it" means
 * here.
 *
 * ## Localization review is the one that needed a rule invented
 *
 * The localization domain stores `status` as a plain column any upsert sets,
 * and its machine-write guard refuses a machine provenance overwriting human
 * content. What it has no concept of is "an operator reviewed this" as an ACT.
 * `reviewLocalization` supplies exactly that and nothing more: it writes the
 * reviewer, the instant and the status through the domain's own upsert, and it
 * refuses to touch `provenance` — because a review is a judgement about a
 * translation, not a claim about where the translation came from.
 */

import type {
  CatalogGovernanceReviewAction,
  CompatibilityClaimState,
  LocalizationStatus,
  SupportedLocale,
} from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import type { Database } from '../../db/postgres.js';
import { upsertCategoryLocalization } from '../../db/catalogLocalization/categoryLocalizationRepository.js';
import { upsertProductTypeLocalization } from '../../db/catalogLocalization/productTypeLocalizationRepository.js';
import { recordClaimReview } from '../../db/compatibility/compatibilityClaimRepository.js';
import {
  approveExternalMapping,
  approveExternalMappingFanOutDecision,
  rejectExternalMapping,
} from '../catalog-external-mappings/mapping.service.js';
import { recordAuditEvent } from '../../db/catalogGovernance/auditRepository.js';
import type { CatalogGovernanceActor } from './actor.js';
import { requireGovernanceRole, roleForAction } from './role.service.js';

/**
 * The statuses an operator REVIEW may set.
 *
 * Not the whole `LOCALIZATION_STATUSES` tuple: `missing` is the absence of a
 * translation and `machine_translated` is a claim about its origin, and a
 * review surface able to write either would let a reviewer mark human work as
 * machine output — which the machine-write guard exists to prevent from the
 * other direction. `deprecated` is a lifecycle decision that belongs with the
 * entity, not with one locale's copy of it.
 */
export const REVIEWABLE_LOCALIZATION_STATUSES: readonly LocalizationStatus[] = [
  'reviewed',
  'approved',
  'stale',
];

/** What a localization review states. */
export interface ReviewLocalizationInput {
  readonly entity: 'category' | 'product_type';
  readonly entityId: string;
  readonly locale: SupportedLocale;
  readonly status: LocalizationStatus;
  readonly name?: string;
  readonly description?: string;
  readonly reason: string;
}

/**
 * Review one translation.
 *
 * `provenance` is carried forward as `'mercaria'` and is NOT a parameter — see
 * the file doc. The reviewer and the instant travel together, which the
 * `_reviewer_pair_check` biconditional requires anyway.
 */
export async function reviewLocalization(
  db: Database,
  actor: CatalogGovernanceActor,
  input: ReviewLocalizationInput,
): Promise<void> {
  requireGovernanceRole(actor, roleForAction('localization_review'));

  if (!REVIEWABLE_LOCALIZATION_STATUSES.includes(input.status)) {
    throw validationError(
      `A review may set ${REVIEWABLE_LOCALIZATION_STATUSES.join(', ')} and nothing else. ` +
        `"${input.status}" is a claim about a translation's origin or lifecycle, not a review outcome.`,
    );
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    if (input.entity === 'category') {
      await upsertCategoryLocalization(
        {
          categoryId: input.entityId,
          locale: input.locale,
          status: input.status,
          provenance: 'mercaria',
          name: input.name ?? null,
          description: input.description ?? null,
          reviewedByOxyUserId: actor.oxyUserId,
          reviewedAt: now,
        },
        tx,
      );
    } else {
      await upsertProductTypeLocalization(
        {
          productTypeDefinitionId: input.entityId,
          locale: input.locale,
          status: input.status,
          provenance: 'mercaria',
          name: input.name ?? null,
          description: input.description ?? null,
          reviewedByOxyUserId: actor.oxyUserId,
          reviewedAt: now,
        },
        tx,
      );
    }

    await recordAuditEvent(tx, {
      domain: 'localization',
      action: 'localization_review',
      subjectKind: input.entity === 'category' ? 'category' : 'product_type_definition',
      subjectId: input.entityId,
      actorKind: 'operator',
      actorOxyUserId: actor.oxyUserId,
      reason: input.reason,
      source: 'operator_console',
      changeRequestId: null,
      // The locale and the status, not the TEXT. A translation body in an
      // append-only audit table is a copy of catalogue content that erasure and
      // correction can never reach, and the localization row already holds it.
      before: null,
      after: { locale: input.locale, status: input.status },
      at: now,
    });
  });
}

/** What an external-mapping decision states. */
export interface ReviewExternalMappingInput {
  readonly mappingId: string;
  readonly decision: 'approve' | 'reject' | 'fan_out_approve';
  readonly reason: string;
}

/**
 * Decide one external mapping.
 *
 * Each branch calls the mapping domain's own service, which owns the state
 * machine, the window, the version chain and the fan-out four-eyes CHECK. The
 * fan-out branch is the one to read: its second approver must differ from the
 * first, and that is `catalog_external_mappings_fan_out_four_eyes_check` rather
 * than anything here — this surface just makes the act reachable, which it was
 * not before.
 */
export async function reviewExternalMapping(
  db: Database,
  actor: CatalogGovernanceActor,
  input: ReviewExternalMappingInput,
): Promise<void> {
  const action: CatalogGovernanceReviewAction =
    input.decision === 'approve'
      ? 'external_mapping_approve'
      : input.decision === 'reject'
        ? 'external_mapping_reject'
        : 'external_mapping_fan_out_approve';
  requireGovernanceRole(actor, roleForAction(action));

  const at = new Date();

  await db.transaction(async (tx) => {
    if (input.decision === 'approve') {
      await approveExternalMapping({ id: input.mappingId, approverOxyUserId: actor.oxyUserId, at }, tx);
    } else if (input.decision === 'reject') {
      await rejectExternalMapping(
        { id: input.mappingId, reviewerOxyUserId: actor.oxyUserId, reason: input.reason, at },
        tx,
      );
    } else {
      await approveExternalMappingFanOutDecision(
        { id: input.mappingId, approverOxyUserId: actor.oxyUserId, rationale: input.reason, at },
        tx,
      );
    }

    await recordAuditEvent(tx, {
      domain: 'external_mapping',
      action,
      subjectKind: 'external_mapping',
      subjectId: input.mappingId,
      actorKind: 'operator',
      actorOxyUserId: actor.oxyUserId,
      reason: input.reason,
      source: 'operator_console',
      changeRequestId: null,
      before: null,
      after: { mappingId: input.mappingId, decision: input.decision },
      at,
    });
  });
}

/** What a compatibility claim review states. */
export interface ReviewCompatibilityClaimInput {
  readonly claimId: string;
  readonly state: CompatibilityClaimState;
  readonly reviewNote: string | null;
  readonly reason: string;
}

/**
 * States a review may set on a compatibility claim.
 *
 * `selected` and `superseded` are excluded: both are written by
 * `promoteClaimToRelation`/`promoteClaimToFitment` as part of creating the
 * canonical row, and a review surface able to set `selected` without one would
 * mark a claim as chosen with nothing having chosen it — the partial unique
 * would then refuse the real promotion.
 */
const REVIEWABLE_CLAIM_STATES: readonly CompatibilityClaimState[] = [
  'corroborating',
  'conflicting',
  'rejected',
  'unresolved',
];

/**
 * Review one compatibility claim.
 *
 * `recordClaimReview` returns `false` when the claim does not exist; a
 * `rejected` state additionally needs the reviewer and the instant, which the
 * repository writes and `compatibility_claims_rejected_state_check` demands.
 */
export async function reviewCompatibilityClaim(
  db: Database,
  actor: CatalogGovernanceActor,
  input: ReviewCompatibilityClaimInput,
): Promise<void> {
  requireGovernanceRole(actor, roleForAction('compatibility_claim_review'));

  if (!REVIEWABLE_CLAIM_STATES.includes(input.state)) {
    throw validationError(
      `A review may set ${REVIEWABLE_CLAIM_STATES.join(', ')}. "${input.state}" is written by promoting the claim to a canonical relation, not by reviewing it.`,
    );
  }

  const at = new Date();

  await db.transaction(async (tx) => {
    const updated = await recordClaimReview(
      input.claimId,
      input.state,
      actor.oxyUserId,
      at,
      input.reviewNote,
      tx,
    );
    if (!updated) throw notFound('Compatibility claim not found.');

    await recordAuditEvent(tx, {
      domain: 'compatibility',
      action: 'compatibility_claim_review',
      subjectKind: 'compatibility_claim',
      subjectId: input.claimId,
      actorKind: 'operator',
      actorOxyUserId: actor.oxyUserId,
      reason: input.reason,
      source: 'operator_console',
      changeRequestId: null,
      before: null,
      after: { claimId: input.claimId, state: input.state },
      at,
    });
  });
}

/** Guard against a decision this surface does not offer. */
export function assertReviewActionSupported(action: string): void {
  const supported: readonly string[] = [
    'localization_review',
    'external_mapping_approve',
    'external_mapping_reject',
    'external_mapping_fan_out_approve',
    'compatibility_claim_review',
  ];
  if (supported.includes(action)) return;
  throw conflict(
    `${action} is decided on the surface that owns it. Proposal decisions live at /internal/catalog-proposals; this surface deliberately adds no second route to them.`,
  );
}
