/**
 * Versioned referral reward rules (#144) against a REAL PostgreSQL database.
 *
 * The fifteen cases #144 lists by name, in its own order, each under a
 * `describe` naming it. They are here rather than against mocks because almost
 * every property #144 asks for is one a mocked repository cannot see: the
 * `UNIQUE(conversion_id)` that makes a duplicate conversion converge, the
 * atomic budget claim, the CHECK that refuses a reward larger than its funding,
 * the triggers that freeze an activated rule and refuse to delete a reward, and
 * the commission base itself — which is a `sum()` over real ledger rows with a
 * real sign convention.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every identifier this file writes carries a per-run
 * suffix and teardown deletes exactly what it created — the
 * `referral-writes.realdb` discipline, whose fixture shapes this file follows.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  referralEvents,
  referralPartners,
  referralPrograms,
  referralLedgerPostings,
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
  recordConversionFromSourceEvent,
  verifyConversion,
} from '../referrals/conversion.service.js';
import { insertOrder, nextOrderNumber, type NewOrder } from '../../db/orders/orderRepository.js';
import { notApplicableFeeSnapshot } from '../fees/order-fees.service.js';
import { createProgramDraft, publishProgram } from '../referrals/program.service.js';
import { applyAsPartner, approvePartner } from '../referrals/partner.service.js';
import { issueCode } from '../referrals/instrument.service.js';
import { registerCodeTouch } from '../referrals/touch.service.js';
import { attributeTouch } from '../referrals/attribution.service.js';
import {
  activateRewardRuleVersion,
  draftRewardRuleVersion,
  editRewardRuleDraft,
} from '../referrals/rewards/rule.service.js';
import {
  accrueRewardForConversion,
  invalidateCampaignBudget,
  reverseReward,
  reverseRewardsForFundingRecord,
} from '../referrals/rewards/reward.service.js';
import {
  registerAffiliateCommissionReader,
  registerSubscriptionRevenueReader,
  resetReferralFundingReaders,
} from '../referrals/rewards/funding.js';
import { listRewardAdjustments } from '../../db/referrals/rewardRepository.js';
import {
  admitPartnerToReferralPilot,
  deleteReferralPilotFixtures,
} from '../referral-pilot/__tests__/pilot-fixture.js';

// Hoisted above the imports: `config/index.ts` reads it at load, and issuing a
// code goes through the instrument service that mints link tokens.
vi.hoisted(() => {
  process.env.REFERRAL_LINK_TOKEN_SECRET = 'realdb-referral-reward-secret';
});

let db: Database;

/** Unique to this run; lower-case hex so it can live inside a code spelling. */
const TAG = uuidv7().replace(/-/g, '').slice(-10);
const AUTHOR = `author-${TAG}`;
const APPROVER = `approver-${TAG}`;
const EUR: CurrencyCode = 'EUR';

const trackedProgramIds: string[] = [];

/**
 * The programme the NEXT partner is admitted to the pilot for (#149).
 *
 * `attributeTouch` refuses a new attribution for a programme with no active
 * pilot cohort, so a fixture that wants one has to publish bounds — exactly as
 * a deployment does. Every test here creates its programme before its partners,
 * so `makeActiveProgram` records it and `makeApprovedPartner` admits to it.
 */
let currentPilotProgram: { programId: string; versionId: string } | null = null;

