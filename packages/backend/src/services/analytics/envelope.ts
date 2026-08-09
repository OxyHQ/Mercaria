/**
 * Building one analytics envelope (#77 "Event contract").
 *
 * Everything a caller may say about an event goes through {@link buildAnalyticsEvent},
 * which is where each envelope rule is applied ONCE:
 *
 *  - Field 5, the RESTRICTED commerce correlation, is dropped unless the event
 *    type is in `ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES`.
 *  - Field 12, buyer origin, is dropped unless the type is in
 *    `ANALYTICS_BUYER_ORIGIN_EVENT_TYPES`.
 *  - Field 3, the Oxy user id, comes from `identity.ts` and is already
 *    consent-gated by the time it arrives here.
 *  - The retention class is DERIVED from the event type through one table, so a
 *    new type cannot land without a retention decision — the map is exhaustive
 *    over the union and `tsc` refuses an addition that skips it.
 *
 * Each of those is ALSO a CHECK on the table. That is not redundancy: the CHECK
 * is what stops a future writer bypassing this function, and this function is
 * what stops a legitimate caller getting a 500 for a rule they could not have
 * known. A dropped field and a rejected insert are very different experiences.
 */

import type {
  AnalyticsBuyerOrigin,
  AnalyticsClientSurface,
  AnalyticsCollectionMode,
  AnalyticsConsentState,
  AnalyticsEntityIds,
  AnalyticsEventClass,
  AnalyticsEventType,
  AnalyticsMeasures,
  AnalyticsReasonCode,
  AnalyticsTrafficClass,
} from '@mercaria/shared-types';
import {
  ANALYTICS_BUYER_ORIGIN_EVENT_TYPES,
  ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES,
  ANALYTICS_DISCOVERY_EVENT_TYPES,
  ANALYTICS_ENVELOPE_VERSION,
  ANALYTICS_EXPERIMENT_EVENT_TYPES,
  ANALYTICS_GUEST_EVENT_TYPES,
} from '@mercaria/shared-types';
import type { AnalyticsEventInsert } from '../../db/analytics/eventRepository.js';
import { config } from '../../config/index.js';
import type { AnalyticsIdentity } from './identity.js';

/**
 * Which retention class each event type belongs to.
 *
 * A `Record` over the full union rather than a prefix rule, so adding a type
 * without deciding its retention fails `tsc`. A prefix rule (`guest_*` is
 * commerce) reads more cleanly and would have silently classed
 * `guest_session_issued` — a browsing-side event — with the funnel.
 */
const EVENT_CLASS_BY_TYPE: Record<AnalyticsEventType, AnalyticsEventClass> = {
  // Discovery: the high-volume, shortest-lived class.
  search_submitted: 'discovery',
  search_results_returned: 'discovery',
  search_zero_results: 'discovery',
  search_result_impression: 'discovery',
  search_result_click: 'discovery',
  entity_suggestion_click: 'discovery',
  product_page_view: 'discovery',
  variant_selected: 'discovery',
  offer_impression: 'discovery',
  offer_expanded: 'discovery',
  offer_selected: 'discovery',
  external_outbound_click: 'discovery',
  save_action: 'discovery',
  alert_action: 'discovery',
  watchlist_action: 'discovery',
  merchant_claim_entry: 'discovery',
  sell_yours_entry: 'discovery',
  // Operational: read by on-call, not by a product dashboard.
  surface_error: 'operational',
  // The funnel. `guest_session_issued` and the cart events are here rather than
  // in `discovery` because they are what a checkout investigation reads, and a
  // funnel whose first two steps expired first would be unanswerable.
  native_add_to_cart: 'commerce_funnel',
  checkout_started: 'commerce_funnel',
  guest_session_issued: 'commerce_funnel',
  guest_cart_created: 'commerce_funnel',
  guest_cart_item_added: 'commerce_funnel',
  guest_cart_item_updated: 'commerce_funnel',
  guest_cart_item_removed: 'commerce_funnel',
  guest_cart_merged: 'commerce_funnel',
  guest_checkout_started: 'commerce_funnel',
  guest_contact_validated: 'commerce_funnel',
  guest_contact_validation_failed: 'commerce_funnel',
  guest_destination_validated: 'commerce_funnel',
  guest_destination_validation_failed: 'commerce_funnel',
  guest_eligibility_accepted: 'commerce_funnel',
  guest_eligibility_rejected: 'commerce_funnel',
  guest_feature_gate_blocked: 'commerce_funnel',
  guest_payment_methods_shown: 'commerce_funnel',
  guest_payment_method_selected: 'commerce_funnel',
  guest_payment_action_required: 'commerce_funnel',
  guest_payment_client_failed: 'commerce_funnel',
  guest_payment_verified: 'commerce_funnel',
  guest_order_portal_opened: 'commerce_funnel',
  guest_recovery_requested: 'commerce_funnel',
  guest_recovery_exchanged: 'commerce_funnel',
  guest_claim_offered: 'commerce_funnel',
  guest_claim_started: 'commerce_funnel',
  guest_claim_completed: 'commerce_funnel',
  guest_claim_declined: 'commerce_funnel',
  guest_claim_conflicted: 'commerce_funnel',
  guest_cancellation_requested: 'commerce_funnel',
  guest_return_requested: 'commerce_funnel',
  guest_support_request_created: 'commerce_funnel',
  // Experiment exposure outlives discovery so a finished test stays analysable.
  experiment_exposed: 'experiment',
};

