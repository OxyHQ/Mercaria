/**
 * The referral PARTNER DASHBOARD and the operator's program management (#147,
 * under ADR 0005 A5 and D19).
 *
 * #142 shipped the model, #143 the attribution edge, #144 the versioned rules,
 * #145 the earnings ledger and #146 enrollment plus the payout rail. Every one
 * of them left a partner-safe projection behind — `ReferralProgramPartnerView`,
 * `ReferralCodePartnerView`, `ReferralLinkPartnerView`,
 * `ReferralAttributionPartnerView`, `ReferralRewardPartnerView`,
 * `ReferralPayoutBatchPartnerView` — and NOTHING consumed any of them. This is
 * the composition that does, plus the two things a composition needs and none
 * of the parts could supply: a disclosure floor and a statement of what every
 * figure means.
 *
 * ## The one rule that shapes all of it
 *
 * ADR 0005 A5: "Partner-visible data is aggregated and minimized, and can never
 * expose buyer personal data … per-period counts (touches, conversions), and
 * per-reward `{day-granularity date, state, net amount, source, campaign}`. It
 * carries **no** buyer name, contact, order id, order contents, address, or
 * free text, in any form, at any aggregation level."
 *
 * A dashboard is exactly where "who did I refer" becomes a list of people, and
 * the mechanism is never a leaked column — it is a BREAKDOWN whose cells hold
 * one row each. So the composition adds two things the per-row DTOs cannot:
 * {@link REFERRAL_PARTNER_DISCLOSURE_FLOOR} over the dimensions that describe
 * the referred SUBJECT, and the refusal of cross-tabs (see
 * {@link ReferralPerformanceDimension}).
 *
 * ## Why there is no conversion RATE
 *
 * #37 acceptance 3 forbids dividing clicks by conversions and #67 states the
 * reason in the affiliate domain: a conversion is revisable for weeks (here, a
 * 60-day hold plus every refund that shrinks its base — ADR 0005 R1/R2) while a
 * click is not, so the ratio moves without either input being wrong. It is
 * additionally not a rate over ONE population here: ADR 0005 D4 admits a code
 * typed at checkout as a touch, so a conversion can exist with no click behind
 * it at all.
 *
 * {@link ReferralPartnerPerformance} therefore has no rate field. The two
 * counts are published beside each other, each naming its own definition, so
 * anybody who wants the ratio takes it knowingly rather than reading one
 * Mercaria computed and vouched for.
 */

import type { CurrencyCode } from './money';
import type {
  ReferralAttributionPartnerView,
  ReferralClientSurface,
  ReferralCodePartnerView,
  ReferralConversionType,
  ReferralLinkPartnerView,
  ReferralProgramFamily,
  ReferralProgramPartnerView,
  ReferralProgramStatus,
} from './referral';
import type { ReferralPayoutBatchPartnerView } from './referral-earnings';
import type {
  ReferralFundingSourceId,
  ReferralRewardPartnerView,
  ReferralRewardState,
} from './referral-reward';

// ─── The disclosure floor ────────────────────────────────────────────────────

/**
 * The minimum count a SUBJECT-REVEALING breakdown cell must reach before its
 * number may be published to a partner.
 *
 * **TEN, and it is #77's number rather than a new one.** The merchant analytics
 * surface suppresses below ten for the identical risk — a small count plus a
 * timestamp is a person — and a second figure here would be a second answer to
 * one question, decided by whichever surface a reader happened to open.
 *
 * **Withheld, never rounded.** #77 states why and it applies verbatim: "under
 * 10" plus a timestamp is a person, and rounding UP to ten asserts a count
 * nobody measured. {@link ReferralCountDisclosure}'s withheld branch therefore
 * carries no number at all, so no client can render it as `0` — the
 * `RankingSignalOutcome` device, and the reason this is a union rather than a
 * nullable integer.
 */
export const REFERRAL_PARTNER_DISCLOSURE_FLOOR = 10;