const trackedPartnerIds: string[] = [];
const trackedRuleIds: string[] = [];
const trackedPaymentIds: string[] = [];
const trackedOrderIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  resetReferralFundingReaders();

  const versionIds =
    trackedProgramIds.length > 0
      ? (
          await db
            .select({ id: referralPrograms.id })
            .from(referralPrograms)
            .where(inArray(referralPrograms.programId, trackedProgramIds))
        ).map((row) => row.id)
      : [];
  const ruleVersionIds =
    trackedRuleIds.length > 0
      ? (
          await db
            .select({ id: referralRewardRules.id })
            .from(referralRewardRules)
            .where(inArray(referralRewardRules.ruleId, trackedRuleIds))
        ).map((row) => row.id)
      : [];
  const attributionIds =
    trackedProgramIds.length > 0
      ? (
          await db
            .select({ id: referralAttributions.id })
            .from(referralAttributions)
            .where(inArray(referralAttributions.programId, trackedProgramIds))
        ).map((row) => row.id)
      : [];
  const conversionIds =
    attributionIds.length > 0
      ? (
          await db
            .select({ id: referralConversions.id })
            .from(referralConversions)
            .where(inArray(referralConversions.attributionId, attributionIds))
        ).map((row) => row.id)
      : [];
  const rewardIds =
    conversionIds.length > 0
      ? (
          await db
            .select({ id: referralRewards.id })
            .from(referralRewards)
            .where(inArray(referralRewards.conversionId, conversionIds))
        ).map((row) => row.id)
      : [];
  const codeIds =
    versionIds.length > 0
      ? (
          await db
            .select({ id: referralCodes.id })
            .from(referralCodes)
            .where(inArray(referralCodes.programVersionId, versionIds))
        ).map((row) => row.id)
      : [];
  const budgetIds =
    trackedProgramIds.length > 0
      ? (
          await db
            .select({ id: referralCampaignBudgets.id })
            .from(referralCampaignBudgets)
            .where(inArray(referralCampaignBudgets.programId, trackedProgramIds))
        ).map((row) => row.id)
      : [];

  /**
   * #145's rows, which this fixture creates WITHOUT naming them.
   *
   * `accrueRewardForConversion` and `reverseReward` now book a ledger posting
   * inside their own transaction, so every reward here has a
   * `referral_ledger_postings` row and every reversal has a second one — each
   * holding a `restrict` foreign key onto the adjustment and the reward this
   * teardown is about to delete. The first full-suite run after #145 landed
   * failed exactly there, with `23503` on `referral_reward_adjustments`.
   *
   * The transactions those postings name carry NO `payment_id`, so the
   * charge-scoped ledger sweep further down cannot see them either; they are
   * collected here and deleted with the rest of the ledger.
   */
  const postingIds =
    trackedPartnerIds.length > 0
      ? (
          await db
            .select({ id: referralLedgerPostings.id })
            .from(referralLedgerPostings)
            .where(inArray(referralLedgerPostings.partnerId, trackedPartnerIds))
        ).map((row) => row.id)
      : [];
  const postingTransactionIds =
    trackedPartnerIds.length > 0
      ? (
          await db
            .select({ id: referralLedgerPostings.ledgerTransactionId })
            .from(referralLedgerPostings)
            .where(inArray(referralLedgerPostings.partnerId, trackedPartnerIds))
        ).map((row) => row.id)
      : [];
  const transitionRewardIds = rewardIds;

  const eventSubjectIds = [
    ...versionIds,
    ...ruleVersionIds,
    ...attributionIds,
    ...conversionIds,
    ...rewardIds,
    ...codeIds,
    ...trackedPartnerIds,
  ];

  /**
   * Seven append-only guards stand between this fixture and its own rows —
   * every one of them `BEFORE UPDATE OR DELETE`, so a teardown DELETE fires it
   * — and each is switched off inside `withTriggerToggleLock`, on the
   * callback's own `tx`.
   *
   * The trigger is the production guarantee and a fixture that could not clean
   * up would leave the shared database growing between runs, so the window has
   * to exist. What it must not be is a window on the POOL: `alter table …
   * disable trigger` is DATABASE-WIDE and one throwaway database serves the
   * whole suite, so two files inside a window at once leave one of them
   * deleting against a trigger the other has just switched back on — and pooled
   * DDL AUTOCOMMITS, so a throw between the disable and the enable strands the
   * trigger off for the rest of the run, after which every later file asserting
   * it refuses a write passes VACUOUSLY. Inside the transaction the DDL rolls
   * back with everything else and the lock is released by the commit or the
   * abort.
   *
   * The windows are as narrow as the ordering allows — only the disables, the
   * deletes that need them and the matching enables are inside, and every
   * select and every unguarded delete stays outside on `db`, in the order it
   * was already in.
   *
   * ONE TABLE PER WINDOW (#301), which is what the two pairs here used to
   * violate. `alter table … disable trigger` takes ShareRowExclusive — NOT
   * ACCESS EXCLUSIVE, measured — and ShareRowExclusive conflicts with the
   * RowExclusive an ordinary INSERT holds. So a window holding `ledger_entries`
   * while asking for `ledger_transactions` deadlocked (40P01) against
   * `insertLedgerTransaction`, which takes them the other way round because the
   * foreign key forces the parent first. **The shared mutex cannot prevent
   * that**: it serialises window against window, and this counterparty is a
   * plain ledger write from any sibling file. It killed a `Deploy to AWS` run
   * on `main` (merge 9c1d430) and re-ran green, which is exactly how a lock
   * cycle presents.
   *
   * Splitting is what makes the cycle UNBUILDABLE rather than a bet on writer
   * order: with a single disable per window the transaction holds exactly one
   * STRONG lock, and every other lock it takes is RowExclusive, which never
   * conflicts with another RowExclusive. Matching the writer's order instead
   * would have been correct only until somebody added a writer with the
   * opposite one — and the adjustments pair below is precisely that case, since
   * `applyRewardAdjustment` writes the CHILD then the parent.
   */
  // #145's two append-only tables, children first and ONE TABLE PER WINDOW.
  if (postingIds.length > 0) {
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_ledger_postings disable trigger referral_ledger_postings_append_only`,
      );
      await tx.delete(referralLedgerPostings).where(inArray(referralLedgerPostings.id, postingIds));
      await tx.execute(
        sql`alter table referral_ledger_postings enable trigger referral_ledger_postings_append_only`,
      );
    });
  }
  if (transitionRewardIds.length > 0) {
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_reward_transitions disable trigger referral_reward_transitions_append_only`,
      );
      await tx
        .delete(referralRewardTransitions)
        .where(inArray(referralRewardTransitions.rewardId, transitionRewardIds));
      await tx.execute(
        sql`alter table referral_reward_transitions enable trigger referral_reward_transitions_append_only`,
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
    // A rule version that ever left `draft` refuses its own DELETE. Its own
    // window: the events, conversions, attributions, touches and codes above
    // are deleted between this and the rewards, and pulling them under ACCESS
    // EXCLUSIVE would widen the hold for nothing.
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
    // And the budgets keep their own, though they sit next to the rules: the
    // two guards protect unrelated tables and either branch can be the only one
    // taken, so one window would lock a table this run may not be touching.
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
    await deleteReferralPilotFixtures(trackedProgramIds, db);
    await db.delete(referralPartners).where(inArray(referralPartners.id, trackedPartnerIds));
  }
  if (trackedProgramIds.length > 0) {
    await db.delete(referralPrograms).where(inArray(referralPrograms.programId, trackedProgramIds));
  }
  if (trackedPaymentIds.length > 0 || postingTransactionIds.length > 0) {
    const txIds = [
      ...new Set([
        ...(trackedPaymentIds.length > 0
          ? (
              await db
                .select({ id: ledgerTransactions.id })
                .from(ledgerTransactions)
                .where(inArray(ledgerTransactions.paymentId, trackedPaymentIds))
            ).map((row) => row.id)
          : []),
        // #145's referral transactions name no payment, so the charge-scoped
        // read above cannot see them.
        ...postingTransactionIds,
      ]),
    ];
    if (txIds.length > 0) {
      // The window that cost a deploy (#301): entries and their transactions,
      // one table each. The deletes stay children-first because the foreign key
      // requires it; what changed is that the transaction no longer holds
      // `ledger_entries`'s ShareRowExclusive while acquiring
      // `ledger_transactions`'s, which is the half `insertLedgerTransaction`
      // deadlocks against. The `payments` delete below stays outside — nothing
      // guards it, and the transactions naming those payments are already gone
      // by the time this commits.
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(sql`alter table ledger_entries disable trigger ledger_entries_append_only`);
        await tx.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, txIds));
        await tx.execute(sql`alter table ledger_entries enable trigger ledger_entries_append_only`);
      });
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(
          sql`alter table ledger_transactions disable trigger ledger_transactions_append_only`,
        );
        await tx.delete(ledgerTransactions).where(inArray(ledgerTransactions.id, txIds));
        await tx.execute(
          sql`alter table ledger_transactions enable trigger ledger_transactions_append_only`,
        );
      });
    }
    await db.delete(payments).where(inArray(payments.id, trackedPaymentIds));
  }
  if (trackedOrderIds.length > 0) {
    // The last one, alone: the `payments` delete above is between it and the
    // ledger window, and it shares no parent with anything.
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table order_fee_snapshots disable trigger order_fee_snapshots_append_only`,
      );
      await tx.delete(orderFeeSnapshots).where(inArray(orderFeeSnapshots.orderId, trackedOrderIds));
      await tx.execute(
        sql`alter table order_fee_snapshots enable trigger order_fee_snapshots_append_only`,
      );
    });
  }
  await closePostgres();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** A published buyer-referral program whose `commission_rule_ref` names `ruleId`. */
async function makeActiveProgram(ruleId: string): Promise<{ programId: string; versionId: string }> {
  const draft = await createProgramDraft({
    name: `Rewards program ${TAG}`,
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
    holdDays: 60,
    payoutPolicyRef: 'stripe-monthly',
    termsVersion: 't1',
    disclosureVersion: 'd1',
    createdByOxyUserId: AUTHOR,
    cohortKeys: [],
  });
  trackedProgramIds.push(draft.programId);
  const published = await publishProgram({ id: draft.id, approvedByOxyUserId: APPROVER });
  currentPilotProgram = { programId: draft.programId, versionId: published.id };
  return { programId: draft.programId, versionId: published.id };
}

/** An APPROVED user partner. */
async function makeApprovedPartner(label: string): Promise<{ id: string }> {
  const { partner } = await applyAsPartner({
    ownerType: 'user',
    ownerId: `owner-${label}-${TAG}`,
    displayName: `Partner ${label}`,
    termsVersion: 't1',
    promotionMethods: ['website'],
  });
  trackedPartnerIds.push(partner.id);
  await approvePartner({ partnerId: partner.id, actorOxyUserId: APPROVER, reason: 'fixture' });
  if (currentPilotProgram !== null) {
    await admitPartnerToReferralPilot({
      programId: currentPilotProgram.programId,
      programVersionId: currentPilotProgram.versionId,
      partnerId: partner.id,
      operatorOxyUserId: APPROVER,
    });
  }
  return { id: partner.id };
}

type RuleOverrides = Partial<Record<string, unknown>>;

/** A DRAFTED and ACTIVATED rule version. Returns the row. */
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
    holdPolicyRef: 'buyer-hold-60d',
    holdDays: 60,
    reversalPolicy: 'proportional_to_realized_base',
    termsVersion: 'referral-terms-v1',
    createdByOxyUserId: AUTHOR,
    ...overrides,
  });
  return await activateRewardRuleVersion({ id: draft.id, approvedByOxyUserId: APPROVER });
}

/** A payment whose ledger carries `commissionMinor` of realized commission. */
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
    {
      kind: 'charge_succeeded',
      description: `fixture charge ${payment.id}`,
      paymentId: payment.id,
    },
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

/** Return `commissionMinor` of commission on a payment — a refund's ledger half. */
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

/** An ACTIVE attribution pinning `ruleVersionRef`, plus an ELIGIBLE conversion. */
async function makeEligibleConversion(input: {
  programId: string;
  programVersionId: string;
  partnerId: string;
  codeId: string;
  ruleVersionRef: string;
  subjectRef: string;
  sourceRef: string;
  conversionType?: 'first_qualifying_paid_order' | 'merchant_activation';
  occurredAt?: Date;
}): Promise<{ attributionId: string; conversionId: string }> {
  const occurredAt = input.occurredAt ?? new Date();
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
    conversionType: input.conversionType ?? 'first_qualifying_paid_order',
    sourceKind: input.conversionType === 'merchant_activation' ? 'merchant_activation' : 'order',
    sourceRef: input.sourceRef,
    sourceEventId: `event-${uuidv7()}`,
    occurredAt,
  });
  const verified = await verifyConversion({ conversionId: conversion.id });
  expect(verified.state).toBe('eligible');
  return { attributionId: attribution.id, conversionId: conversion.id };
}

/** A `mercaria_retail` order — no store, no listing, all ids are plain text. */
async function makeRetailOrder(totalMinor: number): Promise<string> {
  const dual = (amount: number) =>
    ({ shop: { amount, currency: EUR }, presentment: { amount, currency: EUR } }) as const;
  const doc: NewOrder = {
    orderNumber: await nextOrderNumber(),
    buyerOrigin: 'oxy',
    buyerOxyUserId: `buyer-${uuidv7()}`,
    // ADR 0004 D1's biconditional: a `platform` order carries neither owner.
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
      subtotal: dual(totalMinor),
      discountTotal: dual(0),
      shipping: dual(0),
      tax: dual(0),
      grandTotal: dual(totalMinor),
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
        unitPrice: dual(totalMinor),
        quantity: 1,
        lineTotal: dual(totalMinor),
      },
    ],
    statusHistory: [{ status: 'pending_payment', at: new Date(), actorKind: 'system' }],
    appliedDiscounts: [],
    taxLines: [],
    // #88's `mercaria_retail` mode: a NULL fee, never a zero.
    feeSnapshot: notApplicableFeeSnapshot('mercaria_retail'),
  };
  const order = await insertOrder(doc);
  trackedOrderIds.push(order.id);
  return order.id;
}

/**
 * Assert a statement was refused by the DATABASE, matching against the whole
 * error chain.
 *
 * `expect(...).rejects.toThrow(/…/)` matches `error.message`, and drizzle's
 * message is the query wrapper — the constraint name and the trigger's own
 * sentence live on `cause`, which is the standing gotcha for every driver error
 * in this repo. Walking the chain is what makes an assertion about a CHECK an
 * assertion about that check rather than about the SQL text.
 *
 * The `toBeDefined` is the positive control: a statement that did not fail at
 * all would otherwise pass by matching nothing.
 */
async function expectRejectedBy(promise: Promise<unknown>, matcher: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the statement was accepted, not refused').toBeDefined();
  const parts: string[] = [];
  let cursor: unknown = caught;
  while (cursor !== undefined && cursor !== null) {
    const error = cursor as { message?: string; constraint_name?: string; cause?: unknown };
    if (typeof error.message === 'string') parts.push(error.message);
    if (typeof error.constraint_name === 'string') parts.push(error.constraint_name);
    cursor = error.cause === cursor ? undefined : error.cause;
  }
  expect(parts.join('\n')).toMatch(matcher);
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

// ─── The fifteen cases ──────────────────────────────────────────────────────

describe('case 1: percentage marketplace-commission reward', () => {
  it('pays the pinned rate of the REALIZED commission and snapshots the funding', async () => {
    const ruleId = `c1-${TAG}`;
    const rule = await makeActiveRule(ruleId);
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c1');
    const code = await issueCode({ partnerId: partner.id, programId });
    const paymentId = await makePaymentWithCommission(1_000);
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c1-${TAG}`,
      sourceRef: `order-c1-${TAG}`,
    });

    const result = await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId });
    expect(result.outcome).toBe('accrued');
    if (result.outcome !== 'accrued') return;

    // 20% of the commission — NOT of the 5_000 gross the buyer paid.
    expect(result.reward.grossAmountMinor).toBe(200);
    expect(result.reward.netAmountMinor).toBe(200);
    expect(result.reward.currency).toBe(EUR);
    expect(result.reward.state).toBe('held');
    // #144 acceptance 1: one immutable rule version, one funding record.
    expect(result.reward.ruleVersionId).toBe(rule.id);
    expect(result.reward.fundingSourceId).toBe('connected_marketplace');
    expect(result.reward.fundingRecordRef).toBe(paymentId);
    expect(result.reward.fundingAmountMinor).toBe(1_000);
    expect(result.reward.fundingRecordVersion.length).toBeGreaterThan(0);
    // The hold comes off the PINNED version, not from a constant.
    expect(result.reward.holdUntilAt.getTime() - result.reward.accruedAt.getTime()).toBe(
      60 * 24 * 60 * 60 * 1_000,
    );
  });

  it('refuses when the order produced no commission at all, and records why', async () => {
    const ruleId = `c1b-${TAG}`;
    await makeActiveRule(ruleId);
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c1b');
    const code = await issueCode({ partnerId: partner.id, programId });
    // A payment with no `commission_revenue` posting at all — a retail or
    // external order, structurally.
    const [payment] = await db
      .insert(payments)
      .values({
        checkoutGroupId: `group-${uuidv7()}`,
        provider: 'mock',
        status: 'succeeded',
        presentmentAmount: 5_000,
        presentmentCurrency: EUR,
      })
      .returning({ id: payments.id });
    trackedPaymentIds.push(payment.id);

    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c1b-${TAG}`,
      sourceRef: `order-c1b-${TAG}`,
    });

    const result = await accrueRewardForConversion({
      conversionId,
      fundingRecordRef: payment.id,
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'funding_source_unavailable' });

    // ADR 0005 D16: the refusal is RECORDED, so an effect that did not happen
    // is distinguishable from one that silently vanished.
    const events = await db
      .select()
      .from(referralEvents)
      .where(
        and(
          eq(referralEvents.subjectId, conversionId),
          eq(referralEvents.action, 'reward_accrual_refused'),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0].reason).toContain('funding_source_unavailable');
  });
});

describe('case 2: fixed reward', () => {
  it('pays the rule’s fixed amount and claims the campaign budget atomically', async () => {
    const ruleId = `c2-${TAG}`;
    const campaignRef = `campaign-c2-${TAG}`;
    const { programId, versionId } = await makeActiveProgram(ruleId);
    await insertCampaignBudget(db, {
      programId,
      campaignRef,
      name: 'Merchant bounty',
      currency: EUR,
      budgetMinor: 20_000,
      createdByOxyUserId: AUTHOR,
    });
    await makeActiveRule(ruleId, {
      programId,
      campaignRef,
      conversionType: 'merchant_activation',
      fundingSourceId: 'fixed_budget',
      formula: 'fixed_amount',
      rateBps: undefined,
      fixedAmountMinor: 5_000,
      holdDays: 30,
      reversalPolicy: 'fraud_only',
    });
    const partner = await makeApprovedPartner('c2');
    const code = await issueCode({ partnerId: partner.id, programId });
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `merchant-c2-${TAG}`,
      sourceRef: `store-c2-${TAG}`,
      conversionType: 'merchant_activation',
    });

    const result = await accrueRewardForConversion({ conversionId });
    expect(result.outcome).toBe('accrued');
    if (result.outcome !== 'accrued') return;
    expect(result.reward.grossAmountMinor).toBe(5_000);
    expect(result.reward.fundingSourceId).toBe('fixed_budget');
    expect(result.reward.campaignBudgetId).not.toBeNull();

    const [budget] = await db
      .select()
      .from(referralCampaignBudgets)
      .where(eq(referralCampaignBudgets.campaignRef, campaignRef));
    expect(budget.claimedMinor).toBe(5_000);
    expect(budget.status).toBe('open');
  });
});

describe('case 3: affiliate reconciled commission', () => {
  it('refuses by DEFAULT, because #67 has registered no reader', async () => {
    resetReferralFundingReaders();
    const ruleId = `c3a-${TAG}`;
    await makeActiveRule(ruleId, { fundingSourceId: 'affiliate' });
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c3a');
    const code = await issueCode({ partnerId: partner.id, programId });
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c3a-${TAG}`,
      sourceRef: `commission-c3a-${TAG}`,
    });

    expect(
      await accrueRewardForConversion({ conversionId, fundingRecordRef: 'commission-record-1' }),
    ).toEqual({ outcome: 'refused', reason: 'funding_source_unavailable' });
  });

  it('pays a RECONCILED commission and refuses an unreconciled one', async () => {
    const reconciled = new Map<string, number>([[`reconciled-${TAG}`, 4_000]]);
    registerAffiliateCommissionReader(async ({ recordRef }) => {
      const amountMinor = reconciled.get(recordRef);
      // #144 calculation rule 8: an estimate is not a realized base, and
      // `undefined` is how the port says "the network has confirmed nothing".
      return amountMinor === undefined
        ? undefined
        : { amountMinor, currency: EUR, version: 'recon-1', observedAt: new Date() };
    });

    const ruleId = `c3b-${TAG}`;
    await makeActiveRule(ruleId, { fundingSourceId: 'affiliate', rateBps: 2_500 });
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c3b');
    const code = await issueCode({ partnerId: partner.id, programId });

    const paid = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c3b-${TAG}`,
      sourceRef: `commission-c3b-${TAG}`,
    });
    const accrued = await accrueRewardForConversion({
      conversionId: paid.conversionId,
      fundingRecordRef: `reconciled-${TAG}`,
    });
    expect(accrued.outcome).toBe('accrued');
    if (accrued.outcome === 'accrued') expect(accrued.reward.grossAmountMinor).toBe(1_000);

    const pending = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c3b2-${TAG}`,
      sourceRef: `commission-c3b2-${TAG}`,
    });
    expect(
      await accrueRewardForConversion({
        conversionId: pending.conversionId,
        fundingRecordRef: `pending-${TAG}`,
      }),
    ).toEqual({ outcome: 'refused', reason: 'funding_not_reconciled' });

    resetReferralFundingReaders();
  });
});

