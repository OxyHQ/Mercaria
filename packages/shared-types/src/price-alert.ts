/**
 * Product and variant price alerts — issue #79.
 *
 * A buyer describes a real price condition on a canonical product or variant and
 * receives ONE useful notification when a current eligible offer satisfies it.
 * Everything in this file exists to make one of the four failure modes below
 * unrepresentable rather than merely unimplemented.
 *
 * ## The four shapes this file refuses
 *
 * 1. **The same good news, twice.** A duplicate source event, an FX re-check, a
 *    retried delivery and two concurrent workers must all converge on one
 *    notification. {@link priceAlertTriggerKey} names the four facts that decide
 *    identity — alert, offer, OBSERVED-PRICE VERSION and alert policy version —
 *    and the trigger table's unique index is rendered from exactly those four.
 *    A key missing the observed-price version would fire once and never again; a
 *    key missing it and using a timestamp instead would fire on every sweep.
 * 2. **A total that treats unpublished delivery as free.** A `known_total` alert
 *    is answered by {@link PriceAlertQualification}, whose qualifying branch has
 *    no shape without a `Money` — and the total is only ever built from #74's
 *    `OfferComparisonTotal`, whose unknown branch has no amount. So the coercion
 *    cannot be written by accident; it has to be typed out.
 * 3. **A price nobody can still buy.** A trigger cites the offer AND the exact
 *    observation version behind the price. The DELIVERY re-checks that the
 *    destination is still eligible and SUPPRESSES rather than sending, which is
 *    counted — a suppression leaves a row precisely because "how many did we
 *    withhold" is not a question a table of sent messages can answer.
 * 4. **A number converted at a rate nobody recorded.** Every cross-currency
 *    trigger carries the {@link FxRateSnapshot} of each component it converted,
 *    as rows, so acceptance 3 (reproducible from the recorded quote) is a fact
 *    about the data rather than a promise about the code.
 *
 * ## What an alert deliberately cannot say
 *
 * {@link PRICE_ALERT_FORBIDDEN_SCOPES} names the scopes that may never become
 * alert fields, and it is DISJOINT from every vocabulary here — the
 * `RetailForbiddenComponentKind` device. The two that matter: an alert cannot
 * be scoped to a seller's PLAN or commission, because that would make a paid
 * placement decide whose price a buyer hears about; and an alert cannot carry a
 * contact address, because Mercaria's transactional channel is Oxy's own
 * notification service and a second copy of somebody's inbox is a retention
 * problem with no owner.
 */

import type { ConditionGroup } from './condition';
import type { CurrencyCode, FxRateSnapshot, Money } from './money';

/* ────────────────────────────────────────────────────────────────────────── */
/* The alert                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * What the target amount is compared AGAINST (issue model field 4).
 *
 * `item_price` is the seller's own price converted into the alert's currency.
 * `known_total` is that plus a delivery cost the source actually PUBLISHED —
 * never a delivery cost inferred, defaulted or assumed free. The two behave
 * differently on exactly the offers whose postage nobody published, which is
 * acceptance 2, and the difference is carried by the type rather than by a
 * branch: see {@link PriceAlertQualification}.
 */
export type PriceAlertComparisonBasis = 'item_price' | 'known_total';

export const PRICE_ALERT_COMPARISON_BASES: readonly PriceAlertComparisonBasis[] = [
  'item_price',
  'known_total',
];

/**
 * The alert's lifecycle (issue model field 9).
 *
 * `triggered` is a real state and not a flag beside `enabled`: a `once` alert
 * that has fired is finished, and a buyer looking at their list needs to see
 * that it did its job rather than that it is still watching. `deleted` is a
 * state rather than a row removal, because a delivery job already queued names
 * the alert and must be able to say why it was suppressed.
 */
export type PriceAlertState = 'enabled' | 'paused' | 'triggered' | 'deleted';

export const PRICE_ALERT_STATES: readonly PriceAlertState[] = [
  'enabled',
  'paused',
  'triggered',
  'deleted',
];

