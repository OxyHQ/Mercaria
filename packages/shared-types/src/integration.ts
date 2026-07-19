/**
 * Connector / integration DTOs for the Mercaria connectors platform.
 *
 * A `Connection` links a Mercaria store to an external commerce platform
 * (Shopify, WooCommerce, …). It carries the per-resource sync configuration
 * (`SyncSettings`) and the sync activity log (`SyncRun`). Credentials are NEVER
 * part of any DTO — the encrypted secret blob lives only in the server-side
 * `Connection` model and never crosses the wire.
 */

import type { Money } from './money';

/**
 * The external commerce platforms Mercaria can connect to. Shopify ships first;
 * the rest follow as individual `ConnectorProvider` implementations without any
 * change to the surrounding model. The runtime tuple is the SINGLE source of the
 * provider set — `ConnectorProviderId` is derived from it, and validators import
 * it instead of re-declaring the list.
 */
export const CONNECTOR_PROVIDER_IDS = [
  'shopify',
  'woocommerce',
  'etsy',
  'prestashop',
  'magento',
] as const;

export type ConnectorProviderId = (typeof CONNECTOR_PROVIDER_IDS)[number];

/**
 * Which side initiates the connection:
 *  - `'pull'`     — Mercaria queries the external platform's API (e.g. Shopify).
 *  - `'push_in'`  — an external client pushes into Mercaria (e.g. the Mercaria
 *                   WordPress plugin). The model is common to both; only the
 *                   initiator differs.
 */
export type ConnectionMode = 'pull' | 'push_in';

/** Sync direction for a single resource (products / inventory / orders). */
export type SyncResourceDirection = 'pull' | 'push' | 'bidirectional' | 'off';

/**
 * Per-connection sync configuration. Direction is chosen per resource; the
 * remaining fields tune how imported data is materialized into the store.
 */
export interface SyncSettings {
  /** Direction for the product catalog. */
  products: SyncResourceDirection;
  /** Direction for inventory levels. */
  inventory: SyncResourceDirection;
  /** Direction for orders. */
  orders: SyncResourceDirection;
  /** Whether pulled products are published (`active`) or held as `draft`. */
  autoPublish: boolean;
  /** Location that receives pulled stock (Mercaria `Location` id). */
  targetLocationId?: string;
  /** Price transform applied to pulled prices. */
  priceRules?: {
    /** Percentage markup added to the native price (e.g. `10` = +10%). */
    markupPercent?: number;
    /** Rounding strategy after markup. */
    rounding?: 'none' | 'nearest' | 'charm';
  };
  /** Map of external collection/category id → Mercaria `Collection` id. */
  collectionMapping?: Record<string, string>;
  /**
   * How a re-sync resolves a field that differs between the connector and
   * Mercaria:
   *  - `'connector_wins'`     — the connector value always overwrites.
   *  - `'respect_overrides'`  — fields listed in the listing's `overriddenFields`
   *                             are kept (locally-edited fields are pinned).
   */
  conflictPolicy: 'connector_wins' | 'respect_overrides';
}

/** Lifecycle status of a `Connection`. */
export type ConnectionStatus = 'connected' | 'error' | 'disconnected';

/**
 * A store's link to an external commerce platform. NOTE: this DTO carries NO
 * credentials — the encrypted secret blob stays server-side and never leaves the
 * API.
 */
export interface Connection {
  /** Stable connection id. */
  id: string;
  /** Owning Mercaria store id. */
  storeId: string;
  /** External platform this connection targets. */
  provider: ConnectorProviderId;
  /** Whether Mercaria pulls, or the external client pushes in. */
  mode: ConnectionMode;
  /** Current lifecycle status. */
  status: ConnectionStatus;
  /** External platform's shop id, when known. */
  externalShopId?: string;
  /** External shop domain (e.g. `acme.myshopify.com`), when known. */
  shopDomain?: string;
  /**
   * The external shop's own currency (ISO-4217 as reported by the platform). May
   * be a code outside Mercaria's supported `CurrencyCode` set — it is metadata,
   * not a settlement currency, so it is typed as a raw string.
   */
  shopCurrency?: string;
  /** OAuth scopes / permissions granted by the external platform. */
  scopes: string[];
  /** Per-resource sync configuration. */
  syncSettings: SyncSettings;
  /** Ids of webhooks registered on the external platform for this connection. */
  webhookIds: string[];
  /** ISO-8601 time the connection was established. */
  connectedAt: string;
  /** ISO-8601 time of the most recent completed sync, when any. */
  lastSyncAt?: string;
}

