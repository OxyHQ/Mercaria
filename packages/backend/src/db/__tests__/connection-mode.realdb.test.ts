/**
 * A CONNECT MAY NOT REWRITE A CONNECTION'S MODE (#302).
 *
 * `connections` is `UNIQUE(store_id, provider)`, so one store holds at most one
 * connection per platform and a "second connection" in the other mode is a mode
 * change on the existing row. `upsertConnection` used to put `mode` in the
 * `onConflictDoUpdate` `set` like every other column, so an OAuth pull connect
 * silently rewrote a merchant's `push_in` row — the id does not move, every
 * `listings.source_connection_id` still resolves, and the only symptom is that
 * the WordPress plugin's next push 400s on `requirePushInConnection`, with no
 * run recorded and nothing on the channel screen saying a mode was rewritten.
 *
 * ## Why this cannot be a mocked test
 *
 * The fix is a CONDITIONAL WRITE — `ON CONFLICT … DO UPDATE … WHERE
 * connections.mode = $1` — whose refusal IS its empty `RETURNING` set. A mocked
 * `insert` accepts any statement and has no `onConflictDoUpdate` semantics at
 * all, so it would report the same green for the conditional write and for the
 * unconditional one this replaces.
 *
 * ## Why a `Promise.all` race here would be VACUOUS
 *
 * postgres.js pipelines, and two transactions handed to `Promise.all` can each
 * finish before the loop returns to the other — the intuitive race passes
 * against the broken code. So the contention is FORCED: one transaction inserts
 * the `push_in` row and does not commit, the contender's upsert is fired without
 * being awaited, and a THIRD connection polls `pg_blocking_pids` until it reports
 * the holder. That poll THROWS if the block never appears, because a race test
 * that goes green without having raced is worse than none.
 *
 * The pre-reads in the three connect services are NOT what this measures. All
 * three read outside any transaction, so two concurrent connects both see "no
 * row" — which is exactly the case below, and exactly why the rule had to move
 * into the write.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { connections } from '../schema/connectors.js';
import { upsertConnection } from '../connectors/connectionRepository.js';
import { insertStore } from '../stores/storeRepository.js';
import { deleteTestStores } from './store-teardown.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { connectPushIn } from '../../services/channel-ingest.service.js';

let db: Database;

/** Store ids created by a test, dropped after it so the shared database stays clean. */
const createdStoreIds: string[] = [];

/** The one sentence all four refusal sites raise. */
const MODE_CONFLICT = 'A connection already exists for this provider in a different mode';

/** Create a store through the repository and register it for cleanup. */
async function makeStore(): Promise<string> {
  // The WHOLE uuid, not a prefix: v7 is time-ordered, so two ids minted in the
  // same millisecond share their leading characters and a truncated suffix
  // collides with `stores_handle_key`.
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `conn-mode-${suffix}`,
      name: 'Connection mode store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  return store.id;
}

