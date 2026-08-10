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
/**
 * `#106` is CLOSED, and it is the first entry this list has lost.
 *
 * It is worth recording how, because the shape generalises to the seven below.
 * #77 did not defer those six event types because the gates were unbuilt — they
 * already ran, on every guest checkout, since #105. It deferred them because
 * every refusal was a generic `conflict()` carrying a SENTENCE, so classifying
 * one would have meant matching message text: silently wrong the first time
 * somebody improved the wording, and undetectable when it went wrong. Emitting
 * only the ACCEPTED half was the other option and was worse, because
 * `guest_eligibility_coverage` would have read a confident permanent 100%.
 *
 * What #106 supplied was not an event. It was `CheckoutRefusalReason` — a
 * closed vocabulary in the CHECKOUT domain, thrown by the gates as a typed
 * `CheckoutRefusal`, mapped to `ANALYTICS_REASON_CODES` by one exhaustive
 * `Record` in `checkout.controller.ts` that fails `tsc` if a reason is added
 * without deciding how it is measured. Then both halves emit and nothing is
 * fabricated. The entries below want the same thing: a bounded fact the
 * emitting domain already owns, never a string parsed after the event.
 *
 * `#108` is CLOSED too, and it is the clearest instance of the pattern above.
 * What supplied its three event types was not new instrumentation: it was the
 * GRANT ROW. A portal open and a magic-link exchange each produce an id that
 * authorizes nothing and is not a reusable value, so the funnel is countable
 * without a token, an address or a hash ever reaching a column — which is
 * exactly what its contract asked for. The one deliberate asymmetry survives in
 * the vocabulary: `guest_recovery_requested` carries NO checkout group and is
 * emitted on every request whether or not anything matched, because an event
 * emitted only on a match — or one carrying the group it matched — would be the
 * enumeration oracle the 202 exists to close.
 *
 * `#109` is CLOSED in the half a server can honestly measure, and the SPLIT is
 * the part worth recording. What supplied its three server-side types was the
 * CLAIM ROW — a started attempt, a completed claim and a contest each produce a
 * stable row id and a checkout group id, so the funnel is countable without the
 * claiming account's email, the losing claimant's identity or a portal
 * credential ever reaching a column. Identity rule 5 held for free rather than
 * by care: `analytics_events` has an insert and two reads and no update path at
 * all, so "retroactively absorb unrelated guest activity" has no statement to be
 * performed by, and `buyer_origin` on every already-stored event stays `guest`
 * because the column is written once — the same guarantee ADR 0003 D6's trigger
 * gives the order itself.
 *
 * Its other two types moved to #111 rather than being emitted approximately.
 * An OFFER is a screen having been shown and a DECLINE is somebody navigating
 * away; the server sees neither, and the nearest server-side substitutes — a
 * preview read and a claim that never arrived — are not the same facts. That is
 * the same refusal #77's own header describes, applied by the issue that would
 * have benefited most from cheating: `oxy_claim_funnel`'s numerator computes
 * today and its denominator does not, which is visible on the dashboard as a
 * seam rather than as a rate.
 */
