/**
 * Connector sync service — the write-side engine for external-platform sync.
 *
 * It drives a `ConnectorProvider` (Shopify, …) and materializes pulled products
 * into the store through the EXISTING catalog funnels (`createStoreProduct` /
 * `updateListing`), so denormalized facets + inventory stay consistent. Prices
 * are stored in the shop's NATIVE currency (no FAIR conversion on write).
 *
 * PROVENANCE + OVERRIDES. Every pulled listing carries its origin in the four
 * flat `source_*` columns (`sourceConnectionId`, `sourceProvider`,
 * `sourceExternalId`, `sourceExternalUpdatedAt`) — together the upsert key. On
 * re-sync, when the connection's `conflictPolicy` is `respect_overrides`, any
 * field the merchant locally edited (listed in the listing's `overriddenFields`)
 * is left untouched; `connector_wins` overwrites everything.
 *
 * STORAGE. Everything this service touches is Postgres, through the repositories
 * under `db/` — the catalogue (listings, variants, categories, locations,
 * collection membership, the `listing_external_refs` push mirror), orders, and
 * this service's own `connections` / `sync_runs`.
 *
 * SECURITY. Credentials are decrypted only in-memory here (never returned in a
 * DTO). Every connection-scoped operation is resolved by `{ id, storeId }` so a
 * member of one store can never reach another store's connection (no IDOR). No
 * `req.body` is ever spread — writes use explicit field whitelists.
 *
 * ## Ported to Postgres — what changed in this service, and why
 *
 *  - **The credential envelopes are no longer reachable from a connection.** They
 *    were withheld from the wire by `toConnectionDTO` simply never reading them;
 *    they are PROTECTED columns now, so the row type has no such property and a
 *    serializer that reached for one would fail `tsc`. {@link decryptAuth} makes
 *    a second, explicit read for the envelope — one extra query on the paths that
 *    genuinely decrypt, and none at all on the paths that only needed to know
 *    whether a connection is authorized (`hasCredentials`, a derived boolean).
 *  - **Connect and reconnect are ONE upsert statement** on
 *    `UNIQUE(store_id, provider)` rather than a read-then-branch, so two
 *    concurrent OAuth callbacks for one shop merge instead of one of them failing
 *    on the unique index.
 *  - **Disconnect clears all six credential columns together.** The
 *    `num_nonnulls(...) in (0, 3)` CHECKs make a half-cleared envelope
 *    unrepresentable, which is what the `$unset` pair used to leave to
 *    discipline.
 *  - **A `SyncRun` is opened and then closed, in two statements.** The Mongoose
 *    path mutated an in-memory document and saved it once at the end; only those
 *    two writes ever reached the database, so the tallies stay a plain object in
 *    this service — which is also what the live `sync:progress` ticks read — and
 *    the run returned to the caller is the row that was actually persisted.
 *  - **`collectionMapping` is a plain `Record`, not a `Map`.** It is one jsonb
 *    value; nothing queries it by key in SQL, and the DTO already carried a
 *    `Record`.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AddressSnapshot,
  ChannelCollectionMappingRow,
  ChannelCollectionMappingState,
  ChannelCollectionsView,
  ChannelDisconnectPolicy,
  ChannelExternalCollections,
  ChannelOrderHorizon,
  Connection as ConnectionDTO,
  ConnectionWebhookFailure,
  ConnectionWebhookRegistration,
  ConnectorProviderId,
  ConnectorWebhookFailureReason,
  CreateStoreProductInput,
  CreateStoreProductVariantInput,
  CurrencyCode,
  Money,
  SyncProgressEvent,
  SyncRecordFailure,
  SyncRunCounts,
  SyncRun as SyncRunDTO,
  SyncRunRecordFailurePage,
  SyncResourceDirection,
  SyncSettings as SyncSettingsDTO,
  UpdateListingInput,
  UpdateSyncSettingsInput,
} from '@mercaria/shared-types';
import {
  ALL_CURRENCY_CODES,
  ALL_LISTING_STATUSES,
  CONNECTOR_WEBHOOK_RETRYABLE_FAILURE_REASONS,
} from '@mercaria/shared-types';
import { isForeignKeyViolation, isUniqueViolation } from '@oxyhq/db';
import {
  claimConnectionWebhookRegistration,
  completeConnectionWebhookRegistration,
  disconnectConnection,
  findConnection,
  findConnectionById,
  findConnectionByProvider,
  findConnectionCredentials,
  findConnectionIdsByShopDomain,
  findConnectionsByStore,
  findConnectionsNeedingWebhookRegistration,
  findConnectionsToAuditWebhooks,
  findConnectionWebhookFailures,
  findConnectionWebhookSecret,
  findPullConnectionsToReconcile,
  findPushConnections,
  markConnectionError,
  markConnectionSynced,
  recordConnectionWebhookRegistration,
  releaseConnectionWebhookRegistration,
  touchConnectionLastSync,
  updateSyncSettings as updateSyncSettingsColumns,
  upsertConnection,
  type ConnectionRow,
  type UpdatedConnectionRow,
} from '../db/connectors/connectionRepository.js';
import {
  finishSyncRun,
  findSyncRunForConnection,
  insertSyncRun,
  type SyncRunRecord,
  type SyncRunRecordFailure,
} from '../db/connectors/syncRunRepository.js';
import {
  listSyncRunRecordFailures,
  SYNC_RUN_RECORD_FAILURE_MAX_ROWS,
  type SyncRunRecordFailureRow,
} from '../db/connectors/syncRunRecordFailureRepository.js';
import {
  findOrderById,
  findOrderBySourceExternalId,
  insertOrder,
  nextOrderNumber,
  updateOrderFromSource,
  type NewOrder,
  type NewOrderAppliedDiscount,
  type NewOrderItem,
  type NewOrderSource,
  type NewOrderTaxLine,
} from '../db/orders/orderRepository.js';
import {
  findListingById,
  findListingBySourceExternalId,
  findListingChildren,
  findListingsBySourceConnection,
  setListingStatusIfIn,
  updateListingColumns,
  type ListingImageRecord,
  type ListingOptionRecord,
  type ListingRecord,
  type ListingSourceProvenance,
} from '../db/catalog/listingRepository.js';
import {
  findVariantBySourceInventoryItemId,
  findVariantOptionValues,
  findVariantsByListing,
  findVariantsBySourceConnection,
  updateVariant as updateVariantColumns,
  type VariantOptionValueRecord,
  type VariantRecord,
  type VariantSourceProvenance,
} from '../db/catalog/variantRepository.js';
import {
  findExternalRefByListingAndConnection,
  listingPushedToConnection,
  upsertExternalRef,
} from '../db/catalog/listingExternalRefRepository.js';
import { categorySlugExists } from '../db/catalog/categoryRepository.js';
import {
  findCollectionMappingTargets,
  findManualCollectionsByStore,
  setListingAutomatedMemberships,
} from '../db/merchandising/collectionRepository.js';
import { findLocation } from '../db/stores/locationRepository.js';
import {
  addVariant,
  createStoreProduct,
  updateListing,
  updateVariant,
  resolveDefaultLocationId,
  type UpdateVariantInput,
} from './catalog-write.service.js';
import { setAvailable } from './inventory.service.js';
import { encryptSecret, decryptSecret } from '../lib/connector-crypto.js';
import { getConnectorProvider, isImplementedProvider } from '../connectors/registry.js';
import { channelTypeForConnection } from './channels/channel-catalog.js';
import { applyPriceRules, type PriceRules } from '../utils/money.js';
import type {
  ConnectorAuth,
  ConnectorCredentials,
  ConnectorProvider,
  NormalizedOrder,
  NormalizedProduct,
  NormalizedVariant,
  PlatformWebhookSubscription,
  PushFulfillment,
  PushProduct,
  PushVariant,
  VariantEnumerationGap,
  WebhookEventKind,
  WebhookRegistrationResult,
} from '../connectors/types.js';
import { config } from '../config/index.js';
import { createOAuthState } from '../connectors/oauth-state.js';
import { assertOnboardingSessionAcceptsConnect } from './channels/channel-onboarding.service.js';
import { getOAuthRedirectUri, getWebhookAddress } from '../connectors/config.js';
import { getShopifyCredentials } from '../connectors/shopify/config.js';
import { classifyShopifyWebhookTopic } from '../connectors/shopify/webhook.js';
import { classifyWooCommerceWebhookTopic } from '../connectors/woocommerce/webhook.js';
import { getIO } from '../socket.js';
import { conflict, notFound, validationError, MercariaError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Product-delete webhook payload (Shopify sends only `{ id }` on delete). */
const webhookDeletePayloadSchema = z.object({ id: z.union([z.number(), z.string()]) });

/** Inventory-level webhook payload — the platform's inventory-item id is the key. */
const webhookInventoryPayloadSchema = z.object({
  inventory_item_id: z.union([z.number(), z.string()]),
});

/**
 * Broadcast a live sync-progress tick to the connection's store room. Best-effort:
 * a no-op when Socket.IO is not initialized (e.g. a worker-only process, or tests),
 * and it never throws into the caller. Membership of the `store:${storeId}` room is
 * enforced server-side at subscribe time (see `socket.ts`).
 */
function emitSyncProgress(storeId: string, event: SyncProgressEvent): void {
  const io = getIO();
  if (!io) {
    return;
  }
  io.to(`store:${storeId}`).emit('sync:progress', event);
}

/** Env var: the Mercaria category slug imported products are filed under (Fase 1). */
const DEFAULT_CATEGORY_ENV = 'CONNECTOR_DEFAULT_CATEGORY_SLUG';

/**
 * The two provider-native decrypted credential blob shapes:
 *  - `{ accessToken }`                 — an OAuth token (Shopify).
 *  - `{ consumerKey, consumerSecret }` — an API key/secret pair (WooCommerce).
 * `decryptAuth` folds both into `ConnectorAuth.accessToken` (the WooCommerce pair
 * joins into the `"consumerKey:consumerSecret"` HTTP Basic userinfo the provider
 * base64-encodes), so every downstream data path stays provider-agnostic. The two
 * shapes are disjoint, so a sequential `safeParse` picks the right one unambiguously.
 */
const oauthCredentialsSchema = z.object({ accessToken: z.string().min(1) });
const apiKeyCredentialsSchema = z.object({
  consumerKey: z.string().min(1),
  consumerSecret: z.string().min(1),
});

/** True when a raw currency string is a supported Mercaria `CurrencyCode`. */
function isSupportedCurrency(code: string): code is CurrencyCode {
  return (ALL_CURRENCY_CODES as readonly string[]).includes(code);
}

/**
 * The connector price transform, rebuilt from its two columns.
 *
 * An embedded `priceRules` object was PRESENT or ABSENT; the columns are
 * independently nullable, so "no rules" is now both columns null. Returning
 * `undefined` in that case is what keeps `applyPriceRules` a no-op rather than
 * applying a rules object whose every field happens to be undefined.
 *
 * Exported for `channel-ingest.service`, which applies the SAME transform to a
 * pushed-in price and reads the same two columns — the ingest side already
 * imports its category and location resolvers from here for the same reason.
 */
export function toPriceRules(conn: ConnectionRow): PriceRules | undefined {
  const markupPercent = conn.syncSettingsPriceRulesMarkupPercent;
  const rounding = conn.syncSettingsPriceRulesRounding;
  if (markupPercent === null && rounding === null) {
    return undefined;
  }
  return {
    ...(markupPercent !== null ? { markupPercent } : {}),
    ...(rounding !== null ? { rounding } : {}),
  };
}

/** Map a connection's flat `sync_settings_*` columns to the wire DTO. */
function toSyncSettingsDTO(conn: ConnectionRow): SyncSettingsDTO {
  const dto: SyncSettingsDTO = {
    products: conn.syncSettingsProducts,
    inventory: conn.syncSettingsInventory,
    orders: conn.syncSettingsOrders,
    autoPublish: conn.syncSettingsAutoPublish,
    conflictPolicy: conn.syncSettingsConflictPolicy,
  };
  if (conn.syncSettingsTargetLocationId) {
    dto.targetLocationId = conn.syncSettingsTargetLocationId;
  }
  const priceRules = toPriceRules(conn);
  if (priceRules) {
    dto.priceRules = priceRules;
  }
  const mapping = conn.syncSettingsCollectionMapping;
  if (mapping && Object.keys(mapping).length > 0) {
    dto.collectionMapping = { ...mapping };
  }
  return dto;
}

/**
 * Map a `connections` row to its wire DTO.
 *
 * It never included credentials and now it CANNOT: {@link ConnectionRow} is read
 * through `publicColumns`, so the six envelope columns are absent from the type
 * and a line added here that tried to serialize one would fail `tsc`.
 *
 * `webhookFailures` is a PARAMETER rather than something read here, because it
 * lives on a child table and every caller has a LIST of connections — reading it
 * inside would make a merchant's channels screen an N+1. It defaults to none, so
 * a caller that has not read them serializes a connection with no refused
 * topics rather than a wrong one.
 */
export function toConnectionDTO(
  conn: ConnectionRow,
  webhookFailures: readonly ConnectionWebhookFailure[] = [],
): ConnectionDTO {
  const dto: ConnectionDTO = {
    id: conn.id,
    storeId: conn.storeId,
    provider: conn.provider,
    mode: conn.mode,
    status: conn.status,
    scopes: [...conn.scopes],
    // #380. Both DERIVED from columns on this row, in the one place a row
    // becomes a DTO: the channel type through the single function that reads
    // `(provider, mode)` as one, and the horizon through the provider's own rule
    // applied to the grant this connection holds. Neither is stored — the
    // connector that owns the order bound says outright that a stored copy could
    // only disagree with `scopes` — and computing both from the same row in the
    // same statement is what stops them disagreeing with it here either.
    channelType: channelTypeForConnection(conn),
    orderHorizon: deriveOrderHorizon(conn),
    syncSettings: toSyncSettingsDTO(conn),
    webhookIds: [...conn.webhookIds],
    connectedAt: conn.connectedAt.toISOString(),
  };
  if (conn.externalShopId) {
    dto.externalShopId = conn.externalShopId;
  }
  if (conn.shopDomain) {
    dto.shopDomain = conn.shopDomain;
  }
  if (conn.shopCurrency) {
    dto.shopCurrency = conn.shopCurrency;
  }
  if (conn.lastSyncAt) {
    dto.lastSyncAt = conn.lastSyncAt.toISOString();
  }
  // #87: the pause axes, as the SET a client needs rather than the two instants
  // the row stores. Omitted when nothing is paused, so an older client reading
  // no field behaves exactly as it did.
  const pausedScopes: ('fetch' | 'publication')[] = [];
  if (conn.fetchPausedAt) pausedScopes.push('fetch');
  if (conn.publicationPausedAt) pausedScopes.push('publication');
  if (pausedScopes.length > 0) {
    dto.pausedScopes = pausedScopes;
  }
  if (conn.disconnectPolicy && conn.disconnectedAt) {
    dto.disconnectPolicy = conn.disconnectPolicy;
    dto.disconnectedAt = conn.disconnectedAt.toISOString();
  }
  // #218: the topics that will NOT deliver, named. Omitted when there are none,
  // so a healthy connection serializes exactly as it did before.
  if (webhookFailures.length > 0) {
    dto.webhookFailures = webhookFailures.map((failure) => ({ ...failure }));
  }
  // #262: where the registration stands — and since #297 that includes the
  // SUCCESS, so it is always present rather than omitted in the healthy case. The
  // field stays optional on the wire: a client that ignores it behaves as it did,
  // and one that reads it now gets `registered` where it previously got silence
  // and had to infer health from the absence of a field. No provider error text:
  // a refusal names topics and reasons, and the free-form message a thrown
  // registration produces stays in the log.
  dto.webhookRegistration = toWebhookRegistrationDTO(conn);
  return dto;
}

/**
 * How far back THIS connection's order import reaches (#380).
 *
 * Three cases and each is a different fact. A `push_in` connection is the
 * WooCommerce plugin, which exchanges no orders at all — a horizon over
 * something that never arrives would be a bound on nothing. A provider this
 * deployment no longer implements answers `unknown` rather than throwing: the
 * row exists, a serializer must not refuse it, and `complete` or `not_synced`
 * would both be claims about a connector nobody can read. Otherwise the provider
 * applies its own rule to the scopes the platform GRANTED.
 */
function deriveOrderHorizon(conn: ConnectionRow): ChannelOrderHorizon {
  if (conn.mode === 'push_in') return { kind: 'not_synced' };
  if (!isImplementedProvider(conn.provider)) return { kind: 'unknown' };
  return getConnectorProvider(conn.provider).orderHistoryHorizon(conn.scopes);
}

/**
 * The #262 registration state, always.
 *
 * It used to return `undefined` for `pending` with nothing attempted and nothing
 * scheduled, which was the only way a HEALTHY connection avoided serializing as
 * "pending" — a successful registration wrote that value, so the state could not
 * be shown without the special case denying it. #297 gave the column a success
 * value, so the reason is gone and the case goes with it: the DTO now reports the
 * stored fact and the client decides what to say about it.
 *
 * The judgement that lived here moved to the dashboard's `deriveWebhookDelivery`,
 * which is where it belongs — "is Mercaria mid-retry" is a sentence about a
 * merchant's channel, not a property of the row. Note the two are NOT the same
 * predicate any more: this used to hide a never-attempted connection too, and
 * that one now renders through the `webhook_ids` branch as "not registered yet",
 * which is what it actually is.
 */
function toWebhookRegistrationDTO(conn: ConnectionRow): ConnectionWebhookRegistration {
  return {
    state: conn.webhookRegistrationState,
    attempts: conn.webhookRegistrationAttempts,
    ...(conn.webhookRegistrationNextAttemptAt
      ? { nextAttemptAt: conn.webhookRegistrationNextAttemptAt.toISOString() }
      : {}),
  };
}

/** Map a `sync_runs` row to its wire DTO — the four tally columns re-nested. */
export function toSyncRunDTO(run: SyncRunRecord): SyncRunDTO {
  const dto: SyncRunDTO = {
    id: run.id,
    connectionId: run.connectionId,
    kind: run.kind,
    status: run.status,
    counts: {
      created: run.countsCreated,
      updated: run.countsUpdated,
      skipped: run.countsSkipped,
      failed: run.countsFailed,
    },
    startedAt: run.startedAt.toISOString(),
  };
  if (run.finishedAt) {
    dto.finishedAt = run.finishedAt.toISOString();
  }
  if (run.error) {
    dto.error = run.error;
  }
  return dto;
}

/**
 * How many per-record reasons ONE page of the merchant read carries.
 *
 * Equal to the writer's own cap, so the two elisions cannot compound: a run
 * never stores more than this, so a full page means the LIST was cut here and
 * nowhere else, and a short page means the run stored fewer — which is either
 * retention or the write cap, and the run's own `failedCount` beside it is what
 * distinguishes those from "that is all there was".
 */
export const RECORD_FAILURE_PAGE_LIMIT = SYNC_RUN_RECORD_FAILURE_MAX_ROWS;

/** Map a `sync_run_record_failures` row to its wire DTO. */
function toSyncRecordFailureDTO(row: SyncRunRecordFailureRow): SyncRecordFailure {
  const dto: SyncRecordFailure = {
    id: row.id,
    subjectType: row.subjectType,
    reason: row.reasonCode,
    detail: row.detail,
    at: row.createdAt.toISOString(),
  };
  // Absent rather than empty: the platform published no id, and `''` would read
  // as an id nobody can search for.
  if (row.externalId) {
    dto.externalId = row.externalId;
  }
  return dto;
}

/**
 * One run's per-record failures, for the channel screen (#303).
 *
 * A SEPARATE call rather than a field on the run list, and the reason is the
 * shape of the list: fifty runs each carrying up to two hundred reasons is a
 * payload nobody asked for and a per-run query is the N+1 #70 made
 * unrepresentable in its own domain. The trigger a client keys on is the run's
 * own `counts.failed`, which the list already carries.
 *
 * The run is resolved SCOPED to the connection, so a run id belonging to another
 * store's connection is a 404 and never somebody else's failures. The caller has
 * already established that the CONNECTION belongs to the store.
 */
export async function readSyncRunRecordFailures(
  connectionId: string,
  runId: string,
): Promise<SyncRunRecordFailurePage> {
  const run = await findSyncRunForConnection(connectionId, runId);
  if (!run) {
    throw notFound('Sync run not found');
  }
  const rows = await listSyncRunRecordFailures(runId, RECORD_FAILURE_PAGE_LIMIT);
  return {
    runId: run.id,
    failedCount: run.countsFailed,
    failures: rows.map(toSyncRecordFailureDTO),
    limitReached: rows.length >= RECORD_FAILURE_PAGE_LIMIT,
  };
}

/**
 * List a store's connections (no credentials).
 *
 * The refused webhook topics are read in ONE batched statement for the whole
 * list — see {@link toConnectionDTO} for why they are not read per connection.
 */
export async function listConnections(storeId: string): Promise<ConnectionDTO[]> {
  const connections = await findConnectionsByStore(storeId);
  const failures = await findConnectionWebhookFailures(connections.map((conn) => conn.id));
  return connections.map((conn) => toConnectionDTO(conn, failures.get(conn.id) ?? []));
}

/** One connection's DTO, with the topics its last registration could not subscribe. */
export async function toConnectionDTOWithWebhookFailures(
  conn: ConnectionRow,
): Promise<ConnectionDTO> {
  const failures = await findConnectionWebhookFailures([conn.id]);
  return toConnectionDTO(conn, failures.get(conn.id) ?? []);
}

/** Resolve the OAuth scopes to request for `providerId` (provider-specific config). */
function resolveAuthorizeScopes(providerId: ConnectorProviderId): string[] {
  switch (providerId) {
    case 'shopify':
      return getShopifyCredentials().scopes;
    default:
      throw notFound(`Connector provider not available: ${providerId}`);
  }
}

