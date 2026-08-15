/**
 * The Shopify default scope set, and the derivation it has to satisfy (#218).
 *
 * ## What this gate catches, and why a comment could not
 *
 * `SHOPIFY_SCOPES` defaulted to `['read_products']` while `registerWebhooks`
 * subscribed order and inventory topics unconditionally. Shopify gates
 * `POST /webhooks.json` on the READ scope of the topic being subscribed, so the
 * DEFAULT deployment registered three product topics and was refused the other
 * three — which is #218's partial registration, arrived at by configuration
 * rather than by anything going wrong. Nothing failed a build, nothing failed a
 * test, and a merchant saw a connected channel.
 *
 * So the two halves are pinned against each other: the topics the connector
 * registers and the endpoints its declared capabilities call, against the scope
 * set a deployment gets when it configures none. `WEBHOOK_TOPIC_SCOPES` lives in
 * the provider, beside the topics, so adding a topic without deciding its scope
 * is already a `tsc` failure — this file is what fails when the scope is decided
 * and the DEFAULT is not widened to include it.
 *
 * ## The endpoint table is the runbook's, not a re-derivation
 *
 * `docs/runbooks/connector-real-store-verification.md` §3.1 tabulates every
 * endpoint the connector calls against the scope Shopify requires for it, and
 * §3.2 is the string that follows. Restating the mapping from memory here would
 * make this a second description of a fact somebody already established against
 * Shopify's own documentation — so what is encoded below is that table, keyed on
 * the SCOPE, carrying the capability that reaches it so a capability the
 * provider stops declaring stops demanding its scopes.
 *
 * ## What that table could NOT check, until #288
 *
 * The last case asks "is every requested scope justified?" and used to answer it
 * out of the table above it. For a row somebody wrote, that is the gate's input
 * and its expectation being one decision written twice: ask what it would report
 * if `read_locations` were genuinely unnecessary, and the answer is the same
 * PASS. It measured nothing for that row.
 *
 * The fix is not a better list — it is separating the half this repository can
 * derive from the half it cannot. Whether the connector CALLS an endpoint is
 * read off the provider source, independently of every scope value here; whether
 * Shopify REQUIRES a scope for it is an external fact, so each row records where
 * that claim came from and a row nobody has confirmed says so as data. The
 * unconfirmed set is then pinned EXACTLY, because a list of admissions that only
 * grows is the gate switching itself off one defensible line at a time.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHOPIFY_DEFAULT_SCOPES } from '../config.js';
import { shopifyProvider, SHOPIFY_WEBHOOK_TOPICS, WEBHOOK_TOPIC_SCOPES } from '../index.js';

/** Which capability has to be DECLARED before a row's scopes are required. */
type ScopeCapability = 'always' | 'pushesProducts' | 'pushesFulfillment';

/**
 * Where a row's claim that Shopify requires this scope actually comes from.
 *
 * A string discriminant: this package compiles with `strict: false`, so a
 * boolean-literal one does not narrow (the #68 finding).
 */
type ScopeProvenance =
  | { readonly kind: 'documented'; readonly source: string; readonly checked: string }
  | { readonly kind: 'unconfirmed'; readonly why: string; readonly settledBy: string };

/** One requested scope, the endpoints that reach it, and where the claim came from. */
interface ScopeJustification {
  readonly scope: string;
  /**
   * Literal path fragments as they appear in the PROVIDER SOURCE, so the claim
   * "something calls this" is checkable rather than asserted. Each carries its
   * leading slash: `orders.json` is a substring of `fulfillment_orders.json`,
   * and `/orders.json` is not.
   */
  readonly endpoints: readonly string[];
  readonly capability: ScopeCapability;
  readonly provenance: ScopeProvenance;
}

