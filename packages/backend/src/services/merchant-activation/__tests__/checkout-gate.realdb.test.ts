/**
 * The activation gate against a REAL PostgreSQL server, for the owner kind it
 * used to skip.
 *
 * ## Why this file exists
 *
 * `assertSellerGroupsActivated` filtered its input to `store:` groups and
 * returned early when none remained. `planConnectedMarketplaceFee` does not:
 * it selects a schedule on `eligible_seller_type`, whose values are `store`,
 * `user` and ABSENT meaning both, and then calculates and snapshots the fee for
 * whichever it selected. So an individual seller under a `user`-reaching
 * schedule was charged a commission, with `termsVersionAccepted` absent from
 * the snapshot, and nothing refused the sale. The default scope — no
 * `eligible_seller_type` at all — is one that reaches them.
 *
 * ## Why realdb, and not a mock
 *
 * The gate's whole answer is a database read: whether a row exists in
 * `fee_schedule_acceptances` for `(ownerType, ownerId, scheduleKey,
 * scheduleVersion)`. A mocked repository would assert that this file passes the
 * arguments it passes, which is a restatement rather than a test — the unique
 * index, the owner-type CHECK and the real absence of a row are what make the
 * refusal mean anything.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every owner id carries `RUN`, so no case can see a sibling file's rows and no
 * case aggregates over a table. Acceptances are NOT torn down: the DELETE
 * trigger refuses one, exactly as `merchant-activation.realdb.test.ts` records.
 * They leave with the throwaway database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { insertFeeScheduleAcceptance } from '../../../db/fees/feeScheduleRepository.js';
import { isCheckoutRefusal } from '../../checkout/refusal.js';
import { assertSellerGroupsActivated } from '../checkout-gate.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7();

const SCHEDULE = { scheduleKey: `gate-${RUN}`, version: 1 } as const;

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

/**
 * Assert the gate refused, and refused with the ONE reason it has.
 *
 * `rejects.toThrow()` alone would pass on a connection failure or a typo'd
 * column, which is the failure this file is least able to notice by eye — the
 * gate's whole job is to reject, so "it threw" is nearly free.
 */
async function expectRefusal(run: () => Promise<unknown>): Promise<void> {
  let raised: unknown;
  try {
    await run();
  } catch (err) {
    raised = err;
  }
  expect(raised, 'the gate admitted a seller it should have refused').toBeDefined();
  expect(isCheckoutRefusal(raised)).toBe(true);
  if (isCheckoutRefusal(raised)) expect(raised.reason).toBe('seller_not_activated');
}

describe('the activation gate reads both owner kinds', () => {
  it('refuses an individual seller who has not accepted the applicable schedule', async () => {
    // The case that used to pass silently: no acceptance row exists for this
    // person, and before the fix the gate never looked.
    await expectRefusal(() =>
      assertSellerGroupsActivated([
        { sellerKey: `user:seller-unaccepted-${RUN}`, feeSchedule: SCHEDULE },
      ]),
    );
  });

  it('admits an individual seller once the acceptance row exists', async () => {
    const ownerId = `seller-accepted-${RUN}`;
    await insertFeeScheduleAcceptance(db, {
      scheduleKey: SCHEDULE.scheduleKey,
      scheduleVersion: SCHEDULE.version,
      termsVersion: 'v1',
      ownerType: 'user',
      ownerId,
      acceptedByOxyUserId: `oxy-${RUN}`,
    });

    await expect(
      assertSellerGroupsActivated([{ sellerKey: `user:${ownerId}`, feeSchedule: SCHEDULE }]),
    ).resolves.toBeUndefined();
  });

  it('admits an individual seller when no schedule applies at all', async () => {
    // #88's honest zero. A deployment that has published no fee policy must
    // still be able to sell, and this is the boundary that keeps the case above
    // from being satisfied by "the gate refuses every P2P sale".
    await expect(
      assertSellerGroupsActivated([{ sellerKey: `user:seller-nofee-${RUN}` }]),
    ).resolves.toBeUndefined();
  });

  it('still refuses a store that has not accepted, and admits one with no schedule', async () => {
    // The store half, unchanged — a floor under the refactor that widened the
    // filter. A store id nothing created reads the UNWRITTEN settings default,
    // whose intents are enabled and whose hold is absent, so the acceptance is
    // the only lever these two cases move.
    await expectRefusal(() =>
      assertSellerGroupsActivated([
        { sellerKey: `store:store-unaccepted-${RUN}`, feeSchedule: SCHEDULE },
      ]),
    );
    await expect(
      assertSellerGroupsActivated([{ sellerKey: `store:store-nofee-${RUN}` }]),
    ).resolves.toBeUndefined();
  });

  it('ignores a malformed seller key rather than reading it as an owner', async () => {
    // `user:` with nothing after it is not an owner, and treating the empty
    // string as one would look up an acceptance for owner id '' — a row another
    // caller could create.
    await expect(
      assertSellerGroupsActivated([{ sellerKey: 'user:', feeSchedule: SCHEDULE }]),
    ).resolves.toBeUndefined();
    await expect(
      assertSellerGroupsActivated([{ sellerKey: `nonsense-${RUN}`, feeSchedule: SCHEDULE }]),
    ).resolves.toBeUndefined();
  });
});