export const ANALYTICS_SEAMS: readonly AnalyticsSeam[] = [
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
    capability:
      'Guest-commerce rollout gates, retention coordination, and the client payment ' +
      'instrumentation #107 reassigned here',
    eventTypes: [
      'guest_payment_methods_shown',
      'guest_payment_method_selected',
      'guest_payment_action_required',
      'guest_payment_client_failed',
      'guest_payment_verified',
      'guest_claim_offered',
      'guest_claim_declined',
    ],
    metricKeys: ['oxy_claim_funnel'],
    contract:
      'ADR 0003 I12 assigns #111 the job of documenting each guest metric’s dimension before it ' +
      'ships. This domain has already chosen conservatively — actor KIND plus, for the funnel ' +
      'only, an opaque checkout group — so what #111 owes is the review that ratifies or narrows ' +
      'it, plus the coordination of GUEST_* flags with ANALYTICS_ENABLED. The two are ' +
      'deliberately INDEPENDENT levers today: guest commerce must be rollback-able while ' +
      'analytics is down, and analytics must be disable-able without touching guest commerce ' +
      '(experimentation rule 7 applied to the domain rather than to an experiment). ' +
      'The five payment event types moved here from #107, which SHIPPED without them, and the ' +
      'reason is worth keeping because it is the same shape as #77’s own reasoning. FOUR of ' +
      'them (methods shown, method selected, action required, client failed) are facts only a ' +
      'browser or a payment sheet knows, and the storefront has no analytics client at all — ' +
      'building one is rollout instrumentation, not payment work. The FIFTH ' +
      '(`guest_payment_verified`) is server-observable, and emitting it from the payment domain ' +
      'was rejected on purpose: `verified-conversion.ts` establishes a ONE-WAY seam in which ' +
      'analytics reads `payments` and the payment path never depends on telemetry, and ' +
      '`guest_verified_payment_conversion` already takes its numerator from `payments` directly ' +
      '(it carries no `seam` field and computes today). An event emitted from the outbox would ' +
      'invert that direction to add a second, weaker source for a number nothing reads it for. ' +
      'The original contract still binds whoever lands them: method ids must be BOUNDED — a new ' +
      'ANALYTICS_REASON_CODES member or a dedicated tuple, never the provider’s own string, ' +
      'which changes with their API. `guest_payment_verified` must come from the #48 event ' +
      'ingress after the payment aggregate moves, NEVER from a client confirmation callback: it ' +
      'is on the server-only side of ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES and the ingest ' +
      'endpoint refuses it. No card brand, no last four, no Stripe Customer id, no wallet ' +
      'identity — none of them has a column, and adding one fails ' +
      'analytics-forbidden-columns.test.ts. ' +
      'The two CLAIM types arrived here from #109 for the same reason the four client payment ' +
      'ones did, and they are the sharper case because a server-side substitute exists and is ' +
      'wrong: `guest_claim_offered` must come from the review screen RENDERING, never from the ' +
      'preview endpoint being read (a client can poll it, and a claim made from a link the ' +
      'buyer never looked at would still count an offer), and `guest_claim_declined` must come ' +
      'from an explicit dismissal, never from "a preview was read and no claim followed" — the ' +
      'server cannot tell that from a lost connection. Until both land, `oxy_claim_funnel` has ' +
      'a live numerator and no denominator, which is what its `seam` field says on the ' +
      'dashboard.',
  },
  {
    issue: '#74',
    capability: 'Ranking policy versions on an EXPERIMENT’s arm — the impression half has LANDED',
    eventTypes: [],
    metricKeys: [],
    contract:
      'The impression half of this seam is CLOSED. #74 shipped versioned ranking policies and ' +
      '`offer-comparison.controller.ts` passes `rankingPolicyVersion` on every `offer_impression` ' +
      'it emits, so a measured result can be attributed to the policy that produced it — and ' +
      'exactly as this contract predicted, nothing in this domain changed but the value passed at ' +
      'the call site. A deployment that has published no policy records the BUILT-IN version ' +
      '(`builtin-…`), which is a real version an operator can look up rather than a NULL that ' +
      'reads as "unranked". `/offers` (#57) deliberately still passes none: it serves a plain ' +
      'cheapest-first SQL order under no policy at all, and stamping a version on it would ' +
      'attribute that ordering to weights it never consulted. ' +
      'What REMAINS is `analytics_experiments.ranking_policy_version`, the arm of a ranking ' +
      'EXPERIMENT, and it belongs to #111 rather than to #74: #74’s rollout is a canary over ' +
      'comparison SUBJECTS (a canonical product or variant), deliberately carrying no actor, ' +
      'session or device in its bucket preimage, so it is not an experiment over people and must ' +
      'not be recorded as one. `search_policy_version` is #70’s and is untouched.',
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