/**
 * ## Suppression DROPS the row, and that is the whole mechanism
 *
 * The obvious shape — publish every key and replace a small count with a
 * `withheld` marker — leaks the thing the floor exists to protect. A row's KEY
 * is itself the disclosure: `{ market: 'AD', count: withheld }` tells a partner
 * they referred somebody in Andorra, which is precisely the fact a count of one
 * would have told them. So a cell under the floor is removed entirely and only
 * a COUNT of removals is published; a count is not a key.
 *
 * That is why there is no `ReferralCountDisclosure` union here. One was written
 * first, with a `withheld` branch carrying no number so a client could not
 * render it as zero — the right device for the wrong problem, and it would have
 * shipped a mechanism that reads as protection while publishing the key. Every
 * `humanClicks` and `qualifiedConversions` below is therefore a plain number,
 * and the invariant is that a published row cleared the floor.
 *
 * ## And a residual is a leak too
 *
 * {@link ReferralPartnerPerformance.totals} is published, so subtracting the
 * disclosed rows from it yields exactly the suppressed mass. With ONE row
 * suppressed that is the row, recovered in full. So suppression is
 * COMPLEMENTARY: rows are removed smallest-first until at least two are gone
 * AND their combined count is at least the floor, and when neither can be
 * achieved the whole breakdown is withheld. The cost is stated rather than
 * hidden — a partner with one small market loses their second-smallest market
 * too, and a partner with fewer than ten conversions overall sees no
 * subject-revealing breakdown at all until they have.
 */

// ─── Performance dimensions ──────────────────────────────────────────────────

/**
 * A dimension a partner may break their own performance down by.
 *
 * ONE at a time, never a cross-tab, and that is a decision rather than an
 * omission: a market × date cell at count one is a person even when both
 * margins clear the floor, so offering only single-dimension breakdowns is what
 * keeps {@link REFERRAL_PARTNER_DISCLOSURE_FLOOR} meaningful.
 * {@link ReferralPerformanceQuery} has one `dimension` field and no array.
 *
 * ## Six, not nine, and the three that left are a decision
 *
 * #147's "Performance views" lists nine. Six of them describe a fact BOTH a
 * click and a conversion carry, and those are the six here. The other three do
 * not exist on the click side at all:
 *
 *  - `conversion_type` — a click has no conversion type; it happened before any
 *    conversion did.
 *  - `commission_state` — a reward's state. A click never has one.
 *  - `payout_period` — the batch a reward was paid in. Likewise.
 *
 * A breakdown offering them would have to answer `0` for every click cell, and
 * a zero standing in for "this dimension does not apply to this measurement" is
 * exactly the quiet zero this domain refuses everywhere else. All three are
 * ANSWERED, by {@link ReferralPartnerEarnings}: it is broken down by state
 * (commission state), its per-reward rows carry a day-granularity date and a
 * funding source, and {@link ReferralPayoutReadiness.recentPayouts} is one row
 * per settled batch (payout period). They moved to the section that can measure
 * them rather than being dropped.
 *
 * `product_or_collection_context` is not here either: a referral link's
 * destination is already the partner's own `destinationRef` on
 * {@link ReferralCodePartnerView} — a second grouping of the same fact — and a
 * CONVERSION's product context is order contents, which A5 forbids at any
 * aggregation level.
 */
export type ReferralPerformanceDimension =
  | 'program'
  | 'campaign'
  | 'instrument'
  | 'market'
  | 'client_surface'
  | 'date';

/** Every dimension, in the order a dashboard offers them. */
export const REFERRAL_PERFORMANCE_DIMENSIONS: readonly ReferralPerformanceDimension[] = [
  'program',
  'campaign',
  'instrument',
  'market',
  'client_surface',
  'date',
];

/**
 * The three #147 lists that this breakdown cannot measure, and the section that
 * answers each instead.
 *
 * Named as DATA rather than left to the docblock above, so "did somebody decide
 * about these or forget them" is a census a test can run — the
 * `REFERRAL_REWARD_STATE_ELSEWHERE` device, one domain over.
 */
