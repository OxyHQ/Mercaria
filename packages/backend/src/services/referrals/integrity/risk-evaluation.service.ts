/**
 * Measuring a partner's behaviour, and recording what was measured (#148
 * "Risk signals", ADR 0005 D17).
 *
 * ## Everything it reads is Mercaria's own commerce record
 *
 * Touches this domain wrote, conversions it verified, rewards it accrued,
 * enforcement it imposed. Not one query in this file reads a request header, a
 * cookie, an IP, a user agent or anything from the payment domain but an
 * OUTCOME already recorded as a conversion state. That is D17's other half:
 * *"fraud evaluation reads Mercaria's own commerce facts — orders, refunds,
 * disputes, memberships, velocities. It never builds or consults a device or
 * contact fingerprint."*
 *
 * ## The FACTS type is the wall
 *
 * `collectRiskSignalFacts` returns a `ReferralRiskSignalFacts`, which has a
 * field for every permitted signal and none for any forbidden one. So the
 * detector in `risk-thresholds.ts` is pure and cannot be handed an identifier
 * even by a future caller that wanted to — there is no parameter to put one in.
 *
 * ## An UNMEASURED fact is left out, never zeroed
 *
 * A partner with no conversions in the window gets `conversionsInWindow: 0`
 * (which IS a measurement — we counted and found none) and NO refund rate at
 * all (which is not: a rate over zero conversions is undefined, and a zero
 * would put a clean refund rate on a record that has none). The sample floor in
 * `risk-thresholds.ts` is the second half of the same rule.
 *
 * ## Recording is not enforcing
 *
 * This service writes `referral_risk_signals` and NOTHING else. It imposes no
 * action, freezes no reward and suspends nobody — a signal is a reason to look.
 * `referral_enforcement_actions_forfeiture_basis_check` is what makes that
 * safe: an action built on these can never destroy money, whatever a future
 * caller decides to do with them.
 */

import { and, eq, gte, inArray, like, lt, or, sql } from 'drizzle-orm';
import type {
  ReferralRewardRefusalReason,
  ReferralRiskSignalFacts,
  ReferralRiskSubjectType,
} from '@mercaria/shared-types';
import { REFERRAL_RETENTION_POLICY } from '@mercaria/shared-types';
import { notFound } from '../../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import { appendReferralEvent } from '../../../db/referrals/eventRepository.js';
import { findPartnerById } from '../../../db/referrals/partnerRepository.js';
import {
  referralAttributions,
  referralConversions,
  referralEvents,
  referralPartners,
  referralTouches,
} from '../../../db/schema/referrals.js';
import { referralEnforcementActions } from '../../../db/schema/referralIntegrity.js';
import {
  insertRiskSignals,
  type NewReferralRiskSignal,
  type ReferralRiskSignalRow,
} from '../../../db/referralIntegrity/riskSignalRepository.js';
import {
  readReferralRiskPaymentFacts,
} from './payment-facts.port.js';
import {
  deriveRiskSignals,
  REFERRAL_RISK_THRESHOLD_DEFAULTS,
  type ReferralRiskThresholds,
} from './risk-thresholds.js';

/** The window every velocity threshold is measured over. ADR 0005 D17: per DAY. */
const WINDOW_MS = 24 * 60 * 60 * 1_000;

/** 10_000 basis points is 100%. */
const BPS = 10_000;

/** How long a recorded signal is kept — `REFERRAL_RETENTION_POLICY.risk_signal`. */
const SIGNAL_RETENTION_DAYS = REFERRAL_RETENTION_POLICY.risk_signal.sweptAfterDays ?? 400;

/**
 * The conversion states that mean the money came back.
 *
 * `reversed` is #142's state for a conversion whose funding was undone — a
 * refund or a lost dispute. `rejected` is a conversion that never qualified,
 * which is a different fact and is deliberately NOT counted as a refund: a
 * partner whose conversions are refused for `zero_base` has an ineligible
 * cohort, not a refunding one, and folding the two would report the honest
 * retail referrer as a fraud risk.
 */
const REVERSED_CONVERSION_STATES = ['reversed'] as const;

/**
 * The accrual refusals `repeated_cap_attempt` counts.
 *
 * TYPED as `ReferralRewardRefusalReason`, so renaming either member in
 * `@mercaria/shared-types` fails `tsc` here rather than silently making this
 * counter read zero forever — which is the failure this producer exists to
 * avoid, one level up.
 *
 * The other eleven refusal reasons are deliberately excluded: a conversion
 * refused for `zero_base` or `rule_not_active` is a partner whose cohort or
 * whose programme did not qualify, and counting those as "repeatedly probing a
 * cap" would report the honest referrer of unprofitable orders as a fraud
 * signal. #148's kind is `repeated_cap_attempt`, and a cap is what these two
 * name.
 */