/**
 * Build the platform authorize URL to redirect the merchant to. Mints a signed
 * `state` bound to `{ storeId, provider, userId, shopDomain }` — plus the wizard
 * session, when the connect was started from one — that the public callback
 * re-validates. `storeId`/`userId` are resolved server-side (never from a request
 * body).
 *
 * `onboardingSessionId` is the ONE claim that comes from the client, and it is
 * checked against this store BEFORE it is signed, so the callback acts on a
 * session a member of this store demonstrably chose. It is not the security
 * boundary — the store scope on the callback's own patch is — but it is what puts
 * a refusal in the request the merchant is watching rather than leaving the
 * wizard to stall silently after the platform answers.
 */
export async function buildConnectAuthorizeUrl(params: {
  storeId: string;
  providerId: ConnectorProviderId;
  userId: string;
  shopDomain: string;
  onboardingSessionId?: string;
}): Promise<string> {
  const provider = getConnectorProvider(params.providerId);
  if (provider.credentialStrategy !== 'oauth') {
    throw validationError(`Provider ${params.providerId} does not support OAuth connect`);
  }
  if (params.onboardingSessionId !== undefined) {
    await assertOnboardingSessionAcceptsConnect({
      storeId: params.storeId,
      sessionId: params.onboardingSessionId,
      providerId: params.providerId,
    });
  }
  const state = createOAuthState({
    storeId: params.storeId,
    provider: params.providerId,
    userId: params.userId,
    shopDomain: params.shopDomain,
    onboardingSessionId: params.onboardingSessionId,
  });
  return provider.buildAuthorizeUrl({
    shopDomain: params.shopDomain,
    redirectUri: getOAuthRedirectUri(params.providerId),
    state,
    scopes: resolveAuthorizeScopes(params.providerId),
  });
}

/** Mint a fresh per-connection webhook secret (256 bits of entropy, hex-encoded). */
function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Where a registration attempt's per-connection secret comes from (#262).
 *
 * - **`mint`** — a fresh secret, which is what a CONNECT wants: there may be no
 *   stored envelope at all, and rotating on a re-authorization is hygiene.
 * - **`reuse_stored`** — the secret already stored, falling back to a fresh one
 *   when none is. This is what a RE-REGISTRATION wants, and it removes a window
 *   rather than saving a call. A `per_connection` provider recreates every topic,
 *   so a fresh secret makes every delivery that WooCommerce had already queued
 *   under the old one 401 until the swap lands, and Mercaria has no
 *   previous-secret grace for a connection the way it does for Stripe and
 *   CrowdSource. Recreating with the SAME secret leaves the stored envelope
 *   verifying survivors and recreations alike, so nothing 401s at all.
 *
 * The residual gap is named rather than closed: the CONNECT path still mints, so
 * a reconnect keeps the sub-second window #218 already had. Closing it needs a
 * `previous` envelope plus a grace deadline on the connection and a change to the
 * inbound verification — a separate change, and one this path no longer needs.
 */
type WebhookSecretPolicy = 'mint' | 'reuse_stored';

/**
 * What one registration attempt concluded, in the terms the RETRY has to act on.
 *
 * A STRING discriminant, because this backend compiles with `strict: false` and
 * without `strictNullChecks` TypeScript does not narrow a union on a
 * boolean-literal one — a caller testing `!attempt.registered` would be left
 * holding the whole union.
 *
 *  - **`registered`** — the platform's list was read and nothing is refused.
 *    There is no work left, so the attempt counter resets.
 *  - **`retryable`** — something is refused that a later attempt could take, the
 *    platform's list was unreadable for a reason that may pass, or the attempt
 *    threw. An unclassified throw counts as retryable for the moderation
 *    outbox's reason: assuming a defect is permanent is how a recoverable outage
 *    becomes work nobody ever retries.
 *  - **`terminal`** — every remaining refusal is one no retry can fix. Spending
 *    the budget on it would delay nothing but itself and knock at a door only the
 *    merchant can open.
 */
type WebhookRegistrationDisposition = 'registered' | 'retryable' | 'terminal';

/** One registration attempt: the row it left behind, and what to do next. */
interface WebhookRegistrationAttempt {
  readonly connection: ConnectionRow;
  readonly disposition: WebhookRegistrationDisposition;
}

/** Whether an automatic retry could ever take a topic refused for `reason`. */
function isRetryableWebhookFailure(reason: ConnectorWebhookFailureReason): boolean {
  return (CONNECTOR_WEBHOOK_RETRYABLE_FAILURE_REASONS as readonly string[]).includes(reason);
}

/**
 * Register the provider's webhooks for a connection and persist EVERYTHING the
 * attempt left behind — the ids, the secret they were registered with, and the
 * topics the platform refused — in one write (#218), reporting what the RETRY
 * should do next (#262).
 *
 * This is the ONE implementation, and every caller reaches it: both connect paths,
 * the scheduled sweep and the merchant's own re-register. #262 added the callers
 * and the bookkeeping around them and nothing here — two paths establishing one
 * connection's webhook state could disagree, and the disagreement would surface as
 * a shop whose events silently stop arriving.
 *
 * For a `per_connection` provider (WooCommerce) the secret is resolved by
 * {@link WebhookSecretPolicy} — minted on a connect, REUSED on a re-registration —
 * passed to the provider (which sets it on every webhook it creates) and stored
 * ENCRYPTED for inbound verification; `app_secret` providers (Shopify) verify
 * with the app secret and store nothing here.
 *
 * ## What #218 changed, and why each half matters
 *
 * The provider no longer throws on the first refused topic: it returns both
 * lists, so a partial registration PERSISTS the subscriptions that exist rather
 * than discarding them. That is what makes disconnect able to delete them and a
 * retry able to converge — and on WooCommerce it is what stops the secret being
 * lost beside the ids, which turned every delivery into a permanent 401.
 *
 * The stale-webhook delete this used to perform first is GONE, and its
 * disappearance is the fix rather than a simplification: it deleted
 * `conn.webhookIds`, which on a connection broken by this very bug is EMPTY
 * while live subscriptions keep delivering. The provider now reconciles against
 * the platform's own list, which is a superset of what Mercaria believes it
 * created and therefore the only thing that converges an already-orphaned shop.
 *
 * The ids it persists are therefore the platform's whole truth about our address
 * — created here, adopted, or left behind by a delete the platform refused — and
 * never only "what this attempt made". An attempt that could not READ that list
 * writes NO ids at all rather than an empty set: the `unknown` branch is what
 * stops "I could not find out" being stored as "there are none", which is the
 * erasure that made a later disconnect delete nothing.
 *
 * The secret is written only when at least one subscription was CREATED with it
 * (`origin`), never merely because subscriptions exist: an attempt that created
 * none must not replace the envelope that still verifies whatever survived.
 *
 * Best-effort: a THROWN registration (a provider bug, a missing secret) logs and
 * leaves the connection working WITHOUT real-time sync — backfill and the
 * scheduled re-sync still apply, and it never fails the connect. It is also the
 * ONE branch that writes nothing at all, which is why #262's derived population
 * has to read an empty `webhook_ids` as well as the refused topics: a throw leaves
 * no refusal to find.
 *
 * @returns The connection carrying the ids that were just registered (or the one
 *   it was given when nothing was written), and what the retry should do next. The
 *   connect paths serialize the connection into their response, so returning the
 *   refreshed row is what keeps the response in step with the database — the
 *   Mongoose path assigned `conn.webhookIds` on the in-memory document for exactly
 *   that reason.
 */
async function attemptWebhookRegistration(
  conn: ConnectionRow,
  auth: ConnectorAuth,
  secretPolicy: WebhookSecretPolicy,
): Promise<WebhookRegistrationAttempt> {
  const provider = getConnectorProvider(conn.provider);
  try {
    const secret =
      provider.webhookSecretStrategy === 'per_connection'
        ? await resolveWebhookSecret(conn, secretPolicy)
        : undefined;
    const result = await provider.registerWebhooks(auth, {
      address: getWebhookAddress(conn.provider),
      connectionId: conn.id,
      // The ids Mercaria has recorded, so the reconcile can recognise a
      // subscription of ours that the delivery ADDRESS moved away from (#295).
      // `conn.webhookIds` and never a re-read: the row is the one the caller
      // claimed, and the reconcile is about to overwrite exactly this column.
      ownedSubscriptionIds: conn.webhookIds,
      ...(secret !== undefined ? { secret } : {}),
    });
    const failures = result.failures.map((failure) => ({
      topic: failure.topic,
      reason: failure.reason,
      ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
    }));
    const created =
      result.outcome === 'reconciled' &&
      result.subscriptions.some((subscription) => subscription.origin === 'created');
    const updated = await recordConnectionWebhookRegistration(conn.id, {
      ...(result.outcome === 'reconciled'
        ? {
            outcome: 'reconciled' as const,
            webhookIds: result.subscriptions.map((subscription) => subscription.id),
          }
        : { outcome: 'unknown' as const }),
      ...(secret !== undefined && created ? { secret: encryptSecret(secret) } : {}),
      failures,
    });
    if (result.outcome === 'unknown') {
      log.general.warn(
        {
          connectionId: conn.id,
          reason: result.reason,
          ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
        },
        'Could not read the platform webhook list — the stored subscription ids are left as they were',
      );
    } else if (result.failures.length > 0) {
      // The topics, never the reason alone: "which events will not arrive" is
      // the operator's question, and the persisted rows are what a merchant
      // surface renders. The log line is for the incident, not for the merchant.
      log.general.warn(
        {
          connectionId: conn.id,
          registered: result.subscriptions.length,
          refused: result.failures.map((failure) => `${failure.topic}:${failure.reason}`),
        },
        'Connector webhook registration was refused for some topics',
      );
    }
    return { connection: updated ?? conn, disposition: dispositionOf(result) };
  } catch (err) {
    log.general.warn(
      { err, connectionId: conn.id },
      'Failed to register connector webhooks (real-time sync disabled for this connection)',
    );
    // NOTHING was written — not the ids, not the refusals — so the only trace is
    // an empty `webhook_ids`, which is exactly the half of #262's derived
    // population that exists for this branch. `retryable` because the error is
    // unclassified: treating an unclassified defect as permanent is how a
    // recoverable outage becomes a channel nobody ever retries.
    return { connection: conn, disposition: 'retryable' };
  }
}

/**
 * The secret a `per_connection` registration will create its subscriptions with.
 *
 * `reuse_stored` falls back to a fresh secret when there is no envelope, which is
 * the ordinary state for the branch #262 exists to recover: a registration that
 * threw stored nothing at all.
 */
async function resolveWebhookSecret(
  conn: ConnectionRow,
  policy: WebhookSecretPolicy,
): Promise<string> {
  if (policy === 'mint') {
    return generateWebhookSecret();
  }
  const envelope = await findConnectionWebhookSecret(conn.id, conn.provider);
  return envelope ? decryptSecret(envelope) : generateWebhookSecret();
}

/**
 * Classify what the provider answered, in the terms the retry acts on.
 *
 * An `unknown` outcome is classified on the LISTING's own reason rather than being
 * retryable by default: a revoked credential answers 403 to the list every time,
 * and spending the budget on it is the same noise as spending it on a refused
 * topic for the same reason.
 */
function dispositionOf(result: WebhookRegistrationResult): WebhookRegistrationDisposition {
  if (result.outcome === 'unknown') {
    return isRetryableWebhookFailure(result.reason) ? 'retryable' : 'terminal';
  }
  if (result.failures.length === 0) {
    return 'registered';
  }
  return result.failures.some((failure) => isRetryableWebhookFailure(failure.reason))
    ? 'retryable'
    : 'terminal';
}

/**
 * The CONNECT path's registration: mint a fresh secret, ignore the disposition.
 *
 * A connect stays best-effort — a refused registration leaves the connection
 * working on backfill plus the scheduled re-sync and never fails the connect —
 * and it deliberately writes NONE of the #262 retry bookkeeping, because
 * `upsertConnection` has just reset it and the connect holds no lease to write an
 * outcome against. The sweep picks the refusal up on its next tick with a full
 * attempt budget, which is the right budget for a registration nobody has retried
 * yet.
 */
async function registerConnectionWebhooks(
  conn: ConnectionRow,
  auth: ConnectorAuth,
): Promise<ConnectionRow> {
  const attempt = await attemptWebhookRegistration(conn, auth, 'mint');
  return attempt.connection;
}

/**
 * Automatic attempts after which a retryable refusal is treated as permanent.
 *
 * With the backoff below that is roughly a day of trying: enough to absorb a
 * platform outage, and short enough that a channel with no real-time sync reaches
 * a VISIBLE `dead_letter` while somebody could still connect it to the week it
 * happened. Shorter than the moderation outbox's twenty-five because the artefact
 * differs — an undelivered abuse report has nowhere else to go, whereas a
 * connection that cannot subscribe still syncs on the scheduled re-pull and its
 * merchant is already told which events will not arrive.
 */
const MAX_WEBHOOK_REGISTRATION_ATTEMPTS = 12;

/** Base and ceiling of the re-registration backoff. */
const WEBHOOK_REGISTRATION_BACKOFF_BASE_MS = 60_000;
const WEBHOOK_REGISTRATION_MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;

/** Capped exponential backoff, the `moderation_outboxes` curve at a coarser base. */
function webhookRegistrationNextAttemptAt(attempts: number, now: Date): Date {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return new Date(
    now.getTime() +
      Math.min(
        WEBHOOK_REGISTRATION_BACKOFF_BASE_MS * 2 ** exponent,
        WEBHOOK_REGISTRATION_MAX_BACKOFF_MS,
      ),
  );
}

/** What one re-registration run concluded, for the log and for the sweep's tally. */
export type WebhookReregistrationOutcome =
  | 'registered'
  | 'retry_scheduled'
  | 'dead_lettered'
  | 'not_claimed'
  | 'not_registerable';

/**
 * Re-register ONE connection's webhooks (#262) — the whole of the missing trigger.
 *
 * `registerConnectionWebhooks` was already the RECONCILING path: it calls
 * `provider.registerWebhooks`, which every provider implements through
 * `reconcileWebhookSubscriptions` — adopting on Shopify, recreating on WooCommerce,
 * converging a shop that is already carrying orphans. #262 is not a second
 * implementation of any of that, and deliberately is not: two paths establishing
 * one connection's webhook state could disagree, and the disagreement would be
 * invisible until a merchant noticed their prices had stopped moving. What this
 * adds is the CLAIM, the outcome bookkeeping and the callers.
 *
 * The lease is taken FIRST and released last, and it is the reason this function
 * exists rather than the sweep calling the registration directly. Two passes
 * registering one connection concurrently — a merchant pressing retry while the
 * sweep is mid-flight is the realistic case — delete and recreate every topic
 * twice on a `per_connection` provider, and the pass that finishes LAST stores its
 * secret over the other's while the other's subscriptions are the live ones. Every
 * delivery then 401s, permanently, with nothing in the data saying why.
 *
 * @param countsAsAttempt `true` for the sweep, whose attempts the budget bounds;
 *   `false` for a merchant's own request, which must be admissible on a connection
 *   the sweep has given up on and must not spend from a budget it does not own.
 */
export async function reregisterConnectionWebhooks(
  storeId: string,
  connectionId: string,
  options: { countsAsAttempt: boolean; now?: Date },
): Promise<WebhookReregistrationOutcome> {
  const now = options.now ?? new Date();
  const existing = await findConnection(storeId, connectionId);
  if (!existing) {
    throw notFound('Connection not found');
  }
  // The same three preconditions `decryptAuth` and the two connect paths carry.
  // Answered as an OUTCOME rather than thrown, because the sweep reaches this
  // through a population that already excluded them and a merchant reaching it is
  // answered by `requestWebhookReregistration`'s own refusal.
  if (existing.mode !== 'pull' || !existing.hasCredentials || !existing.shopDomain) {
    return 'not_registerable';
  }

  const leaseOwner = `connector-webhooks:${process.pid}:${randomUUID()}`;
  const claimed = await claimConnectionWebhookRegistration({
    connectionId,
    leaseOwner,
    leaseMs: config.connectors.webhookReregistrationLeaseMs,
    countsAsAttempt: options.countsAsAttempt,
    now,
  });
  if (!claimed) {
    // Somebody else holds a live claim. Not an error and not a retry: the pass
    // that holds it is doing exactly this work.
    log.general.debug(
      { connectionId },
      'Webhook re-registration is already in flight for this connection',
    );
    return 'not_claimed';
  }

  const attempt = await attemptRegistrationFor(claimed);
  if (attempt.disposition === 'registered') {
    const completed = await completeConnectionWebhookRegistration(connectionId, leaseOwner);
    if (!completed) {
      // The lease expired and was reclaimed, or a reconnect reset it. The work
      // itself landed — the ids and the refusals are written by the registration's
      // own transaction — so this is bookkeeping the owner check correctly refused.
      log.general.warn(
        { connectionId },
        'Webhook re-registration succeeded but its lease was no longer owned',
      );
    }
    return 'registered';
  }

  // `claimed.webhookRegistrationAttempts` already includes this attempt for the
  // sweep (the claim incremented it) and is the untouched stored count for an
  // on-demand run — so an exhausted connection gets exactly ONE hand-driven
  // attempt and does not re-arm the loop unless it succeeds.
  const deadLettered =
    attempt.disposition === 'terminal' ||
    claimed.webhookRegistrationAttempts >= MAX_WEBHOOK_REGISTRATION_ATTEMPTS;
  await releaseConnectionWebhookRegistration({
    connectionId,
    leaseOwner,
    deadLettered,
    nextAttemptAt: deadLettered
      ? null
      : webhookRegistrationNextAttemptAt(claimed.webhookRegistrationAttempts, now),
    now,
  });
  if (deadLettered) {
    log.general.warn(
      {
        connectionId,
        attempts: claimed.webhookRegistrationAttempts,
        disposition: attempt.disposition,
      },
      'Webhook re-registration has stopped retrying — the refused topics need a merchant or an operator',
    );
  }
  return deadLettered ? 'dead_lettered' : 'retry_scheduled';
}

/**
 * Resolve the credential and run the registration, REUSING the stored secret.
 *
 * Split out so the credential read and the throw it can produce are inside the
 * lease: a connection whose envelope will not decrypt is a real re-registration
 * failure that the backoff and the attempt budget must see, not an exception that
 * escapes past the release and strands the claim until it expires.
 */
async function attemptRegistrationFor(conn: ConnectionRow): Promise<WebhookRegistrationAttempt> {
  try {
    const auth = await decryptAuth(conn);
    return await attemptWebhookRegistration(conn, auth, 'reuse_stored');
  } catch (err) {
    log.general.warn(
      { err, connectionId: conn.id },
      'Could not resolve a credential to re-register connector webhooks',
    );
    return { connection: conn, disposition: 'retryable' };
  }
}

/**
 * One thing an audit found wrong with a subscription Mercaria created (#295).
 *
 * Each names a DIFFERENT fact about the same stored id, and they are kept apart
 * because they arise differently even though the remedy is one: a subscription
 * the platform no longer lists was deleted by somebody, one delivering
 * elsewhere is what a change of `CONNECTOR_OAUTH_REDIRECT_BASE_URL` leaves, and
 * one the platform disabled is what too many failed deliveries produce. An
 * operator reading a log line needs to know which.
 */
export type ConnectionWebhookAuditFinding =
  /** A stored id the platform no longer lists at all. */
  | 'subscription_missing'
  /** A stored id delivering to an address this deployment no longer serves. */
  | 'delivery_address_moved'
  /** A stored id at the right address that the platform has stopped delivering. */
  | 'subscription_disabled';

/** What one audit concluded, and what it did about it. */
export type ConnectionWebhookAuditOutcome =
  /** Every stored id is live, at the address we serve, and delivering. */
  | 'healthy'
  /** Not a connection with webhooks to audit (mode, credentials, shop domain). */
  | 'not_registerable'
  /** No ids recorded — #262's own population, and NOT this detector's business. */
  | 'nothing_registered'
  /** The platform would not say what it holds, so nothing was concluded. */
  | 'unreadable'
  /** Findings, and a re-registration was driven. */
  | 'repair_requested'
  /** Findings, and the connection had already stopped retrying. */
  | 'repair_withheld';

/** The whole of what one audit observed — returned so a caller can assert on it. */
export interface ConnectionWebhookAudit {
  readonly outcome: ConnectionWebhookAuditOutcome;
  /** Deduplicated and sorted, so two runs over one shop read identically. */
  readonly findings: readonly ConnectionWebhookAuditFinding[];
  /**
   * The highest consecutive-failure count the platform published for any
   * subscription of ours, when it publishes one at all.
   *
   * EVIDENCE and never a trigger — see `PlatformWebhookSubscription.failureCount`
   * for why a re-registration keyed on it would churn every merchant's
   * subscriptions over a blip it cannot fix.
   */
  readonly maxFailureCount?: number;
  /** What the re-registration concluded, when one ran. */
  readonly repair?: WebhookReregistrationOutcome;
}

