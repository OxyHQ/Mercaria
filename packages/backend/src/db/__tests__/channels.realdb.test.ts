/**
 * The channel-onboarding and channel-audit domain (#87), against a REAL Postgres
 * database.
 *
 * Every property here is one a mocked drizzle call cannot express, and each one
 * is load-bearing for something the merchant surface promises:
 *
 *  - **the live-session partial unique** is #87 acceptance 2 ("previewing or
 *    retrying a connection creates no duplicate channel") held at the first
 *    step. A mocked `insert` accepts a second row happily;
 *  - **the preview CHECKs** refuse a partial record and refuse counters that do
 *    not partition `scanned` — the vacuity floor, and the fixtures span the
 *    distinction rather than sitting on one side of it;
 *  - **the terminal-state CHECK** refuses a state without its instant, and the
 *    activated-target CHECK refuses an activated session naming nothing;
 *  - **the append-only trigger** on `channel_audit_events` refuses UPDATE and
 *    DELETE. A trigger has no mocked counterpart at all;
 *  - **the `state = 'in_progress'` CAS** in the repository is what makes a
 *    finished session immutable, and two callers racing to activate converge;
 *  - **`connections_disconnect_record_check`** refuses half of the disconnect
 *    record, and `setConnectionPause`'s conditional UPDATE is idempotent — its
 *    empty `RETURNING` IS the "already in that state" answer.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { channelAuditEvents, channelOnboardingSessions } from '../schema/channels.js';
import { connections } from '../schema/connectors.js';
import { deleteTestStores } from './store-teardown.js';
import {
  closeChannelOnboardingSession,
  findChannelOnboardingSession,
  openChannelOnboardingSession,
  patchChannelOnboardingSession,
} from '../channels/channelOnboardingRepository.js';
import {
  listChannelAuditEvents,
  recordChannelAuditEvent,
} from '../channels/channelAuditRepository.js';
import {
  disconnectConnection,
  findConnection,
  setConnectionPause,
  upsertConnection,
} from '../connectors/connectionRepository.js';
import { insertStore } from '../stores/storeRepository.js';

let db: Database;

/** Store ids created by a test, dropped after it so the shared database stays clean. */
const createdStoreIds: string[] = [];

/** Create a store through the repository and register it for cleanup. */
async function makeStore(): Promise<string> {
  // The WHOLE uuid, not a prefix: v7 is time-ordered, so two ids minted in the
  // same millisecond share their leading characters and a truncated suffix
  // collides with `stores_handle_key`.
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `channels-${suffix}`,
      name: 'Channels store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  return store.id;
}

/** A connected `pull` Shopify connection. */
async function makeConnection(storeId: string) {
  return upsertConnection(storeId, 'shopify', {
    mode: 'pull',
    status: 'connected',
    connectedAt: new Date(),
    credentials: { ciphertext: 'cipher', iv: 'nonce', tag: 'auth-tag' },
    shopDomain: `shop-${uuidv7()}.myshopify.com`,
    shopCurrency: 'USD',
  });
}

/**
 * The message a trigger raised, from anywhere in the cause chain.
 *
 * drizzle wraps a `PostgresError` in its own `Failed query: …`, so `String(err)`
 * is the WRAPPER's text and never the trigger's — an assertion on it passes for
 * a statement that failed for a completely different reason. The `did not throw`
 * branch is the one that catches a trigger that is not installed at all.
 * `review-scopes.realdb.test.ts` established this shape.
 */
