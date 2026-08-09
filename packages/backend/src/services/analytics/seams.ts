/**
 * What #77 defines but does not yet EMIT, and who owes each one.
 *
 * ## A seam, never a fabricated event
 *
 * Sixteen of the guest-commerce event types belong to issues that have not
 * landed. Three options existed and two of them are wrong:
 *
 *  - **Drop them from the vocabulary.** Then every metric that needs one has an
 *    undefined denominator, the CHECK has to be widened later (a migration), and
 *    the contract does not say what the funnel will look like — which is the
 *    single most useful thing an event contract does before the code exists.
 *  - **Emit something approximate.** A `guest_payment_verified` derived from a
 *    client callback, a `guest_claim_completed` derived from a session
 *    conversion. Both would be indistinguishable from the real thing in every
 *    dashboard and in the operator trace, which is the failure mode #48's
 *    `deferred: #NN` note exists to prevent one domain over.
 *  - **Declare the type, emit nothing, and say so.** This file.
 *
 * The gate is `analytics-seams.test.ts`: it scans `src/` for any emission of a
 * deferred type and fails the build on one. So "nothing fabricates these" is a
 * property the build checks rather than a comment somebody has to honour, and
 * the day #107 lands its author deletes an entry here and the gate stops
 * objecting.
 *
 * ## The seam is also what a dashboard reads
 *
 * A metric whose events do not exist yet computes as zero-of-zero, and the
 * `AnalyticsMetricDefinition.seam` field carries the issue number so the
 * dashboard renders "awaiting #108" rather than "0%". A metric reading zero and
 * a metric that cannot yet be measured look identical on a chart and mean
 * opposite things.
 */

import type { AnalyticsEventType } from '@mercaria/shared-types';
import { ANALYTICS_DEFERRED_EVENT_TYPES, ANALYTICS_METRICS } from '@mercaria/shared-types';

/** One deferred capability, with the issue that owns it and what it will need. */
export interface AnalyticsSeam {
  /** The issue number, as written in the vocabulary. */
  readonly issue: string;
  /** What that issue will build. */
  readonly capability: string;
  /** The event types it will start emitting. */
  readonly eventTypes: readonly AnalyticsEventType[];
  /** The metric keys that stay zero-of-zero until then. */
  readonly metricKeys: readonly string[];
  /**
   * The CONTRACT the owning issue must satisfy — stated now, while the
   * reasoning is fresh, rather than rediscovered by whoever picks it up.
   */
  readonly contract: string;
}

