/**
 * SyncRun model — one run of a sync operation against a `Connection`.
 *
 * Append-only activity log that powers the dashboard's connector status feed:
 * each backfill / pull / push / webhook-processing run records its kind, status,
 * record tallies and timing. `connectionId` is a String reference, per the
 * Mercaria convention.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { SyncRunKind, SyncRunStatus } from '@mercaria/shared-types';

const KINDS: readonly SyncRunKind[] = [
  'backfill',
  'product_pull',
  'product_push',
  'inventory_sync',
  'order_sync',
  'webhook',
];
const STATUSES: readonly SyncRunStatus[] = ['running', 'completed', 'failed'];

/** Per-run tallies of records processed. */
export interface ISyncRunCounts {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface ISyncRun {
  _id: mongoose.Types.ObjectId;
  connectionId: string;
  kind: SyncRunKind;
  status: SyncRunStatus;
  counts: ISyncRunCounts;
  startedAt: Date;
  finishedAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SyncRunCountsSchema = new Schema<ISyncRunCounts>(
  {
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
  },
  { _id: false },
);

const SyncRunSchema = new Schema<ISyncRun>(
  {
    connectionId: { type: String, required: true },
    kind: { type: String, enum: KINDS as string[], required: true },
    status: { type: String, enum: STATUSES as string[], default: 'running' },
    counts: { type: SyncRunCountsSchema, default: () => ({}) },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date },
    error: { type: String },
  },
  { timestamps: true },
);

// Recent-first feed of runs for a connection.
SyncRunSchema.index({ connectionId: 1, startedAt: -1 });

export const SyncRun: Model<ISyncRun> =
  mongoose.models.SyncRun || mongoose.model<ISyncRun>('SyncRun', SyncRunSchema);