const CAP_REFUSAL_REASONS: readonly ReferralRewardRefusalReason[] = [
  'cap_reached',
  'budget_exhausted',
];

/**
 * The evidence kind `click_to_conversion_pattern` may be measured over.
 *
 * ONLY `link_click`, and this is the single most load-bearing decision in the
 * two producers. `code_entry_at_checkout` is a partner's code typed INTO the
 * checkout form, so the interval between that evidence and the conversion is
 * seconds BY CONSTRUCTION — measuring it would fire
 * `click_to_conversion_pattern` on every honest checkout-code redemption there
 * has ever been, and the signal's own comment ("a conversion in under five
 * seconds of the click is not somebody reading a product page") is false of it.
 * `code_entry_in_app` is excluded for the same reason with less margin.
 *
 * The consequence is stated rather than hidden: a partner who promotes ONLY by
 * code has no measurement here at all, and gets no signal rather than a clean
 * one — `undefined`, never a reassuring number.
 */
const CLICK_EVIDENCE_KIND = 'link_click';

/**
 * Measure one partner over the trailing window.
 *
 * Six bounded reads, all scoped to the partner: this is not a sweep and it does
 * not scan a table. Every one counts rows Mercaria's own commerce wrote.
 *
 * ## Which facts this supplies, and which are still nobody's
 *
 * Supplied: `touchesInWindow`, `conversionsInWindow`, `refundRateBps`,
 * `priorConfirmedEnforcementCount`, and — added here —
 * `medianClickToConversionSeconds` and `capRefusalCount`.
 *
 * NOT supplied, and each for a reason rather than an omission. `undefined`
 * reaches `deriveRiskSignals`, which emits nothing for it, so an absence is a
 * SILENCE rather than a clean bill — which is the whole reason these are worth
 * writing down rather than leaving as a gap somebody fills by guessing:
 *
 *  - `declaredRelatedParty` and `merchantMembershipOverlap` — both are ALREADY
 *    DERIVED, in `collectSelfReferralFacts` beside this file, as
 *    `relatedPartyDeclared` and `partnerHoldsReferredStoreMembership`. Adding a
 *    second derivation here is the "two spellings of one rule" defect, and the
 *    two would disagree the first time either read changed. Closing them means
 *    EXTRACTING the shared reads (`holdsStoreMembership` and the application
 *    lookup) into helpers both callers use — a refactor of a live attribution
 *    gate, which is its own change rather than a producer.
 *  - `referredAccountAgeDays` — the referred Oxy account's creation date. #164
 *    deleted Mercaria's service principal and WALL 6 of
 *    `referral-integrity-isolation.test.ts` forbids an outbound HTTP call, so
 *    it needs a port plus a credential that does not exist.
 *  - `disputeRateBps`, `providerAdverseOutcomeCount`,
 *    `sharedPayoutBeneficiaryPartnerCount` — all three read the PAYMENT domain
 *    (`provider_accounts` lives in `db/schema/payments.ts`), which WALL 2
 *    forbids importing. **The SEAM now exists** — `payment-facts.port.ts`, read
 *    above — and NOTHING registers a reader, so all three stay absent on every
 *    deployment. What is owed is the join's three queries, not another port.
 *    The shape it wants is #146's: a port in
 *    `services/referrals/earnings/` registered from a module outside both
 *    walled domains, as `partner-readiness.port.ts` is.
 *  - `marketOutsideProgramScope` — the fact as SPECIFIED is not representable.
 *    `ReferralRiskSignalFacts` calls it "the conversion's market"; neither a
 *    touch nor a conversion carries one (#149 relies on exactly this — a
 *    market-scoped stop is refused at publish for the same reason). Only the
 *    INSTRUMENT does, and deriving from `referral_codes.market` would answer a
 *    different question under the same name.
 *  - `sourceEventInconsistent` — no relationship exists between a referral
 *    partner and a #62/#65 source event to aggregate over.
 */