/** The states in which an alert may still be evaluated at all. */
export const PRICE_ALERT_EVALUABLE_STATES: readonly PriceAlertState[] = ['enabled'];

/**
 * When an alert may fire AGAIN (issue §"Trigger identity", repeat rules 1–3).
 *
 * The issue names three admissible repeat conditions and this union is those
 * three plus the default of not repeating at all. There is deliberately NO
 * "repeat whenever it still qualifies" member that is not an explicit user
 * choice: an alert whose condition holds for a week would otherwise send a
 * message every time a feed republished the same number.
 *
 * - `once` — one notification, ever. The alert moves to `triggered`.
 * - `reset_threshold` — repeat rule 1. The alert re-arms only once an evaluation
 *   OBSERVES the best in-scope amount above {@link PriceAlert.resetThreshold},
 *   so a price that dips, recovers and dips again notifies twice and a price
 *   that merely wobbles under the target notifies once.
 * - `cooldown_better_low` — repeat rule 2. Both halves are required: the
 *   cooldown must have elapsed AND the new amount must be materially below the
 *   one that fired last time ({@link PRICE_ALERT_MATERIAL_IMPROVEMENT_BPS}).
 *   Either half alone is the thing the rule exists to prevent.
 * - `always` — repeat rule 3, and the only member a user selects to get repeated
 *   notifications. It still cannot repeat for one OBSERVATION, because the
 *   trigger key names the observed-price version.
 */
export type PriceAlertRepeatPolicy =
  | 'once'
  | 'reset_threshold'
  | 'cooldown_better_low'
  | 'always';

export const PRICE_ALERT_REPEAT_POLICIES: readonly PriceAlertRepeatPolicy[] = [
  'once',
  'reset_threshold',
  'cooldown_better_low',
  'always',
];

/**
 * How much better a new low must be before `cooldown_better_low` calls it
 * material — one hundred basis points, one percent.
 *
 * A code CONSTANT and not a per-alert field, deliberately: "materially better"
 * is a statement about what is worth interrupting somebody for, which is a
 * product decision, and a per-alert number would let a client set it to zero
 * and turn the policy back into `always` under a different name. The floor of
 * one minor unit below is what stops a cheap item's one percent rounding to
 * nothing and admitting every re-observation.
 */
export const PRICE_ALERT_MATERIAL_IMPROVEMENT_BPS = 100;

/**
 * Which sellers count (issue model field 7).
 *
 * `official_only` reads #55's VERIFIED relationship through #74's ranking facts
 * and never a name, a logo or a domain — there is no member for those because
 * `commerce_relationships` has no verification method that could produce one.
 */
export type PriceAlertSellerScope =
  | 'any'
  | 'native_only'
  | 'external_only'
  | 'official_only';

export const PRICE_ALERT_SELLER_SCOPES: readonly PriceAlertSellerScope[] = [
  'any',
  'native_only',
  'external_only',
  'official_only',
];

/**
 * Whether the alert cares about being near the buyer (issue model field 7's
 * "nearby").
 *
 * `nearby_pickup` is REPRESENTABLE and NOT AVAILABLE — the `role_email` device
 * from #83. #74's `resolvePickupProximity` refuses every request because #93
 * publishes no collection points, so an alert scoped this way could never fire;
 * the write schema therefore refuses the value by NAME rather than accepting a
 * subscription that is silently dead. The value stays in the tuple so that the
 * column, the CHECK and the evaluator's block reason all exist for it, and
 * turning it on is #93 registering a proximity source and one line here.
 */
export type PriceAlertProximityScope = 'any' | 'nearby_pickup';

export const PRICE_ALERT_PROXIMITY_SCOPES: readonly PriceAlertProximityScope[] = [
  'any',
  'nearby_pickup',
];

/** The proximity scopes a buyer may actually select today. */
export const PRICE_ALERT_AVAILABLE_PROXIMITY_SCOPES: readonly PriceAlertProximityScope[] = ['any'];

