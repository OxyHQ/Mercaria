/**
 * Connector platform — the provider contract.
 *
 * A `ConnectorProvider` is ONE external commerce platform (Shopify first;
 * WooCommerce / Etsy / … follow as additional implementations behind this same
 * interface). The registry (`registry.ts`) resolves an id to its provider and
 * the sync service (`services/connector-sync.service.ts`) drives the provider
 * without knowing which platform it is talking to.
 *
 * A provider is responsible ONLY for talking to its platform and mapping the
 * platform's product shape into the platform-neutral `NormalizedProduct`. It
 * never touches Mercaria models — the sync service owns the write path (through
 * the `catalog-write.service` funnels) and all provenance/override bookkeeping.
 */

import type {
  AddressSnapshot,
  ChannelOrderHorizon,
  ConnectorProviderId,
  ConnectorWebhookFailureReason,
  CurrencyCode,
  DualMoney,
  ExternalCollection,
  ExternalTaxonomyNoun,
  FxRateSnapshot,
  Money,
  OrderStatus,
  PaymentInfo,
} from '@mercaria/shared-types';

/**
 * Credential material a provider presents to authenticate against the external
 * platform. `accessToken` is the decrypted OAuth token (or API key); `shopDomain`
 * is the external shop host (`acme.myshopify.com`). This is the shape the sync
 * service reconstructs from a stored `Connection` (decrypting the token) for the
 * VERIFY / EXCHANGE steps, before the shop currency is known.
 */
export interface ConnectorAuth {
  /** The platform access token (OAuth) or API key — already decrypted. */
  accessToken: string;
  /** External shop host, e.g. `acme.myshopify.com`. */
  shopDomain: string;
}

/**
 * Full credentials for the DATA path (`fetchProducts`). Extends {@link ConnectorAuth}
 * with the shop's resolved Mercaria `CurrencyCode` so the provider can stamp
 * every pulled price in the shop's native currency (Mercaria stores native — no
 * FAIR conversion on the write side).
 */
export interface ConnectorCredentials extends ConnectorAuth {
  /** The shop's own accounting currency, validated to a supported `CurrencyCode`. */
  shopCurrency: CurrencyCode;
}

/**
 * The canonical, provider-neutral classification of an inbound webhook. Each
 * platform speaks its OWN topic vocabulary (Shopify `products/update`, WooCommerce
 * `product.updated`, …); the dispatcher (`connector-sync.service`) maps a raw topic
 * to one of these kinds and routes it to the right — provider-agnostic — handler.
 */
export type WebhookEventKind =
  /** Create OR update a single product (upsert, respecting `overriddenFields`). */
  | 'product_upsert'
  /** Delete a single product (soft-archive the mapped listing, never hard-delete). */
  | 'product_delete'
  /** Create OR update a single order (idempotent upsert by `{connection, externalId}`). */
  | 'order_upsert'
  /** A stock-level change for a single inventory item (re-fetch + absolute set). */
  | 'inventory_update';

/**
 * What a platform says about a subscription's own health (#295).
 *
 * WooCommerce publishes exactly these three and DISABLES a subscription itself
 * once it has counted more than five failed deliveries
 * (`includes/class-wc-webhook.php`, `failed_delivery()`). That is the state
 * a delivery-address change leaves behind, and it stays that way after the
 * address is fixed — so it is a fact Mercaria has to be able to read.
 */
export type WebhookSubscriptionStatus = 'active' | 'paused' | 'disabled';

/**
 * One webhook subscription as the PLATFORM currently holds it.
 *
 * `deliveryUrl` is the whole point: it is what tells a subscription Mercaria's
 * endpoint owns apart from one somebody else's integration created on the same
 * shop, and reconciliation may only ever touch the former.
 */
export interface PlatformWebhookSubscription {
  /** The platform's own subscription id. */
  readonly id: string;
  /** The platform's own topic string (`products/update`, `product.updated`). */
  readonly topic: string;
  /** Where the platform delivers it. */
  readonly deliveryUrl: string;
  /**
   * The platform's own view of whether it is still delivering — ABSENT when the
   * platform publishes none (Shopify's REST webhook object has no such field).
   *
   * Absent means "this platform does not say", never "disabled": reading silence
   * as unhealthy would make every Shopify connection look broken and put every
   * one of them through a delete-and-recreate on a schedule. The direction is
   * deliberate and it is the safe-failing one — an unreadable status delays a
   * repair and can never cause a fleet-wide re-registration.
   */
  readonly status?: WebhookSubscriptionStatus;
  /**
   * Consecutive delivery failures the platform has counted, when it publishes
   * one.
   *
   * EVIDENCE, never a trigger. It is the only thing that says deliveries are
   * failing RIGHT NOW, before the platform gives up — but re-registering does
   * not fix whatever is refusing the deliveries, and a delete-and-recreate every
   * six hours over a transient blip would churn a merchant's subscriptions and,
   * on a `per_connection` platform, their secret with them. So it is reported
   * beside the verdict and decides nothing.
   */
  readonly failureCount?: number;
}

