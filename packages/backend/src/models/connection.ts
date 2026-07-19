/**
 * Connection model — a store's link to an external commerce platform.
 *
 * Keyed by `{ storeId, provider }` (unique). Credentials are stored ONLY as an
 * encrypted `{ ciphertext, iv, tag }` blob (see `lib/connector-crypto.ts`) —
 * never in plaintext — and the blob is NOT part of the serialized `Connection`
 * DTO. Per-resource sync configuration is embedded as `syncSettings`. All
 * cross-collection references (`storeId`, `targetLocationId`) are Strings, per
 * the Mercaria convention.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type {
  ConnectorProviderId,
  ConnectionMode,
  ConnectionStatus,
  SyncResourceDirection,
} from '@mercaria/shared-types';

const PROVIDERS: readonly ConnectorProviderId[] = [
  'shopify',
  'woocommerce',
  'etsy',
  'prestashop',
  'magento',
];
const MODES: readonly ConnectionMode[] = ['pull', 'push_in'];
const STATUSES: readonly ConnectionStatus[] = ['connected', 'error', 'disconnected'];
const RESOURCE_DIRECTIONS: readonly SyncResourceDirection[] = [
  'pull',
  'push',
  'bidirectional',
  'off',
];
const ROUNDING_STRATEGIES = ['none', 'nearest', 'charm'] as const;
const CONFLICT_POLICIES = ['connector_wins', 'respect_overrides'] as const;

/** Encrypted credential blob at rest (mirrors `EncryptedSecret`). */
export interface IConnectionCredentials {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** Embedded per-connection sync configuration (model shape of `SyncSettings`). */
export interface ISyncSettings {
  products: SyncResourceDirection;
  inventory: SyncResourceDirection;
  orders: SyncResourceDirection;
  autoPublish: boolean;
  targetLocationId?: string;
  priceRules?: {
    markupPercent?: number;
    rounding?: (typeof ROUNDING_STRATEGIES)[number];
  };
  /** External collection/category id → Mercaria `Collection` id. */
  collectionMapping?: Map<string, string>;
  conflictPolicy: (typeof CONFLICT_POLICIES)[number];
}

export interface IConnection {
  _id: mongoose.Types.ObjectId;
  storeId: string;
  provider: ConnectorProviderId;
  mode: ConnectionMode;
  status: ConnectionStatus;
  /** Encrypted credentials; absent until the connection is authorized. */
  credentials?: IConnectionCredentials;
  /**
   * Encrypted per-connection inbound-webhook secret. Present only for providers with
   * `webhookSecretStrategy: 'per_connection'` (WooCommerce): the secret is minted at
   * webhook registration, set as the platform webhook's `secret`, and verified against
   * on every inbound delivery. Never returned in the `Connection` DTO.
   */
  webhookSecret?: IConnectionCredentials;
  externalShopId?: string;
  shopDomain?: string;
  shopCurrency?: string;
  scopes: string[];
  syncSettings: ISyncSettings;
  webhookIds: string[];
  connectedAt: Date;
  lastSyncAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ConnectionCredentialsSchema = new Schema<IConnectionCredentials>(
  {
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
  },
  { _id: false },
);

const SyncSettingsSchema = new Schema<ISyncSettings>(
  {
    products: { type: String, enum: RESOURCE_DIRECTIONS as string[], default: 'off' },
    inventory: { type: String, enum: RESOURCE_DIRECTIONS as string[], default: 'off' },
    orders: { type: String, enum: RESOURCE_DIRECTIONS as string[], default: 'off' },
    autoPublish: { type: Boolean, default: false },
    targetLocationId: { type: String },
    priceRules: {
      markupPercent: { type: Number },
      rounding: { type: String, enum: ROUNDING_STRATEGIES as unknown as string[] },
    },
    collectionMapping: { type: Map, of: String },
    conflictPolicy: {
      type: String,
      enum: CONFLICT_POLICIES as unknown as string[],
      default: 'respect_overrides',
    },
  },
  { _id: false },
);

const ConnectionSchema = new Schema<IConnection>(
  {
    storeId: { type: String, required: true },
    provider: { type: String, enum: PROVIDERS as string[], required: true },
    mode: { type: String, enum: MODES as string[], required: true },
    status: { type: String, enum: STATUSES as string[], default: 'disconnected' },
    credentials: { type: ConnectionCredentialsSchema },
    webhookSecret: { type: ConnectionCredentialsSchema },
    externalShopId: { type: String },
    shopDomain: { type: String },
    shopCurrency: { type: String },
    scopes: { type: [String], default: [] },
    syncSettings: { type: SyncSettingsSchema, default: () => ({}) },
    webhookIds: { type: [String], default: [] },
    connectedAt: { type: Date, default: Date.now },
    lastSyncAt: { type: Date },
  },
  { timestamps: true },
);

// One connection per store per platform — the upsert/lookup key.
ConnectionSchema.index({ storeId: 1, provider: 1 }, { unique: true });

export const Connection: Model<IConnection> =
  mongoose.models.Connection || mongoose.model<IConnection>('Connection', ConnectionSchema);