/**
 * The minimum availability an offer must state (issue model field 8).
 *
 * `in_stock` requires the source to have POSITIVELY said so. Most feeds publish
 * no availability at all, and #57 records that as `unknown`; an alert asking for
 * stock is asking for a statement, so silence does not satisfy it. That is the
 * house "unknown is never a soft yes" applied to a buyer's own condition, and it
 * is why `any` is the default rather than `in_stock`.
 */
export type PriceAlertAvailabilityRequirement = 'any' | 'in_stock';

export const PRICE_ALERT_AVAILABILITY_REQUIREMENTS: readonly PriceAlertAvailabilityRequirement[] = [
  'any',
  'in_stock',
];

/**
 * How an alert stands with respect to a catalogue split that divided its
 * product (#59 split invariant 3, #80's shape one domain over).
 *
 * A split makes one identity into two and nothing in the data says which of them
 * a person meant, so the alert is PAUSED and marked, and the buyer answers. A
 * deterministic migration was refused for #80's reason: "keep it where it is" is
 * silently wrong for exactly the buyers whose interest moved.
 */
export type PriceAlertResolution =
  | { readonly state: 'resolved' }
  | {
      readonly state: 'ambiguous_after_split';
      readonly splitJobId: string;
      readonly sourceCanonicalProductId: string;
      /** The other candidate the split produced. Absent while the job has not minted one. */
      readonly targetCanonicalProductId?: string;
    };

export type PriceAlertResolutionState = PriceAlertResolution['state'];

export const PRICE_ALERT_RESOLUTION_STATES: readonly PriceAlertResolutionState[] = [
  'resolved',
  'ambiguous_after_split',
];

/** How a buyer answers a split ambiguity. The #80 three-way choice, verbatim. */
export type PriceAlertSplitResolution = 'keep_source' | 'move_to_target' | 'keep_both';

export const PRICE_ALERT_SPLIT_RESOLUTIONS: readonly PriceAlertSplitResolution[] = [
  'keep_source',
  'move_to_target',
  'keep_both',
];

/**
 * Scopes an alert may NEVER carry, named as VALUES so the prohibition is
 * checkable rather than remembered.
 *
 * DISJOINT from {@link PRICE_ALERT_SELLER_SCOPES} and every other vocabulary
 * here, asserted by `price-alert-isolation.test.ts`. Each one is a way a paid
 * placement, a commission or somebody's contact details would reach the decision
 * about whose price a buyer is told about.
 */
export const PRICE_ALERT_FORBIDDEN_SCOPES: readonly string[] = [
  'sponsored_only',
  'highest_commission',
  'merchant_plan_tier',
  'promoted_placement',
  'fee_schedule_key',
  'referral_partner',
  'affiliate_network_payout',
  'buyer_email',
  'buyer_phone',
  'payment_method',
  'card_fingerprint',
];

/**
 * The alert policy VERSION every trigger cites.
 *
 * A code constant and not a table — `CATALOG_BACKFILL_MAPPING_VERSION`'s
 * reasoning: the evaluation is a PROCEDURE, and a table would let somebody
 * publish a version whose rules nobody shipped. Bumping it is a deliberate
 * change that re-opens every alert for one more notification, because the
 * trigger key names it, so it is bumped only when the meaning of "qualifies"
 * changes.
 */
export const PRICE_ALERT_POLICY_VERSION = '2026-08-10.1';

