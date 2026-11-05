/**
 * The storefront analytics client (#111).
 *
 * ## Why this exists at all
 *
 * Some event types are facts only a browser knows — whether a claim screen was
 * RENDERED, and whether it was explicitly dismissed. #109 declined to fabricate
 * server-side substitutes for them and said so; what they were waiting for is a
 * client, and building one is rollout instrumentation rather than claim work.
 *
 * ## It cannot block anything, and the SIGNATURE is the guarantee
 *
 * `track()` returns `void`, not a promise — the backend sink's device, applied
 * one layer out. A caller has nothing to await, so an analytics call can never
 * join the path between a buyer's press and what it opens, and a caller who
 * tried would get a `tsc` error. The POST is fire-and-forget with its rejection
 * swallowed: an analytics beacon that failed is worth nothing at all to the
 * person using the screen.
 *
 * ## It sends BOUNDED values and nothing else
 *
 * There is no `properties` parameter and no way to add one: the input names an
 * event and nothing more. A wallet identity and an email have no field here —
 * and would be refused by the server's allow-list even if one were invented,
 * because `analytics_events` has no column for either.
 *
 * The endpoint answers 202 and the events may be dropped. That is the contract
 * (#77), and it is why nothing here retries: an analytics write that failed
 * once will usually fail again, and a retry turns a transient outage into a
 * growing buffer on somebody's phone.
 */

import apiClient from './api/client';

/**
 * The event types a storefront may assert.
 *
 * A local literal union rather than an import of
 * `ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES`, and deliberately NARROWER than it:
 * that tuple is what the SERVER accepts, which includes the discovery events
 * other surfaces emit. This is what THIS module sends, and keeping it narrow
 * means a typo names a type that does not compile rather than one the server
 * silently counts as rejected.
 */
export type StorefrontAnalyticsEvent = 'guest_claim_offered' | 'guest_claim_declined';

/**
 * Emit one event. Returns immediately, whatever happens.
 *
 * Every dimension that identifies anything — the actor, the pseudonymous
 * session, the traffic class, the market, the surface — is derived by the
 * SERVER from the request. This function cannot set one and does not try, which
 * is what makes "a client cannot forge an identity" a property of the payload
 * rather than of a check on the far side.
 */
export function track(event: StorefrontAnalyticsEvent): void {
  void apiClient.post('/analytics/events', { events: [{ eventType: event }] }).catch(() => {
    // Deliberately silent. The endpoint answers 202 precisely because these
    // events may be dropped, and a console line on every offline beacon
    // would train everybody to ignore the console.
  });
}
