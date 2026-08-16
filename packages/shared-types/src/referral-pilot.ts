/**
 * The BOUNDED REFERRAL PILOTS (#149, ADR 0005 "Rollout and rollback" phase 2).
 *
 * #142 built the records, #143 the attribution edge, #144 the versioned reward
 * rules, #145 the earnings ledger, #146 the partner and the payout rail, #147
 * the dashboards and #148 the integrity controls. Every one of them answers
 * "can Mercaria do this correctly". None of them answers the question this
 * vocabulary exists for: **how much of it is Mercaria willing to do at all,
 * today, and what would make it stop.**
 *
 * The failure mode it is shaped around is not a bug. It is a pilot that worked
 * technically and expanded by default — #149 says it outright, *"technical
 * completion alone does not authorize a public referral program"* — so every
 * bound here is a stored, versioned, immutable-once-active fact with a person's
 * name on it, and there is deliberately no code path that widens one.
 *
 * #125's bounded retail pilot is the precedent and the shape is deliberately
 * the same: a cohort version, an allow-list, thresholds with units, stops that
 * pause ENTRY and nothing else, and an `unmeasured` outcome so a monitor that
 * read nothing cannot report "no breaches".
 */

/**
 * WHICH pilot is running (#149 "Pilot selection").
 *
 * #149 offers three candidates and ADR 0005 D1 selected exactly two: a buyer
 * referral paid as a share of realized commission, and a merchant referral paid
 * as a fixed bounty from an approved budget. Both are LAUNCHED, so both are
 * members.
 *
 * The creator commerce-link pilot is not, and it is excluded BY NAME below
 * rather than merely omitted — see {@link REFERRAL_PILOT_EXCLUDED_SUBJECTS}.
 */
export type ReferralPilotSubject = 'customer_acquisition' | 'merchant_acquisition';

/** {@link ReferralPilotSubject} as the tuple the columns and CHECKs read. */
export const REFERRAL_PILOT_SUBJECTS: readonly ReferralPilotSubject[] = [
  'customer_acquisition',
  'merchant_acquisition',
];

/**
 * The pilot shapes that may NOT be published, named as VALUES.
 *
 * DISJOINT from {@link REFERRAL_PILOT_SUBJECTS} by a test, the
 * `RETAIL_FORBIDDEN_COMPONENT_KINDS` device. Naming them is the point: an
 * omission reads as an oversight somebody fills in, while a prohibition with a
 * reason attached is a decision a reviewer can disagree with in writing.
 *
 *  - `creator_commerce_link` — #149 permits it "only if permitted and
 *    operationally ready"; ADR 0005 D1 launched neither its funding source nor
 *    its reversal semantics, so a cohort naming it would be bounds for a
 *    program that cannot pay.
 *  - `external_affiliate_subpartner_sharing` — #149 excludes it "unless the
 *    exact network and advertiser agreements explicitly permit sub-partner
 *    sharing". #66 and #65 both record that no such agreement exists, and #67's
 *    reconciliation cannot attribute a click to a sub-partner at all.
 *  - `multi_level_partner_chain` — ADR 0005 D8: chains "would require a
 *    superseding ADR, not a rule version".
 *  - `open_enrollment_revenue_share` — #149's expansion review names open
 *    enrollment and long-duration revenue share as decisions that come AFTER a
 *    pilot, each requiring its own.
 */
export type ReferralPilotExcludedSubject =
  | 'creator_commerce_link'
  | 'external_affiliate_subpartner_sharing'
  | 'multi_level_partner_chain'
  | 'open_enrollment_revenue_share';

/** {@link ReferralPilotExcludedSubject} as a tuple, for the disjointness gate. */
export const REFERRAL_PILOT_EXCLUDED_SUBJECTS: readonly ReferralPilotExcludedSubject[] = [
  'creator_commerce_link',
  'external_affiliate_subpartner_sharing',
  'multi_level_partner_chain',
  'open_enrollment_revenue_share',
];

/**
 * A cohort version's lifecycle — the `fee_schedules` shape, reused deliberately.
 *
 * `closed` rather than `retired`, and the difference is #149's own word: a
 * pilot ENDS when its expansion review says so, and the review is the event.
 * There is no `paused` member, because pausing is a STOP
 * ({@link ReferralPilotStopScope}) and a status that could also mean it would
 * give the machine two ways to say one thing.
 */
export type ReferralPilotCohortStatus = 'draft' | 'active' | 'superseded' | 'closed';

/** {@link ReferralPilotCohortStatus} as the tuple the columns and CHECKs read. */
export const REFERRAL_PILOT_COHORT_STATUSES: readonly ReferralPilotCohortStatus[] = [
  'draft',
  'active',
  'superseded',
  'closed',
];

/**
 * The TWELVE stop thresholds #149 names, verbatim and in its order.
 *
 * A closed tuple rather than free text, and it is what
 * `referral_pilot_stop_thresholds.metric` CHECKs against — so a threshold whose
 * meaning nobody defined cannot be stored. The `analytics_rollups.metric_key`
 * device (#77), applied to a safety bound instead of a report.
 *
 * Each is a RATE, a COUNT, an AMOUNT or a DURATION over a window, never a
 * judgement. What each one is MEASURED from is
 * {@link REFERRAL_PILOT_STOP_METRIC_MEASURES}, and eight of the twelve have no
 * producer today — which the pilot report states rather than hides.
 */