export async function collectRiskSignalFacts(
  db: DatabaseOrTransaction,
  input: { partnerId: string; at: Date },
): Promise<ReferralRiskSignalFacts> {
  const windowStart = new Date(input.at.getTime() - WINDOW_MS);

  const [touchRow] = await db
    .select({ total: sql<string>`count(*)` })
    .from(referralTouches)
    .where(
      and(
        eq(referralTouches.partnerId, input.partnerId),
        gte(referralTouches.occurredAt, windowStart),
        lt(referralTouches.occurredAt, input.at),
      ),
    );

  const [conversionRow] = await db
    .select({
      total: sql<string>`count(*)`,
      reversed: sql<string>`count(*) filter (where ${inArray(
        referralConversions.state,
        [...REVERSED_CONVERSION_STATES],
      )})`,
    })
    .from(referralConversions)
    .innerJoin(
      referralAttributions,
      eq(referralConversions.attributionId, referralAttributions.id),
    )
    .where(
      and(
        eq(referralAttributions.partnerId, input.partnerId),
        gte(referralConversions.occurredAt, windowStart),
        lt(referralConversions.occurredAt, input.at),
      ),
    );

  const [priorRow] = await db
    .select({ total: sql<string>`count(*)` })
    .from(referralEnforcementActions)
    .where(
      and(
        eq(referralEnforcementActions.partnerId, input.partnerId),
        inArray(referralEnforcementActions.basis, ['identity_evidence', 'operator_finding']),
      ),
    );

  // `click_to_conversion_pattern` — the median gap between the winning EVIDENCE
  // and its conversion, over link clicks only (see `CLICK_EVIDENCE_KIND`).
  // `evidence_occurred_at` is already on the attribution, so this needs no join
  // to `referral_touches` and measures exactly the touch that won.
  const [clickRow] = await db
    .select({
      sampled: sql<string>`count(*)`,
      medianSeconds: sql<
        string | null
      >`percentile_cont(0.5) within group (order by extract(epoch from (${referralConversions.occurredAt} - ${referralAttributions.evidenceOccurredAt})))`,
    })
    .from(referralConversions)
    .innerJoin(referralAttributions, eq(referralConversions.attributionId, referralAttributions.id))
    .where(
      and(
        eq(referralAttributions.partnerId, input.partnerId),
        eq(referralAttributions.evidenceTouchKind, CLICK_EVIDENCE_KIND),
        gte(referralConversions.occurredAt, windowStart),
        lt(referralConversions.occurredAt, input.at),
      ),
    );

  // `repeated_cap_attempt` — accruals this partner's conversions were refused
  // for hitting a cap or exhausting a budget. The refusal REASON CODE is not a
  // column: `reward.service.ts` writes it as the `<code>: <detail>` prefix of
  // `referral_events.reason`, so this matches that prefix. A `refusal_reason`
  // column would be the honest fix and belongs to the reward domain rather than
  // here — stated in the PR rather than worked around silently.
  const [capRow] = await db
    .select({ total: sql<string>`count(*)` })
    .from(referralEvents)
    .innerJoin(referralConversions, eq(referralConversions.id, referralEvents.subjectId))
    .innerJoin(referralAttributions, eq(referralConversions.attributionId, referralAttributions.id))
    .where(
      and(
        eq(referralEvents.subjectType, 'conversion'),
        eq(referralEvents.action, 'reward_accrual_refused'),
        or(...CAP_REFUSAL_REASONS.map((reason) => like(referralEvents.reason, `${reason}: %`))),
        eq(referralAttributions.partnerId, input.partnerId),
        gte(referralEvents.createdAt, windowStart),
        lt(referralEvents.createdAt, input.at),
      ),
    );

  // Who the partner IS. The port's subject carries the OWNER rather than only
  // the partner id, because the join resolves a connected account by
  // (ownerType, ownerId) — #146's `referralPayoutAccountOwner` — and passing
  // the id alone would make the join look the partner up a second time through
  // a repository the referral domain would then have to hand it.
  const [partnerOwner = { ownerType: 'user' as const, ownerId: '' }] = await db
    .select({ ownerType: referralPartners.ownerType, ownerId: referralPartners.ownerId })
    .from(referralPartners)
    .where(eq(referralPartners.id, input.partnerId))
    .limit(1);

  // The PAYMENT-domain facts, through #344's port. Unregistered — which is
  // every deployment today — this answers `{}`, so the three facts stay absent
  // and `deriveRiskSignals` emits nothing for them. See the port for why its
  // default is silence where `partner-readiness.port.ts`' is refusal.
  const paymentFacts = await readReferralRiskPaymentFacts({
    partnerId: input.partnerId,
    ownerType: partnerOwner.ownerType,
    ownerId: partnerOwner.ownerId,
    windowStart,
    windowEnd: input.at,
  });

  // postgres.js decodes `count(*)` (an int8) as a STRING, and drizzle types it
  // `number`. `Number(...)` at the boundary, once, rather than at each use —
  // a missed coercion here is arithmetic on a string, which concatenates
  // silently and reports a velocity of "0500". `percentile_cont` over an
  // `extract(epoch …)` returns NUMERIC, which postgres.js decodes as a string
  // too, so the same rule applies with more force: it is compared against a
  // threshold rather than only reported.
  const touches = Number(touchRow?.total ?? 0);
  const conversions = Number(conversionRow?.total ?? 0);
  const reversed = Number(conversionRow?.reversed ?? 0);
  const priorEnforcement = Number(priorRow?.total ?? 0);
  const clicksSampled = Number(clickRow?.sampled ?? 0);

  const facts: ReferralRiskSignalFacts = {
    touchesInWindow: touches,
    conversionsInWindow: conversions,
    priorConfirmedEnforcementCount: priorEnforcement,
    // A COUNT of refusals is a measurement at zero — we counted and found none,
    // exactly as `conversionsInWindow: 0` is — so it is always supplied. The
    // median below is not: a partner with no link-click conversions in the
    // window has nothing to take a median OF.
    capRefusalCount: Number(capRow?.total ?? 0),
    // Absent on every deployment until #344's join is registered. Spread
    // rather than assigned, so an unregistered read adds NO keys at all and
    // cannot make `disputeRateBps: undefined` look like a field somebody set.
    ...paymentFacts,
    ...(clicksSampled > 0 && clickRow?.medianSeconds != null
      ? { medianClickToConversionSeconds: Number(clickRow.medianSeconds) }
      : {}),
  };
  // A rate over zero conversions is UNDEFINED, not zero — see the docblock.
  // Left off the object entirely rather than set to 0, because `undefined`
  // means "not measured" everywhere in this domain and `0` would assert a
  // clean cohort nobody counted.
  if (conversions > 0) {
    return { ...facts, refundRateBps: Math.round((reversed * BPS) / conversions) };
  }
  return facts;
}

