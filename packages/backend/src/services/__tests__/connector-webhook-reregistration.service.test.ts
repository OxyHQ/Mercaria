/**
 * #262: the RETRY POLICY of webhook re-registration — what gets another attempt,
 * how far apart, and where it stops.
 *
 * ## What this file is for, and what it deliberately leaves to the realdb suite
 *
 * The convergence itself — that a re-registration actually adopts, recreates,
 * keeps the ids it holds and clears the refusals — is `reconcileWebhookSubscriptions`
 * driven through the real provider over a faked SOCKET, and it lives in
 * `connectors/__tests__/connector-contract-suite.ts`. A mocked provider here could
 * only restate the mock.
 *
 * What is provable ONLY here is the policy, because it is a decision rather than a
 * translation: which refusals are worth another attempt, that the claim is taken
 * BEFORE the platform is called, and that the flag stops the LOOP without touching
 * a stored fact. Each of those is a branch a real platform cannot be asked to take
 * on demand.
 *
 * The provider is mocked and the repository is mocked; the `config` module is
 * mocked because the flag is read from it, and reading a frozen singleton is the
 * only way this service can see it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findConnection = vi.fn();
const findConnectionsNeedingWebhookRegistration = vi.fn();
const claimConnectionWebhookRegistration = vi.fn();
const completeConnectionWebhookRegistration = vi.fn();
const releaseConnectionWebhookRegistration = vi.fn();
const recordConnectionWebhookRegistration = vi.fn();
const findConnectionWebhookSecret = vi.fn();
const registerWebhooks = vi.fn();
const decryptSecret = vi.fn();
const enqueueConnectionWebhookReregister = vi.fn();

/**
 * The flag + tunables the service reads; mutated per case.
 *
 * `vi.hoisted` because a `vi.mock` factory runs before the module body, so a plain
 * top-level const is not initialized when the factory closes over it.
 */
const connectorsConfig = vi.hoisted(() => ({
  webhookReregistrationEnabled: true,
  webhookReregistrationBatchSize: 7,
  webhookReregistrationLeaseMs: 120_000,
}));

