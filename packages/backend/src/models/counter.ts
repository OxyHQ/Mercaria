/**
 * Counter model — atomic, monotonically increasing sequences.
 *
 * Backs human-friendly, sequential numbers (`MRC-000123`, `MRC-DRAFT-000123`):
 * the number is NOT its ObjectId (opaque, non-sequential) but a short padded
 * counter. Each generator atomically `$inc`s a single counter document (one per
 * sequence name) so concurrent callers can never mint the same number.
 */

import mongoose, { Schema, Model } from 'mongoose';

/** The sequence name used for order numbers. */
const ORDER_COUNTER_ID = 'order';
/** Prefix prepended to every order number. */
const ORDER_NUMBER_PREFIX = 'MRC-';
/** Zero-padding width of the numeric portion of an order number. */
const ORDER_NUMBER_PAD = 6;

/** The sequence name used for draft order numbers. */
const DRAFT_ORDER_COUNTER_ID = 'draftOrder';
/** Prefix prepended to every draft order number. */
const DRAFT_ORDER_NUMBER_PREFIX = 'MRC-DRAFT-';
/** Zero-padding width of the numeric portion of a draft order number. */
const DRAFT_ORDER_NUMBER_PAD = 6;

export interface ICounter {
  /** The sequence name (e.g. `'order'`). */
  _id: string;
  /** The current value of the sequence. */
  seq: number;
}

const CounterSchema = new Schema<ICounter>({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

export const Counter: Model<ICounter> =
  mongoose.models.Counter || mongoose.model<ICounter>('Counter', CounterSchema);

/**
 * Atomically allocate the next value of `counterId`, formatted as
 * `<prefix><zero-padded seq>`. Upserts + `$inc`s the counter document so two
 * concurrent callers always receive distinct numbers.
 */
async function nextSequence(counterId: string, prefix: string, pad: number): Promise<string> {
  const doc = await Counter.findByIdAndUpdate(
    counterId,
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  const seq = doc?.seq ?? 0;
  return `${prefix}${String(seq).padStart(pad, '0')}`;
}

/**
 * Atomically allocate the next order number (`MRC-<zero-padded seq>`). Two
 * concurrent callers always receive distinct numbers.
 */
export async function nextOrderNumber(): Promise<string> {
  return nextSequence(ORDER_COUNTER_ID, ORDER_NUMBER_PREFIX, ORDER_NUMBER_PAD);
}

/**
 * Atomically allocate the next draft order number (`MRC-DRAFT-<zero-padded seq>`).
 * Two concurrent callers always receive distinct numbers.
 */
export async function nextDraftOrderNumber(): Promise<string> {
  return nextSequence(DRAFT_ORDER_COUNTER_ID, DRAFT_ORDER_NUMBER_PREFIX, DRAFT_ORDER_NUMBER_PAD);
}
