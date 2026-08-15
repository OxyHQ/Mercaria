/**
 * `classifyMerchantFacingFailure` — the ONE classification (#303, over #292).
 *
 * The property under test is not "each branch returns the right code". It is
 * that the CODE and the SENTENCE come from one decision, because the way #303's
 * reason column goes wrong is two classifiers that agree on the day they are
 * written: one composing the string and a second deriving the code, diverging
 * the first time somebody adds a branch to one of them.
 *
 * So every case asserts BOTH halves, and the last test asserts the delegation
 * itself over a table of inputs — mutate `merchantFacingFailureMessage` to
 * re-derive its own message and that test is what goes red.
 */

import { describe, expect, it } from 'vitest';
import { SYNC_RECORD_FAILURE_REASONS } from '@mercaria/shared-types';
import { conflict, validationError } from '../error-codes.js';
import {
  MERCHANT_FACING_MESSAGE_MAX_LENGTH,
  UNCLASSIFIED_FAILURE_MESSAGE,
  boundMerchantFacingMessage,
  classifyMerchantFacingFailure,
  merchantFacingFailureMessage,
} from '../merchant-facing.js';
import { SYNC_RECORD_FAILURE_DETAIL_MAX_LENGTH } from '../../../db/schema/connectors.js';

/**
 * A driver error as the app actually sees one: drizzle replaces the driver's
 * message with its own, and the SQLSTATE plus the constraint name live on
 * `cause` — which is exactly why `error ~ 'constraint'` was FALSE on every one
 * of the 1065-character rows #292 measured.
 */
function driverError(sqlState: string, constraintName?: string): Error {
  const cause = Object.assign(new Error('driver'), {
    code: sqlState,
    ...(constraintName === undefined ? {} : { constraint_name: constraintName }),
  });
  return Object.assign(new Error('Failed query: insert into "product_variants" …'), { cause });
}

describe('classifyMerchantFacingFailure', () => {
  it('classifies one of OUR refusals as `refused_by_rule` and keeps its sentence', () => {
    const classified = classifyMerchantFacingFailure(
      validationError('A product may have at most 100 variants'),
    );

    expect(classified.reasonCode).toBe('refused_by_rule');
    expect(classified.message).toBe('A product may have at most 100 variants');
  });

  it('tells a unique violation apart from any other database refusal', () => {
    // The two lead a merchant to opposite places. A duplicate is normally two
    // deliveries of one record racing and resolves itself; a check violation is
    // a rule that will keep refusing every run until something changes.
    const duplicate = classifyMerchantFacingFailure(driverError('23505', 'orders_store_id_source_key'));
    const other = classifyMerchantFacingFailure(driverError('23514', 'listings_status_check'));

    expect(duplicate.reasonCode).toBe('duplicate_record');
    expect(other.reasonCode).toBe('database_refused');
  });

  it('publishes the RULE and the CODE and never the statement (#292)', () => {
    const classified = classifyMerchantFacingFailure(driverError('23514', 'listings_status_check'));

    expect(classified.message).toContain('rule listings_status_check');
    expect(classified.message).toContain('code 23514');
    // The negative half, and it is the one that matters: the value being
    // replaced is `err.message`, which for a drizzle failure is the failing
    // statement plus its bound parameters.
    expect(classified.message).not.toContain('insert into');
    expect(classified.message).not.toContain('product_variants');
  });

  it('classifies a duplicate with a KNOWN remedy as a duplicate, not as its remedy text', () => {
    // `RECOGNISED_CONSTRAINTS` replaces the sentence wholesale, so this is the
    // case where a second classifier reading the MESSAGE would answer
    // `unclassified` — the message names neither a rule nor a code.
    const classified = classifyMerchantFacingFailure(
      driverError('23505', 'listings_store_id_handle_key'),
    );

    expect(classified.reasonCode).toBe('duplicate_record');
    expect(classified.message).toContain('same URL handle');
  });

  it('classifies anything it cannot read as `unclassified`', () => {
    for (const thrown of [new TypeError('undici'), 'a bare string', null, 0, undefined]) {
      const classified = classifyMerchantFacingFailure(thrown);
      expect(classified.reasonCode).toBe('unclassified');
      expect(classified.message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
    }
  });

  it('keeps a scrubbed-to-nothing MercariaError as OURS', () => {
    // It borrows the fallback SENTENCE because that is the only one available,
    // and keeps the CODE, because reporting it as `unclassified` would say the
    // opposite of what is known: somebody's rule composed this refusal.
    const classified = classifyMerchantFacingFailure(conflict('   '));

    expect(classified.reasonCode).toBe('refused_by_rule');
    expect(classified.message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
  });

  it('never returns an empty detail, whatever it was handed', () => {
    // A blank detail beside a reason code reads as "no reason was recorded",
    // which an ABSENT ROW already means — so the two would be indistinguishable,
    // and the column is NOT NULL because of it.
    for (const thrown of [validationError(''), conflict(''), new Error(''), '', null]) {
      expect(classifyMerchantFacingFailure(thrown).message.length).toBeGreaterThan(0);
    }
  });

  it('only ever answers with a reason the column accepts', () => {
    const answered = [
      validationError('ours'),
      driverError('23505'),
      driverError('23514', 'x'),
      new TypeError('nope'),
    ].map((thrown) => classifyMerchantFacingFailure(thrown).reasonCode);

    // A floor as well as a membership test: an empty `answered` would satisfy
    // `every` and prove nothing.
    expect(answered).toHaveLength(4);
    for (const reason of answered) {
      expect(SYNC_RECORD_FAILURE_REASONS).toContain(reason);
    }
  });

  it('is the ONE source of the message — `merchantFacingFailureMessage` delegates', () => {
    const inputs = [
      validationError('ours'),
      conflict('a composed refusal'),
      driverError('23505', 'orders_store_id_source_key'),
      driverError('23514', 'listings_status_check'),
      driverError('40001'),
      new TypeError('undici'),
      'a bare string',
      null,
    ];

    // The vacuity floor: a table that shrank to nothing would pass this loop.
    expect(inputs).toHaveLength(8);
    for (const thrown of inputs) {
      expect(merchantFacingFailureMessage(thrown)).toBe(
        classifyMerchantFacingFailure(thrown).message,
      );
    }
  });
});

describe('the composer’s bound and the column’s bound', () => {
  it('leaves the column wide enough for every message the composer can produce', () => {
    // An IMPLICATION rather than an equality, which is the correct relation:
    // shortening the composed message is harmless, and a column NARROWER than
    // the composer would refuse a legitimate detail — so a run that refused a
    // product would fail to record that it had.
    expect(SYNC_RECORD_FAILURE_DETAIL_MAX_LENGTH).toBeGreaterThanOrEqual(
      MERCHANT_FACING_MESSAGE_MAX_LENGTH,
    );
  });

  it('bounds a message the composer cannot otherwise cap', () => {
    const composed = boundMerchantFacingMessage('x'.repeat(4_000));

    expect(composed.length).toBeLessThanOrEqual(MERCHANT_FACING_MESSAGE_MAX_LENGTH);
    expect(composed.length).toBeLessThanOrEqual(SYNC_RECORD_FAILURE_DETAIL_MAX_LENGTH);
  });
});
