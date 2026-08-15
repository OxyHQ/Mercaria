/**
 * The WooCommerce scenarios of `docs/runbooks/connector-real-store-verification.md`
 * §7, as DATA: the identifier, the runbook's own title, the observable the table
 * names, and what that observable would read if the thing under test were
 * absent.
 *
 * Both of the last two are stated HERE rather than composed at the point of a
 * verdict, for one reason: the counterfactual is the part somebody drops under
 * time pressure, and `EvidenceCollector.record` refuses a `PASSED` without it.
 * Writing it beside the scenario means the honest form is the cheap one.
 *
 * The three unnumbered checks §7 names after the table are `X1`–`X3`. They are
 * not decoration — each is a real defect's regression (#220 and #259), and the
 * runbook says only a real site settles whether a `product.updated` delivery
 * carries `variations` in the id shape the provider reads.
 */

/** One scenario the driver may attempt. */
export interface ScenarioSpec {
  readonly id: string;
  /** The runbook's own wording, so the evidence and the procedure match. */
  readonly title: string;
  /** The observable §7 names. */
  readonly expectedObservable: string;
  /**
   * What the observable would read if the thing under test were ABSENT — the
   * discriminator that makes a count evidence rather than a number.
   */
  readonly wouldReadIfAbsent: string;
  /** What must exist before this scenario can be attempted at all. */
  readonly requires: readonly ScenarioRequirement[];
  /**
   * True when one arm cannot be read on its own and the scenario is reported as
   * two runs under different configuration. W8 is the case: a bare FAILED would
   * say the enumeration is broken when it is the CAP that refused.
   */
  readonly measuredAsPair?: boolean;
}

/** A precondition a scenario cannot be run without. */
export type ScenarioRequirement =
  /** A real WooCommerce site with REST credentials. */
  | 'woo_site'
  /** An Oxy bearer token for a store member with `channels:write`. */
  | 'admin_auth'
  /** Redis, so a sync is queued rather than run inline. */
  | 'redis'
  /** The backend reachable from the public internet, for real deliveries. */
  | 'public_ingress'
  /** A catalogue exceeding one page (> 100 products). */
  | 'large_catalogue'
  /** A read-only REST key, which only the site's operator can mint. */
  | 'readonly_key'
  /** A product carrying more than 100 variations. */
  | 'many_variations'
  /** A site configured to strip `X-WP-TotalPages`. */
  | 'header_stripping'
  /** A change made in the WooCommerce admin by a person. */
  | 'manual_site_edit';