export const REFERRAL_PERFORMANCE_DIMENSION_ELSEWHERE: Readonly<Record<string, string>> =
  Object.freeze({
    conversion_type:
      'A click carries no conversion type. Answered by the per-reward rows on the earnings section, whose funding source names the program family that produced them.',
    commission_state:
      'A click carries no commission state. Answered by `ReferralPartnerEarnings.byCurrency`, which is broken down by reward state.',
    payout_period:
      'A click is never paid. Answered by `ReferralPayoutReadiness.recentPayouts`, one row per settled batch with its own day-granularity date.',
  });

/**
 * The dimensions that describe the referred SUBJECT rather than the partner's
 * own instrument — and therefore the ones the floor applies to.
 *
 * The line is not "is this a small number", it is **whose fact is it**. A
 * program, a campaign, a code, a date, a conversion type, a commission state
 * and a payout period are all facts about the partner's own promotion or about
 * Mercaria's own accounting; a market and a client surface are facts about the
 * person who arrived.
 *
 * Applying the floor to the partner-instrument dimensions would additionally be
 * INCONSISTENT rather than private: A5 already publishes per-reward
 * `{date, state, net amount, source, campaign}`, so a partner can count a
 * single conversion on a single day off their own earnings list. A floor that
 * withheld the same number one tab over is a gate whose cheapest green is to
 * remove it — #82's `PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR` reasoning, which
 * declines to floor what another surface already publishes.
 */
export const REFERRAL_SUBJECT_REVEALING_DIMENSIONS: readonly ReferralPerformanceDimension[] = [
  'market',
  'client_surface',
];

/**
 * Dimensions a partner performance view may NEVER offer, named as VALUES.
 *
 * DISJOINT from {@link REFERRAL_PERFORMANCE_DIMENSIONS} by a test — the
 * `RETAIL_FORBIDDEN_COMPONENT_KIND` device. Each of these is a way of grouping
 * by the person rather than by the promotion, and a floor does not rescue any
 * of them: "buyers whose surname begins with A" with eleven members is still a
 * question about people.
 */
export type ReferralForbiddenPerformanceDimension =
  | 'referred_buyer'
  | 'referred_buyer_contact'
  | 'referred_buyer_email_domain'
  | 'order'
  | 'order_contents'
  | 'order_value_band'
  | 'listing'
  | 'seller'
  | 'payment_method'
  | 'card_fingerprint'
  | 'device'
  | 'ip_network'
  | 'postal_area'
  | 'referred_merchant_identity';

/** The prohibition as data. */
export const REFERRAL_FORBIDDEN_PERFORMANCE_DIMENSIONS: readonly ReferralForbiddenPerformanceDimension[] =
  [
    'referred_buyer',
    'referred_buyer_contact',
    'referred_buyer_email_domain',
    'order',
    'order_contents',
    'order_value_band',
    'listing',
    'seller',
    'payment_method',
    'card_fingerprint',
    'device',
    'ip_network',
    'postal_area',
    'referred_merchant_identity',
  ];

/**
 * Field names that may never appear anywhere in a partner-facing referral
 * payload, at any depth.
 *
 * Walked at RUNTIME over a real composed dashboard, not only scanned — #92's
 * two-gate rule, because a static scan sees the code somebody wrote and a walk
 * sees what a serializer actually emitted.
 */
export const REFERRAL_PARTNER_FORBIDDEN_FIELDS: readonly string[] = [
  'buyerId',
  'buyerOxyUserId',
  'buyerEmail',
  'buyerName',
  'email',
  'emailHash',
  'phone',
  'address',
  'orderId',
  'orderNumber',
  'orderItems',
  'listingId',
  'sellerId',
  'subjectRef',
  'subjectOxyUserId',
  'guestSessionId',
  'guestCheckoutId',
  'checkoutGroupId',
  'paymentId',
  'cardFingerprint',
  'ipAddress',
  'userAgent',
  'deviceId',
  'note',
  'reviewNote',
];