/**
 * Measure a partner and record whatever fired.
 *
 * Returns the rows written, which may legitimately be EMPTY — a partner within
 * every threshold produces no signals, and writing a "nothing found" row would
 * make the signal table a heartbeat with the findings buried in it. The
 * `referral_events` row is written only when something fired, for the same
 * reason.
 */
export async function evaluatePartnerRisk(input: {
  partnerId: string;
  at?: Date;
  thresholds?: ReferralRiskThresholds;
}): Promise<readonly ReferralRiskSignalRow[]> {
  const at = input.at ?? new Date();
  const thresholds = input.thresholds ?? REFERRAL_RISK_THRESHOLD_DEFAULTS;
  const db = getDb();

  return await db.transaction(async (tx) => {
    const partner = await findPartnerById(tx, input.partnerId);
    if (!partner) throw notFound('Referral partner not found');

    const facts = await collectRiskSignalFacts(tx, { partnerId: input.partnerId, at });
    const derived = deriveRiskSignals(facts, thresholds);
    if (derived.length === 0) return [];

    const windowStart = new Date(at.getTime() - WINDOW_MS);
    const expiresAt = new Date(at.getTime() + SIGNAL_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
    const rows = await insertRiskSignals(
      tx,
      derived.map(
        (signal): NewReferralRiskSignal => ({
          partnerId: input.partnerId,
          subjectType: 'partner' satisfies ReferralRiskSubjectType,
          subjectId: input.partnerId,
          kind: signal.kind,
          severity: signal.severity,
          observedValue: signal.observedValue,
          thresholdValue: signal.thresholdValue,
          windowStart,
          windowEnd: at,
          recordedByKind: 'system',
          expiresAt,
        }),
      ),
    );

    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: input.partnerId,
      action: 'partner_risk_signal_recorded',
      actorKind: 'system',
      reason: `${rows.length} signal(s): ${derived.map((s) => s.kind).join(', ')}`,
    });
    return rows;
  });
}

/**
 * Record one signal an OPERATOR observed by hand.
 *
 * `manual_evidence` is the only kind whose CHECK requires an operator, and this
 * is the only writer that supplies one — a system-recorded "manual evidence"
 * would let an automated sweep produce the one kind a reviewer trusts most.
 */
export async function recordManualRiskSignal(input: {
  partnerId: string;
  subjectType: ReferralRiskSubjectType;
  subjectId: string;
  note: string;
  evidenceRef?: string;
  actorOxyUserId: string;
  at?: Date;
}): Promise<ReferralRiskSignalRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const partner = await findPartnerById(tx, input.partnerId);
    if (!partner) throw notFound('Referral partner not found');
    const [row] = await insertRiskSignals(tx, [
      {
        partnerId: input.partnerId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        kind: 'manual_evidence',
        severity: 'informational',
        observedValue: 1,
        windowStart: at,
        windowEnd: at,
        evidenceRef: input.evidenceRef,
        recordedByKind: 'operator',
        recordedByOxyUserId: input.actorOxyUserId,
        note: input.note.trim(),
        expiresAt: new Date(at.getTime() + SIGNAL_RETENTION_DAYS * 24 * 60 * 60 * 1_000),
      },
    ]);
    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: input.partnerId,
      action: 'partner_risk_signal_recorded',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: `manual_evidence on ${input.subjectType}`,
    });
    return row;
  });
}