vi.mock('../../config/index.js', () => ({ config: { connectors: connectorsConfig } }));
// `db/postgres.ts` is reached transitively and reads `config.postgres` inside its
// connect function; nothing here connects, and mocking it keeps a real pool out of
// a unit test that has no database.
vi.mock('../../db/postgres.js', () => ({
  getDb: () => {
    throw new Error('a unit test must not reach Postgres');
  },
  connectPostgres: vi.fn(),
  closePostgres: vi.fn(),
}));
vi.mock('../../db/connectors/connectionRepository.js', () => ({
  findConnection: (...a: unknown[]) => findConnection(...a),
  findConnectionsNeedingWebhookRegistration: (...a: unknown[]) =>
    findConnectionsNeedingWebhookRegistration(...a),
  claimConnectionWebhookRegistration: (...a: unknown[]) =>
    claimConnectionWebhookRegistration(...a),
  completeConnectionWebhookRegistration: (...a: unknown[]) =>
    completeConnectionWebhookRegistration(...a),
  releaseConnectionWebhookRegistration: (...a: unknown[]) =>
    releaseConnectionWebhookRegistration(...a),
  recordConnectionWebhookRegistration: (...a: unknown[]) =>
    recordConnectionWebhookRegistration(...a),
  findConnectionWebhookSecret: (...a: unknown[]) => findConnectionWebhookSecret(...a),
  findConnectionById: vi.fn(),
  findConnectionByProvider: vi.fn(),
  findConnectionCredentials: vi.fn().mockResolvedValue({ ciphertext: 'c', iv: 'i', tag: 't' }),
  findConnectionIdsByShopDomain: vi.fn(),
  findConnectionsByStore: vi.fn(),
  findConnectionWebhookFailures: vi.fn().mockResolvedValue(new Map()),
  findPullConnectionsToReconcile: vi.fn(),
  findPushConnections: vi.fn(),
  disconnectConnection: vi.fn(),
  markConnectionError: vi.fn(),
  markConnectionSynced: vi.fn(),
  touchConnectionLastSync: vi.fn(),
  updateSyncSettings: vi.fn(),
  upsertConnection: vi.fn(),
}));
vi.mock('../../db/connectors/syncRunRepository.js', () => ({
  insertSyncRun: vi.fn(),
  finishSyncRun: vi.fn(),
}));
vi.mock('../catalog-write.service.js', () => ({
  createStoreProduct: vi.fn(),
  updateListing: vi.fn(),
  updateVariant: vi.fn(),
  addVariant: vi.fn(),
  resolveDefaultLocationId: vi.fn(),
}));
vi.mock('../../lib/connector-crypto.js', () => ({
  encryptSecret: (value: string) => ({ ciphertext: value, iv: 'iv', tag: 'tag' }),
  decryptSecret: (...a: unknown[]) => decryptSecret(...a),
}));
vi.mock('../../connectors/registry.js', () => ({
  getConnectorProvider: () => ({
    id: 'woocommerce',
    webhookSecretStrategy: 'per_connection',
    registerWebhooks: (...a: unknown[]) => registerWebhooks(...a),
  }),
  isImplementedProvider: () => true,
}));
vi.mock('../../connectors/config.js', () => ({
  getWebhookAddress: () => 'https://api.mercaria.test/channels/webhooks/woocommerce',
  getOAuthRedirectUri: () => 'https://api.mercaria.test/channels/oauth/woocommerce/callback',
}));
vi.mock('../../queue/producers.js', () => ({
  enqueueConnectionWebhookReregister: (...a: unknown[]) =>
    enqueueConnectionWebhookReregister(...a),
  enqueueConnectionBackfill: vi.fn(),
  enqueueOrderSync: vi.fn(),
  enqueueInventorySync: vi.fn(),
  enqueueWebhookProcess: vi.fn(),
  enqueueProductPush: vi.fn(),
  enqueueFulfillmentPush: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  CONNECTOR_WEBHOOK_FAILURE_REASONS,
  CONNECTOR_WEBHOOK_RETRYABLE_FAILURE_REASONS,
  CONNECTOR_WEBHOOK_UNRETRYABLE_FAILURE_REASONS,
} from '@mercaria/shared-types';
import {
  reregisterConnectionWebhooks,
  requestWebhookReregistration,
  sweepConnectionWebhookRegistrations,
} from '../connector-sync.service.js';

describe('#262 — the two failure-reason lists PARTITION the vocabulary', () => {
  it('covers every reason exactly once, and the retryable half is derived by subtraction', () => {
    // Two lists over one vocabulary can disagree, and the direction they disagree
    // in decides whether a channel goes dark. This is the assertion that stops a
    // reason being covered TWICE or by NEITHER — the second is the dangerous one,
    // because a reason in neither list is one the SQL population never selects and
    // the service never classifies.
    const retryable = new Set<string>(CONNECTOR_WEBHOOK_RETRYABLE_FAILURE_REASONS);
    const unretryable = new Set<string>(CONNECTOR_WEBHOOK_UNRETRYABLE_FAILURE_REASONS);

    for (const reason of CONNECTOR_WEBHOOK_FAILURE_REASONS) {
      expect(
        retryable.has(reason) !== unretryable.has(reason),
        `${reason} is in both lists or in neither`,
      ).toBe(true);
    }
    expect(retryable.size + unretryable.size).toBe(CONNECTOR_WEBHOOK_FAILURE_REASONS.length);
    // The floor: a subtraction over an empty vocabulary would satisfy every line
    // above while classifying nothing.
    expect(unretryable.size).toBeGreaterThan(0);
    expect(retryable.size).toBeGreaterThan(0);
    // The DIRECTION of the derivation, which is the decision: a reason added to
    // the vocabulary later is retryable by omission, costing at most the bounded
    // attempt budget — the opposite default would leave a channel dark for a
    // reason nobody had classified.
    expect(unretryable).toContain('permission_denied');
    expect(unretryable).toContain('topic_not_supported');
  });
});

/** A connected, credentialled `pull` connection carrying `attempts` spent. */
function connection(attempts = 0) {
  return {
    id: 'conn-1',
    storeId: 'store-1',
    provider: 'woocommerce' as const,
    mode: 'pull' as const,
    status: 'connected' as const,
    hasCredentials: true,
    shopDomain: 'shop.example.test',
    webhookIds: [],
    webhookRegistrationState: 'pending' as const,
    webhookRegistrationAttempts: attempts,
    webhookRegistrationNextAttemptAt: null,
  };
}

/** A platform answer that reconciled and refused `failures`. */
function reconciled(failures: { topic: string; reason: string }[] = []) {
  return {
    outcome: 'reconciled' as const,
    subscriptions: [{ id: 'wh-1', topic: 'product.updated', origin: 'created' as const }],
    failures,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  connectorsConfig.webhookReregistrationEnabled = true;
  connectorsConfig.webhookReregistrationBatchSize = 7;
  findConnection.mockResolvedValue(connection());
  claimConnectionWebhookRegistration.mockImplementation(
    async (options: { countsAsAttempt: boolean }) =>
      // The claim is what increments, so the row it returns already carries this
      // attempt for the sweep — which is what the dead-letter bound reads.
      connection(options.countsAsAttempt ? 1 : 0),
  );
  completeConnectionWebhookRegistration.mockResolvedValue(true);
  releaseConnectionWebhookRegistration.mockResolvedValue(true);
  recordConnectionWebhookRegistration.mockImplementation(async () => connection());
  findConnectionWebhookSecret.mockResolvedValue({ ciphertext: 'ct', iv: 'iv', tag: 'tag' });
  decryptSecret.mockImplementation((envelope: { ciphertext: string }) =>
    envelope.ciphertext === 'ct'
      ? 'the-stored-webhook-secret'
      : JSON.stringify({ consumerKey: 'ck', consumerSecret: 'cs' }),
  );
  registerWebhooks.mockResolvedValue(reconciled());
});

describe('#262 re-registration — the claim comes before the platform call', () => {
  it('CLAIMS first, and a connection it cannot claim is never registered', async () => {
    claimConnectionWebhookRegistration.mockResolvedValue(null);

    const outcome = await reregisterConnectionWebhooks('store-1', 'conn-1', {
      countsAsAttempt: true,
    });

    expect(outcome).toBe('not_claimed');
    // The whole point of the lease. Two passes recreating one WooCommerce
    // connection's subscriptions leaves the loser's secret stored over the
    // winner's live ones, and every delivery 401s from then on.
    expect(registerWebhooks).not.toHaveBeenCalled();
    expect(completeConnectionWebhookRegistration).not.toHaveBeenCalled();
    expect(releaseConnectionWebhookRegistration).not.toHaveBeenCalled();
  });

  it('spends an attempt for the SWEEP and none for a merchant', async () => {
    await reregisterConnectionWebhooks('store-1', 'conn-1', { countsAsAttempt: true });
    expect(claimConnectionWebhookRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ countsAsAttempt: true }),
    );

    vi.clearAllMocks();
    claimConnectionWebhookRegistration.mockResolvedValue(connection(0));
    findConnection.mockResolvedValue(connection());
    registerWebhooks.mockResolvedValue(reconciled());
    completeConnectionWebhookRegistration.mockResolvedValue(true);
    findConnectionWebhookSecret.mockResolvedValue({ ciphertext: 'ct', iv: 'iv', tag: 'tag' });

    await reregisterConnectionWebhooks('store-1', 'conn-1', { countsAsAttempt: false });
    expect(claimConnectionWebhookRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ countsAsAttempt: false }),
    );
  });

  it('refuses a connection that cannot be registered at all, without claiming', async () => {
    findConnection.mockResolvedValue({ ...connection(), hasCredentials: false });

    const outcome = await reregisterConnectionWebhooks('store-1', 'conn-1', {
      countsAsAttempt: true,
    });

    expect(outcome).toBe('not_registerable');
    expect(claimConnectionWebhookRegistration).not.toHaveBeenCalled();
  });
});

