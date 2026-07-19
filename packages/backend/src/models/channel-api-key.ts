/**
 * ChannelApiKey model — a long-lived, store-scoped credential an external ingest
 * client (e.g. the Mercaria WooCommerce plugin) presents to authenticate its
 * catalog pushes WITHOUT a short-lived Oxy access token.
 *
 * SECURITY. The plaintext key is NEVER stored — only its irreversible sha256
 * `hash` (a hex digest) and a non-secret display `prefix`. A key is verified by
 * hashing the presented value and constant-time-comparing it against the stored
 * hash (see `channel-key.service`). All cross-collection references (`storeId`,
 * `connectionId`, `createdBy`) are Strings, per the Mercaria convention. A key is
 * revoked (not deleted) by stamping `revokedAt`, preserving the audit trail.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { ChannelApiKeyScope } from '@mercaria/shared-types';
import { CHANNEL_API_KEY_SCOPES } from '@mercaria/shared-types';

export interface IChannelApiKey {
  _id: mongoose.Types.ObjectId;
  /** Owning Mercaria store id. */
  storeId: string;
  /** Push-in connection the key is bound to, when scoped to a single one. */
  connectionId?: string;
  /** sha256 hex digest of the plaintext key — the only stored form of the secret. */
  hash: string;
  /** Non-secret display prefix (the first characters of the plaintext key). */
  prefix: string;
  /** Human-readable label the merchant gave the key. */
  label: string;
  /** Scopes the key holds. */
  scopes: ChannelApiKeyScope[];
  /** Oxy user id of the member who created the key. */
  createdBy: string;
  /** Last time the key authenticated an ingest. */
  lastUsedAt?: Date;
  /** When set, the key is revoked and can no longer authenticate. */
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ChannelApiKeySchema = new Schema<IChannelApiKey>(
  {
    storeId: { type: String, required: true },
    connectionId: { type: String },
    hash: { type: String, required: true },
    prefix: { type: String, required: true },
    label: { type: String, required: true },
    scopes: {
      type: [String],
      enum: CHANNEL_API_KEY_SCOPES as unknown as string[],
      default: () => [...CHANNEL_API_KEY_SCOPES],
    },
    createdBy: { type: String, required: true },
    lastUsedAt: { type: Date },
    revokedAt: { type: Date },
  },
  { timestamps: true },
);

// List a store's keys.
ChannelApiKeySchema.index({ storeId: 1 });
// A key hash is globally unique — the stored form of the secret.
ChannelApiKeySchema.index({ hash: 1 }, { unique: true });
// Coarse lookup selector for verification: the (non-secret) prefix narrows to a
// handful of candidates, which are then constant-time compared on the full hash.
ChannelApiKeySchema.index({ prefix: 1 });

export const ChannelApiKey: Model<IChannelApiKey> =
  mongoose.models.ChannelApiKey ||
  mongoose.model<IChannelApiKey>('ChannelApiKey', ChannelApiKeySchema);