/**
 * AUDIT one connection's live webhook subscriptions against what Mercaria
 * believes it registered, and drive a repair when they disagree (#295).
 *
 * ## The blind spot this exists to close
 *
 * #262's sweep derives its population from Mercaria's own rows: an empty
 * `webhook_ids`, or a topic the platform refused. A subscription that registered
 * CLEANLY and was later killed on the platform's side is invisible to it by
 * construction, and there is no derivation over local rows that could see it —
 * `webhook_ids` is full and nothing was refused. The commonest way it happens is
 * a change of `CONNECTOR_OAUTH_REDIRECT_BASE_URL`: deliveries start failing
 * against a hostname that no longer serves, WooCommerce disables the
 * subscriptions itself past five failures, and they stay disabled after the
 * address is fixed. It is quiet in BOTH directions — Mercaria sees no
 * deliveries, and "no events happened" is indistinguishable from "the
 * subscriptions are dead" without asking the platform.
 *
 * ## Evidence, never a schedule of re-registrations
 *
 * The ONLY repair trigger is a stored id the platform contradicts. A shop whose
 * subscriptions are all live, at the address we serve and delivering is left
 * completely alone — no delete, no create, no attempt spent — which is what
 * makes running this on every connection every six hours affordable, and what
 * stops it becoming the "re-register everything on a schedule" that
 * `findConnectionsNeedingWebhookRegistration` refuses to be.
 *
 * ## The three things it deliberately does not treat as evidence
 *
 * An EMPTY `webhook_ids` is not a finding here: it is #262's own population, and
 * reporting it would give one state two owners. An UNREADABLE list is not a
 * finding: a re-registration would fail at the same list call and spend an
 * attempt saying so. And a subscription at a foreign address that Mercaria holds
 * no id for is not visible as ours at all — see `webhook-registration.ts` for
 * why the evidence is an id rather than a URL shape.
 *
 * ## A `dead_letter` is a stop, and a detector must not restart it
 *
 * #262 dead-letters a connection whose refusals a retry cannot fix, and that is
 * a deliberate end to the automatic loop. Firing a repair into it every six
 * hours would undo the stop from outside; the finding is logged and the remedy
 * is the merchant's own re-registration button, which is what #262 built it for.
 *
 * Best-effort throughout: this NEVER throws, because it runs beside a catalogue
 * reconcile and a webhook audit must not be able to fail one.
 */
export async function auditConnectionWebhooks(
  storeId: string,
  connectionId: string,
): Promise<ConnectionWebhookAudit> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull' || !conn.hasCredentials || !conn.shopDomain) {
    return { outcome: 'not_registerable', findings: [] };
  }
  if (conn.webhookIds.length === 0) {
    return { outcome: 'nothing_registered', findings: [] };
  }

  const provider = getConnectorProvider(conn.provider);
  let live: PlatformWebhookSubscription[];
  try {
    const auth = await decryptAuth(conn);
    live = [...(await provider.listWebhooks(auth))];
  } catch (err) {
    // Reported rather than repaired: a re-registration reads the same list and
    // would spend an attempt discovering the same thing. It is also what a
    // revoked credential answers every time.
    log.general.warn(
      { err, connectionId: conn.id },
      'Could not read the platform webhook list to audit this connection',
    );
    return { outcome: 'unreadable', findings: [] };
  }

  const expectedUrl = provider.webhookDeliveryUrl({
    address: getWebhookAddress(conn.provider),
    connectionId: conn.id,
  });
  const byId = new Map(live.map((subscription) => [subscription.id, subscription]));
  const findings = new Set<ConnectionWebhookAuditFinding>();
  let maxFailureCount: number | undefined;
  for (const id of conn.webhookIds) {
    const subscription = byId.get(id);
    if (!subscription) {
      findings.add('subscription_missing');
      continue;
    }
    if (subscription.deliveryUrl !== expectedUrl) {
      findings.add('delivery_address_moved');
      continue;
    }
    // ABSENT is not unhealthy — a platform that publishes no status has said
    // nothing, and only a platform that says `disabled`/`paused` has said it
    // stopped. Reading silence the other way would put every Shopify connection
    // through a re-registration every six hours.
    if (subscription.status === 'disabled' || subscription.status === 'paused') {
      findings.add('subscription_disabled');
    }
    if (subscription.failureCount !== undefined) {
      maxFailureCount = Math.max(maxFailureCount ?? 0, subscription.failureCount);
    }
  }

  const observed = [...findings].sort();
  const failureEvidence = maxFailureCount === undefined ? {} : { maxFailureCount };
  if (observed.length === 0) {
    return { outcome: 'healthy', findings: [], ...failureEvidence };
  }

  if (conn.webhookRegistrationState === 'dead_letter') {
    log.general.warn(
      { connectionId: conn.id, findings: observed, ...failureEvidence },
      'Webhook audit found dead subscriptions on a connection that has stopped retrying',
    );
    return { outcome: 'repair_withheld', findings: observed, ...failureEvidence };
  }

  log.general.warn(
    { connectionId: conn.id, findings: observed, ...failureEvidence },
    'Webhook audit found subscriptions the platform no longer honours — re-registering',
  );
  // `countsAsAttempt: true` — this is the AUTOMATIC loop, so its attempts are
  // what the budget bounds. A shop that cannot be repaired must reach the same
  // visible `dead_letter` the sweep reaches rather than being retried every six
  // hours forever; a merchant pressing the button still gets their own attempt.
  const repair = await reregisterConnectionWebhooks(storeId, connectionId, {
    countsAsAttempt: true,
  });
  return { outcome: 'repair_requested', findings: observed, repair, ...failureEvidence };
}

/**
 * The merchant's own trigger: validate synchronously, then ENQUEUE (#262).
 *
 * The `requestBackfill` shape, for the same reason — a registration is a handful
 * of platform calls whose latency belongs to somebody else, so the caller gets a
 * proper 404/400 and the work goes to the sync queue. The producer's inline
 * fallback keeps it working without Redis, which is also what keeps this available
 * during the incident that turned the scheduled sweep off.
 */
export async function requestWebhookReregistration(
  storeId: string,
  connectionId: string,
): Promise<void> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.status !== 'connected') {
    throw validationError('Webhooks can only be registered for a connected channel');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Webhook registration is only supported for pull connections');
  }
  if (!conn.hasCredentials || !conn.shopDomain) {
    throw validationError('Connection has no stored credentials — reconnect the channel first');
  }
  const { enqueueConnectionWebhookReregister } = await import('../queue/producers.js');
  await enqueueConnectionWebhookReregister({ storeId, connectionId });
}

/**
 * The scheduled sweep: re-register every connection whose registration did not
 * finish (#262).
 *
 * The population is DERIVED — see
 * `findConnectionsNeedingWebhookRegistration`, which states what it finds and what
 * it deliberately cannot. This function's own share is bounded and gated: one
 * batch per pass, one claim per connection, and a flag that stops the LOOP while
 * leaving every stored fact and the merchant's own retry available.
 *
 * A connection whose run throws is logged and skipped rather than aborting the
 * sweep over the rest — the `reconcileAllConnections` posture, and the reason a
 * single unreachable shop cannot stop every other merchant's channel recovering.
 */
export async function sweepConnectionWebhookRegistrations(): Promise<void> {
  if (!config.connectors.webhookReregistrationEnabled) {
    // The LOOP is gated and nothing else: the refusals stay recorded, the attempt
    // counters stay where they are, and turning it back on drains the backlog.
    log.general.debug('Connector webhook re-registration sweep is disabled');
    return;
  }

  const candidates = await findConnectionsNeedingWebhookRegistration({
    limit: config.connectors.webhookReregistrationBatchSize,
  });
  if (candidates.length === 0) {
    return;
  }

  const tally: Record<WebhookReregistrationOutcome, number> = {
    registered: 0,
    retry_scheduled: 0,
    dead_lettered: 0,
    not_claimed: 0,
    not_registerable: 0,
  };
  for (const candidate of candidates) {
    try {
      const outcome = await reregisterConnectionWebhooks(candidate.storeId, candidate.id, {
        countsAsAttempt: true,
      });
      tally[outcome] += 1;
    } catch (err) {
      log.general.warn(
        { err, connectionId: candidate.id },
        'Webhook re-registration sweep: failed to re-register connection',
      );
    }
  }
  log.general.info(
    { scanned: candidates.length, ...tally },
    'Connector webhook re-registration sweep complete',
  );
}

/**
 * Complete an OAuth connect: exchange the authorization code, validate the shop
 * currency is supported, encrypt the token, and upsert the `{ storeId, provider }`
 * connection. `storeId` is resolved server-side (from the signed state), never
 * from a request body. After persisting, registers the platform's product
 * webhooks (best-effort) and — when product pull is already enabled for this
 * connection — enqueues an initial backfill. Returns the persisted connection.
 *
 * Refuses to hijack an existing connection created in a different mode (e.g. a
 * WooCommerce push-in link from the WordPress plugin), like the API-key connect
 * below. The AUTHORITY for that refusal is `upsertConnection`'s conditional
 * write, not this read — two concurrent connects would both read "no row". What
 * the read buys is the refusal arriving BEFORE `exchangeCode`, which consumes a
 * one-time authorization code and leaves a granted access token on the platform
 * that Mercaria then stores nowhere. It can only ever refuse EARLIER than the
 * write, never admit what the write refuses.
 */
export async function connectAndVerify(
  storeId: string,
  providerId: ConnectorProviderId,
  params: { code: string; shopDomain: string; redirectUri: string },
): Promise<ConnectionRow> {
  const existing = await findConnectionByProvider(storeId, providerId);
  if (existing && existing.mode !== 'pull') {
    throw conflict('A connection already exists for this provider in a different mode');
  }

  const provider = getConnectorProvider(providerId);
  const result = await provider.exchangeCode({
    shopDomain: params.shopDomain,
    code: params.code,
    redirectUri: params.redirectUri,
  });

  if (!isSupportedCurrency(result.shopCurrency)) {
    throw validationError(`Shop currency ${result.shopCurrency} is not supported by Mercaria`);
  }

  // ONE statement on `UNIQUE(store_id, provider)`: a second OAuth callback for
  // the same shop merges into the same row instead of racing an insert against
  // it. The sync-settings defaults a fresh row gets are the COLUMN defaults,
  // which is what `setDefaultsOnInsert` bought under Mongoose.
  const upserted = await upsertConnection(storeId, providerId, {
    mode: 'pull',
    status: 'connected',
    credentials: encryptSecret(JSON.stringify({ accessToken: result.accessToken })),
    externalShopId: result.externalShopId,
    shopDomain: result.shopDomain,
    shopCurrency: result.shopCurrency,
    scopes: result.scopes,
    connectedAt: new Date(),
  });

  // Real-time sync: register the platform's product webhooks (best-effort).
  const conn = await registerConnectionWebhooks(upserted, {
    accessToken: result.accessToken,
    shopDomain: result.shopDomain,
  });

  // Initial import: whatever this connection already pulls starts now. A fresh
  // connection defaults every direction to `off`, so on a first connect this
  // enqueues nothing and the import starts when the merchant turns a resource on
  // (`updateSyncSettings`); on a RE-connect of a configured channel it re-imports.
  await enqueueInitialPulls(conn, pullingResources(conn), 'connect');

  return conn;
}

/**
 * Complete an API-KEY connect (WooCommerce and any future `credentialStrategy:
 * 'api_key'` provider): verify the merchant-supplied `{ consumerKey,
 * consumerSecret }` against the platform (`verifyConnection`, which also reports
 * the shop currency), validate the currency is supported, encrypt the credential
 * pair, and upsert the `{ storeId, provider }` connection as a `pull` channel.
 *
 * No OAuth code exchange, and webhook registration is the SAME best-effort step
 * the OAuth connect runs (below) rather than a WooCommerce-shaped variant of it.
 * A fresh connection defaults `products: 'off'`; the merchant enables
 * `products: 'pull'` via `updateSyncSettings`, then `runBackfill` imports the
 * catalog — the SAME pull path Shopify uses. When registration is refused the
 * channel still works on backfill plus the scheduled re-sync, which is what
 * makes it best-effort; the refused topics are recorded and served to the
 * merchant rather than silently dropped (#218).
 *
 * `storeId`/`providerId` are resolved server-side (route param + loaded store);
 * only the credentials come from the body, and they are validated + encrypted,
 * never spread into the document. Refuses to hijack an existing connection created
 * in a different mode (e.g. a WooCommerce push-in link from the WordPress plugin)
 * — the read below refuses before `verifyConnection` calls the merchant's site,
 * and `upsertConnection`'s conditional write is what actually enforces it (#302).
 */
export async function connectWithApiKey(
  storeId: string,
  providerId: ConnectorProviderId,
  params: { shopDomain: string; consumerKey: string; consumerSecret: string },
): Promise<ConnectionRow> {
  const provider = getConnectorProvider(providerId);
  if (provider.credentialStrategy !== 'api_key') {
    throw validationError(`Provider ${providerId} does not support API-key connect`);
  }

  const existing = await findConnectionByProvider(storeId, providerId);
  if (existing && existing.mode !== 'pull') {
    throw conflict('A connection already exists for this provider in a different mode');
  }

  // Verify the credentials AND read the shop currency in one call. The provider
  // encodes the API key/secret as the `"consumerKey:consumerSecret"` Basic userinfo.
  const identity = await provider.verifyConnection({
    accessToken: `${params.consumerKey}:${params.consumerSecret}`,
    shopDomain: params.shopDomain,
  });
  if (!isSupportedCurrency(identity.shopCurrency)) {
    throw validationError(`Shop currency ${identity.shopCurrency} is not supported by Mercaria`);
  }

  const upserted = await upsertConnection(storeId, providerId, {
    mode: 'pull',
    status: 'connected',
    credentials: encryptSecret(
      JSON.stringify({ consumerKey: params.consumerKey, consumerSecret: params.consumerSecret }),
    ),
    externalShopId: identity.externalShopId,
    shopDomain: identity.shopDomain,
    shopCurrency: identity.shopCurrency,
    // An API-key provider grants no OAuth scopes; the empty array is written
    // explicitly so a reconnect cannot leave a previous provider's grant behind.
    scopes: [],
    connectedAt: new Date(),
  });

  // Real-time sync: register the platform's webhooks (best-effort), exactly like the
  // OAuth connect. For WooCommerce this mints + stores a per-connection webhook secret;
  // if the merchant's API key lacks write scope the registration simply fails and is
  // logged — the connection still works via backfill + the scheduled reconcile.
  return registerConnectionWebhooks(upserted, {
    accessToken: `${params.consumerKey}:${params.consumerSecret}`,
    shopDomain: identity.shopDomain,
  });
}

/**
 * Everything the collection-mapping screen needs, in ONE payload (#376).
 *
 * The three lists are resolved TOGETHER because deciding whether a stored row
 * still works is a join across all three, and it is a judgement rather than a
 * lookup: `target_automated` in particular is not something a client could
 * derive without also knowing why an automated collection may not be a target.
 * Restating that on a client is how the two answers drift.
 *
 * ## The platform half fails SOFT, and the store half does not
 *
 * A merchant opening this screen has a mapping to read and edit whether or not
 * their platform is reachable this minute. So a failed `fetchCollections` is
 * reported as `unavailable` beside a fully-resolved `mapping` and `targets`,
 * rather than failing the request — the stored rows and their health are
 * Mercaria's own facts and are always answerable. The store half has no such
 * fallback and no reason to need one.
 *
 * A `push_in` connection is `unavailable` for a structural reason rather than a
 * transient one: the external site pushes INTO Mercaria and Mercaria holds no
 * credential to call it back with, so there is nothing to ask. Its mapping is
 * still readable, which is right — nothing stops a push-in connection carrying
 * one, and `applyCollectionMapping` is not the path push-in products take.
 */
export async function listChannelCollections(
  storeId: string,
  connectionId: string,
): Promise<ChannelCollectionsView> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    // 404 and never 403: the tenant gate on every channel route answers the same
    // way for "no such connection" and "somebody else's connection", so a caller
    // cannot use it to discover that a connection id exists.
    throw notFound('Connection not found');
  }
  const provider = getConnectorProvider(conn.provider);

  const mapping = conn.syncSettingsCollectionMapping ?? {};
  const storedTargetIds = [...new Set(Object.values(mapping))];
  const [targets, storedTargets] = await Promise.all([
    findManualCollectionsByStore(storeId),
    findCollectionMappingTargets(storeId, storedTargetIds),
  ]);
  const storedById = new Map(storedTargets.map((t) => [t.id, t]));

  const external = await readExternalCollections(conn, provider);
  const externalById = new Map(
    external.outcome === 'listed'
      ? external.collections.map((c) => [c.externalId, c] as const)
      : [],
  );

  const rows: ChannelCollectionMappingRow[] = Object.entries(mapping).map(
    ([externalId, collectionId]) => {
      const target = storedById.get(collectionId);
      const externalMatch = externalById.get(externalId);
      const state: ChannelCollectionMappingState = !target
        ? 'target_missing'
        : target.type === 'automated'
          ? 'target_automated'
          : // Only claim the platform dropped it when the platform actually
            // ANSWERED. An unreachable platform listed nothing, and reporting
            // that as `external_missing` would tell a merchant their shop had
            // deleted every grouping they had mapped.
            external.outcome === 'listed' && !externalMatch
            ? 'external_missing'
            : 'ok';
      return {
        externalId,
        ...(externalMatch ? { externalTitle: externalMatch.title } : {}),
        collectionId,
        ...(target ? { collectionTitle: target.title } : {}),
        state,
      };
    },
  );

  return {
    noun: provider.externalTaxonomyNoun,
    external,
    targets: targets.map((t) => ({ id: t.id, title: t.title, handle: t.handle })),
    mapping: rows,
  };
}

/** Ask the platform for its groupings, or say why it could not be asked. */
async function readExternalCollections(
  conn: ConnectionRow,
  provider: ConnectorProvider,
): Promise<ChannelExternalCollections> {
  if (conn.mode !== 'pull') {
    return { outcome: 'unavailable', reason: 'push_in_connection' };
  }
  if (conn.status === 'disconnected' || !conn.hasCredentials || !conn.shopDomain) {
    return { outcome: 'unavailable', reason: 'disconnected' };
  }
  if (!conn.shopCurrency || !isSupportedCurrency(conn.shopCurrency)) {
    return { outcome: 'unavailable', reason: 'disconnected' };
  }
  try {
    const creds = await decryptCredentials(conn, conn.shopCurrency);
    return { outcome: 'listed', collections: await provider.fetchCollections(creds) };
  } catch (err) {
    log.general.warn(
      { err, connectionId: conn.id, provider: conn.provider },
      'Failed to list channel collections from the platform',
    );
    return { outcome: 'unavailable', reason: 'platform_unavailable' };
  }
}

/**
 * Refuse a `collectionMapping` whose targets are not MANUAL collections of this
 * store (#376).
 *
 * `sync_settings_collection_mapping` is `jsonb`, which is the right shape — its
 * KEYS are the external platform's own open id space, so there is nothing to
 * project into columns and no join to express (see
 * `db/schema/CONVENTIONS.md`'s jsonb register). But `jsonb` also means the
 * VALUES carry no foreign key, so nothing in the database refuses a target that
 * does not exist, belongs to another store, or is rule-driven.
 *
 * This is the WRITE-time half and `applyCollectionMapping`'s filter is the
 * RUN-time half, and they are not redundant — they answer at two different
 * moments. Here there is a merchant present who can fix the value, so the honest
 * answer is a 400 naming what is wrong; storing it instead would leave them
 * looking at a saved mapping that quietly does nothing. At import time nobody is
 * present and the mapping was valid when it was written, so the only useful
 * behaviour is to skip the drifted row and keep importing.
 *
 * The refusal names the offending ids because they are the merchant's OWN
 * collection ids, echoed back from their own request body — it discloses
 * nothing they did not send. An id belonging to another store is reported as
 * unknown rather than as automated, since the scoped read cannot see it: that
 * is the correct answer and not a leak.
 */
async function assertCollectionMappingTargetsAreMappable(
  storeId: string,
  mapping: Record<string, string>,
): Promise<void> {
  const targetIds = [...new Set(Object.values(mapping))];
  if (targetIds.length === 0) return;

  const found = await findCollectionMappingTargets(storeId, targetIds);
  const byId = new Map(found.map((t) => [t.id, t]));

  const unknown = targetIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw validationError(`Unknown collection in collectionMapping: ${unknown.join(', ')}`);
  }
  const automated = targetIds.filter((id) => byId.get(id)?.type === 'automated');
  if (automated.length > 0) {
    throw validationError(
      `Cannot map a channel onto an automated collection (${automated.join(', ')}): its ` +
        `membership is decided by its own rules, and a connector membership would be ` +
        `added and removed on every sync. Map onto a manual collection instead.`,
    );
  }
}

/**
 * Update a connection's `syncSettings` from an explicit field whitelist. Scoped
 * by `{ id, storeId }` (no cross-store access). Never spreads the request body.
 *
 * The whitelist is stated ONCE, in the repository's `SyncSettingsPatch`, and the
 * read-modify-save pair is now a single conditional UPDATE — the row is never
 * loaded and written back, so a concurrent settings change cannot be clobbered by
 * a stale in-memory document.
 *
 * BEHAVIOUR CHANGE: `sync_settings_target_location_id` is a real foreign key, so
 * a `targetLocationId` naming no location is REFUSED (SQLSTATE 23503) instead of
 * being stored as a dangling id. It is translated here rather than left to
 * surface as a 500: the value came from a request body, so it is a 400.
 *
 * ## Turning a resource on STARTS it
 *
 * Writing the columns used to be the whole of this function, which made the
 * settings form a control that changed nothing observable: a merchant moved
 * `products` from `off` to `pull`, saved, and no import ever ran — the connect path
 * had already decided against enqueuing one, because at connect time the column
 * still said `off`. Nothing else in `src/` would have started it either, so a
 * connected store sat at zero imported products indefinitely with every layer
 * reporting success.
 *
 * So the save enqueues exactly what the connect path enqueues, through the SAME
 * function, for exactly the resources this write TURNED ON. It runs after the write
 * has committed and is best-effort — see {@link enqueueInitialPulls} for why its
 * eligibility test is deliberately not `requestBackfill`'s.
 */