/**
 * One cell of a breakdown, published only when it cleared the floor.
 *
 * Plain numbers, deliberately: a row that exists here was disclosed, and a row
 * that was not is absent rather than present-and-blank — see the suppression
 * note above for why a `withheld` marker on a named key is not suppression.
 */
export interface ReferralPerformanceRow {
  /** The dimension VALUE — a program id, a market code, a `YYYY-MM-DD`, … */
  key: string;
  /** Human-readable where the key is not (a code's `code`, a program's name). */
  label: string;
  /** Organic clicks in the window (bot, preview and internal traffic excluded). */
  humanClicks: number;
  /** Qualified conversions in the window. */
  qualifiedConversions: number;
}

/** What a partner asks for. */
export interface ReferralPerformanceQuery {
  dimension: ReferralPerformanceDimension;
  /** ISO-8601 date, `YYYY-MM-DD`, inclusive. */
  from: string;
  /** ISO-8601 date, `YYYY-MM-DD`, inclusive. */
  through: string;
}

/**
 * Why a whole breakdown was withheld, when it was.
 *
 * `insufficient_population` is the ordinary case: complementary suppression
 * could not remove enough to make the residual safe, which for a new partner
 * simply means they have not referred enough people yet.
 */
export type ReferralPerformanceWithholdReason = 'insufficient_population';

/** The answer, with the floor that produced it stated beside the rows. */
export interface ReferralPartnerPerformance {
  dimension: ReferralPerformanceDimension;
  from: string;
  through: string;
  /** Present exactly when the dimension is subject-revealing. */
  disclosureFloor?: number;
  /**
   * Every row that cleared the floor. On a subject-revealing dimension this may
   * be EMPTY while `totals` is non-zero — that is suppression working, not an
   * absence of activity, and `withheldRowCount` is what tells them apart.
   */
  rows: readonly ReferralPerformanceRow[];
  /**
   * Totals over the WHOLE window, undimensioned and therefore never withheld —
   * see {@link REFERRAL_SUBJECT_REVEALING_DIMENSIONS} for why a floor here
   * would withhold a number the earnings list already publishes.
   */
  totals: {
    humanClicks: number;
    qualifiedConversions: number;
  };
  /** How many rows the floor removed. A count, never the rows themselves. */
  withheldRowCount: number;
  /** Present exactly when every row was withheld. */
  withheldReason?: ReferralPerformanceWithholdReason;
  /** The definition of every figure above, by key. */
  metrics: readonly ReferralMetricDefinition[];
}

// ─── Metric definitions ──────────────────────────────────────────────────────

/**
 * Every figure a partner dashboard renders names itself.
 *
 * #77's rule, verbatim: "a number whose definition is unstated cannot be
 * stored, and the read surface 404s a metric key with no definition". Here the
 * consequence is stronger, because the reader is the person being paid: a
 * "conversion" that silently means "attribution recorded" rather than "reward
 * accrued" is the difference between a partner believing they are owed money
 * and being owed it.
 */
export type ReferralMetricKey =
  | 'referral_human_clicks'
  | 'referral_qualified_conversions'
  | 'referral_pending_earnings'
  | 'referral_held_earnings'
  | 'referral_vested_earnings'
  | 'referral_payable_now'
  | 'referral_paid_earnings'
  | 'referral_reversed_earnings'
  | 'referral_outstanding_balance';

export const REFERRAL_METRIC_KEYS: readonly ReferralMetricKey[] = [
  'referral_human_clicks',
  'referral_qualified_conversions',
  'referral_pending_earnings',
  'referral_held_earnings',
  'referral_vested_earnings',
  'referral_payable_now',
  'referral_paid_earnings',
  'referral_reversed_earnings',
  'referral_outstanding_balance',
];