/** The kind of work a `SyncRun` performed. */
export type SyncRunKind =
  | 'backfill'
  | 'product_pull'
  | 'product_push'
  | 'inventory_sync'
  | 'order_sync'
  | 'fulfillment_push'
  | 'webhook'
  | 'ingest';

/** Lifecycle status of a single `SyncRun`. */
export type SyncRunStatus = 'running' | 'completed' | 'failed';

/** Per-run tallies of records processed, surfaced in the dashboard status feed. */
export interface SyncRunCounts {
  /** Records newly created. */
  created: number;
  /** Existing records updated. */
  updated: number;
  /** Records intentionally skipped (e.g. pinned by `overriddenFields`). */
  skipped: number;
  /** Records that failed to process. */
  failed: number;
}

/**
 * The lifecycle phase of a live sync, emitted over Socket.IO as the run progresses:
 *  - `'started'`   — the run has begun (counts are all zero).
 *  - `'running'`   — an intermediate progress tick (e.g. after each product page).
 *  - `'completed'` — the run finished successfully.
 *  - `'failed'`    — the run aborted with an error.
 */
export type SyncProgressPhase = 'started' | 'running' | 'completed' | 'failed';

/**
 * A live sync-progress event, broadcast to the `store:${storeId}` Socket.IO room
 * as a backfill or webhook run advances. It mirrors the persisted `SyncRun` but is
 * ephemeral (never stored) — the dashboard renders it as a live progress feed.
 */
export interface SyncProgressEvent {
  /** Connection the run belongs to. */
  connectionId: string;
  /** What the run is doing. */
  kind: SyncRunKind;
  /** Current lifecycle phase. */
  phase: SyncProgressPhase;
  /** Running record tallies at this tick. */
  counts: SyncRunCounts;
}

/** One run of a sync operation against a connection — the dashboard status log. */
export interface SyncRun {
  /** Stable run id. */
  id: string;
  /** Connection this run belongs to. */
  connectionId: string;
  /** What the run did. */
  kind: SyncRunKind;
  /** Current status. */
  status: SyncRunStatus;
  /** Record tallies. */
  counts: SyncRunCounts;
  /** ISO-8601 time the run started. */
  startedAt: string;
  /** ISO-8601 time the run finished, when it has. */
  finishedAt?: string;
  /** Failure message when `status === 'failed'`. */
  error?: string;
}

/**
 * Payload accepted when creating a connection. Credentials are NOT supplied here
 * — the server obtains them out-of-band (OAuth callback / push-in registration)
 * and stores them encrypted. Sync configuration is optional; the server applies
 * defaults for any omitted field.
 */
export interface CreateConnectionInput {
  /** External platform to connect. */
  provider: ConnectorProviderId;
  /** Whether Mercaria pulls, or the external client pushes in. */
  mode: ConnectionMode;
  /** Optional initial sync configuration; server defaults fill the rest. */
  syncSettings?: Partial<SyncSettings>;
}

/** Partial payload accepted when updating a connection's sync configuration. */
export type UpdateSyncSettingsInput = Partial<SyncSettings>;

// ---------------------------------------------------------------------------
// Channel ingestion (push_in) — the receive side for an external client (e.g.
// the Mercaria WooCommerce plugin) pushing its catalog INTO Mercaria.
// ---------------------------------------------------------------------------

