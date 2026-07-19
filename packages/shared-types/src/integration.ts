/**
 * Connector / integration DTOs for the Mercaria connectors platform.
 *
 * A `Connection` links a Mercaria store to an external commerce platform
 * (Shopify, WooCommerce, …). It carries the per-resource sync configuration
 * (`SyncSettings`) and the sync activity log (`SyncRun`). Credentials are NEVER
 * part of any DTO — the encrypted secret blob lives only in the server-side
 * `Connection` model and never crosses the wire.
 */

/**
 * The external commerce platforms Mercaria can connect to. Shopify ships first;
 * the rest follow as individual `ConnectorProvider` implementations without any
 * change to the surrounding model.
 */
export type ConnectorProviderId = 'shopify' | 'woocommerce' | 'etsy' | 'prestashop' | 'magento';

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
  | 'webhook';

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