/**
 * One subscription that is LIVE at this connector's delivery URL when a
 * registration finishes — whatever created it.
 *
 * `origin` is a STRING discriminant and it is not decoration: the caller mints a
 * fresh `per_connection` secret before the attempt and may only store it once
 * something was created WITH it. Reading "there are subscriptions" as "we
 * created one" would replace the envelope that verifies whatever survived from
 * an earlier registration with one that verifies nothing.
 */
export interface RegisteredWebhook {
  readonly id: string;
  readonly topic: string;
  /**
   * `created` — this attempt created it, signed with this attempt's secret.
   * `retained` — it was already live at our delivery URL and is still there: an
   * adopted subscription, an undeleted duplicate, or one a refused DELETE left
   * behind. Mercaria must hold its id either way, because that id is the only
   * thing a later reconcile or a disconnect can delete it by.
   */
  readonly origin: 'created' | 'retained';
}

/** One topic the platform would not subscribe, and why. */
export interface WebhookRegistrationFailure {
  readonly topic: string;
  readonly reason: ConnectorWebhookFailureReason;
  /** The status the platform answered; absent when the call never reached it. */
  readonly httpStatus?: number;
}

/**
 * A registration that READ the platform's subscription list and reconciled it.
 *
 * The two lists are not complementary views of one fact: a partial registration
 * has entries in each, and reporting only the successes is how #218's ids got
 * discarded while reporting only the failures would lose the subscriptions that
 * DO exist.
 *
 * `subscriptions` is the COMPLETE set of subscriptions live at this connector's
 * delivery URL when the attempt finished — created here, adopted, or left behind
 * by a delete the platform refused. That is exactly what disconnect must be able
 * to delete and what the next reconcile must be able to converge, so an id is
 * omitted from it only when the subscription is provably gone.
 *
 * `failures` is what a merchant surface renders as "these events will not
 * arrive".
 */
export interface WebhookReconciliation {
  readonly outcome: 'reconciled';
  readonly subscriptions: readonly RegisteredWebhook[];
  readonly failures: readonly WebhookRegistrationFailure[];
}

/**
 * A registration that could not READ the platform's subscription list, and
 * therefore knows NOTHING about what is live.
 *
 * It carries no subscription list AT ALL, which is the point: an empty array is
 * a claim ("there are none") and this branch has no claim to make. Nothing was
 * created and nothing was deleted, so whatever the caller already holds is still
 * the best description of the shop — and #218's first consequence was exactly
 * this state being written down as "no subscriptions", after which disconnect
 * deleted nothing and the orphans delivered forever.
 *
 * `failures` still names EVERY desired topic under the listing's own reason,
 * because none of those events will arrive.
 */
export interface WebhookReconciliationUnknown {
  readonly outcome: 'unknown';
  readonly reason: ConnectorWebhookFailureReason;
  /** The status the platform answered; absent when the call never reached it. */
  readonly httpStatus?: number;
  readonly failures: readonly WebhookRegistrationFailure[];
}

/**
 * What a registration attempt left behind.
 *
 * A STRING discriminant, not a nullable list: this backend compiles with
 * `strict: false`, so a caller holding the union would read `subscriptions` off
 * the unknown branch and get `undefined` — which `?? []` then turns into the
 * empty array this union exists to make unwritable.
 */
export type WebhookRegistrationResult = WebhookReconciliation | WebhookReconciliationUnknown;

/** The external shop's identity, as reported by the platform. */
export interface ShopIdentity {
  /** The platform's own shop id. */
  externalShopId: string;
  /** The canonical external shop host (`acme.myshopify.com`). */
  shopDomain: string;
  /**
   * The shop's currency as reported by the platform (raw ISO-4217 string). It may
   * be OUTSIDE Mercaria's supported `CurrencyCode` set — the sync service is the
   * one place that validates/maps it before any product is priced.
   */
  shopCurrency: string;
}

/** The result of exchanging an OAuth authorization code for an access token. */
export interface ExchangeResult extends ShopIdentity {
  /** The granted access token to persist (encrypted). */
  accessToken: string;
  /** The scopes the platform actually granted. */
  scopes: string[];
}