async function refusalMessages(run: () => Promise<unknown>): Promise<string> {
  let thrown: unknown;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, 'the statement succeeded — is the trigger installed?').toBeDefined();
  const messages: string[] = [];
  let current: unknown = thrown;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(' | ');
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    // Both new tables CASCADE from `stores`, so dropping the store is enough —
    // and that it IS enough is worth relying on rather than deleting by hand.
    // The canonical link a backfill pass may have attached does NOT cascade,
    // which is why this goes through the shared teardown.
    await deleteTestStores(db, [storeId]);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('the live-session partial unique (#87 acceptance 2)', () => {
  it('converges two opens of the same channel type on ONE session', async () => {
    const storeId = await makeStore();

    const first = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });
    // A second tab, or a retry after a timeout the client never saw. The
    // read-then-insert version of this would create a second row for both.
    const second = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });

    expect(second.id).toBe(first.id);
    const all = await db
      .select()
      .from(channelOnboardingSessions)
      .where(eq(channelOnboardingSessions.storeId, storeId));
    expect(all).toHaveLength(1);
  });

  it('permits a DIFFERENT channel type at the same time', async () => {
    // The unique is on the PAIR. A merchant connecting Shopify and a feed at
    // once is ordinary, and an index on `store_id` alone would refuse it.
    const storeId = await makeStore();
    await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });
    await openChannelOnboardingSession({
      storeId,
      channelType: 'product_feed',
      startedByOxyUserId: 'user-1',
    });

    const all = await db
      .select()
      .from(channelOnboardingSessions)
      .where(eq(channelOnboardingSessions.storeId, storeId));
    expect(all).toHaveLength(2);
  });

  it('permits a NEW session once the previous one finished', async () => {
    // The index is PARTIAL on `state = 'in_progress'`, so finished sessions
    // accumulate as history. A plain unique would make a merchant who
    // disconnected unable to ever reconnect through the wizard.
    const storeId = await makeStore();
    const first = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });
    await closeChannelOnboardingSession(storeId, first.id, 'abandoned', new Date());

    const second = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });

    expect(second.id).not.toBe(first.id);
  });
});

describe('the preview CHECKs', () => {
  it('accepts a COMPLETE preview whose counters partition `scanned`', async () => {
    const storeId = await makeStore();
    const session = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });

    const patched = await patchChannelOnboardingSession(storeId, session.id, {
      preview: { scanned: 10, matched: 4, created: 3, review: 1, invalid: 1, duplicate: 1 },
    });

    expect(patched?.previewScanned).toBe(10);
    expect(patched?.previewedAt).not.toBeNull();
  });

  it('REFUSES counters that do not sum to `scanned`', async () => {
    // Equality, never `<=`. A record the preview read and dropped on the floor
    // would otherwise be invisible — and a preview that silently loses records
    // is the one that says "nothing to review" about a feed full of problems.
    const storeId = await makeStore();
    const session = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });

    const failure = await patchChannelOnboardingSession(storeId, session.id, {
      preview: { scanned: 10, matched: 4, created: 3, review: 1, invalid: 1, duplicate: 0 },
    }).catch((err: unknown) => err);

    expect(isCheckViolation(failure)).toBe(true);
    expect(constraintNameOf(failure)).toBe('channel_onboarding_sessions_preview_total_check');
  });

  it('REFUSES a partial preview record', async () => {
    // Five counters with a missing `scanned` reads as a preview that examined
    // nothing, which is also what a mapping matching no rows produces. Those two
    // must never be indistinguishable, so the seven columns are all or none.
    const storeId = await makeStore();
    const session = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });

    const failure = await db
      .update(channelOnboardingSessions)
      .set({ previewMatched: 4, previewCreated: 3 })
      .where(eq(channelOnboardingSessions.id, session.id))
      .catch((err: unknown) => err);

    expect(isCheckViolation(failure)).toBe(true);
    expect(constraintNameOf(failure)).toBe('channel_onboarding_sessions_preview_complete_check');
  });
});