/**
 * What one figure means, as DATA.
 *
 * `attributionLimit` is the field that earns its place: it is where a figure
 * says what it CANNOT see. A click count cannot see a crawler that lied about
 * its user agent; an earnings figure cannot see a refund that has not been
 * processed yet.
 */
export interface ReferralMetricDefinition {
  key: ReferralMetricKey;
  label: string;
  numerator: string;
  /** Absent for a plain count — there is no denominator to state. */
  denominator?: string;
  window: string;
  /** The TABLE the figure is read from, so "is this authoritative" has an answer. */
  source: string;
  attributionLimit: string;
}

/**
 * The definitions, one per key.
 *
 * A `Record` over the key union rather than an array, so a key added without a
 * definition fails `tsc` — #85's `requirements.ts` device.
 */
export const REFERRAL_METRIC_DEFINITIONS: Readonly<
  Record<ReferralMetricKey, ReferralMetricDefinition>
> = Object.freeze({
  referral_human_clicks: {
    key: 'referral_human_clicks',
    label: 'Human clicks',
    numerator:
      'Referral touches recorded in the window whose traffic class is `organic` — bot, link-preview and internal-traffic touches are excluded.',
    window: 'The requested date range, by the day the touch was recorded, UTC.',
    source: 'referral_touches',
    attributionLimit:
      'Classification reads three self-declared request headers and nothing else (#143). A crawler that presents an ordinary user agent is counted as a person; nothing here infers behaviour, and no IP, device or contact signal exists to infer it from.',
  },
  referral_qualified_conversions: {
    key: 'referral_qualified_conversions',
    label: 'Qualified conversions',
    numerator:
      'Referral conversions recorded in the window that reached a qualifying state — a first paid native order, or a merchant activation.',
    window: 'The requested date range, by the day the conversion was recorded, UTC.',
    source: 'referral_conversions',
    attributionLimit:
      'A conversion is not a reward. One that produced no realized Mercaria funding accrues nothing (ADR 0005 D16 `zero_base`), and one whose funding is later refunded is reversed. Earnings figures are the authority on what is owed; this counts qualifying events.',
  },
  referral_pending_earnings: {
    key: 'referral_pending_earnings',
    label: 'Pending',
    numerator:
      'Conversions recorded and not yet evaluated for a reward. No reward row exists yet, so no amount does either.',
    window: 'Live, at the moment of the request.',
    source: 'referral_conversions',
    attributionLimit:
      'A count and never an amount: the base is read from the ledger at accrual, so before that there is no figure to state and any estimate would be one Mercaria invented.',
  },
  referral_held_earnings: {
    key: 'referral_held_earnings',
    label: 'On hold',
    numerator:
      'The net amounts of rewards in `held` or `frozen`, summed per currency. A hold covers the period in which a refund can still shrink the base (ADR 0005 D12).',
    window: 'Live, at the moment of the request.',
    source: 'referral_rewards',
    attributionLimit:
      'Net, so it already reflects every refund adjustment recorded so far — and it can still fall, which is what the hold is for.',
  },
  referral_vested_earnings: {
    key: 'referral_vested_earnings',
    label: 'Vested',
    numerator:
      'The net amounts of rewards in `vested`, summed per currency — the hold has elapsed and no reversal has reached them.',
    window: 'Live, at the moment of the request.',
    source: 'referral_rewards',
    attributionLimit:
      'Vested is not payable: a payout additionally requires the three ADR 0005 D15 gates and the currency minimum, which the payout section states separately.',
  },
  referral_payable_now: {
    key: 'referral_payable_now',
    label: 'Payable now',
    numerator:
      'What a batch opened at this instant could pay — vested rewards that no live batch has already claimed.',
    window: 'Live, at the moment of the request.',
    source: 'ledger_entries and referral_payout_batch_items',
    attributionLimit:
      'It answers "what is available to pay", not "what will be paid": batch inclusion re-checks readiness, standing and the minimum at the moment the batch is built.',
  },
  referral_paid_earnings: {
    key: 'referral_paid_earnings',
    label: 'Paid',
    numerator:
      'The sum of every settled payout batch, per currency, read from the ledger postings that settled them.',
    window: 'Lifetime.',
    source: 'ledger_entries',
    attributionLimit:
      'Never falls. A reversal after payment is a clawback against the balance (ADR 0005 R7) and never a rewrite of what was paid.',
  },
  referral_reversed_earnings: {
    key: 'referral_reversed_earnings',
    label: 'Reversed',
    numerator:
      'The net amounts of rewards in `voided`, plus every negative adjustment recorded against a reward that still stands, summed per currency.',
    window: 'Lifetime.',
    source: 'referral_rewards and referral_reward_adjustments',
    attributionLimit:
      'Each reversal carries a bounded cause code. The record naming WHY is append-only; nothing here can be edited to make a reversal disappear.',
  },
  referral_outstanding_balance: {
    key: 'referral_outstanding_balance',
    label: 'Balance',
    numerator:
      'The signed `referral_payable` position, derived from immutable ledger entries and from nothing else.',
    window: 'Live, at the moment of the request.',
    source: 'ledger_entries',
    attributionLimit:
      'NEGATIVE is a real state: after a post-payout reversal the partner owes it back, and future accruals offset it first (ADR 0005 R7). It is not clamped to zero.',
  },
});

