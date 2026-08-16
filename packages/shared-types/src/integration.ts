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
 * Why the platform refused to create ONE webhook subscription (#218).
 *
 * A closed set, because a merchant surface has to say which events will not
 * arrive AND what to do about it, and the remedies genuinely differ: a
 * `permission_denied` is a scope or an API key the merchant must widen, a
 * `topic_not_supported` is a platform that will never send that event, and a
 * `rate_limited` or `platform_error` is worth simply retrying. A sentence
 * cannot be branched on, and an HTTP status alone cannot either — 403 means the
 * same thing on both platforms, and 400 does not.
 *
 * It is deliberately NARROWER than the set of HTTP statuses a platform can
 * answer: everything unclassifiable lands on `unexpected_response`, which is
 * honest, rather than on the nearest plausible member, which is not.
 */
export const CONNECTOR_WEBHOOK_FAILURE_REASONS = [
  /** 401/403 — the credential does not carry the scope this topic needs. */
  'permission_denied',
  /** 429 — the platform was throttling; the topic is fine and a retry may take it. */
  'rate_limited',
  /** 400/422 — the platform refused the subscription itself. */
  'topic_not_supported',
  /** 5xx — the platform failed. */
  'platform_error',
  /** A 2xx whose body carried no usable subscription id, or an unclassifiable status. */
  'unexpected_response',
  /** The call never reached the platform (DNS, TLS, timeout, SSRF refusal). */
  'transport_error',
] as const;

export type ConnectorWebhookFailureReason = (typeof CONNECTOR_WEBHOOK_FAILURE_REASONS)[number];

/**
 * The refusals no number of retries can fix (#262).
 *
 * Both are the vocabulary's own words, quoted from the doc comment above: a
 * `permission_denied` is "a scope or an API key the merchant must widen" and a
 * `topic_not_supported` is "a platform that will never send that event". A
 * credential that answered 403 answers 403 again, so an automatic sweep spending
 * attempts on either is knocking at a door only a person can open — and the
 * remedy it needs is the merchant re-registering on demand AFTER widening the
 * grant, which is exactly what {@link CONNECTOR_WEBHOOK_RETRYABLE_FAILURE_REASONS}
 * must not pre-empt by burning the attempt budget first.
 */
export const CONNECTOR_WEBHOOK_UNRETRYABLE_FAILURE_REASONS = [
  'permission_denied',
  'topic_not_supported',
] as const satisfies readonly ConnectorWebhookFailureReason[];

/**
 * The refusals an automatic re-registration may retry — derived by SUBTRACTION.
 *
 * The direction of the derivation is the decision. A reason added to the
 * vocabulary later becomes RETRYABLE by omission, which costs at most the
 * bounded attempt budget of noise; the opposite default would leave a channel
 * dark until a human noticed, for a reason nobody had classified. The two lists
 * are asserted to partition the vocabulary, so neither can drift into covering
 * a reason twice or none.
 */
export const CONNECTOR_WEBHOOK_RETRYABLE_FAILURE_REASONS: readonly ConnectorWebhookFailureReason[] =
  CONNECTOR_WEBHOOK_FAILURE_REASONS.filter(
    (reason) =>
      !(CONNECTOR_WEBHOOK_UNRETRYABLE_FAILURE_REASONS as readonly string[]).includes(reason),
  );

/**
 * Where automatic webhook re-registration stands for one connection (#262).
 *
 * `pending` is work OUTSTANDING — never attempted, or a retry is scheduled. The
 * two are told apart by `attempts` and `nextAttemptAt`, not by a fourth state,
 * because "due" is a fact about the clock and a stored value for it would go
 * stale the moment it passed.
 *
 * `registered` is the success (#297). Until it existed a successful registration
 * wrote `pending`, so one value carried both "never tried" and "completed" and
 * nothing in it told them apart. That was harmless only because
 * `findConnectionsNeedingWebhookRegistration` never swept on the state alone —
 * it also requires empty `webhook_ids` or a retryable failure. The column was a
 * broken suspender and that predicate the only belt, and the cost of the belt
 * slipping is not a wasted call: on WooCommerce a re-registration RECREATES
 * rather than adopts (the secret is fixed at creation, #218), so a sweep over
 * healthy connections would add a full set of subscriptions to every connected
 * merchant's site every fifteen minutes.
 *
 * `dead_letter` is the visible give-up: either the attempt budget is spent or the
 * platform refused for a reason no retry can fix. It is stored rather than derived
 * because only the code holding the provider's answer knows which of those two it
 * is, and the merchant's next action ("widen the scope, then press retry") is the
 * same either way.
 *
 * What none of the three can say is whether those subscriptions are still LIVE on
 * the platform — a merchant, or a sibling connection sharing the address, can
 * delete them and nothing here observes it. `registered` means Mercaria completed
 * a registration and recorded the ids, which is what the sweep already believes.
 */
export const CONNECTOR_WEBHOOK_REGISTRATION_STATES = [
  'pending',
  'registered',
  'dead_letter',
] as const;

export type ConnectorWebhookRegistrationState =
  (typeof CONNECTOR_WEBHOOK_REGISTRATION_STATES)[number];

/**
 * What automatic re-registration has tried for this connection (#262).
 *
 * Carries NO provider error text. A refusal names topics and reasons through
 * {@link ConnectionWebhookFailure}; the free-form message a thrown registration
 * produces stays in the server log, because a provider's error string is the one
 * place a credential or a signed URL could ride out to a merchant response.
 */
export interface ConnectionWebhookRegistration {
  readonly state: ConnectorWebhookRegistrationState;
  /** Consecutive AUTOMATIC attempts spent; a success resets it to zero. */
  readonly attempts: number;
  /** ISO-8601 time the next automatic attempt becomes due, when one is scheduled. */
  readonly nextAttemptAt?: string;
}

/**
 * One webhook topic the platform would NOT subscribe, recorded on the connection.
 *
 * The record exists because the alternative is silence: before #218 a refused
 * topic left a warning in a log line nobody reads and a connection that looks
 * healthy, so a merchant discovered it as "my prices stopped updating" weeks
 * later. Every registration REPLACES this list wholesale, so it always describes
 * the most recent attempt rather than accumulating history.
 */
export interface ConnectionWebhookFailure {
  /** The PLATFORM's own topic string (`orders/create`, `product.updated`). */
  readonly topic: string;
  readonly reason: ConnectorWebhookFailureReason;
  /**
   * The HTTP status the platform answered, when the call reached it. Absent for
   * a `transport_error`, which is precisely the case where there is no status.
   */
  readonly httpStatus?: number;
  /** ISO-8601 time of the registration attempt that recorded it. */
  readonly recordedAt: string;
}

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
   * be a code outside Mercaria's supported `CurrencyCode` set — it is metadata
   * reported by the platform, not a currency Mercaria transacts in, so it is
   * typed as a raw string.
   */
  shopCurrency?: string;
  /** OAuth scopes / permissions granted by the external platform. */
  scopes: string[];
  /** Per-resource sync configuration. */
  syncSettings: SyncSettings;
  /** Ids of webhooks registered on the external platform for this connection. */
  webhookIds: string[];
  /**
   * The topics the platform refused at the last registration (#218).
   *
   * Omitted when there are none, so an older client reading no field behaves
   * exactly as it did — and a merchant surface that renders it is naming events
   * that will NOT arrive, which is the one thing `webhookIds` cannot say.
   */
  webhookFailures?: ConnectionWebhookFailure[];
  /**
   * Where automatic re-registration stands (#262).
   *
   * Omitted in the ordinary state — nothing tried, nothing scheduled, nothing
   * given up on — so a healthy connection serializes exactly as it did and an
   * older client reading no field behaves exactly as it did. Present, it is what
   * tells a merchant whether the refused topics beside it are still being retried
   * or whether Mercaria has stopped and is waiting for them.
   */
  webhookRegistration?: ConnectionWebhookRegistration;
  /** ISO-8601 time the connection was established. */
  connectedAt: string;
  /** ISO-8601 time of the most recent completed sync, when any. */
  lastSyncAt?: string;
  /**
   * Which scopes are currently paused (#87 management 4).
   *
   * A LIST rather than two booleans, because the two stored columns are
   * instants and what a client needs is the set. Empty is the ordinary state, so
   * an older client reading no field behaves exactly as it did.
   *
   * Typed as `ChannelPauseScope[]` in `./channel-catalog`, which imports FROM
   * this module — so it is spelled structurally here rather than importing back
   * and creating a cycle. The two are pinned together by
   * `channel-summary.service.ts`, which builds both from the same columns.
   */
  pausedScopes?: ('fetch' | 'publication')[];
  /**
   * What the last disconnect decided to do with this connection's listings, and
   * when. Absent until this connection has been disconnected at least once; a
   * reconnect leaves them standing, so they always name the most recent one.
   */
  disconnectPolicy?: 'keep_listings' | 'unpublish_listings' | 'archive_listings';
  disconnectedAt?: string;
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
  /**
   * Why the run did not fully land.
   *
   * On a `failed` run this is the failure that stopped it. On a `completed` one
   * it is present exactly when `counts.failed > 0`, naming the records that were
   * refused and why — because `completed` beside a non-zero tally is otherwise a
   * report that reads as clean while a product is missing (#294). Render it
   * whenever it is present; keying on `status === 'failed'` hides the case it
   * was added for.
   *
   * It is a SUMMARY and is elided — three reasons, three records each — so a run
   * that refused a hundred products names nine of them here. The complete,
   * durable list is `SyncRecordFailure` (#303), fetched per run.
   */
  error?: string;
}