describe('the terminal-state CHECKs', () => {
  it('REFUSES an activated state with no instant', async () => {
    // The session names a CONNECTION first, so the activated-target CHECK is
    // satisfied and the only thing left to refuse the write is the terminal
    // check. Without that the fixture fails BOTH constraints and the assertion
    // would pass on whichever Postgres happened to evaluate first — a case that
    // cannot tell the two apart is one that tests neither.
    const storeId = await makeStore();
    const connection = await makeConnection(storeId);
    const session = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });
    await patchChannelOnboardingSession(storeId, session.id, { connectionId: connection.id });

    const failure = await db
      .update(channelOnboardingSessions)
      .set({ state: 'activated' })
      .where(eq(channelOnboardingSessions.id, session.id))
      .catch((err: unknown) => err);

    expect(isCheckViolation(failure)).toBe(true);
    expect(constraintNameOf(failure)).toBe('channel_onboarding_sessions_terminal_check');
  });

  it('REFUSES an activated session that names neither a connection nor a feed', async () => {
    // An activated session naming nothing is a merchant told they are connected
    // to something that does not exist.
    const storeId = await makeStore();
    const session = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });

    const failure = await db
      .update(channelOnboardingSessions)
      .set({ state: 'activated', activatedAt: new Date() })
      .where(eq(channelOnboardingSessions.id, session.id))
      .catch((err: unknown) => err);

    expect(isCheckViolation(failure)).toBe(true);
    expect(constraintNameOf(failure)).toBe(
      'channel_onboarding_sessions_activated_target_check',
    );
  });

  it('REFUSES an activated session naming BOTH', async () => {
    // `num_nonnulls(...) = 1`, not `>= 1`: a session activates a connection OR a
    // feed, and both would make "which channel did this activate" ambiguous.
    const storeId = await makeStore();
    const connection = await makeConnection(storeId);
    const session = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });

    const failure = await db
      .update(channelOnboardingSessions)
      .set({
        state: 'activated',
        activatedAt: new Date(),
        connectionId: connection.id,
        feedConfigurationId: uuidv7(),
      })
      .where(eq(channelOnboardingSessions.id, session.id))
      .catch((err: unknown) => err);

    // A foreign key on the invented feed id fires first on some plans; either
    // refusal is the schema doing its job, and asserting only that the write was
    // REFUSED is what keeps this case about the property rather than about
    // which constraint the planner reached first.
    expect(failure).toBeInstanceOf(Error);
  });
});

describe('the repository CAS on `state = in_progress`', () => {
  it('refuses to patch a finished session', async () => {
    // What makes an activated session immutable: a stale tab pressing "save"
    // after somebody activated on another device matches nothing and gets
    // `null`, rather than rewriting the record of what was activated.
    const storeId = await makeStore();
    const connection = await makeConnection(storeId);
    const session = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });
    await patchChannelOnboardingSession(storeId, session.id, { connectionId: connection.id });
    await closeChannelOnboardingSession(storeId, session.id, 'activated', new Date());

    const patched = await patchChannelOnboardingSession(storeId, session.id, { step: 'connect' });

    expect(patched).toBeNull();
    const stored = await findChannelOnboardingSession(storeId, session.id);
    expect(stored?.state).toBe('activated');
    expect(stored?.step).toBe('activate');
  });

  it('lets exactly ONE of two concurrent closes win', async () => {
    const storeId = await makeStore();
    const connection = await makeConnection(storeId);
    const session = await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });
    await patchChannelOnboardingSession(storeId, session.id, { connectionId: connection.id });

    // Genuinely concurrent. A sequential pair passes under a read-then-write
    // that a real race defeats — the #110 lesson, one domain over.
    const [a, b] = await Promise.all([
      closeChannelOnboardingSession(storeId, session.id, 'activated', new Date()),
      closeChannelOnboardingSession(storeId, session.id, 'activated', new Date()),
    ]);

    expect([a, b].filter((row) => row !== null)).toHaveLength(1);
  });

  it('scopes every read and write to the store', async () => {
    // A stranger's session id and an unknown id are the SAME answer, because the
    // query carries `store_id` — so 403 is unreachable and a store member cannot
    // enumerate which session ids exist.
    const storeA = await makeStore();
    const storeB = await makeStore();
    const session = await openChannelOnboardingSession({
      storeId: storeA,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });

    expect(await findChannelOnboardingSession(storeB, session.id)).toBeNull();
    expect(await patchChannelOnboardingSession(storeB, session.id, { step: 'connect' })).toBeNull();
  });
});