export async function updateSyncSettings(
  storeId: string,
  connectionId: string,
  patch: UpdateSyncSettingsInput,
): Promise<ConnectionRow> {
  if (patch.collectionMapping !== undefined) {
    await assertCollectionMappingTargetsAreMappable(storeId, patch.collectionMapping);
  }
  let conn: UpdatedConnectionRow | null;
  try {
    conn = await updateSyncSettingsColumns(storeId, connectionId, {
      ...(patch.products !== undefined ? { products: patch.products } : {}),
      ...(patch.inventory !== undefined ? { inventory: patch.inventory } : {}),
      ...(patch.orders !== undefined ? { orders: patch.orders } : {}),
      ...(patch.autoPublish !== undefined ? { autoPublish: patch.autoPublish } : {}),
      ...(patch.conflictPolicy !== undefined ? { conflictPolicy: patch.conflictPolicy } : {}),
      ...(patch.targetLocationId !== undefined
        ? { targetLocationId: patch.targetLocationId }
        : {}),
      ...(patch.priceRules !== undefined ? { priceRules: patch.priceRules } : {}),
      ...(patch.collectionMapping !== undefined
        ? { collectionMapping: patch.collectionMapping }
        : {}),
    });
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw validationError('Target location not found');
    }
    throw err;
  }
  if (!conn) {
    throw notFound('Connection not found');
  }
  await enqueueInitialPulls(conn, newlyPullingResources(conn), 'settings');
  return conn;
}

/**
 * Disconnect a connection: delete the platform webhooks (best-effort, while the
 * credentials are still present), then mark it disconnected, drop BOTH encrypted
 * envelopes (no token at rest) and any registered webhook ids. The record is
 * KEPT so the `source` provenance on already-imported listings stays meaningful.
 * Scoped by `{ id, storeId }`.
 *
 * The clear writes NULL to all six credential columns in one statement — see
 * `connectionRepository.disconnectConnection`: the `all three or none` CHECKs
 * refuse a partial clear, and `''` would pass them while leaving a connection
 * that reads as authorized and decrypts to nothing.
 *
 * ## What it deletes, and why `webhookIds` is not enough (#218)
 *
 * The set is the UNION of the stored ids and every subscription the platform
 * currently delivers to this connection's EXACT delivery URL. Registration was
 * taught to converge by reading the platform; disconnect has to be, for the same
 * reason and against the same failure: a registration that threw between the
 * platform call and the database write leaves live subscriptions Mercaria holds
 * no id for, and a disconnect that trusts `webhookIds` walks straight past them
 * and leaves permanent orphans delivering to an endpoint whose connection is
 * gone. Reading the platform is also what makes an EMPTY `webhookIds` worth
 * acting on, which is exactly the state the bug produced.
 *
 * Both halves are needed: the platform's list can be unreadable (an expired
 * token, a 5xx, a revoked scope), in which case the stored ids are still deleted
 * — and a stored id the platform no longer has is answered as an idempotent
 * success by both providers.
 *
 * The URL comparison is the provider's `webhookDeliveryUrl` and is EXACT.
 * WooCommerce's is per connection, so a prefix test would delete a sibling
 * connection's subscriptions.
 *
 * ## The SHARED-ADDRESS guard, and why it is not "widens nothing"
 *
 * Shopify delivers every shop's events to ONE app-wide address, so two Mercaria
 * stores connected to the SAME Shopify shop deliver to the same URL. In the
 * ordinary case both have adopted the same rows and hold the same ids, so
 * disconnecting either already deleted the other's — but NOT in the state #218
 * exists to fix: if this connection's last registration answered `unknown` or
 * threw, its `webhook_ids` is empty or stale, so the stored-id delete used to be
 * a no-op while the platform sweep would delete the SIBLING's entire live set.
 *
 * That would be an outage rather than an inconvenience, and #262's
 * re-registration sweep does NOT make it recoverable — which is the part worth
 * reading, because it is the opposite of what "there is a re-registration path
 * now" suggests. That sweep's population is DERIVED from refused topics and an
 * empty `webhook_ids`, and a sibling whose live subscriptions were deleted out
 * from under it shows NEITHER: its stored ids look complete and its last
 * registration refused nothing. It is invisible to the sweep by construction, so
 * this guard is still what prevents the state rather than merely delaying it, and
 * the remedy for one that happened anyway is a person pressing re-register.
 *
 * So the platform-discovered half is skipped when ANOTHER live connection
 * resolves to this exact delivery URL. The stored ids still go — they are this
 * connection's own record. The test is asked of the PROVIDER, not of its id, so
 * WooCommerce pays nothing for it: a sibling Woo connection's URL carries a
 * different connection id, so the sweep still clears its orphans, which is the
 * single-store case #218 is actually about.
 */
export async function disconnect(
  storeId: string,
  connectionId: string,
  policy: ChannelDisconnectPolicy,
): Promise<ConnectionRow> {
  const existing = await findConnection(storeId, connectionId);
  if (!existing) {
    throw notFound('Connection not found');
  }

  // Best-effort: remove the platform webhooks while we still hold the credentials.
  // `hasCredentials` answers "is it authorized" without reading the envelope; the
  // envelope itself is read inside `decryptAuth`, one line further down.
  if (existing.hasCredentials && existing.shopDomain) {
    try {
      const provider = getConnectorProvider(existing.provider);
      const auth = await decryptAuth(existing);
      const doomed = new Set(existing.webhookIds);
      const address = getWebhookAddress(existing.provider);
      const deliveryUrl = provider.webhookDeliveryUrl({
        address,
        connectionId: existing.id,
      });
      // Does any OTHER live connection deliver to the exact URL this one does?
      //
      // Asked of the provider rather than of its id, so it costs WooCommerce
      // nothing: a sibling Woo connection's URL carries a different connection
      // id, so this is false and the platform sweep below still clears its
      // orphans. It is true only where the address is genuinely SHARED, which
      // today means two Mercaria stores connected to one Shopify shop.
      const siblingIds = (
        await findConnectionIdsByShopDomain(existing.provider, existing.shopDomain)
      ).filter((id) => id !== existing.id);
      const addressIsShared = siblingIds.some(
        (siblingId) => provider.webhookDeliveryUrl({ address, connectionId: siblingId }) === deliveryUrl,
      );
      if (addressIsShared) {
        // The stored ids still go — they are this connection's own record — but
        // a PLATFORM-DISCOVERED subscription at a shared address may belong to
        // the sibling, and #262's sweep would not give it back: that population is
        // derived from refused topics and an empty `webhook_ids`, and a sibling
        // robbed this way has neither. Deleting the whole set would take a shop
        // this connection does not exclusively own dark until a person
        // re-registered it by hand.
        log.general.warn(
          { connectionId: existing.id, siblings: siblingIds.length },
          'Webhook delivery address is shared with another connection — deleting only the ids this connection holds',
        );
      } else {
        try {
          for (const subscription of await provider.listWebhooks(auth)) {
            if (subscription.deliveryUrl === deliveryUrl) {
              doomed.add(subscription.id);
            }
          }
        } catch (err) {
          // An unreadable list is not a reason to delete nothing: the stored ids
          // are still the best handle anyone has, and they are deleted below.
          log.general.warn(
            { err, connectionId: existing.id },
            'Could not read the platform webhook list on disconnect — deleting only the ids Mercaria holds',
          );
        }
      }
      if (doomed.size > 0) {
        await provider.deleteWebhooks(auth, [...doomed]);
      }
    } catch (err) {
      log.general.warn(
        { err, connectionId: existing.id },
        'Failed to delete connector webhooks on disconnect',
      );
    }
  }

  const conn = await disconnectConnection(storeId, connectionId, policy);
  if (!conn) {
    throw notFound('Connection not found');
  }
  return conn;
}

/** Resolve + validate the Fase-1 default import category slug (once per run). */
export async function resolveImportCategorySlug(): Promise<string> {
  const slug = process.env[DEFAULT_CATEGORY_ENV]?.trim();
  if (!slug) {
    throw validationError(
      `${DEFAULT_CATEGORY_ENV} is not configured — imported products need a target category`,
    );
  }
  const exists = await categorySlugExists(slug);
  if (!exists) {
    throw validationError(`Import category "${slug}" (${DEFAULT_CATEGORY_ENV}) does not exist`);
  }
  return slug;
}

/**
 * Decrypt a connection's stored token into `ConnectorAuth` (access token + shop
 * domain). Used by the auth-only paths (webhook register/delete) that do not need
 * the shop currency.
 *
 * ASYNC now, and that is the whole shape of the protected-column port: the
 * envelope is no longer carried on the connection row, so this makes the one
 * extra read that names those columns. Every caller is a path that genuinely
 * decrypts — the paths that only needed to know whether a connection is
 * authorized read `hasCredentials` and issue no second query at all.
 */
async function decryptAuth(conn: ConnectionRow): Promise<ConnectorAuth> {
  if (!conn.shopDomain) {
    throw validationError('Connection has no shop domain');
  }
  const credentials = await findConnectionCredentials(conn.id);
  if (!credentials) {
    throw validationError('Connection has no stored credentials');
  }
  const raw: unknown = JSON.parse(decryptSecret(credentials));
  const oauth = oauthCredentialsSchema.safeParse(raw);
  if (oauth.success) {
    return { accessToken: oauth.data.accessToken, shopDomain: conn.shopDomain };
  }
  const apiKey = apiKeyCredentialsSchema.safeParse(raw);
  if (apiKey.success) {
    return {
      accessToken: `${apiKey.data.consumerKey}:${apiKey.data.consumerSecret}`,
      shopDomain: conn.shopDomain,
    };
  }
  throw validationError('Stored connection credentials are malformed');
}

/** Decrypt a connection's stored credentials into `ConnectorCredentials` (adds currency). */
async function decryptCredentials(
  conn: ConnectionRow,
  shopCurrency: CurrencyCode,
): Promise<ConnectorCredentials> {
  return { ...(await decryptAuth(conn)), shopCurrency };
}

/** What the provider could not prove about a variant enumeration, in words. */
function describeVariantEnumerationGap(gap: VariantEnumerationGap): string {
  switch (gap.kind) {
    case 'declared_not_fetched':
      return `the platform declared variations ${gap.missingIds.join(', ')} and did not carry them`;
    case 'fetched_not_declared':
      return `the platform carried variations ${gap.unexpectedIds.join(', ')} it never declared`;
    case 'duplicate_fetched':
      return `the platform carried variations ${gap.duplicateIds.join(', ')} more than once`;
    case 'pagination_unprovable':
      return `${gap.pagesRead} page(s) were read and none of them proved the enumeration finished`;
    case 'declares_variants_and_carries_none':
      return `it declares ${gap.declared} variations and carries none`;
  }
}

/**
 * The bounded refusal a product whose variant enumeration is INCOMPLETE gets
 * (#259).
 *
 * It names the gap KIND and the ids, because that is what every merchant-facing
 * carriage of this refusal shows. A refused product in a backfill lands as
 * `counts.failed += 1`, this message on the warn line, this message in the run's
 * `sync_runs.error` summary (#294) and a durable `sync_run_record_failures` row
 * carrying it as `detail` under reason `refused_by_rule` (#303); a refused
 * webhook fails its `sync_runs` row with this as `error`. A message that said
 * only "incomplete" would leave an operator unable to tell a site that stopped
 * publishing a page header from one whose plugin is serving a variation twice.
 */
function incompleteVariantSetError(
  externalId: string,
  gap: VariantEnumerationGap,
): MercariaError {
  return validationError(
    `Connector product ${externalId} has an incomplete variant enumeration (${gap.kind}): ` +
      `${describeVariantEnumerationGap(gap)} — refusing to create, update or unsell anything from it`,
  );
}

/**
 * Map a normalized variant to the store-product variant input, applying the
 * connection's `priceRules` (markup + rounding) to the native `price` and
 * `compareAtPrice` before persisting.
 */
function toVariantInput(
  variant: NormalizedVariant,
  priceRules: PriceRules | undefined,
): CreateStoreProductVariantInput {
  const input: CreateStoreProductVariantInput = {
    optionValues: variant.optionValues.map((o) => ({ name: o.name, value: o.value })),
    price: applyPriceRules(variant.price, priceRules),
    inventory: { tracked: variant.inventory.tracked, available: variant.inventory.available },
  };
  if (variant.compareAtPrice) {
    input.compareAtPrice = applyPriceRules(variant.compareAtPrice, priceRules);
  }
  if (variant.sku) {
    input.sku = variant.sku;
  }
  if (variant.barcode) {
    input.barcode = variant.barcode;
  }
  return input;
}

/**
 * Build the `CreateStoreProductInput` for a first-time import of `product`.
 *
 * The `variants` map must stay ONE-TO-ONE with `product.variants` and in the
 * same order. #221's variant provenance is carried POSITIONALLY beside this list
 * (`buildVariantSources` walks the same array, and `resolveStoreVariants` zips
 * the two), so a `.filter` or a `.sort` added here would attach each stamp to
 * the wrong variant — and the failure is silent: the rows insert cleanly, and
 * the next inventory sync updates the stock of a different variant.
 *
 * The narrowing above that map is the type doing the work (#259): a `VariantSet`
 * whose `enumeration` is `incomplete` carries no variant array at all, so there
 * is nothing here to map and no coercion available to write. `importProduct`
 * refuses such a product before this is reached, which makes the throw
 * unreachable through the sync paths — and this is why that refusal cannot be
 * forgotten by a later caller rather than a comment asking them to remember it.
 */
function toCreateInput(
  product: NormalizedProduct,
  categorySlug: string,
  priceRules: PriceRules | undefined,
): CreateStoreProductInput {
  if (product.variants.enumeration === 'incomplete') {
    throw incompleteVariantSetError(product.externalId, product.variants.gap);
  }
  const input: CreateStoreProductInput = {
    title: product.title,
    description: product.description,
    category: categorySlug,
    imageFileIds: [...product.imageUrls],
    options: product.options.map((o) => ({ name: o.name, values: [...o.values] })),
    variants: product.variants.variants.map((v) => toVariantInput(v, priceRules)),
  };
  if (product.vendor) {
    input.vendor = product.vendor;
  }
  if (product.productType) {
    input.productType = product.productType;
  }
  if (product.handle) {
    input.handle = product.handle;
  }
  if (product.seo) {
    input.seo = product.seo;
  }
  return input;
}

/**
 * Build the listing-level update patch for a re-synced `product`, skipping any
 * connector-managed field pinned in `overridden`. The connector-MANAGED fields
 * are exactly those enumerated below — `title`, `description`, `images` (maps to
 * the `imageFileIds` patch key), `vendor`, `productType`, `handle`, `seo`;
 * native Mercaria fields (category, condition, tags, collections, status) are
 * NEVER touched by a re-sync. Variant-level price/stock re-sync is a later phase
 * (Fase 2); this refreshes the listing fields only.
 */
function toUpdatePatch(product: NormalizedProduct, overridden: Set<string>): UpdateListingInput {
  const patch: UpdateListingInput = {};
  if (!overridden.has('title')) patch.title = product.title;
  if (!overridden.has('description')) patch.description = product.description;
  if (!overridden.has('images')) patch.imageFileIds = [...product.imageUrls];
  if (!overridden.has('vendor') && product.vendor !== undefined) patch.vendor = product.vendor;
  if (!overridden.has('productType') && product.productType !== undefined) {
    patch.productType = product.productType;
  }
  if (!overridden.has('handle') && product.handle !== undefined) patch.handle = product.handle;
  if (!overridden.has('seo') && product.seo !== undefined) patch.seo = product.seo;
  return patch;
}

/**
 * The connector-provenance columns for a pulled listing.
 *
 * The four `source_*` fields are flat columns on `listings` rather than an
 * embedded sub-document, so this returns the columns themselves — carried into
 * the CREATE (#221) and applied as the PATCH on every later sync, from this one
 * definition either way.
 * `sourceExternalUpdatedAt` is written explicitly NULL when the platform sent no
 * timestamp: the embedded version simply left the key out, which kept the
 * PREVIOUS sync's timestamp on a product whose source had stopped reporting one —
 * a newer-than check silently reading a value the platform no longer stands behind.
 */
function buildSource(conn: ConnectionRow, product: NormalizedProduct): ListingSourceProvenance {
  return {
    sourceConnectionId: conn.id,
    sourceProvider: conn.provider,
    sourceExternalId: product.externalId,
    sourceExternalUpdatedAt: product.externalUpdatedAt ?? null,
  };
}

/**
 * Resolve the location imported stock is written to: the connection's configured
 * `targetLocationId` when it is a real active location of the store, otherwise the
 * store default. Returns `undefined` when no target is configured — the caller then
 * lets `createStoreProduct` fall back to the store default itself (so the common
 * no-target case does no extra location query).
 *
 * `findLocation` scopes to the store — that is the cross-store guard the
 * `{ _id, storeId }` Mongo filter used to carry — but it does NOT filter on `isActive`,
 * so the active check is made here to keep a deactivated target falling back to
 * the default rather than silently receiving stock.
 */
export async function resolveImportLocationId(conn: ConnectionRow): Promise<string | undefined> {
  const target = conn.syncSettingsTargetLocationId?.trim();
  if (!target) {
    return undefined;
  }
  const location = await findLocation(conn.storeId, target);
  return location?.isActive ? target : resolveDefaultLocationId(conn.storeId);
}

/**
 * Resolve the CONCRETE location inventory sync writes to: the configured
 * `targetLocationId` when valid, else the store default (inventory always needs a
 * concrete location, unlike the import-create path which can defer to the funnel).
 * Same store-scoped lookup plus explicit `isActive` check as
 * {@link resolveImportLocationId}.
 */
export async function resolveInventoryLocationId(conn: ConnectionRow): Promise<string> {
  const target = conn.syncSettingsTargetLocationId?.trim();
  if (target) {
    const location = await findLocation(conn.storeId, target);
    if (location?.isActive) {
      return target;
    }
  }
  return resolveDefaultLocationId(conn.storeId);
}

/**
 * The connector-provenance columns for each of a product's variants, POSITIONALLY
 * aligned with `product.variants`.
 *
 * This REPLACED `stampVariantSources`, which read the created variants back and
 * UPDATED them after the create had already committed (#221). The alignment it
 * relied on is the same one this uses — `resolveStoreVariants` numbers each
 * variant by its index in the input and `insertVariants` writes that number — so
 * nothing is less certain, one write disappears, and with it the window in which
 * an imported variant existed unstamped. That window mattered: an unstamped
 * variant is invisible to the inventory sync and to every later match, and
 * `convergeVariants` cannot repair it, because a variant it CAN see is one it
 * matches by SKU or option values rather than by provenance.
 *
 * All FOUR provenance columns are written on every variant, `null` included.
 * That is not extra caution, it is what the `$set: { source }` it ultimately
 * replaces already did: assigning the whole sub-document dropped any key the new
 * one omitted. Writing the set also keeps the columns mutually consistent —
 * `findVariantBySourceInventoryItemId` matches on `(sourceConnectionId,
 * sourceExternalInventoryItemId)`, so a variant carrying only some of them is
 * exactly as unfindable as an unstamped one while LOOKING synced.
 *
 * A variant the platform gave NEITHER id for is stamped all-NULL rather than
 * given the connection: it is unfindable by either key, so recording the
 * connection would claim a link nothing can follow. That is also exactly what
 * the ingest path — which supplies no external ids at all — has always produced,
 * so that path is unaffected.
 */
function buildVariantSources(
  conn: ConnectionRow,
  product: NormalizedProduct,
): VariantSourceProvenance[] {
  // #259 made `variants` a union, so this narrows on the discriminant rather
  // than reading an array off it — never a cast, and never `.variants` on the
  // union itself. It THROWS rather than returning an empty list because the
  // caller ZIPS what comes back against the variant rows BY POSITION: an empty
  // list would insert every variant unstamped, which is the exact state the
  // header above says `convergeVariants` cannot repair. Unreachable through the
  // sync paths — `importProduct` refuses an incomplete enumeration before the
  // create branch — and that is what keeps the refusal from being something a
  // later caller has to remember.
  if (product.variants.enumeration === 'incomplete') {
    throw incompleteVariantSetError(product.externalId, product.variants.gap);
  }
  return product.variants.variants.map((variant) =>
    variant.externalVariantId === undefined && variant.externalInventoryItemId === undefined
      ? {
          sourceConnectionId: null,
          sourceProvider: null,
          sourceExternalVariantId: null,
          sourceExternalInventoryItemId: null,
        }
      : {
          sourceConnectionId: conn.id,
          sourceProvider: conn.provider,
          sourceExternalVariantId: variant.externalVariantId ?? null,
          sourceExternalInventoryItemId: variant.externalInventoryItemId ?? null,
        },
  );
}

/**
 * Stamp ONE variant with the platform's variant + inventory-item ids.
 *
 * The single-variant counterpart of {@link buildVariantSources}, kept because
 * #220's convergence creates a variant OUTSIDE the create path and it needs the
 * same four columns written the same way — an unstamped variant is invisible to
 * the inventory sync and to every later match, which is a variant that exists
 * and never updates again. #221 folded the CREATE path's stamping into the
 * insert itself, so this is now reached only from `convergeVariants`.
 * A normalized variant carrying neither id is a no-op, so the ingest path (which
 * supplies none) is unaffected.
 */
async function stampVariantSource(
  conn: ConnectionRow,
  listingId: string,
  variantId: string,
  normalized: NormalizedVariant,
): Promise<void> {
  if (
    normalized.externalVariantId === undefined &&
    normalized.externalInventoryItemId === undefined
  ) {
    return;
  }
  await updateVariantColumns(
    listingId,
    variantId,
    {
      sourceConnectionId: conn.id,
      sourceProvider: conn.provider,
      sourceExternalVariantId: normalized.externalVariantId ?? null,
      sourceExternalInventoryItemId: normalized.externalInventoryItemId ?? null,
    },
    undefined,
  );
}

