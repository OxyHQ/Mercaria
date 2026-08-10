/**
 * Reads and writes for `referral_reward_rules` — the immutable rule versions
 * (#144).
 *
 * Every write in this file is either an INSERT of a fresh version or a
 * single-statement CAS from an expected status. There is deliberately no
 * general `updateRule`: a rule version's terms are frozen the moment it leaves
 * `draft` (a database trigger says so), and an API that took a patch would make
 * "edit the live rate" a thing a caller could attempt and a reviewer would have
 * to notice.
 *
 * The version REF a `referral_attributions` row pins is spelled here, once
 * ({@link rewardRuleVersionRef}), so the attribution resolver, the accrual
 * pipeline and every test compute the same string.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  CurrencyCode,
  ReferralConversionType,
  ReferralFundingSourceId,
  ReferralRewardCapPeriod,
  ReferralRewardCurrencyMode,
  ReferralRewardFormula,
  ReferralRewardReversalPolicy,
  ReferralRewardRuleStatus,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralRewardRules } from '../schema/referralRewards.js';

/** A rule version row as the services read it back. */
export type ReferralRewardRuleRow = typeof referralRewardRules.$inferSelect;

/**
 * The pinned spelling of one exact rule version — `<ruleId>@v<version>`.
 *
 * Stated ONCE because it is a contract between two domains that do not import
 * each other's internals: `attribution.service` writes it into
 * `referral_attributions.rule_version_ref` at attribution time (ADR 0005 D19),
 * and the accrual pipeline reads it back weeks later. A second spelling
 * anywhere would resolve to nothing and the reward would silently never accrue.
 */
export function rewardRuleVersionRef(ruleId: string, version: number): string {
  return `${ruleId}@v${String(version)}`;
}

/**
 * The inverse. Returns `undefined` for a ref that names no version — which is
 * what a pre-#144 attribution carries (the bare `commission_rule_ref` a program
 * names), and the accrual refuses it with `no_pinned_rule_version` rather than
 * resolving whichever version happens to be active now.
 */
export function parseRewardRuleVersionRef(
  ref: string,
): { ruleId: string; version: number } | undefined {
  const at = ref.lastIndexOf('@v');
  if (at <= 0) return undefined;
  const ruleId = ref.slice(0, at);
  const version = Number(ref.slice(at + 2));
  if (!Number.isInteger(version) || version < 1) return undefined;
  return { ruleId, version };
}

/** Everything a new rule VERSION is born with. Status is always `draft`. */
export interface CreateRewardRuleVersionInput {
  ruleId: string;
  version: number;
  name: string;
  programId: string;
  campaignRef?: string;
  conversionType: ReferralConversionType;
  fundingSourceId: ReferralFundingSourceId;
  formula: ReferralRewardFormula;
  rateBps?: number;
  fixedAmountMinor?: number;
  currencyMode: ReferralRewardCurrencyMode;
  rewardCurrency?: CurrencyCode;
  effectiveStartAt: Date;
  effectiveEndAt?: Date;
  holdPolicyRef: string;
  holdDays: number;
  minAccrualMinor?: number;
  maxRewardPerConversionMinor?: number;
  maxRewardPerPartnerPeriodMinor?: number;
  partnerCapPeriod?: ReferralRewardCapPeriod;
  maxRewardPerCampaignMinor?: number;
  reversalPolicy: ReferralRewardReversalPolicy;
  termsVersion: string;
  createdByOxyUserId: string;
  supersedesRuleVersionId?: string;
}

export async function insertRewardRuleVersion(
  db: DatabaseOrTransaction,
  input: CreateRewardRuleVersionInput,
): Promise<ReferralRewardRuleRow> {
  const [row] = await db
    .insert(referralRewardRules)
    .values({
      ruleId: input.ruleId,
      version: input.version,
      name: input.name,
      programId: input.programId,
      campaignRef: input.campaignRef ?? null,
      conversionType: input.conversionType,
      fundingSourceId: input.fundingSourceId,
      formula: input.formula,
      rateBps: input.rateBps ?? null,
      fixedAmountMinor: input.fixedAmountMinor ?? null,
      currencyMode: input.currencyMode,
      rewardCurrency: input.rewardCurrency ?? null,
      effectiveStartAt: input.effectiveStartAt,
      effectiveEndAt: input.effectiveEndAt ?? null,
      holdPolicyRef: input.holdPolicyRef,
      holdDays: input.holdDays,
      minAccrualMinor: input.minAccrualMinor ?? null,
      maxRewardPerConversionMinor: input.maxRewardPerConversionMinor ?? null,
      maxRewardPerPartnerPeriodMinor: input.maxRewardPerPartnerPeriodMinor ?? null,
      partnerCapPeriod: input.partnerCapPeriod ?? null,
      maxRewardPerCampaignMinor: input.maxRewardPerCampaignMinor ?? null,
      reversalPolicy: input.reversalPolicy,
      termsVersion: input.termsVersion,
      createdByOxyUserId: input.createdByOxyUserId,
      status: 'draft',
      supersedesRuleVersionId: input.supersedesRuleVersionId ?? null,
    })
    .returning();
  return row;
}