/** Body for `POST /admin/stores/:storeId/channels/:provider/connect-push`. */
export interface ConnectPushInput {
  /** The external site's domain (e.g. the WordPress host); display metadata only. */
  shopDomain?: string;
}

/** Result of establishing (or re-affirming) a push-in connection. */
export interface ConnectPushResult {
  /** The push-in connection id the external client ingests against. */
  connectionId: string;
  /** The Mercaria store the connection belongs to. */
  storeId: string;
}

/** A single option-value assignment on an ingested variant. */
export interface IngestOptionValue {
  name: string;
  value: string;
}

/** One variant of an ingested product, priced in the shop's native currency. */
export interface IngestProductVariant {
  /** Option-value assignments (omitted/empty for a single-variant product). */
  optionValues?: IngestOptionValue[];
  /** Selling price in native currency (integer minor units + supported code). */
  price: Money;
  /** Optional compare-at (was) price, same currency. */
  compareAtPrice?: Money;
  /** Stock-keeping unit — also the inventory-ingest mapping key. */
  sku?: string;
  /** Barcode (UPC/EAN/ISBN…). */
  barcode?: string;
  /** Inventory snapshot; `available` defaults to 0 when omitted. */
  inventory?: { available: number };
}

/**
 * A product pushed into Mercaria by an external client. Upserted idempotently by
 * `{ storeId, source.connectionId, externalId }`. Prices are stored in the given
 * NATIVE currency (no FAIR conversion). Native Mercaria fields (category,
 * condition, tags, collections) are NOT part of this payload — they stay local
 * and are never overwritten by an ingest.
 */
export interface IngestProduct {
  /** The product's id on the external platform (the upsert key). */
  externalId: string;
  /** The external platform's `updated_at` (ISO-8601), when available. */
  externalUpdatedAt?: string;
  /** Product title. */
  title: string;
  /** Product description (may contain source HTML). */
  description?: string;
  /** Absolute image URLs (stored verbatim — no re-upload). */
  images?: string[];
  /** Selectable options and their values. */
  options?: { name: string; values: string[] }[];
  /** Concrete variants (at least one). */
  variants: IngestProductVariant[];
  /** Manufacturer/brand. */
  vendor?: string;
  /** Merchandising product type. */
  productType?: string;
  /** URL-safe handle. */
  handle?: string;
  /** SEO overrides. */
  seo?: { title?: string; description?: string };
}

/** Body for `POST /admin/stores/:storeId/channels/:connectionId/ingest/products`. */
export interface IngestProductsInput {
  products: IngestProduct[];
}

/**
 * Outcome of ingesting a single product:
 *  - `'created'` — a new listing was created and stamped with provenance.
 *  - `'updated'` — the mapped listing was updated (pinned fields respected).
 *  - `'skipped'` — nothing changed (every managed field is pinned).
 *  - `'failed'`  — the product could not be ingested (`error` explains why).
 */
export type IngestProductAction = 'created' | 'updated' | 'skipped' | 'failed';

/** Per-product result of a products ingest (one entry per input product, in order). */
export interface IngestProductResult {
  /** The external id echoed back so the client can reconcile. */
  externalId: string;
  /** What happened to this product. */
  action: IngestProductAction;
  /** The Mercaria listing id, when one was created/updated/matched. */
  listingId?: string;
  /** Failure detail when `action === 'failed'`. */
  error?: string;
}

/** Result of a products ingest. */
export interface IngestProductsResult {
  results: IngestProductResult[];
}

/** One inventory update: set `available` on the variant mapped from `externalId`(+`sku`). */
export interface IngestInventoryItem {
  /** The external product id (maps to a connector-sourced listing). */
  externalId: string;
  /** The variant SKU; required to disambiguate a multi-variant product. */
  sku?: string;
  /** Absolute available quantity to set (non-negative integer). */
  available: number;
}

/** Body for `POST /admin/stores/:storeId/channels/:connectionId/ingest/inventory`. */
export interface IngestInventoryInput {
  items: IngestInventoryItem[];
}

