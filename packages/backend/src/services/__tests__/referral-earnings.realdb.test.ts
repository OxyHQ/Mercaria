/**
 * The referral EARNINGS ledger (#145) against a REAL PostgreSQL database.
 *
 * The eleven cases #145 lists by name, in its own order, each under a `describe`
 * naming it — plus the acceptance criteria that only a real server can settle.
 * They are here rather than against mocks because almost every property #145
 * asks for is one a mocked repository cannot see: the balanced ledger
 * transaction and its zero-sum refusal, the append-only triggers on four tables,
 * the partial unique that makes one reward claimable by exactly one live batch,
 * the four-eyes CHECK on a batch, the widened reward trigger that lets a freeze
 * push a hold FORWARD and nothing pull it back, and the balance itself — which
 * is a `sum()` over real ledger rows with a real sign convention.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every identifier this file writes carries a per-run
 * suffix and teardown deletes exactly what it created — the
 * `referral-rewards.realdb` discipline, whose fixture shapes this file follows.
 *
 * Two calls are deliberately NOT made here, and both for the same reason:
 * `reconcileReferralEarnings` pages over EVERY partner with postings and WRITES
 * a discrepancy row per finding, and `settleApprovedBatches` claims every
 * approved batch in the database. Scoping the assertions would not help — the
 * calls themselves write. The scoped entry points (`reconcilePartner`,
 * `settlePayoutBatch`, `vestDueRewards({ partnerId })`) are what this file
 * drives.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { CurrencyCode } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, getDb, type Database } from '../../db/postgres.js';
import { withTriggerToggleLock } from '../../db/__tests__/trigger-toggle-lock.js';
import {
  referralAttributions,
  referralCampaignBudgets,
  referralCodes,
  referralConversions,
  referralEarningDiscrepancies,
  referralEvents,
  referralLedgerPostings,
  referralPartners,
  referralPayoutBatchItems,
  referralPayoutBatches,
  referralPrograms,
  referralRewardAdjustments,
  referralRewardRules,
  referralRewardTransitions,
  referralRewards,
  referralTouches,
} from '../../db/schema/index.js';
import { ledgerEntries, ledgerTransactions } from '../../db/schema/ledger.js';
import { orderFeeSnapshots } from '../../db/schema/fees.js';
import { orders } from '../../db/schema/orders.js';
import { payments } from '../../db/schema/payments.js';
import { insertLedgerTransaction } from '../../db/payments/ledgerRepository.js';
import { insertAttribution } from '../../db/referrals/attributionRepository.js';
import { insertCampaignBudget } from '../../db/referrals/campaignBudgetRepository.js';
import {
  applyPartnerReadiness,
  transitionPartnerState,
} from '../../db/referrals/partnerRepository.js';
import { upsertProgramControls } from '../../db/referrals/programControlRepository.js';
import { listRewardAdjustments } from '../../db/referrals/rewardRepository.js';
import { listRewardTransitions } from '../../db/referralEarnings/rewardTransitionRepository.js';
import {
  listReferralLedgerPostingsForReward,
  sumRewardPostingObligation,
} from '../../db/referralEarnings/ledgerPostingRepository.js';
import { readReferralPartnerLedgerBalances } from '../../db/referralEarnings/partnerBalanceRepository.js';
import { listEarningDiscrepancies } from '../../db/referralEarnings/discrepancyRepository.js';
import { insertOrder, nextOrderNumber, type NewOrder } from '../../db/orders/orderRepository.js';
import { notApplicableFeeSnapshot } from '../fees/order-fees.service.js';
import { createProgramDraft, publishProgram } from '../referrals/program.service.js';
import { applyAsPartner, approvePartner } from '../referrals/partner.service.js';
import { issueCode } from '../referrals/instrument.service.js';
import {
  recordConversionFromSourceEvent,
  verifyConversion,
} from '../referrals/conversion.service.js';
import {
  activateRewardRuleVersion,
  draftRewardRuleVersion,
} from '../referrals/rewards/rule.service.js';
import {
  accrueRewardForConversion,
  reverseReward,
} from '../referrals/rewards/reward.service.js';
import {
  approvePayoutBatch,
  buildPayoutBatchForPartner,
  cancelPayoutBatch,
  settlePayoutBatch,
} from '../referrals/earnings/payout-batch.service.js';
import {
  registerReferralPayoutRail,
  resetReferralPayoutRail,
  type ReferralPayoutOutcome,
} from '../referrals/earnings/payout-rail.port.js';
import {
  freezePartnerRewards,
  liftPartnerFreeze,
  vestDueRewards,
} from '../referrals/earnings/vesting.service.js';
import { reconcilePartner } from '../referrals/earnings/reconciliation.service.js';
import { readReferralPartnerBalances } from '../referrals/earnings/read.service.js';

process.env.REFERRAL_LINK_TOKEN_SECRET ??= 'realdb-referral-earnings-secret';

let db: Database;

/** Unique to this run; lower-case hex so it can live inside a code spelling. */
const TAG = uuidv7().replace(/-/g, '').slice(-10);
const AUTHOR = `author-${TAG}`;
const APPROVER = `approver-${TAG}`;
const OPERATOR = `operator-${TAG}`;
const EUR: CurrencyCode = 'EUR';
const USD: CurrencyCode = 'USD';

