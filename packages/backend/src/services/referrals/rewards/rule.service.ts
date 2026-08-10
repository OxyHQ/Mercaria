/**
 * The reward-rule version lifecycle: draft → active → superseded → retired
 * (#144 field 14).
 *
 * ## "No rule version can be edited after activation" has three layers
 *
 * The SERVICE: `editRewardRuleDraft` is the only edit path and its statement
 * carries `status = 'draft'` in the predicate, so an activation that landed
 * while a caller was composing a patch matches nothing.
 *
 * The DATABASE: `mercaria_referral_reward_rule_immutable` refuses every column
 * change on a non-draft row and refuses DELETE outright. That is what holds
 * against a migration, a repair script and `psql`, none of which go through
 * this file.
 *
 * The PIN: an attribution records `<ruleId>@v<version>` when it is created (ADR
 * 0005 D19), so even a rule whose ACTIVE version changes cannot move an
 * existing reward — the reward resolves the version it was promised, which by
 * then is `superseded` and still readable.
 *
 * ## Publishing supersedes in ONE transaction
 *
 * `referral_reward_rules_one_active_key` is a partial unique on
 * `(rule_id) WHERE status = 'active'`, so ending the incumbent and activating
 * the successor must commit together — two publishers racing converge on one
 * winner instead of both failing halfway.
 */

import type { ReferralRewardRuleStatus } from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../../lib/errors/error-codes.js';
import { getDb } from '../../../db/postgres.js';
import { appendReferralEvent } from '../../../db/referrals/eventRepository.js';
import {
  findActiveRewardRuleVersion,
  findLatestRewardRuleVersion,
  findRewardRuleVersionById,
  insertRewardRuleVersion,
  rewardRuleVersionRef,
  transitionRewardRuleStatus,
  updateRewardRuleDraft,
  type ReferralRewardRuleRow,
} from '../../../db/referrals/rewardRuleRepository.js';
import { assertNoForbiddenReferralFunding } from './forbidden-funding.js';
import {
  referralRewardRuleDraftSchema,
  type ReferralRewardRuleDraftBody,
} from './rule-schema.js';

/**
 * Validate a raw draft body: the forbidden-funding ANSWER first, then the
 * `.strict()` schema.
 *
 * The order is the point. `.strict()` answers "no" to an unknown key;
 * `assertNoForbiddenReferralFunding` answers "why" for the keys that are
 * attempts at the funding boundary. Running it first is what turns
 * `{ retailMarginShareBps: 500 }` from "unrecognized key" into a sentence about
 * a zero-profit channel.
 */
export function validateRewardRuleDraftBody(body: unknown): ReferralRewardRuleDraftBody {
  if (typeof body !== 'object' || body === null) {
    throw validationError('A reward rule draft must be an object.');
  }
  const record = body as Record<string, unknown>;
  const candidates = [
    ...Object.keys(record),
    // The VALUE too: `{ fundingSourceId: 'mercaria_retail_margin' }` is the same
    // attempt as `{ retailMarginBps: 500 }` and deserves the same answer,
    // rather than an enum error that names twelve members it is not.
    ...(typeof record.fundingSourceId === 'string' ? [record.fundingSourceId] : []),
  ];
  assertNoForbiddenReferralFunding(candidates, 'Referral reward rule');

  const parsed = referralRewardRuleDraftSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw validationError(`Referral reward rule draft is invalid — ${detail}`);
  }
  return parsed.data;
}

/**
 * Draft the NEXT version of a rule (version 1 when it has none).
 *
 * A draft is never the live terms, so nothing here checks an effective window
 * against the clock: a version scheduled to start next month is a perfectly
 * good draft, and refusing it would make forward planning impossible.
 */