/** A single normalized variant, priced in the shop's native currency. */
export interface NormalizedVariant {
  /** Option-value assignments defining the variant (e.g. `[{Size, M}]`). */
  optionValues: { name: string; value: string }[];
  /** Selling price in the shop's native currency (integer minor units). */
  price: Money;
  /** Optional "compare at" (was) price, same currency. */
  compareAtPrice?: Money;
  /** Stock-keeping unit, when the platform provides one. */
  sku?: string;
  /** Barcode (UPC/EAN/ISBN, …), when provided. */
  barcode?: string;
  /** The platform's own variant id, when provided (stored as variant provenance). */
  externalVariantId?: string;
  /**
   * The platform's inventory-item id, when provided — the key of an inventory-level
   * update. Persisted on the Mercaria variant so the inventory sync (pull job +
   * `inventory_levels/update` webhook) maps a platform item id back to the variant.
   */
  externalInventoryItemId?: string;
  /** Inventory snapshot for this variant. */
  inventory: {
    /** Whether the platform tracks stock for this variant. */
    tracked: boolean;
    /** Units available (never negative). */
    available: number;
  };
}

/**
 * Why a variant enumeration could NOT be proven complete (#259).
 *
 * Each member is a distinct piece of evidence a provider gathered, and the
 * distinctions are the point: "the platform named three variations and handed us
 * two" and "we read a full page and the site published no page count" lead an
 * operator to opposite conclusions, and collapsing them into one "incomplete"
 * makes the refusal unreadable in the sync run that records it.
 */
export type VariantEnumerationGap =
  /** The payload named these variation ids and the read did not carry them. */
  | { readonly kind: 'declared_not_fetched'; readonly missingIds: readonly string[] }
  /** The read carried these variation ids and the payload never named them. */
  | { readonly kind: 'fetched_not_declared'; readonly unexpectedIds: readonly string[] }
  /** The read carried these variation ids more than once. */
  | { readonly kind: 'duplicate_fetched'; readonly duplicateIds: readonly string[] }
  /** Nothing proved the paged read reached the end (see the WooCommerce header rule). */
  | { readonly kind: 'pagination_unprovable'; readonly pagesRead: number }
  /** The product has a variation axis and the read carried no usable variation. */
  | { readonly kind: 'declares_variants_and_carries_none'; readonly declared: number };

/**
 * A product's variants, together with what the provider could PROVE about them.
 *
 * The `incomplete` branch carries NO `variants` property, so a consumer cannot
 * read an unproven enumeration as a variant list without writing the coercion
 * out loud — and there is no coercion to write, because there is no array to
 * reach for. That is what turns issue #259's rules 3, 4 and 11 into `tsc`
 * errors: `convergeVariants` cannot reach its removal loop and the create path
 * cannot build a `CreateStoreProductInput` without narrowing to `complete`
 * first, and narrowing is exactly the decision each of them was getting wrong.
 *
 * The discriminant is a STRING rather than a boolean deliberately: this backend
 * compiles with `strict: false`, and without `strictNullChecks` TypeScript does
 * not narrow a union on the truthiness of a boolean-literal discriminant.
 */
export type VariantSet =
  | { readonly enumeration: 'complete'; readonly variants: NormalizedVariant[] }
  | { readonly enumeration: 'incomplete'; readonly gap: VariantEnumerationGap };

/**
 * A platform-neutral product, the shape the sync service maps into
 * `CreateStoreProductInput`. `externalId` + `externalUpdatedAt` carry the
 * provenance used for upsert-by-external-key and newer-than checks.
 *
 * Images are ABSOLUTE platform CDN URLs — Mercaria's media chokepoint
 * (`resolveMedia`) passes absolute http(s) URLs through unchanged, so they are
 * stored as image "file ids" verbatim (no re-upload).
 */