const trackedProgramIds: string[] = [];
const trackedPartnerIds: string[] = [];
const trackedRuleIds: string[] = [];
const trackedPaymentIds: string[] = [];
const trackedOrderIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  resetReferralPayoutRail();

  // Discover every id this run owns by walking DOWN from the tracked roots —
  // the `referral-rewards.realdb` shape. A tracked list per table would go stale
  // the moment a service wrote a child the fixture did not name.
  const versionIds = (
    await db
      .select({ id: referralPrograms.id })
      .from(referralPrograms)
      .where(inArray(referralPrograms.programId, trackedProgramIds.length ? trackedProgramIds : ['-']))
  ).map((row) => row.id);
  const ruleVersionIds = (
    await db
      .select({ id: referralRewardRules.id })
      .from(referralRewardRules)
      .where(inArray(referralRewardRules.ruleId, trackedRuleIds.length ? trackedRuleIds : ['-']))
  ).map((row) => row.id);
  const attributionIds = (
    await db
      .select({ id: referralAttributions.id })
      .from(referralAttributions)
      .where(inArray(referralAttributions.programId, trackedProgramIds.length ? trackedProgramIds : ['-']))
  ).map((row) => row.id);
  const conversionIds = attributionIds.length
    ? (
        await db
          .select({ id: referralConversions.id })
          .from(referralConversions)
          .where(inArray(referralConversions.attributionId, attributionIds))
      ).map((row) => row.id)
    : [];
  const rewardIds = conversionIds.length
    ? (
        await db
          .select({ id: referralRewards.id })
          .from(referralRewards)
          .where(inArray(referralRewards.conversionId, conversionIds))
      ).map((row) => row.id)
    : [];
  const batchIds = trackedPartnerIds.length
    ? (
        await db
          .select({ id: referralPayoutBatches.id })
          .from(referralPayoutBatches)
          .where(inArray(referralPayoutBatches.partnerId, trackedPartnerIds))
      ).map((row) => row.id)
    : [];
  const postingTransactionIds = trackedPartnerIds.length
    ? (
        await db
          .select({ id: referralLedgerPostings.ledgerTransactionId })
          .from(referralLedgerPostings)
          .where(inArray(referralLedgerPostings.partnerId, trackedPartnerIds))
      ).map((row) => row.id)
    : [];
  const codeIds = versionIds.length
    ? (
        await db
          .select({ id: referralCodes.id })
          .from(referralCodes)
          .where(inArray(referralCodes.programVersionId, versionIds))
      ).map((row) => row.id)
    : [];
  const budgetIds = trackedProgramIds.length
    ? (
        await db
          .select({ id: referralCampaignBudgets.id })
          .from(referralCampaignBudgets)
          .where(inArray(referralCampaignBudgets.programId, trackedProgramIds))
      ).map((row) => row.id)
    : [];
  const eventSubjectIds = [
    ...trackedProgramIds,
    ...trackedPartnerIds,
    ...attributionIds,
    ...conversionIds,
    ...rewardIds,
    ...ruleVersionIds,
    ...batchIds,
    ...codeIds,
  ];

  /**
   * SIX append-only guards stand between this fixture and its own rows, and each
   * is switched off inside `withTriggerToggleLock`, on the callback's own `tx`.
   *
   * ONE TABLE PER WINDOW (#301). `alter table … disable trigger` takes
   * ShareRowExclusive, which conflicts with the RowExclusive an ordinary INSERT
   * holds — so a window holding two tables deadlocks against any writer taking
   * the pair the other way round, and the shared mutex cannot see that party at
   * all because it serialises window against window. Splitting is what makes the
   * cycle unbuildable rather than a bet on writer order.
   */
  if (trackedPartnerIds.length > 0) {
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_ledger_postings disable trigger referral_ledger_postings_append_only`,
      );
      await tx
        .delete(referralLedgerPostings)
        .where(inArray(referralLedgerPostings.partnerId, trackedPartnerIds));
      await tx.execute(
        sql`alter table referral_ledger_postings enable trigger referral_ledger_postings_append_only`,
      );
    });
    await db
      .delete(referralEarningDiscrepancies)
      .where(inArray(referralEarningDiscrepancies.partnerId, trackedPartnerIds));
  }
  if (rewardIds.length > 0) {
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_reward_transitions disable trigger referral_reward_transitions_append_only`,
      );
      await tx
        .delete(referralRewardTransitions)
        .where(inArray(referralRewardTransitions.rewardId, rewardIds));
      await tx.execute(
        sql`alter table referral_reward_transitions enable trigger referral_reward_transitions_append_only`,
      );
    });
  }
  if (batchIds.length > 0) {
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_payout_batch_items disable trigger referral_payout_batch_items_guard`,
      );
      await tx
        .delete(referralPayoutBatchItems)
        .where(inArray(referralPayoutBatchItems.batchId, batchIds));
      await tx.execute(
        sql`alter table referral_payout_batch_items enable trigger referral_payout_batch_items_guard`,
      );
    });
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_payout_batches disable trigger referral_payout_batches_guard`,
      );
      await tx.delete(referralPayoutBatches).where(inArray(referralPayoutBatches.id, batchIds));
      await tx.execute(
        sql`alter table referral_payout_batches enable trigger referral_payout_batches_guard`,
      );
    });
  }
  if (rewardIds.length > 0) {
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_reward_adjustments disable trigger referral_reward_adjustments_append_only`,
      );
      await tx
        .delete(referralRewardAdjustments)
        .where(inArray(referralRewardAdjustments.rewardId, rewardIds));
      await tx.execute(
        sql`alter table referral_reward_adjustments enable trigger referral_reward_adjustments_append_only`,
      );
    });
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(sql`alter table referral_rewards disable trigger referral_rewards_frozen`);
      await tx.delete(referralRewards).where(inArray(referralRewards.id, rewardIds));
      await tx.execute(sql`alter table referral_rewards enable trigger referral_rewards_frozen`);
    });
  }
  if (eventSubjectIds.length > 0) {
    await db.delete(referralEvents).where(inArray(referralEvents.subjectId, eventSubjectIds));
  }
  if (conversionIds.length > 0) {
    await db.delete(referralConversions).where(inArray(referralConversions.id, conversionIds));
  }
  if (attributionIds.length > 0) {
    await db.delete(referralAttributions).where(inArray(referralAttributions.id, attributionIds));
  }
  if (versionIds.length > 0) {
    await db.delete(referralTouches).where(inArray(referralTouches.programVersionId, versionIds));
  }
  if (codeIds.length > 0) {
    await db.delete(referralCodes).where(inArray(referralCodes.id, codeIds));
  }
  if (ruleVersionIds.length > 0) {
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_reward_rules disable trigger referral_reward_rules_immutable_once_active`,
      );
      await tx.delete(referralRewardRules).where(inArray(referralRewardRules.id, ruleVersionIds));
      await tx.execute(
        sql`alter table referral_reward_rules enable trigger referral_reward_rules_immutable_once_active`,
      );
    });
  }
  if (budgetIds.length > 0) {
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_campaign_budgets disable trigger referral_campaign_budgets_guard`,
      );
      await tx.delete(referralCampaignBudgets).where(inArray(referralCampaignBudgets.id, budgetIds));
      await tx.execute(
        sql`alter table referral_campaign_budgets enable trigger referral_campaign_budgets_guard`,
      );
    });
  }
  if (trackedPartnerIds.length > 0) {
    await db.delete(referralPartners).where(inArray(referralPartners.id, trackedPartnerIds));
  }
  if (trackedProgramIds.length > 0) {
    await db.delete(referralPrograms).where(inArray(referralPrograms.programId, trackedProgramIds));
  }

  // The ledger last: the postings that named these transactions are gone by now,
  // so the FK no longer blocks. One table per window, children first, because
  // the foreign key requires that order — and #301 is why the two disables are
  // two windows rather than one.
  const chargeTransactionIds = trackedPaymentIds.length
    ? (
        await db
          .select({ id: ledgerTransactions.id })
          .from(ledgerTransactions)
          .where(inArray(ledgerTransactions.paymentId, trackedPaymentIds))
      ).map((row) => row.id)
    : [];
  const allTransactionIds = [...new Set([...chargeTransactionIds, ...postingTransactionIds])];
  if (allTransactionIds.length > 0) {
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(sql`alter table ledger_entries disable trigger ledger_entries_append_only`);
      await tx.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, allTransactionIds));
      await tx.execute(sql`alter table ledger_entries enable trigger ledger_entries_append_only`);
    });
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table ledger_transactions disable trigger ledger_transactions_append_only`,
      );
      await tx.delete(ledgerTransactions).where(inArray(ledgerTransactions.id, allTransactionIds));
      await tx.execute(
        sql`alter table ledger_transactions enable trigger ledger_transactions_append_only`,
      );
    });
  }
  if (trackedPaymentIds.length > 0) {
    await db.delete(payments).where(inArray(payments.id, trackedPaymentIds));
  }
  if (trackedOrderIds.length > 0) {
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table order_fee_snapshots disable trigger order_fee_snapshots_append_only`,
      );
      await tx.delete(orderFeeSnapshots).where(inArray(orderFeeSnapshots.orderId, trackedOrderIds));
      await tx.execute(
        sql`alter table order_fee_snapshots enable trigger order_fee_snapshots_append_only`,
      );
    });
    await db.delete(orders).where(inArray(orders.id, trackedOrderIds));
  }
  await closePostgres();
}, 180_000);

// ─── Fixtures ───────────────────────────────────────────────────────────────

async function makeActiveProgram(ruleId: string): Promise<{ programId: string; versionId: string }> {
  const draft = await createProgramDraft({
    name: `Earnings program ${ruleId}`,
    description: 'Bring a buyer',
    publicTermsSummary: 'Share your code; earn on the first qualifying order.',
    family: 'buyer_referral',
    eligiblePartnerTypes: ['user', 'store'],
    eligibleSubjectKinds: ['oxy_user', 'guest_checkout'],
    markets: [],
    currencies: [],
    channels: [],
    commercialModes: [],
    attributionPolicy: 'last_touch',
    attributionWindowDays: 30,
    qualifyingEventPolicy: 'first_qualifying_paid_order',
    commissionRuleRef: ruleId,
    holdDays: 0,
    payoutPolicyRef: 'stripe-monthly',
    termsVersion: 't1',
    disclosureVersion: 'd1',
    createdByOxyUserId: AUTHOR,
    cohortKeys: [],
  });
  trackedProgramIds.push(draft.programId);
  const published = await publishProgram({ id: draft.id, approvedByOxyUserId: APPROVER });
  return { programId: draft.programId, versionId: published.id };
}

/** An APPROVED partner whose three D15 readiness gates are all `ready`. */
async function makePayablePartner(label: string): Promise<{ id: string }> {
  const { partner } = await applyAsPartner({
    ownerType: 'user',
    ownerId: `owner-${label}-${TAG}`,
    displayName: `Partner ${label}`,
    termsVersion: 't1',
    promotionMethods: ['website'],
  });
  trackedPartnerIds.push(partner.id);
  await approvePartner({ partnerId: partner.id, actorOxyUserId: APPROVER, reason: 'fixture' });
  await applyPartnerReadiness(getDb(), {
    id: partner.id,
    identityReadiness: 'ready',
    taxReadiness: 'ready',
    payoutReadiness: 'ready',
  });
  await getDb()
    .update(referralPartners)
    .set({ payoutBeneficiaryRef: `acct-${label}-${TAG}` })
    .where(eq(referralPartners.id, partner.id));
  return { id: partner.id };
}

type RuleOverrides = Partial<Record<string, unknown>>;

async function makeActiveRule(ruleId: string, overrides: RuleOverrides = {}) {
  trackedRuleIds.push(ruleId);
  const draft = await draftRewardRuleVersion({
    ruleId,
    name: `Rule ${ruleId}`,
    programId: `program-${ruleId}`,
    conversionType: 'first_qualifying_paid_order',
    fundingSourceId: 'connected_marketplace',
    formula: 'percentage_of_realized_base',
    rateBps: 2_000,
    currencyMode: 'fixed_currency',
    rewardCurrency: EUR,
    effectiveStartAt: '2020-01-01T00:00:00.000Z',
    holdPolicyRef: 'buyer-hold-0d',
    // Zero, so the vesting sweep has something DUE in this run without waiting
    // sixty days. The hold's LENGTH is #144's and is pinned there; what #145
    // measures is what happens when it elapses.
    holdDays: 0,
    reversalPolicy: 'proportional_to_realized_base',
    termsVersion: 'referral-terms-v1',
    createdByOxyUserId: AUTHOR,
    ...overrides,
  });
  return await activateRewardRuleVersion({ id: draft.id, approvedByOxyUserId: APPROVER });
}

async function makePaymentWithCommission(
  commissionMinor: number,
  options: { currency?: CurrencyCode; grossMinor?: number } = {},
): Promise<string> {
  const currency = options.currency ?? EUR;
  const gross = options.grossMinor ?? commissionMinor * 5;
  const [payment] = await db
    .insert(payments)
    .values({
      checkoutGroupId: `group-${uuidv7()}`,
      provider: 'mock',
      status: 'succeeded',
      presentmentAmount: gross,
      presentmentCurrency: currency,
    })
    .returning({ id: payments.id });
  trackedPaymentIds.push(payment.id);

  await insertLedgerTransaction(
    db,
    { kind: 'charge_succeeded', description: `fixture charge ${payment.id}`, paymentId: payment.id },
    [
      { account: 'provider_clearing', currency, amountMinor: BigInt(gross) },
      {
        account: 'merchant_payable',
        currency,
        amountMinor: -BigInt(gross - commissionMinor),
        ownerType: 'store',
        ownerId: `store-${TAG}`,
      },
      { account: 'commission_revenue', currency, amountMinor: -BigInt(commissionMinor) },
    ],
  );
  return payment.id;
}

async function returnCommission(
  paymentId: string,
  commissionMinor: number,
  currency: CurrencyCode = EUR,
): Promise<void> {
  await insertLedgerTransaction(
    db,
    { kind: 'refund', description: `fixture refund ${paymentId}`, paymentId },
    [
      { account: 'commission_revenue', currency, amountMinor: BigInt(commissionMinor) },
      { account: 'provider_clearing', currency, amountMinor: -BigInt(commissionMinor) },
    ],
  );
}

async function makeEligibleConversion(input: {
  programId: string;
  programVersionId: string;
  partnerId: string;
  codeId: string;
  ruleVersionRef: string;
  subjectRef: string;
  sourceRef: string;
}): Promise<{ attributionId: string; conversionId: string }> {
  const occurredAt = new Date();
  const attribution = await insertAttribution(getDb(), {
    programId: input.programId,
    subjectKind: 'oxy_user',
    subjectRef: input.subjectRef,
    programVersionId: input.programVersionId,
    partnerId: input.partnerId,
    winningCodeId: input.codeId,
    evidenceTouchKind: 'code_entry_in_app',
    evidenceOccurredAt: new Date(occurredAt.getTime() - 1_000),
    attributionPolicy: 'last_touch',
    ruleVersionRef: input.ruleVersionRef,
    expiresAt: new Date(occurredAt.getTime() + 30 * 24 * 60 * 60 * 1_000),
    originalActorKind: 'oxy_user',
  });
  if (!attribution) throw new Error('attribution fixture produced no row');

  const { conversion } = await recordConversionFromSourceEvent({
    attributionId: attribution.id,
    conversionType: 'first_qualifying_paid_order',
    sourceKind: 'order',
    sourceRef: input.sourceRef,
    sourceEventId: `event-${uuidv7()}`,
    occurredAt,
  });
  const verified = await verifyConversion({ conversionId: conversion.id });
  expect(verified.state).toBe('eligible');
  return { attributionId: attribution.id, conversionId: conversion.id };
}

/** A whole world: program, partner, code, rule, payment, conversion, reward. */
async function makeAccruedReward(input: {
  label: string;
  commissionMinor: number;
  currency?: CurrencyCode;
  ruleOverrides?: RuleOverrides;
}): Promise<{
  programId: string;
  programVersionId: string;
  partnerId: string;
  rewardId: string;
  conversionId: string;
  paymentId: string;
}> {
  const ruleId = `rule-${input.label}-${TAG}`;
  const { programId, versionId } = await makeActiveProgram(ruleId);
  const partner = await makePayablePartner(input.label);
  const code = await issueCode({
    programId,
    partnerId: partner.id,
  });
  const rule = await makeActiveRule(ruleId, {
    ...(input.currency ? { rewardCurrency: input.currency } : {}),
    ...input.ruleOverrides,
  });
  const paymentId = await makePaymentWithCommission(input.commissionMinor, {
    ...(input.currency ? { currency: input.currency } : {}),
  });
  const { conversionId } = await makeEligibleConversion({
    programId,
    programVersionId: versionId,
    partnerId: partner.id,
    codeId: code.id,
    ruleVersionRef: `${rule.ruleId}@v${String(rule.version)}`,
    subjectRef: `subject-${input.label}-${TAG}`,
    sourceRef: `order-${input.label}-${TAG}`,
  });

  const accrual = await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId });
  expect(accrual.outcome).toBe('accrued');
  if (accrual.outcome !== 'accrued') throw new Error('unreachable');
  return {
    programId,
    programVersionId: versionId,
    partnerId: partner.id,
    rewardId: accrual.reward.id,
    conversionId,
    paymentId,
  };
}

/** A rail that always settles, for the cases that need money to actually move. */
function settlingRail(reference: string) {
  return async (): Promise<ReferralPayoutOutcome> => ({
    outcome: 'settled',
    providerReference: reference,
  });
}

/** The signed `referral_payable` position, straight from the ledger. */
async function payableMinor(partnerId: string, currency: CurrencyCode): Promise<number> {
  const balances = await readReferralPartnerLedgerBalances(db, partnerId);
  return balances.find((balance) => balance.currency === currency)?.outstandingMinor ?? 0;
}

/** A whole row plus its `xmin`, so "unchanged" means the tuple was never rewritten. */
async function snapshotRow(table: string, id: string): Promise<Record<string, unknown>> {
  const result = await db.execute(
    sql`select xmin::text as row_version, t.* from ${sql.raw(`"${table}"`)} t where t.id = ${id}`,
  );
  const [row] = result as unknown as Record<string, unknown>[];
  if (!row) throw new Error(`${table} row ${id} not found`);
  return row;
}

// ─── 1. Reward creation and duplicate suppression ────────────────────────────

describe('1. reward creation and duplicate suppression', () => {
  it('books ONE balanced ledger transaction per accrual, and a retry books nothing', async () => {
    const world = await makeAccruedReward({ label: 'dup', commissionMinor: 20_000 });

    const postings = await listReferralLedgerPostingsForReward(db, world.rewardId);
    expect(postings).toHaveLength(1);
    expect(postings[0].kind).toBe('reward_accrued');
    // 20% of 20 000 = 4 000.
    expect(postings[0].amountMinor).toBe(4_000);

    // The ledger transaction itself: two legs, balanced, on the two referral
    // accounts and no others.
    const entries = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, postings[0].ledgerTransactionId));
    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, entry) => sum + entry.amountMinor, 0n)).toBe(0n);
    expect(entries.map((entry) => entry.account).sort()).toEqual([
      'referral_expense',
      'referral_payable',
    ]);
    const payable = entries.find((entry) => entry.account === 'referral_payable');
    expect(payable?.ownerType).toBe('referral_partner');
    expect(payable?.ownerId).toBe(world.partnerId);
    expect(payable?.amountMinor).toBe(-4_000n);

    // The RETRY. `UNIQUE(conversion_id)` returns the same reward, and the
    // posting claim means no second transaction is written — not even the same
    // one back, which is why `xmin` is asserted rather than the column values.
    const before = await snapshotRow('referral_ledger_postings', postings[0].id);
    const retry = await accrueRewardForConversion({
      conversionId: world.conversionId,
      fundingRecordRef: world.paymentId,
    });
    expect(retry.outcome).toBe('accrued');
    if (retry.outcome === 'accrued') expect(retry.created).toBe(false);
    const after = await snapshotRow('referral_ledger_postings', postings[0].id);
    expect(after.row_version).toBe(before.row_version);
    expect(await listReferralLedgerPostingsForReward(db, world.rewardId)).toHaveLength(1);

    // …and the balance says what the reward says. Acceptance 1.
    expect(await payableMinor(world.partnerId, EUR)).toBe(4_000);
  }, 120_000);

  it('refuses to edit or delete a posting — append-only by TRIGGER', async () => {
    const world = await makeAccruedReward({ label: 'append', commissionMinor: 10_000 });
    const [posting] = await listReferralLedgerPostingsForReward(db, world.rewardId);

    let updateError: unknown;
    try {
      await db
        .update(referralLedgerPostings)
        .set({ amountMinor: 1 })
        .where(eq(referralLedgerPostings.id, posting.id));
    } catch (error) {
      updateError = error;
    }
    expect(updateError, 'the UPDATE was accepted').toBeDefined();

    let deleteError: unknown;
    try {
      await db.delete(referralLedgerPostings).where(eq(referralLedgerPostings.id, posting.id));
    } catch (error) {
      deleteError = error;
    }
    expect(deleteError, 'the DELETE was accepted').toBeDefined();
  }, 120_000);
});

// ─── 2. Hold → vested → paid ─────────────────────────────────────────────────

describe('2. hold -> vested -> paid', () => {
  it('walks the whole lifecycle, records every transition, and books the payout', async () => {
    const world = await makeAccruedReward({ label: 'life', commissionMinor: 100_000 });
    // 20% of 100 000 = 20 000, comfortably over the EUR 25.00 minimum.
    const rail = settlingRail(`tr_${TAG}`);
    registerReferralPayoutRail(rail);

    const [held] = await db.select().from(referralRewards).where(eq(referralRewards.id, world.rewardId));
    expect(held.state).toBe('held');

    const vesting = await vestDueRewards({ partnerId: world.partnerId });
    expect(vesting.vested).toBe(1);
    const [vested] = await db.select().from(referralRewards).where(eq(referralRewards.id, world.rewardId));
    expect(vested.state).toBe('vested');
    expect(vested.vestedAt).not.toBeNull();

    // A second pass is a NO-OP: the CAS loses and nothing is appended.
    const again = await vestDueRewards({ partnerId: world.partnerId });
    expect(again.vested).toBe(0);
    expect(await listRewardTransitions(db, world.rewardId)).toHaveLength(1);

    const built = await buildPayoutBatchForPartner({
      partnerId: world.partnerId,
      programId: world.programId,
      currency: EUR,
      createdByOxyUserId: 'system',
    });
    expect(built.outcome).toBe('opened');
    if (built.outcome !== 'opened') return;
    expect(built.batch.grossEligibleMinor).toBe(20_000);
    expect(built.batch.netPayoutMinor).toBe(20_000);

    await approvePayoutBatch({
      batchId: built.batch.id,
      approvedByOxyUserId: OPERATOR,
      reason: 'monthly run',
    });
    const settled = await settlePayoutBatch({ batchId: built.batch.id });
    expect(settled.outcome).toBe('settled');
    if (settled.outcome !== 'settled') return;
    expect(settled.batch.status).toBe('paid');
    expect(settled.batch.providerReference).toBe(`tr_${TAG}`);

    const [paid] = await db.select().from(referralRewards).where(eq(referralRewards.id, world.rewardId));
    expect(paid.state).toBe('paid');
    expect(paid.paidAt).not.toBeNull();

    // The payout DEBITED the payable and CREDITED the platform balance, so the
    // partner is owed nothing and `settledMinor` reports what moved.
    expect(await payableMinor(world.partnerId, EUR)).toBe(0);
    const [balance] = await readReferralPartnerLedgerBalances(db, world.partnerId);
    expect(balance.settledMinor).toBe(20_000);

    // The trail: hold_elapsed then payout_settled, in order, each once.
    const transitions = await listRewardTransitions(db, world.rewardId);
    expect(transitions.map((row) => `${row.fromState}->${row.toState}`)).toEqual([
      'held->vested',
      'vested->paid',
    ]);
    expect(transitions.map((row) => row.cause)).toEqual(['hold_elapsed', 'payout_settled']);
  }, 180_000);

  it('freezing stops the hold clock and lifting resumes it where it stopped', async () => {
    // A hold long enough to have time left on it, so the PUSH is measurable.
    const world = await makeAccruedReward({
      label: 'freeze',
      commissionMinor: 50_000,
      ruleOverrides: { holdDays: 30 },
    });
    const [before] = await db.select().from(referralRewards).where(eq(referralRewards.id, world.rewardId));

    await freezePartnerRewards({
      partnerId: world.partnerId,
      cause: 'partner_suspended',
      sourceRef: `case-${TAG}`,
      actorKind: 'operator',
      actorRef: OPERATOR,
      reason: 'fraud review opened',
    });
    const [frozen] = await db.select().from(referralRewards).where(eq(referralRewards.id, world.rewardId));
    expect(frozen.state).toBe('frozen');
    expect(frozen.frozenFromState).toBe('held');
    expect(frozen.holdUntilAt.getTime()).toBe(before.holdUntilAt.getTime());

    await new Promise((resolve) => setTimeout(resolve, 25));
    await liftPartnerFreeze({
      partnerId: world.partnerId,
      sourceRef: `case-${TAG}`,
      actorKind: 'operator',
      actorRef: OPERATOR,
      reason: 'review cleared',
    });
    const [lifted] = await db.select().from(referralRewards).where(eq(referralRewards.id, world.rewardId));
    expect(lifted.state).toBe('held');
    expect(lifted.frozenFromState).toBeNull();
    // FORWARD, by at least the frozen duration. The trigger #145 widened is
    // what permits this at all, and only in this direction.
    expect(lifted.holdUntilAt.getTime()).toBeGreaterThan(before.holdUntilAt.getTime());

    // …and the reverse move is REFUSED by that same trigger.
    let pullBack: unknown;
    try {
      await db
        .update(referralRewards)
        .set({ holdUntilAt: new Date(before.holdUntilAt.getTime() - 60_000) })
        .where(eq(referralRewards.id, world.rewardId));
    } catch (error) {
      pullBack = error;
    }
    expect(pullBack, 'a reward was allowed to vest earlier').toBeDefined();
  }, 180_000);
});

// ─── 3. Reversal before payout ───────────────────────────────────────────────

describe('3. reversal before payout', () => {
  it('books the reversal, voids the reward and returns the balance to zero', async () => {
    const world = await makeAccruedReward({ label: 'revpre', commissionMinor: 30_000 });
    expect(await payableMinor(world.partnerId, EUR)).toBe(6_000);

    // The whole commission comes back — a full refund.
    await returnCommission(world.paymentId, 30_000);
    const result = await reverseReward({
      rewardId: world.rewardId,
      cause: 'order_fully_refunded',
      sourceRef: `refund-${TAG}`,
      reason: 'buyer returned everything',
    });
    expect(result?.created).toBe(true);
    expect(result?.reward.state).toBe('voided');
    expect(result?.reward.netAmountMinor).toBe(0);
    expect(result?.adjustment.recoveryState).toBe('offset_against_balance');
    expect(result?.adjustment.liabilityAmountMinor).toBe(0);

    expect(await payableMinor(world.partnerId, EUR)).toBe(0);
    const postings = await listReferralLedgerPostingsForReward(db, world.rewardId);
    expect(postings.map((row) => row.kind)).toEqual(['reward_accrued', 'reward_reversed']);
    expect(await sumRewardPostingObligation(db, world.rewardId)).toBe(0);

    // A REPLAY writes nothing at all — not the adjustment, not the posting.
    const replay = await reverseReward({
      rewardId: world.rewardId,
      cause: 'order_fully_refunded',
      sourceRef: `refund-${TAG}`,
      reason: 'the same refund, delivered twice',
    });
    expect(replay?.created).toBe(false);
    expect(await listReferralLedgerPostingsForReward(db, world.rewardId)).toHaveLength(2);
    expect(await listRewardAdjustments(db, world.rewardId)).toHaveLength(1);
  }, 180_000);
});

// ─── 4. Reversal after payout ────────────────────────────────────────────────

describe('4. reversal after payout', () => {
  it('never un-pays, records a partner liability and lets the payable go NEGATIVE', async () => {
    const world = await makeAccruedReward({ label: 'revpost', commissionMinor: 200_000 });
    registerReferralPayoutRail(settlingRail(`tr_post_${TAG}`));
    await vestDueRewards({ partnerId: world.partnerId });
    const built = await buildPayoutBatchForPartner({
      partnerId: world.partnerId,
      programId: world.programId,
      currency: EUR,
      createdByOxyUserId: 'system',
    });
    if (built.outcome !== 'opened') throw new Error('the batch fixture produced nothing');
    await approvePayoutBatch({
      batchId: built.batch.id,
      approvedByOxyUserId: OPERATOR,
      reason: 'monthly run',
    });
    const settled = await settlePayoutBatch({ batchId: built.batch.id });
    expect(settled.outcome).toBe('settled');
    expect(await payableMinor(world.partnerId, EUR)).toBe(0);

    const paidSnapshot = await snapshotRow('referral_rewards', world.rewardId);

    // The funding disappears AFTER the money left.
    await returnCommission(world.paymentId, 200_000);
    const reversal = await reverseReward({
      rewardId: world.rewardId,
      cause: 'order_fully_refunded',
      sourceRef: `refund-post-${TAG}`,
      reason: 'refunded after the partner was paid',
    });
    expect(reversal?.created).toBe(true);
    // ADR 0005 R7: the payout is never un-paid and the paid record is never
    // rewritten.
    expect(reversal?.reward.state).toBe('paid');
    const afterSnapshot = await snapshotRow('referral_rewards', world.rewardId);
    expect(afterSnapshot.paid_at).toEqual(paidSnapshot.paid_at);
    expect(reversal?.adjustment.recoveryState).toBe('partner_liability');
    expect(reversal?.adjustment.liabilityAmountMinor).toBe(40_000);

    // The balance is now a RECEIVABLE, which is a real state rather than a bug.
    expect(await payableMinor(world.partnerId, EUR)).toBe(-40_000);
    const postings = await listReferralLedgerPostingsForReward(db, world.rewardId);
    expect(postings.map((row) => row.kind)).toEqual(['reward_accrued', 'reward_reversed']);
  }, 180_000);
});

// ─── 5. Partial refund allocation ────────────────────────────────────────────

describe('5. partial refund allocation', () => {
  it('recomputes the net from the base as it now stands and books only the delta', async () => {
    const world = await makeAccruedReward({ label: 'partial', commissionMinor: 50_000 });
    expect(await payableMinor(world.partnerId, EUR)).toBe(10_000);

    // Half the commission returns. 20% of the remaining 25 000 is 5 000.
    await returnCommission(world.paymentId, 25_000);
    const result = await reverseReward({
      rewardId: world.rewardId,
      cause: 'order_partially_refunded',
      sourceRef: `refund-half-${TAG}`,
      reason: 'one line refunded',
    });
    expect(result?.reward.netAmountMinor).toBe(5_000);
    // The STATE is untouched: a partial reversal lowers the net and moves
    // nothing else, so there is no transition row for it either.
    expect(result?.reward.state).toBe('held');
    expect(await listRewardTransitions(db, world.rewardId)).toHaveLength(0);
    expect(result?.adjustment.deltaAmountMinor).toBe(-5_000);

    expect(await payableMinor(world.partnerId, EUR)).toBe(5_000);
    // `Σ deltas + gross == net`, and the postings say the same thing.
    expect(await sumRewardPostingObligation(db, world.rewardId)).toBe(5_000);
  }, 180_000);
});

// ─── 6. Multi-currency ───────────────────────────────────────────────────────

describe('6. multi-currency handling', () => {
  it('keeps each currency’s balance separate and converts nothing', async () => {
    const eur = await makeAccruedReward({ label: 'mceur', commissionMinor: 40_000 });
    // The SAME partner earns in a second currency, under its own rule.
    const usdRuleId = `rule-mcusd-${TAG}`;
    const usdProgram = await makeActiveProgram(usdRuleId);
    const usdCode = await issueCode({
      programId: usdProgram.programId,
      partnerId: eur.partnerId,
    });
    const usdRule = await makeActiveRule(usdRuleId, { rewardCurrency: USD });
    const usdPayment = await makePaymentWithCommission(60_000, { currency: USD });
    const { conversionId } = await makeEligibleConversion({
      programId: usdProgram.programId,
      programVersionId: usdProgram.versionId,
      partnerId: eur.partnerId,
      codeId: usdCode.id,
      ruleVersionRef: `${usdRule.ruleId}@v${String(usdRule.version)}`,
      subjectRef: `subject-mcusd-${TAG}`,
      sourceRef: `order-mcusd-${TAG}`,
    });
    const accrual = await accrueRewardForConversion({
      conversionId,
      fundingRecordRef: usdPayment,
    });
    expect(accrual.outcome).toBe('accrued');

    const balances = await readReferralPartnerLedgerBalances(db, eur.partnerId);
    const byCurrency = new Map(balances.map((row) => [row.currency, row.outstandingMinor]));
    expect(byCurrency.get('EUR')).toBe(8_000);
    expect(byCurrency.get('USD')).toBe(12_000);
    // Nothing summed the two into one figure — there is no such figure.
    expect(balances).toHaveLength(2);

    // A batch is per currency, and USD publishes no minimum, so it is BLOCKED
    // rather than defaulted to zero.
    await vestDueRewards({ partnerId: eur.partnerId });
    const usdBatch = await buildPayoutBatchForPartner({
      partnerId: eur.partnerId,
      programId: usdProgram.programId,
      currency: USD,
      createdByOxyUserId: 'system',
    });
    expect(usdBatch.outcome).toBe('nothing_payable');
    if (usdBatch.outcome === 'nothing_payable') {
      expect(usdBatch.reasons).toContain('payout_minimum_not_published');
    }
  }, 240_000);
});

// ─── 7. Payout retry ─────────────────────────────────────────────────────────

describe('7. payout retry', () => {
  it('fails visibly with no rail, keeps its claims, and settles on the SAME key later', async () => {
    const world = await makeAccruedReward({ label: 'retry', commissionMinor: 150_000 });
    resetReferralPayoutRail();
    await vestDueRewards({ partnerId: world.partnerId });
    const built = await buildPayoutBatchForPartner({
      partnerId: world.partnerId,
      programId: world.programId,
      currency: EUR,
      createdByOxyUserId: 'system',
    });
    if (built.outcome !== 'opened') throw new Error('the batch fixture produced nothing');
    await approvePayoutBatch({
      batchId: built.batch.id,
      approvedByOxyUserId: OPERATOR,
      reason: 'monthly run',
    });

    const firstAttempt = await settlePayoutBatch({ batchId: built.batch.id });
    expect(firstAttempt.outcome).toBe('failed');
    if (firstAttempt.outcome !== 'failed') return;
    // The seam #146 fills, failing CLOSED and saying why.
    expect(firstAttempt.reason).toBe('rail_not_configured');
    expect(firstAttempt.batch.status).toBe('failed');

    // The claims are KEPT. Releasing them on failure would let the retry and the
    // next batch both carry the same reward.
    const items = await db
      .select()
      .from(referralPayoutBatchItems)
      .where(eq(referralPayoutBatchItems.batchId, built.batch.id));
    expect(items).toHaveLength(1);
    expect(items[0].releasedAt).toBeNull();
    // …and the reward is still `vested`, not paid.
    const [reward] = await db.select().from(referralRewards).where(eq(referralRewards.id, world.rewardId));
    expect(reward.state).toBe('vested');

    // The retry rides the batch's own key, unchanged across attempts.
    let seenKey: string | undefined;
    registerReferralPayoutRail(async (request) => {
      seenKey = request.idempotencyKey;
      return { outcome: 'settled', providerReference: `tr_retry_${TAG}` };
    });
    const secondAttempt = await settlePayoutBatch({ batchId: built.batch.id });
    expect(secondAttempt.outcome).toBe('settled');
    expect(seenKey).toBe(`refpay:${built.batch.id}`);
    expect(await payableMinor(world.partnerId, EUR)).toBe(0);
  }, 240_000);

  it('refuses a second live batch for the same partner and currency', async () => {
    const world = await makeAccruedReward({ label: 'onebatch', commissionMinor: 150_000 });
    registerReferralPayoutRail(settlingRail(`tr_one_${TAG}`));
    await vestDueRewards({ partnerId: world.partnerId });
    const first = await buildPayoutBatchForPartner({
      partnerId: world.partnerId,
      programId: world.programId,
      currency: EUR,
      createdByOxyUserId: 'system',
    });
    expect(first.outcome).toBe('opened');
    const second = await buildPayoutBatchForPartner({
      partnerId: world.partnerId,
      programId: world.programId,
      currency: EUR,
      createdByOxyUserId: 'system',
    });
    expect(second.outcome).toBe('batch_already_open');

    // Cancelling RELEASES the claims — the only status that does — and the item
    // row survives, so which batch held which reward stays answerable.
    if (first.outcome !== 'opened') return;
    const cancelled = await cancelPayoutBatch({
      batchId: first.batch.id,
      cancelledByOxyUserId: OPERATOR,
      reason: 'rebuilding after a correction',
    });
    expect(cancelled.released).toBe(1);
    const items = await db
      .select()
      .from(referralPayoutBatchItems)
      .where(eq(referralPayoutBatchItems.batchId, first.batch.id));
    expect(items).toHaveLength(1);
    expect(items[0].releasedAt).not.toBeNull();

    // …and a release cannot be taken back.
    let unrelease: unknown;
    try {
      await db
        .update(referralPayoutBatchItems)
        .set({ releasedAt: null })
        .where(eq(referralPayoutBatchItems.id, items[0].id));
    } catch (error) {
      unrelease = error;
    }
    expect(unrelease, 'a released claim was taken back').toBeDefined();

    const rebuilt = await buildPayoutBatchForPartner({
      partnerId: world.partnerId,
      programId: world.programId,
      currency: EUR,
      createdByOxyUserId: 'system',
    });
    expect(rebuilt.outcome).toBe('opened');
  }, 240_000);

  it('refuses an approval by the person who opened the batch (four eyes)', async () => {
    const world = await makeAccruedReward({ label: 'foureyes', commissionMinor: 150_000 });
    await vestDueRewards({ partnerId: world.partnerId });
    const built = await buildPayoutBatchForPartner({
      partnerId: world.partnerId,
      programId: world.programId,
      currency: EUR,
      createdByOxyUserId: OPERATOR,
    });
    if (built.outcome !== 'opened') throw new Error('the batch fixture produced nothing');
    let selfApproval: unknown;
    try {
      await approvePayoutBatch({
        batchId: built.batch.id,
        approvedByOxyUserId: OPERATOR,
        reason: 'approving my own batch',
      });
    } catch (error) {
      selfApproval = error;
    }
    expect(selfApproval, 'a hand-opened batch approved itself').toBeDefined();
    // …and a second pair of eyes is accepted.
    const approved = await approvePayoutBatch({
      batchId: built.batch.id,
      approvedByOxyUserId: APPROVER,
      reason: 'reviewed',
    });
    expect(approved.status).toBe('approved');
  }, 240_000);
});

// ─── 8. Budget cap exhaustion ────────────────────────────────────────────────

describe('8. budget cap exhaustion', () => {
  it('books NOTHING when the accrual is refused', async () => {
    const ruleId = `rule-budget-${TAG}`;
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makePayablePartner('budget');
    const code = await issueCode({
      programId,
      partnerId: partner.id,
    });
    // A budget that cannot cover the bounty.
    await insertCampaignBudget(db, {
      programId,
      campaignRef: `camp-${TAG}`,
      name: 'Tiny budget',
      currency: EUR,
      budgetMinor: 100,
      createdByOxyUserId: AUTHOR,
    });
    const rule = await makeActiveRule(ruleId, {
      programId,
      campaignRef: `camp-${TAG}`,
      fundingSourceId: 'fixed_budget',
      formula: 'fixed_amount',
      rateBps: undefined,
      fixedAmountMinor: 5_000,
    });
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${rule.ruleId}@v${String(rule.version)}`,
      subjectRef: `subject-budget-${TAG}`,
      sourceRef: `order-budget-${TAG}`,
    });

    const accrual = await accrueRewardForConversion({ conversionId });
    expect(accrual.outcome).toBe('refused');
    if (accrual.outcome === 'refused') expect(accrual.reason).toBe('budget_exhausted');

    // The whole point: a refused accrual leaves the BOOK untouched. An audit row
    // says why (#144), and there is no money to un-book.
    const postings = await db
      .select()
      .from(referralLedgerPostings)
      .where(eq(referralLedgerPostings.partnerId, partner.id));
    expect(postings).toHaveLength(0);
    expect(await payableMinor(partner.id, EUR)).toBe(0);
  }, 180_000);
});