describe('case 4: subscription revenue', () => {
  it('pays RECOGNIZED revenue through the #89 port and refuses without one', async () => {
    resetReferralFundingReaders();
    const ruleId = `c4-${TAG}`;
    await makeActiveRule(ruleId, {
      fundingSourceId: 'subscription',
      conversionType: 'merchant_activation',
      rateBps: 1_000,
    });
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c4');
    const code = await issueCode({ partnerId: partner.id, programId });

    const unregistered = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `merchant-c4a-${TAG}`,
      sourceRef: `sub-c4a-${TAG}`,
      conversionType: 'merchant_activation',
    });
    expect(
      await accrueRewardForConversion({
        conversionId: unregistered.conversionId,
        fundingRecordRef: `invoice-${TAG}`,
      }),
    ).toEqual({ outcome: 'refused', reason: 'funding_source_unavailable' });

    registerSubscriptionRevenueReader(async () => ({
      amountMinor: 12_000,
      currency: EUR,
      version: 'period-2026-08',
      observedAt: new Date(),
    }));
    const registered = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `merchant-c4b-${TAG}`,
      sourceRef: `sub-c4b-${TAG}`,
      conversionType: 'merchant_activation',
    });
    const result = await accrueRewardForConversion({
      conversionId: registered.conversionId,
      fundingRecordRef: `invoice-${TAG}`,
    });
    expect(result.outcome).toBe('accrued');
    if (result.outcome === 'accrued') expect(result.reward.grossAmountMinor).toBe(1_200);
    resetReferralFundingReaders();
  });
});