/**
 * Apply the connection's `collectionMapping` to a listing's `collectionIds`: map the
 * product's external `collectionRefs` through it and set exactly those connector
 * collections, while PRESERVING native Mercaria memberships (manual + automated
 * collections that are not in the mapping's codomain). The connector-MANAGED set is
 * the mapping's values, so a re-sync both adds and removes connector collections
 * precisely without touching native ones. A no-op — and no DB write — only when
 * the connection has no mapping or `collections` is pinned in `overridden`
 * (respecting `overriddenFields`). A product that carries NO collection refs is
 * not one of those cases: it means the platform removed it from every mapped
 * collection, so the managed memberships are dropped.
 *
 * The merge is now a SET DIFF in SQL instead of a read-modify-write of an array.
 * `Listing.collectionIds` became the `listing_collections` junction table, and
 * bounding the delete to the connector-MANAGED collection ids is what preserves
 * every native membership — the property the old `currentIds.filter(...)`
 * computed in the process. The read that fed that filter is therefore gone, and
 * with it the window in which a concurrent native membership change could be
 * clobbered by writing a whole array back.
 *
 * `setListingAutomatedMemberships` is reached for its SHAPE — insert the matched
 * set, delete scoped-minus-matched, for ONE listing — with the connector-managed
 * ids as the scope rather than the store's automated collections. It writes a
 * NULL `position`, which is right for a connector membership: the platform sends
 * an unordered set, exactly as `collectionIds` carried no order.
 *
 * ## Why `mappable` is passed in, and what it stops (#376)
 *
 * `sync_settings_collection_mapping` is `jsonb`, so its VALUES carry no foreign
 * key and nothing in the database keeps them pointing at a live collection. Two
 * kinds of drift follow a perfectly valid mapping, and each is silent in a
 * different direction:
 *
 *  - **The target was DELETED.** `listing_collections.collection_id` IS a real
 *    foreign key, so the insert below raises `23503` — and `runBackfill` counts
 *    a per-product failure and moves on. Every product carrying that ref then
 *    fails to import, run after run, and the run row names the PRODUCT while the
 *    cause is a collection nobody has looked at. Worse on the update path, where
 *    `updateListing` has already committed: the listing is written and the
 *    product is still tallied as failed.
 *
 *  - **The target became AUTOMATED.** No error at all, and a permanent
 *    flip-flop: `reconcileAutomatedMembership` deletes what this wrote because
 *    the listing does not match the rules, and this deletes what the rules
 *    engine wrote because the platform did not name the ref. Both write a NULL
 *    `position`, so neither can see the other's row as foreign, and which one
 *    wins is whichever ran last.
 *
 * So a target that is not currently a MANUAL collection of this store is dropped
 * from BOTH sides. Dropping it from `managed` too is the half worth stating: it
 * leaves any existing rows alone rather than deleting them, which is right in
 * both cases — a deleted collection took its rows with it by cascade, and a
 * now-automated one belongs to the rules engine, which will reconcile it.
 *
 * The set is resolved ONCE per run rather than per product (see
 * {@link resolveMappableCollectionIds}), so this stays one bounded query per
 * sync instead of one per product.
 */
async function applyCollectionMapping(
  conn: ConnectionRow,
  listingId: string,
  product: NormalizedProduct,
  overridden: Set<string>,
  mappable: ReadonlySet<string>,
): Promise<void> {
  // The `Map` became a jsonb `Record` — one value, read and written whole, with
  // the external platform's own collection ids as its keys.
  const mapping = conn.syncSettingsCollectionMapping;
  if (!mapping || Object.keys(mapping).length === 0 || overridden.has('collections')) {
    return;
  }
  const refs = product.collectionRefs ?? [];
  const managed = [...new Set(Object.values(mapping))].filter((id) => mappable.has(id));
  const desired = [
    ...new Set(
      refs.flatMap((ref) => {
        const mapped = mapping[ref];
        return mapped && mappable.has(mapped) ? [mapped] : [];
      }),
    ),
  ];

  await setListingAutomatedMemberships(listingId, managed, desired);
}

/**
 * Which of a connection's mapping TARGETS may actually be written to right now.
 *
 * One query per sync run over the mapping's codomain (tens of ids at most), and
 * none at all for a connection with no mapping — which is every connection that
 * has never opened the mapping screen. Resolved per RUN rather than per product
 * so an import does not pay for it once per row; a mapping edited mid-run is
 * therefore picked up by the next run, which is the same freshness every other
 * `syncSettings` field on `ConnectionRow` already has.
 */
async function resolveMappableCollectionIds(conn: ConnectionRow): Promise<ReadonlySet<string>> {
  const mapping = conn.syncSettingsCollectionMapping;
  if (!mapping) return new Set<string>();
  const targetIds = [...new Set(Object.values(mapping))];
  if (targetIds.length === 0) return new Set<string>();
  const targets = await findCollectionMappingTargets(conn.storeId, targetIds);
  return new Set(targets.filter((t) => t.type === 'manual').map((t) => t.id));
}

/** The outcome of importing a single product. */
type ImportOutcome = 'created' | 'updated' | 'skipped';

/** Options controlling how a single product is materialized on import. */
interface ImportProductOptions {
  categorySlug: string;
  autoPublish: boolean;
  respectOverrides: boolean;
  priceRules: PriceRules | undefined;
  /** Resolved import location (connector `targetLocationId`); undefined → store default. */
  importLocationId?: string;
  /**
   * The mapping targets that are MANUAL collections of this store, resolved once
   * per run — see {@link resolveMappableCollectionIds}. Empty for a connection
   * with no `collectionMapping`, which is the state every connection starts in.
   */
  mappableCollectionIds: ReadonlySet<string>;
}

/** Canonical, order-independent key for a variant's option-value tuple. */
function variantMatchKey(optionValues: { name: string; value: string }[]): string {
  return optionValues
    .map((o) => `${o.name}=${o.value}`)
    .sort()
    .join('|');
}

/**
 * An existing variant plus the option-value tuple the LEGACY matcher keys on.
 *
 * The two travel together because `optionValues` is a CHILD TABLE now rather than
 * an embedded array, so it is loaded once for the whole listing and re-attached
 * here — not re-queried per candidate while matching.
 */
interface ExistingVariant {
  readonly variant: VariantRecord;
  readonly optionValues: VariantOptionValueRecord[];
}

/**
 * One listing's existing variants, indexed the three ways an incoming variant
 * may resolve — each as a LIST rather than a first-insertion-wins entry.
 *
 * The lists are what make AMBIGUITY representable at all (#259 rule 8). The map
 * this replaces held one candidate per key and dropped the rest, so two variants
 * sharing a SKU or an option tuple silently resolved to whichever the read
 * happened to return first — arbitrary, stable-looking, and wrong for one of
 * them forever.
 */
interface ExistingVariantIndex {
  /** Stamped for THIS connection, keyed on the platform's own variant id. */
  readonly bySourceExternalId: Map<string, ExistingVariant[]>;
  /** NOT stamped for this connection — the migration fallback, keyed on SKU. */
  readonly legacyBySku: Map<string, ExistingVariant[]>;
  /** NOT stamped for this connection — the migration fallback, keyed on the tuple. */
  readonly legacyByOptionKey: Map<string, ExistingVariant[]>;
}

/** How ONE incoming variant resolved against the listing's existing rows. */
type VariantMatch =
  | {
      readonly outcome: 'matched';
      readonly existing: ExistingVariant;
      readonly tier: 'source_id' | 'legacy';
    }
  | { readonly outcome: 'new' }
  | {
      readonly outcome: 'ambiguous';
      readonly by: 'source_external_variant_id' | 'sku' | 'option_values';
      readonly candidateIds: readonly string[];
    };

/** Append `candidate` to the list `key` addresses, creating the list when absent. */
function pushCandidate(
  index: Map<string, ExistingVariant[]>,
  key: string,
  candidate: ExistingVariant,
): void {
  const bucket = index.get(key);
  if (bucket) {
    bucket.push(candidate);
  } else {
    index.set(key, [candidate]);
  }
}

/**
 * Index a listing's existing variants for matching.
 *
 * A row already stamped with THIS connection's variant id is indexed under that
 * id and under NOTHING else — the SKU and option-tuple maps are the migration
 * fallback for rows the connector has never stamped, and a stamped row appearing
 * in them is how an identified variant gets stolen by a SKU that moved to a
 * different variation.
 */
function indexExistingVariants(
  conn: ConnectionRow,
  existingVariants: readonly VariantRecord[],
  optionValuesByVariant: Map<string, VariantOptionValueRecord[]>,
): ExistingVariantIndex {
  const index: ExistingVariantIndex = {
    bySourceExternalId: new Map<string, ExistingVariant[]>(),
    legacyBySku: new Map<string, ExistingVariant[]>(),
    legacyByOptionKey: new Map<string, ExistingVariant[]>(),
  };
  for (const variant of existingVariants) {
    const candidate: ExistingVariant = {
      variant,
      optionValues: optionValuesByVariant.get(variant.id) ?? [],
    };
    const sourceExternalVariantId = variant.sourceExternalVariantId;
    if (variant.sourceConnectionId === conn.id && sourceExternalVariantId) {
      pushCandidate(index.bySourceExternalId, sourceExternalVariantId, candidate);
      continue;
    }
    if (variant.sku) {
      pushCandidate(index.legacyBySku, variant.sku, candidate);
    }
    pushCandidate(index.legacyByOptionKey, variantMatchKey(candidate.optionValues), candidate);
  }
  return index;
}

/**
 * Resolve ONE incoming variant against the index — #259 rules 6, 7 and 8.
 *
 * The platform's own variant id comes FIRST and is exact. Only when it resolves
 * nothing does the SKU / option-tuple fallback run, and only over rows this
 * connection has never stamped: that is what carries a listing imported before
 * variant provenance existed onto its stable identity, without ever letting a
 * merchant's SKU edit re-point a variant that already has one.
 *
 * More than one candidate at any tier is AMBIGUOUS and is answered as such. The
 * caller refuses the product — picking one would be a coin flip whose loser is
 * unsold, and doing it by map insertion order made the coin flip invisible.
 */
function matchIncomingVariant(
  incoming: NormalizedVariant,
  index: ExistingVariantIndex,
): VariantMatch {
  if (incoming.externalVariantId !== undefined) {
    const bySource = index.bySourceExternalId.get(incoming.externalVariantId) ?? [];
    if (bySource.length === 1) {
      return { outcome: 'matched', existing: bySource[0], tier: 'source_id' };
    }
    if (bySource.length > 1) {
      return {
        outcome: 'ambiguous',
        by: 'source_external_variant_id',
        candidateIds: bySource.map((candidate) => candidate.variant.id),
      };
    }
  }
  const bySku = incoming.sku ? (index.legacyBySku.get(incoming.sku) ?? []) : [];
  if (bySku.length === 1) {
    return { outcome: 'matched', existing: bySku[0], tier: 'legacy' };
  }
  if (bySku.length > 1) {
    return {
      outcome: 'ambiguous',
      by: 'sku',
      candidateIds: bySku.map((candidate) => candidate.variant.id),
    };
  }
  const byOptions = index.legacyByOptionKey.get(variantMatchKey(incoming.optionValues)) ?? [];
  if (byOptions.length === 1) {
    return { outcome: 'matched', existing: byOptions[0], tier: 'legacy' };
  }
  if (byOptions.length > 1) {
    return {
      outcome: 'ambiguous',
      by: 'option_values',
      candidateIds: byOptions.map((candidate) => candidate.variant.id),
    };
  }
  return { outcome: 'new' };
}

/** The bounded refusal an ambiguous match gets — observable, and it names the rows. */
function ambiguousVariantMatchError(
  externalId: string,
  match: Extract<VariantMatch, { outcome: 'ambiguous' }>,
): MercariaError {
  return conflict(
    `Connector product ${externalId}: ${match.candidateIds.length} existing variants share one ` +
      `${match.by} (${match.candidateIds.join(', ')}) — refusing to pick one`,
  );
}

/**
 * Whether this variant's four provenance columns already say what the incoming
 * variant says. A legacy row matched by SKU has none of them; a row whose
 * platform inventory-item id moved has one that is stale.
 */
function sourceStampDiffers(
  record: VariantRecord,
  conn: ConnectionRow,
  incoming: NormalizedVariant,
): boolean {
  if (incoming.externalVariantId === undefined && incoming.externalInventoryItemId === undefined) {
    // Nothing to stamp — `stampVariantSource` is a no-op for such a variant, and
    // saying so here keeps this from reporting a write that never happens.
    return false;
  }
  return (
    record.sourceConnectionId !== conn.id ||
    record.sourceProvider !== conn.provider ||
    record.sourceExternalVariantId !== (incoming.externalVariantId ?? null) ||
    record.sourceExternalInventoryItemId !== (incoming.externalInventoryItemId ?? null)
  );
}

/**
 * Bring ONE matched existing variant onto the incoming one, PRESERVING its id —
 * #259 rules 9 and 12.
 *
 * Its id is what `cart_items`, `product_save_*`, `offers`, the canonical variant
 * links and every order line point at, so a platform-side rename has to become
 * an UPDATE here. Writing nothing when nothing differs is what keeps a re-sync of
 * an unchanged catalogue a true no-op.
 *
 * Returns true when anything was written.
 */
async function applyVariantUpdate(
  conn: ConnectionRow,
  listingId: string,
  existing: ExistingVariant,
  incoming: NormalizedVariant,
  priceRules: PriceRules | undefined,
): Promise<boolean> {
  const record = existing.variant;
  const patch: UpdateVariantInput = {};

  const targetPrice = applyPriceRules(incoming.price, priceRules);
  const targetCompareAt = incoming.compareAtPrice
    ? applyPriceRules(incoming.compareAtPrice, priceRules)
    : undefined;

  // `price` was required on the Mongoose model and both of its columns are
  // NULLABLE here, so a variant carrying no price at all is a case that did not
  // exist before. NULL differs from every incoming amount, which prices it on
  // the first re-sync rather than leaving it priceless — the same outcome the
  // create path would have produced.
  if (record.priceAmount !== targetPrice.amount || record.priceCurrency !== targetPrice.currency) {
    patch.price = targetPrice;
  }
  // The two `compare_at_price` columns are NULL together — that is what
  // `product_variants_compare_at_price_paired_check` guarantees — so the amount
  // alone answers "is one stored", exactly as the embedded object's presence did.
  const compareAtDiffers =
    record.compareAtPriceAmount !== null
      ? !targetCompareAt ||
        record.compareAtPriceAmount !== targetCompareAt.amount ||
        record.compareAtPriceCurrency !== targetCompareAt.currency
      : targetCompareAt !== undefined;
  if (compareAtDiffers) {
    // A compare-at price dropped on the platform clears the stored one (`null`).
    patch.compareAtPrice = targetCompareAt ?? null;
  }

  // A SKU the merchant changed on the platform RENAMES this variant; it does not
  // describe a different one. Applied only while the platform still publishes a
  // SKU: `UpdateVariantInput.sku` cannot express a CLEAR, so a variant whose SKU
  // was removed upstream keeps the one it had rather than being stripped of it
  // by a shape the funnel has no way to say.
  //
  // Two variants of one product SWAPPING SKUs now converges, and #296 is what
  // changed: with `product_variants_sku_key` gone there is no constraint for the
  // half-applied state to trip, so the first variant takes the second's SKU, the
  // two share it for the length of the loop, and the second takes the first's.
  // Nothing here needs a two-step rename, because nothing matched on the SKU to
  // begin with — `matchIncomingVariant` pairs these rows by
  // `source_external_variant_id`, which a SKU edit does not touch.
  if (incoming.sku !== undefined && incoming.sku !== record.sku) {
    patch.sku = incoming.sku;
  }

  // #381: a barcode CORRECTED upstream propagates. It was written on create and
  // never again, so a variant kept whatever GTIN it was first imported with.
  //
  // That is an identity claim rather than a stale string. `subject-loader.ts`
  // asserts `product_variants.barcode` as an `ean` for #58's matcher, and #296
  // removed the table-wide unique precisely so identity is decided by the
  // collision gate rather than a raw constraint — so a stale barcode is a wrong
  // identifier offered to the thing that attaches this variant to a canonical
  // product.
  //
  // Adding it to the PATCH is the whole fix, and deliberately not one line more:
  // `updateVariant` ends in `syncListingFacets`, which requests the offer
  // convergence (#57) and the per-variant re-match (#58) together. Before this,
  // a barcode-only edit produced an EMPTY patch, so `updateVariant` was never
  // called and neither was requested — the column kept the old GTIN and nothing
  // asked the matcher to look again. Reaching the existing chokepoint fixes all
  // three; enqueueing a match here as well would make this the one catalogue
  // writer with its own opinion about when matching happens.
  //
  // Applied only while the platform still publishes a barcode, for the reason
  // the SKU above is: `UpdateVariantInput.barcode` cannot express a CLEAR, so a
  // variant whose barcode was removed upstream keeps the one it had rather than
  // being stripped of it by a shape the funnel has no way to say.
  if (incoming.barcode !== undefined && incoming.barcode !== record.barcode) {
    patch.barcode = incoming.barcode;
  }

  // Option LABELS and VALUES move too, and this is the edit the old matcher could
  // not survive: it keyed on the tuple, so a rename matched nothing, created a
  // second variant and unsold the original — issue #259's design point 9, with no
  // incomplete response involved.
  const incomingOptions = incoming.optionValues.map((o) => ({ name: o.name, value: o.value }));
  if (variantMatchKey(existing.optionValues) !== variantMatchKey(incomingOptions)) {
    patch.optionValues = incomingOptions;
  }

  const wrotePatch = Object.keys(patch).length > 0;
  if (wrotePatch) {
    await updateVariant(listingId, record.id, patch);
  }
  // A legacy row matched by SKU or tuple GAINS its provenance here, which is what
  // makes the fallback a one-time migration rather than the permanent matcher.
  const stampDiffers = sourceStampDiffers(record, conn, incoming);
  if (stampDiffers) {
    await stampVariantSource(conn, listingId, record.id, incoming);
  }
  return wrotePatch || stampDiffers;
}

/**
 * CONVERGE the variants of a re-synced listing onto the incoming normalized
 * product: bring the ones that match onto the platform's current terms, CREATE
 * the ones the platform added, and unsell the ones it removed — preserving every
 * local variant id through all three.
 *
 * ## Identity, in three tiers (#259)
 *
 * The platform's own variant id is the PRIMARY match, over rows this connection
 * already stamped. SKU and the option-value tuple are a MIGRATION FALLBACK, and
 * only for rows the connector has never stamped — a listing imported before
 * variant provenance existed. Anything ambiguous at either tier REFUSES the
 * product rather than choosing.
 *
 * Matching by SKU and tuple FIRST is what issue #259 was filed about: a merchant
 * renaming a size on the platform matched nothing, so the sync created a second
 * variant and unsold the historical one — with its carts, saves, offers and
 * order history pointing at the row that had just been made unbuyable. Nothing
 * about that response was incomplete; the identity rule was simply wrong.
 *
 * ## MATCH first, WRITE second
 *
 * Every incoming variant is resolved before anything is written. That is what
 * makes an ambiguous legacy match fail CLOSED (#259 acceptance 3): the refusal
 * lands with no variant created, re-priced or unsold, where a match-and-write
 * loop would have converged the variants ahead of the ambiguous one and left the
 * listing half-migrated with nothing saying so.
 *
 * ## What #220 added, and the two decisions in it
 *
 * An UNMATCHED INCOMING variant is CREATED. It used to be skipped with the
 * comment "creation is a later phase", and that skip is what made #220
 * permanent: a variable product first seen through a webhook was created with
 * one wrong variant and no later sync could add the missing ones, so the listing
 * stayed wrong until somebody deleted and re-imported it. Creation goes through
 * `addVariant` — the same funnel the merchant surface uses, so the variant-count
 * cap, the position numbering and the facet recompute all apply — and is stamped
 * with its platform ids so the inventory sync can find it.
 *
 * An UNMATCHED EXISTING variant — one the platform stopped listing — is left in
 * place with its stock set to ZERO and tracking ON. It is never deleted and
 * never archived, and both halves of that are decisions:
 *
 *  - **Never deleted.** A variant id is referenced by `cart_items`,
 *    `product_save_*`, `offers`, `canonical_variant_source_links` and the
 *    matching links, every one of them `ON DELETE CASCADE` — so deleting one
 *    silently empties it out of live carts and retires an offer. A configuration
 *    somebody stopped selling is not a reason to erase what buyers did with it.
 *  - **Unsold rather than left alone.** Mercaria cannot fulfil a configuration
 *    the platform no longer has, so leaving it buyable would be reading silence
 *    as availability. Zeroing the stock stops the sale, breaks no reference, and
 *    keeps the row visible to a merchant who wants to understand what happened.
 *    Tracking is turned ON because an UNTRACKED variant ignores its stock
 *    entirely — zeroing one without that would look like a fix and change
 *    nothing. It is written ONCE: a variant already unsellable is skipped, so a
 *    re-sync does not write per removed variant forever.
 *
 * The unsell is written at `locationId` — the connection's own target location,
 * the one `importProduct` stocked the variant at. Routing it to the store
 * DEFAULT instead is what made it inert wherever a merchant had configured a
 * target: `recomputeVariantScalarFromLevels` SUMS the levels, so a zero inserted
 * beside the target's surviving stock left the variant fully buyable while every
 * test that shared one location for both reported a pass.
 *
 * Neither creation nor removal is reachable from a FAILED, PARTIAL or UNPROVEN
 * fetch: `runBackfill` throws out of its page loop on a fetch failure, and
 * `importProduct` refuses a product whose variant enumeration is `incomplete`
 * before any of this — the same posture `archiveUnseenSourcedListings` takes at
 * the product grain.
 *
 * RESPECTS `overriddenFields`: when the merchant has pinned `price` (the marker put
 * into `overridden` only under `respect_overrides`), the whole convergence is
 * skipped — the local variant set wins, exactly like the pinned listing fields in
 * `toUpdatePatch`.
 *
 * Returns true when anything moved, so the caller can count the product as
 * `updated` even when no listing-level field did.
 */
