/**
 * #344's payment-facts join, and why one of its three facts has no producer —
 * both against a real server (#344, #148).
 *
 * Two halves, and they are here together because they are the same question
 * asked of the same seam:
 *
 *  1. **The two facts that ARE produced.** `disputeRateBps` and
 *     `providerAdverseOutcomeCount` are measured end to end — the referral
 *     domain's own `collectRiskSignalFacts` calling the port, the join reading
 *     `disputes`, `orders` and `payment_attempts`, and `deriveRiskSignals`
 *     turning the result into the signal an operator sees. Nothing here is
 *     mocked, because everything that could go wrong is a property of the
 *     server: the cohort predicate, the `array_agg … filter` that produces it,
 *     the `orders.payment_id` link, and the arithmetic over a denominator that
 *     came from a different statement than the numerator did.
 *  2. **The one that does not**, below.
 *
 * The load-bearing case is `the RATE is taken over the DOMAINs denominator`.
 * The fixture is built so the two candidate denominators DIFFER — 25 conversions
 * in the window, 20 of them from an order — so a join dividing by the cohort it
 * was handed instead of by the count it was told reports 1000 bps where the
 * truth is 800. Both are above the threshold, so both fire the same signal with
 * the same severity: the only thing that tells them apart is the observed value,
 * which is why this case asserts the number and not merely the kind.
 *
 * #344 lists `sharedPayoutBeneficiaryPartnerCount` as one of three facts a
 * payment-domain join would supply, and `ReferralRiskSignalFacts` states its
 * contract: *"Another approved partner resolves to the same `provider_accounts`
 * row."* **No two partners can, and two unique indexes are why.** A producer
 * would therefore return zero for every partner forever — a signal that cannot
 * fire, reporting a clean bill on somebody nobody examined, which is the exact
 * "green and inert" failure this codebase refuses everywhere else.
 *
 * The resolution partner → owner → account row is INJECTIVE at every hop:
 *
 *  1. `referral_partners_owner_key` is unique on `(owner_type, owner_id)`, so
 *     one owner pair is one partner.
 *  2. `referralPayoutAccountOwner` is the IDENTITY translation — it returns the
 *     partner's own owner pair and consults nothing — so one partner is one
 *     account owner.
 *  3. `provider_accounts_provider_account_id_key` is unique on
 *     `(provider, provider_account_id)`, so one Stripe account is one row.
 *
 * Two partners sharing a beneficiary would have to break one of the three, and
 * this file asserts all three so the finding is a GATE rather than a paragraph
 * somebody has to find. It goes red the day one of them changes, which is the
 * day the fact becomes measurable and the producer becomes worth writing.
 *
 * ## What would reopen it, precisely
 *
 * #146 increment 3's deferred **beneficiary change** — letting a partner
 * nominate a payout destination that is NOT their own owner. That breaks hop 2
 * by design: `referralPayoutAccountOwner` stops being the identity, two partners
 * can name one account, and the signal starts meaning something. Nothing else in
 * the roadmap does.
 *
 * Discovered by writing the producer and watching the fixture fail `23505` on
 * `provider_accounts_provider_account_id_key` — the constraint refusing the very
 * shape the signal exists to detect. The producer was reverted rather than
 * shipped returning zero.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb, type Database } from '../../db/postgres.js';
import {
  disputes,
  paymentAttempts,
  payments,
  providerAccounts,
} from '../../db/schema/payments.js';
import { orders } from '../../db/schema/orders.js';
import {
  referralAttributions,
  referralCodes,
  referralConversions,
  referralEvents,
  referralLinks,
  referralPartners,
  referralPrograms,
  referralTouches,
} from '../../db/schema/referrals.js';
import { insertPartner } from '../../db/referrals/partnerRepository.js';
import { insertProgramVersion } from '../../db/referrals/programRepository.js';
import { insertCode, insertLink } from '../../db/referrals/instrumentRepository.js';
import { insertTouch } from '../../db/referrals/touchRepository.js';
import { insertAttribution } from '../../db/referrals/attributionRepository.js';
import { upsertConversion } from '../../db/referrals/conversionRepository.js';
import { referralPayoutAccountOwner } from '../referral-payouts/beneficiary.js';
import { readReferralRiskPartnerPaymentFacts } from '../referral-payouts/risk-payment-facts.js';
import {
  registerReferralRiskPaymentFactsReader,
  resetReferralRiskPaymentFactsReader,
  type ReferralRiskPaymentSubject,
} from '../referrals/integrity/payment-facts.port.js';
import { collectRiskSignalFacts } from '../referrals/integrity/risk-evaluation.service.js';
import { deriveRiskSignals } from '../referrals/integrity/risk-thresholds.js';

const TAG = uuidv7().slice(-8);
let db: Database;
const trackedPartnerIds: string[] = [];
const trackedAccountIds: string[] = [];
const trackedProgramIds: string[] = [];
const trackedOrderIds: string[] = [];
const trackedPaymentIds: string[] = [];
let programId = '';
let programVersionId = '';

beforeAll(async () => {
  db = await connectPostgres();
  programId = `prog-rpf-${TAG}`;
  trackedProgramIds.push(programId);
  const program = await insertProgramVersion(db, {
    programId,
    version: 1,
    name: `Risk payment facts ${TAG}`,
    description: 'Fixture',
    publicTermsSummary: 'Earn a share of Mercaria commission.',
    family: 'buyer_referral',
    eligiblePartnerTypes: ['user'],
    eligibleSubjectKinds: ['oxy_user'],
    markets: [],
    currencies: [],
    channels: [],
    commercialModes: [],
    attributionPolicy: 'last_touch',
    attributionWindowDays: 30,
    qualifyingEventPolicy: 'first_qualifying_paid_order',
    commissionRuleRef: `rule-${TAG}:1`,
    holdDays: 60,
    payoutPolicyRef: `payout-${TAG}`,
    termsVersion: 'terms-2026-08-01',
    disclosureVersion: 'disclosure-2026-08-01',
    createdByOxyUserId: `oxy-op-${TAG}`,
    cohortKeys: [],
  });
  programVersionId = program.id;
}, 120_000);

afterEach(() => {
  // A registration is process-global. Leaving one behind would silently supply
  // this file's reader to whatever ran next in the same worker.
  resetReferralRiskPaymentFactsReader();
});

afterAll(async () => {
  // CHILDREN FIRST, and the payment side before the referral side: `disputes`
  // and `payment_attempts` are both `on delete restrict` against `payments`, so
  // deleting the payment first fails `23503` rather than cascading.
  if (trackedPaymentIds.length > 0) {
    await db.delete(disputes).where(inArray(disputes.paymentId, trackedPaymentIds));
    await db.delete(paymentAttempts).where(inArray(paymentAttempts.paymentId, trackedPaymentIds));
  }
  if (trackedOrderIds.length > 0) {
    await db.delete(orders).where(inArray(orders.id, trackedOrderIds));
  }
  if (trackedPaymentIds.length > 0) {
    await db.delete(payments).where(inArray(payments.id, trackedPaymentIds));
  }
  if (trackedPartnerIds.length > 0) {
    const attributionIds = (
      await db
        .select({ id: referralAttributions.id })
        .from(referralAttributions)
        .where(inArray(referralAttributions.partnerId, trackedPartnerIds))
    ).map((row) => row.id);
    if (attributionIds.length > 0) {
      const conversionIds = (
        await db
          .select({ id: referralConversions.id })
          .from(referralConversions)
          .where(inArray(referralConversions.attributionId, attributionIds))
      ).map((row) => row.id);
      if (conversionIds.length > 0) {
        // A conversion's own audit rows: `referral_events.subject_id` addresses
        // the CONVERSION, so deleting by partner would leave them.
        await db.delete(referralEvents).where(inArray(referralEvents.subjectId, conversionIds));
        await db.delete(referralConversions).where(inArray(referralConversions.id, conversionIds));
      }
      await db.delete(referralAttributions).where(inArray(referralAttributions.id, attributionIds));
    }
    await db.delete(referralTouches).where(inArray(referralTouches.partnerId, trackedPartnerIds));
    const codeIds = (
      await db
        .select({ id: referralCodes.id })
        .from(referralCodes)
        .where(inArray(referralCodes.partnerId, trackedPartnerIds))
    ).map((row) => row.id);
    if (codeIds.length > 0) {
      await db.delete(referralLinks).where(inArray(referralLinks.codeId, codeIds));
      await db.delete(referralCodes).where(inArray(referralCodes.id, codeIds));
    }
  }
  if (trackedAccountIds.length > 0) {
    await db.delete(providerAccounts).where(inArray(providerAccounts.id, trackedAccountIds));
  }
  if (trackedPartnerIds.length > 0) {
    await db.delete(referralPartners).where(inArray(referralPartners.id, trackedPartnerIds));
  }
  if (trackedProgramIds.length > 0) {
    await db.delete(referralPrograms).where(inArray(referralPrograms.programId, trackedProgramIds));
  }
  await closePostgres();
}, 120_000);

async function makePartner(label: string): Promise<{ id: string; ownerId: string }> {
  const ownerId = `owner-rpf-${label}-${TAG}`;
  const { row } = await insertPartner(getDb(), {
    ownerType: 'user',
    ownerId,
    displayName: `Partner ${label}`,
    // `applied` rather than `approved`: `insertPartner` only mints the three
    // pre-decision states (#146 owns the transition), and the state is
    // irrelevant here — the finding rests on the two UNIQUES, which do not read
    // it. A count over approved partners is what a producer would filter on,
    // and there is nothing for it to count either way.
    state: 'applied',
    at: new Date(),
    promotionMethods: ['website'],
  });
  trackedPartnerIds.push(row.id);
  return { id: row.id, ownerId };
}

/** Assert a REJECTION whose constraint matches, reading `cause`. */
async function expectPgRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  // Drizzle wraps the driver error, so the outer message is `Failed query: …`
  // and the constraint name lives on `cause`. Matching the outer message alone
  // passes for ANY failed statement, including a typo'd column.
  expect(failure, 'the statement was expected to be REFUSED and was not').toBeDefined();
  const cause = (failure as { cause?: { constraint_name?: string } }).cause;
  expect(cause?.constraint_name ?? '').toMatch(pattern);
}