/**
 * Runbook §3.1, as data — one row per REQUESTED SCOPE (#288).
 *
 * ## Why this is not the shape it was
 *
 * It used to be a map from capability to a scope list, and the last case in this
 * file asked "is every default scope justified?" against that same map. For
 * `read_locations` those were one decision written twice: the scope is in the
 * default because somebody believed Shopify needs it, and it passed the gate
 * because the same person wrote it into the table. Ask what the check would
 * report if `read_locations` were genuinely unnecessary — the same PASS. It
 * measured nothing for that row.
 *
 * Two things are separable here, and conflating them is what made it vacuous:
 *
 *  - **Does the connector CALL this endpoint?** Derivable from the provider
 *    source, and independent of every scope value below. `every cited endpoint
 *    is reachable in the provider` is that check.
 *  - **Does Shopify require this scope for it?** An external fact this
 *    repository cannot derive at all. So each row RECORDS where the claim came
 *    from, and a row nobody has confirmed says so in the data rather than
 *    looking like the ones that were.
 *
 * `read_locations` is the row that is not derived, and it is the one #288 is
 * about: the connector calls no location endpoint (asserted below as the
 * scanner's negative control), and Shopify's InventoryLevel reference names the
 * inventory scope alone. That is not enough to REMOVE it — a scope needed and
 * not requested fails at the first inventory sync, and only a real store settles
 * it — so it stays, marked, with the experiment that would settle it written
 * down beside it.
 */
const SCOPE_JUSTIFICATIONS: readonly ScopeJustification[] = [
  {
    scope: 'read_products',
    endpoints: ['/products.json', '/collects.json', '/smart_collections.json'],
    capability: 'always',
    provenance: {
      kind: 'documented',
      source: 'https://shopify.dev/docs/api/admin-rest/latest/resources/product',
      checked: '2026-08-15',
    },
  },
  {
    scope: 'read_orders',
    endpoints: ['/orders.json'],
    capability: 'always',
    provenance: {
      kind: 'documented',
      source: 'https://shopify.dev/docs/api/admin-rest/latest/resources/order',
      checked: '2026-08-15',
    },
  },
  {
    scope: 'read_inventory',
    endpoints: ['/inventory_levels.json'],
    capability: 'always',
    provenance: {
      kind: 'documented',
      source: 'https://shopify.dev/docs/api/admin-rest/latest/resources/inventorylevel',
      checked: '2026-08-15',
    },
  },
  {
    // NO endpoint, and that emptiness IS the finding rather than an omission:
    // there is no call in this connector whose scope requirement could justify
    // it. `inventory_levels.json` rows carry `location_id` inline and the
    // connector sums across them; `locations.json` is never fetched.
    scope: 'read_locations',
    endpoints: [],
    capability: 'always',
    provenance: {
      kind: 'unconfirmed',
      why:
        "Shopify's InventoryLevel reference names the inventory access scope alone " +
        '(checked 2026-08-15) and this connector fetches no location endpoint, so ' +
        'nothing here establishes that the location join needs its own grant. The ' +
        'runbook §3.1 has hedged it as "confirm in the Partner scope picker" since ' +
        'it was written, which is a question nobody has answered.',
      settledBy:
        'Connect a real store with SHOPIFY_SCOPES set to the §3.2 string MINUS ' +
        'read_locations, then run an inventory pull. The granted scopes[] and the ' +
        'run outcome answer it: a completed pull means it was never needed and this ' +
        'row goes; a 403 means it was, and this becomes a documented row citing the ' +
        'response. Blocked on the Partner account #69 acceptance 7 is blocked on.',
    },
  },
  {
    scope: 'write_products',
    endpoints: ['/products.json'],
    capability: 'pushesProducts',
    provenance: {
      kind: 'documented',
      source: 'https://shopify.dev/docs/api/admin-rest/latest/resources/product',
      checked: '2026-08-15',
    },
  },
  {
    scope: 'read_merchant_managed_fulfillment_orders',
    endpoints: ['/fulfillment_orders.json'],
    capability: 'pushesFulfillment',
    provenance: {
      kind: 'documented',
      source: 'https://shopify.dev/docs/api/admin-rest/latest/resources/fulfillmentorder',
      checked: '2026-08-15',
    },
  },
  {
    scope: 'write_merchant_managed_fulfillment_orders',
    endpoints: ['/fulfillments.json'],
    capability: 'pushesFulfillment',
    provenance: {
      kind: 'documented',
      source: 'https://shopify.dev/docs/api/admin-rest/latest/resources/fulfillment',
      checked: '2026-08-15',
    },
  },
];