async function convergeVariants(
  conn: ConnectionRow,
  listingId: string,
  product: NormalizedProduct,
  overridden: Set<string>,
  priceRules: PriceRules | undefined,
  locationId: string | undefined,
): Promise<boolean> {
  // A locally-edited price is pinned — never let a re-sync overwrite it.
  if (overridden.has('price')) {
    return false;
  }

  // The removal loop below cannot tell "the platform removed this variant" from
  // "we did not see it", so it may only run behind a PROVEN enumeration — and
  // there is no way to read the incoming variants without narrowing to one,
  // which is what makes that a property of the type rather than a rule to
  // remember. `importProduct` refuses such a product before this is reached.
  if (product.variants.enumeration === 'incomplete') {
    throw incompleteVariantSetError(product.externalId, product.variants.gap);
  }
  const incomingVariants = product.variants.variants;

  const existingVariants = await findVariantsByListing(listingId);
  if (existingVariants.length === 0) {
    return false;
  }
  const optionValuesByVariant = await findVariantOptionValues(
    existingVariants.map((variant) => variant.id),
  );
  const index = indexExistingVariants(conn, existingVariants, optionValuesByVariant);

  // The element type EXCLUDES `ambiguous`, which is what carries "every
  // ambiguity was refused above" into the write loop as a fact `tsc` checks
  // rather than an ordering a reader has to trust.
  const resolved: {
    readonly incoming: NormalizedVariant;
    readonly match: Exclude<VariantMatch, { outcome: 'ambiguous' }>;
  }[] = [];
  const consumed = new Set<string>();
  for (const incoming of incomingVariants) {
    const match = matchIncomingVariant(incoming, index);
    if (match.outcome === 'ambiguous') {
      throw ambiguousVariantMatchError(product.externalId, match);
    }
    if (match.outcome === 'matched') {
      if (consumed.has(match.existing.variant.id)) {
        continue; // an existing variant maps to at most one incoming variant
      }
      consumed.add(match.existing.variant.id);
    }
    resolved.push({ incoming, match });
  }

  let changed = false;
  for (const { incoming, match } of resolved) {
    if (match.outcome === 'new') {
      const created = await addVariant(listingId, toVariantInput(incoming, priceRules), {
        locationId,
      });
      await stampVariantSource(conn, listingId, created, incoming);
      changed = true;
      continue;
    }
    if (await applyVariantUpdate(conn, listingId, match.existing, incoming, priceRules)) {
      changed = true;
    }
  }

  // Variants the platform stopped listing — see this function's header for why
  // they are unsold rather than deleted, why the write happens once, and why it
  // is written at the connection's own location.
  for (const variant of existingVariants) {
    if (consumed.has(variant.id)) {
      continue;
    }
    if (variant.inventoryTracked && variant.inventoryAvailable === 0) {
      continue; // already unsellable — a re-sync must not write per removed variant
    }
    await updateVariant(
      listingId,
      variant.id,
      { inventory: { tracked: true, available: 0 } },
      { locationId },
    );
    changed = true;
  }

  return changed;
}

/** Import ONE normalized product (create or override-respecting update). */
async function importProduct(
  conn: ConnectionRow,
  product: NormalizedProduct,
  opts: ImportProductOptions,
): Promise<ImportOutcome> {
  // #259 acceptance 1: an enumeration nobody could PROVE complete writes
  // NOTHING — not a listing field, not a variant, not an unsell. It is refused
  // here, above both branches, because a 2xx that under-reports a product's
  // variations is otherwise indistinguishable from a merchant deleting them, and
  // the update branch would have patched the listing before the variant path
  // ever looked. Both entry points reach this one line: `runBackfill` counts the
  // refusal as `failed` and logs it against the external id, and a webhook fails
  // its `sync_runs` row with this message as `error`.
  if (product.variants.enumeration === 'incomplete') {
    throw incompleteVariantSetError(product.externalId, product.variants.gap);
  }

  // `let` because the create branch may LOSE the provenance-unique race and fall
  // through to the update branch with the row the winner wrote (#221).
  let existing = await findListingBySourceExternalId(
    conn.storeId,
    conn.id,
    product.externalId,
  );

  if (!existing) {
    // LOOP PREVENTION (bidirectional): before creating, check whether this external
    // product is one WE pushed OUT to this connection (recorded in `externalRefs`).
    // If so, the inbound event is an echo of our own push — the listing is
    // Mercaria-owned, so skip it (never re-import a pushed product as a duplicate,
    // and never let the platform's normalization fight Mercaria's source of truth).
    const pushMirror = await listingPushedToConnection(
      conn.storeId,
      conn.id,
      product.externalId,
    );
    if (pushMirror) {
      return 'skipped';
    }

    // #221: the provenance and the initial status travel INTO the create, so
    // they are written by the listing's own insert inside its own transaction.
    // The two used to be a second statement, and a failure between them left a
    // listing with no `source_external_id` — unmatchable by
    // `findListingBySourceExternalId` forever, and still holding its handle, so
    // every later sync of that product failed on `listings_store_id_handle_key`.
    let createdListingId: string | undefined;
    try {
      createdListingId = await createStoreProduct(
        conn.storeId,
        toCreateInput(product, opts.categorySlug, opts.priceRules),
        {
          locationId: opts.importLocationId,
          source: buildSource(conn, product),
          status: opts.autoPublish ? 'active' : 'draft',
          variantSources: buildVariantSources(conn, product),
        },
      );
    } catch (err) {
      // #221: `listings_store_id_source_key_idx` is UNIQUE, so the read above and
      // this insert are no longer a read-then-write race. Losing it is ORDINARY —
      // a webhook delivered while a backfill is running is two deliveries for one
      // external id — so the loser RE-READS and converges through the update
      // branch rather than failing the product.
      //
      // By CONSTRAINT NAME, off the driver error: a drizzle error's SQLSTATE is on
      // `cause` and never `error.code`, and an unnamed check would swallow
      // `listings_store_id_handle_key` too. That one must still surface — a handle
      // collision between two genuinely different external products is a real
      // merchant conflict, and suffixing it silently would hide it. Since #292 it
      // surfaces NAMED: `createStoreProduct` classifies it into a refusal carrying
      // the incumbent listing and the connection holding the handle.
      if (!isUniqueViolation(err, 'listings_store_id_source_key_idx')) {
        throw err;
      }
      const raced = await findListingBySourceExternalId(
        conn.storeId,
        conn.id,
        product.externalId,
      );
      // The constraint fired and the row is not there: something other than the
      // race we can explain. Rethrow the ORIGINAL error rather than invent one.
      if (!raced) {
        throw err;
      }
      existing = raced;
    }

    if (createdListingId !== undefined) {
      // `applyCollectionMapping` stays OUTSIDE the create, and the asymmetry is
      // the point rather than an oversight: an unmapped COLLECTION is RECOVERABLE
      // — the next sync finds the listing by its provenance and re-applies the
      // mapping — whereas an unstamped LISTING can never be found again, and an
      // unstamped VARIANT is invisible to the inventory sync and to every later
      // match. Those two ride the create's own transaction now; a membership
      // recompute gains nothing from it, and
      // `recomputeAutomatedMembershipForListing` opens its own connection, which
      // inside the transaction would wait on itself.
      // A freshly-created listing has no local overrides yet.
      await applyCollectionMapping(
        conn,
        createdListingId,
        product,
        new Set<string>(),
        opts.mappableCollectionIds,
      );
      return 'created';
    }
    // Fell through from the race: `existing` now names the row the winner wrote.
  }

  const listingId = existing.id;
  const overridden = opts.respectOverrides ? new Set(existing.overriddenFields) : new Set<string>();
  const patch = toUpdatePatch(product, overridden);
  const changed = Object.keys(patch).length > 0;
  if (changed) {
    // #90: a connector sync is a SOURCE assertion, not a seller's. It carries no
    // account, so `writeListingConditionEvidence` refuses any condition that needs
    // photographs rather than attributing them to nobody — and a connector patch
    // never carries one today.
    await updateListing(listingId, patch, { kind: 'source' });
  }
  // #220: converge the variant SET, not just the prices — create what the
  // platform added, unsell what it removed (respects a pinned `price`). It is
  // handed the same location the create path stocks at, so an unsell lands on
  // the level the connector's stock actually lives in (#259).
  const repriced = await convergeVariants(
    conn,
    listingId,
    product,
    overridden,
    opts.priceRules,
    opts.importLocationId,
  );
  await applyCollectionMapping(conn, listingId, product, overridden, opts.mappableCollectionIds);
  // Always refresh provenance (externalUpdatedAt), even when nothing else changed.
  await updateListingColumns(listingId, buildSource(conn, product));
  return changed || repriced ? 'updated' : 'skipped';
}

/**
 * Run an initial backfill for a `pull` connection: page through the provider's
 * products and upsert each into the store. Records a `SyncRun` with per-record
 * tallies. A per-product failure is logged + counted (never aborts the run); a
 * whole-run failure (e.g. a network/credentials error) is recorded on the run,
 * which is still returned so the dashboard has a status record.
 */
export async function runBackfill(storeId: string, connectionId: string): Promise<SyncRunRecord> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Backfill is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettingsProducts)) {
    throw validationError('Product pull is not enabled for this connection');
  }
  if (!conn.shopCurrency || !isSupportedCurrency(conn.shopCurrency)) {
    throw validationError('Connection has no supported shop currency');
  }

  const provider = getConnectorProvider(conn.provider);
  const creds = await decryptCredentials(conn, conn.shopCurrency);
  const categorySlug = await resolveImportCategorySlug();
  const respectOverrides = conn.syncSettingsConflictPolicy === 'respect_overrides';
  const autoPublish = conn.syncSettingsAutoPublish;
  const priceRules = toPriceRules(conn);
  const importLocationId = await resolveImportLocationId(conn);
  const mappableCollectionIds = await resolveMappableCollectionIds(conn);

  const run = await insertSyncRun(conn.id, 'backfill');
  const counts: SyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  emitSyncProgress(conn.storeId, { connectionId, kind: 'backfill', phase: 'started', counts });

  // Every external id seen across all pages — the basis for delete-reconciliation
  // below. Populated as each page is fetched (BEFORE import), so a product that
  // fails to import is still counted as "seen" (it exists on the platform) and is
  // never mistakenly archived.
  const seenExternalIds = new Set<string>();
  /** Products this run refused, named on the run row rather than only logged (#294). */
  const recordFailures: SyncRunRecordFailure[] = [];

  try {
    let cursor: string | undefined;
    do {
      const page = await provider.fetchProducts(creds, cursor);
      for (const product of page.products) {
        seenExternalIds.add(product.externalId);
        try {
          const outcome = await importProduct(conn, product, {
            categorySlug,
            autoPublish,
            respectOverrides,
            priceRules,
            importLocationId,
            mappableCollectionIds,
          });
          counts[outcome] += 1;
        } catch (err) {
          counts.failed += 1;
          // #294: the tally alone made a refused product invisible — measured on
          // a 124-product store where one 110-variation product was refused whole
          // and the run still read `completed`. The THROWN value travels to
          // `finishSyncRun`, which is the only writer of that column and the only
          // place a merchant-facing message is composed.
          recordFailures.push({
            subjectType: 'product',
            externalId: product.externalId,
            failure: err,
          });
          log.general.warn(
            { err, connectionId: conn.id, externalId: product.externalId },
            'Failed to import connector product',
          );
        }
      }
      cursor = page.nextCursor;
      // Live tick after each page so the dashboard shows running progress.
      emitSyncProgress(conn.storeId, { connectionId, kind: 'backfill', phase: 'running', counts });
    } while (cursor);

    // DELETE RECONCILIATION — the safety net for products removed on the platform
    // while a `products/delete` webhook was missed. This line is reached ONLY after
    // EVERY page fetched successfully: a fetch-level failure throws out of this try
    // into the catch below, so a PARTIAL/failed fetch can NEVER mass-archive the
    // catalog (a transient platform outage must not wipe a store). Each of this
    // connection's sourced listings whose externalId was NOT seen in the full pull
    // is soft-archived (reusing `archiveSourcedListing`, respecting a pinned status).
    const archived = await archiveUnseenSourcedListings(conn, seenExternalIds, respectOverrides);
    // Count archives as `updated` (the schema has no `archived` tally), matching the
    // `products/delete` webhook path which also records an archive as `updated`.
    counts.updated += archived;

    const completed = await finishSyncRun(run.id, {
      status: 'completed',
      counts,
      recordFailures,
    });
    await markConnectionSynced(conn.id);
    emitSyncProgress(conn.storeId, { connectionId, kind: 'backfill', phase: 'completed', counts });
    return completed;
  } catch (err) {
    // No `recordFailures` here, deliberately: the whole-run failure is why the
    // run stopped, so the products it never reached are its consequence and
    // `finishSyncRun` would discard them anyway.
    const failed = await finishSyncRun(run.id, {
      status: 'failed',
      counts,
      failure: err,
    });
    await markConnectionError(conn.id);
    emitSyncProgress(conn.storeId, { connectionId, kind: 'backfill', phase: 'failed', counts });
    log.general.error({ err, connectionId: conn.id }, 'Connector backfill failed');
    return failed;
  }
}

/**
 * Validate that a connection is backfillable, then ENQUEUE an initial backfill.
 * The validation runs synchronously so the API caller gets a proper 404/400; the
 * import itself runs on the `marketplace-sync` queue (or inline when Redis is off,
 * via the producer's inline fallback). Scoped by `{ id, storeId }` — no
 * cross-store access.
 */
export async function requestBackfill(storeId: string, connectionId: string): Promise<void> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Backfill is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettingsProducts)) {
    throw validationError('Product pull is not enabled for this connection');
  }
  const { enqueueConnectionBackfill } = await import('../queue/producers.js');
  await enqueueConnectionBackfill({ storeId, connectionId });
}

/**
 * Archive the listing mapped to `externalId` for `conn` (soft-delete — never a
 * hard-delete, so order history + provenance survive). Returns true when a listing
 * was actually archived (an already-archived or unmapped id is a no-op).
 *
 * The provenance key resolves the listing and a CONDITIONAL update archives it,
 * rather than one filtered `updateOne`. The second statement is what preserves the
 * return value's meaning: `setListingStatusIfIn` refuses a listing already
 * `archived` (its `status <> next` clause is Mongo's `modifiedCount === 1`), so two
 * deliveries of the same delete webhook cannot both report having archived it. The
 * whole status set is allowed because the Mongo update was likewise unconditional
 * on the current status.
 */
async function archiveSourcedListing(
  conn: ConnectionRow,
  externalId: string,
  opts: { respectStatusOverride: boolean } = { respectStatusOverride: false },
): Promise<boolean> {
  const listing = await findListingBySourceExternalId(conn.storeId, conn.id, externalId);
  if (!listing) {
    return false;
  }
  // A locally-pinned status wins, exactly as it does in a field merge — for a
  // caller that has no listing in hand and so cannot check before asking. That
  // is #377's webhook path: the platform said the product was unpublished, and
  // the external id is the only thing it holds. `archiveUnseenSourcedListings`
  // already holds the row and short-circuits on the same predicate before
  // reaching here.
  //
  // OFF by default, because the `product_delete` caller does not pass it and
  // never did: a product DELETED upstream is gone whatever the merchant pinned,
  // and turning that into a refusal would be a behaviour change to a path
  // neither #377 nor #381 is about.
  if (opts.respectStatusOverride && listing.overriddenFields.includes('status')) {
    return false;
  }
  return setListingStatusIfIn(listing.id, 'archived', ALL_LISTING_STATUSES);
}

/**
 * DELETE RECONCILIATION for a FULLY-completed backfill: soft-archive every one of
 * `conn`'s sourced listings whose `source.externalId` was NOT in `seenExternalIds`
 * (the set of ids present across the just-finished full pull) — i.e. the product no
 * longer exists on the platform (e.g. a missed `products/delete` webhook). Reuses
 * the existing `archiveSourcedListing` soft-delete (NEVER a hard-delete, so order
 * history + provenance survive) and RESPECTS a locally-pinned `status` under
 * `respect_overrides`, exactly like the field merge. Isolated per listing: one bad
 * archive is logged and never aborts the sweep. Returns the number archived.
 *
 * CALLER GUARD (critical): only invoke this AFTER the backfill fetched EVERY page
 * without a fetch-level failure — a partial/failed fetch must never reach here, or a
 * transient platform outage would archive the whole catalog.
 */
async function archiveUnseenSourcedListings(
  conn: ConnectionRow,
  seenExternalIds: Set<string>,
  respectOverrides: boolean,
): Promise<number> {
  // The `status !== 'archived'` filter is applied here rather than in the query
  // because the repository read is deliberately status-agnostic; the set it
  // returns is already just this connection's imports, not the store's catalogue.
  const sourced = (
    await findListingsBySourceConnection(conn.storeId, conn.id)
  ).filter((listing) => listing.status !== 'archived');

  let archived = 0;
  for (const listing of sourced) {
    const externalId = listing.sourceExternalId;
    if (!externalId || seenExternalIds.has(externalId)) {
      continue; // still present on the platform (or no external id) — keep it
    }
    // Respect a locally-pinned status the same way field merges respect
    // overrides. `archiveSourcedListing` applies the SAME predicate for the
    // callers that have no listing in hand (#377's webhook path), and this stays
    // because the sweep already holds the row: it short-circuits before a second
    // read, and the redundancy fails safe — weakening the check there would
    // still leave this path protected.
    if (respectOverrides && listing.overriddenFields.includes('status')) {
      continue;
    }
    try {
      if (await archiveSourcedListing(conn, externalId, { respectStatusOverride: respectOverrides })) {
        archived += 1;
      }
    } catch (err) {
      log.general.warn(
        { err, connectionId: conn.id, externalId },
        'Failed to archive unseen sourced listing during reconcile',
      );
    }
  }
  return archived;
}

/**
 * Scheduled reconcile sweep — the SAFETY NET for missed real-time webhooks. A
 * dropped `products/*` webhook means the platform's change never reached Mercaria;
 * this periodic pass re-pulls every connected `pull`/`bidirectional` catalog, which
 * re-prices changed variants (see `repriceExistingVariants`) and delete-reconciles
 * removed products (see `archiveUnseenSourcedListings`). It enqueues a backfill per
 * eligible connection so each runs as its own retryable, deduped job; failing to
 * enqueue one connection is logged and never aborts the sweep over the rest.
 *
 * It ALSO enqueues a webhook AUDIT per connection (#295), and that is why the
 * catalogue re-pull is only half of what "safety net for missed webhooks" means:
 * re-pulling recovers the DATA a dead subscription never delivered, and nothing
 * before #295 noticed the subscription was dead. The two populations are
 * different — a connection with product pull off has webhooks and no catalogue
 * to re-pull — so they are read separately rather than one filtered from the
 * other.
 *
 * TWO enqueues rather than one audit inline, because an audit is a platform call
 * per shop: doing them here would make this job's duration a function of how
 * many merchants have connected, and one unreachable site would hold up every
 * other merchant's reconcile.
 *
 * Runs only under Redis (the scheduler is Redis-only). The producer's inline
 * fallback keeps this correct if ever called without Redis, but the scheduler never
 * registers it there — so without Redis there is simply no periodic sweep.
 */
export async function reconcileAllConnections(): Promise<void> {
  // The projection Mongo expressed as `'_id storeId'` is the repository's whole
  // select list: the sweep enqueues and reads nothing else, and its working set
  // can be every connection in the system.
  const connections = await findPullConnectionsToReconcile();

  const { enqueueConnectionBackfill, enqueueConnectionWebhookAudit } = await import(
    '../queue/producers.js'
  );
  for (const conn of connections) {
    try {
      await enqueueConnectionBackfill({ storeId: conn.storeId, connectionId: conn.id });
    } catch (err) {
      log.general.warn(
        { err, connectionId: conn.id },
        'Reconcile sweep: failed to enqueue backfill for connection',
      );
    }
  }

  const auditable = await findConnectionsToAuditWebhooks();
  for (const conn of auditable) {
    try {
      await enqueueConnectionWebhookAudit({ storeId: conn.storeId, connectionId: conn.id });
    } catch (err) {
      log.general.warn(
        { err, connectionId: conn.id },
        'Reconcile sweep: failed to enqueue webhook audit for connection',
      );
    }
  }

  log.general.info(
    { count: connections.length, audited: auditable.length },
    'Connector reconcile sweep enqueued per-connection backfills and webhook audits',
  );
}

/** True when a per-resource direction pulls into Mercaria (`pull` or `bidirectional`). */
function pullsResource(direction: SyncResourceDirection): boolean {
  return direction === 'pull' || direction === 'bidirectional';
}

/** The three resources a `pull` connection can import, each with its own producer. */
type PullResource = 'products' | 'orders' | 'inventory';

/** Every resource this connection currently pulls, in import order. */
function pullingResources(conn: ConnectionRow): PullResource[] {
  const resources: PullResource[] = [];
  if (pullsResource(conn.syncSettingsProducts)) resources.push('products');
  if (pullsResource(conn.syncSettingsOrders)) resources.push('orders');
  if (pullsResource(conn.syncSettingsInventory)) resources.push('inventory');
  return resources;
}

/**
 * Every resource this write TURNED ON — a direction that did not pull before and
 * does now.
 *
 * A transition rather than a state, because the patch is partial: a merchant saving
 * a `targetLocationId` on a channel already pulling products must not re-import the
 * catalogue, and `updateSyncSettings` writes `products` unchanged in that request.
 * The previous values come from the same statement that wrote the new ones (see
 * `connectionRepository.updateSyncSettings`), so nothing here can compare against a
 * snapshot another save has already replaced.
 */