describe('#262 re-registration — where the retry stops', () => {
  it('RESETS the budget when the attempt left nothing refused', async () => {
    const outcome = await reregisterConnectionWebhooks('store-1', 'conn-1', {
      countsAsAttempt: true,
    });

    expect(outcome).toBe('registered');
    expect(completeConnectionWebhookRegistration).toHaveBeenCalledWith('conn-1', expect.any(String));
    expect(releaseConnectionWebhookRegistration).not.toHaveBeenCalled();
  });

  it('schedules a RETRY for a refusal a later attempt could take', async () => {
    const now = new Date('2026-08-14T10:00:00Z');
    registerWebhooks.mockResolvedValue(
      reconciled([{ topic: 'product.updated', reason: 'rate_limited' }]),
    );

    const outcome = await reregisterConnectionWebhooks('store-1', 'conn-1', {
      countsAsAttempt: true,
      now,
    });

    expect(outcome).toBe('retry_scheduled');
    const release = releaseConnectionWebhookRegistration.mock.calls[0][0] as {
      deadLettered: boolean;
      nextAttemptAt: Date | null;
    };
    expect(release.deadLettered).toBe(false);
    expect(release.nextAttemptAt?.getTime()).toBeGreaterThan(now.getTime());
  });

  it('STOPS immediately on a refusal no retry can fix, with the budget untouched', async () => {
    // The scope-refusal rule. A credential that answered 403 answers 403 again,
    // so spending twelve attempts on it is noise AND it delays nothing but
    // itself — the merchant has to widen the grant either way, and the visible
    // `dead_letter` is what tells them to.
    registerWebhooks.mockResolvedValue(
      reconciled([{ topic: 'product.updated', reason: 'permission_denied' }]),
    );

    const outcome = await reregisterConnectionWebhooks('store-1', 'conn-1', {
      countsAsAttempt: true,
    });

    expect(outcome).toBe('dead_lettered');
    const release = releaseConnectionWebhookRegistration.mock.calls[0][0] as {
      deadLettered: boolean;
      nextAttemptAt: Date | null;
    };
    expect(release.deadLettered).toBe(true);
    // No next attempt is due, because there is no next attempt.
    expect(release.nextAttemptAt).toBeNull();
  });

  it('RETRIES a MIXED refusal — one topic the merchant must fix must not strand the rest', async () => {
    registerWebhooks.mockResolvedValue(
      reconciled([
        { topic: 'product.updated', reason: 'permission_denied' },
        { topic: 'order.created', reason: 'platform_error' },
      ]),
    );

    const outcome = await reregisterConnectionWebhooks('store-1', 'conn-1', {
      countsAsAttempt: true,
    });

    expect(outcome).toBe('retry_scheduled');
  });

  it('STOPS a retryable refusal once the budget is spent', async () => {
    claimConnectionWebhookRegistration.mockResolvedValue(connection(12));
    registerWebhooks.mockResolvedValue(
      reconciled([{ topic: 'product.updated', reason: 'platform_error' }]),
    );

    const outcome = await reregisterConnectionWebhooks('store-1', 'conn-1', {
      countsAsAttempt: true,
    });

    expect(outcome).toBe('dead_lettered');
  });

  it('treats an unreadable platform LIST by its own reason, not as retryable by default', async () => {
    registerWebhooks.mockResolvedValue({
      outcome: 'unknown',
      reason: 'permission_denied',
      failures: [{ topic: 'product.updated', reason: 'permission_denied' }],
    });

    expect(
      await reregisterConnectionWebhooks('store-1', 'conn-1', { countsAsAttempt: true }),
    ).toBe('dead_lettered');

    vi.clearAllMocks();
    findConnection.mockResolvedValue(connection());
    claimConnectionWebhookRegistration.mockResolvedValue(connection(1));
    releaseConnectionWebhookRegistration.mockResolvedValue(true);
    findConnectionWebhookSecret.mockResolvedValue({ ciphertext: 'ct', iv: 'iv', tag: 'tag' });
    registerWebhooks.mockResolvedValue({
      outcome: 'unknown',
      reason: 'platform_error',
      failures: [{ topic: 'product.updated', reason: 'platform_error' }],
    });

    expect(
      await reregisterConnectionWebhooks('store-1', 'conn-1', { countsAsAttempt: true }),
    ).toBe('retry_scheduled');
  });

  it('RELEASES the lease when the registration THREW rather than stranding the claim', async () => {
    // A throw writes no ids and no refusals, so the only trace is an empty
    // `webhook_ids`. What must not also happen is the claim outliving the pass:
    // the connection would be unreachable until the lease expired.
    registerWebhooks.mockRejectedValue(new Error('provider exploded'));

    const outcome = await reregisterConnectionWebhooks('store-1', 'conn-1', {
      countsAsAttempt: true,
    });

    expect(outcome).toBe('retry_scheduled');
    expect(releaseConnectionWebhookRegistration).toHaveBeenCalledTimes(1);
  });

  it('DEAD-LETTERS a repeatedly-THROWING registration having recorded NO refusal', async () => {
    // The premise the dashboard's `deriveWebhookDelivery` ordering rests on, and
    // it is the reason that ordering is not a preference: a throw is caught before
    // `recordConnectionWebhookRegistration` is reached, so it writes no ids AND no
    // per-topic rows. Once the budget drains, the connection is `dead_letter`
    // while `webhookFailures` is EMPTY — so a client keying its headline on the
    // refusal list renders a channel Mercaria has given up on as healthy.
    claimConnectionWebhookRegistration.mockResolvedValue(connection(12));
    registerWebhooks.mockRejectedValue(new Error('provider exploded'));

    const outcome = await reregisterConnectionWebhooks('store-1', 'conn-1', {
      countsAsAttempt: true,
    });

    expect(outcome).toBe('dead_lettered');
    expect(
      releaseConnectionWebhookRegistration.mock.calls[0][0],
    ).toEqual(expect.objectContaining({ deadLettered: true }));
    // The half that makes the state ambiguous to a client: nothing was recorded,
    // so there is no topic to name and no refusal row to key a headline on.
    expect(
      recordConnectionWebhookRegistration,
      'a thrown registration must write nothing at all',
    ).not.toHaveBeenCalled();
  });

  it('RELEASES the lease when the CREDENTIAL will not resolve', async () => {
    // The credential read is inside the lease on purpose: an envelope that will
    // not decrypt is a real failure the backoff and the budget must see, not an
    // exception that escapes past the release.
    decryptSecret.mockImplementation((envelope: { ciphertext: string }) => {
      if (envelope.ciphertext === 'ct') return 'the-stored-webhook-secret';
      throw new Error('cannot decrypt');
    });

    const outcome = await reregisterConnectionWebhooks('store-1', 'conn-1', {
      countsAsAttempt: true,
    });

    expect(outcome).toBe('retry_scheduled');
    expect(releaseConnectionWebhookRegistration).toHaveBeenCalledTimes(1);
    expect(registerWebhooks).not.toHaveBeenCalled();
  });
});