// ─── 9. Program disabled with existing balances ──────────────────────────────

describe('9. referral program disabled with existing balances', () => {
  it('stops NEW payouts and preserves every earned record', async () => {
    const world = await makeAccruedReward({ label: 'disable', commissionMinor: 150_000 });
    await vestDueRewards({ partnerId: world.partnerId });
    const balanceBefore = await payableMinor(world.partnerId, EUR);
    expect(balanceBefore).toBe(30_000);

    await upsertProgramControls(db, {
      programId: world.programId,
      redirectEnabled: false,
      attributionEnabled: false,
      payoutEnabled: false,
      updatedByOxyUserId: OPERATOR,
      reason: 'program paused',
    });

    const built = await buildPayoutBatchForPartner({
      partnerId: world.partnerId,
      programId: world.programId,
      currency: EUR,
      createdByOxyUserId: 'system',
    });
    expect(built.outcome).toBe('nothing_payable');
    if (built.outcome === 'nothing_payable') {
      expect(built.reasons).toContain('program_payout_paused');
    }

    // Every earned record is exactly where it was. ADR 0005 D18: gate loops and
    // gates, never records.
    expect(await payableMinor(world.partnerId, EUR)).toBe(balanceBefore);
    const [reward] = await db.select().from(referralRewards).where(eq(referralRewards.id, world.rewardId));
    expect(reward.state).toBe('vested');
    expect(reward.netAmountMinor).toBe(30_000);

    // And the balance projection reports it as UNPAYABLE rather than as absent —
    // the distinction a partner-support question turns on.
    const projected = await readReferralPartnerBalances({
      partnerId: world.partnerId,
      programId: world.programId,
    });
    expect(projected[0].outstandingMinor).toBe(30_000);
    expect(projected[0].payableNowMinor).toBe(0);
  }, 180_000);

  it('withholds a SUSPENDED partner without voiding anything', async () => {
    const world = await makeAccruedReward({ label: 'suspend', commissionMinor: 150_000 });
    await vestDueRewards({ partnerId: world.partnerId });
    await transitionPartnerState(db, {
      id: world.partnerId,
      expected: ['approved'],
      to: 'suspended',
      at: new Date(),
    });

    const built = await buildPayoutBatchForPartner({
      partnerId: world.partnerId,
      programId: world.programId,
      currency: EUR,
      createdByOxyUserId: 'system',
    });
    expect(built.outcome).toBe('nothing_payable');
    if (built.outcome === 'nothing_payable') {
      expect(built.reasons).toContain('partner_suspended');
    }
    expect(await payableMinor(world.partnerId, EUR)).toBe(30_000);
  }, 180_000);
});

