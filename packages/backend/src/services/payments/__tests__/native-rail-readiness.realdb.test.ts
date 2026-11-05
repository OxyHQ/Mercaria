/**
 * The seller-readiness gate on the Peable rail.
 *
 * A `realdb` file because the property is a property of the query: the gate has
 * to reach `provider_accounts`, look for an account ON THE NATIVE RAIL, and
 * refuse when there is none or it is not `ready`. A mocked repository would
 * accept whichever provider the caller passed and answer whatever the test
 * wired, which is exactly the disagreement being tested.
 *
 * ## The bug this pins, stated so the assertions below are readable
 *
 * `assertSellerGroupsPaymentReady` once opened with a check on a DIFFERENT
 * rail's flag, so on a Peable-only deployment it returned before looking at
 * anything and a checkout admitted every seller — including one with no
 * connected account at all. ADR 0001 D4 exists to refuse exactly that seller.
 * It failed OPEN while the two readiness READS beside it failed closed, so the
 * dashboard told the seller they were not ready while checkout sold through
 * them anyway.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@oxy.so/db';

const rails = { peable: false };

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
      },
    },
  };
});

/**
 * Oxy's profile lookup is a network call to another service; what it answers is
 * the input here, so it is stubbed at the module boundary. Everything on THIS
 * side of it — the store read, the gate, the refusal — is real.
 */
const oxyProfiles = new Map<string, { id: string; username: string; displayName: string }>();
vi.mock('../../oxy-user.service.js', () => ({
  getProfiles: async (ids: string[]) =>
    new Map(ids.flatMap((id) => (oxyProfiles.has(id) ? [[id, oxyProfiles.get(id)]] : []))),
}));

let assertSellerGroupsPaymentReady: typeof import('../provider-account.service.js')['assertSellerGroupsPaymentReady'];
let isSellerPaymentReady: typeof import('../provider-account.service.js')['isSellerPaymentReady'];
let readSellerPaymentReadiness: typeof import('../provider-account.service.js')['readSellerPaymentReadiness'];
let closePostgres: typeof import('../../../db/postgres.js')['closePostgres'];
let getDb: typeof import('../../../db/postgres.js')['getDb'];
let accounts: typeof import('../../../db/payments/providerAccountRepository.js');
let storeRepository: typeof import('../../../db/stores/storeRepository.js');