// ─── #344's two produced facts ───────────────────────────────────────────────

/** How many conversions the fixture puts in the window, and how they split. */
const WINDOW_CONVERSIONS = 25;
const ORDER_SOURCED_CONVERSIONS = 20;
const DISPUTED_ORDERS = 2;
const DECLINED_ATTEMPTS = 3;

/** A partner with one code, one link and one link-click touch to hang attributions off. */
async function seedFunnel(label: string): Promise<{ partnerId: string; codeId: string; touchId: string }> {
  const { row: partner } = await insertPartner(getDb(), {
    ownerType: 'user',
    ownerId: `owner-rpf-${label}-${TAG}`,
    displayName: `Partner ${label} ${TAG}`,
    state: 'applied',
    at: new Date(),
    termsVersion: 'terms-2026-08-01',
    promotionMethods: ['website'],
  });
  trackedPartnerIds.push(partner.id);

  // Every instant is an OFFSET from a past anchor, never a literal:
  // `fixture-date-census.test.ts` refuses a fixture carrying a date the real
  // clock is still travelling toward, and a touch's `expires_at` is inherently
  // in the future — so the ANCHOR is what must be in the past.
  const activatedAt = new Date(Date.now() - 75 * 86_400_000);
  const touchOccurredAt = new Date(Date.now() - 60 * 86_400_000);

  const code = await insertCode(getDb(), {
    partnerId: partner.id,
    programVersionId,
    code: `c-rpf-${label}-${TAG}`.toLowerCase(),
    activatedAt,
    disclosureRequired: true,
  });
  if (!code) throw new Error('code collision in fixture');
  const link = await insertLink(getDb(), {
    id: uuidv7(),
    codeId: code.id,
    token: `t-rpf-${label}-${TAG}`,
    activatedAt,
    disclosureRequired: true,
  });
  const touch = await insertTouch(getDb(), {
    programVersionId,
    partnerId: partner.id,
    codeId: code.id,
    linkId: link.id,
    touchKind: 'link_click',
    occurredAt: touchOccurredAt,
    clientSurface: 'web',
    actorKind: 'oxy_user',
    trafficClass: 'organic',
    consentMode: 'granted',
    oxyUserId: `subject-${uuidv7().slice(-10)}`,
    attributionWindowExpiresAt: new Date(touchOccurredAt.getTime() + 30 * 86_400_000),
    expiresAt: new Date(touchOccurredAt.getTime() + 400 * 86_400_000),
  });
  if (!touch) throw new Error('touch fixture returned no row');
  return { partnerId: partner.id, codeId: code.id, touchId: touch.id };
}