export type ReferralPilotStopMetric =
  | 'negative_net_contribution'
  | 'refund_or_dispute_rate'
  | 'self_referral_or_account_farm_rate'
  | 'attribution_conflict_rate'
  | 'payout_mismatch'
  | 'partner_support_backlog'
  | 'disclosure_complaints'
  | 'privacy_incident'
  | 'provider_or_ledger_reconciliation_failure'
  | 'program_budget_exhaustion'
  | 'merchant_quality_deterioration'
  | 'security_finding';

/** {@link ReferralPilotStopMetric} as the tuple the columns and CHECKs read. */
export const REFERRAL_PILOT_STOP_METRICS: readonly ReferralPilotStopMetric[] = [
  'negative_net_contribution',
  'refund_or_dispute_rate',
  'self_referral_or_account_farm_rate',
  'attribution_conflict_rate',
  'payout_mismatch',
  'partner_support_backlog',
  'disclosure_complaints',
  'privacy_incident',
  'provider_or_ledger_reconciliation_failure',
  'program_budget_exhaustion',
  'merchant_quality_deterioration',
  'security_finding',
];

/**
 * How a threshold's value is read, and the reason the twelve cannot share one
 * unit.
 *
 * `rate_bps` is a share of the window's denominator in basis points; `count` is
 * an absolute number of occurrences; `minor_units` is money in the pilot's own
 * payout currency; `hours` is elapsed time, which #149's support-backlog and
 * resolution-time bounds are actually about. Storing all four as one number
 * with no unit is how "> 2% of conversions" and "> €500/week" end up compared
 * against each other.
 */
export type ReferralPilotThresholdUnit = 'rate_bps' | 'count' | 'minor_units' | 'hours';

/** {@link ReferralPilotThresholdUnit} as the tuple the columns and CHECKs read. */
export const REFERRAL_PILOT_THRESHOLD_UNITS: readonly ReferralPilotThresholdUnit[] = [
  'rate_bps',
  'count',
  'minor_units',
  'hours',
];

/**
 * What a breach PAUSES (#149: "crossing a threshold pauses the relevant path
 * while preserving valid historical settlement and appeals").
 *
 * The scope is per THRESHOLD, because the twelve are not equally broad: one
 * partner farming accounts should not stop every other partner's honest
 * referrals, and a ledger reconciliation failure is about the pilot rather than
 * about a market.
 *
 * There is deliberately NO scope that pauses settlement, payout or appeal. A
 * stop halts ENTRY — new attribution — and nothing else: conversions already
 * attributed keep converting, rewards keep accruing, holds keep elapsing,
 * vested balances keep being paid and appeals keep being heard, because a
 * partner who has already done the work is owed the terms they did it under.
 * That is the whole content of #149 acceptance 5, and it is held by the fact
 * that `assertReferralPilotAdmits` is called from `attributeTouch` and from
 * nowhere else.
 */
export type ReferralPilotStopScope = 'pilot' | 'partner' | 'market';

/** {@link ReferralPilotStopScope} as the tuple the columns and CHECKs read. */
export const REFERRAL_PILOT_STOP_SCOPES: readonly ReferralPilotStopScope[] = [
  'pilot',
  'partner',
  'market',
];

/**
 * Who raised a stop.
 *
 * `automatic` rows carry NO raiser (a CHECK), because attributing a threshold
 * evaluation to a person makes an audit trail say something false. An
 * `operator` stop carries one and is mandatory — the `payment_repairs` posture.
 */
export type ReferralPilotStopOrigin = 'automatic' | 'operator';

/** {@link ReferralPilotStopOrigin} as the tuple the columns and CHECKs read. */
export const REFERRAL_PILOT_STOP_ORIGINS: readonly ReferralPilotStopOrigin[] = [
  'automatic',
  'operator',
];

/**
 * Why the pilot refused a NEW attribution.
 *
 * INTERNAL. A partner never sees which bound fired, for the reason #123's
 * `retail_line_ineligible` and #112's `p2p_seller_excluded` both give:
 * distinguishing them would let somebody vary one input at a time and read out
 * the pilot's partner allow-list, its dates and its remaining entry budget.
 * `attributeTouch` returns ONE `ReferralConflictReason` and this vocabulary
 * reaches the `referral_events` row an operator traces from.
 */
export type ReferralPilotAdmissionRefusal =
  | 'no_active_cohort'
  | 'program_not_in_pilot'
  | 'partner_not_allowlisted'
  | 'subject_kind_not_in_pilot'
  | 'before_pilot_start'
  | 'after_pilot_end'
  | 'partner_entry_cap_reached'
  | 'program_entry_cap_reached'
  | 'stop_threshold_active';

/** {@link ReferralPilotAdmissionRefusal} as a tuple, for exhaustive iteration. */
export const REFERRAL_PILOT_ADMISSION_REFUSALS: readonly ReferralPilotAdmissionRefusal[] = [
  'no_active_cohort',
  'program_not_in_pilot',
  'partner_not_allowlisted',
  'subject_kind_not_in_pilot',
  'before_pilot_start',
  'after_pilot_end',
  'partner_entry_cap_reached',
  'program_entry_cap_reached',
  'stop_threshold_active',
];

/**
 * The pilot's admission verdict on one new attribution.
 *
 * A STRING discriminant rather than a boolean, for `offer-freshness.ts`'
 * reason: the backend compiles with `strict: false`, under which TypeScript
 * does not narrow a union on the truthiness of a boolean-literal discriminant,
 * and every caller here must act on the refusal REASON.
 */
export type ReferralPilotAdmission =
  | { readonly outcome: 'admitted'; readonly cohortId: string; readonly cohortVersion: number }
  | { readonly outcome: 'refused'; readonly reason: ReferralPilotAdmissionRefusal };