describe('case 5: fixed marketing-budget bounty', () => {
  it('exhausts the budget rather than overspending it', async () => {
    const ruleId = `c5-${TAG}`;
    const campaignRef = `campaign-c5-${TAG}`;
    const { programId, versionId } = await makeActiveProgram(ruleId);
    await insertCampaignBudget(db, {
      programId,
      campaignRef,
      name: 'Small bounty pot',
      currency: EUR,
      budgetMinor: 7_500,
      createdByOxyUserId: AUTHOR,
    });
    await makeActiveRule(ruleId, {
      programId,
      campaignRef,
      conversionType: 'merchant_activation',
      fundingSourceId: 'fixed_budget',
      formula: 'fixed_amount',
      rateBps: undefined,
      fixedAmountMinor: 5_000,
      holdDays: 30,
      reversalPolicy: 'fraud_only',
    });
    const partner = await makeApprovedPartner('c5');
    const code = await issueCode({ partnerId: partner.id, programId });

    const first = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `merchant-c5a-${TAG}`,
      sourceRef: `store-c5a-${TAG}`,
      conversionType: 'merchant_activation',
    });
    expect((await accrueRewardForConversion({ conversionId: first.conversionId })).outcome).toBe(
      'accrued',
    );

    // 2_500 left, 5_000 asked: the CAS matches nothing and the accrual is
    // refused rather than the budget going negative.
    const second = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `merchant-c5b-${TAG}`,
      sourceRef: `store-c5b-${TAG}`,
      conversionType: 'merchant_activation',
    });
    expect(await accrueRewardForConversion({ conversionId: second.conversionId })).toEqual({
      outcome: 'refused',
      reason: 'budget_exhausted',
    });

    const [budget] = await db
      .select()
      .from(referralCampaignBudgets)
      .where(eq(referralCampaignBudgets.campaignRef, campaignRef));
    expect(budget.claimedMinor).toBe(5_000);
    expect(budget.claimedMinor).toBeLessThanOrEqual(budget.budgetMinor);
  });

  it('refuses to shrink a budget below what it has already paid out', async () => {
    // Cutting a campaign is `status = 'closed'`, which is prospective. A shrink
    // would be retroactive and could strand claims already made — the trigger
    // is what makes that a database fact rather than a habit.
    const { programId } = await makeActiveProgram(`c5c-${TAG}`);
    const budget = await insertCampaignBudget(db, {
      programId,
      campaignRef: `campaign-c5c-${TAG}`,
      name: 'Shrinkable?',
      currency: EUR,
      budgetMinor: 10_000,
      createdByOxyUserId: AUTHOR,
    });
    await expectRejectedBy(
      db
        .update(referralCampaignBudgets)
        .set({ budgetMinor: 500 })
        .where(eq(referralCampaignBudgets.id, budget.id)),
      /cannot shrink/,
    );
    // …and growing it is fine, which is what makes the refusal above about the
    // DIRECTION rather than about the column being frozen.
    await db
      .update(referralCampaignBudgets)
      .set({ budgetMinor: 20_000 })
      .where(eq(referralCampaignBudgets.id, budget.id));
  });
});

describe('case 6: multi-currency boundaries', () => {
  it('refuses funding in a currency the rule does not pay in, and converts nothing', async () => {
    const ruleId = `c6-${TAG}`;
    await makeActiveRule(ruleId, { rewardCurrency: 'USD' });
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c6');
    const code = await issueCode({ partnerId: partner.id, programId });
    const paymentId = await makePaymentWithCommission(1_000, { currency: EUR });
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c6-${TAG}`,
      sourceRef: `order-c6-${TAG}`,
    });

    expect(await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId })).toEqual({
      outcome: 'refused',
      reason: 'funding_currency_mismatch',
    });
    // Nothing was written: a refusal produces no reward, in any currency.
    const rewards = await db
      .select()
      .from(referralRewards)
      .where(eq(referralRewards.conversionId, conversionId));
    expect(rewards).toHaveLength(0);
  });

  it('takes the funding’s own currency when the rule pins none', async () => {
    const ruleId = `c6b-${TAG}`;
    await makeActiveRule(ruleId, {
      currencyMode: 'funding_currency',
      rewardCurrency: undefined,
      rateBps: 1_000,
    });
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c6b');
    const code = await issueCode({ partnerId: partner.id, programId });
    const paymentId = await makePaymentWithCommission(3_000, { currency: 'GBP' });
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c6b-${TAG}`,
      sourceRef: `order-c6b-${TAG}`,
    });

    const result = await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId });
    expect(result.outcome).toBe('accrued');
    if (result.outcome !== 'accrued') return;
    expect(result.reward.currency).toBe('GBP');
    expect(result.reward.grossAmountMinor).toBe(300);
  });

  it('refuses a payment carrying commission in two currencies rather than summing them', async () => {
    const ruleId = `c6c-${TAG}`;
    await makeActiveRule(ruleId, { currencyMode: 'funding_currency', rewardCurrency: undefined });
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c6c');
    const code = await issueCode({ partnerId: partner.id, programId });
    const paymentId = await makePaymentWithCommission(1_000, { currency: EUR });
    // A second, USD, commission posting against the same payment. Adding a EUR
    // amount to a USD one to reach a base is arithmetic on two different things
    // — the same reason the ledger's own balance rule is per currency.
    await insertLedgerTransaction(
      db,
      { kind: 'adjustment', description: 'fixture usd leg', paymentId },
      [
        { account: 'commission_revenue', currency: 'USD', amountMinor: -500n },
        { account: 'provider_clearing', currency: 'USD', amountMinor: 500n },
      ],
    );
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c6c-${TAG}`,
      sourceRef: `order-c6c-${TAG}`,
    });

    expect(await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId })).toEqual({
      outcome: 'refused',
      reason: 'funding_source_unavailable',
    });
  });
});

describe('case 7: rounding and caps', () => {
  it('rounds half-even once and applies the per-conversion cap', async () => {
    const ruleId = `c7-${TAG}`;
    await makeActiveRule(ruleId, { rateBps: 2_500, maxRewardPerConversionMinor: 40 });
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c7');
    const code = await issueCode({ partnerId: partner.id, programId });

    // 25% of 10 is 2.5 → 2 (half-even), well under the cap.
    const small = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c7a-${TAG}`,
      sourceRef: `order-c7a-${TAG}`,
    });
    const smallPayment = await makePaymentWithCommission(10);
    const smallResult = await accrueRewardForConversion({
      conversionId: small.conversionId,
      fundingRecordRef: smallPayment,
    });
    expect(smallResult.outcome === 'accrued' && smallResult.reward.grossAmountMinor).toBe(2);

    // 25% of 1_000 is 250, clamped to the rule's 40.
    const large = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c7b-${TAG}`,
      sourceRef: `order-c7b-${TAG}`,
    });
    const largePayment = await makePaymentWithCommission(1_000);
    const largeResult = await accrueRewardForConversion({
      conversionId: large.conversionId,
      fundingRecordRef: largePayment,
    });
    expect(largeResult.outcome === 'accrued' && largeResult.reward.grossAmountMinor).toBe(40);
  });

  it('refuses under the minimum instead of topping the reward up to it', async () => {
    // ADR 0005 D10: a floor above the realized base is money from nowhere, so a
    // rule's minimum is a THRESHOLD and there is no arithmetic that raises an
    // amount anywhere in the domain.
    const ruleId = `c7c-${TAG}`;
    await makeActiveRule(ruleId, { rateBps: 100, minAccrualMinor: 500 });
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c7c');
    const code = await issueCode({ partnerId: partner.id, programId });
    const paymentId = await makePaymentWithCommission(1_000);
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c7c-${TAG}`,
      sourceRef: `order-c7c-${TAG}`,
    });

    // 1% of 1_000 is 10, under the 500 minimum.
    expect(await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId })).toEqual({
      outcome: 'refused',
      reason: 'below_min_accrual',
    });
    expect(
      await db.select().from(referralRewards).where(eq(referralRewards.conversionId, conversionId)),
    ).toHaveLength(0);
  });

  it('enforces the per-partner period cap across conversions', async () => {
    const ruleId = `c7d-${TAG}`;
    await makeActiveRule(ruleId, {
      rateBps: 10_000,
      maxRewardPerPartnerPeriodMinor: 1_500,
      partnerCapPeriod: 'lifetime',
    });
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c7d');
    const code = await issueCode({ partnerId: partner.id, programId });

    const first = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c7d1-${TAG}`,
      sourceRef: `order-c7d1-${TAG}`,
    });
    const firstResult = await accrueRewardForConversion({
      conversionId: first.conversionId,
      fundingRecordRef: await makePaymentWithCommission(1_000),
    });
    expect(firstResult.outcome === 'accrued' && firstResult.reward.grossAmountMinor).toBe(1_000);

    // 500 of headroom left; the base offers 1_000, so the cap binds.
    const second = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c7d2-${TAG}`,
      sourceRef: `order-c7d2-${TAG}`,
    });
    const secondResult = await accrueRewardForConversion({
      conversionId: second.conversionId,
      fundingRecordRef: await makePaymentWithCommission(1_000),
    });
    expect(secondResult.outcome === 'accrued' && secondResult.reward.grossAmountMinor).toBe(500);

    // Nothing left at all: refused, and recorded.
    const third = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c7d3-${TAG}`,
      sourceRef: `order-c7d3-${TAG}`,
    });
    expect(
      await accrueRewardForConversion({
        conversionId: third.conversionId,
        fundingRecordRef: await makePaymentWithCommission(1_000),
      }),
    ).toEqual({ outcome: 'refused', reason: 'cap_reached' });
  });

  it('refuses a reward larger than its funding at the ROW, not only in the service', async () => {
    // The CHECK, mutation-tested against the service: a hand-written insert
    // claiming more than the funding is refused by the database.
    const ruleId = `c7e-${TAG}`;
    const rule = await makeActiveRule(ruleId);
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c7e');
    const code = await issueCode({ partnerId: partner.id, programId });
    const { attributionId, conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c7e-${TAG}`,
      sourceRef: `order-c7e-${TAG}`,
    });

    await expectRejectedBy(
      db.insert(referralRewards).values({
        conversionId,
        attributionId,
        partnerId: partner.id,
        programVersionId: versionId,
        ruleVersionId: rule.id,
        fundingSourceId: 'connected_marketplace',
        fundingRecordRef: 'pay_x',
        fundingRecordVersion: 'v1',
        fundingAmountMinor: 100,
        fundingObservedAt: new Date(),
        grossAmountMinor: 101,
        netAmountMinor: 101,
        currency: EUR,
        accruedAt: new Date(),
        holdUntilAt: new Date(),
      }),
      /referral_rewards_funding_bound_check/,
    );
  });
});