/** One conversion in the window, from the named source. */
async function seedConversion(input: {
  funnel: { partnerId: string; codeId: string; touchId: string };
  sourceKind: 'order' | 'merchant_activation';
  sourceRef: string;
  convertedAt: Date;
}): Promise<void> {
  const attribution = await insertAttribution(getDb(), {
    programId,
    programVersionId,
    partnerId: input.funnel.partnerId,
    subjectKind: 'oxy_user',
    subjectRef: `subject-${uuidv7().slice(-10)}`,
    winningTouchId: input.funnel.touchId,
    winningCodeId: input.funnel.codeId,
    evidenceTouchKind: 'link_click',
    evidenceOccurredAt: new Date(input.convertedAt.getTime() - 3_600_000),
    attributionPolicy: 'last_touch',
    ruleVersionRef: `rule-${TAG}:1`,
    expiresAt: new Date(input.convertedAt.getTime() + 30 * 86_400_000),
    originalActorKind: 'oxy_user',
  });
  if (!attribution) throw new Error('attribution fixture returned no row');
  await upsertConversion(getDb(), {
    attributionId: attribution.id,
    programVersionId,
    conversionType: 'first_qualifying_paid_order',
    sourceKind: input.sourceKind,
    sourceRef: input.sourceRef,
    sourceEventId: `evt-${uuidv7().slice(-10)}`,
    occurredAt: input.convertedAt,
    // `pending`, never `reversed`: a reversed conversion would fire
    // `refund_dispute_concentration` on the REFUND branch, and
    // `risk-thresholds.ts` reports the dispute rate only when the refund rate
    // did not — so a careless fixture would make this file green while
    // measuring the producer that already existed.
    state: 'pending',
  });
}

