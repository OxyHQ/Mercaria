/**
 * AbuseReport model — a user telling Mercaria that something is wrong.
 *
 * Distinct in every way from the store SALES ANALYTICS in `report.service.ts` and
 * `shared-types/src/report.ts`, which share the word and nothing else.
 *
 * Cross-collection references (`reportedId`, `reporterOxyUserId`) are `String`,
 * matching the convention every other Mercaria model follows — Oxy users are
 * external and there is no local `User` collection, and `reportedId` addresses a
 * different collection per `reportedType` so it could not be a single `ref`.
 *
 * `localStatus` tracks the REPORT, never the case. Whether CrowdSource has
 * decided anything is CrowdSource's to say; this field only records what this
 * deployment knows about its own copy.
 */

import mongoose, { Schema, Model } from 'mongoose';
import {
  ABUSE_REPORT_CATEGORIES,
  ABUSE_REPORTED_TYPES,
  type AbuseReportCategory,
  type AbuseReportLocalStatus,
  type AbuseReportedType,
} from '@mercaria/shared-types';

const LOCAL_STATUSES: readonly AbuseReportLocalStatus[] = [
  'received',
  'queued',
  'delivered',
  'delivery_failed',
  'decided',
];

/** Bound on the operator-facing explanation, and on a reporter's free text. */
const MAX_REASON_LENGTH = 300;
const MAX_DETAILS_LENGTH = 2_000;

export interface IAbuseReport {
  _id: mongoose.Types.ObjectId;
  reportedType: AbuseReportedType;
  reportedId: string;
  reporterOxyUserId: string;
  categories: AbuseReportCategory[];
  details?: string;
  localStatus: AbuseReportLocalStatus;
  localStatusReason?: string;
  /**
   * The id CrowdSource assigned, once delivery succeeded. Absent until then, and
   * absent forever on a report that has no route out.
   */
  crowdSourceReportId?: string;
  crowdSourceCaseId?: string;
  /**
   * SHA-256 of the exact representation sent for review (§5.6), so a decision
   * about an older version of a listing stays identifiable as such after the
   * seller has edited it.
   */
  snapshotHash?: string;
  deliveredAt?: Date;
  decidedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AbuseReportSchema = new Schema<IAbuseReport>(
  {
    reportedType: {
      type: String,
      enum: ABUSE_REPORTED_TYPES as unknown as string[],
      required: true,
    },
    reportedId: { type: String, required: true },
    reporterOxyUserId: { type: String, required: true },
    categories: {
      type: [{ type: String, enum: ABUSE_REPORT_CATEGORIES as unknown as string[] }],
      required: true,
    },
    details: { type: String, maxlength: MAX_DETAILS_LENGTH },
    localStatus: {
      type: String,
      enum: LOCAL_STATUSES as unknown as string[],
      default: 'received',
      required: true,
    },
    localStatusReason: { type: String, maxlength: MAX_REASON_LENGTH },
    crowdSourceReportId: { type: String },
    crowdSourceCaseId: { type: String },
    snapshotHash: { type: String },
    deliveredAt: { type: Date },
    decidedAt: { type: Date },
  },
  { timestamps: true },
);

/**
 * One report per reporter per object.
 *
 * A unique index rather than a service-layer check: two taps on a report button
 * race, and the loser must not open a second case. The intake transaction reads
 * this first for a friendly error, but the index is what actually holds.
 */
AbuseReportSchema.index(
  { reporterOxyUserId: 1, reportedType: 1, reportedId: 1 },
  { unique: true },
);

/** Operator sweep: what is owed delivery, and what is stuck. */
AbuseReportSchema.index({ localStatus: 1, createdAt: -1 });

/** Every report about one object — what enforcement resolves a decision against. */
AbuseReportSchema.index({ reportedType: 1, reportedId: 1, createdAt: -1 });

/** Inbound decisions arrive naming the case, never the local report. */
AbuseReportSchema.index(
  { crowdSourceCaseId: 1 },
  { sparse: true },
);

export const AbuseReport: Model<IAbuseReport> =
  mongoose.models.AbuseReport ||
  mongoose.model<IAbuseReport>('AbuseReport', AbuseReportSchema);