/** One buyer's price condition, as their own client sees it. */
export interface PriceAlert {
  readonly id: string;
  /** Issue model field 2. Always present — an alert is always ABOUT a product. */
  readonly canonicalProductId: string;
  /** Issue model field 2's optional half: one exact configuration. */
  readonly canonicalVariantId?: string;
  /** Issue model field 3. The amount and the currency the comparison is made in. */
  readonly target: Money;
  readonly basis: PriceAlertComparisonBasis;
  /** Issue model field 5. EMPTY means every segment. */
  readonly conditionGroups: readonly ConditionGroup[];
  /** Issue model field 6. ISO 3166-1 alpha-2, or absent for every market. */
  readonly market?: string;
  readonly sellerScope: PriceAlertSellerScope;
  readonly proximityScope: PriceAlertProximityScope;
  readonly merchantId?: string;
  readonly storefrontId?: string;
  readonly availabilityRequirement: PriceAlertAvailabilityRequirement;
  /** Issue model field 8. Unknown quantity never satisfies a minimum. */
  readonly minimumAvailableQuantity?: number;
  /** Issue model field 8's other half — #57's `OfferPickupState`, not proximity. */
  readonly requirePickupAvailable: boolean;
  readonly state: PriceAlertState;
  readonly repeatPolicy: PriceAlertRepeatPolicy;
  /** Required by `reset_threshold`, forbidden otherwise. In the alert's currency. */
  readonly resetThreshold?: Money;
  /** Required by `cooldown_better_low`, forbidden otherwise. */
  readonly cooldownSeconds?: number;
  /** Issue notification 7. All three present together or none of them. */
  readonly quietHours?: PriceAlertQuietHours;
  /** Issue notification 7's other half. BCP-47, as the buyer's client stated it. */
  readonly locale?: string;
  /** Issue notification 2 — an explicit preference, honoured only where a transport exists. */
  readonly emailOptIn: boolean;
  readonly resolution: PriceAlertResolution;
  /** Issue model field 11. */
  readonly createdAt: string;
  readonly lastEvaluatedAt?: string;
  readonly lastTriggeredAt?: string;
  readonly lastDeliveredAt?: string;
  /** The amount that fired last time, which `cooldown_better_low` measures against. */
  readonly lastTriggeredAmount?: Money;
  /** Issue model field 12's merge half — set when a product merge rehomed this alert. */
  readonly rehomedFromCanonicalProductId?: string;
  readonly rehomedAt?: string;
}

/**
 * When NOT to interrupt somebody (issue notification 7).
 *
 * Minutes from local midnight plus an IANA zone, all three together or none —
 * a window with no zone is a window in the server's time, which is not a fact
 * about the buyer's night. A window that WRAPS midnight is ordinary and is why
 * `startMinute > endMinute` is legal rather than a validation error.
 *
 * Quiet hours DEFER a delivery to the end of the window; they never drop one.
 * A dropped alert is indistinguishable from an alert that never qualified, and
 * the whole point of the durable delivery job is that it is not.
 */
export interface PriceAlertQuietHours {
  readonly startMinute: number;
  readonly endMinute: number;
  /** An IANA zone name (`Europe/Madrid`). Validated by `Intl`, never a fixed list. */
  readonly timeZone: string;
}

export const PRICE_ALERT_MINUTES_PER_DAY = 1_440;

/* ────────────────────────────────────────────────────────────────────────── */
/* Evaluation                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Why an evaluation did not produce a trigger.
 *
 * Every member names a fact the evaluator READ, so the list is exhaustive
 * rather than a guess, and an operator tracing "why did my alert not fire" gets
 * the answer rather than an absence. `above_target` is the ordinary one and is
 * not an error.
 */
export type PriceAlertBlockReason =
  /** Nothing in the comparison survived #74's eligibility at all. */
  | 'no_eligible_offer'
  /** Eligible offers exist and none of them is in this alert's scope. */
  | 'no_offer_in_scope'
  /** The best in-scope amount is above the target. */
  | 'above_target'
  /** `known_total`, and no in-scope offer published a delivery cost. */
  | 'delivery_cost_unknown'
  /** The offer's currency could not be quoted into the alert's currency. */
  | 'currency_not_convertible'
  /** No immutable observation stands behind the qualifying price. */
  | 'no_observed_price_version'
  /** The repeat policy says it is too soon, or not enough better, or already done. */
  | 'repeat_policy_not_satisfied'
  /** The alert is paused, triggered-and-finished or deleted. */
  | 'alert_not_evaluable'
  /** A split divided the product and the buyer has not said which one they meant. */
  | 'ambiguous_after_split'
  /** The alert asks for proximity, which #93 does not supply. */
  | 'proximity_scope_unsupported';