describe('#262 re-registration — the secret is REUSED, never rotated', () => {
  it('creates the recreated subscriptions with the secret already stored', async () => {
    // WooCommerce fixes a webhook's secret AT CREATION and never discloses it
    // again, and Mercaria holds no previous-secret grace for a connection. Minting
    // a fresh one here makes every delivery queued under the old one 401 until the
    // swap lands; recreating with the SAME secret leaves the stored envelope
    // verifying survivors and recreations alike.
    await reregisterConnectionWebhooks('store-1', 'conn-1', { countsAsAttempt: true });

    expect(registerWebhooks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ secret: 'the-stored-webhook-secret' }),
    );
  });

  it('MINTS one when there is no stored envelope — the state a thrown registration leaves', async () => {
    findConnectionWebhookSecret.mockResolvedValue(null);

    await reregisterConnectionWebhooks('store-1', 'conn-1', { countsAsAttempt: true });

    const params = registerWebhooks.mock.calls[0][1] as { secret: string };
    expect(params.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(params.secret).not.toBe('the-stored-webhook-secret');
  });
});

describe('#262 sweep — the LOOP is gated and nothing else', () => {
  it('reads NOTHING and calls no platform when the sweep is disabled', async () => {
    connectorsConfig.webhookReregistrationEnabled = false;

    await sweepConnectionWebhookRegistrations();

    expect(findConnectionsNeedingWebhookRegistration).not.toHaveBeenCalled();
    expect(claimConnectionWebhookRegistration).not.toHaveBeenCalled();
    expect(registerWebhooks).not.toHaveBeenCalled();
  });

  it('bounds the pass by the configured batch size', async () => {
    findConnectionsNeedingWebhookRegistration.mockResolvedValue([]);

    await sweepConnectionWebhookRegistrations();

    expect(findConnectionsNeedingWebhookRegistration).toHaveBeenCalledWith({ limit: 7 });
  });

  it('re-registers every candidate and survives one that throws', async () => {
    findConnectionsNeedingWebhookRegistration.mockResolvedValue([
      { id: 'conn-1', storeId: 'store-1' },
      { id: 'conn-2', storeId: 'store-2' },
      { id: 'conn-3', storeId: 'store-3' },
    ]);
    findConnection.mockImplementation(async (_storeId: string, connectionId: string) => {
      if (connectionId === 'conn-2') {
        throw new Error('unreachable row');
      }
      return { ...connection(), id: connectionId };
    });

    await sweepConnectionWebhookRegistrations();

    // One unreachable shop must not stop every other merchant's channel
    // recovering — the `reconcileAllConnections` posture.
    expect(registerWebhooks).toHaveBeenCalledTimes(2);
  });
});