/**
 * Outcome of a single inventory update:
 *  - `'updated'` — stock was set on the mapped variant.
 *  - `'skipped'` — no listing/variant mapped from `externalId`(+`sku`).
 *  - `'failed'`  — the update errored (`error` explains why).
 */
export type IngestInventoryAction = 'updated' | 'skipped' | 'failed';

/** Per-item result of an inventory ingest (one entry per input item, in order). */
export interface IngestInventoryResultItem {
  externalId: string;
  action: IngestInventoryAction;
  /** The variant whose stock was set, when mapped. */
  variantId?: string;
  /** Failure detail when `action === 'failed'`. */
  error?: string;
}

/** Result of an inventory ingest. */
export interface IngestInventoryResult {
  results: IngestInventoryResultItem[];
}

// ---------------------------------------------------------------------------
// Channel API keys — long-lived, store-scoped credentials an external ingest
// client (e.g. the Mercaria WooCommerce plugin) uses to authenticate its pushes
// WITHOUT a short-lived Oxy access token. The key path is the `push_in` receive
// side's stable, self-serve credential: unlike an Oxy access token it never
// expires, and it is revocable per key from the dashboard.
// ---------------------------------------------------------------------------

/**
 * Scopes a `ChannelApiKey` may hold. A channel key only ever authorizes catalog
 * ingestion (`channels:write`); it can never act as a store member or reach any
 * other admin surface. The runtime tuple is the single source — the type derives
 * from it and the model/validators import it rather than re-declaring the list.
 */
export const CHANNEL_API_KEY_SCOPES = ['channels:write'] as const;

/** A scope a channel key can carry. */
export type ChannelApiKeyScope = (typeof CHANNEL_API_KEY_SCOPES)[number];

/**
 * Metadata for a channel API key. The plaintext key is NEVER part of this DTO —
 * it is shown exactly once at creation (see `GenerateChannelApiKeyResult`) and
 * only its irreversible sha256 hash is stored server-side. Everything here is
 * safe to list in the dashboard.
 */
export interface ChannelApiKey {
  /** Stable key id. */
  id: string;
  /** Owning Mercaria store id. */
  storeId: string;
  /**
   * The push-in connection this key is bound to, when scoped to one. A bound key
   * can ONLY ingest into that connection; an unbound (store-scoped) key may
   * ingest into any of the store's push-in connections.
   */
  connectionId?: string;
  /**
   * Display prefix — the first characters of the plaintext key (e.g.
   * `mck_1a2b3c4d`). Lets a merchant recognize a key in a list without exposing
   * the secret.
   */
  prefix: string;
  /** Human-readable label the merchant gave the key (e.g. "WordPress plugin"). */
  label: string;
  /** Scopes the key holds (always exactly `['channels:write']` for now). */
  scopes: ChannelApiKeyScope[];
  /** Oxy user id of the member who created the key. */
  createdBy: string;
  /** ISO-8601 time the key was last used to authenticate an ingest, when ever. */
  lastUsedAt?: string;
  /** ISO-8601 creation time. */
  createdAt: string;
}

/** Body for `POST /admin/stores/:storeId/channel-keys` — mint a new channel key. */
export interface GenerateChannelApiKeyInput {
  /** Human-readable label to identify the key later. */
  label: string;
  /**
   * Optionally bind the key to a single push-in connection. When omitted the key
   * is store-scoped and works for any of the store's push-in connections.
   */
  connectionId?: string;
}

/**
 * Result of minting a channel key. The plaintext `key` is returned EXACTLY ONCE
 * and is unrecoverable afterward (only its hash is stored) — the client must show
 * it to the merchant immediately and never persist it server-side.
 */
export interface GenerateChannelApiKeyResult {
  /** The plaintext key (`mck_…`). Shown once; never retrievable again. */
  key: string;
  /** The stored key's metadata. */
  apiKey: ChannelApiKey;
}