// ─── Earnings ────────────────────────────────────────────────────────────────

/** One currency's worth of earnings, by state. */
export interface ReferralEarningsByCurrency {
  currency: CurrencyCode;
  heldMinor: number;
  vestedMinor: number;
  paidMinor: number;
  reversedMinor: number;
  payableNowMinor: number;
  /** Signed. Negative is what the partner owes back (ADR 0005 R7). */
  outstandingMinor: number;
  /** The published minimum for this currency, when there is one (ADR 0005 D14). */
  payoutMinimumMinor?: number;
  /**
   * Whether the reward rows and the ledger agree on what is payable.
   *
   * The `countsAgree` device (#60/#62): two stores that must agree without
   * something comparing them is a discrepancy nobody notices. #145's sweep is
   * the durable version; this is the same comparison at read time, so a partner
   * asking about their balance is never shown two numbers that disagree with
   * nothing saying so.
   */
  ledgerAgrees: boolean;
}

/** The whole earnings picture, with nothing that names anybody. */
export interface ReferralPartnerEarnings {
  /** Conversions with no reward row yet — a COUNT, never an amount. */
  pendingConversions: number;
  byCurrency: readonly ReferralEarningsByCurrency[];
  /** Most recent first. A5's per-reward allow-list, unchanged. */
  recentRewards: readonly ReferralRewardPartnerView[];
  metrics: readonly ReferralMetricDefinition[];
}

// ─── Payout readiness ────────────────────────────────────────────────────────

/**
 * Why a partner may or may not be paid, and by what rail.
 *
 * The beneficiary is MASKED — #147's payout item 3 — and masked at the SOURCE
 * rather than in a client: the projection carries `beneficiaryLast4` and no
 * account id in any form, so a client that wanted the whole thing has nothing
 * to render. #46's status projection, one domain over.
 */
export interface ReferralPayoutReadiness {
  /** Whether accrual is running for this partner at all. */
  earningEnabled: boolean;
  /** Whether a batch could include them today. */
  payoutEnabled: boolean;
  /** The three ADR 0005 D15 gates, each as its own verdict. */
  identity: 'unknown' | 'pending' | 'ready' | 'blocked';
  tax: 'unknown' | 'pending' | 'ready' | 'blocked';
  payout: 'unknown' | 'pending' | 'ready' | 'blocked';
  /** Everything outstanding, collected — never the first reason found. */
  outstanding: readonly string[];
  /** Last four characters of the payout destination, or absent. */
  beneficiaryLast4?: string;
  /** Currencies Mercaria has published a minimum for. */
  supportedCurrencies: readonly CurrencyCode[];
  /** Monthly (ADR 0005 D14). A statement of policy, not a promise of a date. */
  cadence: 'monthly';
  /** Recent payouts, A5's allow-list extended to the batch. */
  recentPayouts: readonly ReferralPayoutBatchPartnerView[];
}