/** The scopes whose requirement nobody has established against a real store. */
const UNCONFIRMED_SCOPES = SCOPE_JUSTIFICATIONS.filter(
  (row) => row.provenance.kind === 'unconfirmed',
).map((row) => row.scope);

/** Is this row's capability declared by the shipped provider? */
function capabilityDeclared(capability: ScopeCapability): boolean {
  if (capability === 'always') return true;
  return shopifyProvider.capabilities[capability] === true;
}

/**
 * The provider source with comments and doc-blocks REMOVED.
 *
 * Load-bearing rather than tidy: `index.ts` documents the endpoints it calls in
 * prose — `GET /orders.json`, the 60-day note on `fetchOrders` — so a scan over
 * raw source would find every path in a COMMENT and report that a call exists
 * when none does. That is the census-over-comments failure, and here it would
 * make the one independent anchor in this file vacuous.
 */
const PROVIDER_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'),
  'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1 ');

describe('the Shopify default scopes cover what the connector actually calls', () => {
  it('names a scope for EVERY topic it registers', () => {
    // The vacuity floor: an empty topic list would satisfy every assertion below
    // by having nothing to check, and a topic map that lost its keys would too.
    expect(SHOPIFY_WEBHOOK_TOPICS.length).toBeGreaterThanOrEqual(6);
    for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
      expect(WEBHOOK_TOPIC_SCOPES[topic], `${topic} has no scope`).toBeTruthy();
    }
    expect(Object.keys(WEBHOOK_TOPIC_SCOPES).sort()).toEqual([...SHOPIFY_WEBHOOK_TOPICS].sort());
  });

  it('DEFAULTS to a scope set covering every registered topic', () => {
    // The exact failure #218 lands in: `read_products` alone, three topics
    // refused, three subscriptions created and their ids discarded.
    for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
      expect(
        SHOPIFY_DEFAULT_SCOPES,
        `the default scope set cannot subscribe ${topic}`,
      ).toContain(WEBHOOK_TOPIC_SCOPES[topic]);
    }
  });

  it('DEFAULTS to a scope set covering every endpoint a DECLARED capability calls', () => {
    // The premise, asserted rather than assumed: with both capabilities false
    // this case would be checking three scopes and still passing.
    expect(shopifyProvider.capabilities.pushesProducts).toBe(true);
    expect(shopifyProvider.capabilities.pushesFulfillment).toBe(true);
    for (const row of SCOPE_JUSTIFICATIONS) {
      if (!capabilityDeclared(row.capability)) continue;
      expect(SHOPIFY_DEFAULT_SCOPES, `the default scope set omits ${row.scope}`).toContain(
        row.scope,
      );
    }
  });

  it('cites, for every DOCUMENTED scope, an endpoint the provider really calls', () => {
    // The independent anchor, and the answer to #288's circularity. Everything
    // else in this file compares one hand-written list against another; this
    // reads the PROVIDER and asks whether the endpoint a scope is justified by
    // exists at all. A scope defended by a call nobody makes fails here, which
    // is a failure the justification table cannot talk its way out of.
    //
    // What it deliberately does NOT check is the scope MAPPING — whether Shopify
    // requires `read_products` for `/products.json` is an external fact, and
    // `provenance` records where each claim came from instead of pretending to
    // derive it. The check is also method-blind (a literal path, not GET vs
    // POST), so it establishes reachability and not the verb.
    //
    // The vacuity floor: a moved or emptied `index.ts`, or a comment-stripper
    // that ate the file, would otherwise make every `toContain` below vacuous.
    expect(PROVIDER_SOURCE.length, 'index.ts looks empty — did it move?').toBeGreaterThan(20_000);
    expect(PROVIDER_SOURCE, 'the stripper ate real code').toContain('async fetchOrders');
    // ...and it really stripped: this phrase exists ONLY in the API_VERSION
    // doc-block. Without it every endpoint below could be satisfied by prose,
    // since `index.ts` names its own endpoints in comments.
    expect(PROVIDER_SOURCE, 'comments were NOT stripped').not.toContain('falls forward');

    // The NEGATIVE control, which is also the finding: no location endpoint is
    // called anywhere, in code OR in a comment the stripper removed. If this
    // ever starts matching, `read_locations` has a real justification and its
    // row should become a documented one.
    expect(PROVIDER_SOURCE, 'a location endpoint IS called now').not.toContain('/locations.json');

    let cited = 0;
    for (const row of SCOPE_JUSTIFICATIONS) {
      if (row.provenance.kind !== 'documented') continue;
      expect(
        row.endpoints.length,
        `${row.scope} is documented but cites no endpoint, so nothing checks it`,
      ).toBeGreaterThan(0);
      for (const endpoint of row.endpoints) {
        cited += 1;
        expect(
          PROVIDER_SOURCE,
          `${row.scope} is justified by ${endpoint}, which the provider never calls`,
        ).toContain(endpoint);
      }
    }
    // A second floor, on the loop's own output: an emptied table would satisfy
    // every assertion above by iterating over nothing.
    expect(cited, 'no endpoint was checked at all').toBeGreaterThanOrEqual(7);
  });

  it('names EXACTLY the scopes nobody has confirmed, so the list cannot grow quietly', () => {
    // An unconfirmed row is an admission, and a list of admissions that only
    // ever grows is the gate switching itself off one defensible line at a
    // time. Exact rather than a floor: adding a second unverified scope has to
    // be a visible decision, and REMOVING this one (because a real store
    // settled it) has to be visible too.
    expect(UNCONFIRMED_SCOPES).toEqual(['read_locations']);

    // An unconfirmed row owes the next reader the experiment, not just the
    // doubt — otherwise it is a shrug with a type annotation.
    for (const row of SCOPE_JUSTIFICATIONS) {
      if (row.provenance.kind !== 'unconfirmed') continue;
      expect(row.provenance.settledBy.length, `${row.scope} says how to settle it`).toBeGreaterThan(
        80,
      );
    }
  });

  it('never requests read_all_orders, whatever the justification table says (#287)', () => {
    // The case below already refuses a scope nothing calls, so this looks
    // redundant — it is not, and the difference is the failure it survives.
    // Somebody who decides the connector "needs" full order history fixes that
    // case by adding a `read_all_orders` row to SCOPE_JUSTIFICATIONS, which is
    // the natural move and makes the generic gate go green. This one still
    // fails, because the objection is not "nothing calls it".
    //
    // Shopify grants `read_all_orders` only on written approval for a specific
    // app and refuses the WHOLE grant rather than narrowing it when an
    // unapproved scope is requested — so this in the DEFAULT breaks every
    // connect on every deployment, and the symptom is a connector that cannot
    // connect rather than anything naming a scope. It is an operator decision
    // per approved app (`SHOPIFY_SCOPES` set explicitly there), never a default.
    //
    // The cost of its absence is real and is documented rather than fixed here:
    // `GET /orders.json` reaches back 60 days only, and a truncated import is
    // indistinguishable from a complete one (`index.ts` `fetchOrders`).
    expect(SHOPIFY_DEFAULT_SCOPES).not.toContain('read_all_orders');
  });

  it('requests NOTHING it cannot point at an endpoint or a topic', () => {
    // The other direction, and the one that keeps this honest: a default asking
    // for `write_orders` or `read_customers` is a merchant granting Mercaria
    // powers no shipped code uses, on a consent screen they read once.
    //
    // On its own this case cannot fail for a scope somebody wrote a row for —
    // that is #288, and it is why the two cases above exist: one checks the
    // cited endpoint against the PROVIDER, the other pins the set of rows whose
    // claim rests on nothing. What remains here is the narrower question of a
    // scope with no row at all.
    const justified = new Set<string>([
      ...Object.values(WEBHOOK_TOPIC_SCOPES),
      ...SCOPE_JUSTIFICATIONS.map((row) => row.scope),
    ]);
    for (const scope of SHOPIFY_DEFAULT_SCOPES) {
      expect(justified, `${scope} is requested by default and nothing calls it`).toContain(scope);
    }
  });
});