/** The retention class for an event type. Total over the union, by construction. */
export function eventClassFor(type: AnalyticsEventType): AnalyticsEventClass {
  return EVENT_CLASS_BY_TYPE[type];
}

/** Whether an event type may carry the checkout/order correlation (field 5). */
export function mayCarryCommerceCorrelation(type: AnalyticsEventType): boolean {
  return (ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES as readonly string[]).includes(type);
}

/** Whether an event type may carry the buyer-origin dimension (field 12). */
export function mayCarryBuyerOrigin(type: AnalyticsEventType): boolean {
  return (ANALYTICS_BUYER_ORIGIN_EVENT_TYPES as readonly string[]).includes(type);
}

/** Every event type, in one array, for the gates that enumerate them. */
export const ALL_EVENT_TYPES: readonly AnalyticsEventType[] = [
  ...ANALYTICS_DISCOVERY_EVENT_TYPES,
  ...ANALYTICS_GUEST_EVENT_TYPES,
  ...ANALYTICS_EXPERIMENT_EVENT_TYPES,
];

/** What a caller says about one event. */
export interface AnalyticsEventDraft {
  readonly eventType: AnalyticsEventType;
  readonly occurredAt?: Date;
  readonly identity: AnalyticsIdentity;
  readonly clientSurface: AnalyticsClientSurface;
  readonly appVersion?: string;
  readonly market?: string;
  readonly trafficClass: AnalyticsTrafficClass;
  readonly consentState: AnalyticsConsentState;
  readonly entities?: AnalyticsEntityIds;
  readonly measures?: AnalyticsMeasures;
  readonly reasonCode?: AnalyticsReasonCode;
  readonly buyerOrigin?: AnalyticsBuyerOrigin;
  readonly checkoutGroupId?: string;
  readonly orderId?: string;
  readonly searchPolicyVersion?: string;
  readonly rankingPolicyVersion?: string;
  readonly experimentKey?: string;
  readonly experimentVersion?: number;
  readonly experimentVariant?: string;
}

/** How long each class of event is retained, in days. */
const RETENTION_DAYS_BY_CLASS: Record<AnalyticsEventClass, number> = {
  discovery: 90,
  commerce_funnel: 180,
  experiment: 180,
  operational: 30,
};

/** The retention window for a class, exported so the docs and the gate agree. */
export function retentionDaysForClass(eventClass: AnalyticsEventClass): number {
  return RETENTION_DAYS_BY_CLASS[eventClass];
}

/**
 * Compose an insertable row from a draft.
 *
 * Pure: it takes a clock rather than reading one, so a test can pin the two
 * timestamps and the retention deadline exactly.
 *
 * `collectionMode` is read from config and is deliberately NOT a parameter. It
 * is a property of the deployment, not of the event, and a caller able to
 * override it could record a `full`-mode event on an `essential`-mode
 * deployment — a claim about consent that nothing downstream could check.
 */