export const PRICE_ALERT_BLOCK_REASONS: readonly PriceAlertBlockReason[] = [
  'no_eligible_offer',
  'no_offer_in_scope',
  'above_target',
  'delivery_cost_unknown',
  'currency_not_convertible',
  'no_observed_price_version',
  'repeat_policy_not_satisfied',
  'alert_not_evaluable',
  'ambiguous_after_split',
  'proximity_scope_unsupported',
];

/**
 * What an evaluation concluded about ONE alert.
 *
 * A STRING discriminant, not a boolean: `@mercaria/backend` compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant — the finding #68
 * recorded and #110 hit again. `if (!x.qualified)` would leave the caller
 * holding the whole union.
 *
 * The qualifying branch carries everything a trigger row needs and the blocked
 * branch carries none of it, so `insertPriceAlertTrigger` cannot be called from
 * a refusal — the missing fields are a compile error rather than a NULL.
 */
export type PriceAlertQualification =
  | {
      readonly outcome: 'blocked';
      readonly reasons: readonly PriceAlertBlockReason[];
      /** The best in-scope amount, when there WAS one — what a trace shows a buyer. */
      readonly bestInScopeAmount?: Money;
    }
  | {
      readonly outcome: 'qualified';
      readonly offerId: string;
      /** Which variant qualified — issue evaluation 7, stated rather than implied. */
      readonly canonicalVariantId: string;
      /**
       * The immutable observation behind the price (`offer_price_snapshots.id`).
       *
       * Part of the trigger key, which is why a qualification with none is a
       * BLOCK (`no_observed_price_version`) rather than a trigger with a NULL:
       * without it a repeated evaluation of one unchanged price has no way to
       * recognise itself and would notify on every sweep.
       */
      readonly observedPriceVersion: string;
      /** The amount compared against the target, in the alert's own currency. */
      readonly amount: Money;
      /** The offer's own price, in the offer's own currency. */
      readonly nativeItemAmount: number;
      readonly nativeItemCurrency: string;
      /** Present only for a `known_total` qualification whose source published one. */
      readonly nativeDeliveryAmount?: number;
      readonly nativeDeliveryCurrency?: string;
      /** One per component actually converted. EMPTY when nothing was. */
      readonly quotes: readonly PriceAlertTriggerQuote[];
      readonly conditionGroup?: ConditionGroup;
      readonly merchantId?: string;
      readonly offerKind: string;
      /** Whether the buyer can complete the purchase on Mercaria (notification 5). */
      readonly nativeCheckoutEligible: boolean;
    };

/** Which half of a `known_total` a stored quote converted. */
export type PriceAlertCostComponent = 'item_price' | 'delivery_cost';

export const PRICE_ALERT_COST_COMPONENTS: readonly PriceAlertCostComponent[] = [
  'item_price',
  'delivery_cost',
];