export async function draftRewardRuleVersion(body: unknown): Promise<ReferralRewardRuleRow> {
  const draft = validateRewardRuleDraftBody(body);
  const db = getDb();
  return await db.transaction(async (tx) => {
    const latest = await findLatestRewardRuleVersion(tx, draft.ruleId);
    if (latest?.status === 'draft') {
      throw conflict(
        `Rule ${draft.ruleId} already has an unpublished draft (version ${String(latest.version)}). ` +
          'Edit or discard it rather than opening a second.',
      );
    }
    const inserted = await insertRewardRuleVersion(tx, {
      ruleId: draft.ruleId,
      version: (latest?.version ?? 0) + 1,
      name: draft.name,
      programId: draft.programId,
      campaignRef: draft.campaignRef,
      conversionType: draft.conversionType,
      fundingSourceId: draft.fundingSourceId,
      formula: draft.formula,
      rateBps: draft.rateBps,
      fixedAmountMinor: draft.fixedAmountMinor,
      currencyMode: draft.currencyMode,
      rewardCurrency: draft.rewardCurrency,
      effectiveStartAt: new Date(draft.effectiveStartAt),
      effectiveEndAt: draft.effectiveEndAt ? new Date(draft.effectiveEndAt) : undefined,
      holdPolicyRef: draft.holdPolicyRef,
      holdDays: draft.holdDays,
      minAccrualMinor: draft.minAccrualMinor,
      maxRewardPerConversionMinor: draft.maxRewardPerConversionMinor,
      maxRewardPerPartnerPeriodMinor: draft.maxRewardPerPartnerPeriodMinor,
      partnerCapPeriod: draft.partnerCapPeriod,
      maxRewardPerCampaignMinor: draft.maxRewardPerCampaignMinor,
      reversalPolicy: draft.reversalPolicy,
      termsVersion: draft.termsVersion,
      createdByOxyUserId: draft.createdByOxyUserId,
      supersedesRuleVersionId: latest?.id,
    });
    await appendReferralEvent(tx, {
      subjectType: 'reward_rule',
      subjectId: inserted.id,
      action: 'reward_rule_drafted',
      actorKind: 'operator',
      actorRef: draft.createdByOxyUserId,
      reason:
        `${inserted.ruleId}@v${String(inserted.version)}: ${inserted.formula} from ` +
        `${inserted.fundingSourceId}`,
    });
    return inserted;
  });
}

/**
 * Replace a DRAFT's terms wholesale.
 *
 * Wholesale rather than field-by-field: a rule's cross-field agreements
 * (formula ↔ rate, currency mode ↔ currency, cap ↔ period) are only checkable
 * over a complete body, and a partial patch would let a caller reach a state
 * the schema never saw whole.
 */
export async function editRewardRuleDraft(
  id: string,
  body: unknown,
): Promise<ReferralRewardRuleRow> {
  const draft = validateRewardRuleDraftBody(body);
  const db = getDb();
  const existing = await findRewardRuleVersionById(db, id);
  if (!existing) throw notFound('Referral reward rule version not found');
  if (existing.ruleId !== draft.ruleId) {
    throw validationError(
      `A draft cannot change its rule identity (${existing.ruleId} → ${draft.ruleId}). ` +
        'Discard it and draft under the other rule.',
    );
  }
  const updated = await updateRewardRuleDraft(db, id, {
    name: draft.name,
    campaignRef: draft.campaignRef ?? null,
    conversionType: draft.conversionType,
    fundingSourceId: draft.fundingSourceId,
    formula: draft.formula,
    rateBps: draft.rateBps ?? null,
    fixedAmountMinor: draft.fixedAmountMinor ?? null,
    currencyMode: draft.currencyMode,
    rewardCurrency: draft.rewardCurrency ?? null,
    effectiveStartAt: new Date(draft.effectiveStartAt),
    effectiveEndAt: draft.effectiveEndAt ? new Date(draft.effectiveEndAt) : null,
    holdPolicyRef: draft.holdPolicyRef,
    holdDays: draft.holdDays,
    minAccrualMinor: draft.minAccrualMinor ?? null,
    maxRewardPerConversionMinor: draft.maxRewardPerConversionMinor ?? null,
    maxRewardPerPartnerPeriodMinor: draft.maxRewardPerPartnerPeriodMinor ?? null,
    partnerCapPeriod: draft.partnerCapPeriod ?? null,
    maxRewardPerCampaignMinor: draft.maxRewardPerCampaignMinor ?? null,
    reversalPolicy: draft.reversalPolicy,
    termsVersion: draft.termsVersion,
  });
  if (!updated) {
    throw conflict(
      `Rule version ${existing.ruleId}@v${String(existing.version)} is ${existing.status}, not ` +
        'draft: its terms are immutable. Draft a new version instead of editing this one.',
    );
  }
  return updated;
}

/**
 * Activate a draft, ending whatever version was live.
 *
 * One transaction, because the partial unique admits exactly one `active` row
 * per rule — and because a window in which a rule has NO active version is a
 * window in which every accrual under it is refused for a reason that is not
 * true.
 */