/* -------------------------------------------------------------------------- */
/*  Measured economics                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Where a pilot number may come from (#149: "Do not count a client-side success
 * event as revenue or a bot click as acquisition").
 *
 * #77's `ANALYTICS_METRIC_SOURCES` distinction, restated for money: the four
 * commerce tables and the ledger are DURABLE RECORDS, the referral tables are
 * this program's own durable records, and `operator_entry` is a figure a person
 * typed with their name beside it. There is no telemetry member at all —
 * `analytics_events` is on the forbidden side, because a pilot report is the
 * document an expansion decision rests on and a client event is not evidence
 * about money.
 */
export type ReferralPilotMeasureSource =
  | 'orders'
  | 'payments'
  | 'refunds'
  | 'ledger_transactions'
  | 'referral_touches'
  | 'referral_attributions'
  | 'referral_conversions'
  | 'referral_rewards'
  | 'referral_reward_adjustments'
  | 'referral_payout_batches'
  | 'referral_partners'
  | 'referral_enforcement_actions'
  | 'referral_risk_signals'
  | 'referral_earning_discrepancies'
  | 'operator_entry';

/** {@link ReferralPilotMeasureSource} as a tuple, for the disjointness gate. */
export const REFERRAL_PILOT_MEASURE_SOURCES: readonly ReferralPilotMeasureSource[] = [
  'orders',
  'payments',
  'refunds',
  'ledger_transactions',
  'referral_touches',
  'referral_attributions',
  'referral_conversions',
  'referral_rewards',
  'referral_reward_adjustments',
  'referral_payout_batches',
  'referral_partners',
  'referral_enforcement_actions',
  'referral_risk_signals',
  'referral_earning_discrepancies',
  'operator_entry',
];

/**
 * The sources a pilot number may NEVER come from, named as VALUES.
 *
 * DISJOINT from {@link REFERRAL_PILOT_MEASURE_SOURCES} by a test. Each is a
 * sentence from #149 or ADR 0005 turned into something a build can refuse:
 *
 *  - `analytics_events` / `client_reported_conversion` — "do not count a
 *    client-side success event as revenue" (#149 pilot metrics).
 *  - `bot_click` / `unclassified_click` — "or a bot click as acquisition".
 *    #143's classifier is what tells them apart, and a click it could not
 *    classify is not a human one.
 *  - `partner_self_report` — a partner's own count of what they sent.
 *  - `estimated_commission` — ADR 0005's reward-base contract: "never an
 *    estimate". A pending affiliate figure is the shape this forbids.
 *  - `gross_merchandise_value` — #149 states it outright: "Do not use total
 *    order GMV as the default base", and a report quoting GMV beside a
 *    commission share is how an attractive-GMV, negative-contribution pilot
 *    gets expanded.
 */
export type ReferralPilotForbiddenMeasureSource =
  | 'analytics_events'
  | 'client_reported_conversion'
  | 'bot_click'
  | 'unclassified_click'
  | 'partner_self_report'
  | 'estimated_commission'
  | 'gross_merchandise_value';

/** {@link ReferralPilotForbiddenMeasureSource} as a tuple, for the gate. */
export const REFERRAL_PILOT_FORBIDDEN_MEASURE_SOURCES: readonly ReferralPilotForbiddenMeasureSource[] =
  [
    'analytics_events',
    'client_reported_conversion',
    'bot_click',
    'unclassified_click',
    'partner_self_report',
    'estimated_commission',
    'gross_merchandise_value',
  ];

/** How a pilot measure's window is drawn. */
export type ReferralPilotMeasureWindow =
  | 'pilot_to_date'
  | 'rolling_7d'
  | 'rolling_28d'
  | 'reward_lifecycle';

/** {@link ReferralPilotMeasureWindow} as a tuple. */
export const REFERRAL_PILOT_MEASURE_WINDOWS: readonly ReferralPilotMeasureWindow[] = [
  'pilot_to_date',
  'rolling_7d',
  'rolling_28d',
  'reward_lifecycle',
];

/**
 * Which of #149's two lists a measure belongs to.
 *
 * `pilot_metric` is the eighteen under "Pilot metrics"; `unit_economics` is the
 * twelve under "Unit economics". One registry rather than two, because they
 * share every field and the difference is which section of the report they are
 * rendered in — but the KIND is stored, because #149 asks for both lists and a
 * report that silently merged them would be answering a question nobody asked.
 */
export type ReferralPilotMeasureKind = 'pilot_metric' | 'unit_economics';

/** {@link ReferralPilotMeasureKind} as a tuple. */
export const REFERRAL_PILOT_MEASURE_KINDS: readonly ReferralPilotMeasureKind[] = [
  'pilot_metric',
  'unit_economics',
];

/**
 * Whether anything in this repository can actually compute a measure.
 *
 * `derived` means a producer exists and reads the named source. `operator_entry`
 * means the fact lives outside every table Mercaria owns and a person records
 * it with their name beside it. `unavailable` means NOTHING produces it and the
 * measure names the issue that would — and a report renders it as `unmeasured`
 * rather than as zero, which is the whole reason this field exists: a sweep
 * that computed only what it could reach would report "no breaches" for
 * everything else (#125's finding, one domain over).
 */
export type ReferralPilotMeasureProducer = 'derived' | 'operator_entry' | 'unavailable';

/** {@link ReferralPilotMeasureProducer} as a tuple. */
export const REFERRAL_PILOT_MEASURE_PRODUCERS: readonly ReferralPilotMeasureProducer[] = [
  'derived',
  'operator_entry',
  'unavailable',
];