export interface NormalizedProduct {
  /** The product's id on the external platform (upsert key with the connection). */
  externalId: string;
  /** The platform's `updated_at` for the product, when available. */
  externalUpdatedAt?: Date;
  /** Product title. */
  title: string;
  /** Product description (may contain HTML from the source platform). */
  description: string;
  /** URL-safe handle, when the platform provides one. */
  handle?: string;
  /** Manufacturer / brand. */
  vendor?: string;
  /** Merchandising product type. */
  productType?: string;
  /** Selectable options and their values (empty for single-variant products). */
  options: { name: string; values: string[] }[];
  /** Absolute image URLs (platform CDN), in gallery order. */
  imageUrls: string[];
  /**
   * The external collection ids this product belongs to on the platform. The sync
   * service maps these through the connection's `collectionMapping` onto Mercaria
   * `collectionIds`. Shopify's REST `products.json` omits membership, so the Shopify
   * provider fills this during `fetchProducts` from a per-run collection index
   * (custom collections via `collects.json`, smart collections via their product
   * lists); a webhook-driven single-product update carries no collection context and
   * leaves it empty until the next backfill. Empty → the mapping is a no-op.
   */
  collectionRefs?: string[];
  /**
   * Whether the platform still PUBLISHES this product, when the platform says
   * (#377). Absent means this provider does not report a publish state at all —
   * which is NOT the same as `'published'`, and must never be read as either
   * verdict.
   *
   * It exists because a publish state is the one product fact a provider can
   * only tell Mercaria about through a WEBHOOK. A pull filters server-side
   * (WooCommerce asks for `status=publish`), so an unpublished product simply
   * stops appearing and the backfill's delete-reconciliation archives it as
   * unseen. A webhook has no such filter: the platform delivers the edit that
   * unpublished the product, and without this the normalizer dropped the only
   * field saying so — leaving the listing on sale until the next full backfill,
   * with every later edit webhook writing to it.
   *
   * The three states are deliberately distinct rather than a boolean. A provider
   * that reports nothing (Shopify, whose product schema parses no status) must
   * not have its silence read as "unpublished", which would archive a catalogue,
   * nor be given a `true` default that a provider which DOES report could later
   * inherit by forgetting to set it.
   */
  publishState?: 'published' | 'unpublished';
  /**
   * The product's variants AND what the provider could prove about them (#259).
   *
   * A plain `NormalizedVariant[]` said "these are the variants" whether the
   * provider had enumerated them or merely read whatever one truncated response
   * carried — and `convergeVariants` then unsold every local variant the short
   * read failed to mention. The union makes "we could not prove this" a value
   * the write path has to handle rather than a fact nobody recorded.
   */
  variants: VariantSet;
  /** SEO overrides, when the platform exposes them. */
  seo?: { title?: string; description?: string };
}

/**
 * A platform-neutral inventory level: the total units available for one external
 * inventory item, SUMMED across every platform location (a single Mercaria target
 * location mirrors the shop-wide sellable total). `externalInventoryItemId` is the
 * key the sync service maps back to a Mercaria variant (via the variant's stored
 * `source.externalInventoryItemId`).
 */
export interface NormalizedInventoryLevel {
  /** The platform's inventory-item id (maps to a connector-sourced variant). */
  externalInventoryItemId: string;
  /** Total units available across the platform's locations (never negative). */
  available: number;
}

// --- PUSH (Mercaria → platform) ---------------------------------------------

/** One variant of a product being PUSHED out to an external platform. */
export interface PushVariant {
  /** Option-value assignments defining the variant (empty for single-variant). */
  optionValues: { name: string; value: string }[];
  /** Selling price in the listing's native currency (integer minor units). */
  price: Money;
  /** Optional "compare at" (was) price, same currency. */
  compareAtPrice?: Money;
  /** Stock-keeping unit, when set. */
  sku?: string;
  /** Barcode (UPC/EAN/ISBN, …), when set. */
  barcode?: string;
  /** Inventory snapshot for this variant. */
  inventory: {
    /** Whether Mercaria tracks stock for this variant. */
    tracked: boolean;
    /** Units available (never negative). */
    available: number;
  };
}

/**
 * A platform-neutral product being PUSHED to an external platform, built by the
 * sync service from a Mercaria `Listing` + its variants. `externalId` is present
 * only on an UPDATE (a listing already mapped to this connection) — its absence
 * means CREATE. Images are absolute URLs (only publicly-fetchable URLs are pushed).
 */
export interface PushProduct {
  /** The product's existing id on the platform; absent → create a new product. */
  externalId?: string;
  /** Product title. */
  title: string;
  /** Product description (HTML allowed). */
  description: string;
  /** Publish state to request on the platform. */
  status: 'active' | 'draft';
  /** URL-safe handle, when set. */
  handle?: string;
  /** Manufacturer / brand, when set. */
  vendor?: string;
  /** Merchandising product type, when set. */
  productType?: string;
  /** Selectable options and their values (empty for single-variant products). */
  options: { name: string; values: string[] }[];
  /** Absolute, publicly-fetchable image URLs, in gallery order. */
  imageUrls: string[];
  /** Concrete variants (always ≥ 1). */
  variants: PushVariant[];
  /** SEO overrides, when set. */
  seo?: { title?: string; description?: string };
}

/** The result of pushing a product: the platform id to persist as the mapping. */
export interface PushProductResult {
  /** The product's id on the external platform (create → new; update → same). */
  externalId: string;
}

/**
 * One fulfilled line to push out, identified by the platform's own product/variant
 * id (whichever the pulled order line carried) plus the quantity being fulfilled in
 * THIS push. The provider matches it to the platform's fulfillment-order line items
 * and caps the quantity at what is still fulfillable there.
 */
export interface PushFulfillmentLine {
  /** The platform's variant id for the fulfilled line, when the order line carried one. */
  externalVariantId?: string;
  /** The platform's product id for the fulfilled line, when the order line carried one. */
  externalProductId?: string;
  /** Units of this line being fulfilled in this push (never negative). */
  quantity: number;
}