describe('#262 — the merchant entry point validates, then enqueues', () => {
  it('ENQUEUES rather than registering inside the request', async () => {
    await requestWebhookReregistration('store-1', 'conn-1');

    expect(enqueueConnectionWebhookReregister).toHaveBeenCalledWith({
      storeId: 'store-1',
      connectionId: 'conn-1',
    });
    expect(registerWebhooks).not.toHaveBeenCalled();
    expect(claimConnectionWebhookRegistration).not.toHaveBeenCalled();
  });

  it('404s a connection that is not this store’s, and enqueues nothing', async () => {
    findConnection.mockResolvedValue(null);

    await expect(requestWebhookReregistration('store-1', 'conn-1')).rejects.toThrow(
      /not found/i,
    );
    expect(enqueueConnectionWebhookReregister).not.toHaveBeenCalled();
  });

  it('refuses a disconnected, push-in or credential-less channel synchronously', async () => {
    for (const patch of [
      { status: 'disconnected' as const },
      { mode: 'push_in' as const },
      { hasCredentials: false },
      { shopDomain: null },
    ]) {
      vi.clearAllMocks();
      findConnection.mockResolvedValue({ ...connection(), ...patch });
      await expect(requestWebhookReregistration('store-1', 'conn-1')).rejects.toThrow();
      expect(enqueueConnectionWebhookReregister).not.toHaveBeenCalled();
    }
  });
});
