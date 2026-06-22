/**
 * Feedback service — the user's submitted product feedback.
 *
 * All operations are scoped to `oxyUserId`. A submission is created in the
 * `pending` review state; the caller can list their own feedback history
 * (newest first, paginated) and read a single item back. Logic lives here; the
 * controller is thin.
 */

import { Feedback, type IFeedback } from '../models/feedback.js';
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

/** Serialize an `IFeedback` document to the wire `FeedbackDTO`. */
function toDTO(doc: IFeedback): FeedbackDTO {
  const dto: FeedbackDTO = {
    id: String(doc._id),
    type: doc.type,
    message: doc.message,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
  if (doc.rating !== undefined) dto.rating = doc.rating;
  if (doc.email !== undefined) dto.email = doc.email;
  return dto;
}

/** Create a feedback submission for the user (starts in the `pending` state). */
export async function create(
  oxyUserId: string,
  input: CreateFeedbackInput,
): Promise<FeedbackDTO> {
  const doc = await Feedback.create({
    oxyUserId,
    type: input.type,
    rating: input.rating,
    message: input.message,
    email: input.email,
    metadata: input.metadata,
    status: 'pending',
  });
  return toDTO(doc.toObject());
}

/** List the user's feedback history (newest first, offset-paginated). */
export async function list(
  oxyUserId: string,
  opts: { page: number; limit: number },
): Promise<{ data: FeedbackDTO[]; total: number }> {
  const { page, limit } = opts;
  const [docs, total] = await Promise.all([
    Feedback.find({ oxyUserId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<IFeedback[]>(),
    Feedback.countDocuments({ oxyUserId }),
  ]);
  return { data: docs.map(toDTO), total };
}

/** Read a single feedback item owned by the user, or throw NOT_FOUND. */
export async function getById(oxyUserId: string, feedbackId: string): Promise<FeedbackDTO> {
  const doc = await Feedback.findOne({ _id: feedbackId, oxyUserId }).lean<IFeedback | null>();
  if (!doc) {
    throw notFound('Feedback not found');
  }
  return toDTO(doc);
}