// ─── Programs ────────────────────────────────────────────────────────────────

/**
 * A program a partner may apply to, with the enrollment state they are in.
 *
 * `eligible` is DERIVED per request from the partner's owner type against the
 * program's `eligiblePartnerTypes` and the program's live status — the
 * `deriveNativeCheckoutEligibility` divergence, because the inputs move without
 * anybody touching the partner.
 */
export interface ReferralProgramOffer {
  program: ReferralProgramPartnerView;
  /** Whether this owner type may apply at all. */
  eligible: boolean;
  /** Named reasons they may not. Empty when `eligible`. */
  ineligibleReasons: readonly string[];
  /** Whether the partner has accepted this program's terms version. */
  termsAccepted: boolean;
  /** Percentage copy always names its base — #147 acceptance 7. */
  rewardBasis: ReferralRewardBasisCopy;
}

/**
 * How a program's reward is described, with the BASE always named.
 *
 * #147 acceptance 7: "Percentage copy always names its revenue base."
 * `percentageOf` is NOT optional on the percentage branch, so a client cannot
 * render "20%" with nothing after it — the same device that makes an unknown
 * price unrenderable one domain over.
 */
export type ReferralRewardBasisCopy =
  | {
      readonly kind: 'percentage_of_realized_base';
      readonly rateBps: number;
      /** e.g. "Mercaria's marketplace commission on the referred order". */
      readonly percentageOf: string;
      readonly fundingSourceId: ReferralFundingSourceId;
    }
  | {
      readonly kind: 'fixed_amount';
      readonly amountMinor: number;
      readonly currency: CurrencyCode;
      readonly fundingSourceId: ReferralFundingSourceId;
    }
  | {
      /** No active rule version — a program that pays nothing states so. */
      readonly kind: 'not_published';
    };

/** The limits a partner is operating under, so a cap is never a silent stop. */
export interface ReferralProgramLimits {
  programId: string;
  attributionWindowDays: number;
  /** Merchant programs only. */
  activationWindowDays?: number;
  holdDays: number;
  maxRewardPerConversionMinor?: number;
  maxRewardPerPartnerPeriodMinor?: number;
  partnerCapPeriod?: 'day' | 'week' | 'month' | 'lifetime';
  currency?: CurrencyCode;
}

// ─── The composed dashboard ──────────────────────────────────────────────────

/**
 * Everything the partner dashboard renders, in one read.
 *
 * Composed server-side for #71's reason: the parts are keyset pages in
 * different orders over different tables, and a client joining them drops
 * whichever row fell outside its window — silently, as a hole in a figure
 * somebody is being paid against.
 *
 * Every field is NAMED. Nothing is spread from a row, which is the #46 status
 * projection's discipline and the only version of A5 that survives somebody
 * adding a column.
 */
export interface ReferralPartnerDashboard {
  /** Absent when this owner has never enrolled. */
  partner?: {
    id: string;
    displayName: string;
    ownerType: 'user' | 'store';
    state: string;
    appealState: string;
  };
  /** The enrollment checklist — #146's standing, unchanged. */
  enrollment: {
    earningStarted: boolean;
    outstanding: readonly string[];
    agreementStanding: 'accepted' | 'superseded' | 'missing';
    requiredAgreementVersion: string;
    applicationState?: string;
  };
  /** Programs this owner may apply to or is enrolled in. */
  programs: readonly ReferralProgramOffer[];
  /** The limits of each program the partner has an instrument under. */
  limits: readonly ReferralProgramLimits[];
  instruments: {
    codes: readonly ReferralCodePartnerView[];
    links: readonly ReferralLinkPartnerView[];
    /** The exact disclosure text a partner must publish with a link. */
    disclosureText: string;
    disclosureVersion: string;
  };
  /** A trailing 30-day window, so the first screen shows something real. */
  performance: ReferralPartnerPerformance;
  earnings: ReferralPartnerEarnings;
  payouts: ReferralPayoutReadiness;
  /** Where to ask for help. Bounded — a path, never an address. */
  support: {
    /** Whether an appeal may be opened right now. */
    appealAvailable: boolean;
    /** Named seams a partner may be told about, so the UI promises nothing. */
    unavailable: readonly ReferralSupportUnavailableReason[];
  };
}