/**
 * One pilot measure, completely stated.
 *
 * #149's "Pilot metrics" section asks for the "exact numerator, denominator,
 * window and source of truth" of each, and #77's rule binds: a number whose
 * definition is unstated cannot be stored, and the read surface serves nothing
 * whose key has no definition. There is NO optional field except `seam`, so a
 * measure with an unstated denominator does not compile — the shape is the
 * enforcement, and `measures.test.ts` closes what TypeScript cannot (a non-empty
 * string, and `seam` present exactly when the producer is `unavailable`).
 */
export interface ReferralPilotMeasureDefinition {
  /** Stable key. Appears in stored measurements, so renaming one is a migration. */
  readonly key: string;
  readonly kind: ReferralPilotMeasureKind;
  /** What a reader sees. */
  readonly title: string;
  /** Exactly what is counted on top. */
  readonly numerator: string;
  /**
   * Exactly what is counted underneath. Never "all traffic".
   *
   * An absolute figure (a sum of money, a count of incidents) states its
   * POPULATION here rather than a ratio's denominator — because "what is this a
   * number of" is the question a reader has either way.
   */
  readonly denominator: string;
  readonly window: ReferralPilotMeasureWindow;
  readonly source: ReferralPilotMeasureSource;
  readonly unit: ReferralPilotThresholdUnit;
  readonly producer: ReferralPilotMeasureProducer;
  /**
   * What this measure cannot tell you.
   *
   * #149 asks for incremental-versus-organic acquisition "with limitations
   * stated", and the honest reading is that every one of these has a limitation
   * — so the field is mandatory rather than reserved for the awkward ones.
   */
  readonly attributionLimit: string;
  /** The issue that owes the producer. Present EXACTLY when `producer` is `unavailable`. */
  readonly seam?: string;
}

/**
 * Every measure #149 names, defined once.
 *
 * The order follows the issue's two lists, so a reader can check the two
 * against each other without a mapping table.
 */