/** A paid order pointing at a payment, so `payment_attempts` are reachable from it. */
async function seedOrder(orderId: string, paymentId: string): Promise<void> {
  const money = {
    shippingCostShopAmount: 0,
    shippingCostShopCurrency: 'EUR' as const,
    shippingCostPresentmentAmount: 0,
    shippingCostPresentmentCurrency: 'EUR' as const,
    totalsSubtotalShopAmount: 1_000,
    totalsSubtotalShopCurrency: 'EUR' as const,
    totalsSubtotalPresentmentAmount: 1_000,
    totalsSubtotalPresentmentCurrency: 'EUR' as const,
    totalsDiscountTotalShopAmount: 0,
    totalsDiscountTotalShopCurrency: 'EUR' as const,
    totalsDiscountTotalPresentmentAmount: 0,
    totalsDiscountTotalPresentmentCurrency: 'EUR' as const,
    totalsShippingShopAmount: 0,
    totalsShippingShopCurrency: 'EUR' as const,
    totalsShippingPresentmentAmount: 0,
    totalsShippingPresentmentCurrency: 'EUR' as const,
    totalsTaxShopAmount: 0,
    totalsTaxShopCurrency: 'EUR' as const,
    totalsTaxPresentmentAmount: 0,
    totalsTaxPresentmentCurrency: 'EUR' as const,
    totalsGrandTotalShopAmount: 1_000,
    totalsGrandTotalShopCurrency: 'EUR' as const,
    totalsGrandTotalPresentmentAmount: 1_000,
    totalsGrandTotalPresentmentCurrency: 'EUR' as const,
  };
  await getDb()
    .insert(orders)
    .values({
      id: orderId,
      orderNumber: `RPF-${TAG}-${orderId.slice(-6)}`,
      buyerOxyUserId: `buyer-rpf-${TAG}`,
      sellerType: 'user',
      sellerOxyUserId: `seller-rpf-${TAG}`,
      commercialRole: 'connected_marketplace',
      shippingAddressLine1: '1 Test St',
      shippingAddressCity: 'Barcelona',
      shippingAddressPostalCode: '08001',
      shippingAddressCountry: 'ES',
      shippingAddressRecipientName: 'Test Buyer',
      shippingMethod: 'standard',
      shippingLabel: 'Standard',
      status: 'paid',
      // The link the join reads. `payments.order_id` is deliberately NOT the
      // one it uses: that column is set only where one payment stands for one
      // order, so an ordinary multi-seller group carries NULL there.
      paymentId,
      ...money,
    });
  trackedOrderIds.push(orderId);
}