/**
 * What #147's "Referral support and disputes" section asks for and this
 * increment does not build, named rather than silently missing.
 *
 * A UI rendering a support entry point that leads nowhere is worse than one
 * that says the channel does not exist yet, which is why these are VALUES the
 * client switches on rather than a paragraph in a document.
 */
export type ReferralSupportUnavailableReason =
  | 'dispute_thread_not_built'
  | 'evidence_attachment_not_built'
  | 'outbound_notification_transport_not_configured';

// ─── The operator's view of a program ────────────────────────────────────────

/**
 * A program version as an OPERATOR reads it — every column the version carries,
 * because an operator publishing terms must see exactly what they are
 * publishing.
 *
 * Separate from {@link ReferralProgramPartnerView} and not a superset of it by
 * accident: the partner view exists so a partner surface CANNOT reach a policy
 * reference or an approver's identity, and a shared type with optional fields
 * would put both behind one serializer's discretion.
 */
export interface ReferralProgramOperatorView {
  id: string;
  programId: string;
  version: number;
  name: string;
  description: string;
  publicTermsSummary: string;
  family: ReferralProgramFamily;
  status: ReferralProgramStatus;
  effectiveStartAt?: string;
  effectiveEndAt?: string;
  eligiblePartnerTypes: readonly string[];
  eligibleSubjectKinds: readonly string[];
  markets: readonly string[];
  currencies: readonly string[];
  channels: readonly string[];
  commercialModes: readonly string[];
  attributionPolicy: string;
  attributionWindowDays: number;
  activationWindowDays?: number;
  qualifyingEventPolicy: ReferralConversionType;
  commissionRuleRef: string;
  holdDays: number;
  capPolicyRef?: string;
  payoutPolicyRef: string;
  termsVersion: string;
  disclosureVersion: string;
  featureFlagKey?: string;
  cohortKeys: readonly string[];
  createdByOxyUserId: string;
  approvedByOxyUserId?: string;
  publishedAt?: string;
  pausedAt?: string;
  endedAt?: string;
  retiredAt?: string;
  createdAt: string;
}

/**
 * How much of a program's budget and caps has been drawn.
 *
 * DERIVED at read time from the reward rows and the campaign budget rows.
 * There is deliberately no utilization TABLE: a stored counter is a second
 * representation of a sum the rewards already carry, and #144's own cap
 * enforcement declines one for exactly that reason.
 */
export interface ReferralProgramUtilization {
  programId: string;
  /** One row per campaign budget under this program. */
  campaigns: readonly {
    campaignRef: string;
    currency: CurrencyCode;
    allocatedMinor: number;
    claimedMinor: number;
    remainingMinor: number;
    status: string;
  }[];
  /** Accruals in the trailing period the rule's cap is measured over. */
  accrualsMinor: readonly { currency: CurrencyCode; amountMinor: number }[];
  rewardCounts: Readonly<Record<ReferralRewardState, number>>;
  /** How many partners hold an instrument under this program. */
  activePartners: number;
}

/** Where a partner's traffic came from, in the one shape a breakdown uses. */
export type ReferralPerformanceSurface = ReferralClientSurface;

/** Re-exported so a dashboard consumer needs one import. */
export type { ReferralAttributionPartnerView };