/** The stored row, straight from the table — no repository projection in between. */
async function readRow(storeId: string) {
  const [row] = await db
    .select({ id: connections.id, mode: connections.mode, updatedAt: connections.updatedAt })
    .from(connections)
    .where(eq(connections.storeId, storeId))
    .limit(1);
  return row;
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    await deleteTestStores(db, [storeId]);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('upsertConnection refuses a mode change', () => {
  it('refuses a pull connect over a push_in connection and writes NOTHING', async () => {
    const storeId = await makeStore();
    const pushIn = await connectPushIn(storeId, 'shopify', { shopDomain: 'plugin.example.test' });
    expect(pushIn.mode).toBe('push_in');
    const before = await readRow(storeId);

    // Exactly what `connectAndVerify` hands the repository after a Shopify OAuth
    // exchange. Before #302 this returned a row whose `mode` was now `pull`.
    const refusal = await upsertConnection(storeId, 'shopify', {
      mode: 'pull',
      status: 'connected',
      credentials: { ciphertext: 'c', iv: 'i', tag: 't' },
      shopDomain: 'shop.myshopify.com',
      shopCurrency: 'USD',
      scopes: ['read_products'],
      connectedAt: new Date(),
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(refusal, 'the pull connect was accepted').not.toBeNull();
    expect(isMercariaError(refusal) && refusal.code).toBe('CONFLICT');
    expect(isMercariaError(refusal) && refusal.message).toBe(MODE_CONFLICT);

    // Not merely "the mode is still push_in": the `DO UPDATE … WHERE` must not
    // have run at all, so the credentials, the domain and `updated_at` are
    // untouched too. A version that refused AFTER writing would pass a mode-only
    // assertion and would still have replaced the plugin's stored facts.
    const after = await readRow(storeId);
    expect(after.id).toBe(before.id);
    expect(after.mode).toBe('push_in');
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    const [stored] = await db
      .select({ domain: connections.shopDomain, cipher: connections.credentialsCiphertext })
      .from(connections)
      .where(eq(connections.id, before.id));
    expect(stored.domain).toBe('plugin.example.test');
    expect(stored.cipher).toBeNull();
  });

  it('refuses a push_in connect over a pull connection — the rule is symmetric', async () => {
    const storeId = await makeStore();
    const pull = await upsertConnection(storeId, 'woocommerce', {
      mode: 'pull',
      status: 'connected',
      connectedAt: new Date(),
      shopDomain: 'https://shop.example.test',
    });

    // The WRITE first, so this case measures the same mechanism as the one above
    // rather than `connectPushIn`'s pre-read — which would leave it green against
    // an `upsertConnection` that had lost its conditional write entirely.
    await expect(
      upsertConnection(storeId, 'woocommerce', {
        mode: 'push_in',
        status: 'connected',
        connectedAt: new Date(),
        shopDomain: 'plugin.example.test',
      }),
    ).rejects.toThrow(MODE_CONFLICT);

    // And the plugin's own entry point still answers the merchant the same way.
    await expect(connectPushIn(storeId, 'woocommerce', {})).rejects.toThrow(MODE_CONFLICT);
    expect((await readRow(storeId)).mode).toBe('pull');
    expect((await readRow(storeId)).id).toBe(pull.id);
  });

  it('still reconnects in the SAME mode — the positive control', async () => {
    // Without this the two cases above are equally satisfied by a `setWhere` that
    // refuses everything, which would break every reconnect in the product.
    const storeId = await makeStore();
    const first = await upsertConnection(storeId, 'shopify', {
      mode: 'pull',
      status: 'connected',
      connectedAt: new Date(),
      shopDomain: 'first.myshopify.com',
      shopCurrency: 'USD',
      scopes: ['read_products'],
    });

    const second = await upsertConnection(storeId, 'shopify', {
      mode: 'pull',
      status: 'connected',
      connectedAt: new Date(),
      credentials: { ciphertext: 'c2', iv: 'i2', tag: 't2' },
      shopDomain: 'second.myshopify.com',
      shopCurrency: 'EUR',
      scopes: ['read_products', 'write_products'],
    });

    expect(second.id).toBe(first.id);
    expect(second.mode).toBe('pull');
    expect(second.shopDomain).toBe('second.myshopify.com');
    expect(second.hasCredentials).toBe(true);
  });

  it('refuses the SECOND of two concurrent connects that both saw no row', async () => {
    const storeId = await makeStore();

    /** Resolves once the holder's uncommitted `push_in` insert is in place. */
    let signalHeld: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    /** Resolved by the test to let the holder commit. */
    let signalRelease: () => void;
    const release = new Promise<void>((resolve) => {
      signalRelease = resolve;
    });

    let holderPid = -1;
    const holder = db.transaction(async (tx) => {
      const [pid] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      holderPid = Number(pid.pid);
      // The plugin's connect, committed only after the contender is provably
      // queued behind it. A committed row would let the contender's ON CONFLICT
      // resolve immediately, which is the sequential case the pre-reads already
      // covered.
      await tx.insert(connections).values({
        storeId,
        provider: 'shopify',
        mode: 'push_in',
        status: 'connected',
        connectedAt: new Date(),
        shopDomain: 'plugin.example.test',
      });
      signalHeld();
      await release;
    });

    await held;

    let contenderPid = -1;
    const contender = db.transaction(async (tx) => {
      const [pid] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      contenderPid = Number(pid.pid);
      // The OAuth connect. Its own service-level pre-read would have seen no row
      // (the holder has not committed), which is precisely the hole a guard
      // cannot close.
      return upsertConnection(
        storeId,
        'shopify',
        {
          mode: 'pull',
          status: 'connected',
          connectedAt: new Date(),
          shopDomain: 'shop.myshopify.com',
          shopCurrency: 'USD',
        },
        tx,
      );
    });
    // A STRING discriminant, not `ok: true | false`: this package compiles with
    // `strict: false`, so TypeScript does not narrow a union on the truthiness of
    // a boolean-literal member and the `err` read below would not typecheck.
    const contenderSettled = contender.then(
      (row) => ({ outcome: 'wrote' as const, row }),
      (err: unknown) => ({ outcome: 'refused' as const, err }),
    );

    // THE PROOF, from a third backend: the contender is actually queued behind
    // the holder. Without it, a contender that finished before the holder even
    // started would produce the same green.
    const deadline = Date.now() + 15_000;
    let blocked = false;
    while (Date.now() < deadline) {
      if (contenderPid > 0) {
        const [row] = await db.execute<{ blockers: number[] }>(
          sql`select pg_blocking_pids(${contenderPid}) as blockers`,
        );
        const blockers = (row?.blockers ?? []).map(Number);
        if (blockers.includes(holderPid)) {
          blocked = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!blocked) {
      signalRelease();
      await holder.catch(() => undefined);
      await contenderSettled;
      throw new Error(
        `The contender never blocked on the holder (holder pid ${holderPid}, contender pid ` +
          `${contenderPid}). Nothing raced, so this case measured nothing.`,
      );
    }

    signalRelease();
    await holder;
    const outcome = await contenderSettled;

    expect(outcome.outcome, 'the losing connect wrote a row instead of being refused').toBe(
      'refused',
    );
    if (outcome.outcome === 'refused') {
      expect(isMercariaError(outcome.err) && outcome.err.message).toBe(MODE_CONFLICT);
    }
    expect((await readRow(storeId)).mode).toBe('push_in');
  }, 60_000);
});