// ─── 10. A reward can never be funded from mercaria_retail ───────────────────

describe('10. funding a reward from mercaria_retail margin or cost variance FAILS', () => {
  it('has no representable posting against any retail account', async () => {
    const world = await makeAccruedReward({ label: 'retailwall', commissionMinor: 20_000 });
    // Every entry this domain has EVER written, for this partner, walked by
    // account. The forbidden set is the whole rest of Mercaria's chart.
    const [posting] = await listReferralLedgerPostingsForReward(db, world.rewardId);
    const entries = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, posting.ledgerTransactionId));
    for (const entry of entries) {
      expect(['referral_expense', 'referral_payable', 'provider_clearing']).toContain(entry.account);
    }

    // And the database itself refuses the forged version: a referral posting
    // naming a retail cost account is refused by the ledger's own CHECK the
    // moment it is unbalanced, and by the domain's assertion before that. Here
    // it is the ACCOUNT boundary that matters — a `retail_cost_recovery` entry
    // owned by a referral partner is not something any builder can produce.
    let forged: unknown;
    try {
      await insertLedgerTransaction(
        db,
        { kind: 'referral_reward_accrued', description: 'forged retail funding' },
        [
          {
            account: 'referral_payable',
            currency: EUR,
            amountMinor: -1_000n,
            ownerType: 'referral_partner',
            ownerId: world.partnerId,
          },
          // Unbalanced ON PURPOSE in the same way a wrong-account posting would
          // be: the repository refuses before any SQL, which is the layer that
          // catches a composition error whatever account it names.
          { account: 'retail_cost_recovery', currency: USD, amountMinor: 1_000n },
        ],
      );
    } catch (error) {
      forged = error;
    }
    expect(forged, 'a cross-account referral posting was accepted').toBeDefined();
  }, 180_000);

  it('leaves a mercaria_retail order and its fee snapshot byte-identical', async () => {
    // A REAL retail order beside a REAL accrual. #145 zero-profit protection 5:
    // the referral changes neither the customer amount nor #128's reconciliation
    // inputs, and `xmin` is what makes "unchanged" mean the tuple was never
    // rewritten rather than that the values happen to match.
    const dual = (amount: number) =>
      ({ shop: { amount, currency: EUR }, presentment: { amount, currency: EUR } }) as const;
    const doc: NewOrder = {
      orderNumber: await nextOrderNumber(),
      buyerOrigin: 'oxy',
      buyerOxyUserId: `buyer-${uuidv7()}`,
      sellerType: 'platform',
      commercialRole: 'mercaria_retail',
      shippingAddress: {
        recipientName: 'Buyer',
        line1: '1 Market Street',
        city: 'Valencia',
        postalCode: '46001',
        country: 'ES',
      },
      shippingMethod: 'standard',
      shippingLabel: 'Standard shipping',
      shippingCost: dual(0),
      totals: {
        subtotal: dual(12_345),
        discountTotal: dual(0),
        shipping: dual(0),
        tax: dual(0),
        grandTotal: dual(12_345),
      },
      status: 'pending_payment',
      paymentStatus: 'unpaid',
      checkoutGroupId: uuidv7(),
      items: [
        {
          listingId: `listing-${uuidv7()}`,
          variantId: `variant-${uuidv7()}`,
          title: 'Retail line',
          variantTitle: 'Default Title',
          optionValues: [],
          unitPrice: dual(12_345),
          quantity: 1,
          lineTotal: dual(12_345),
        },
      ],
      statusHistory: [{ status: 'pending_payment', at: new Date(), actorKind: 'system' }],
      appliedDiscounts: [],
      taxLines: [],
      feeSnapshot: notApplicableFeeSnapshot('mercaria_retail'),
    };
    const order = await insertOrder(doc);
    trackedOrderIds.push(order.id);

    const orderBefore = await snapshotRow('orders', order.id);
    const [snapshotRowBefore] = await db
      .select()
      .from(orderFeeSnapshots)
      .where(eq(orderFeeSnapshots.orderId, order.id));
    const feeBefore = await snapshotRow('order_fee_snapshots', snapshotRowBefore.id);

    await makeAccruedReward({ label: 'retailorder', commissionMinor: 20_000 });

    expect(await snapshotRow('orders', order.id)).toEqual(orderBefore);
    expect(await snapshotRow('order_fee_snapshots', snapshotRowBefore.id)).toEqual(feeBefore);
    // …and the retail order pays NO marketplace fee, which is what leaves the
    // referral nothing to have taken a share of.
    expect(snapshotRowBefore.feeAmount).toBeNull();
    expect(snapshotRowBefore.commercialMode).toBe('mercaria_retail');
  }, 180_000);
});