export const REFERRAL_PILOT_MEASURES: readonly ReferralPilotMeasureDefinition[] = [
  /* ---- #149 "Pilot metrics", 1–18 ------------------------------------- */
  {
    key: 'human_referral_clicks',
    kind: 'pilot_metric',
    title: 'Human referral clicks',
    numerator:
      'referral_touches rows of kind link_click whose traffic_class is organic, for a code owned ' +
      'by an allow-listed partner of the cohort',
    denominator: 'the same population — an absolute count, not a ratio',
    window: 'pilot_to_date',
    source: 'referral_touches',
    unit: 'count',
    producer: 'derived',
    attributionLimit:
      '#143 classifies from three self-declared headers, so a crawler that lies is counted as a ' +
      'human. The answer to that is #148 velocity, never behavioural inference — which means this ' +
      'number is an upper bound on humans and must never be read as one.',
  },
  {
    key: 'eligible_referred_subjects',
    kind: 'pilot_metric',
    title: 'Eligible referred subjects',
    numerator: 'distinct subject_ref on active referral_attributions in the cohort',
    denominator: 'the same population — an absolute count, not a ratio',
    window: 'pilot_to_date',
    source: 'referral_attributions',
    unit: 'count',
    producer: 'derived',
    attributionLimit:
      'A guest checkout scope and an Oxy account are different subject kinds and are never joined ' +
      '(ADR 0005 A3), so one person who buys twice as a guest counts twice. Deduplicating them ' +
      'would require exactly the contact matching #109 forbids.',
  },
  {
    key: 'qualified_conversion_rate',
    kind: 'pilot_metric',
    title: 'Qualified conversion rate',
    numerator: 'referral_conversions in state verified for the cohort',
    denominator: 'active referral_attributions in the cohort',
    window: 'pilot_to_date',
    source: 'referral_conversions',
    unit: 'rate_bps',
    producer: 'derived',
    attributionLimit:
      'An attribution created today can still convert inside its window, so the ratio understates ' +
      'a young pilot and moves without either input being wrong — #67 and #147 record the same ' +
      'hazard about clicks. Read it only over a window that has closed.',
  },
  {
    key: 'native_revenue_generated',
    kind: 'pilot_metric',
    title: 'Native Mercaria revenue generated',
    numerator:
      'commission_revenue ledger postings for the orders named by verified conversions in the ' +
      'cohort, net of commission returned on their refunds',
    denominator: 'the same population — an amount, not a ratio',
    window: 'pilot_to_date',
    source: 'ledger_transactions',
    unit: 'minor_units',
    producer: 'derived',
    attributionLimit:
      'This is Mercaria REVENUE and never buyer spend (ADR 0005 fact 1). It says nothing about ' +
      'whether the same order would have happened without the referral — that question is ' +
      'incremental_versus_organic, which nothing measures.',
  },
  {
    key: 'commission_pending',
    kind: 'pilot_metric',
    title: 'Pending commission',
    numerator: 'net amount of referral_rewards in state held or frozen for the cohort',
    denominator: 'the same population — an amount, not a ratio',
    window: 'reward_lifecycle',
    source: 'referral_rewards',
    unit: 'minor_units',
    producer: 'derived',
    attributionLimit:
      'A held reward is an obligation that can still shrink to zero (R1/R2), so this is a ceiling ' +
      'on what will be paid rather than a forecast of it.',
  },
  {
    key: 'commission_approved',
    kind: 'pilot_metric',
    title: 'Approved commission',
    numerator: 'net amount of referral_rewards in state vested and not yet paid, for the cohort',
    denominator: 'the same population — an amount, not a ratio',
    window: 'reward_lifecycle',
    source: 'referral_rewards',
    unit: 'minor_units',
    producer: 'derived',
    attributionLimit:
      'Vested is not payable: #145 derives payability from a partner readiness triple this number ' +
      'does not read, so a vested balance may sit unpaid indefinitely.',
  },
  {
    key: 'commission_reversed',
    kind: 'pilot_metric',
    title: 'Reversed commission',
    numerator:
      'the absolute value of negative delta_amount_minor on referral_reward_adjustments for the ' +
      'cohort, plus the net of every reward that reached voided',
    denominator: 'the same population — an amount, not a ratio',
    window: 'reward_lifecycle',
    source: 'referral_reward_adjustments',
    unit: 'minor_units',
    producer: 'derived',
    attributionLimit:
      'Counts money that ceased to be owed for ANY reason — a refund, a dispute, a fraud finding ' +
      'or a partner suspension — so a rise here is not by itself evidence of abuse.',
  },
  {
    key: 'commission_paid',
    kind: 'pilot_metric',
    title: 'Paid commission',
    numerator: 'settled amount of referral_payout_batches naming the cohort’s partners',
    denominator: 'the same population — an amount, not a ratio',
    window: 'pilot_to_date',
    source: 'referral_payout_batches',
    unit: 'minor_units',
    producer: 'derived',
    attributionLimit:
      'A batch settles a partner’s whole payable balance, which may include rewards earned ' +
      'under an earlier cohort version. Attributing a payout to one version is therefore ' +
      'approximate at a version boundary, and the report says so.',
  },
  {
    key: 'customer_acquisition_cost',
    kind: 'pilot_metric',
    title: 'Customer acquisition cost',
    numerator: 'referral_expense ledger postings for the cohort',
    denominator: 'distinct oxy_user and guest_checkout subjects with a verified conversion',
    window: 'pilot_to_date',
    source: 'ledger_transactions',
    unit: 'minor_units',
    producer: 'derived',
    attributionLimit:
      'Referral expense only. Payout fees, FX, fraud loss and support are separate unit-economics ' +
      'lines and are NOT folded in here, because a single blended figure hides which of them moved.',
  },
  {
    key: 'merchant_acquisition_cost',
    kind: 'pilot_metric',
    title: 'Merchant acquisition cost',
    numerator: 'referral_expense ledger postings for merchant-subject conversions in the cohort',
    denominator: 'distinct merchant subjects with a verified conversion',
    window: 'pilot_to_date',
    source: 'ledger_transactions',
    unit: 'minor_units',
    producer: 'derived',
    attributionLimit:
      'A merchant bounty is funded from budget and accrues at activation (ADR 0005 D11), so this ' +
      'is the cost of an ACTIVATION and not of a merchant who is still selling a year later.',
  },
  {
    key: 'payback_period',
    kind: 'pilot_metric',
    title: 'Payback period',
    numerator:
      'hours from the first referral_expense posting of a cohort to the instant cumulative ' +
      'commission_revenue from its conversions first exceeds it',
    denominator: 'the cohort as a whole — a duration, not a ratio',
    window: 'pilot_to_date',
    source: 'ledger_transactions',
    unit: 'hours',
    producer: 'unavailable',
    seam: '#111',
    attributionLimit:
      'Meaningful only where the reward is a bounty paid ahead of revenue. For a commission share ' +
      'the reward is a fraction of income already earned, so payback is immediate by construction ' +
      'and the figure would be a zero that reads as a measurement.',
  },
  {
    key: 'referred_cohort_refund_rate',
    kind: 'pilot_metric',
    title: 'Referred-cohort refund, dispute and cancellation rate',
    numerator: 'orders behind cohort conversions carrying a refund, dispute or cancellation',
    denominator: 'orders behind cohort conversions',
    window: 'rolling_28d',
    source: 'refunds',
    unit: 'rate_bps',
    producer: 'derived',
    attributionLimit:
      'There is no non-referred control group here, so a rate above baseline is a fact about ' +
      'referred orders and not proof that the referral caused it.',
  },
  {
    key: 'fraud_intervention_rate',
    kind: 'pilot_metric',
    title: 'Self-referral and fraud intervention rate',
    numerator: 'referral_enforcement_actions imposed on cohort partners',
    denominator: 'active referral_attributions in the cohort',
    window: 'rolling_28d',
    source: 'referral_enforcement_actions',
    unit: 'rate_bps',
    producer: 'derived',
    attributionLimit:
      'Counts interventions Mercaria MADE, which is a fact about the controls rather than about ' +
      'how much abuse occurred. A pilot with no detector would score zero.',
  },
  {
    key: 'appeal_overturn_rate',
    kind: 'pilot_metric',
    title: 'False-positive and appeal overturn rate',
    numerator: 'referral_enforcement_appeals decided in the partner’s favour',
    denominator: 'referral_enforcement_appeals decided',
    window: 'pilot_to_date',
    source: 'referral_enforcement_actions',
    unit: 'rate_bps',
    producer: 'derived',
    attributionLimit:
      'An overturn is evidence about the appeals that were FILED. A partner who accepted a wrong ' +
      'decision is invisible to it, and the direction of that bias flatters the controls.',
  },
  {
    key: 'partner_payout_readiness_rate',
    kind: 'pilot_metric',
    title: 'Partner application and payout-readiness rate',
    numerator: 'cohort partners whose ADR 0005 D15 gates all pass',
    denominator: 'cohort partners',
    window: 'pilot_to_date',
    source: 'referral_partners',
    unit: 'rate_bps',
    producer: 'derived',
    attributionLimit:
      'Readiness is DERIVED live (#145), so this is a snapshot at read time and not a record of ' +
      'how many were ready when a batch ran.',
  },
  {
    key: 'payout_failure_rate',
    kind: 'pilot_metric',
    title: 'Payout failure and return rate',
    numerator: 'referral_payout_batches for cohort partners whose status is failed',
    denominator: 'referral_payout_batches for cohort partners that left approved',
    window: 'pilot_to_date',
    source: 'referral_payout_batches',
    unit: 'rate_bps',
    producer: 'derived',
    attributionLimit:
      'A batch that failed and was retried successfully counts once in each half, so this measures ' +
      'ATTEMPTS rather than partners who went unpaid.',
  },
  {
    key: 'support_volume_and_resolution',
    kind: 'pilot_metric',
    title: 'Support volume and resolution time',
    numerator: 'partner support contacts about the pilot, and hours to resolution',
    denominator: 'cohort partners',
    window: 'rolling_28d',
    source: 'operator_entry',
    unit: 'hours',
    producer: 'operator_entry',
    attributionLimit:
      'Mercaria operates no partner support desk in this repository (#147 defers the dispute ' +
      'thread), so this is a figure a person records from wherever support actually happens. It ' +
      'is evidence about that system, not about this one.',
  },
  {
    key: 'incremental_versus_organic',
    kind: 'pilot_metric',
    title: 'Incremental versus likely organic acquisition',
    numerator: 'referred conversions judged incremental',
    denominator: 'referred conversions',
    window: 'pilot_to_date',
    source: 'operator_entry',
    unit: 'rate_bps',
    producer: 'unavailable',
    seam: '#111',
    attributionLimit:
      'THE limitation #149 asks to be stated: nothing in this repository can distinguish a buyer ' +
      'a partner brought from one who would have arrived anyway. Answering it needs a holdout, ' +
      'which is an experiment over PEOPLE and therefore #77/#111’s, under their allocation ' +
      'rules and not this domain’s. Until one exists the honest answer is unmeasured, and a ' +
      'number here would be the single most over-read figure in the report.',
  },
  {
    key: 'budget_utilization',
    kind: 'pilot_metric',
    title: 'Program budget utilization',
    numerator: 'referral_expense postings for the cohort',
    denominator: 'the cohort’s published program-wide reward budget',
    window: 'pilot_to_date',
    source: 'ledger_transactions',
    unit: 'rate_bps',
    producer: 'derived',
    attributionLimit:
      'Utilization counts what ACCRUED, including rewards later reversed, so it overstates what ' +
      'the pilot will finally have cost.',
  },
  {
    key: 'post_reward_repeat_revenue',
    kind: 'pilot_metric',
    title: 'Retention or repeat revenue after the rewarded event',
    numerator: 'commission_revenue from later orders by a referred subject',
    denominator: 'referred subjects with a verified conversion',
    window: 'pilot_to_date',
    source: 'orders',
    unit: 'minor_units',
    producer: 'unavailable',
    seam: '#111',
    attributionLimit:
      'A guest subject is a checkout scope that expires (ADR 0005 D6), so a returning guest is a ' +
      'NEW subject and their repeat revenue is unattributable without exactly the durable profile ' +
      'A4 forbids. The measure is defined so the gap is visible rather than so it can be filled.',
  },
  {
    key: 'privacy_and_disclosure_complaints',
    kind: 'pilot_metric',
    title: 'Privacy and disclosure complaints',
    numerator: 'complaints recorded against the pilot',
    denominator: 'cohort partners',
    window: 'pilot_to_date',
    source: 'operator_entry',
    unit: 'count',
    producer: 'operator_entry',
    attributionLimit:
      'Mercaria has no complaint intake for a referral program; a complaint arrives through ' +
      'whatever channel a person used. Recording it here is a person asserting it happened.',
  },

  /* ---- #149 "Unit economics", 1–12 ------------------------------------ */
  {
    key: 'eligible_mercaria_revenue',
    kind: 'unit_economics',
    title: 'Eligible Mercaria revenue',
    numerator: 'commission_revenue postings for cohort conversions, net of refunded commission',
    denominator: 'the cohort — an amount, not a ratio',
    window: 'pilot_to_date',
    source: 'ledger_transactions',
    unit: 'minor_units',
    producer: 'derived',
    attributionLimit:
      'The ONLY revenue figure in this report, and it is Mercaria’s realized commission. GMV ' +
      'is a forbidden source (#149), so no basket total appears anywhere beside it.',
  },
  {
    key: 'referral_commission_expense',
    kind: 'unit_economics',
    title: 'Referral commission expense',
    numerator: 'referral_expense postings for the cohort, net of reversals',
    denominator: 'the cohort — an amount, not a ratio',
    window: 'pilot_to_date',
    source: 'ledger_transactions',
    unit: 'minor_units',
    producer: 'derived',
    attributionLimit:
      'Net of reversals, so a reversed reward stops being an expense the moment it is reversed — ' +
      'which means a snapshot taken mid-hold reads higher than the final figure.',
  },
  {
    key: 'payout_and_fx_fees',
    kind: 'unit_economics',
    title: 'Payout and FX fees',
    numerator: 'rail fees and FX cost on settled cohort payout batches',
    denominator: 'the cohort — an amount, not a ratio',
    window: 'pilot_to_date',
    source: 'referral_payout_batches',
    unit: 'minor_units',
    producer: 'unavailable',
    seam: '#146',
    attributionLimit:
      'A Stripe Connect transfer’s fee is on the rail’s own balance transaction and ' +
      '#146 stores no fee column, so nothing here can read one. Every launch reward is EUR ' +
      '(ADR 0005 fact 3) and the pilot pins one payout currency, so the FX half is structurally ' +
      'zero — but the fee half is real and unmeasured, and reporting zero would understate cost.',
  },
  {
    key: 'fraud_and_reversal_loss',
    kind: 'unit_economics',
    title: 'Fraud and reversal loss',
    numerator:
      'reversed amounts on rewards already PAID (R7 clawbacks) that have not been recovered, for ' +
      'the cohort',
    denominator: 'the cohort — an amount, not a ratio',
    window: 'pilot_to_date',
    source: 'referral_reward_adjustments',
    unit: 'minor_units',
    producer: 'derived',
    attributionLimit:
      'Only money that LEFT and did not come back is loss. A reward voided before payout cost ' +
      'nothing and is deliberately excluded, so this figure is smaller than commission_reversed ' +
      'and the two must not be added.',
  },
  {
    key: 'support_and_operational_cost',
    kind: 'unit_economics',
    title: 'Support and operational cost',
    numerator: 'the cost of running the pilot outside the program itself',
    denominator: 'the cohort — an amount, not a ratio',
    window: 'pilot_to_date',
    source: 'operator_entry',
    unit: 'minor_units',
    producer: 'operator_entry',
    attributionLimit:
      'Mercaria books no operational cost against a referral program, so this is a figure somebody ' +
      'computed elsewhere. It is included because #149 requires net contribution to include it, ' +
      'and excluding it would flatter the pilot.',
  },
  {
    key: 'net_contribution',
    kind: 'unit_economics',
    title: 'Net contribution after referral expense',
    numerator:
      'eligible_mercaria_revenue minus referral_commission_expense, payout_and_fx_fees, ' +
      'fraud_and_reversal_loss and support_and_operational_cost',
    denominator: 'the cohort — an amount, not a ratio',
    window: 'pilot_to_date',
    source: 'ledger_transactions',
    unit: 'minor_units',
    producer: 'derived',
    attributionLimit:
      'Composed from five lines, two of which have no producer today. The report therefore states ' +
      'net contribution as a BOUND — the best case, since every unmeasured line is a cost — and ' +
      'refuses to publish it as a measurement while any of them is unmeasured.',
  },
  {
    key: 'average_commission_per_subject',
    kind: 'unit_economics',
    title: 'Average commission per qualified subject',
    numerator: 'referral_expense postings for the cohort',
    denominator: 'distinct subjects with a verified conversion in the cohort',
    window: 'pilot_to_date',
    source: 'ledger_transactions',
    unit: 'minor_units',
    producer: 'derived',
    attributionLimit:
      'A mean over two reward shapes — a commission share and a fixed bounty — which are not ' +
      'comparable. Read the per-subject figures split by conversion type, which the report emits ' +
      'separately.',
  },
  {
    key: 'cost_by_partner',
    kind: 'unit_economics',
    title: 'Cost by partner and channel',
    numerator: 'referral_expense postings, grouped by partner and by the touch’s channel',
    denominator: 'the cohort — an amount, not a ratio',
    window: 'pilot_to_date',
    source: 'ledger_transactions',
    unit: 'minor_units',
    producer: 'derived',
    attributionLimit:
      'A partner cell below the disclosure floor is dropped entirely (#147’s rule), so the ' +
      'grouped figures need not sum to the total and the report says which mass was withheld.',
  },
  {
    key: 'sensitivity_to_refunds_and_retention',
    kind: 'unit_economics',
    title: 'Sensitivity to higher refunds and lower retention',
    numerator: 'net contribution recomputed under stressed refund and retention assumptions',
    denominator: 'the cohort — an amount, not a ratio',
    window: 'pilot_to_date',
    source: 'operator_entry',
    unit: 'minor_units',
    producer: 'unavailable',
    seam: '#111',
    attributionLimit:
      'A sensitivity needs a retention measurement to stress, and post_reward_repeat_revenue has ' +
      'no producer. Publishing a stressed figure over an unmeasured base would be arithmetic ' +
      'dressed as evidence.',
  },
  {
    key: 'comparison_with_other_channels',
    kind: 'unit_economics',
    title: 'Comparison with other acquisition channels',
    numerator: 'acquisition cost on other channels',
    denominator: 'acquisitions on those channels',
    window: 'pilot_to_date',
    source: 'operator_entry',
    unit: 'minor_units',
    producer: 'unavailable',
    seam: '#111',
    attributionLimit:
      'Mercaria runs no other measured acquisition channel in this repository. #149 asks for the ' +
      'comparison "where data exists"; it does not, and an invented benchmark is the number an ' +
      'expansion decision would rest on.',
  },
  {
    key: 'outstanding_and_contingent_liabilities',
    kind: 'unit_economics',
    title: 'Outstanding and contingent liabilities',
    numerator:
      'the credit balance of referral_payable for cohort partners, plus the net of held and ' +
      'frozen rewards not yet booked as payable',
    denominator: 'the cohort — an amount, not a ratio',
    window: 'reward_lifecycle',
    source: 'ledger_transactions',
    unit: 'minor_units',
    producer: 'derived',
    attributionLimit:
      'Contingent because a held reward can still fall to zero. The figure is what Mercaria would ' +
      'owe if every current hold vested in full.',
  },
  {
    key: 'reconciliation_completeness',
    kind: 'unit_economics',
    title: 'Reconciliation completeness',
    numerator: 'open referral_earning_discrepancies for the cohort',
    denominator: 'referral_earning_discrepancies observed for the cohort',
    window: 'pilot_to_date',
    source: 'referral_earning_discrepancies',
    unit: 'rate_bps',
    producer: 'derived',
    attributionLimit:
      'Measures what the #145 sweep FOUND. A sweep that has never run reports zero of zero, which ' +
      'the report renders as unmeasured rather than as complete.',
  },
];