/** Every seam, keyed by the owning issue. */
export const ANALYTICS_SEAMS: readonly AnalyticsSeam[] = [
  {
    issue: '#106',
    capability: 'Guest buyers on orders — contact/destination validation and the eligibility gate',
    eventTypes: [
      'guest_contact_validated',
      'guest_contact_validation_failed',
      'guest_destination_validated',
      'guest_destination_validation_failed',
      'guest_eligibility_accepted',
      'guest_eligibility_rejected',
    ],
    metricKeys: ['guest_eligibility_coverage'],
    contract:
      'These six are deferred for a reason worth reading, because the gates they describe ' +
      'ALREADY RUN: #105 landed `assertGuestSellerTypesAllowed` (ADR 0003 D18’s P2P exclusion), ' +
      '`assertDestinationCountrySupported` and `assertSellerGroupsAcceptDestination`, and a ' +
      'guest checkout passes through all three today. What they do not have is a BOUNDED ' +
      'refusal: each raises a generic `conflict()` carrying a sentence, so classifying one into ' +
      'a reason code would mean matching on message text — which is the fabricated event this ' +
      'file exists to refuse, and which would silently mis-classify the first time somebody ' +
      'improved the wording. Emitting only the ACCEPTED half was the other option and is ' +
      'worse: `guest_eligibility_coverage` would read a permanent, confident 100%. So the ' +
      'metric names this seam and reads as unmeasurable instead. #106 owes each refusal an ' +
      'error CODE from `ANALYTICS_REASON_CODES` (the members are already there — ' +
      '`p2p_seller_excluded`, `market_not_supported`, `destination_unsupported`, ' +
      '`seller_not_payment_ready`), after which both halves emit from the checkout controller ' +
      'with no further design. The validation events must carry the OUTCOME and nothing else: ' +
      'no email, no phone, no address line — `guest_checkouts` holds the contact and this ' +
      'domain has no column for any of it.',
  },
  {
    issue: '#107',
    capability: 'Stripe guest checkout — payment methods, action-required, verified success',
    eventTypes: [
      'guest_payment_methods_shown',
      'guest_payment_method_selected',
      'guest_payment_action_required',
      'guest_payment_client_failed',
      'guest_payment_verified',
    ],
    metricKeys: ['guest_verified_payment_conversion'],
    contract:
      'Method ids must be BOUNDED — a new ANALYTICS_REASON_CODES member or a dedicated tuple, ' +
      'never the provider’s own string, which changes with their API. `guest_payment_verified` ' +
      'must be emitted from the #48 event ingress after the payment aggregate moves, NEVER from ' +
      'the client confirmation callback: it is on the server-only side of ' +
      'ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES and the ingest endpoint refuses it. No card ' +
      'brand, no last four, no Stripe Customer id, no wallet identity — none of them has a ' +
      'column, and adding one fails analytics-forbidden-columns.test.ts.',
  },
  {
    issue: '#108',
    capability: 'Guest order portal and magic-link recovery',
    eventTypes: [
      'guest_order_portal_opened',
      'guest_recovery_requested',
      'guest_recovery_exchanged',
    ],
    metricKeys: ['order_portal_delivery_success'],
    contract:
      'Identity rule 9: portal and recovery events carry the GRANT’s row id or the checkout ' +
      'group, never the `mgx_`/`mgp_` token and never the email or its hash. A grant row id is ' +
      'not a reusable authorization value; a token is, which is why the token has no column and ' +
      'the redaction pass in redact-query.ts already destroys the three prefixes on sight. The ' +
      'recovery REQUEST is emitted even when no checkout matched — T5 answers 202 either way, ' +
      'and an event emitted only on a match would turn the metric into an enumeration oracle.',
  },
  {
    issue: '#109',
    capability: 'Claiming a guest checkout into an Oxy account',
    eventTypes: [
      'guest_claim_offered',
      'guest_claim_started',
      'guest_claim_completed',
      'guest_claim_declined',
      'guest_claim_conflicted',
    ],
    metricKeys: ['oxy_claim_funnel'],
    contract:
      'Identity rule 5 is the hard one and it is a rule about what NOT to write. A completed ' +
      'claim may connect that exact checkout group’s FUTURE account-owned events to the Oxy ' +
      'user; it may not rewrite a single stored row. There is deliberately no update path in ' +
      'db/analytics/eventRepository.ts — the table has an insert and two reads — so ' +
      '"retroactively absorb unrelated guest activity" has no statement to be performed by. ' +
      'A DECLINE is a normal outcome (rule 6) and is emitted as one, not as a surface_error. ' +
      'And `buyer_origin` on every already-stored event stays `guest`, because the column is ' +
      'written once and never updated — which is the same guarantee ADR 0003 D6’s trigger gives ' +
      'the order.',
  },
  {
    issue: '#110',
    capability: 'Guest cancellations, returns and support requests',
    eventTypes: [
      'guest_cancellation_requested',
      'guest_return_requested',
      'guest_support_request_created',
    ],
    metricKeys: ['guest_post_purchase_demand'],
    contract:
      'Free-text support content has no column and must not acquire one — a bounded reason code ' +
      'from ANALYTICS_REASON_CODES, or a new member of that tuple, is the whole of what a ' +
      'support event may say. The order correlation is admitted for these types by ' +
      'ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES; the buyer’s contact is not, in any form.',
  },
  {
    issue: '#111',
    capability: 'Guest-commerce rollout gates and retention coordination',
    eventTypes: [],
    metricKeys: [],
    contract:
      'ADR 0003 I12 assigns #111 the job of documenting each guest metric’s dimension before it ' +
      'ships. This domain has already chosen conservatively — actor KIND plus, for the funnel ' +
      'only, an opaque checkout group — so what #111 owes is the review that ratifies or narrows ' +
      'it, plus the coordination of GUEST_* flags with ANALYTICS_ENABLED. The two are ' +
      'deliberately INDEPENDENT levers today: guest commerce must be rollback-able while ' +
      'analytics is down, and analytics must be disable-able without touching guest commerce ' +
      '(experimentation rule 7 applied to the domain rather than to an experiment).',
  },
  {
    issue: '#74',
    capability: 'Ranking policy versions',
    eventTypes: [],
    metricKeys: [],
    contract:
      'Every event and every search record carries `search_policy_version` and ' +
      '`ranking_policy_version` columns that are NULL today because no policy version exists to ' +
      'record. #74 supplies them; nothing here has to change but the value passed at the call ' +
      'site. `analytics_experiments.ranking_policy_version` is the same seam for a ranking ' +
      'experiment’s arm.',
  },
  {
    issue: '#37',
    capability: 'Outbound affiliate redirect and network conversion reports',
    eventTypes: [],
    metricKeys: ['affiliate_commission'],
    contract:
      'The metric’s source is `affiliate_reports` and must stay so. Acceptance 3 forbids ' +
      'deriving a network conversion from `external_outbound_click`, and the two must never be ' +
      'divided into a "conversion rate" — network reports are revisable for weeks and the click ' +
      'is not, so the ratio would move without either input being wrong.',
  },
];

/** Every deferred event type, flattened — the gate scans for these. */
export const DEFERRED_EVENT_TYPES: readonly AnalyticsEventType[] = Object.keys(
  ANALYTICS_DEFERRED_EVENT_TYPES,
) as AnalyticsEventType[];

/**
 * Every metric that names a seam, so the dashboard can label it.
 *
 * Derived from the definitions rather than from {@link ANALYTICS_SEAMS}: the
 * definition is what a dashboard renders, so it must be the one that carries
 * the label, and a seam listed here but not on its metric would show a metric
 * as measurable when it is not.
 */
export function metricsAwaitingSeams(): readonly { key: string; seam: string }[] {
  return ANALYTICS_METRICS.filter((metric) => metric.seam !== undefined).map((metric) => ({
    key: metric.key,
    seam: metric.seam ?? '',
  }));
}