export async function activateRewardRuleVersion(input: {
  id: string;
  approvedByOxyUserId: string;
  at?: Date;
}): Promise<ReferralRewardRuleRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const draft = await findRewardRuleVersionById(tx, input.id);
    if (!draft) throw notFound('Referral reward rule version not found');
    if (draft.status !== 'draft') {
      throw conflict(
        `Rule version ${draft.ruleId}@v${String(draft.version)} is ${draft.status} and cannot be ` +
          'activated again.',
      );
    }
    if (draft.createdByOxyUserId === input.approvedByOxyUserId) {
      // The #55/#109 four-eyes shape, applied where it matters most in this
      // domain: a rule version decides what Mercaria pays, and one person able
      // to both write and activate it is one person able to set the rate.
      throw validationError(
        'A reward rule version is approved by somebody other than its author: the terms decide ' +
          'what Mercaria pays, so authoring and approving are two people.',
      );
    }

    const incumbent = await findActiveRewardRuleVersion(tx, draft.ruleId);
    if (incumbent) {
      const ended = await transitionRewardRuleStatus(tx, {
        id: incumbent.id,
        expected: ['active'],
        to: 'superseded',
        at,
      });
      if (!ended) {
        throw conflict(
          `Rule ${draft.ruleId}'s active version changed while publishing. Retry.`,
        );
      }
      await appendReferralEvent(tx, {
        subjectType: 'reward_rule',
        subjectId: ended.id,
        action: 'reward_rule_superseded',
        actorKind: 'operator',
        actorRef: input.approvedByOxyUserId,
        reason: `superseded by ${draft.ruleId}@v${String(draft.version)}`,
      });
    }

    const activated = await transitionRewardRuleStatus(tx, {
      id: draft.id,
      expected: ['draft'],
      to: 'active',
      at,
      approvedByOxyUserId: input.approvedByOxyUserId,
    });
    if (!activated) {
      throw conflict(`Rule version ${draft.ruleId}@v${String(draft.version)} changed while publishing.`);
    }
    await appendReferralEvent(tx, {
      subjectType: 'reward_rule',
      subjectId: activated.id,
      action: 'reward_rule_activated',
      actorKind: 'operator',
      actorRef: input.approvedByOxyUserId,
      reason: `${activated.ruleId}@v${String(activated.version)} is live`,
    });
    return activated;
  });
}

/**
 * Retire a rule version — stop NEW accruals under it.
 *
 * Prospective and nothing else (ADR 0005 D16/D18): rewards already accrued keep
 * their terms, their hold clock and their payout path, because retirement is a
 * business decision about the future and not a reversal case.
 */
export async function retireRewardRuleVersion(input: {
  id: string;
  actorOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<ReferralRewardRuleRow> {
  const at = input.at ?? new Date();
  const expected: ReferralRewardRuleStatus[] = ['active', 'superseded', 'draft'];
  const db = getDb();
  return await db.transaction(async (tx) => {
    const row = await transitionRewardRuleStatus(tx, {
      id: input.id,
      expected,
      to: 'retired',
      at,
    });
    if (!row) {
      const existing = await findRewardRuleVersionById(tx, input.id);
      if (!existing) throw notFound('Referral reward rule version not found');
      if (existing.status === 'retired') return existing;
      throw conflict(
        `Rule version ${existing.ruleId}@v${String(existing.version)} cannot be retired.`,
      );
    }
    await appendReferralEvent(tx, {
      subjectType: 'reward_rule',
      subjectId: row.id,
      action: 'reward_rule_retired',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: input.reason,
    });
    return row;
  });
}

/**
 * The pinned ref for a program's `commission_rule_ref` AS OF NOW.
 *
 * Called by `attribution.service` at the moment an attribution is created (ADR
 * 0005 D19). When the named rule has an active version the ref is exact
 * (`<ruleId>@v<version>`); when it has none the program's own ref is carried
 * through unchanged, so attribution is never BLOCKED by an unpublished rule —
 * the accrual refuses later with `no_pinned_rule_version`, which is a recorded
 * refusal rather than a lost referral.
 */
export async function resolvePinnedRewardRuleRef(
  db: Parameters<typeof findActiveRewardRuleVersion>[0],
  commissionRuleRef: string,
): Promise<string> {
  const active = await findActiveRewardRuleVersion(db, commissionRuleRef);
  return active ? rewardRuleVersionRef(active.ruleId, active.version) : commissionRuleRef;
}