function newlyPullingResources(row: UpdatedConnectionRow): PullResource[] {
  const turnedOn = (before: SyncResourceDirection, after: SyncResourceDirection): boolean =>
    !pullsResource(before) && pullsResource(after);
  const resources: PullResource[] = [];
  if (turnedOn(row.previousSyncSettingsProducts, row.syncSettingsProducts)) {
    resources.push('products');
  }
  if (turnedOn(row.previousSyncSettingsOrders, row.syncSettingsOrders)) {
    resources.push('orders');
  }
  if (turnedOn(row.previousSyncSettingsInventory, row.syncSettingsInventory)) {
    resources.push('inventory');
  }
  return resources;
}

/**
 * Enqueue the first import for each of `resources` — the ONE place a pull is
 * started as a consequence of something other than a merchant pressing Sync.
 *
 * Both callers reach it: `connectAndVerify` with everything the reconnected channel
 * already pulls, and `updateSyncSettings` with everything the save just turned on.
 * They were three copied blocks in the connect path and nothing at all in the save
 * path, which is the whole defect — a merchant could move `products` from `off` to
 * `pull`, save, and import nothing, forever, with no error anywhere.
 *
 * ## Why the eligibility test is not `requestBackfill`'s
 *
 * `requestBackfill` is a merchant pressing a button, so it REFUSES a non-pull or
 * unconfigured connection and the 400 tells them which. This runs as a side effect
 * of a save that has already committed and has nobody to tell, so it must not
 * enqueue work that is certain to fail: a `push_in` connection cannot run a pull at
 * all, and a disconnected one holds no credential to run it with. Both leave the
 * SETTING exactly as written — a merchant may configure a channel before
 * reconnecting it, and the reconnect is what starts the import (above).
 *
 * Every enqueue is best-effort, as the connect path's always were: the producer's
 * inline fallback keeps it working without Redis, and a queue that is briefly
 * unreachable must not fail the write that has already landed.
 */
async function enqueueInitialPulls(
  conn: ConnectionRow,
  resources: readonly PullResource[],
  trigger: 'connect' | 'settings',
): Promise<void> {
  if (resources.length === 0) return;
  if (conn.mode !== 'pull' || !conn.hasCredentials) return;

  const producers = await import('../queue/producers.js');
  const job = { storeId: conn.storeId, connectionId: conn.id };
  const enqueue: Record<PullResource, () => Promise<void>> = {
    products: () => producers.enqueueConnectionBackfill(job),
    orders: () => producers.enqueueOrderSync(job),
    inventory: () => producers.enqueueInventorySync(job),
  };

  for (const resource of resources) {
    await enqueue[resource]().catch((err) =>
      log.general.warn(
        { err, connectionId: conn.id, resource, trigger },
        'Failed to enqueue initial pull',
      ),
    );
  }
}

/**
 * Provider-aware classification of an inbound webhook topic into a provider-neutral
 * {@link WebhookEventKind} (or `undefined` when it is a topic we do not act on). This
 * is what makes `processConnectorWebhook` provider-agnostic: each platform speaks its
 * OWN topic vocabulary (Shopify `products/update`, WooCommerce `product.updated`, …)
 * and they resolve to the SAME canonical kinds here, so the dispatch below never
 * hard-codes one platform's strings.
 */
function classifyWebhookTopic(
  provider: ConnectorProviderId,
  topic: string,
): WebhookEventKind | undefined {
  switch (provider) {
    case 'shopify':
      return classifyShopifyWebhookTopic(topic);
    case 'woocommerce':
      return classifyWooCommerceWebhookTopic(topic);
    default:
      return undefined;
  }
}

/** A unit of webhook work that increments `counts`; the wrapper owns the `SyncRun`. */
type WebhookWork = (counts: SyncRunCounts) => Promise<void>;

/**
 * Run ONE webhook unit under a `webhook` `SyncRun`: create the run, emit live
 * progress, run `work`, then complete or fail. Best-effort — it NEVER throws:
 * platforms re-deliver failed webhooks and every upsert is idempotent, so a
 * modeled failure is recorded on the run + logged and swallowed.
 */
async function runWebhookUnit(conn: ConnectionRow, topic: string, work: WebhookWork): Promise<void> {
  const connectionId = conn.id;
  const counts: SyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const run = await insertSyncRun(connectionId, 'webhook');
  emitSyncProgress(conn.storeId, { connectionId, kind: 'webhook', phase: 'started', counts });

  try {
    await work(counts);
    await finishSyncRun(run.id, { status: 'completed', counts });
    // `lastSyncAt` only: one successful webhook is not evidence that a connection
    // previously marked `error` has recovered — a full backfill or order sync is.
    await touchConnectionLastSync(connectionId);
    emitSyncProgress(conn.storeId, { connectionId, kind: 'webhook', phase: 'completed', counts });
  } catch (err) {
    counts.failed += 1;
    await finishSyncRun(run.id, {
      status: 'failed',
      counts,
      failure: err,
    });
    emitSyncProgress(conn.storeId, { connectionId, kind: 'webhook', phase: 'failed', counts });
    log.general.error({ err, connectionId, topic }, 'Failed to process connector webhook');
  }
}

/**
 * Handle a product webhook by its canonical {@link WebhookEventKind}:
 * `product_delete` archives the mapped listing (soft-delete), `product_upsert`
 * create/update-upserts it. The provider's own topic vocabulary was already resolved
 * to the kind by the dispatcher, so this stays provider-agnostic.
 */
async function handleProductWebhook(
  conn: ConnectionRow,
  kind: 'product_upsert' | 'product_delete',
  payload: unknown,
  counts: SyncRunCounts,
): Promise<void> {
  if (kind === 'product_delete') {
    const parsed = webhookDeletePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw validationError('Malformed product-delete webhook payload');
    }
    const archived = await archiveSourcedListing(conn, String(parsed.data.id));
    counts[archived ? 'updated' : 'skipped'] += 1;
    return;
  }
  // product_upsert (create/update) — upsert the single product.
  if (!conn.shopCurrency || !isSupportedCurrency(conn.shopCurrency)) {
    throw validationError('Connection has no supported shop currency');
  }
  const provider = getConnectorProvider(conn.provider);
  // #220: complete the delivery BEFORE normalizing. A WooCommerce `product.*`
  // payload carries `variations` as ids and no variation objects, so without
  // this the pure normalizer refuses it (and, before the refusal existed,
  // collapsed a variable product to one variant at the parent's lowest price,
  // permanently). Shopify's implementation returns the payload unchanged.
  // A failed expansion THROWS, which fails this webhook run without writing
  // anything — the next backfill converges.
  const expanded = await provider.expandWebhookProduct(await decryptAuth(conn), payload);
  const product = provider.normalizeProduct(expanded, conn.shopCurrency);

  // #377: a product the platform has moved OUT of publish is archived here, and
  // is never merged into the listing as if it were still for sale.
  //
  // ARCHIVE rather than `draft`, because the backfill already archives exactly
  // this product and a draft would not survive it. An unpublished WooCommerce
  // product is filtered out of the pull (`status=publish`), so it is "unseen" by
  // the very next backfill and `archiveUnseenSourcedListings` archives it —
  // meaning `draft` is not a second policy, it is a state the next scheduled
  // reconcile overwrites. Choosing it would leave the two paths disagreeing
  // about one event, which is the defect this closes rather than a variation on
  // it. It also matches the `product_delete` branch above: from Mercaria's side
  // an unpublish and a delete are the same observable fact — the product is no
  // longer in the catalogue this connection publishes — and archiving is a
  // SOFT-delete either way, so order history and provenance survive and the
  // merchant can restore it.
  //
  // A provider that reports no publish state (`undefined`) archives nothing.
  //
  // The check sits AFTER the expansion rather than before it, so an unpublished
  // variable product still costs one `/variations` call it does not use. That is
  // deliberate: reading the state off the raw payload would mean normalizing
  // twice, and the only case it would buy is an expansion that THROWS — where
  // the webhook fails, nothing is written, and the listing waits for the
  // backfill exactly as it does today. No behaviour regresses by leaving it
  // here, and the publish rule stays in the normalizer where both paths read it.
  if (product.publishState === 'unpublished') {
    const archived = await archiveSourcedListing(conn, product.externalId, {
      respectStatusOverride: conn.syncSettingsConflictPolicy === 'respect_overrides',
    });
    counts[archived ? 'updated' : 'skipped'] += 1;
    return;
  }

  const categorySlug = await resolveImportCategorySlug();
  const outcome = await importProduct(conn, product, {
    categorySlug,
    autoPublish: conn.syncSettingsAutoPublish,
    respectOverrides: conn.syncSettingsConflictPolicy === 'respect_overrides',
    priceRules: toPriceRules(conn),
    importLocationId: await resolveImportLocationId(conn),
    mappableCollectionIds: await resolveMappableCollectionIds(conn),
  });
  counts[outcome] += 1;
}

/** Handle an `orders/*` webhook: idempotently upsert the single external order. */
async function handleOrderWebhook(
  conn: ConnectionRow,
  payload: unknown,
  counts: SyncRunCounts,
): Promise<void> {
  if (!conn.shopCurrency || !isSupportedCurrency(conn.shopCurrency)) {
    throw validationError('Connection has no supported shop currency');
  }
  const provider = getConnectorProvider(conn.provider);
  const order = provider.normalizeOrder(payload, conn.shopCurrency);
  const outcome = await upsertExternalOrder(conn, order);
  counts[outcome] += 1;
}

/**
 * Handle an `inventory_levels/update` webhook: map the platform's `inventory_item_id`
 * to the mapped Mercaria variant (via its stored `source.externalInventoryItemId`)
 * and set its stock at the connection's target location. The webhook reports ONE
 * platform location's level, so the authoritative SHOP-WIDE total is re-fetched via
 * `fetchInventory` (summed across locations) before the absolute set — matching the
 * pull job's semantics. Idempotent: an unmapped item is a no-op counted as skipped.
 */
async function handleInventoryWebhook(
  conn: ConnectionRow,
  payload: unknown,
  counts: SyncRunCounts,
): Promise<void> {
  const parsed = webhookInventoryPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw validationError('Malformed inventory-level webhook payload');
  }
  const itemId = String(parsed.data.inventory_item_id);
  const variant = await findVariantBySourceInventoryItemId(conn.id, itemId);
  if (!variant) {
    counts.skipped += 1;
    return;
  }

  const provider = getConnectorProvider(conn.provider);
  const levels = await provider.fetchInventory(await decryptAuth(conn), {
    inventoryItemIds: [itemId],
  });
  const level = levels.find((l) => l.externalInventoryItemId === itemId);
  const available = Math.max(0, level?.available ?? 0);
  const locationId = await resolveInventoryLocationId(conn);
  await setAvailable(variant.id, variant.listingId, locationId, available);
  counts.updated += 1;
}

/**
 * Process ONE inbound platform webhook (already HMAC-verified at the ingress route).
 * Provider-aware: the raw topic is classified into a provider-neutral
 * {@link WebhookEventKind} (`classifyWebhookTopic`), then dispatched:
 *  - product upsert/delete (gated on the product direction) → the same product
 *    upsert/archive path as backfill (respecting `overriddenFields`).
 *  - order upsert (gated on the order direction) → an idempotent external-order
 *    upsert (`{ storeId, source.externalId }` never duplicates).
 *  - inventory update (gated on the inventory direction) → re-fetch + absolute set.
 * Records a `webhook` `SyncRun` and emits live progress. Best-effort: a modeled
 * failure is recorded + logged and does NOT throw. Keeps every platform's behavior
 * identical — Shopify and WooCommerce topics resolve to the same kinds.
 */
export async function processConnectorWebhook(job: {
  connectionId: string;
  topic: string;
  payload: unknown;
}): Promise<void> {
  const conn = await findConnectionById(job.connectionId);
  if (!conn) {
    log.general.warn(
      { connectionId: job.connectionId, topic: job.topic },
      'Webhook for unknown connection (ignored)',
    );
    return;
  }
  if (conn.status !== 'connected') {
    log.general.warn(
      { connectionId: job.connectionId, status: conn.status },
      'Webhook for a non-connected connection (ignored)',
    );
    return;
  }

  const kind = classifyWebhookTopic(conn.provider, job.topic);

  if (kind === 'product_upsert' || kind === 'product_delete') {
    // Respect the per-connection product direction: no product pull ⇒ ignore.
    if (!pullsResource(conn.syncSettingsProducts)) {
      log.general.info(
        { connectionId: job.connectionId, topic: job.topic },
        'Product pull disabled — webhook ignored',
      );
      return;
    }
    await runWebhookUnit(conn, job.topic, (counts) =>
      handleProductWebhook(conn, kind, job.payload, counts),
    );
    return;
  }

  if (kind === 'order_upsert') {
    // Respect the per-connection order direction: no order pull ⇒ ignore.
    if (!pullsResource(conn.syncSettingsOrders)) {
      log.general.info(
        { connectionId: job.connectionId, topic: job.topic },
        'Order pull disabled — webhook ignored',
      );
      return;
    }
    await runWebhookUnit(conn, job.topic, (counts) =>
      handleOrderWebhook(conn, job.payload, counts),
    );
    return;
  }

  if (kind === 'inventory_update') {
    // Respect the per-connection inventory direction: no inventory pull ⇒ ignore.
    if (!pullsResource(conn.syncSettingsInventory)) {
      log.general.info(
        { connectionId: job.connectionId, topic: job.topic },
        'Inventory pull disabled — webhook ignored',
      );
      return;
    }
    await runWebhookUnit(conn, job.topic, (counts) =>
      handleInventoryWebhook(conn, job.payload, counts),
    );
    return;
  }

  log.general.info(
    { connectionId: job.connectionId, topic: job.topic },
    'Unhandled webhook topic (ignored)',
  );
}

// --- ORDER SYNC (platform → Mercaria) ---------------------------------------

/** A single non-empty placeholder for a required address field the platform omitted. */
const ADDRESS_PLACEHOLDER = '-';

/** Build the provenance `source` sub-document for an external order. */
function buildOrderSource(conn: ConnectionRow, order: NormalizedOrder): NewOrderSource {
  const source: NewOrderSource = {
    connectionId: conn.id,
    provider: conn.provider,
    externalId: order.externalId,
  };
  if (order.externalUpdatedAt) {
    source.externalUpdatedAt = order.externalUpdatedAt;
  }
  return source;
}

/**
 * Guarantee every REQUIRED `AddressSnapshot` field is non-empty (Mongoose rejects
 * empty required strings). The platform's address is used where present; missing
 * required pieces fall back to a placeholder so an incomplete external order still
 * persists as a faithful snapshot of what the platform provided.
 */
function ensureAddressSnapshot(
  addr: AddressSnapshot | undefined,
  fallbackName: string,
): AddressSnapshot {
  const base = addr ?? { recipientName: '', line1: '', city: '', postalCode: '', country: '' };
  return {
    ...base,
    recipientName: base.recipientName.trim() || fallbackName,
    line1: base.line1.trim() || ADDRESS_PLACEHOLDER,
    city: base.city.trim() || ADDRESS_PLACEHOLDER,
    postalCode: base.postalCode.trim() || ADDRESS_PLACEHOLDER,
    country: base.country.trim() || ADDRESS_PLACEHOLDER,
  };
}

/**
 * A snapshot reference id for an external order line. The line references the
 * platform's product/variant, which may not (yet) have a mapped Mercaria listing,
 * so a synthetic reference keeps the immutable snapshot self-describing without a
 * dangling foreign key. (Linking to a real listing is future work.)
 */
function externalLineRef(kind: 'product' | 'variant', conn: ConnectionRow, externalId?: string): string {
  return `ext:${conn.provider}:${kind}:${externalId ?? 'unknown'}`;
}

/** Map a normalized order's lines to persisted order-item snapshots. */
function toOrderItems(conn: ConnectionRow, order: NormalizedOrder): NewOrderItem[] {
  return order.lines.map((line) => ({
    listingId: externalLineRef('product', conn, line.externalProductId),
    variantId: externalLineRef('variant', conn, line.externalVariantId),
    title: line.title,
    variantTitle: line.variantTitle,
    optionValues: [],
    unitPrice: line.unitPrice,
    quantity: line.quantity,
    lineTotal: line.lineTotal,
  }));
}

/**
 * Map the platform's per-discount breakdown to persisted allocations.
 *
 * Every allocation is `target: 'order'`. Mercaria's target set is
 * `'order' | 'line'` and `targetLineIndex` is an index into THIS order's own
 * lines, so a line target would mean re-deriving Mercaria's line ordering from
 * the platform's allocation records — a mapping neither platform states, whose
 * failure mode is a discount silently attributed to the wrong item. An
 * order-targeted allocation says what the platform actually published: this
 * discount removed this much from this order. It is also the only shape a
 * SHIPPING discount can take, since Mercaria has no shipping target.
 *
 * `valueType` is written only when the platform stated one — never defaulted
 * (see `OrderDiscountAllocation`).
 */
function toAppliedDiscounts(order: NormalizedOrder): NewOrderAppliedDiscount[] {
  return order.discounts.map((discount) => ({
    discountId: discount.externalId,
    title: discount.title,
    amount: discount.amount,
    target: 'order' as const,
    ...(discount.code === undefined ? {} : { code: discount.code }),
    ...(discount.valueType === undefined ? {} : { valueType: discount.valueType }),
  }));
}

/** Map the platform's per-rate tax breakdown to persisted tax lines, verbatim. */
function toOrderTaxLines(order: NormalizedOrder): NewOrderTaxLine[] {
  return order.taxLines.map((line) => ({
    name: line.name,
    amount: line.amount,
    ...(line.rateBps === undefined ? {} : { rateBps: line.rateBps }),
  }));
}

/**
 * Build the full persisted order document for a first-time import of an external
 * order. Store order (`sellerType: 'store'`), stamped with `source` provenance; the
 * buyer id is synthetic (an external order has no Oxy user), the payment provider is
 * `external` (settled off Oxy Pay), and money is preserved as `DualMoney`.
 */
function buildExternalOrderDoc(
  conn: ConnectionRow,
  order: NormalizedOrder,
  orderNumber: string,
): NewOrder {
  const buyerOxyUserId = `ext:${conn.provider}:${order.customer?.externalId ?? order.externalId}`;
  const paidAt = order.paymentStatus === 'paid' ? order.createdAt ?? new Date() : undefined;

  const doc: NewOrder = {
    orderNumber,
    // ADR 0003 D6's third origin, stated rather than left implicit. The `ext:`
    // value above KEEPS going into `buyer_oxy_user_id` for now — it is this
    // row's only provenance until ADR 0003 M9 retires it in favour of the
    // `source_*` columns, and `orders_buyer_identity_check` leaves the column
    // unconstrained for `'external'` precisely so that retirement can happen
    // on its own schedule rather than as a side effect of guest checkout.
    buyerOrigin: 'external',
    buyerOxyUserId,
    sellerType: 'store',
    commercialRole: 'connected_marketplace',
    storeId: conn.storeId,
    // An online sale imported from a connected platform; `source` marks provenance.
    sourceChannel: 'storefront',
    source: buildOrderSource(conn, order),
    items: toOrderItems(conn, order),
    shippingAddress: ensureAddressSnapshot(
      order.shippingAddress,
      order.customer?.name ?? 'External customer',
    ),
    // The METHOD stays `standard` and the LABEL carries the platform's own text.
    // `SHIPPING_METHODS` is Mercaria's closed set (`standard|express|pickup`) and
    // no platform publishes a value from it — mapping "Express (2 days)" or
    // "Recogida en tienda" onto a member would be a guess about somebody else's
    // shop, and the one that lands on `pickup` changes how the order is
    // fulfilled. The label is the part a merchant reads.
    shippingMethod: 'standard',
    shippingLabel: order.shippingLabel ?? 'Shipping',
    shippingCost: order.totals.shipping,
    totals: {
      subtotal: order.totals.subtotal,
      discountTotal: order.totals.discountTotal,
      shipping: order.totals.shipping,
      tax: order.totals.tax,
      grandTotal: order.totals.grandTotal,
    },
    appliedDiscounts: toAppliedDiscounts(order),
    taxLines: toOrderTaxLines(order),
    status: order.status,
    // A connector import is the SYSTEM: the transition happened on another
    // platform and Mercaria is recording it, so there is no Mercaria actor to
    // name and inventing one would attribute somebody else's shop's action to
    // an account here (ADR 0003 D16).
    statusHistory: [
      {
        status: order.status,
        at: new Date(),
        actorKind: 'system',
        note: `Imported from ${conn.provider}`,
      },
    ],
    paymentStatus: order.paymentStatus,
    paymentProvider: 'external',
    ...(paidAt ? { paymentPaidAt: paidAt } : {}),
    checkoutGroupId: `ext:${conn.provider}:${order.externalId}`,
  };
  if (order.fxRate) {
    doc.fxRate = order.fxRate;
  }
  return doc;
}

/**
 * Idempotently upsert ONE external order into Mercaria, keyed by `{ storeId,
 * source.connectionId, source.externalId }` (hard-enforced by a unique partial
 * index). An existing order has its mutable status/payment refreshed (never
 * duplicated); a new order is created with a fresh Mercaria order number. A
 * concurrent create that loses the unique-index race is treated as `skipped`.
 */
async function upsertExternalOrder(conn: ConnectionRow, order: NormalizedOrder): Promise<ImportOutcome> {
  const connectionId = conn.id;
  const existing = await findOrderBySourceExternalId(conn.storeId, connectionId, order.externalId);

  if (existing) {
    // A re-sync still refreshes only the three mutable fields, and the discount
    // and tax BREAKDOWN is deliberately not among them — it is carried on a
    // first import and never backfilled onto an order that already exists.
    //
    // An order's totals are frozen at import (`insertOrder` is their only
    // writer). A platform order is editable afterwards — Shopify order edits,
    // a WooCommerce admin changing a coupon — so a breakdown taken from TODAY's
    // payload and written beside totals frozen from THEN would be one financial
    // record whose halves come from two different moments, which is worse than
    // an absent breakdown. Nothing reads these rows for money either
    // (`refund.service` computes against the order's lines and totals), so an
    // older order keeps reconciling exactly as it always has and only loses the
    // display. Re-importing an order with fresh totals is a different act,
    // because it MOVES an order's money, and it belongs to its own issue.
    const changed = existing.status !== order.status;
    await updateOrderFromSource(existing.id, {
      status: order.status,
      paymentStatus: order.paymentStatus,
      source: buildOrderSource(conn, order),
    });
    await recordExternalPayment(conn, order, existing.id);
    return changed ? 'updated' : 'skipped';
  }

  try {
    const created = await insertOrder(buildExternalOrderDoc(conn, order, await nextOrderNumber()));
    await recordExternalPayment(conn, order, created.id);
    return 'created';
  } catch (err) {
    // The NAMED index: one Mercaria order per (connection, external order). Lost
    // the race to a concurrent sync or webhook — the order already exists.
    if (isUniqueViolation(err, 'orders_store_id_source_key')) {
      return 'skipped';
    }
    throw err;
  }
}