/**
 * What KIND of thing a refused record was (#303).
 *
 * Stored rather than derived from `SyncRunKind`, and the reason is a rail that
 * would be silently wrong: `inventory_sync` is the kind of BOTH the pull
 * (`syncInventory`, whose unit is a platform inventory ITEM id) and the push
 * (`ingestInventory`, whose unit is the PRODUCT external id it resolves a
 * listing by). Deriving the subject from the kind would tell a merchant to
 * search their product list for an inventory-item id on one of those two.
 */
export type SyncRecordSubjectType = 'product' | 'order' | 'inventory_item';

export const SYNC_RECORD_SUBJECT_TYPES: readonly SyncRecordSubjectType[] = [
  'product',
  'order',
  'inventory_item',
];

/**
 * Why ONE record did not land — the classified code (#303).
 *
 * Four members, derived by ONE function from the same evidence that composes the
 * merchant-facing message, so the code and the sentence beside it cannot
 * disagree. Deliberately NOT `MercariaErrorCode`: that vocabulary is the HTTP
 * envelope's and grows with every feature, so a connector row would end up
 * carrying `GUEST_CART_DISABLED`.
 *
 *  - `refused_by_rule` — one of Mercaria's own rules refused the record (a
 *    validation refusal, a conflict, the variant ceiling, an ambiguous SKU). The
 *    detail is the sentence that rule composed, and it usually names a remedy.
 *  - `duplicate_record` — a unique violation (SQLSTATE 23505). Normally two
 *    deliveries of one record racing, or a platform publishing one id twice.
 *  - `database_refused` — any other refusal the database named (a constraint or
 *    a SQLSTATE is present, and neither is data).
 *  - `unclassified` — nothing about the failure could be classified. The full
 *    error is in Mercaria's server log; it is deliberately not published, because
 *    the value it would publish is `err.message`, which for a driver failure is
 *    the failing statement plus its bound parameters (#292).
 */
