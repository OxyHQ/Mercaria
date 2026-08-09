/**
 * Retail eligibility policy versions, category rules and market capabilities —
 * the operator-facing seam (#121 dimension 12, operations 3).
 *
 * A thin layer over `policyRepository`, and it exists for exactly three things
 * the repository should not carry: the DTO projection, the refusal that NAMES
 * an insufficient piece of resale evidence, and the AUDIT row every act writes
 * — including the ones that were refused.
 *
 * ## Why the refusal lives here rather than only in the zod schema
 *
 * The `.strict()` schema already refuses a value outside the enum. What it
 * answers is "invalid enum value", which reads as a typo rather than as an
 * attempt at something the commercial model forbids.
 * `assertNoForbiddenResaleEvidence` runs FIRST, over the raw values the caller
 * sent, so an operator who requires `affiliate_feed` is told that an affiliate
 * agreement grants linking and commission rights and never a right to resell.
 * The schema is the wall; this is the sign on it — the
 * `retail-pricing-policy.service` shape.
 */

import type { RetailEligibilityPolicySummary, RetailFulfilmentMethod } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { getDb } from '../../db/postgres.js';
import {
  activateRetailEligibilityPolicy,
  findRetailEligibilityPolicyById,
  insertRetailEligibilityPolicy,
  retireRetailEligibilityPolicy,
  upsertRetailCategoryRule,
  upsertRetailMarketCapability,
  type NewRetailCategoryRule,
  type NewRetailEligibilityPolicy,
  type NewRetailMarketCapability,
  type RetailCategoryRuleRecord,
  type RetailEligibilityPolicyRecord,
  type RetailMarketCapabilityRecord,
} from '../../db/retailEligibility/policyRepository.js';
import { appendRetailEligibilityAudit } from '../../db/retailEligibility/decisionRepository.js';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import { assertNoForbiddenResaleEvidence } from './forbidden-evidence.js';
import type {
  RetailCustomerType,
  RetailResaleEvidenceKind,
} from '@mercaria/shared-types';

/** `retail_eligibility_policies` row → the operator-facing DTO. */
export function toRetailEligibilityPolicySummary(
  row: RetailEligibilityPolicyRecord,
): RetailEligibilityPolicySummary {
  return {
    policyKey: row.policyKey,
    version: row.version,
    name: row.name,
    summary: row.summary,
    status: row.status,
    effectiveStart: row.effectiveStart.toISOString(),
    ...(row.effectiveEnd ? { effectiveEnd: row.effectiveEnd.toISOString() } : {}),
    permittedDestinationCountries: row.permittedDestinationCountries,
    permittedFulfilmentOriginCountries: row.permittedFulfilmentOriginCountries,
    permittedChannels: row.permittedChannels,
    permittedCurrencies: row.permittedCurrencies as RetailEligibilityPolicySummary['permittedCurrencies'],
    permittedFulfilmentMethods: row.permittedFulfilmentMethods as RetailFulfilmentMethod[],
    permittedCustomerTypes: row.permittedCustomerTypes as RetailCustomerType[],
    requiredResaleEvidenceKinds: row.requiredResaleEvidenceKinds as RetailResaleEvidenceKind[],
    requiredIdentifierSchemes: row.requiredIdentifierSchemes,
    requireCountryOfOrigin: row.requireCountryOfOrigin,
    requireResponsibleOperator: row.requireResponsibleOperator,
    requireDeterministicProductMatch: row.requireDeterministicProductMatch,
    minimumMatchConfidence: row.minimumMatchConfidence,
    maxQuantityPerOrder: row.maxQuantityPerOrder,
    ...(row.maxOrderValueAmount !== null && row.maxOrderValueCurrency !== null
      ? {
          maxOrderValue: {
            amount: row.maxOrderValueAmount,
            currency: row.maxOrderValueCurrency,
          },
        }
      : {}),
    manualExceptionsPermitted: row.manualExceptionsPermitted,
    exceptionDualApprovalRequired: row.exceptionDualApprovalRequired,
    createdAt: row.createdAt.toISOString(),
    ...(row.activatedAt ? { activatedAt: row.activatedAt.toISOString() } : {}),
  };
}

/**
 * Refuse a policy body that requires evidence which can never authorize a
 * resale, naming which one and why.
 *
 * Takes the RAW values so what it inspects is what the caller actually sent —
 * reading a parsed object would only ever see the values the enum already
 * allows, which is precisely the set that contains none of them.
 */