// ─── 11. A budgeted bounty stays independent of buyer cost ───────────────────

describe('11. a separately budgeted bounty is independent of buyer cost and #128', () => {
  it('books against referral_expense and touches no retail or customer account', async () => {
    const ruleId = `rule-bounty-${TAG}`;
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makePayablePartner('bounty');
    const code = await issueCode({
      programId,
      partnerId: partner.id,
    });
    await insertCampaignBudget(db, {
      programId,
      campaignRef: `camp-bounty-${TAG}`,
      name: 'Acquisition budget',
      currency: EUR,
      budgetMinor: 100_000,
      createdByOxyUserId: AUTHOR,
    });
    const rule = await makeActiveRule(ruleId, {
      programId,
      campaignRef: `camp-bounty-${TAG}`,
      fundingSourceId: 'fixed_budget',
      formula: 'fixed_amount',
      rateBps: undefined,
      fixedAmountMinor: 5_000,
    });
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${rule.ruleId}@v${String(rule.version)}`,
      subjectRef: `subject-bounty-${TAG}`,
      sourceRef: `order-bounty-${TAG}`,
    });
    const accrual = await accrueRewardForConversion({ conversionId });
    expect(accrual.outcome).toBe('accrued');
    if (accrual.outcome !== 'accrued') return;

    // The bounty is a MERCARIA MARKETING EXPENSE: it debits `referral_expense`
    // and credits the partner's payable, and that is the whole of it. No retail
    // cost account, no customer adjustment, no buyer amount anywhere.
    const [posting] = await listReferralLedgerPostingsForReward(db, accrual.reward.id);
    const entries = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, posting.ledgerTransactionId));
    expect(entries.map((entry) => entry.account).sort()).toEqual([
      'referral_expense',
      'referral_payable',
    ]);
    expect(entries.reduce((sum, entry) => sum + entry.amountMinor, 0n)).toBe(0n);
    expect(await payableMinor(partner.id, EUR)).toBe(5_000);

    // The campaign budget was claimed atomically and the reward names it.
    const [budget] = await db
      .select()
      .from(referralCampaignBudgets)
      .where(eq(referralCampaignBudgets.campaignRef, `camp-bounty-${TAG}`));
    expect(budget.claimedMinor).toBe(5_000);
    expect(accrual.reward.campaignBudgetId).toBe(budget.id);
  }, 180_000);
});

// ─── The reconciliation sweep ADR 0005 gates this issue on ───────────────────

describe('the reconciliation sweep', () => {
  it('finds nothing when the two stores agree', async () => {
    const world = await makeAccruedReward({ label: 'recon-ok', commissionMinor: 20_000 });
    const result = await reconcilePartner(db, { partnerId: world.partnerId, at: new Date() });
    // The vacuity floor: a pass that scanned NOTHING and a pass that found
    // nothing produce the same `findings: 0`, and only this tells them apart.
    expect(result.rewardsScanned).toBeGreaterThanOrEqual(1);
    expect(result.findings).toBe(0);
  }, 180_000);

  it('DETECTS a reward whose accrual never booked, and repairs nothing', async () => {
    const world = await makeAccruedReward({ label: 'recon-gap', commissionMinor: 20_000 });
    const [posting] = await listReferralLedgerPostingsForReward(db, world.rewardId);

    // Remove the posting the way only a fault could — through the append-only
    // guard, inside a window. This is the mutation that makes the probe's zero
    // above mean something.
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_ledger_postings disable trigger referral_ledger_postings_append_only`,
      );
      await tx.delete(referralLedgerPostings).where(eq(referralLedgerPostings.id, posting.id));
      await tx.execute(
        sql`alter table referral_ledger_postings enable trigger referral_ledger_postings_append_only`,
      );
    });

    const result = await reconcilePartner(db, { partnerId: world.partnerId, at: new Date() });
    expect(result.findings).toBeGreaterThanOrEqual(1);
    const findings = await listEarningDiscrepancies(db, {
      partnerId: world.partnerId,
      limit: 20,
    });
    expect(findings.map((row) => row.kind)).toContain('ledger_posting_missing');

    // It DETECTED and repaired NOTHING: the reward is exactly as it was, and no
    // posting was invented to make the books agree.
    const [reward] = await db.select().from(referralRewards).where(eq(referralRewards.id, world.rewardId));
    expect(reward.netAmountMinor).toBe(4_000);
    expect(await listReferralLedgerPostingsForReward(db, world.rewardId)).toHaveLength(0);

    // A second pass converges on the row it already wrote rather than piling up.
    await reconcilePartner(db, { partnerId: world.partnerId, at: new Date() });
    const again = await listEarningDiscrepancies(db, { partnerId: world.partnerId, limit: 20 });
    expect(again.filter((row) => row.kind === 'ledger_posting_missing')).toHaveLength(1);
  }, 180_000);

  it('does not REOPEN a finding an operator has resolved', async () => {
    const world = await makeAccruedReward({ label: 'recon-resolved', commissionMinor: 20_000 });
    const [posting] = await listReferralLedgerPostingsForReward(db, world.rewardId);
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_ledger_postings disable trigger referral_ledger_postings_append_only`,
      );
      await tx.delete(referralLedgerPostings).where(eq(referralLedgerPostings.id, posting.id));
      await tx.execute(
        sql`alter table referral_ledger_postings enable trigger referral_ledger_postings_append_only`,
      );
    });
    await reconcilePartner(db, { partnerId: world.partnerId, at: new Date() });
    const [finding] = await listEarningDiscrepancies(db, {
      partnerId: world.partnerId,
      limit: 5,
    });
    await db
      .update(referralEarningDiscrepancies)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedByOxyUserId: OPERATOR,
        resolutionNote: 'booked by hand under a change ticket',
      })
      .where(eq(referralEarningDiscrepancies.id, finding.id));

    // The failure `payment_discrepancies` hit in this very database: an upsert
    // without `setWhere` reopens what somebody already answered.
    await reconcilePartner(db, { partnerId: world.partnerId, at: new Date() });
    const [after] = await db
      .select()
      .from(referralEarningDiscrepancies)
      .where(eq(referralEarningDiscrepancies.id, finding.id));
    expect(after.status).toBe('resolved');
  }, 180_000);
});

// ─── Acceptance 7: the operator trace, without buyer secrets ─────────────────

describe('acceptance 7: the operator trace explains every payable amount', () => {
  it('carries the whole chain and no buyer-shaped field', async () => {
    const world = await makeAccruedReward({ label: 'trace', commissionMinor: 150_000 });
    registerReferralPayoutRail(settlingRail(`tr_trace_${TAG}`));
    await vestDueRewards({ partnerId: world.partnerId });
    const built = await buildPayoutBatchForPartner({
      partnerId: world.partnerId,
      programId: world.programId,
      currency: EUR,
      createdByOxyUserId: 'system',
    });
    if (built.outcome !== 'opened') throw new Error('the batch fixture produced nothing');
    await approvePayoutBatch({
      batchId: built.batch.id,
      approvedByOxyUserId: OPERATOR,
      reason: 'monthly run',
    });
    await settlePayoutBatch({ batchId: built.batch.id });

    const { traceReferralEarnings } = await import('../referrals/earnings/read.service.js');
    const trace = await traceReferralEarnings({
      partnerId: world.partnerId,
      programId: world.programId,
    });
    expect(trace.partnerId).toBe(world.partnerId);
    expect(trace.rewards).toHaveLength(1);
    expect(trace.rewards[0].transitions.map((row) => row.cause)).toEqual([
      'hold_elapsed',
      'payout_settled',
    ]);
    expect(trace.rewards[0].postings.map((row) => row.kind)).toEqual(['reward_accrued']);
    expect(trace.rewards[0].payoutBatchId).toBe(built.batch.id);
    expect(trace.batches).toHaveLength(1);
    expect(trace.balances[0].settledMinor).toBe(30_000);

    // A RUNTIME walk of a genuinely emitted trace: no buyer, no email, no
    // address, no guest credential, no card handle at any depth. The #92
    // two-gate rule — the static scan is `referral-earnings-isolation.test.ts`.
    const serialized = JSON.stringify(trace).toLowerCase();
    for (const forbidden of [
      'email',
      'phone',
      'address',
      'card',
      'guest_session',
      'guestsession',
      'buyer',
      'token',
    ]) {
      expect(serialized.includes(forbidden), `the trace carries \`${forbidden}\``).toBe(false);
    }
  }, 240_000);
});