/**
 * Which measure each stop threshold is read from.
 *
 * A total map rather than a lookup by name: a stop metric with no measure fails
 * `tsc`, which is what stops a threshold being published against a number
 * nobody defined. Eight of the twelve resolve to a measure whose producer is
 * `operator_entry` or `unavailable` — that is the honest state and the report
 * names it, rather than a sweep computing four and reporting "no breaches".
 */
export const REFERRAL_PILOT_STOP_METRIC_MEASURES: Record<ReferralPilotStopMetric, string> = {
  negative_net_contribution: 'net_contribution',
  refund_or_dispute_rate: 'referred_cohort_refund_rate',
  self_referral_or_account_farm_rate: 'fraud_intervention_rate',
  attribution_conflict_rate: 'attribution_conflict_rate_measure',
  payout_mismatch: 'reconciliation_completeness',
  partner_support_backlog: 'support_volume_and_resolution',
  disclosure_complaints: 'privacy_and_disclosure_complaints',
  privacy_incident: 'privacy_and_disclosure_complaints',
  provider_or_ledger_reconciliation_failure: 'reconciliation_completeness',
  program_budget_exhaustion: 'budget_utilization',
  merchant_quality_deterioration: 'merchant_quality_measure',
  security_finding: 'security_finding_measure',
};