export function assertRetailPolicyEvidenceIsSufficient(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  const raw = (body as { requiredResaleEvidenceKinds?: unknown }).requiredResaleEvidenceKinds;
  if (!Array.isArray(raw)) return;
  assertNoForbiddenResaleEvidence(
    raw.filter((value): value is string => typeof value === 'string'),
    'Retail eligibility policy',
  );
}

/** Draft a new policy version, audited. */
export async function draftRetailEligibilityPolicy(
  input: NewRetailEligibilityPolicy & { reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailEligibilityPolicyRecord> {
  const row = await insertRetailEligibilityPolicy(db, input);
  await appendRetailEligibilityAudit(db, {
    action: 'policy_drafted',
    subjectTable: 'retail_eligibility_policies',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.createdByOxyUserId,
    detail: `${row.policyKey} v${row.version}`,
  });
  return row;
}

/**
 * Publish a draft, audited on BOTH outcomes.
 *
 * A refused activation — the version was not a draft, or somebody else won the
 * race — writes a `refused` audit row too. "Who tried to publish this and was
 * told no" is a question an incident asks, and a table that records only
 * successes has no answer.
 */
export async function activateRetailEligibilityPolicyVersion(
  input: { id: string; approvedByOxyUserId: string; reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailEligibilityPolicyRecord> {
  const existing = await findRetailEligibilityPolicyById(db, input.id);
  if (!existing) throw notFound(`Retail eligibility policy ${input.id} does not exist.`);

  const row = await activateRetailEligibilityPolicy(db, input);
  if (!row) {
    await appendRetailEligibilityAudit(db, {
      action: 'policy_activated',
      subjectTable: 'retail_eligibility_policies',
      subjectId: input.id,
      outcome: 'refused',
      reason: input.reason,
      actorOxyUserId: input.approvedByOxyUserId,
      detail: `status was ${existing.status}, not draft`,
    });
    throw conflict(
      `Retail eligibility policy ${input.id} is ${existing.status}, not draft, so it cannot be activated.`,
    );
  }
  await appendRetailEligibilityAudit(db, {
    action: 'policy_activated',
    subjectTable: 'retail_eligibility_policies',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.approvedByOxyUserId,
    detail: `${row.policyKey} v${row.version}`,
  });
  return row;
}

/** Withdraw a version, audited on both outcomes. */
export async function retireRetailEligibilityPolicyVersion(
  input: { id: string; actorOxyUserId: string; reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailEligibilityPolicyRecord> {
  const row = await retireRetailEligibilityPolicy(db, input.id);
  if (!row) {
    await appendRetailEligibilityAudit(db, {
      action: 'policy_retired',
      subjectTable: 'retail_eligibility_policies',
      subjectId: input.id,
      outcome: 'refused',
      reason: input.reason,
      actorOxyUserId: input.actorOxyUserId,
      detail: 'not a draft or active version',
    });
    throw conflict(`Retail eligibility policy ${input.id} is not a draft or active version.`);
  }
  await appendRetailEligibilityAudit(db, {
    action: 'policy_retired',
    subjectTable: 'retail_eligibility_policies',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.actorOxyUserId,
  });
  return row;
}

/** Record one category's rule under one policy version, audited. */
export async function recordRetailCategoryRule(
  input: NewRetailCategoryRule,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailCategoryRuleRecord> {
  const row = await upsertRetailCategoryRule(db, input);
  await appendRetailEligibilityAudit(db, {
    action: 'category_rule_recorded',
    subjectTable: 'retail_category_rules',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.recordedByOxyUserId,
    detail: `${row.categoryKey}: ${row.admissibility}`,
  });
  return row;
}

/** Record one route's determination under one policy version, audited. */
export async function recordRetailMarketCapability(
  input: NewRetailMarketCapability,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailMarketCapabilityRecord> {
  const row = await upsertRetailMarketCapability(db, input);
  await appendRetailEligibilityAudit(db, {
    action: 'market_capability_recorded',
    subjectTable: 'retail_market_capabilities',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.recordedByOxyUserId,
    detail: `${row.fulfilmentOriginCountry}→${row.destinationCountry} (${row.customerType})`,
  });
  return row;
}