/**
 * A fulfillment being PUSHED to an external platform: mark the mapped external order
 * (or specific lines of it) fulfilled/shipped, attaching tracking when Mercaria
 * captured it.
 *
 * When `lines` is present, ONLY those lines are fulfilled — the provider maps each
 * to the platform's fulfillment-order line items and fulfills at most its remaining
 * fulfillable quantity, so several partial fulfillments can be pushed for one order.
 * When `lines` is ABSENT, every line still fulfillable across the order's open
 * fulfillment work is fulfilled (the whole remaining order). Either way the push is
 * IDEMPOTENT: a line/fulfillment-order with nothing left to fulfill is skipped, so a
 * re-push (retry, or a later ship of the rest) never re-fulfills an already-shipped line.
 */
export interface PushFulfillment {
  /** The platform's order id (the connector order's `source.externalId`). */
  externalOrderId: string;
  /** Tracking number to attach, when Mercaria has one. */
  trackingNumber?: string;
  /** Tracking URL to attach, when Mercaria has one. */
  trackingUrl?: string;
  /** Carrier/company name to attach, when Mercaria has one. */
  trackingCompany?: string;
  /**
   * The specific fulfilled lines to push (partial fulfillment). Absent → fulfill the
   * whole remaining order. Each line is matched to the platform's fulfillment-order
   * line items and capped at their remaining fulfillable quantity.
   */
  lines?: PushFulfillmentLine[];
}

// --- ORDERS (platform → Mercaria) -------------------------------------------

/** One line of an order pulled from an external platform. */
export interface NormalizedOrderLine {
  /** Line/product title at purchase time. */
  title: string;
  /** Variant title at purchase time (e.g. `Size / M`). */
  variantTitle: string;
  /** Quantity ordered. */
  quantity: number;
  /** Unit price, in shop + presentment currency. */
  unitPrice: DualMoney;
  /** `unitPrice * quantity`, in shop + presentment currency. */
  lineTotal: DualMoney;
  /** The platform's product id for the line, when provided. */
  externalProductId?: string;
  /** The platform's variant id for the line, when provided. */
  externalVariantId?: string;
  /** SKU, when provided. */
  sku?: string;
}

/** The buyer/customer attached to a pulled order, when the platform provides one. */
export interface NormalizedOrderCustomer {
  /** The platform's customer id, when provided. */
  externalId?: string;
  /** Customer email, when provided. */
  email?: string;
  /** Customer display name, when provided. */
  name?: string;
}

/**
 * A platform-neutral order, the shape the sync service upserts into a Mercaria
 * `Order`. `externalId` + `externalUpdatedAt` carry the provenance used for the
 * idempotent upsert-by-external-key. Every money field is a `DualMoney` — `shop`
 * is the store's accounting currency, `presentment` what the buyer paid. Both
 * carry the SOURCE platform's own amounts verbatim; Mercaria never re-prices an
 * imported order at its own rates.
 */
export interface NormalizedOrder {
  /** The order's id on the external platform (upsert key with the connection). */
  externalId: string;
  /** The platform's `updated_at` for the order, when available. */
  externalUpdatedAt?: Date;
  /** The platform's human order number/name (e.g. `#1001`), when provided. */
  externalNumber?: string;
  /** The platform's order creation time, when provided. */
  createdAt?: Date;
  /** The Mercaria lifecycle status mapped from the platform's order state. */
  status: OrderStatus;
  /** The Mercaria payment status mapped from the platform's financial state. */
  paymentStatus: PaymentInfo['status'];
  /** The store's accounting currency for this order (the connection's shop currency). */
  shopCurrency: CurrencyCode;
  /** The buyer's presentment currency (falls back to the shop currency). */
  presentmentCurrency: CurrencyCode;
  /** The shop→presentment rate snapshot, when the two currencies differ. */
  fxRate?: FxRateSnapshot;
  /** Concrete order lines (always ≥ 1). */
  lines: NormalizedOrderLine[];
  /** Order money totals, each in shop + presentment currency. */
  totals: {
    subtotal: DualMoney;
    discountTotal: DualMoney;
    tax: DualMoney;
    shipping: DualMoney;
    grandTotal: DualMoney;
  };
  /** The buyer/customer, when the platform provides one. */
  customer?: NormalizedOrderCustomer;
  /** The shipping destination, when the platform provides a usable address. */
  shippingAddress?: AddressSnapshot;
}

