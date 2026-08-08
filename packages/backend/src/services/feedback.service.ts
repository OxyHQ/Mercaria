/**
 * Feedback service — the user's submitted product feedback.
 *
 * All operations are scoped to `oxyUserId`. A submission is created in the
 * `pending` review state; the caller can list their own feedback history
 * (newest first, paginated) and read a single item back. Logic lives here; the
 * controller is thin.
 *
 * ## Ported to Postgres — the two things that changed shape
 *
 *  - **`metadata` is three columns, not an open object.** Its TypeScript type
 *    carried an index signature, but the Mongoose SCHEMA declared only
 *    `platform`, `appVersion` and `deviceInfo` and strict mode dropped every
 *    other key, so nothing open-shaped was ever stored. {@link metadataString}
 *    does explicitly what the schema used to do silently — including the
 *    `type: String` CAST, so a client sending `appVersion: 3` still stores
 *    `"3"`. The one behaviour that does NOT survive is Mongoose throwing a
 *    CastError on an object-valued entry, which was a 500 on a telemetry field;
 *    it is stored as NULL instead.
 *  - **`email` is a PROTECTED column and this path names it.** Every read is
 *    scoped to the author, so what comes back is the address the caller
 *    themselves typed — see the header of `db/buyers/feedbackRepository.ts` for
 *    the explicit opt-in and why the protection still stands for the operator
 *    surface that does not exist yet. A field Mongo left ABSENT is NULL here, so
 *    the serializer omits a null rather than emitting one.
 */

import {
  findFeedback,
  findFeedbackPage,
  insertFeedback,
  type FeedbackRecord,
} from '../db/buyers/feedbackRepository.js';
import { notFound } from '../lib/errors/error-codes.js';

/** A single piece of feedback as returned on the wire. */
export interface FeedbackDTO {
  id: string;
  type: 'bug' | 'feature' | 'improvement' | 'other';
  rating?: number;
  message: string;
  email?: string;
  status: 'pending' | 'reviewed' | 'resolved';
  createdAt: string;
  updatedAt: string;
}

/** Body accepted by `create` (assignable from the parsed `feedbackSchema`). */
export interface CreateFeedbackInput {
  type: 'bug' | 'feature' | 'improvement' | 'other';
  rating?: number;
  message: string;
  email?: string;
  metadata?: Record<string, unknown>;
}

/**
 * One `metadata` entry as the `text` column stores it.
 *
 * Re-applies Mongoose's `type: String` cast at the call site, since Postgres has
 * no equivalent: a string is kept, a number or boolean becomes its string form
 * (which is what the collection holds today), and anything else — the shapes
 * Mongoose rejected outright — is dropped to NULL rather than failing the
 * submission over a telemetry field.
 */
function metadataString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Serialize a `feedback` row to the wire `FeedbackDTO`. */
function toDTO(row: FeedbackRecord): FeedbackDTO {
  const dto: FeedbackDTO = {
    id: row.id,
    type: row.type,
    message: row.message,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.rating !== null) dto.rating = row.rating;
  if (row.email !== null) dto.email = row.email;
  return dto;
}

/** Create a feedback submission for the user (starts in the `pending` state). */
export async function create(
  oxyUserId: string,
  input: CreateFeedbackInput,
): Promise<FeedbackDTO> {
  const metadata = input.metadata ?? {};
  const row = await insertFeedback(oxyUserId, {
    type: input.type,
    message: input.message,
    ...(input.rating !== undefined ? { rating: input.rating } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    metadataPlatform: metadataString(metadata.platform),
    metadataAppVersion: metadataString(metadata.appVersion),
    metadataDeviceInfo: metadataString(metadata.deviceInfo),
  });
  return toDTO(row);
}

/** List the user's feedback history (newest first, offset-paginated). */
export async function list(
  oxyUserId: string,
  opts: { page: number; limit: number },
): Promise<{ data: FeedbackDTO[]; total: number }> {
  const { rows, total } = await findFeedbackPage(oxyUserId, opts.page, opts.limit);
  return { data: rows.map(toDTO), total };
}

/** Read a single feedback item owned by the user, or throw NOT_FOUND. */
export async function getById(oxyUserId: string, feedbackId: string): Promise<FeedbackDTO> {
  const row = await findFeedback(oxyUserId, feedbackId);
  if (!row) {
    throw notFound('Feedback not found');
  }
  return toDTO(row);
}