export type SyncRecordFailureReason =
  | 'refused_by_rule'
  | 'duplicate_record'
  | 'database_refused'
  | 'unclassified';

export const SYNC_RECORD_FAILURE_REASONS: readonly SyncRecordFailureReason[] = [
  'refused_by_rule',
  'duplicate_record',
  'database_refused',
  'unclassified',
];

/**
 * One record a run could not process, durably (#303).
 *
 * `sync_runs.counts.failed` is a tally and `sync_runs.error` is an elided
 * summary; this is the row that says WHICH record and WHY, one per record, for
 * as long as the retention window holds it.
 *
 * `detail` is composed by the SAME classifier that writes `sync_runs.error`, so
 * a raw driver statement can no more reach this field than it can reach that one
 * — there is exactly one composer of a merchant-facing failure string.
 */
export interface SyncRecordFailure {
  /** Stable row id. */
  id: string;
  /** What kind of record this was. */
  subjectType: SyncRecordSubjectType;
  /**
   * The external platform's own id for the record — what a merchant searches by.
   *
   * Absent when the platform published none, which is a real state rather than a
   * gap in the report.
   */
  externalId?: string;
  /** The classified reason. */
  reason: SyncRecordFailureReason;
  /** The bounded, scrubbed sentence. Never a driver statement (#292). */
  detail: string;
  /** ISO-8601 time the failure was recorded. */
  at: string;
}