/**
 * What a connector provider can do, declared once by the provider itself.
 *
 * Every member is a fact about code that shipped rather than a configuration:
 * `pushesProducts` is whether `pushProduct` does something or refuses,
 * `retriesRateLimit` is whether the transport honours a `Retry-After` or turns
 * a 429 into a failed run. A provider that loses a capability and forgets to
 * say so is caught by the contract suite, which measures the branch either way.
 */
export interface ConnectorCapabilities {
  /** `pushProduct` publishes a Mercaria listing to the platform. */
  readonly pushesProducts: boolean;
  /** `pushFulfillment` reports a Mercaria fulfilment back to the platform. */
  readonly pushesFulfillment: boolean;
  /** The transport retries an HTTP 429 rather than failing the run. */
  readonly retriesRateLimit: boolean;
  /** The platform delivers a webhook when a stock level changes. */
  readonly inventoryWebhook: boolean;
}

/**
 * A single external-commerce platform. One implementation per platform; the
 * registry maps a {@link ConnectorProviderId} to its instance.
 */
export interface ConnectorProvider {
  /** The platform this provider talks to. */
  readonly id: ConnectorProviderId;
  /** How the platform is authorized: an OAuth app or a static API key/secret. */
  readonly credentialStrategy: 'oauth' | 'api_key';
  /**
   * How INBOUND webhooks are authenticated:
   *  - `app_secret`    — a single app-wide secret signs every delivery (Shopify's
   *    app client secret); the ingress route verifies with that one secret and does
   *    NOT need a per-connection secret.
   *  - `per_connection` — a fresh secret is generated at registration, set as the
   *    platform webhook's `secret`, and stored (encrypted) on the `Connection`
   *    (WooCommerce). The ingress route resolves the connection first, then verifies
   *    with its stored secret. The sync service reads this flag to decide whether to
   *    mint + persist a `webhookSecret` when registering.
   */
  readonly webhookSecretStrategy: 'app_secret' | 'per_connection';
  /**
   * Which directions this provider actually implements — ONE declaration, three
   * readers.
   *
   * It lived in the #69 contract-suite harnesses until #87 needed it on a
   * merchant-facing screen. Restating it there would have produced a second
   * description of one fact, and the direction those two disagree in is always
   * the flattering one: a channel catalog claiming WooCommerce pushes products
   * is a promise a merchant configures a sync around.
   *
   * Now the provider declares it, `channel-catalog.ts` reads it, and the
   * contract suite reads it too — so a declaration that stopped being true
   * turns the suite RED, because every capability-gated case asserts the
   * SUCCESS when it is `true` and the REFUSAL when it is `false`. There is no
   * spelling of this that is wrong and green.
   */
  readonly capabilities: ConnectorCapabilities;

  /**
   * How far back {@link fetchOrders} reaches for a connection holding `scopes`
   * (#380).
   *
   * A METHOD rather than a capability flag because the answer is not a property
   * of the shipped code alone: Shopify's `GET /orders.json` reaches 60 days with
   * `read_orders` and the shop's whole history with `read_all_orders` beside it,
   * so the same provider gives two answers for two connections. The provider
   * declares the rule, `toConnectionDTO` applies it to the grant the connection
   * actually holds, and nothing is stored — the connector that owns the bound
   * says outright that a stored copy could only disagree with `Connection.scopes`.
   *
   * It must not read configuration or a default scope list. The argument is what
   * the platform GRANTED, which is the only thing that bounds a fetch; a
   * deployment's configured `SHOPIFY_SCOPES` says what was asked for, and a
   * connection made before somebody changed it holds neither.
   */
  orderHistoryHorizon(scopes: readonly string[]): ChannelOrderHorizon;

  /**
   * Build the platform's OAuth authorize URL the merchant's browser is sent to.
   * `state` is an opaque, server-signed CSRF token the callback re-validates.
   */
  buildAuthorizeUrl(params: {
    shopDomain: string;
    redirectUri: string;
    state: string;
    scopes: string[];
  }): string;

  /**
   * Exchange an OAuth authorization `code` for an access token, and enrich it
   * with the shop's identity (id + canonical domain + currency).
   */
  exchangeCode(params: {
    shopDomain: string;
    code: string;
    redirectUri: string;
  }): Promise<ExchangeResult>;

  /** Verify credentials by fetching the shop's identity from the platform. */
  verifyConnection(auth: ConnectorAuth): Promise<ShopIdentity>;

  /**
   * What this platform CALLS the groupings `collectionMapping` is keyed on.
   *
   * Declared here rather than looked up by `ConnectorProviderId` for
   * {@link ConnectorCapabilities}' reason: two descriptions of one fact drift,
   * and the drift is always flattering. Shopify says "collection", WooCommerce
   * says "category", and a merchant screen using the wrong word is naming
   * something they cannot find in their own admin.
   */
  readonly externalTaxonomyNoun: ExternalTaxonomyNoun;