beforeAll(async () => {
  // Dynamic, for the reason the refund lifecycle file gives: a STATIC import of
  // the service pulls `db/postgres.js` and therefore `config/index.ts`, which
  // freezes its view of process.env at module load. The rail flags above are
  // getters on a mocked config precisely so this file can move them per case,
  // but the connection still has to be opened before the first query.
  const postgres = await import('../../../db/postgres.js');
  await postgres.connectPostgres();
  ({ closePostgres, getDb } = postgres);
  accounts = await import('../../../db/payments/providerAccountRepository.js');
  storeRepository = await import('../../../db/stores/storeRepository.js');
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

/** A seller this run owns whose Peable account the stored verdict calls `ready`. */
async function readySellerKey(): Promise<string> {
  const ownerId = `native-rail-${uuidv7()}`;
  const row = await accounts.insertProviderAccount(getDb(), {
    provider: 'peable',
    ownerType: 'store',
    ownerId,
    providerAccountId: `acct_ready_${uuidv7()}`,
    country: 'ES',
  });
  await accounts.applyProviderAccountState(getDb(), {
    id: row.id,
    state: {
      onboardingState: 'ready',
      chargesEnabled: false,
      payoutsEnabled: true,
      transfersCapability: 'active',
      requirementsCurrentlyDue: 0,
      requirementsEventuallyDue: 0,
      requirementsPastDue: 0,
      requirementsPendingVerification: 0,
      disabledReasonCodes: [],
      syncedAt: new Date(),
    },
  });
  return `store:${ownerId}`;
}

/** A real store row this run owns, with no provider account, named `name`. */
async function unconnectedStore(name: string): Promise<string> {
  const store = await storeRepository.insertStore({
    oxyAccountId: `native-rail-owner-${uuidv7()}`,
    handle: `native-rail-${uuidv7()}`,
    name,
    description: '',
    brandColor: '#204060',
    defaultCurrency: 'USD',
  });
  return `store:${store.id}`;
}

/** The refusal a gate threw, or `undefined` when it admitted the checkout. */
async function refusalOf(
  sellerKeys: string[],
): Promise<{ message: string; httpStatus: number; details?: unknown } | undefined> {
  return await assertSellerGroupsPaymentReady(sellerKeys).then(
    () => undefined,
    (err: unknown) => err as { message: string; httpStatus: number; details?: unknown },
  );
}

beforeEach(() => {
  rails.peable = false;
  oxyProfiles.clear();
});

describe('seller readiness follows the native rail', () => {
  /** THE regression: the gate queries, and refuses a seller with no account. */
  it('refuses an unconnected seller when Peable is configured', async () => {
    rails.peable = true;
    const sellerKey = unconnectedSellerKey();

    await expect(assertSellerGroupsPaymentReady([sellerKey])).rejects.toThrow(
      /cannot accept payment right now/,
    );
  });

  /** The positive half, so the refusal above is not vacuous. */
  it('admits a seller whose Peable account is ready', async () => {
    rails.peable = true;
    const sellerKey = await readySellerKey();

    await expect(assertSellerGroupsPaymentReady([sellerKey])).resolves.toBeUndefined();
    expect(await isSellerPaymentReady(sellerKey)).toBe(true);
    expect((await readSellerPaymentReadiness([sellerKey])).get(sellerKey)).toBe(true);
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
  it('reads and gate agree, with the rail and without it', async () => {
    for (const peable of [true, false]) {
      rails.peable = peable;
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
      expect(gateRefused).toBe(peable);
    }
  });
});

/**
 * The buyer reads NAMES, never `store:<id>` (owner rule: no internal ids in a
 * buyer's error). Real rows, so the name is the one `stores.name` holds and the
 * key the one checkout groups by.
 */
describe('the refusal names each seller the way the cart does', () => {
  it('names an unready store by its store name, keeping the key in details only', async () => {
    rails.peable = true;
    const sellerKey = await unconnectedStore('Lumen Ceramics');

    const refusal = await refusalOf([sellerKey]);

    expect(refusal?.httpStatus).toBe(409);
    expect(refusal?.message).toBe(
      'Lumen Ceramics cannot accept payment right now. ' +
        'Remove their items from your order to check out with the rest.',
    );
    expect(refusal?.message).not.toContain('store:');
    expect(refusal?.details).toEqual({
      reason: 'seller_not_payment_ready',
      sellers: [{ sellerKey, name: 'Lumen Ceramics' }],
    });
  });

  it('names several sellers — a store and a private seller — and only the unready ones', async () => {
    rails.peable = true;
    const store = await unconnectedStore('North Pole Books');
    const oxyUserId = `native-rail-person-${uuidv7()}`;
    oxyProfiles.set(oxyUserId, { id: oxyUserId, username: 'ada', displayName: 'Ada Lovelace' });
    const person = `user:${oxyUserId}`;
    const ready = await readySellerKey();

    const refusal = await refusalOf([store, ready, person]);

    expect(refusal?.message).toBe(
      'These sellers cannot accept payment right now: North Pole Books and Ada Lovelace. ' +
        'Remove their items from your order to check out with the rest.',
    );
    expect(refusal?.message).not.toMatch(/store:|user:|native-rail-/);
    expect(refusal?.details).toEqual({
      reason: 'seller_not_payment_ready',
      sellers: [
        { sellerKey: store, name: 'North Pole Books' },
        { sellerKey: person, name: 'Ada Lovelace' },
      ],
    });
  });

  it('says "A seller" — never the id — when Oxy cannot name a private seller', async () => {
    rails.peable = true;
    const unknownId = `native-rail-unknown-${uuidv7()}`;
    // Oxy's own fallback chain ends at the account id: that is not a name either.
    const handlelessId = `native-rail-handleless-${uuidv7()}`;
    oxyProfiles.set(handlelessId, {
      id: handlelessId,
      username: handlelessId,
      displayName: handlelessId,
    });

    for (const oxyUserId of [unknownId, handlelessId]) {
      const person = `user:${oxyUserId}`;
      const refusal = await refusalOf([person]);

      expect(refusal?.message).toMatch(/^A seller cannot accept payment right now\./);
      expect(refusal?.message).not.toContain(oxyUserId);
      expect(refusal?.details).toEqual({
        reason: 'seller_not_payment_ready',
        sellers: [{ sellerKey: person }],
      });
    }
  });
});