/**
 * One run's per-record failures, and what the list does NOT say.
 *
 * `failedCount` is the run's own tally and `failures` is what is still stored,
 * and the two legitimately differ: a whole-run failure counts one without naming
 * a record, a run may refuse more records than one page stores, and the rows
 * expire while the run row does not. Reporting the tally beside the list is what
 * stops a shorter list reading as a smaller problem.
 */
export interface SyncRunRecordFailurePage {
  /** The run these belong to. */
  runId: string;
  /** `SyncRun.counts.failed` — what the run itself tallied. */
  failedCount: number;
  /** The per-record reasons still stored, oldest first (the order they were met). */
  failures: SyncRecordFailure[];
  /**
   * True when the page was cut by its own limit rather than by retention or by
   * the run's write cap — the two elisions have different remedies and reading
   * one as the other sends somebody to the wrong place.
   */
  limitReached: boolean;
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
  /**
   * Inventory snapshot. PRESENT means the client is asserting a tracked stock
   * figure — including `{ available: 0 }`, which means tracked and sold out.
   * ABSENT means the client does not track stock for this variant, and the
   * variant is stored UNTRACKED (sellable, no quantity counted) rather than at
   * zero — an omission is not an assertion that nothing is for sale (#293).
   */
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
 *  - `'ambiguous'` — SEVERAL variants of the mapped listing carry that `sku`, so
 *    nothing was set and `error` names them. A SKU is unique at no grain
 *    Mercaria enforces (#296 — the platforms disagree about whether it should
 *    be), so this is a catalogue the merchant has to de-duplicate. Deliberately
 *    not folded into `'skipped'`: "we could not find it" and "we found several
 *    and will not guess" lead a merchant to opposite actions.
 *  - `'failed'`  — the update errored (`error` explains why).
 */
export type IngestInventoryAction = 'updated' | 'skipped' | 'ambiguous' | 'failed';

/** Per-item result of an inventory ingest (one entry per input item, in order). */
export interface IngestInventoryResultItem {
  externalId: string;
  action: IngestInventoryAction;
  /** The variant whose stock was set, when mapped. */
  variantId?: string;
  /** Detail when `action` is `'failed'` or `'ambiguous'`. */
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

// ── Collection mapping: the platform's groupings, and what they map onto ─────

/**
 * What a platform CALLS the grouping `SyncSettings.collectionMapping` is keyed
 * on — the one place the two implemented providers genuinely disagree.
 *
 * Shopify publishes flat "collections" (custom and smart, in one id space);
 * WooCommerce publishes nested product "categories". Mercaria maps both onto
 * `Collection`, so the model is shared and only the NOUN differs — and a
 * merchant screen that called a WooCommerce category a "collection" would be
 * naming something the merchant cannot find in their own admin.
 *
 * It is a provider DECLARATION rather than a lookup keyed on
 * `ConnectorProviderId`, for the reason `ConnectorCapabilities` already records:
 * a second description of one fact drifts, and it drifts in the flattering
 * direction.
 */
export const EXTERNAL_TAXONOMY_NOUNS = ['collection', 'category'] as const;

export type ExternalTaxonomyNoun = (typeof EXTERNAL_TAXONOMY_NOUNS)[number];

/**
 * One grouping the external platform currently publishes.
 *
 * `externalId` is the platform's own id and is EXACTLY the key
 * `collectionMapping` is keyed on and exactly what a provider puts in
 * `NormalizedProduct.collectionRefs`. A picker built on any other identifier
 * (a handle, a slug, a name) would store a key no import can ever match, and
 * the failure would be silent: the mapping simply never fires.
 */
export interface ExternalCollection {
  /** The platform's own id — the `collectionMapping` KEY. */
  readonly externalId: string;
  /** The merchant-facing name, as the platform spells it. */
  readonly title: string;
  /**
   * The parent grouping, where the platform NESTS them (WooCommerce). Absent on
   * a flat taxonomy (Shopify) and on a root-level node. Presentation only —
   * nothing about the mapping is hierarchical, and mapping a parent does NOT
   * map its children.
   */
  readonly parentExternalId?: string;
  /** How many products the platform reports in it, when it publishes a count. */
  readonly productCount?: number;
}

/** Why this connection's live groupings could not be listed. */
export const CHANNEL_COLLECTIONS_UNAVAILABLE_REASONS = [
  /**
   * A `push_in` connection: the external site pushes into Mercaria and Mercaria
   * holds no credential to call it with. There is nothing to ask.
   */
  'push_in_connection',
  /** The connection is disconnected — its credentials were dropped at rest. */
  'disconnected',
  /** The platform was asked and refused or could not be reached. */
  'platform_unavailable',
] as const;

export type ChannelCollectionsUnavailableReason =
  (typeof CHANNEL_COLLECTIONS_UNAVAILABLE_REASONS)[number];

/**
 * The platform's live groupings, or a named reason there are none to show.
 *
 * A discriminated union on a STRING discriminant, and deliberately not an
 * optional array: this backend compiles with `strict: false`, so TypeScript
 * does not narrow a union on the truthiness of a boolean-literal discriminant,
 * and an absent array would make "we could not ask" and "the shop has none"
 * the same value — which are opposite answers for a merchant staring at an
 * empty picker.
 */
export type ChannelExternalCollections =
  | { readonly outcome: 'listed'; readonly collections: readonly ExternalCollection[] }
  | {
      readonly outcome: 'unavailable';
      readonly reason: ChannelCollectionsUnavailableReason;
    };

/**
 * A Mercaria collection a mapping may TARGET.
 *
 * MANUAL collections only. An automated collection's membership is derived from
 * its rules by `reconcileAutomatedMembership`, and a connector membership is
 * derived from the platform's own grouping by `applyCollectionMapping` — both
 * write a NULL `position` into `listing_collections`, and each DELETES what the
 * other inserted. The result flip-flops on whichever ran last, with no error
 * anywhere, so the two must never own one collection.
 */
export interface ChannelCollectionTarget {
  readonly id: string;
  readonly title: string;
  readonly handle: string;
}

/** The health of ONE stored `externalId → collectionId` row. */
export const CHANNEL_COLLECTION_MAPPING_STATES = [
  /** Both ends resolve and the target is mappable — the row does what it says. */
  'ok',
  /**
   * The platform no longer publishes this grouping. The mapping is inert (no
   * import will ever carry the ref) but harmless, and it is NOT auto-removed: a
   * grouping can disappear because a merchant is mid-reorganization, and
   * deleting their configuration on their behalf is not recoverable.
   */
  'external_missing',
  /** The Mercaria collection was deleted. The row is skipped at import. */
  'target_missing',
  /**
   * The Mercaria collection became AUTOMATED after the mapping was stored. The
   * row is skipped at import so the rules engine keeps sole ownership.
   */
  'target_automated',
] as const;

export type ChannelCollectionMappingState =
  (typeof CHANNEL_COLLECTION_MAPPING_STATES)[number];

/** One stored mapping row, resolved against both ends. */
export interface ChannelCollectionMappingRow {
  /** The platform's grouping id — the stored key. */
  readonly externalId: string;
  /** Its current name, absent when the platform no longer publishes it. */
  readonly externalTitle?: string;
  /** The Mercaria collection id — the stored value. */
  readonly collectionId: string;
  /** Its current title, absent when it was deleted. */
  readonly collectionTitle?: string;
  /** What this row will actually do on the next import. */
  readonly state: ChannelCollectionMappingState;
}

/**
 * Everything the mapping screen needs, in ONE payload.
 *
 * The three lists are resolved together on purpose: a client that fetched the
 * platform's groupings and the store's collections separately would have to
 * join them itself to decide whether a stored row still works, and that join is
 * exactly the judgement (`target_automated` in particular) that must not be
 * restated on a client.
 */
export interface ChannelCollectionsView {
  /** What this platform calls its groupings, for the screen's copy. */
  readonly noun: ExternalTaxonomyNoun;
  /** What the platform publishes today, or why it could not be asked. */
  readonly external: ChannelExternalCollections;
  /** The MANUAL collections of this store a mapping may point at. */
  readonly targets: readonly ChannelCollectionTarget[];
  /** The stored mapping, each row resolved against both ends. */
  readonly mapping: readonly ChannelCollectionMappingRow[];
}
