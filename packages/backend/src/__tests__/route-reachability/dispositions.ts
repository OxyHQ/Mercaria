/**
 * What is to be done about every route no user can reach.
 *
 * The gate is `route-reachability.test.ts`; this is the hand-maintained half it
 * checks the measurement against. A route that is neither REACHABLE nor named
 * here FAILS THE BUILD — `~/Oxy/AGENTS.md`: a gate that skips what is missing
 * from a hand-maintained map is not a gate. `merge-plan-census.test.ts` is the
 * worked precedent in this repository: it accepts `untouched` WITH A REASON as
 * a decision, and refuses silence.
 *
 * ## Two kinds, and they are not interchangeable
 *
 * `deliberate` — unreachable BY DESIGN and permanently. Nothing is owed. The
 * only member today is a bank-authentication return whose URL the server
 * composes, which is exactly the class in-app navigation cannot and must not
 * cover.
 *
 * `awaiting_product_decision` — a real gap, acknowledged, with the specific
 * question written down and where it is recorded. This is NOT a quieter
 * `deliberate`, and collapsing the two is the failure this file exists to
 * prevent: a shipped feature nobody can reach would then be indistinguishable
 * from a return URL, which is how #97's and #147's screens sat unreachable
 * through every green build until #363 went looking. The payment domain's
 * `deferred: #NN` marker is the same device for the same reason — marking a
 * seam `processed` makes it indistinguishable from real handling.
 *
 * ## Both lists shrink, and the gate enforces it
 *
 * An entry naming a route that has SINCE BEEN WIRED fails the build, so wiring
 * a screen forces its entry out rather than leaving a stale excuse behind. An
 * entry naming a route that no longer exists fails too. And the total is
 * asserted EXACTLY rather than as a ceiling — `~/Oxy/AGENTS.md`: a list of
 * exemptions needs its own exact-count assertion, because an ever-growing one
 * is the gate switching itself off one defensible line at a time.
 *
 * Adding an entry here is therefore a visible decision in a diff, which is the
 * whole point. Wiring the screen is usually the cheaper answer.
 */

/** Why a route nobody can reach is allowed to stay that way. */
export type RouteDisposition =
  | {
      readonly kind: 'deliberate';
      /** Why in-app navigation must not reach it. */
      readonly reason: string;
    }
  | {
      readonly kind: 'awaiting_product_decision';
      /** The decision that is actually owed, phrased as the question. */
      readonly question: string;
      /** Where that question is recorded, so this is not the only record. */
      readonly recordedIn: string;
    };

/**
 * Every unreachable route, by app.
 *
 * Keyed by the URL pattern expo-router serves, `[param]` segments intact — the
 * same string the census reports, so an entry cannot silently fail to match the
 * route it is excusing.
 */
export const ROUTE_DISPOSITIONS: Readonly<
  Record<string, Readonly<Record<string, RouteDisposition>>>
> = {
  frontend: {
    '/checkout/return': {
      kind: 'deliberate',
      reason:
        'The bank-authentication return. The server composes this URL from ' +
        'STRIPE_CHECKOUT_RETURN_URL and hands it to Stripe, which sends the buyer back to it ' +
        'with ?checkoutGroupId=... after 3-D Secure; the storefront never navigates here and ' +
        'must not, because arriving without the provider round trip is not a state this screen ' +
        'can serve. An inbound in-app edge would be the defect, not the fix.',
    },
    '/sell': {
      kind: 'awaiting_product_decision',
      question:
        'Where does selling enter the storefront? The #91 draft flow shipped whole and its ' +
        'entry point is unowned: components/sell/SellYoursButton.tsx exists and is imported by ' +
        'NOTHING, and #71 records the product-page "Sell yours" control as deliberately absent ' +
        'pending #41. The top-level entries (scan, search, "something unique") need no product ' +
        'and belong to nobody. A "Sell" nav item changes the primary navigation model for every ' +
        'user, which is a product call rather than a wiring fix.',
      recordedIn: '#366 (this gate); the flow itself is #91, the product-page control #41',
    },
    '/sell/[draftId]': {
      kind: 'awaiting_product_decision',
      question:
        'Reachable the moment /sell is: the draft list links to it. It is listed separately ' +
        'rather than folded into /sell because the gate scores routes, not flows, and a ' +
        'disposition covering a route it does not name would be exactly the silence this map ' +
        'refuses.',
      recordedIn: '#366 (this gate); the flow itself is #91',
    },
    '/notifications': {
      kind: 'awaiting_product_decision',
      question:
        'Should the shell have a bell? No bell, badge or notification affordance exists ' +
        'anywhere in the storefront, and lib/hooks/use-notification-setup.ts deliberately ' +
        'navigates nowhere from a push payload, with its reasoning recorded at the call site. ' +
        'Adding one to AppShell is new product surface in the primary chrome.',
      recordedIn: '#366 (this gate)',
    },
    '/compare': {
      kind: 'awaiting_product_decision',
      question:
        'Should /watchlists/[watchlistId] offer "Compare this list"? The screen accepts ' +
        '?watchlist=<id>, which strongly implies that entry, and /watchlists/[watchlistId] is ' +
        'reachable — so this is a one-line edge. But the control carries an objective and ' +
        'channel-policy picker, and #42\'s multi-store optimization is still deferred, so ' +
        'whether the surface is meant to be live is a rollout question rather than a nav bug.',
      recordedIn: '#42 (open epic); measured in #366',
    },
  },
  dashboard: {},
  pos: {},
};