export function buildAnalyticsEvent(draft: AnalyticsEventDraft, now: Date): AnalyticsEventInsert {
  const eventClass = eventClassFor(draft.eventType);
  const identity = draft.identity;
  const entities = draft.entities ?? {};
  const measures = draft.measures ?? {};

  // Field 5. Dropped rather than rejected — see the module docblock.
  const correlationAllowed = mayCarryCommerceCorrelation(draft.eventType);
  const originAllowed = mayCarryBuyerOrigin(draft.eventType);

  // The experiment triple travels whole or not at all; the CHECK refuses a
  // partial one, and composing a partial one here would 500 the flush rather
  // than the caller.
  const experimentComplete =
    draft.experimentKey !== undefined &&
    draft.experimentVersion !== undefined &&
    draft.experimentVariant !== undefined;

  return {
    envelopeVersion: ANALYTICS_ENVELOPE_VERSION,
    eventType: draft.eventType,
    eventClass,
    occurredAt: draft.occurredAt ?? now,
    // Never client-supplied. The whole point of a receipt time is that it is
    // ours: a client clock that is wrong (or lying) must not be able to place an
    // event outside the window a metric is computed over.
    receivedAt: now,
    actorKind: identity.kind === 'oxy' ? 'oxy' : identity.actorKind,
    oxyUserId: identity.kind === 'oxy' ? identity.oxyUserId : null,
    pseudonymousSessionId:
      identity.kind === 'pseudonymous' ? identity.pseudonymousSessionId : null,
    pseudonymEpoch: identity.kind === 'pseudonymous' ? identity.pseudonymEpoch : null,
    checkoutGroupId: correlationAllowed ? (draft.checkoutGroupId ?? null) : null,
    orderId: correlationAllowed ? (draft.orderId ?? null) : null,
    clientSurface: draft.clientSurface,
    appVersion: draft.appVersion ?? null,
    market: draft.market ?? null,
    queryEventId: entities.queryEventId ?? null,
    listingId: entities.listingId ?? null,
    productVariantId: entities.productVariantId ?? null,
    canonicalProductId: entities.canonicalProductId ?? null,
    canonicalVariantId: entities.canonicalVariantId ?? null,
    offerId: entities.offerId ?? null,
    merchantId: entities.merchantId ?? null,
    storefrontId: entities.storefrontId ?? null,
    categoryId: entities.categoryId ?? null,
    storeId: entities.storeId ?? null,
    searchPolicyVersion: draft.searchPolicyVersion ?? null,
    rankingPolicyVersion: draft.rankingPolicyVersion ?? null,
    experimentKey: experimentComplete ? (draft.experimentKey ?? null) : null,
    experimentVersion: experimentComplete ? (draft.experimentVersion ?? null) : null,
    experimentVariant: experimentComplete ? (draft.experimentVariant ?? null) : null,
    trafficClass: draft.trafficClass,
    consentState: draft.consentState,
    // `off` never reaches a row — the CHECK refuses it — and the sink returns
    // before this function is reached when collection is disabled. `essential`
    // is the floor a stored row can carry.
    collectionMode: storableCollectionMode(config.analytics.collectionMode),
    buyerOrigin: originAllowed ? (draft.buyerOrigin ?? null) : null,
    reasonCode: draft.reasonCode ?? null,
    position: measures.position ?? null,
    resultCount: measures.resultCount ?? null,
    latencyMs: measures.latencyMs ?? null,
    quantity: measures.quantity ?? null,
    itemCount: measures.itemCount ?? null,
    expiresAt: new Date(now.getTime() + RETENTION_DAYS_BY_CLASS[eventClass] * 86_400_000),
  };
}

/**
 * The mode a stored row may claim.
 *
 * `off` is the mode in which nothing is recorded, so a row carrying it is a
 * contradiction and the CHECK refuses it. Reaching here with `off` means the
 * sink's own gate was bypassed — which a test does deliberately — so this
 * narrows to `essential` rather than throwing, and the row records the weakest
 * true claim instead of failing a flush nobody is waiting on.
 */
function storableCollectionMode(mode: AnalyticsCollectionMode): 'essential' | 'full' {
  return mode === 'full' ? 'full' : 'essential';
}