/**
 * The three measures that exist ONLY because a stop threshold needs them.
 *
 * They are not in #149's two published lists, so they are not
 * {@link REFERRAL_PILOT_MEASURES} members — a report rendering them beside the
 * eighteen would be answering a question the issue did not ask. They are
 * defined here, completely, for the same reason every other measure is: a
 * threshold whose number has no stated definition cannot be evaluated.
 */
export const REFERRAL_PILOT_STOP_ONLY_MEASURES: readonly ReferralPilotMeasureDefinition[] = [
  {
    key: 'attribution_conflict_rate_measure',
    kind: 'pilot_metric',
    title: 'Attribution conflict rate',
    numerator:
      'referral_attributions closed with a conflict_reason of competing_touch, operator_correction ' +
      'or operator_invalidation, in the cohort',
    denominator: 'referral_attributions created in the cohort',
    window: 'rolling_28d',
    source: 'referral_attributions',
    unit: 'rate_bps',
    producer: 'derived',
    attributionLimit:
      'A supersession under last-touch is ordinary and expected (ADR 0005 D4), so a non-zero rate ' +
      'is normal. Only a rise is information, and this measure states no baseline.',
  },
  {
    key: 'merchant_quality_measure',
    kind: 'pilot_metric',
    title: 'Referred merchant quality',
    numerator: 'referred merchants whose activation was later revoked or restricted',
    denominator: 'referred merchants activated in the cohort',
    window: 'pilot_to_date',
    source: 'operator_entry',
    unit: 'rate_bps',
    producer: 'unavailable',
    seam: '#85',
    attributionLimit:
      '#85 derives activation live and records an observation trail, but nothing links a merchant ' +
      'activation back to the referral that produced it in a form this domain may read — the ' +
      'isolation gate forbids exactly that reach. Closing it is a projection #85 owns.',
  },
  {
    key: 'security_finding_measure',
    kind: 'pilot_metric',
    title: 'Open security findings against the pilot',
    numerator: 'critical or high security findings recorded against the referral program',
    denominator: 'the cohort — a count, not a ratio',
    window: 'pilot_to_date',
    source: 'operator_entry',
    unit: 'count',
    producer: 'operator_entry',
    attributionLimit:
      'Mercaria stores no security-finding record, so this is a figure a person enters. #149 ' +
      'pre-launch gate 11 makes it a launch condition rather than a measurement, and the ' +
      'threshold exists so a finding DURING the pilot stops it too.',
  },
];