  /**
   * List every grouping the shop currently publishes, so a merchant can PICK
   * one instead of typing an id.
   *
   * Deliberately NOT capability-gated: both implemented providers publish a
   * complete, named list, so a `listsCollections: false` branch would be one no
   * provider takes — a gate that cannot fail, which reads as coverage. What
   * genuinely varies is the NOUN (declared above) and whether the taxonomy
   * NESTS, which `ExternalCollection.parentExternalId` carries. A future
   * provider that cannot list earns the capability then, with a real `false`
   * beside it.
   *
   * The returned `externalId` MUST be the same identifier this provider writes
   * into `NormalizedProduct.collectionRefs`. They are the two halves of one
   * join, and a picker offering any other identifier stores a key no import can
   * match — a mapping that is configured, displayed, and silently inert.
   *
   * It is its OWN call rather than a by-product of `fetchProducts`. Shopify's
   * per-run collection index is built from `collects.json` plus each smart
   * collection's product list, and carries ids ONLY — no titles, because
   * membership is all an import needs. A picker needs names, so the titles have
   * to be fetched, and a merchant opening the screen must not have to run a
   * backfill first.
   */
  fetchCollections(creds: ConnectorCredentials): Promise<ExternalCollection[]>;

  /**
   * Fetch one page of products. `cursor` is the opaque pagination token returned
   * as `nextCursor` by the previous call (absent on the first page). The returned
   * `nextCursor` is absent on the last page.
   */
  fetchProducts(
    creds: ConnectorCredentials,
    cursor?: string,
  ): Promise<{ products: NormalizedProduct[]; nextCursor?: string }>;

  /**
   * Complete a raw WEBHOOK payload into the shape {@link normalizeProduct} needs,
   * fetching from the platform when the delivery is not self-contained (#220).
   *
   * A webhook carries the product as the PLATFORM serializes it, which is not
   * always the shape the pull path assembles. WooCommerce's `product.*` delivery
   * carries `variations` as a list of IDS and no variation objects, so the
   * payload declares an option axis it cannot price — and before #220 the
   * normalizer fell through to its single-variant branch and imported a variable
   * product as ONE variant at the parent's lowest price, with no option values
   * and no stock, permanently. Shopify's delivery already carries its variants,
   * so its implementation returns the payload unchanged.
   *
   * It is a SEPARATE, ASYNC seam rather than a branch inside `normalizeProduct`
   * because `normalizeProduct` is pure and synchronous and must stay so: it is
   * the one part of a provider a test can drive with no transport, and making it
   * async to accommodate one platform's delivery shape would put a network call
   * inside the function every other case relies on being inert.
   *
   * It THROWS rather than degrading when the expansion cannot complete. A
   * payload that arrives incomplete and is imported anyway is exactly #220; the
   * webhook run fails, nothing is written, and the next backfill converges.
   */
  expandWebhookProduct(auth: ConnectorAuth, raw: unknown): Promise<unknown>;

  /**
   * Map ONE raw platform product into a {@link NormalizedProduct}, pricing every
   * variant in `shopCurrency` (the shop's validated native currency).
   *
   * PURE and SYNCHRONOUS. A payload that declares variations it does not carry
   * is never collapsed into one variant (#220) — see {@link expandWebhookProduct}.
   * Since #259 it REPRESENTS that rather than throwing: the returned
   * {@link VariantSet} carries the {@link VariantEnumerationGap} instead of a
   * variant list, and `importProduct` is the one place that turns a gap into a
   * bounded refusal. A throw is still the right answer for a payload this
   * cannot MAP at all (an unparseable price, a missing one) — the gap describes
   * a product the provider understood and could not finish reading.
   */
  normalizeProduct(raw: unknown, shopCurrency: CurrencyCode): NormalizedProduct;

  /**
   * PUSH a product to the platform: CREATE when `product.externalId` is absent,
   * or UPDATE the mapped external product when present. Returns the platform id to
   * persist as the connection mapping (`Listing.externalRefs`).
   */
  pushProduct(auth: ConnectorAuth, product: PushProduct): Promise<PushProductResult>;

  /**
   * Fetch one page of orders. `cursor` is the opaque pagination token returned as
   * `nextCursor` by the previous call (absent on the first page); the returned
   * `nextCursor` is absent on the last page. Every money field is priced in
   * `creds.shopCurrency` (`shop`) + the order's presentment currency.
   */
  fetchOrders(
    creds: ConnectorCredentials,
    cursor?: string,
  ): Promise<{ orders: NormalizedOrder[]; nextCursor?: string }>;

