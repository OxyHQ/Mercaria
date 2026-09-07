/**
 * The seller-readiness gate on a deployment whose native rail is NOT Stripe.
 *
 * This is the mutation check for the bug the rail resolution closes, and it is
 * a `realdb` file because the property is a property of the query: the gate has
 * to reach `provider_accounts`, look for an account ON THE RESOLVED RAIL, and
 * refuse when there is none. A mocked repository would accept whichever
 * provider the caller passed and answer whatever the test wired, which is
 * exactly the disagreement being tested.
 *
 * ## The bug, stated so the assertions below are readable
 *
 * `assertSellerGroupsPaymentReady` opened with
 * `if (!config.payments.stripe.enabled) return;`. On a Peable-only deployment
 * that returned BEFORE looking at anything, so a checkout admitted every seller
 * — including one with no connected account at all, on any rail. ADR 0001 D4
 * exists to refuse exactly that seller, and the gate that enforces it was
 * skipping itself. It failed OPEN while the two readiness READS beside it
 * (`readSellerPaymentReadiness`, `isSellerPaymentReady`) failed closed, so the
 * dashboard told the seller they were not ready while checkout sold through
 * them anyway.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@oxyhq/db';

const rails = { peable: false, stripe: false };

vi.mock('../../../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config/index.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      payments: {
        ...actual.config.payments,
        peable: {
          ...actual.config.payments.peable,
          get enabled() {
            return rails.peable;
          },
        },
        stripe: {
          ...actual.config.payments.stripe,
          get enabled() {
            return rails.stripe;
          },
        },
      },
    },
  };
});

let assertSellerGroupsPaymentReady: typeof import('../provider-account.service.js')['assertSellerGroupsPaymentReady'];
let isSellerPaymentReady: typeof import('../provider-account.service.js')['isSellerPaymentReady'];
let readSellerPaymentReadiness: typeof import('../provider-account.service.js')['readSellerPaymentReadiness'];
let closePostgres: typeof import('../../../db/postgres.js')['closePostgres'];

beforeAll(async () => {
  // Dynamic, for the reason the refund lifecycle file gives: a STATIC import of
  // the service pulls `db/postgres.js` and therefore `config/index.ts`, which
  // freezes its view of process.env at module load. The rail flags above are
  // getters on a mocked config precisely so this file can move them per case,
  // but the connection still has to be opened before the first query.
  const postgres = await import('../../../db/postgres.js');
  await postgres.connectPostgres();
  ({ closePostgres } = postgres);
  ({ assertSellerGroupsPaymentReady, isSellerPaymentReady, readSellerPaymentReadiness } =
    await import('../provider-account.service.js'));
});

afterAll(async () => {
  await closePostgres();
});

/** A seller this run owns, who has no provider account on any rail. */
function unconnectedSellerKey(): string {
  return `store:native-rail-${uuidv7()}`;
}

beforeEach(() => {
  rails.peable = false;
  rails.stripe = false;
});

describe('seller readiness follows the resolved rail', () => {
  /**
   * THE regression. With Stripe off and Peable on, the gate used to return
   * without a query and the checkout proceeded.
   */
  it('refuses an unconnected seller on a Peable-only deployment', async () => {
    rails.peable = true;
    const sellerKey = unconnectedSellerKey();

    await expect(assertSellerGroupsPaymentReady([sellerKey])).rejects.toThrow(
      /cannot accept payment right now/,
    );
  });

  /** Unchanged behaviour on the rail that already worked, so this is a widening. */
  it('refuses an unconnected seller on a Stripe-only deployment', async () => {
    rails.stripe = true;
    const sellerKey = unconnectedSellerKey();

    await expect(assertSellerGroupsPaymentReady([sellerKey])).rejects.toThrow(
      /cannot accept payment right now/,
    );
  });

  /**
   * The early return is still correct where it was always correct: with no rail
   * at all there is nothing to be ready FOR, the only path to `paid` is the
   * dev-only `mockPay` seam, and a checkout places orders exactly as it did
   * before payments existed.
   */
  it('admits every seller when the deployment has no rail at all', async () => {
    await expect(assertSellerGroupsPaymentReady([unconnectedSellerKey()])).resolves.toBeUndefined();
  });

  /**
   * The two reads agree with the gate on every deployment shape. They disagreed
   * before — the gate skipped while the reads said `false` — and a seller shown
   * "not ready" who is nevertheless sold through is the worst of both answers.
   */
  it('reads and gate agree, on each rail and on none', async () => {
    for (const [peable, stripe] of [
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      rails.peable = peable;
      rails.stripe = stripe;
      const sellerKey = unconnectedSellerKey();

      const gateRefused = await assertSellerGroupsPaymentReady([sellerKey]).then(
        () => false,
        () => true,
      );
      const readReady = await isSellerPaymentReady(sellerKey);
      const bulk = await readSellerPaymentReadiness([sellerKey]);

      // No account exists, so no read can say `ready`; the gate refuses exactly
      // when there is a rail to be unready for.
      expect(readReady).toBe(false);
      expect(bulk.get(sellerKey)).toBeUndefined();
      expect(gateRefused).toBe(peable || stripe);
    }
  });
});