describe('case 8: partial refund', () => {
  it('appends a NEGATIVE adjustment recomputed from the base as it now stands', async () => {
    const ruleId = `c8-${TAG}`;
    await makeActiveRule(ruleId, { rateBps: 2_000 });
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c8');
    const code = await issueCode({ partnerId: partner.id, programId });
    const paymentId = await makePaymentWithCommission(1_000);
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c8-${TAG}`,
      sourceRef: `order-c8-${TAG}`,
    });
    const accrued = await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId });
    expect(accrued.outcome === 'accrued' && accrued.reward.grossAmountMinor).toBe(200);

    // Half the commission comes back.
    await returnCommission(paymentId, 500);
    const [result] = await reverseRewardsForFundingRecord({
      fundingSourceId: 'connected_marketplace',
      fundingRecordRef: paymentId,
      cause: 'order_partially_refunded',
      sourceRef: `refund-c8-${TAG}`,
      reason: 'half the order came back',
    });

    expect(result.adjustment.deltaAmountMinor).toBe(-100);
    expect(result.adjustment.resultingNetMinor).toBe(100);
    expect(result.adjustment.observedFundingAmountMinor).toBe(500);
    expect(result.adjustment.recoveryState).toBe('offset_against_balance');
    expect(result.reward.netAmountMinor).toBe(100);
    // The reward is still live — a partial refund shrinks, it does not void.
    expect(result.reward.state).toBe('held');
    // …and the gross is untouched, so `Σ deltas + gross == net` reconciles.
    expect(result.reward.grossAmountMinor).toBe(200);
  });
});

describe('case 9: full refund', () => {
  it('voids the reward and records the reversal', async () => {
    const ruleId = `c9-${TAG}`;
    await makeActiveRule(ruleId);
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c9');
    const code = await issueCode({ partnerId: partner.id, programId });
    const paymentId = await makePaymentWithCommission(1_000);
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c9-${TAG}`,
      sourceRef: `order-c9-${TAG}`,
    });
    await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId });

    await returnCommission(paymentId, 1_000);
    const [result] = await reverseRewardsForFundingRecord({
      fundingSourceId: 'connected_marketplace',
      fundingRecordRef: paymentId,
      cause: 'order_fully_refunded',
      sourceRef: `refund-c9-${TAG}`,
      reason: 'the whole order came back',
    });

    expect(result.reward.state).toBe('voided');
    expect(result.reward.netAmountMinor).toBe(0);
    expect(result.reward.voidedAt).not.toBeNull();
    expect(result.adjustment.deltaAmountMinor).toBe(-200);
    // The ROW survives — history is never deleted.
    const rows = await db
      .select()
      .from(referralRewards)
      .where(eq(referralRewards.id, result.reward.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].grossAmountMinor).toBe(200);
  });

  it('refuses to DELETE a reward, ever', async () => {
    const ruleId = `c9b-${TAG}`;
    await makeActiveRule(ruleId);
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c9b');
    const code = await issueCode({ partnerId: partner.id, programId });
    const paymentId = await makePaymentWithCommission(1_000);
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c9b-${TAG}`,
      sourceRef: `order-c9b-${TAG}`,
    });
    const accrued = await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId });
    expect(accrued.outcome).toBe('accrued');
    if (accrued.outcome !== 'accrued') return;

    await expectRejectedBy(
      db.delete(referralRewards).where(eq(referralRewards.id, accrued.reward.id)),
      /never deleted/,
    );
    // And the adjustment trail is append-only in both directions.
    await reverseReward({
      rewardId: accrued.reward.id,
      cause: 'fraud_invalidation',
      sourceRef: `finding-c9b-${TAG}`,
      reason: 'fixture',
    });
    const [adjustment] = await listRewardAdjustments(db, accrued.reward.id);
    await expectRejectedBy(
      db
        .update(referralRewardAdjustments)
        .set({ reason: 'edited' })
        .where(eq(referralRewardAdjustments.id, adjustment.id)),
      /append-only/,
    );
  });
});

describe('case 10: dispute / reversal', () => {
  it('voids a lost dispute, and a PAID reward becomes a partner liability', async () => {
    const ruleId = `c10-${TAG}`;
    await makeActiveRule(ruleId);
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c10');
    const code = await issueCode({ partnerId: partner.id, programId });
    const paymentId = await makePaymentWithCommission(1_000);
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c10-${TAG}`,
      sourceRef: `order-c10-${TAG}`,
    });
    const accrued = await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId });
    expect(accrued.outcome).toBe('accrued');
    if (accrued.outcome !== 'accrued') return;

    // #145 owns vesting and payout; the state is set directly here so the R7
    // branch — the one that must never un-pay — is exercised.
    await db
      .update(referralRewards)
      .set({ state: 'paid', vestedAt: new Date(), paidAt: new Date() })
      .where(eq(referralRewards.id, accrued.reward.id));

    const result = await reverseReward({
      rewardId: accrued.reward.id,
      cause: 'dispute_lost',
      sourceRef: `dp_${TAG}`,
      reason: 'the buyer won the dispute',
    });
    expect(result).toBeDefined();
    if (!result) return;

    // ADR 0005 R7: the payout is never un-paid and the paid record is never
    // rewritten. The shortfall becomes a liability #145 recovers.
    expect(result.reward.state).toBe('paid');
    expect(result.reward.paidAt).not.toBeNull();
    expect(result.reward.netAmountMinor).toBe(0);
    expect(result.adjustment.recoveryState).toBe('partner_liability');
    expect(result.adjustment.liabilityAmountMinor).toBe(200);
  });
});