/**
 * The expansion decision #149 requires after a complete measurement window.
 *
 * A closed set, and `expand` is deliberately one member among five rather than
 * the default: "expansion requires a dated review rather than automatic
 * rollout" (acceptance 7) is what this vocabulary makes checkable.
 */
export type ReferralPilotReviewDecision = 'continue' | 'modify' | 'expand' | 'pause' | 'end';

/** {@link ReferralPilotReviewDecision} as the tuple the columns and CHECKs read. */
export const REFERRAL_PILOT_REVIEW_DECISIONS: readonly ReferralPilotReviewDecision[] = [
  'continue',
  'modify',
  'expand',
  'pause',
  'end',
];

/** One threshold's verdict, as {@link ReferralPilotThresholdOutcome} carries it. */
export type ReferralPilotThresholdVerdict = 'breached' | 'within' | 'unmeasured';

/**
 * Why a threshold could not be evaluated.
 *
 * `no_producer` is the one that matters and is NOT the same as
 * `no_measurement`: the first says nothing in this repository can ever compute
 * it today, the second says nobody supplied one this time. Collapsing them
 * would make a permanent gap look like a transient one.
 */
export type ReferralPilotUnmeasuredReason =
  | 'no_producer'
  | 'no_measurement'
  | 'unit_mismatch'
  | 'empty_sample';

/** {@link ReferralPilotUnmeasuredReason} as a tuple. */
export const REFERRAL_PILOT_UNMEASURED_REASONS: readonly ReferralPilotUnmeasuredReason[] = [
  'no_producer',
  'no_measurement',
  'unit_mismatch',
  'empty_sample',
];