/** One payment aggregate the fixture's orders and disputes hang off. */
async function seedPayment(): Promise<string> {
  const paymentId = uuidv7();
  await getDb().insert(payments).values({
    id: paymentId,
    checkoutGroupId: `grp-rpf-${TAG}`,
    provider: 'stripe',
    status: 'succeeded',
    presentmentAmount: 1_000,
    presentmentCurrency: 'EUR',
  });
  trackedPaymentIds.push(paymentId);
  return paymentId;
}

describe("#344's join produces the two facts the port was declared for", () => {
  let funnel: { partnerId: string; codeId: string; touchId: string };
  let paymentId = '';
  let orderIds: string[] = [];
  const at = new Date();

  beforeAll(async () => {
    funnel = await seedFunnel('produced');
    paymentId = await seedPayment();

    // 20 ORDER-sourced conversions and 5 that are not, so the two candidate
    // denominators differ and the load-bearing case below can tell them apart.
    orderIds = Array.from({ length: ORDER_SOURCED_CONVERSIONS }, () => uuidv7());
    for (const orderId of orderIds) await seedOrder(orderId, paymentId);

    const convertedAt = new Date(at.getTime() - 3 * 3_600_000);
    for (const orderId of orderIds) {
      await seedConversion({ funnel, sourceKind: 'order', sourceRef: orderId, convertedAt });
    }
    for (let i = 0; i < WINDOW_CONVERSIONS - ORDER_SOURCED_CONVERSIONS; i += 1) {
      await seedConversion({
        funnel,
        sourceKind: 'merchant_activation',
        sourceRef: `store-rpf-${TAG}-${i}`,
        convertedAt,
      });
    }

    for (let i = 0; i < DISPUTED_ORDERS; i += 1) {
      await getDb().insert(disputes).values({
        id: uuidv7(),
        provider: 'stripe',
        providerDisputeId: `dp_rpf_${TAG}_${i}`,
        paymentId,
        orderId: orderIds[i],
        amountAmount: 1_000,
        amountCurrency: 'EUR',
        status: 'needs_response',
      });
    }

    for (let i = 0; i < DECLINED_ATTEMPTS; i += 1) {
      await getDb().insert(paymentAttempts).values({
        id: uuidv7(),
        paymentId,
        sequence: i + 1,
        provider: 'stripe',
        status: 'failed',
      });
    }
    // The positive control on the decline count: a SUCCEEDED attempt on the same
    // payment must not be counted, so a producer that forgot its status filter
    // reports 4 rather than 3 and this file goes red.
    await getDb().insert(paymentAttempts).values({
      id: uuidv7(),
      paymentId,
      sequence: DECLINED_ATTEMPTS + 1,
      provider: 'stripe',
      status: 'succeeded',
    });
  }, 180_000);

  it('the RATE is taken over the DOMAINs denominator, not over the cohort it was handed', async () => {
    // THE load-bearing case. `deriveRiskSignals` guards both rates behind
    // `conversionsInWindow >= minimumRateSample`, so a join dividing by a number
    // it derived itself would have the sample floor guarding one denominator
    // while the rate measured another. The fixture makes the two differ:
    //   over the 25 conversions the domain counted   → 2/25  =  800 bps
    //   over the 20 order-sourced refs it was handed → 2/20  = 1000 bps
    // Both clear the 200 bps threshold and both fire the same kind at the same
    // severity, so the VALUE is the only thing that discriminates them.
    registerReferralRiskPaymentFactsReader(readReferralRiskPartnerPaymentFacts);

    const facts = await collectRiskSignalFacts(getDb(), { partnerId: funnel.partnerId, at });

    expect(facts.conversionsInWindow).toBe(WINDOW_CONVERSIONS);
    expect(facts.disputeRateBps).toBe(
      Math.round((DISPUTED_ORDERS * 10_000) / WINDOW_CONVERSIONS),
    );
    expect(facts.disputeRateBps).toBe(800);
    // And the value a cohort-denominated join would have produced is a DIFFERENT
    // number, which is what makes the assertion above discriminating rather than
    // merely true.
    expect(Math.round((DISPUTED_ORDERS * 10_000) / ORDER_SOURCED_CONVERSIONS)).not.toBe(
      facts.disputeRateBps,
    );
  });

  it('counts each DECLINE once, not once per referred order sharing its payment', async () => {
    // This case FOUND A REAL BUG and is kept in the shape that found it. All
    // twenty fixture orders point at ONE payment, which is not a contrivance —
    // it is what a multi-seller checkout group looks like, and the reason
    // `payments.order_id` is null for one while `orders.payment_id` is stamped
    // on each. A plain `count(*)` over the join therefore multiplies every
    // declined attempt by the number of referred orders on that payment: the
    // first run of this file reported 60 for three declines, which would have
    // manufactured an `elevated` signal out of an ordinary basket.
    //
    // The gap between 3 and 60 is the whole assertion, so the fixture must keep
    // several orders on one payment for it to mean anything.
    registerReferralRiskPaymentFactsReader(readReferralRiskPartnerPaymentFacts);
    const facts = await collectRiskSignalFacts(getDb(), { partnerId: funnel.partnerId, at });
    expect(facts.providerAdverseOutcomeCount).toBe(DECLINED_ATTEMPTS);
    // The positive control on the fixture itself: if these ever stopped sharing
    // a payment the case above would pass while measuring nothing.
    const distinctPayments = await getDb()
      .selectDistinct({ paymentId: orders.paymentId })
      .from(orders)
      .where(inArray(orders.id, orderIds));
    expect(distinctPayments).toHaveLength(1);
    expect(orderIds.length).toBeGreaterThan(1);
  });

  it('`refund_dispute_concentration` now fires on the DISPUTE half, at `high`', async () => {
    // The half #344 exists to close. Before it, `refundRateBps` computed and
    // `disputeRateBps` did not, so the kind fired on refunds only while reading
    // as though it covered both. The refund rate here is ZERO — no conversion in
    // the fixture is `reversed` — so the branch reached is unambiguously the
    // dispute one, which `risk-thresholds.ts` reports at `high` rather than the
    // refund branch's `elevated`.
    registerReferralRiskPaymentFactsReader(readReferralRiskPartnerPaymentFacts);
    const facts = await collectRiskSignalFacts(getDb(), { partnerId: funnel.partnerId, at });
    expect(facts.refundRateBps).toBe(0);

    const signals = deriveRiskSignals(facts);
    const concentration = signals.filter((s) => s.kind === 'refund_dispute_concentration');
    expect(concentration).toHaveLength(1);
    expect(concentration[0]?.severity).toBe('high');
    expect(concentration[0]?.observedValue).toBe(800);

    // The other fact reaches its own signal too, and `provider_risk_outcome` is a
    // SEPARATE kind — a dispute is never scored under both.
    expect(signals.filter((s) => s.kind === 'provider_risk_outcome')).toHaveLength(1);
  });

  it('is ACTUALLY CALLED by the entrypoint, with the cohort taken from one statement', async () => {
    // The "registered, tested, zero callers" failure, asserted at the level that
    // matters here: not that `index.ts` mentions the registrar, but that
    // `collectRiskSignalFacts` reaches the port and hands it the population it
    // measured. A spy rather than the real join, so what is under test is the
    // CALL and not the SQL the cases above already cover.
    const seen: ReferralRiskPaymentSubject[] = [];
    registerReferralRiskPaymentFactsReader(async (subject) => {
      seen.push(subject);
      return {};
    });

    await collectRiskSignalFacts(getDb(), { partnerId: funnel.partnerId, at });

    expect(seen).toHaveLength(1);
    const subject = seen[0];
    expect(subject?.partnerId).toBe(funnel.partnerId);
    expect(subject?.conversionsInWindow).toBe(WINDOW_CONVERSIONS);
    expect(subject?.orderCohort.kind).toBe('enumerated');
    if (subject?.orderCohort.kind !== 'enumerated') {
      expect.unreachable('the fixture cohort is far below the bound');
      return;
    }
    // Exactly the ORDER-sourced conversions, and the five `merchant_activation`
    // ones are absent: their `source_ref` names a store, and asking the payment
    // domain about it by order id would answer for a row that does not exist.
    expect([...subject.orderCohort.orderRefs].sort()).toEqual([...orderIds].sort());
  });

  it('answers UNMEASURED rather than a truncated rate when the cohort is too large', async () => {
    // The failure direction that matters: a rate over a sliced cohort
    // under-reports, which is the reassuring direction, on a fraud measurement.
    // Driven through the join directly, because forcing the branch through
    // `collectRiskSignalFacts` would need ten thousand fixture rows.
    const facts = await readReferralRiskPartnerPaymentFacts({
      partnerId: funnel.partnerId,
      ownerType: 'user',
      ownerId: `owner-rpf-produced-${TAG}`,
      windowStart: new Date(at.getTime() - 86_400_000),
      windowEnd: at,
      conversionsInWindow: WINDOW_CONVERSIONS,
      orderCohort: { kind: 'not_enumerable', reason: 'cohort_exceeds_bound' },
    });
    // BOTH withheld together: the count is over the same population as the rate,
    // so serving one of them would report a partial cohort under a whole fact's
    // name.
    expect(facts).toEqual({});
  });

  it('a rate over ZERO conversions is absent, never a clean 0 bps', async () => {
    const facts = await readReferralRiskPartnerPaymentFacts({
      partnerId: funnel.partnerId,
      ownerType: 'user',
      ownerId: `owner-rpf-produced-${TAG}`,
      windowStart: new Date(at.getTime() - 86_400_000),
      windowEnd: at,
      conversionsInWindow: 0,
      orderCohort: { kind: 'enumerated', orderRefs: [] },
    });
    expect('disputeRateBps' in facts).toBe(false);
    // The COUNT is still supplied, and that asymmetry is the point: "we counted
    // and found none" is a measurement, while a rate over nothing is not.
    expect(facts.providerAdverseOutcomeCount).toBe(0);
  });

  it('a partner with orders but no disputes reports 0 bps, which IS a measurement', async () => {
    // The other side of the rule above, and the reason it is not simply "absent
    // is safe": a cohort that was measured and found clean must say so, or an
    // operator cannot tell a clean partner from an unmeasured one.
    const clean = await seedFunnel('clean');
    const cleanOrderId = uuidv7();
    await seedOrder(cleanOrderId, paymentId);
    await seedConversion({
      funnel: clean,
      sourceKind: 'order',
      sourceRef: cleanOrderId,
      convertedAt: new Date(at.getTime() - 3 * 3_600_000),
    });

    registerReferralRiskPaymentFactsReader(readReferralRiskPartnerPaymentFacts);
    const facts = await collectRiskSignalFacts(getDb(), { partnerId: clean.partnerId, at });

    expect(facts.conversionsInWindow).toBe(1);
    expect(facts.disputeRateBps).toBe(0);
    // Below `minimumRateSample`, so nothing fires — the floor, not the rate.
    expect(deriveRiskSignals(facts).filter((s) => s.kind === 'refund_dispute_concentration'))
      .toHaveLength(0);
  });
});