describe('case 7 under CONCURRENCY: a cap bounds the total, not each accrual', () => {
  /**
   * The case the sequential cap test cannot reach.
   *
   * `sumPartnerAccruals` / `sumCampaignAccruals` are a READ followed by an
   * INSERT, and this backend runs at Postgres's default READ COMMITTED with no
   * isolation-level override anywhere. Two accruals for the SAME partner but
   * DIFFERENT conversions therefore both see the other's row as absent — no row
   * lock can help, because the row that would need locking does not exist yet.
   * The result is a cap silently exceeded with no refusal recorded, which is
   * exactly what #144 acceptance 7 forbids.
   *
   * `UNIQUE(conversion_id)` does NOT cover this: it converges two accruals of
   * ONE conversion, and these are two.
   *
   * Repeated, because a race test that passes once has proven nothing — and
   * with a FRESH partner per iteration, so an earlier iteration's accruals
   * cannot be what exhausts the cap.
   */
  const ITERATIONS = 6;

  it('never exceeds the per-partner cap, and the loser records a refusal', async () => {
    const ruleId = `race-partner-${TAG}`;
    const CAP = 1_000;
    await makeActiveRule(ruleId, {
      rateBps: 10_000,
      maxRewardPerPartnerPeriodMinor: CAP,
      partnerCapPeriod: 'lifetime',
    });
    const { programId, versionId } = await makeActiveProgram(ruleId);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const partner = await makeApprovedPartner(`race-p${String(iteration)}`);
      const code = await issueCode({ partnerId: partner.id, programId });
      const conversions = await Promise.all(
        [0, 1].map(async (index) =>
          makeEligibleConversion({
            programId,
            programVersionId: versionId,
            partnerId: partner.id,
            codeId: code.id,
            ruleVersionRef: `${ruleId}@v1`,
            subjectRef: `buyer-race-p${String(iteration)}-${String(index)}-${TAG}`,
            sourceRef: `order-race-p${String(iteration)}-${String(index)}-${TAG}`,
          }),
        ),
      );
      const payments = await Promise.all([
        makePaymentWithCommission(CAP),
        makePaymentWithCommission(CAP),
      ]);

      const outcomes = await Promise.all(
        conversions.map(async (conversion, index) =>
          accrueRewardForConversion({
            conversionId: conversion.conversionId,
            fundingRecordRef: payments[index],
          }),
        ),
      );

      const accrued = await db
        .select()
        .from(referralRewards)
        .where(eq(referralRewards.partnerId, partner.id));
      const total = accrued.reduce((sum, row) => sum + row.grossAmountMinor, 0);
      expect(
        total,
        `iteration ${String(iteration)} paid ${String(total)} against a cap of ${String(CAP)}`,
      ).toBeLessThanOrEqual(CAP);

      // …and the money that was NOT paid was refused out loud. A cap that held
      // by paying two rewards of half the size would satisfy the sum above and
      // still be wrong: a percentage rule pays the rate or explains itself.
      const refused = outcomes.filter((outcome) => outcome.outcome === 'refused');
      expect(refused).toHaveLength(1);
      expect(refused[0].outcome === 'refused' && refused[0].reason).toBe('cap_reached');
      expect(accrued).toHaveLength(1);
      expect(accrued[0].grossAmountMinor).toBe(CAP);
    }
  });

  it('never exceeds the per-campaign cap under two partners at once', async () => {
    // The campaign cap spans PARTNERS, so its race needs two of them — which is
    // also why a lock keyed on the partner cannot serialize it and it needs its
    // own key.
    const ruleId = `race-campaign-${TAG}`;
    const campaignRef = `campaign-race-${TAG}`;
    const CAP = 1_000;
    const { programId, versionId } = await makeActiveProgram(ruleId);
    await makeActiveRule(ruleId, {
      programId,
      campaignRef,
      rateBps: 10_000,
      maxRewardPerCampaignMinor: CAP,
    });

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      // A fresh CAMPAIGN per iteration, because the cap is campaign-scoped and
      // spans every rule version naming it.
      const iterationCampaign = `${campaignRef}-${String(iteration)}`;
      const iterationRuleId = `${ruleId}-${String(iteration)}`;
      await makeActiveRule(iterationRuleId, {
        programId,
        campaignRef: iterationCampaign,
        rateBps: 10_000,
        maxRewardPerCampaignMinor: CAP,
      });
      const partners = await Promise.all([
        makeApprovedPartner(`race-c${String(iteration)}a`),
        makeApprovedPartner(`race-c${String(iteration)}b`),
      ]);
      const prepared = await Promise.all(
        partners.map(async (partner, index) => {
          const code = await issueCode({ partnerId: partner.id, programId });
          const conversion = await makeEligibleConversion({
            programId,
            programVersionId: versionId,
            partnerId: partner.id,
            codeId: code.id,
            ruleVersionRef: `${iterationRuleId}@v1`,
            subjectRef: `buyer-race-c${String(iteration)}-${String(index)}-${TAG}`,
            sourceRef: `order-race-c${String(iteration)}-${String(index)}-${TAG}`,
          });
          return {
            conversionId: conversion.conversionId,
            paymentId: await makePaymentWithCommission(CAP),
          };
        }),
      );

      const outcomes = await Promise.all(
        prepared.map(async (entry) =>
          accrueRewardForConversion({
            conversionId: entry.conversionId,
            fundingRecordRef: entry.paymentId,
          }),
        ),
      );

      const accrued = await db
        .select()
        .from(referralRewards)
        .innerJoin(
          referralRewardRules,
          eq(referralRewardRules.id, referralRewards.ruleVersionId),
        )
        .where(eq(referralRewardRules.campaignRef, iterationCampaign));
      const total = accrued.reduce(
        (sum, row) => sum + row.referral_rewards.grossAmountMinor,
        0,
      );
      expect(
        total,
        `iteration ${String(iteration)} paid ${String(total)} against a campaign cap of ${String(CAP)}`,
      ).toBeLessThanOrEqual(CAP);
      const refused = outcomes.filter((outcome) => outcome.outcome === 'refused');
      expect(refused).toHaveLength(1);
      expect(refused[0].outcome === 'refused' && refused[0].reason).toBe('cap_reached');
    }
  });
});

