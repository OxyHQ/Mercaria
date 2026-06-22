/**
 * Counter model — atomic, monotonically increasing sequences.
 *
 * Backs human-friendly, sequential order numbers (`MRC-000123`): an order's
 * number is NOT its ObjectId (opaque, non-sequential) but a short padded
 * counter. `nextOrderNumber` atomically `$inc`s a single counter document (one
 * per sequence name) so concurrent checkouts can never mint the same number.
 */

import mongoose, { Schema, Model } from 'mongoose';

/** The sequence name used for order numbers. */
const ORDER_COUNTER_ID = 'order';
/** Prefix prepended to every order number. */
const ORDER_NUMBER_PREFIX = 'MRC-';
/** Zero-padding width of the numeric portion of an order number. */
const ORDER_NUMBER_PAD = 6;

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
 * Atomically allocate the next order number. Upserts + `$inc`s the `'order'`
 * counter and formats the new value as `MRC-<zero-padded seq>`. Two concurrent
 * callers always receive distinct numbers.
 */
export async function nextOrderNumber(): Promise<string> {
  const doc = await Counter.findByIdAndUpdate(
    ORDER_COUNTER_ID,
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  const seq = doc?.seq ?? 0;
  return `${ORDER_NUMBER_PREFIX}${String(seq).padStart(ORDER_NUMBER_PAD, '0')}`;
}