/** §7's table, plus the three checks named after it. */
export const WOOCOMMERCE_SCENARIOS: readonly ScenarioSpec[] = [
  {
    id: 'W1',
    title: 'REST credential connection',
    expectedObservable:
      "connection status `connected`, `shopCurrency` matching the site, exactly ONE connection row",
    wouldReadIfAbsent:
      'no connection row at all, or one with status `error` and a null `shopCurrency` — the ' +
      'credentials are verified against the site on connect, so a wrong key cannot produce a ' +
      '`connected` row',
    requires: ['woo_site', 'admin_auth'],
  },
  {
    id: 'W2',
    title: 'Product, variant and inventory backfill',
    expectedObservable:
      'a `backfill` run reaching `completed`; every variable product imports with EVERY ' +
      "variation; `manage_stock: 'parent'` variations take the parent's stock",
    wouldReadIfAbsent:
      'zero listings and a run whose `created` tally is 0 — and, for the variation half, a ' +
      'variable product collapsed to ONE variant at the parent price with no option values, ' +
      'which is exactly the #220 defect this scenario regresses',
    requires: ['woo_site', 'admin_auth'],
  },
  {
    id: 'W3',
    title: 'Pagination and retry',
    expectedObservable:
      'every product imported across more than one page; whether the host produced a 429 at ' +
      'all, whether it carried `Retry-After`, and its value against the 30s cap (§8.2)',
    wouldReadIfAbsent:
      'a run importing only the first page — the count would equal one `per_page` exactly, ' +
      'which is the signature of an enumeration that stopped at page 1 rather than one that ' +
      'read the whole catalogue',
    requires: ['woo_site', 'admin_auth', 'redis', 'large_catalogue'],
  },
  {
    id: 'W4',
    title: 'Product update and removal',
    expectedObservable:
      "the edit follows into the listing; the trashed product's listing reaches `archived`",
    wouldReadIfAbsent:
      'the listing still carrying the pre-edit title, and the trashed product still `active` — ' +
      'archive-on-removal is what a complete enumeration authorises, so its absence looks ' +
      'identical to a healthy catalogue until a shopper buys a delisted item',
    requires: ['woo_site', 'admin_auth', 'manual_site_edit'],
  },
  {
    id: 'W5',
    title: 'Order import where configured',
    expectedObservable: 'one Mercaria order per Woo order, with a single-currency `DualMoney`',
    wouldReadIfAbsent:
      'zero orders, or more than one Mercaria order for one Woo order — the second is the ' +
      'idempotency failure, and it is invisible in a per-order check',
    requires: ['woo_site', 'admin_auth'],
  },
  {
    id: 'W6',
    title: 'Native currency preservation',
    expectedObservable: "an imported variant priced in the SITE's currency, never FAIR",
    wouldReadIfAbsent:
      "the variant priced in FAIR (the store's default before this run set EUR) or converted " +
      "to the store's own currency — either would mean the catalogue write converted, which " +
      'it must not',
    requires: ['woo_site', 'admin_auth'],
  },
  {
    id: 'W7',
    title: 'Invalid / insufficient permission',
    expectedObservable:
      'the sync still works; `webhookIds` empty AND `webhookFailures` naming every topic with ' +
      "its status and reason; `GET .../channels/readiness` reporting `catalog.state: degraded`",
    wouldReadIfAbsent:
      'an empty `webhookFailures` beside an empty `webhookIds` — which is what the PRE-#218 ' +
      'behaviour produced and reads as a healthy channel, and is the whole reason the refusal ' +
      'list exists',
    requires: ['woo_site', 'admin_auth', 'readonly_key'],
  },
  {
    id: 'W8',
    title: 'A product with MORE THAN 100 variations',
    expectedObservable:
      'every variation imports; the number of `/variations` requests and whether each page ' +
      'carried `X-WP-TotalPages`. A product refused as `declared_not_fetched` means the ' +
      "site's variation id list and the variations endpoint disagree — record BOTH",
    wouldReadIfAbsent:
      'exactly 100 variants imported (one page, silently truncated) with the product reported ' +
      'as a success — which is what an unproven pagination reads as, and is #259',
    // MEASURED AS A PAIR, and the pair is what makes the result readable.
    // `MAX_VARIANTS_PER_PRODUCT` (config/index.ts) defaults to exactly 100 while
    // this scenario asks for MORE than 100, so at default configuration the
    // product is refused WHOLE and the run still reports `completed` — W8 has
    // never been passable as shipped. Re-running with the variable raised to 200
    // imports all 110 variations with `failed=0`, which is what establishes that
    // the cap was MASKING working pagination rather than that the enumeration
    // was broken. Report both arms; do NOT quietly raise the default, because at
    // the default a merchant's product vanishes with the run reporting success.
    measuredAsPair: true,
    requires: ['woo_site', 'admin_auth', 'many_variations'],
  },
  {
    id: 'W9',
    title: 'A site that strips `X-WP-TotalPages`',
    expectedObservable:
      'every product still imports and NOTHING is archived; exactly one extra `/products` ' +
      'request at the end (the empty page that terminates the enumeration)',
    wouldReadIfAbsent:
      'listings past page 1 soft-archived — the #259 catalogue failure, in which a missing ' +
      'header read as "one page" and a full first page proved a complete enumeration',
    requires: ['woo_site', 'admin_auth', 'header_stripping'],
  },
  {
    id: 'X1',
    title:
      'A NEW variable product imported by the `product.created` webhook, with no prior backfill',
    expectedObservable:
      'EVERY variation, each at its own price with its own option values and stock; the ' +
      "webhook run's tallies",
    wouldReadIfAbsent:
      'ONE variant at the parent\'s lowest price with no option values and `available: 0`, ' +
      'beside an option axis declaring several — the #220 collapse verbatim',
    requires: ['woo_site', 'admin_auth', 'public_ingress', 'manual_site_edit'],
  },
  {
    id: 'X2',
    title: 'A variation ADDED on the site, then a re-sync',
    expectedObservable: 'the new variant appears on the existing listing',
    wouldReadIfAbsent:
      'the listing keeping its original variant set — `importProduct` never ADDED variants to ' +
      'an existing listing before #220, which is what made an earlier collapse permanent ' +
      'rather than self-healing',
    requires: ['woo_site', 'admin_auth', 'manual_site_edit'],
  },
  {
    id: 'X3',
    title: 'A variation DELETED on the site, then a re-sync',
    expectedObservable:
      'the variant SURVIVES at zero stock with tracking on, rather than disappearing',
    wouldReadIfAbsent:
      'the variant deleted — which would cascade it out of live carts, saved items and offers, ' +
      'and is precisely what #220 chose not to do',
    requires: ['woo_site', 'admin_auth', 'manual_site_edit'],
  },
];

/** Human-readable explanation of one unmet requirement. */
export const REQUIREMENT_REASONS: Record<ScenarioRequirement, string> = {
  woo_site:
    'no real WooCommerce site is available — the credential file the provisioning agent ' +
    'writes does not exist yet',
  admin_auth:
    'no Oxy bearer token is configured, and `/admin` is gated by real Oxy auth ' +
    '(`createOxyAuthMiddleware`) with no local bypass',
  redis: 'REDIS_URL is not configured, so a sync would run inline rather than being queued',
  public_ingress:
    'the backend is not reachable from the public internet, so the platform cannot deliver a ' +
    'webhook to it',
  large_catalogue: 'the site does not hold more than one page of products (> 100)',
  readonly_key:
    'no READ-ONLY WooCommerce REST key is available; only the site operator can mint one',
  many_variations: 'the site holds no product with more than 100 variations',
  header_stripping:
    'the site is not behind a plugin that strips `X-WP-TotalPages`, and configuring one is a ' +
    'change to the site rather than to Mercaria',
  manual_site_edit:
    'the scenario needs a change made by a person in the WooCommerce admin during the run',
};