/** One conversion, retained so the amount can be re-derived (acceptance 3). */
export interface PriceAlertTriggerQuote {
  readonly component: PriceAlertCostComponent;
  readonly snapshot: FxRateSnapshot;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Triggers and delivery                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The identity of one qualifying OBSERVATION (issue §"Trigger identity").
 *
 * Four facts and no fifth: the alert, the offer, the observed-price version and
 * the alert policy version. There is deliberately no clock in it — a timestamp
 * would make every re-evaluation a new identity, which is the duplicate-
 * notification bug the whole section exists to prevent — and no evaluation-run
 * id, for the same reason.
 *
 * The unique index on `price_alert_triggers` is rendered from exactly these four
 * columns, so this function and the constraint cannot disagree: the function
 * produces the key a caller LOGS and traces with, and the database produces the
 * convergence.
 */
export function priceAlertTriggerKey(input: {
  readonly alertId: string;
  readonly offerId: string;
  readonly observedPriceVersion: string;
  readonly policyVersion: string;
}): string {
  return [input.alertId, input.offerId, input.observedPriceVersion, input.policyVersion].join('|');
}

/**
 * Where a notification goes.
 *
 * `oxy_notification` is the ecosystem channel (issue notification 1) — the
 * in-app feed, Expo push and Web Push, fanned out by
 * `lib/notification-service.ts`, which already carries a `price_alert` type.
 *
 * `email` is issue notification 2 and is representable and UNSENDABLE: Mercaria
 * has no outbound mail transport, so `services/price-alerts/transport.ts`
 * carries an EMPTY registry and every attempt fails `transport_unconfigured`
 * visibly with the row intact. A `console.log` transport looks like a working
 * feature in every test and sends nothing in production; an unprovisioned SES
 * client looks like one in production and fails like an outage. #108 made the
 * same call for the guest portal and this is the same seam.
 */
export type PriceAlertNotificationChannel = 'oxy_notification' | 'email';

export const PRICE_ALERT_NOTIFICATION_CHANNELS: readonly PriceAlertNotificationChannel[] = [
  'oxy_notification',
  'email',
];

/**
 * What became of one notification (issue notification 6).
 *
 * `opened` is deliberately NOT a member. Whether somebody read a notification is
 * already stored, once, on `notifications.read_at`; a second column here could
 * disagree with it, and two representations of one fact is the thing this
 * codebase refuses everywhere else. {@link PriceAlertNotificationView.openedAt}
 * is DERIVED from the linked notification row.
 */
export type PriceAlertNotificationState =
  | 'queued'
  | 'delivering'
  | 'delivered'
  | 'failed'
  | 'suppressed'
  | 'dead_letter';

export const PRICE_ALERT_NOTIFICATION_STATES: readonly PriceAlertNotificationState[] = [
  'queued',
  'delivering',
  'delivered',
  'failed',
  'suppressed',
  'dead_letter',
];

/**
 * Why a queued notification was withheld rather than sent.
 *
 * A SUPPRESSION is a terminal outcome with a row, not a silent drop, because
 * "how many notifications did we withhold because the price had already gone"
 * is issue operations 3's stale-link measurement and a table of sent messages
 * can never answer it.
 */
export type PriceAlertSuppressionReason =
  /** Acceptance 4 — the qualifying offer stopped being eligible before we sent. */
  | 'destination_no_longer_eligible'
  /** The buyer deleted the alert between the trigger and the send. */
  | 'alert_deleted'
  /** The buyer paused it. */
  | 'alert_paused'
  /** The channel is not deliverable for this buyer and never will be. */
  | 'channel_unavailable';

export const PRICE_ALERT_SUPPRESSION_REASONS: readonly PriceAlertSuppressionReason[] = [
  'destination_no_longer_eligible',
  'alert_deleted',
  'alert_paused',
  'channel_unavailable',
];

/**
 * Why the LAST delivery attempt failed — a CLOSED set of Mercaria's own codes.
 *
 * Never a transport's own message: somebody else's vocabulary is unbounded, and
 * a mail provider's error text routinely quotes the recipient address, which is
 * the one value this domain spends its whole shape keeping out of reach.
 *
 * `transport_unconfigured` is the honest and expected state of the `email`
 * channel today — see {@link PriceAlertNotificationChannel}.
 */
export type PriceAlertDeliveryFailure =
  | 'transport_unconfigured'
  | 'transport_rejected'
  | 'transport_unavailable'
  | 'trigger_unreadable'
  | 'unexpected_error';

export const PRICE_ALERT_DELIVERY_FAILURES: readonly PriceAlertDeliveryFailure[] = [
  'transport_unconfigured',
  'transport_rejected',
  'transport_unavailable',
  'trigger_unreadable',
  'unexpected_error',
];

/**
 * A trigger, as an operator trace and the buyer's own history see it.
 *
 * It names the product, the variant that qualified, the merchant and the offer —
 * everything issue notification 4 asks a message to state — and it carries NO
 * destination URL. A notification links to the canonical product and the
 * qualifying offer inside Mercaria; a stored outbound address would be exactly
 * the "now-unvalidated destination" notification 3 forbids linking to.
 */
export interface PriceAlertTrigger {
  readonly id: string;
  readonly alertId: string;
  readonly offerId: string;
  readonly canonicalProductId: string;
  readonly canonicalVariantId: string;
  readonly observedPriceVersion: string;
  readonly policyVersion: string;
  readonly basis: PriceAlertComparisonBasis;
  /** The amount that satisfied the target, in the alert's own currency. */
  readonly amount: Money;
  readonly target: Money;
  readonly nativeItemPrice: { readonly amount: number; readonly currency: string };
  readonly nativeDeliveryCost?: { readonly amount: number; readonly currency: string };
  readonly quotes: readonly PriceAlertTriggerQuote[];
  readonly conditionGroup?: ConditionGroup;
  readonly merchantId?: string;
  readonly offerKind: string;
  /** Notification 5 — native purchase and external navigation are different things. */
  readonly nativeCheckoutEligible: boolean;
  readonly triggeredAt: string;
}

/** One delivery attempt record, as a buyer's history and an operator trace see it. */
export interface PriceAlertNotificationView {
  readonly id: string;
  readonly triggerId: string;
  readonly channel: PriceAlertNotificationChannel;
  readonly state: PriceAlertNotificationState;
  readonly suppressionReason?: PriceAlertSuppressionReason;
  readonly attempts: number;
  readonly queuedAt: string;
  readonly deliveredAt?: string;
  /** DERIVED from `notifications.read_at`, never stored twice. See the state union. */
  readonly openedAt?: string;
  /** The last failure's coded reason. Never a provider message or a stack. */
  readonly failureReason?: string;
}

/**
 * What the buyer is told (issue notification 4).
 *
 * Composed server-side from the trigger and handed to the notification service
 * as structured `data`, so a client can re-render it in the buyer's own locale
 * without the server shipping localized prose. The FIELD LIST is the allow-list:
 * `services/price-alerts/notification.ts` builds exactly this and a runtime gate
 * walks a real emitted payload against
 * {@link PRICE_ALERT_FORBIDDEN_NOTIFICATION_FIELDS}.
 */
export interface PriceAlertNotificationPayload {
  readonly alertId: string;
  readonly triggerId: string;
  readonly canonicalProductId: string;
  readonly canonicalVariantId: string;
  readonly offerId: string;
  readonly merchantId?: string;
  readonly amount: Money;
  readonly target: Money;
  readonly basis: PriceAlertComparisonBasis;
  readonly conditionGroup?: ConditionGroup;
  /** Notification 5: a native purchase and an outbound navigation are different. */
  readonly nativeCheckoutEligible: boolean;
  /** Notification 7's locale half, echoed so a client can re-render. */
  readonly locale?: string;
}

/**
 * Fields a price-alert notification payload may NEVER carry, as VALUES.
 *
 * The first four are the "now-unvalidated destination" of notification 3 — a
 * message carrying an outbound URL would still carry it a week later, which is
 * precisely the link that must not survive. The rest are the buyer identity a
 * push payload has no reason to hold.
 */
export const PRICE_ALERT_FORBIDDEN_NOTIFICATION_FIELDS: readonly string[] = [
  'destinationUrl',
  'affiliateUrl',
  'trackingTemplate',
  'affiliateNetwork',
  'buyerEmail',
  'email',
  'emailHash',
  'phone',
  'guestSessionId',
  'pushToken',
  'oxyUserId',
];

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure rules                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Whether a repeat policy's own precondition is met, given the alert's history.
 *
 * PURE, and the whole of repeat rules 1–3. The `armed` question is answered from
 * two timestamps that each record a real event (`lastTriggeredAt` and
 * `rearmedAt`) rather than from a stored boolean, so there is no second
 * representation of "may fire again" for a service bug to leave stale.
 */
export function repeatPolicySatisfied(input: {
  readonly policy: PriceAlertRepeatPolicy;
  readonly lastTriggeredAt?: Date;
  readonly rearmedAt?: Date;
  readonly lastTriggeredAmountMinor?: number;
  readonly cooldownSeconds?: number;
  readonly candidateAmountMinor: number;
  readonly now: Date;
}): boolean {
  if (input.lastTriggeredAt === undefined) return true;

  switch (input.policy) {
    case 'once':
      return false;
    case 'always':
      return true;
    case 'reset_threshold':
      // Re-armed means an evaluation SAW the price above the reset threshold
      // after the last notification. A wobble under the target never re-arms.
      return input.rearmedAt !== undefined && input.rearmedAt > input.lastTriggeredAt;
    case 'cooldown_better_low': {
      const cooldownSeconds = input.cooldownSeconds ?? 0;
      const elapsedMs = input.now.getTime() - input.lastTriggeredAt.getTime();
      if (elapsedMs < cooldownSeconds * 1_000) return false;
      const previous = input.lastTriggeredAmountMinor;
      if (previous === undefined) return true;
      return input.candidateAmountMinor <= materialImprovementCeiling(previous);
    }
  }
}

/**
 * The highest amount that still counts as materially better than `previous`.
 *
 * One percent, floored at ONE minor unit so a cheap item's percentage cannot
 * round to zero and re-admit every re-observation of an unchanged price. Stated
 * as a ceiling rather than a delta because that is what the comparison reads,
 * and because expressing it the other way invites a `<` where a `<=` belongs.
 */
export function materialImprovementCeiling(previousMinor: number): number {
  const proportional = Math.floor((previousMinor * PRICE_ALERT_MATERIAL_IMPROVEMENT_BPS) / 10_000);
  return previousMinor - Math.max(1, proportional);
}

/**
 * Whether `at` falls inside the alert's quiet window.
 *
 * The window is expressed in the buyer's own zone, so the comparison converts
 * `at` into that zone with `Intl` rather than doing arithmetic on a UTC offset —
 * an offset is not a zone and is wrong twice a year. A zone the runtime does not
 * recognise answers FALSE: a quiet window nobody can evaluate must not become a
 * reason to withhold a notification indefinitely.
 */
export function withinQuietHours(quietHours: PriceAlertQuietHours, at: Date): boolean {
  const minute = localMinuteOfDay(quietHours.timeZone, at);
  if (minute === undefined) return false;
  const { startMinute, endMinute } = quietHours;
  if (startMinute === endMinute) return false;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

/**
 * The next instant at or after `at` that is outside the quiet window.
 *
 * Minute granularity, which is the granularity the window itself is expressed
 * in. A delivery is DEFERRED to this instant and never dropped — see
 * {@link PriceAlertQuietHours}.
 */
export function quietHoursReleaseAt(quietHours: PriceAlertQuietHours, at: Date): Date {
  const minute = localMinuteOfDay(quietHours.timeZone, at);
  if (minute === undefined) return at;
  const untilEnd =
    minute < quietHours.endMinute
      ? quietHours.endMinute - minute
      : PRICE_ALERT_MINUTES_PER_DAY - minute + quietHours.endMinute;
  return new Date(at.getTime() + untilEnd * 60_000);
}

/**
 * Minutes since local midnight in `timeZone`, or `undefined` when the runtime
 * does not know the zone.
 *
 * `Intl.DateTimeFormat` with an explicit `hourCycle: 'h23'`, because the default
 * for some locales renders midnight as `24` and the arithmetic would then put a
 * quiet window a day out.
 */
function localMinuteOfDay(timeZone: string, at: Date): number | undefined {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return undefined;
  }
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined;
  return hour * 60 + minute;
}

/** Whether a string is an IANA zone this runtime can evaluate. */
export function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