describe('case 11: idempotent duplicate conversion', () => {
  it('produces the SAME reward, and does not re-read a base that has moved', async () => {
    const ruleId = `c11-${TAG}`;
    await makeActiveRule(ruleId);
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c11');
    const code = await issueCode({ partnerId: partner.id, programId });
    const paymentId = await makePaymentWithCommission(1_000);
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c11-${TAG}`,
      sourceRef: `order-c11-${TAG}`,
    });

    const first = await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId });
    expect(first.outcome === 'accrued' && first.created).toBe(true);

    // The world MOVES between the two calls. A retry that re-realized the base
    // would answer 100 instead of 200 — the opposite of "an idempotent
    // conversion retry produces the same reward".
    await returnCommission(paymentId, 500);
    const second = await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId });
    expect(second.outcome).toBe('accrued');
    if (first.outcome !== 'accrued' || second.outcome !== 'accrued') return;
    expect(second.created).toBe(false);
    expect(second.reward.id).toBe(first.reward.id);
    expect(second.reward.grossAmountMinor).toBe(200);

    expect(
      await db.select().from(referralRewards).where(eq(referralRewards.conversionId, conversionId)),
    ).toHaveLength(1);
  });

  it('two CONCURRENT accruals of one conversion produce exactly one reward', async () => {
    const ruleId = `c11b-${TAG}`;
    await makeActiveRule(ruleId);
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c11b');
    const code = await issueCode({ partnerId: partner.id, programId });
    const paymentId = await makePaymentWithCommission(1_000);
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c11b-${TAG}`,
      sourceRef: `order-c11b-${TAG}`,
    });

    const [a, b] = await Promise.all([
      accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId }),
      accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId }),
    ]);
    expect(a.outcome).toBe('accrued');
    expect(b.outcome).toBe('accrued');
    if (a.outcome !== 'accrued' || b.outcome !== 'accrued') return;
    expect(a.reward.id).toBe(b.reward.id);
    expect(
      await db.select().from(referralRewards).where(eq(referralRewards.conversionId, conversionId)),
    ).toHaveLength(1);
  });

  it('applies a replayed reversal exactly once', async () => {
    const ruleId = `c11c-${TAG}`;
    await makeActiveRule(ruleId);
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c11c');
    const code = await issueCode({ partnerId: partner.id, programId });
    const paymentId = await makePaymentWithCommission(1_000);
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c11c-${TAG}`,
      sourceRef: `order-c11c-${TAG}`,
    });
    const accrued = await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId });
    expect(accrued.outcome).toBe('accrued');
    if (accrued.outcome !== 'accrued') return;

    await returnCommission(paymentId, 500);
    const refundRef = `refund-c11c-${TAG}`;
    const first = await reverseReward({
      rewardId: accrued.reward.id,
      cause: 'order_partially_refunded',
      sourceRef: refundRef,
      reason: 'first delivery',
    });
    const replay = await reverseReward({
      rewardId: accrued.reward.id,
      cause: 'order_partially_refunded',
      sourceRef: refundRef,
      reason: 'redelivered',
    });

    expect(first?.created).toBe(true);
    expect(replay?.created).toBe(false);
    expect(replay?.adjustment.id).toBe(first?.adjustment.id);
    expect(await listRewardAdjustments(db, accrued.reward.id)).toHaveLength(1);
    // The net did not move twice.
    const [reward] = await db
      .select()
      .from(referralRewards)
      .where(eq(referralRewards.id, accrued.reward.id));
    expect(reward.netAmountMinor).toBe(100);
  });
});

describe('case 12: rule version change', () => {
  it('pins the version at ATTRIBUTION, so a later rate change pays the old terms', async () => {
    const ruleId = `c12-${TAG}`;
    await makeActiveRule(ruleId, { rateBps: 2_000 });
    const { programId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c12');
    const code = await issueCode({ partnerId: partner.id, programId });

    // Attribution through the REAL path, so the pin is the resolver's own.
    const registered = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: {
        actor: { kind: 'oxy_user', ref: `buyer-c12-${TAG}` },
        clientSurface: 'web',
        consentMode: 'granted',
      },
    });
    const attributed = await attributeTouch(registered.touch.id);
    expect(attributed.outcome).toBe('created');
    if (attributed.outcome !== 'created') return;
    expect(attributed.attribution.ruleVersionRef).toBe(`${ruleId}@v1`);

    // The rate DOUBLES after the referral happened.
    const draftV2 = await draftRewardRuleVersion({
      ruleId,
      name: `Rule ${ruleId} v2`,
      programId,
      conversionType: 'first_qualifying_paid_order',
      fundingSourceId: 'connected_marketplace',
      formula: 'percentage_of_realized_base',
      rateBps: 4_000,
      currencyMode: 'fixed_currency',
      rewardCurrency: EUR,
      effectiveStartAt: '2020-01-01T00:00:00.000Z',
      holdPolicyRef: 'buyer-hold-60d',
      holdDays: 60,
      reversalPolicy: 'proportional_to_realized_base',
      termsVersion: 'referral-terms-v2',
      createdByOxyUserId: AUTHOR,
    });
    await activateRewardRuleVersion({ id: draftV2.id, approvedByOxyUserId: APPROVER });

    const paymentId = await makePaymentWithCommission(1_000);
    const { conversion } = await recordConversionFromSourceEvent({
      attributionId: attributed.attribution.id,
      conversionType: 'first_qualifying_paid_order',
      sourceKind: 'order',
      sourceRef: `order-c12-${TAG}`,
      sourceEventId: `event-c12-${TAG}`,
      occurredAt: new Date(),
    });
    await verifyConversion({ conversionId: conversion.id });

    const result = await accrueRewardForConversion({
      conversionId: conversion.id,
      fundingRecordRef: paymentId,
    });
    expect(result.outcome).toBe('accrued');
    if (result.outcome !== 'accrued') return;
    // v1's 20%, not v2's 40% — the whole of ADR 0005 D19.
    expect(result.reward.grossAmountMinor).toBe(200);

    // …and the version it paid under is now `superseded`, which is fine: the
    // pinned version governs forever, only RETIREMENT stops new accruals.
    const [pinned] = await db
      .select()
      .from(referralRewardRules)
      .where(and(eq(referralRewardRules.ruleId, ruleId), eq(referralRewardRules.version, 1)));
    expect(pinned.status).toBe('superseded');
  });

  it('refuses to edit an activated version, in the service AND in the database', async () => {
    const ruleId = `c12b-${TAG}`;
    const rule = await makeActiveRule(ruleId);

    await expect(
      editRewardRuleDraft(rule.id, {
        ruleId,
        name: 'edited',
        programId: `program-${ruleId}`,
        conversionType: 'first_qualifying_paid_order',
        fundingSourceId: 'connected_marketplace',
        formula: 'percentage_of_realized_base',
        rateBps: 9_000,
        currencyMode: 'fixed_currency',
        rewardCurrency: EUR,
        effectiveStartAt: '2020-01-01T00:00:00.000Z',
        holdPolicyRef: 'buyer-hold-60d',
        holdDays: 60,
        reversalPolicy: 'proportional_to_realized_base',
        termsVersion: 'referral-terms-v1',
        createdByOxyUserId: AUTHOR,
      }),
    ).rejects.toThrow(/immutable/);

    // The service's predicate is only half of it: the TRIGGER is what holds
    // against a migration, a repair script and `psql`.
    await expectRejectedBy(
      db
        .update(referralRewardRules)
        .set({ rateBps: 9_000 })
        .where(eq(referralRewardRules.id, rule.id)),
      /immutable/,
    );
    await expectRejectedBy(
      db.delete(referralRewardRules).where(eq(referralRewardRules.id, rule.id)),
      /never deleted/,
    );
  });

  it('refuses an activation approved by the author', async () => {
    const ruleId = `c12c-${TAG}`;
    trackedRuleIds.push(ruleId);
    const draft = await draftRewardRuleVersion({
      ruleId,
      name: 'Self-approved',
      programId: `program-${ruleId}`,
      conversionType: 'first_qualifying_paid_order',
      fundingSourceId: 'connected_marketplace',
      formula: 'percentage_of_realized_base',
      rateBps: 2_000,
      currencyMode: 'fixed_currency',
      rewardCurrency: EUR,
      effectiveStartAt: '2020-01-01T00:00:00.000Z',
      holdPolicyRef: 'buyer-hold-60d',
      holdDays: 60,
      reversalPolicy: 'proportional_to_realized_base',
      termsVersion: 'referral-terms-v1',
      createdByOxyUserId: AUTHOR,
    });
    await expect(
      activateRewardRuleVersion({ id: draft.id, approvedByOxyUserId: AUTHOR }),
    ).rejects.toThrow(/other than its author/);
  });
});

describe('case 13: mercaria_retail margin or cost variance as funding FAILS', () => {
  it('is refused by the CHECK, so no service bug can write one', async () => {
    // The vocabulary and the `.strict()` schema are pinned in
    // `rewards/__tests__/forbidden-funding.test.ts`; this is the layer only a
    // real server has — the constraint that refuses the VALUE outright.
    const ruleId = `c13-${TAG}`;
    trackedRuleIds.push(ruleId);
    for (const forbidden of [
      'mercaria_retail_margin',
      'mercaria_retail_cost_variance',
      'supplier_acquisition_cost',
      'paid_ranking',
    ]) {
      await expectRejectedBy(
        db.execute(sql`
          insert into referral_reward_rules (
            id, rule_id, version, name, program_id, conversion_type, funding_source_id,
            formula, rate_bps, currency_mode, reward_currency, effective_start_at,
            hold_policy_ref, hold_days, reversal_policy, terms_version, created_by_oxy_user_id
          ) values (
            ${uuidv7()}, ${ruleId}, 99, 'forbidden', 'p', 'first_qualifying_paid_order',
            ${forbidden}, 'percentage_of_realized_base', 2000, 'fixed_currency', 'EUR',
            now(), 'h', 60, 'proportional_to_realized_base', 't', ${AUTHOR}
          )`),
        /referral_reward_rules_funding_source_id_check/,
      );
    }
  });

  it('refuses the same value on a REWARD row, not only on a rule', async () => {
    const ruleId = `c13b-${TAG}`;
    const rule = await makeActiveRule(ruleId);
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c13b');
    const code = await issueCode({ partnerId: partner.id, programId });
    const { attributionId, conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c13b-${TAG}`,
      sourceRef: `order-c13b-${TAG}`,
    });

    await expectRejectedBy(
      db.execute(sql`
        insert into referral_rewards (
          id, conversion_id, attribution_id, partner_id, program_version_id, rule_version_id,
          funding_source_id, funding_record_ref, funding_record_version, funding_amount_minor,
          funding_observed_at, gross_amount_minor, net_amount_minor, currency, accrued_at,
          hold_until_at
        ) values (
          ${uuidv7()}, ${conversionId}, ${attributionId}, ${partner.id}, ${versionId}, ${rule.id},
          'mercaria_retail_cost_variance', 'variance-1', 'v1', 1000, now(), 100, 100, 'EUR',
          now(), now()
        )`),
      /referral_rewards_funding_source_id_check/,
    );
  });
});

