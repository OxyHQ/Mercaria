/**
 * Unit tests for `feedback.service`.
 *
 * `feedback` is Postgres now, so `db/buyers/feedbackRepository` is mocked in
 * place of the `Feedback` model.
 *
 * The port introduced ONE piece of real logic and this file exists for it:
 * `metadata` was an open object backed by a Mongoose schema that declared three
 * strict paths, so strict mode dropped every other key and `type: String` cast
 * the three it kept. Postgres has neither behaviour, so the service now does both
 * explicitly — and a narrowing with no fixture in the shape it narrows is
 * indistinguishable from no narrowing at all. Each case below is a shape where
 * doing it and not doing it disagree.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertFeedback = vi.fn();
const findFeedback = vi.fn();
const findFeedbackPage = vi.fn();

vi.mock('../../db/buyers/feedbackRepository.js', () => ({
  insertFeedback: (...args: unknown[]) => insertFeedback(...args),
  findFeedback: (...args: unknown[]) => findFeedback(...args),
  findFeedbackPage: (...args: unknown[]) => findFeedbackPage(...args),
}));

import { create, getById, list } from '../feedback.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const USER = 'reporter-1';

/** Every row fixture carries the same timestamps; none of them is asserted on. */
const AT = new Date('2026-01-01T00:00:00.000Z');

/** A `feedback` ROW as the repository returns it — optionals NULL, not absent. */
function feedbackRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'feedback-1',
    oxyUserId: USER,
    type: 'bug',
    rating: null,
    message: 'Something is wrong',
    email: null,
    metadataPlatform: null,
    metadataAppVersion: null,
    metadataDeviceInfo: null,
    status: 'pending',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertFeedback.mockResolvedValue(feedbackRow());
});

describe('feedback.service.create — the metadata narrowing', () => {
  it('keeps the three declared keys and DROPS everything else', async () => {
    // The Mongoose schema declared exactly three paths and strict mode discarded
    // the rest, so nothing open-shaped was ever stored. A fixture carrying only
    // the three keys could not tell that from a straight pass-through.
    await create(USER, {
      type: 'bug',
      message: 'Something is wrong',
      metadata: {
        platform: 'ios',
        appVersion: '1.4.0',
        deviceInfo: 'iPhone 15',
        sessionToken: 'must-not-be-stored',
        nested: { anything: true },
      },
    });

    const [, values] = insertFeedback.mock.calls[0];
    expect(values).toEqual({
      type: 'bug',
      message: 'Something is wrong',
      metadataPlatform: 'ios',
      metadataAppVersion: '1.4.0',
      metadataDeviceInfo: 'iPhone 15',
    });
  });

  it('CASTS a number or boolean to its string form, as `type: String` did', async () => {
    // The shape where a strict `typeof === 'string'` check and Mongoose's cast
    // disagree: a client sending `appVersion: 3` stores `"3"` in the collection
    // today, and dropping it would be a silent narrowing of the port.
    await create(USER, {
      type: 'other',
      message: 'Numbers',
      metadata: { platform: 3, appVersion: false, deviceInfo: 'ok' },
    });

    const [, values] = insertFeedback.mock.calls[0];
    expect(values.metadataPlatform).toBe('3');
    expect(values.metadataAppVersion).toBe('false');
  });

  it('drops an object-valued entry instead of failing the submission', async () => {
    // Mongoose raised a CastError here, which was a 500 on a telemetry field. The
    // only behaviour the port deliberately does NOT preserve.
    await create(USER, {
      type: 'other',
      message: 'Objects',
      metadata: { platform: { name: 'ios' } },
    });

    const [, values] = insertFeedback.mock.calls[0];
    expect(values.metadataPlatform).toBeUndefined();
  });

  it('names no metadata columns at all when the caller sent none', async () => {
    await create(USER, { type: 'feature', message: 'A wish' });

    const [oxyUserId, values] = insertFeedback.mock.calls[0];
    expect(oxyUserId).toBe(USER);
    expect(values.metadataPlatform).toBeUndefined();
    expect(values.metadataAppVersion).toBeUndefined();
    expect(values.metadataDeviceInfo).toBeUndefined();
    // `status` is the column DEFAULT (`pending`), not something the service sends.
    expect(Object.hasOwn(values, 'status')).toBe(false);
  });
});

describe('feedback.service — serialization', () => {
  it('omits NULL optionals rather than emitting them as null', async () => {
    findFeedback.mockResolvedValue(feedbackRow());

    const dto = await getById(USER, 'feedback-1');

    expect(Object.hasOwn(dto, 'rating')).toBe(false);
    expect(Object.hasOwn(dto, 'email')).toBe(false);
    // The three metadata columns are stored but never served — the DTO has never
    // carried them and the port must not start.
    expect(Object.keys(dto).sort()).toEqual([
      'createdAt',
      'id',
      'message',
      'status',
      'type',
      'updatedAt',
    ]);
  });

  it('carries the optionals through when they are set', async () => {
    // The mirror case: without it the assertion above passes against a serializer
    // that drops `rating` and `email` unconditionally.
    findFeedbackPage.mockResolvedValue({
      rows: [feedbackRow({ rating: 4, email: 'reporter@example.com' })],
      total: 1,
    });

    const { data, total } = await list(USER, { page: 2, limit: 10 });

    expect(total).toBe(1);
    expect(data[0]).toMatchObject({ rating: 4, email: 'reporter@example.com' });
    expect(findFeedbackPage).toHaveBeenCalledWith(USER, 2, 10);
  });

  it('raises NOT_FOUND for another reporter’s submission', async () => {
    // The repository returns `null` for "no such item" AND "someone else's" — the
    // scoping IS the authorization, and the caller cannot tell them apart.
    findFeedback.mockResolvedValue(null);

    await expect(getById(USER, 'feedback-9')).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.NOT_FOUND,
    );
  });
});