  /**
   * Map ONE raw platform order (an `orders/*` webhook payload, or a page entry)
   * into a {@link NormalizedOrder}. `shopCurrency` is the connection's validated
   * accounting currency; the presentment side is read from the order when the
   * platform reports it, else falls back to the shop currency.
   */
  normalizeOrder(raw: unknown, shopCurrency: CurrencyCode): NormalizedOrder;

  /**
   * Fetch the current inventory levels for the given external inventory-item ids,
   * each summed across the platform's locations. The provider batches internally to
   * respect the platform's per-request id cap. Returns one entry per item that the
   * platform reports a level for (items with no level are omitted). Used by the
   * inventory pull job and the `inventory_levels/update` webhook.
   */
  fetchInventory(
    auth: ConnectorAuth,
    params: { inventoryItemIds: string[] },
  ): Promise<NormalizedInventoryLevel[]>;

  /**
   * PUSH a fulfillment to the platform for a connector order that Mercaria has
   * fulfilled/shipped. Idempotent: when the external order has no open fulfillment
   * work left (already fulfilled), it is a no-op. Attaches tracking when present.
   */
  pushFulfillment(auth: ConnectorAuth, fulfillment: PushFulfillment): Promise<void>;

  /**
   * Every webhook subscription that currently exists on the platform for this
   * shop, whatever created it and wherever it delivers.
   *
   * The registration path reads it BEFORE creating anything (#218), because
   * `Connection.webhookIds` records what Mercaria believes it created while the
   * platform records what EXISTS — and those two diverge exactly when it
   * matters. A registration that failed part-way left live subscriptions
   * Mercaria holds no id for, and every later reconnect added another full set
   * beside them. Reconciling against the platform's own list is the only thing
   * that converges a shop already in that state.
   */
  listWebhooks(auth: ConnectorAuth): Promise<PlatformWebhookSubscription[]>;

  /**
   * The EXACT URL this provider's subscriptions for `connectionId` deliver to,
   * built from `address` (the public inbound-webhook base URL for the provider).
   *
   * ONE authority, because THREE paths compare against it and two spellings of
   * one URL can only ever disagree: registration reconciles against it,
   * disconnect deletes every subscription sitting at it, and the ingress route
   * is mounted where it points. It is a provider concern rather than a rule
   * derived from {@link webhookSecretStrategy}, because "does the platform need
   * a per-connection endpoint" and "does it need a per-connection secret" are
   * different questions that happen to have the same answer today.
   *
   * It is compared EXACTLY and never by prefix — a WooCommerce connection's URL
   * is another's base plus a different id, so a `startsWith` test turns one
   * connection's reconcile into a cross-store deletion.
   */
  webhookDeliveryUrl(params: { address: string; connectionId: string }): string;

  /**
   * Register the provider's webhooks pointing at {@link webhookDeliveryUrl}.
   * The set of topics is the provider's own concern.
   *
   * PER-TOPIC FAULT TOLERANT (#218), and that is the contract rather than an
   * implementation detail: it NEVER throws for anything the platform answers,
   * and it reports what it knows in a discriminated {@link
   * WebhookRegistrationResult}. When the platform's own list was read, it names
   * every subscription live at the delivery URL — created here, adopted, or left
   * behind by a refused delete — AND every topic the platform refused, with the
   * status and a classified {@link ConnectorWebhookFailureReason}. When the list
   * could NOT be read it says so and names no subscriptions at all, because
   * nothing was created, nothing was deleted, and an empty list would be a claim
   * about a shop it never saw.
   *
   * So a PARTIAL registration still leaves the caller able to persist the ids,
   * disconnect cleanly, and retry without duplicating anything.
   *
   * `connectionId` + `secret` support `per_connection` webhook auth: a provider that
   * cannot lean on one app-wide secret (WooCommerce) delivers to a per-connection
   * URL so the ingress route can resolve the exact connection, and sets `secret` as
   * the platform webhook secret. `app_secret` providers (Shopify) ignore the secret
   * — they sign with the app secret.
   *
   * `ownedSubscriptionIds` is what Mercaria has RECORDED for this connection, and
   * it is the only ownership evidence that survives a change of delivery address
   * (#295). Every provider passes it straight through to
   * `reconcileWebhookSubscriptions`, which uses it to REMOVE a subscription this
   * connection created at an address the deployment no longer serves — never to
   * adopt one.
   */
  registerWebhooks(
    auth: ConnectorAuth,
    params: {
      address: string;
      connectionId: string;
      secret?: string;
      ownedSubscriptionIds: readonly string[];
    },
  ): Promise<WebhookRegistrationResult>;

  /**
   * Delete the given webhook subscriptions by their platform ids. Idempotent: an
   * already-absent subscription is treated as success (not an error).
   */
  deleteWebhooks(auth: ConnectorAuth, webhookIds: string[]): Promise<void>;
}