export async function findRewardRuleVersionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralRewardRuleRow | undefined> {
  const [row] = await db
    .select()
    .from(referralRewardRules)
    .where(eq(referralRewardRules.id, id));
  return row;
}

/** The exact version a `<ruleId>@v<version>` ref names, whatever its status. */
export async function findRewardRuleVersion(
  db: DatabaseOrTransaction,
  input: { ruleId: string; version: number },
): Promise<ReferralRewardRuleRow | undefined> {
  const [row] = await db
    .select()
    .from(referralRewardRules)
    .where(
      and(
        eq(referralRewardRules.ruleId, input.ruleId),
        eq(referralRewardRules.version, input.version),
      ),
    );
  return row;
}

/** The one `active` version of a rule, when there is one. */
export async function findActiveRewardRuleVersion(
  db: DatabaseOrTransaction,
  ruleId: string,
): Promise<ReferralRewardRuleRow | undefined> {
  const [row] = await db
    .select()
    .from(referralRewardRules)
    .where(and(eq(referralRewardRules.ruleId, ruleId), eq(referralRewardRules.status, 'active')));
  return row;
}

/** The highest version number a rule has reached, for minting the next one. */
export async function findLatestRewardRuleVersion(
  db: DatabaseOrTransaction,
  ruleId: string,
): Promise<ReferralRewardRuleRow | undefined> {
  const [row] = await db
    .select()
    .from(referralRewardRules)
    .where(eq(referralRewardRules.ruleId, ruleId))
    .orderBy(desc(referralRewardRules.version))
    .limit(1);
  return row;
}

/**
 * Edit a DRAFT's terms. The predicate carries `status = 'draft'`, so the
 * statement is the check: a version somebody activated while the caller was
 * composing its patch matches nothing and the caller gets `undefined`, not a
 * silently applied edit that the trigger would then have refused anyway.
 */
export async function updateRewardRuleDraft(
  db: DatabaseOrTransaction,
  id: string,
  patch: Partial<
    Pick<
      typeof referralRewardRules.$inferInsert,
      | 'name'
      | 'campaignRef'
      | 'conversionType'
      | 'fundingSourceId'
      | 'formula'
      | 'rateBps'
      | 'fixedAmountMinor'
      | 'currencyMode'
      | 'rewardCurrency'
      | 'effectiveStartAt'
      | 'effectiveEndAt'
      | 'holdPolicyRef'
      | 'holdDays'
      | 'minAccrualMinor'
      | 'maxRewardPerConversionMinor'
      | 'maxRewardPerPartnerPeriodMinor'
      | 'partnerCapPeriod'
      | 'maxRewardPerCampaignMinor'
      | 'reversalPolicy'
      | 'termsVersion'
    >
  >,
): Promise<ReferralRewardRuleRow | undefined> {
  const [row] = await db
    .update(referralRewardRules)
    .set(patch)
    .where(and(eq(referralRewardRules.id, id), eq(referralRewardRules.status, 'draft')))
    .returning();
  return row;
}

/**
 * One status transition, as a CAS from a SET of expected statuses. The
 * timestamps the CHECKs demand travel with the transition that defines them.
 */
export async function transitionRewardRuleStatus(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    expected: readonly ReferralRewardRuleStatus[];
    to: ReferralRewardRuleStatus;
    at: Date;
    approvedByOxyUserId?: string;
  },
): Promise<ReferralRewardRuleRow | undefined> {
  const [row] = await db
    .update(referralRewardRules)
    .set({
      status: input.to,
      ...(input.to === 'active'
        ? { activatedAt: input.at, approvedByOxyUserId: input.approvedByOxyUserId }
        : {}),
      ...(input.to === 'superseded' ? { supersededAt: input.at } : {}),
      ...(input.to === 'retired' ? { retiredAt: input.at } : {}),
    })
    .where(
      and(
        eq(referralRewardRules.id, input.id),
        inArray(referralRewardRules.status, [...input.expected]),
      ),
    )
    .returning();
  return row;
}

/** Every version of one rule, newest first — the operator and audit read. */
export async function listRewardRuleVersions(
  db: DatabaseOrTransaction,
  ruleId: string,
): Promise<ReferralRewardRuleRow[]> {
  return await db
    .select()
    .from(referralRewardRules)
    .where(eq(referralRewardRules.ruleId, ruleId))
    .orderBy(desc(referralRewardRules.version));
}