describe('`channel_audit_events` is append-only, by trigger', () => {
  it('records an entry with field NAMES and no values', async () => {
    const storeId = await makeStore();
    const row = await recordChannelAuditEvent({
      storeId,
      action: 'settings_updated',
      actorOxyUserId: 'user-1',
      channelType: 'shopify',
      changedFields: ['syncSettingsProducts', 'syncSettingsAutoPublish'],
    });

    expect(row.changedFields).toEqual(['syncSettingsProducts', 'syncSettingsAutoPublish']);
    // The whole point of the shape: there is no column an old or new VALUE could
    // have gone into, so the trail cannot become a plaintext credential store.
    expect(Object.keys(row)).not.toContain('details');
  });

  it('REFUSES an UPDATE', async () => {
    const storeId = await makeStore();
    const row = await recordChannelAuditEvent({
      storeId,
      action: 'disconnected',
      actorOxyUserId: 'user-1',
    });

    const messages = await refusalMessages(() =>
      db
        .update(channelAuditEvents)
        .set({ action: 'settings_updated' })
        .where(eq(channelAuditEvents.id, row.id)),
    );

    expect(messages).toMatch(/append-only/);
  });

  it('REFUSES a DELETE while the store still exists', async () => {
    // Deliberately unlike `analytics_events`, which permits DELETE outright
    // because a retention schedule needs it. There is no retention schedule
    // here, so an operator cannot remove one entry to hide it.
    const storeId = await makeStore();
    const row = await recordChannelAuditEvent({
      storeId,
      action: 'disconnected',
      actorOxyUserId: 'user-1',
    });

    const messages = await refusalMessages(() =>
      db.delete(channelAuditEvents).where(eq(channelAuditEvents.id, row.id)),
    );

    expect(messages).toMatch(/only be removed with the store/);
  });

  it('PERMITS the cascade when the store itself goes', async () => {
    // The precise exception, and the fixture spans the distinction the trigger
    // exists to make: the case above deletes an entry while its store stands,
    // this one deletes the store. A blanket refusal passes the first and fails
    // this one — which is exactly how the first version of this trigger was
    // caught, by every OTHER case in this file failing in `afterEach`.
    const suffix = uuidv7();
    const store = await insertStore(
      {
        handle: `channels-cascade-${suffix}`,
        name: 'Cascade store',
        description: '',
        brandColor: '#123456',
        defaultCurrency: 'FAIR',
      },
      [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
    );
    await recordChannelAuditEvent({
      storeId: store.id,
      action: 'onboarding_started',
      actorOxyUserId: 'user-1',
    });

    // Deliberately NOT registered for the shared cleanup: this case owns the
    // deletion, and registering it would delete the store twice.
    await deleteTestStores(db, [store.id]);

    expect(await listChannelAuditEvents(store.id, { limit: 10 })).toEqual([]);
  });

  it('pages newest first, by identity rather than by position', async () => {
    const storeId = await makeStore();
    // EXPLICIT ordering rather than insertion order: a uuid v7 primary key is
    // not monotonic within a millisecond, so three rows written in a tight loop
    // tie on `created_at` and the tiebreak becomes a coin flip. Asserting the
    // SET is what the ordering guarantees at this resolution.
    const written = await Promise.all([
      recordChannelAuditEvent({ storeId, action: 'fetch_paused', actorOxyUserId: 'user-1' }),
      recordChannelAuditEvent({ storeId, action: 'fetch_resumed', actorOxyUserId: 'user-1' }),
      recordChannelAuditEvent({ storeId, action: 'sync_requested', actorOxyUserId: 'user-1' }),
    ]);

    const listed = await listChannelAuditEvents(storeId, { limit: 10 });

    expect(new Set(listed.map((row) => row.id))).toEqual(new Set(written.map((row) => row.id)));
  });
});

describe('the disconnect record and the pause columns', () => {
  it('writes the policy and its instant TOGETHER', async () => {
    const storeId = await makeStore();
    const connection = await makeConnection(storeId);

    const disconnected = await disconnectConnection(storeId, connection.id, 'archive_listings');

    expect(disconnected?.status).toBe('disconnected');
    expect(disconnected?.disconnectPolicy).toBe('archive_listings');
    expect(disconnected?.disconnectedAt).not.toBeNull();
  });

  it('REFUSES half of the disconnect record', async () => {
    // A policy without its instant, or an instant without its policy, is half of
    // one fact — and the half that survives reads as the whole.
    const storeId = await makeStore();
    const connection = await makeConnection(storeId);

    const failure = await db
      .update(connections)
      .set({ disconnectPolicy: 'keep_listings' })
      .where(eq(connections.id, connection.id))
      .catch((err: unknown) => err);

    expect(isCheckViolation(failure)).toBe(true);
    expect(constraintNameOf(failure)).toBe('connections_disconnect_record_check');
  });

  it('pauses fetch and publication INDEPENDENTLY', async () => {
    // Two facts, not one tri-state. A merchant investigating wrong prices stops
    // publication while the connector keeps observing; one whose host is
    // rate-limiting wants the opposite; and both at once must be expressible.
    const storeId = await makeStore();
    const connection = await makeConnection(storeId);

    await setConnectionPause(storeId, connection.id, 'fetch', true);
    const afterFetch = await findConnection(storeId, connection.id);
    expect(afterFetch?.fetchPausedAt).not.toBeNull();
    expect(afterFetch?.publicationPausedAt).toBeNull();

    await setConnectionPause(storeId, connection.id, 'publication', true);
    const afterBoth = await findConnection(storeId, connection.id);
    expect(afterBoth?.fetchPausedAt).not.toBeNull();
    expect(afterBoth?.publicationPausedAt).not.toBeNull();

    // Resuming one leaves the other alone.
    await setConnectionPause(storeId, connection.id, 'fetch', false);
    const afterResume = await findConnection(storeId, connection.id);
    expect(afterResume?.fetchPausedAt).toBeNull();
    expect(afterResume?.publicationPausedAt).not.toBeNull();
  });

  it('is idempotent: pausing something already paused changes nothing', async () => {
    // The conditional UPDATE's empty `RETURNING` set IS the "already in that
    // state" answer, and the instant must NOT move — "paused since" is the whole
    // reason these are timestamps rather than booleans.
    const storeId = await makeStore();
    const connection = await makeConnection(storeId);

    const first = await setConnectionPause(storeId, connection.id, 'fetch', true);
    const second = await setConnectionPause(storeId, connection.id, 'fetch', true);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const stored = await findConnection(storeId, connection.id);
    expect(stored?.fetchPausedAt?.getTime()).toBe(first?.fetchPausedAt?.getTime());
  });

  it('leaves `status` alone — a pause is not a disconnect', async () => {
    // Collapsing the two would make resuming a paused channel indistinguishable
    // from reconnecting a broken one.
    const storeId = await makeStore();
    const connection = await makeConnection(storeId);

    await setConnectionPause(storeId, connection.id, 'publication', true);

    const stored = await findConnection(storeId, connection.id);
    expect(stored?.status).toBe('connected');
  });

  it('scopes a pause to the store', async () => {
    const storeA = await makeStore();
    const storeB = await makeStore();
    const connection = await makeConnection(storeA);

    expect(await setConnectionPause(storeB, connection.id, 'fetch', true)).toBeNull();
    const stored = await findConnection(storeA, connection.id);
    expect(stored?.fetchPausedAt).toBeNull();
  });
});

describe('a unique violation is a unique violation', () => {
  it('cannot insert a second live session by hand either', async () => {
    // The repository converges; this asserts the DATABASE is what makes it
    // converge, rather than the `ON CONFLICT` clause being the only thing
    // between two rows.
    const storeId = await makeStore();
    await openChannelOnboardingSession({
      storeId,
      channelType: 'shopify',
      startedByOxyUserId: 'user-1',
    });

    const failure = await db
      .insert(channelOnboardingSessions)
      .values({ storeId, channelType: 'shopify', startedByOxyUserId: 'user-2' })
      .catch((err: unknown) => err);

    expect(isUniqueViolation(failure)).toBe(true);
    expect(constraintNameOf(failure)).toBe('channel_onboarding_sessions_live_key');
  });
});