describe('a shared payout beneficiary is UNREPRESENTABLE, so the signal has no producer', () => {
  it('hop 3: one Stripe account cannot be named by two `provider_accounts` rows', async () => {
    // The measured refusal that ended the producer. Two owners, one connected
    // account — the fraud shape the signal describes — is refused by the
    // database, so a count over `provider_account_id` is a count that is always
    // zero.
    const first = await makePartner('acct-a');
    const second = await makePartner('acct-b');
    const shared = `acct_shared_${TAG}`;

    const firstId = uuidv7();
    trackedAccountIds.push(firstId);
    await getDb().insert(providerAccounts).values({
      id: firstId,
      provider: 'stripe',
      ownerType: 'user',
      ownerId: first.ownerId,
      providerAccountId: shared,
      country: 'ES',
      onboardingState: 'ready',
    });

    await expectPgRejection(
      getDb().insert(providerAccounts).values({
        id: uuidv7(),
        provider: 'stripe',
        ownerType: 'user',
        ownerId: second.ownerId,
        providerAccountId: shared,
        country: 'ES',
        onboardingState: 'ready',
      }),
      /provider_accounts_provider_account_id_key/,
    );
  });

  it('hop 1: one owner pair is one partner, and the repository CONVERGES', async () => {
    // Not a refusal: `insertPartner` is `onConflictDoNothing` on exactly
    // `(owner_type, owner_id)` followed by a read-back, so a second enrolment
    // for one owner hands back the FIRST partner rather than raising. That is
    // the stronger evidence — the production path itself treats one owner pair
    // as one partner, so "two partners sharing an owner" is not a state a
    // caller can reach even by trying.
    const partner = await makePartner('dup');
    const again = await insertPartner(getDb(), {
      ownerType: 'user',
      ownerId: partner.ownerId,
      displayName: 'Rival',
      state: 'applied',
      at: new Date(),
      promotionMethods: ['website'],
    });

    expect(again.created).toBe(false);
    expect(again.row.id).toBe(partner.id);
    // And the name the second caller supplied did NOT overwrite the first,
    // which is what makes this a convergence rather than a quiet update.
    expect(again.row.displayName).toBe('Partner dup');
  });

  it('hop 2: the owner translation is the IDENTITY and consults nothing', () => {
    // A pure assertion rather than a database one, because this is the hop
    // #146's deferred beneficiary change would break — and when it does, the
    // whole finding expires and the producer becomes worth writing.
    const owner = referralPayoutAccountOwner({ ownerType: 'user', ownerId: `o-${TAG}` });
    expect(owner).toEqual({ ownerType: 'user', ownerId: `o-${TAG}` });
  });

  it('both indexes EXIST, which is what makes the three assertions above non-vacuous', async () => {
    // A refusal test passes just as happily when the statement fails for an
    // unrelated reason, and a `toMatch` over a missing constraint name would
    // report the empty string. Reading `pg_indexes` is the positive control:
    // it names what must be present for the finding to hold, so dropping either
    // turns THIS red rather than silently making the refusals untestable.
    const rows = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
      where indexname in ('provider_accounts_provider_account_id_key', 'referral_partners_owner_key')
    `);
    const found = [...rows].map((r) => r.indexname).sort();
    expect(found).toEqual(['provider_accounts_provider_account_id_key', 'referral_partners_owner_key']);
  });
});