// ─── The ledger's own invariants, over referral money ────────────────────────

describe('the ledger invariants hold over referral postings', () => {
  it('nets every referral account to zero across the whole run', async () => {
    // A scoped version of `findGlobalLedgerImbalances`: every transaction this
    // file booked, summed per currency. Scoped to the transactions THIS run's
    // postings name, because an unscoped aggregate reads a sibling file's rows.
    const transactionIds = trackedPartnerIds.length
      ? (
          await db
            .select({ id: referralLedgerPostings.ledgerTransactionId })
            .from(referralLedgerPostings)
            .where(inArray(referralLedgerPostings.partnerId, trackedPartnerIds))
        ).map((row) => row.id)
      : [];
    // A non-zero floor, so an empty set cannot satisfy the sum below.
    expect(transactionIds.length).toBeGreaterThanOrEqual(5);

    const rows = await db
      .select({
        currency: ledgerEntries.currency,
        total: sql<string>`sum(${ledgerEntries.amountMinor})`,
      })
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.transactionId, transactionIds))
      .groupBy(ledgerEntries.currency);
    for (const row of rows) {
      expect(BigInt(row.total), `${row.currency} does not net to zero`).toBe(0n);
    }
    expect(rows.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('names the partner on every referral_payable entry this run wrote', async () => {
    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.account, 'referral_payable'),
          eq(ledgerEntries.ownerType, 'referral_partner'),
          inArray(ledgerEntries.ownerId, trackedPartnerIds.length ? trackedPartnerIds : ['-']),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect(trackedPartnerIds).toContain(row.ownerId);
    }
  }, 120_000);
});