describe('case 14: a retail fixed bounty does not change the customer cost', () => {
  it('leaves the retail order and its fee snapshot byte-identical, tuple version included', async () => {
    const ruleId = `c14-${TAG}`;
    const campaignRef = `campaign-c14-${TAG}`;
    const { programId, versionId } = await makeActiveProgram(ruleId);
    await insertCampaignBudget(db, {
      programId,
      campaignRef,
      name: 'Retail acquisition bounty',
      currency: EUR,
      budgetMinor: 50_000,
      createdByOxyUserId: AUTHOR,
    });
    await makeActiveRule(ruleId, {
      programId,
      campaignRef,
      conversionType: 'merchant_activation',
      fundingSourceId: 'fixed_budget',
      formula: 'fixed_amount',
      rateBps: undefined,
      fixedAmountMinor: 5_000,
      holdDays: 30,
      reversalPolicy: 'fraud_only',
    });
    const partner = await makeApprovedPartner('c14');
    const code = await issueCode({ partnerId: partner.id, programId });

    // A zero-profit retail order the bounty is ASSOCIATED with. ADR 0005's one
    // narrow allowance: the bounty comes from a separately budgeted marketing
    // expense and the customer amount is untouched.
    const orderId = await makeRetailOrder(9_900);
    const [feeSnapshot] = await db
      .select()
      .from(orderFeeSnapshots)
      .where(eq(orderFeeSnapshots.orderId, orderId));
    const orderBefore = await snapshotRow('orders', orderId);
    const feeBefore = await snapshotRow('order_fee_snapshots', feeSnapshot.id);
    // The premise: the retail order really does carry a NULL fee, never a zero.
    expect(feeSnapshot.result).toBe('not_applicable');
    expect(feeSnapshot.feeAmount).toBeNull();

    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `merchant-c14-${TAG}`,
      sourceRef: orderId,
      conversionType: 'merchant_activation',
    });
    const result = await accrueRewardForConversion({ conversionId });
    expect(result.outcome).toBe('accrued');
    if (result.outcome !== 'accrued') return;
    expect(result.reward.grossAmountMinor).toBe(5_000);

    // Not one minor unit of the customer's cost moved, and the tuples were not
    // even rewritten — `xmin` is what tells a genuine no-op apart from a write
    // that happened to land on the same values.
    expect(await snapshotRow('orders', orderId)).toEqual(orderBefore);
    expect(await snapshotRow('order_fee_snapshots', feeSnapshot.id)).toEqual(feeBefore);
    const [orderAfter] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(orderAfter.totalsGrandTotalPresentmentAmount).toBe(9_900);
  });
});

describe('case 15: a referral reward cannot alter a #88 fee snapshot', () => {
  it('is append-only at the database, and the reward path never touches it', async () => {
    const ruleId = `c15-${TAG}`;
    await makeActiveRule(ruleId);
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('c15');
    const code = await issueCode({ partnerId: partner.id, programId });
    const orderId = await makeRetailOrder(4_200);
    const [feeSnapshot] = await db
      .select()
      .from(orderFeeSnapshots)
      .where(eq(orderFeeSnapshots.orderId, orderId));
    const before = await snapshotRow('order_fee_snapshots', feeSnapshot.id);

    const paymentId = await makePaymentWithCommission(1_000);
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `buyer-c15-${TAG}`,
      sourceRef: orderId,
    });

    // Accrue, then reverse — every write the domain performs, against a
    // conversion naming this order.
    const accrued = await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId });
    expect(accrued.outcome).toBe('accrued');
    await returnCommission(paymentId, 400);
    await reverseRewardsForFundingRecord({
      fundingSourceId: 'connected_marketplace',
      fundingRecordRef: paymentId,
      cause: 'order_partially_refunded',
      sourceRef: `refund-c15-${TAG}`,
      reason: 'partial',
    });

    expect(await snapshotRow('order_fee_snapshots', feeSnapshot.id)).toEqual(before);

    // And the structural half: even a module that COULD reach the table cannot
    // rewrite a placed order's fee, because the snapshot is append-only.
    await expectRejectedBy(
      db
        .update(orderFeeSnapshots)
        .set({ feeAmount: 999 })
        .where(eq(orderFeeSnapshots.id, feeSnapshot.id)),
      /append-only/,
    );
  });
});

describe('the reversal outcomes ADR 0005 names, beyond the fifteen cases', () => {
  it('does not reverse a budgeted bounty on an ordinary refund (R6)', async () => {
    const ruleId = `r6-${TAG}`;
    const campaignRef = `campaign-r6-${TAG}`;
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const budget = await insertCampaignBudget(db, {
      programId,
      campaignRef,
      name: 'Bounty pot',
      currency: EUR,
      budgetMinor: 30_000,
      createdByOxyUserId: AUTHOR,
    });
    await makeActiveRule(ruleId, {
      programId,
      campaignRef,
      conversionType: 'merchant_activation',
      fundingSourceId: 'fixed_budget',
      formula: 'fixed_amount',
      rateBps: undefined,
      fixedAmountMinor: 5_000,
      holdDays: 30,
      reversalPolicy: 'fraud_only',
    });
    const partner = await makeApprovedPartner('r6');
    const code = await issueCode({ partnerId: partner.id, programId });
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `merchant-r6-${TAG}`,
      sourceRef: `store-r6-${TAG}`,
      conversionType: 'merchant_activation',
    });
    const accrued = await accrueRewardForConversion({ conversionId });
    expect(accrued.outcome).toBe('accrued');
    if (accrued.outcome !== 'accrued') return;

    // An ordinary refund of the activating order is NOT invalidation: the
    // bounty was funded by budget, not by that order's commission.
    expect(
      await reverseReward({
        rewardId: accrued.reward.id,
        cause: 'order_fully_refunded',
        sourceRef: `refund-r6-${TAG}`,
        reason: 'the activating order came back',
      }),
    ).toBeUndefined();
    expect(await listRewardAdjustments(db, accrued.reward.id)).toHaveLength(0);

    // A FRAUD finding does reverse it, and releases the budget claim.
    const fraud = await reverseReward({
      rewardId: accrued.reward.id,
      cause: 'fraud_invalidation',
      sourceRef: `finding-r6-${TAG}`,
      reason: 'the activation was fabricated',
    });
    expect(fraud?.reward.state).toBe('voided');
    const [afterFraud] = await db
      .select()
      .from(referralCampaignBudgets)
      .where(eq(referralCampaignBudgets.id, budget.id));
    expect(afterFraud.claimedMinor).toBe(0);
  });

  it('invalidating a budget allocation voids everything it funded (#144 reversal 6)', async () => {
    const ruleId = `r7-${TAG}`;
    const campaignRef = `campaign-r7-${TAG}`;
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const budget = await insertCampaignBudget(db, {
      programId,
      campaignRef,
      name: 'Mistaken allocation',
      currency: EUR,
      budgetMinor: 30_000,
      createdByOxyUserId: AUTHOR,
    });
    await makeActiveRule(ruleId, {
      programId,
      campaignRef,
      conversionType: 'merchant_activation',
      fundingSourceId: 'fixed_budget',
      formula: 'fixed_amount',
      rateBps: undefined,
      fixedAmountMinor: 5_000,
      holdDays: 30,
      reversalPolicy: 'fraud_only',
    });
    const partner = await makeApprovedPartner('r7');
    const code = await issueCode({ partnerId: partner.id, programId });
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      ruleVersionRef: `${ruleId}@v1`,
      subjectRef: `merchant-r7-${TAG}`,
      sourceRef: `store-r7-${TAG}`,
      conversionType: 'merchant_activation',
    });
    await accrueRewardForConversion({ conversionId });

    const results = await invalidateCampaignBudget({
      budgetId: budget.id,
      reason: 'the allocation was never approved',
    });
    expect(results).toHaveLength(1);
    expect(results[0].reward.state).toBe('voided');
    expect(results[0].adjustment.cause).toBe('invalid_budget_allocation');

    const [after] = await db
      .select()
      .from(referralCampaignBudgets)
      .where(eq(referralCampaignBudgets.id, budget.id));
    // Marked, never deleted, never shrunk — the trail of what it paid is the
    // only way anybody can check that the money came back.
    expect(after.status).toBe('invalidated');
    expect(after.budgetMinor).toBe(30_000);
    expect(after.claimedMinor).toBe(0);
  });

  it('refuses an attribution that pins no exact rule version, and records it', async () => {
    const ruleId = `nopin-${TAG}`;
    await makeActiveRule(ruleId);
    const { programId, versionId } = await makeActiveProgram(ruleId);
    const partner = await makeApprovedPartner('nopin');
    const code = await issueCode({ partnerId: partner.id, programId });
    const paymentId = await makePaymentWithCommission(1_000);
    const { conversionId } = await makeEligibleConversion({
      programId,
      programVersionId: versionId,
      partnerId: partner.id,
      codeId: code.id,
      // A pre-#144 attribution carries the program's BARE rule ref.
      ruleVersionRef: ruleId,
      subjectRef: `buyer-nopin-${TAG}`,
      sourceRef: `order-nopin-${TAG}`,
    });

    // Resolving "whichever version is active now" is exactly what ADR 0005 D19
    // forbids, so the refusal is the correct answer rather than a gap.
    expect(await accrueRewardForConversion({ conversionId, fundingRecordRef: paymentId })).toEqual({
      outcome: 'refused',
      reason: 'no_pinned_rule_version',
    });
  });
});