/**
 * Record the imported order's payment as an explicit `external` payment.
 *
 * ADR 0001 D12 and #45 acceptance 5: the payment is VISIBLE — linked to its
 * order, carrying the source platform's amounts verbatim — and produces NO
 * ledger entries, because no Mercaria money moved. That last part is not a
 * simplification to revisit: booking a Shopify sale into Mercaria's accounts
 * would put cash there that Mercaria does not have, and the ledger's whole value
 * is that it does not contain figures like that.
 *
 * Idempotent by INDEX: the payment is unique per imported ORDER, so a re-sync or
 * a redelivered webhook refreshes the status of the row it already made. The
 * uniqueness is on the order rather than the checkout group precisely because
 * two connected shops can import orders carrying the same external id, which
 * makes the synthetic `ext:` group ids collide.
 *
 * Best-effort, deliberately: an import must not fail because the payment record
 * could not be written. The order is the commerce truth and the payment row is
 * its explanation, and the next sync writes it — where the reverse choice would
 * mean a Postgres hiccup silently stopping a merchant's orders from importing.
 */
async function recordExternalPayment(
  conn: ConnectionRow,
  order: NormalizedOrder,
  orderId: string,
): Promise<void> {
  try {
    const { ensurePayment } = await import('./payments/payment.service.js');
    const payment = await ensurePayment({
      provider: 'external',
      checkoutGroupId: `ext:${conn.provider}:${order.externalId}`,
      orderId,
      // Verbatim, on the presentment side — what the buyer was actually charged
      // on the source platform. Mercaria converts nothing here.
      presentment: {
        amount: order.totals.grandTotal.presentment.amount,
        currency: order.totals.grandTotal.presentment.currency,
      },
      // Mirrors the source's own payment state. `unpaid` on the source is a
      // payment that was created and not completed; anything else it reports as
      // paid is money that moved somewhere Mercaria was not.
      status: order.paymentStatus === 'paid' ? 'succeeded' : 'created',
      // An external order has no Oxy buyer, and inventing one would make a
      // connector import look like a Mercaria purchase.
      // Linked to the ONE order below rather than to the whole group: the
      // synthetic group id is not unique across connections.
      linkOrders: false,
    });
    const { linkPaymentToOrder } = await import('./payments/order-linkage.js');
    await linkPaymentToOrder({ orderId, paymentId: payment.id, provider: 'external' });
  } catch (err) {
    log.general.warn(
      { err, connectionId: conn.id, externalId: order.externalId },
      'Failed to record the external payment for an imported order; the next sync retries it',
    );
  }
}

/**
 * Pull orders from a `pull` connection and idempotently upsert each into Mercaria.
 * Records an `order_sync` `SyncRun` with per-record tallies. A per-order failure is
 * logged + counted (never aborts the run); a whole-run failure is recorded and the
 * run is still returned for the dashboard status feed. Scoped by `{ id, storeId }`.
 */
export async function syncOrders(storeId: string, connectionId: string): Promise<SyncRunRecord> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Order sync is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettingsOrders)) {
    throw validationError('Order pull is not enabled for this connection');
  }
  if (!conn.shopCurrency || !isSupportedCurrency(conn.shopCurrency)) {
    throw validationError('Connection has no supported shop currency');
  }

  const provider = getConnectorProvider(conn.provider);
  const creds = await decryptCredentials(conn, conn.shopCurrency);
  const runConnectionId = conn.id;

  const run = await insertSyncRun(runConnectionId, 'order_sync');
  const counts: SyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  /**
   * Orders this run refused, named on the run rather than only logged (#303).
   *
   * #294 gave the backfill this and left the two rails beside it untouched, so
   * an order sync that refused eleven orders recorded `completed`, a tally of
   * eleven and a NULL `error` — the exact report #303 is about, on a rail its
   * text does not name.
   */
  const recordFailures: SyncRunRecordFailure[] = [];
  emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'order_sync', phase: 'started', counts });

  try {
    let cursor: string | undefined;
    do {
      const page = await provider.fetchOrders(creds, cursor);
      for (const order of page.orders) {
        try {
          const outcome = await upsertExternalOrder(conn, order);
          counts[outcome] += 1;
        } catch (err) {
          counts.failed += 1;
          recordFailures.push({
            subjectType: 'order',
            externalId: order.externalId,
            failure: err,
          });
          log.general.warn(
            { err, connectionId: runConnectionId, externalId: order.externalId },
            'Failed to import connector order',
          );
        }
      }
      cursor = page.nextCursor;
      emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'order_sync', phase: 'running', counts });
    } while (cursor);

    const completed = await finishSyncRun(run.id, {
      status: 'completed',
      counts,
      recordFailures,
    });
    await markConnectionSynced(runConnectionId);
    emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'order_sync', phase: 'completed', counts });
    return completed;
  } catch (err) {
    const failed = await finishSyncRun(run.id, {
      status: 'failed',
      counts,
      failure: err,
    });
    await markConnectionError(runConnectionId);
    emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'order_sync', phase: 'failed', counts });
    log.general.error({ err, connectionId: runConnectionId }, 'Connector order sync failed');
    return failed;
  }
}

/**
 * Validate an order-pull connection, then ENQUEUE an order sync on the
 * `marketplace-sync` queue (inline fallback when Redis is off). Scoped by
 * `{ id, storeId }` — no cross-store access.
 */
export async function requestOrderSync(storeId: string, connectionId: string): Promise<void> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Order sync is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettingsOrders)) {
    throw validationError('Order pull is not enabled for this connection');
  }
  const { enqueueOrderSync } = await import('../queue/producers.js');
  await enqueueOrderSync({ storeId, connectionId });
}

// --- INVENTORY SYNC (platform → Mercaria) -----------------------------------

/**
 * Pull the current inventory levels for a `pull` connection's products and set each
 * mapped variant's stock at the connection's target location. Variants are matched
 * to platform inventory items by their stored `source.externalInventoryItemId` (set
 * at import), so no SKU match is needed. Idempotent: `setAvailable` is an absolute
 * set, so a re-run converges; a level with no mapped variant is counted skipped, a
 * per-variant failure is isolated. Records an `inventory_sync` `SyncRun`. Scoped by
 * `{ id, storeId }`.
 */
export async function syncInventory(storeId: string, connectionId: string): Promise<SyncRunRecord> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Inventory sync is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettingsInventory)) {
    throw validationError('Inventory pull is not enabled for this connection');
  }

  const provider = getConnectorProvider(conn.provider);
  const auth = await decryptAuth(conn);
  const runConnectionId = conn.id;

  const run = await insertSyncRun(runConnectionId, 'inventory_sync');
  const counts: SyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  /**
   * Levels this run could not apply (#303) — the second rail #294 left behind.
   *
   * `inventory_item`, and this is the pair that makes the subject a stored fact
   * rather than a derivation: `sync_runs.kind` is `inventory_sync` here AND on
   * the PUSH rail, whose unit is a product's external id. One kind, two
   * subjects.
   */
  const recordFailures: SyncRunRecordFailure[] = [];
  emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'inventory_sync', phase: 'started', counts });

  try {
    const locationId = await resolveInventoryLocationId(conn);
    // Variants of this connection that carry a platform inventory-item id. The
    // repository returns every variant the connection sourced; the item-id filter
    // stays here because it also NARROWS the nullable column to the string the map
    // is keyed by, which no query result could do on its own.
    const variants = await findVariantsBySourceConnection(runConnectionId);

    const byItemId = new Map<string, { variantId: string; listingId: string }>();
    for (const variant of variants) {
      const itemId = variant.sourceExternalInventoryItemId;
      if (itemId) {
        byItemId.set(itemId, { variantId: variant.id, listingId: variant.listingId });
      }
    }

    if (byItemId.size > 0) {
      const levels = await provider.fetchInventory(auth, { inventoryItemIds: [...byItemId.keys()] });
      for (const level of levels) {
        const mapping = byItemId.get(level.externalInventoryItemId);
        if (!mapping) {
          counts.skipped += 1;
          continue;
        }
        try {
          await setAvailable(mapping.variantId, mapping.listingId, locationId, Math.max(0, level.available));
          counts.updated += 1;
        } catch (err) {
          counts.failed += 1;
          recordFailures.push({
            subjectType: 'inventory_item',
            externalId: level.externalInventoryItemId,
            failure: err,
          });
          log.general.warn(
            { err, connectionId: runConnectionId, externalInventoryItemId: level.externalInventoryItemId },
            'Failed to apply connector inventory level',
          );
        }
        emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'inventory_sync', phase: 'running', counts });
      }
    }

    const completed = await finishSyncRun(run.id, {
      status: 'completed',
      counts,
      recordFailures,
    });
    await markConnectionSynced(runConnectionId);
    emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'inventory_sync', phase: 'completed', counts });
    return completed;
  } catch (err) {
    const failed = await finishSyncRun(run.id, {
      status: 'failed',
      counts,
      failure: err,
    });
    await markConnectionError(runConnectionId);
    emitSyncProgress(conn.storeId, { connectionId: runConnectionId, kind: 'inventory_sync', phase: 'failed', counts });
    log.general.error({ err, connectionId: runConnectionId }, 'Connector inventory sync failed');
    return failed;
  }
}

/**
 * Validate an inventory-pull connection, then ENQUEUE an inventory sync on the
 * `marketplace-sync` queue (inline fallback when Redis is off). Scoped by
 * `{ id, storeId }` — no cross-store access.
 */
export async function requestInventorySync(storeId: string, connectionId: string): Promise<void> {
  const conn = await findConnection(storeId, connectionId);
  if (!conn) {
    throw notFound('Connection not found');
  }
  if (conn.mode !== 'pull') {
    throw validationError('Inventory sync is only supported for pull connections');
  }
  if (!pullsResource(conn.syncSettingsInventory)) {
    throw validationError('Inventory pull is not enabled for this connection');
  }
  const { enqueueInventorySync } = await import('../queue/producers.js');
  await enqueueInventorySync({ storeId, connectionId });
}

// --- PRODUCT PUSH (Mercaria → platform) -------------------------------------

/**
 * Validate a persisted native price into a `Money` (its currency must be supported).
 *
 * Both halves arrive separately because a `Money` is two nullable columns here, and
 * a variant with NO price is a case the required Mongoose `price` made impossible.
 * It is REFUSED rather than pushed: there is no amount to send, and a platform
 * product created without one is worse than a push that fails loudly. The two
 * columns are NULL together (`product_variants_price_paired_check`), so one guard
 * covers both.
 */
function toMoney(amount: number | null, currency: string | null): Money {
  if (amount === null || currency === null) {
    throw validationError('Cannot push a variant that has no price');
  }
  if (!isSupportedCurrency(currency)) {
    throw validationError(`Unsupported currency on product price: ${currency}`);
  }
  return { amount, currency };
}

/** Map a persisted variant to a push variant (native price preserved). */
function toPushVariant(
  variant: VariantRecord,
  optionValues: VariantOptionValueRecord[],
): PushVariant {
  const pushVariant: PushVariant = {
    optionValues: optionValues.map((o) => ({ name: o.name, value: o.value })),
    price: toMoney(variant.priceAmount, variant.priceCurrency),
    inventory: { tracked: variant.inventoryTracked, available: variant.inventoryAvailable },
  };
  if (variant.compareAtPriceAmount !== null) {
    pushVariant.compareAtPrice = toMoney(
      variant.compareAtPriceAmount,
      variant.compareAtPriceCurrency,
    );
  }
  if (variant.sku) {
    pushVariant.sku = variant.sku;
  }
  if (variant.barcode) {
    pushVariant.barcode = variant.barcode;
  }
  return pushVariant;
}

/**
 * Everything a push needs about a listing, loaded ONCE for every connection it is
 * pushed to.
 *
 * The Mongoose document carried its images, options and each variant's option
 * values inside itself; all four are separate tables now, so they are gathered here
 * instead of re-read per connection — a store connected to three platforms would
 * otherwise run the same four queries three times for one product.
 */
interface PushableListing {
  readonly listing: ListingRecord;
  readonly images: ListingImageRecord[];
  readonly options: ListingOptionRecord[];
  readonly variants: VariantRecord[];
  readonly optionValues: Map<string, VariantOptionValueRecord[]>;
}

/** Build the platform-neutral `PushProduct` for a listing + its variants. */
function toPushProduct(pushable: PushableListing, existingExternalId?: string): PushProduct {
  const { listing } = pushable;
  // Only absolute http(s) image URLs can be pushed (the platform needs a public
  // `src`); Oxy-cloud file ids that are not URLs are skipped — image push is
  // best-effort and never blocks the product push. `findListingChildren` returns
  // both child lists already ordered by `position`, so neither is re-sorted.
  const imageUrls = pushable.images
    .map((img) => img.fileId)
    .filter((fileId) => /^https?:\/\//i.test(fileId));

  const product: PushProduct = {
    title: listing.title,
    description: listing.description,
    status: listing.status === 'active' ? 'active' : 'draft',
    options: pushable.options.map((o) => ({ name: o.name, values: [...o.values] })),
    imageUrls,
    variants: pushable.variants.map((variant) =>
      toPushVariant(variant, pushable.optionValues.get(variant.id) ?? []),
    ),
  };
  if (existingExternalId) {
    product.externalId = existingExternalId;
  }
  if (listing.handle) {
    product.handle = listing.handle;
  }
  if (listing.vendor) {
    product.vendor = listing.vendor;
  }
  if (listing.productType) {
    product.productType = listing.productType;
  }
  // One embedded `seo` object became two nullable columns, so "the listing has SEO"
  // is now "either column is set" — which is what a present sub-document meant.
  if (listing.seoTitle !== null || listing.seoDescription !== null) {
    product.seo = {
      ...(listing.seoTitle !== null ? { title: listing.seoTitle } : {}),
      ...(listing.seoDescription !== null ? { description: listing.seoDescription } : {}),
    };
  }
  return product;
}

/**
 * Push ONE listing to ONE connection under its own `product_push` `SyncRun`.
 *
 * The push mirror — which external product this listing maps to on this
 * connection — is a `listing_external_refs` row rather than an entry in an array
 * on the listing, so it is read before the push (to target a re-push at the SAME
 * external product) and written after it. `upsertExternalRef` REPLACES the pair's
 * previous mapping, which is what the `$pull`-then-`$push` did.
 *
 * That write can now RAISE where the Mongo pair silently succeeded:
 * `UNIQUE(connection_id, external_id)` refuses a mapping another of this store's
 * listings already claims. It is deliberately not caught — the catch below records
 * it on the run and logs it, which is right even though the provider call already
 * succeeded: a push whose mapping was not recorded is not idempotent, so the next
 * re-push would create a DUPLICATE product rather than update this one. A run that
 * pushed but could not record where is genuinely failed.
 */
async function pushListingToConnection(
  conn: ConnectionRow,
  pushable: PushableListing,
): Promise<void> {
  const connectionId = conn.id;
  const existingRef = await findExternalRefByListingAndConnection(
    pushable.listing.id,
    connectionId,
  );
  const counts: SyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const run = await insertSyncRun(connectionId, 'product_push');
  emitSyncProgress(conn.storeId, { connectionId, kind: 'product_push', phase: 'started', counts });

  try {
    const provider = getConnectorProvider(conn.provider);
    const result = await provider.pushProduct(
      await decryptAuth(conn),
      toPushProduct(pushable, existingRef?.externalId),
    );
    await upsertExternalRef({
      listingId: pushable.listing.id,
      connectionId,
      provider: conn.provider,
      externalId: result.externalId,
    });
    counts[existingRef ? 'updated' : 'created'] += 1;

    await finishSyncRun(run.id, { status: 'completed', counts });
    await touchConnectionLastSync(connectionId);
    emitSyncProgress(conn.storeId, { connectionId, kind: 'product_push', phase: 'completed', counts });
  } catch (err) {
    counts.failed += 1;
    await finishSyncRun(run.id, {
      status: 'failed',
      counts,
      failure: err,
    });
    emitSyncProgress(conn.storeId, { connectionId, kind: 'product_push', phase: 'failed', counts });
    log.general.error(
      { err, connectionId, listingId: pushable.listing.id },
      'Failed to push product to channel',
    );
  }
}

/**
 * Push a store listing OUT to every connection whose product direction is `push`
 * or `bidirectional`.
 *
 * LOOP PREVENTION (critical): the origin connection a listing was PULLED from
 * (`listing.source.connectionId`) is skipped, so a product pulled from Shopify X
 * never echoes straight back to X. The connector import path (webhook/backfill)
 * writes through the catalog funnels DIRECTLY and never calls this, so a pulled
 * upsert cannot trigger a re-push either — together these break the pull↔push loop.
 *
 * Best-effort per connection: a push failure to one connection is recorded on its
 * own `SyncRun` and never aborts the others. Scoped by `storeId` (IDOR-safe).
 */
export async function pushListingToChannels(storeId: string, listingId: string): Promise<void> {
  const listing = await findListingById(listingId);
  if (!listing || listing.ownerType !== 'store' || listing.storeId !== storeId) {
    return; // Not a store product of this store — nothing to push.
  }

  const connections = await findPushConnections(storeId);
  if (connections.length === 0) {
    return;
  }

  const variants = await findVariantsByListing(listing.id);
  if (variants.length === 0) {
    return; // A pushable product needs at least one variant.
  }

  const children = await findListingChildren([listing.id]);
  const pushable: PushableListing = {
    listing,
    images: children.images.get(listing.id) ?? [],
    options: children.options.get(listing.id) ?? [],
    variants,
    optionValues: await findVariantOptionValues(variants.map((variant) => variant.id)),
  };

  const originConnectionId = listing.sourceConnectionId;
  for (const conn of connections) {
    const connectionId = conn.id;
    // LOOP PREVENTION: never push a listing back to the connection it was pulled from.
    if (connectionId === originConnectionId) {
      continue;
    }
    // `hasCredentials` is the derived presence flag, so establishing that a
    // connection is authorized costs no read of the envelope — only the push
    // itself, one line down, decrypts.
    if (!conn.hasCredentials || !conn.shopDomain) {
      continue; // Not authorized (e.g. mid-reconnect) — skip silently.
    }
    await pushListingToConnection(conn, pushable);
  }
}

// --- FULFILLMENT PUSH (Mercaria order → platform) ---------------------------

/**
 * Push a Mercaria-fulfilled order's fulfillment back OUT to the platform it was
 * pulled from. Called when an order that carries `source` transitions to `shipped`
 * in Mercaria (see `order.service.transition`).
 *
 * LOOP PREVENTION (critical): only a MERCHANT-driven `transition('shipped')` reaches
 * here — the inbound order-sync/webhook path sets an order's status with a direct
 * `Order.updateOne` and NEVER calls `transition`, so a fulfillment that came FROM the
 * platform can never echo back out. The push is further gated on the connection's
 * `orders` direction being `bidirectional`; a `pull`-only connection never pushes.
 *
 * Best-effort: a push failure is recorded on its own `fulfillment_push` `SyncRun` and
 * never affects the order. Idempotent at the provider (a re-push of an already-fulfilled
 * order is a no-op). Loads by `orderId`; a non-connector order (no `source`) is a no-op.
 */
export async function pushOrderFulfillment(orderId: string): Promise<void> {
  const order = await findOrderById(orderId);
  if (!order || order.sourceConnectionId === null || order.sourceExternalId === null) {
    return; // Not a connector order — nothing to push.
  }

  const conn = await findConnectionById(order.sourceConnectionId);
  if (!conn || conn.status !== 'connected' || !conn.hasCredentials || !conn.shopDomain) {
    return; // Connection gone / disconnected / mid-reconnect — skip silently.
  }
  // Only bidirectional order sync pushes fulfillments back to the platform.
  if (conn.syncSettingsOrders !== 'bidirectional') {
    return;
  }

  const connectionId = conn.id;
  const counts: SyncRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const run = await insertSyncRun(connectionId, 'fulfillment_push');
  emitSyncProgress(conn.storeId, { connectionId, kind: 'fulfillment_push', phase: 'started', counts });

  try {
    const provider = getConnectorProvider(conn.provider);
    const fulfillment: PushFulfillment = { externalOrderId: order.sourceExternalId };
    if (order.shippingTrackingNumber) {
      fulfillment.trackingNumber = order.shippingTrackingNumber;
    }
    await provider.pushFulfillment(await decryptAuth(conn), fulfillment);
    counts.updated += 1;

    await finishSyncRun(run.id, { status: 'completed', counts });
    await touchConnectionLastSync(connectionId);
    emitSyncProgress(conn.storeId, { connectionId, kind: 'fulfillment_push', phase: 'completed', counts });
  } catch (err) {
    counts.failed += 1;
    await finishSyncRun(run.id, {
      status: 'failed',
      counts,
      failure: err,
    });
    emitSyncProgress(conn.storeId, { connectionId, kind: 'fulfillment_push', phase: 'failed', counts });
    log.general.error(
      { err, connectionId, orderId: order.id },
      'Failed to push fulfillment to channel',
    );
  }
}
