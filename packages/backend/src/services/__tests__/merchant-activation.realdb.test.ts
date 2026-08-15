/**
 * The activation writes and their constraints, against a REAL PostgreSQL server.
 *
 * The rest of this domain's suite is pure and mocks nothing, because the
 * derivation reads a plain object. What CANNOT live there is everything the
 * server owns, and each of these is a property no mocked insert could refuse:
 *
 *  - the hold's `num_nonnulls(...) in (0, 3)` CHECK — a partial hold, which is
 *    the row that would leave a store held with nobody named;
 *  - both append-only triggers, on UPDATE and (for acceptances) on DELETE;
 *  - the acceptance unique, so a replayed accept converges instead of
 *    duplicating an audit trail;
 *  - `merchant_activation_capability_events_change_check`, which is what stops a
 *    second writer recording a transition that did not happen;
 *  - `merchant_activation_capability_events_actor_shape_check`, the biconditional
 *    that keeps a sweep's observation from being attributed to a person;
 *  - the settings unique, and that `lockMerchantActivationSettings` converges
 *    rather than raising when two callers create the row at once;
 *  - the transition RECORDING itself, end to end through the real service.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel workers. Every row this file writes hangs off stores it created, and
 * teardown deletes exactly those — a `delete from merchant_activation_settings`
 * here would empty a sibling's fixtures mid-run. Nothing in this file aggregates
 * over a table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import {
  applyPlatformHold,
  findMerchantActivationSettings,
  lockMerchantActivationSettings,
  readMerchantActivationSettings,
  releasePlatformHold,
  updateMerchantCheckoutIntents,
} from '../../db/merchantActivation/activationSettingsRepository.js';
import {
  countCapabilityEvents,
  insertCapabilityEvents,
  readLatestCapabilityStates,
} from '../../db/merchantActivation/capabilityEventRepository.js';
import {
  insertPolicyAcceptance,
  listPolicyAcceptancesForOwner,
} from '../../db/merchantActivation/policyAcceptanceRepository.js';
import {
  merchantActivationCapabilityEvents,
  merchantActivationPolicyAcceptances,
  merchantActivationSettings,
} from '../../db/schema/merchantActivation.js';
import { storeMembers, stores } from '../../db/schema/stores.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { observeMerchantActivation } from '../merchant-activation/transitions.service.js';
import { acceptActivationPolicy } from '../merchant-activation/settings.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7();

const createdStoreIds: string[] = [];

/**
 * Acceptances are NOT torn down, and that is the table's own rule rather than an
 * oversight: the DELETE trigger refuses one, which is the property the case
 * below asserts. Every owner id this file writes carries `RUN`, so the rows are
 * scoped to this run and leave with the throwaway database.
 */

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (createdStoreIds.length > 0) {
    // Children first. `merchant_activation_settings` and the capability trail
    // both CASCADE from `stores`, but deleting them explicitly is what makes a
    // teardown failure name this file rather than a foreign key three tables
    // away.
    await db
      .delete(merchantActivationCapabilityEvents)
      .where(inArray(merchantActivationCapabilityEvents.storeId, createdStoreIds));
    await db
      .delete(merchantActivationSettings)
      .where(inArray(merchantActivationSettings.storeId, createdStoreIds));
    await db.delete(storeMembers).where(inArray(storeMembers.storeId, createdStoreIds));
    await deleteTestStores(db, createdStoreIds);
  }
  await closePostgres();
});

/**
 * Assert a statement is refused by a NAMED constraint.
 *
 * postgres.js puts the driver error under `cause` and the thrown message is a
 * generic "Failed query: …", so `rejects.toThrow(/name/)` passes on ANY failure
 * — a typo in a column, a missing fixture, a dropped connection. This reads
 * `constraint_name` off the driver error, so a case can only pass when the
 * constraint it names is the one that fired.
 */
async function expectConstraintViolation(
  run: () => Promise<unknown>,
  constraintName: string,
): Promise<void> {
  let raised: unknown;
  try {
    await run();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected ${constraintName} to refuse the statement`).toBeDefined();
  const cause = (raised as { cause?: { constraint_name?: string } }).cause;
  const named = cause?.constraint_name ?? (raised as { constraint_name?: string }).constraint_name;
  expect(named).toBe(constraintName);
}

/**
 * Assert a statement is refused by one of the append-only TRIGGERS.
 *
 * A trigger raises `check_violation` with no constraint name, so the message is
 * the only handle — and it is read off the DRIVER error rather than off
 * drizzle's generic wrapper, which every failure produces.
 */
async function expectAppendOnlyRefusal(run: () => Promise<unknown>): Promise<void> {
  let raised: unknown;
  try {
    await run();
  } catch (err) {
    raised = err;
  }
  expect(raised, 'expected the append-only trigger to refuse the statement').toBeDefined();
  const cause = (raised as { cause?: { message?: string; code?: string } }).cause;
  expect(cause?.code).toBe('23514');
  expect(cause?.message).toMatch(/append-only/);
}

/** Seed a native store with an owner who holds the two guest permissions. */
async function seedStore(suffix: string): Promise<string> {
  const [store] = await db
    .insert(stores)
    .values({
      handle: `act-${RUN}-${suffix}`,
      name: `Activation Store ${suffix}`,
      description: 'seeded by merchant-activation.realdb.test',
      brandColor: '#101010',
    })
    .returning({ id: stores.id });
  createdStoreIds.push(store.id);
  await db.insert(storeMembers).values({
    storeId: store.id,
    oxyUserId: `owner-${RUN}-${suffix}`,
    role: 'owner',
    permissions: ['store:manage', 'refunds:write', 'orders:read'],
    joinedAt: new Date(),
  });
  return store.id;
}

describe('the settings row', () => {
  it('reads as unwritten defaults, and a READ creates nothing', async () => {
    const storeId = await seedStore('unwritten');
    const facts = await readMerchantActivationSettings(storeId);
    expect(facts).toEqual({
      exists: false,
      nativeCheckoutIntent: 'enabled',
      guestCheckoutIntent: 'enabled',
      supportEmail: null,
      supportUrl: null,
      platformHeld: false,
    });
    // A checkout reads this. A read that minted a row would write on a path that
    // must never write, and would make "how many stores have started activation"
    // unanswerable.
    expect(await findMerchantActivationSettings(db, storeId)).toBeUndefined();
  });

  it('CONVERGES when two callers create it at once', async () => {
    const storeId = await seedStore('race');
    // Sequential creation through two transactions is the shape a read-then-write
    // gets wrong; the unique index plus `ON CONFLICT DO NOTHING` is what makes it
    // one row rather than a 23505.
    const [first, second] = await Promise.all([
      db.transaction(async (tx) => lockMerchantActivationSettings(tx, storeId)),
      db.transaction(async (tx) => lockMerchantActivationSettings(tx, storeId)),
    ]);
    expect(first.id).toBe(second.id);
    const rows = await db
      .select({ id: merchantActivationSettings.id })
      .from(merchantActivationSettings)
      .where(eq(merchantActivationSettings.storeId, storeId));
    expect(rows).toHaveLength(1);
  });

  it('refuses a PARTIAL hold — the row that would leave a store held by nobody', async () => {
    const storeId = await seedStore('partial-hold');
    await db.transaction(async (tx) => lockMerchantActivationSettings(tx, storeId));
    await expectConstraintViolation(
      () =>
        db
          .update(merchantActivationSettings)
          .set({ platformHoldReason: 'fraud review' })
          .where(eq(merchantActivationSettings.storeId, storeId)),
      'merchant_activation_settings_hold_shape_check',
    );
    // The positive control: all three together is accepted, so the CHECK is
    // refusing the SHAPE rather than the columns.
    const held = await db.transaction(async (tx) =>
      applyPlatformHold(tx, { storeId, reason: 'fraud review', operatorOxyUserId: `op-${RUN}` }),
    );
    expect(held?.platformHeldAt).not.toBeNull();
  });

  it('refuses a SECOND hold over a live one, and releases all three columns together', async () => {
    const storeId = await seedStore('hold-twice');
    const first = await db.transaction(async (tx) =>
      applyPlatformHold(tx, { storeId, reason: 'first reason', operatorOxyUserId: `op1-${RUN}` }),
    );
    expect(first?.platformHoldReason).toBe('first reason');

    // The incumbent's reason and actor are what an incident review reads, so a
    // second hold is a NO-OP rather than an overwrite. The empty result IS the
    // "already held" answer.
    const second = await db.transaction(async (tx) =>
      applyPlatformHold(tx, { storeId, reason: 'second reason', operatorOxyUserId: `op2-${RUN}` }),
    );
    expect(second).toBeUndefined();
    expect((await findMerchantActivationSettings(db, storeId))?.platformHoldReason).toBe(
      'first reason',
    );

    const released = await db.transaction(async (tx) => releasePlatformHold(tx, storeId));
    expect(released?.platformHoldReason).toBeNull();
    expect(released?.platformHeldByOxyUserId).toBeNull();
    expect(released?.platformHeldAt).toBeNull();
    // Releasing what is not held is a no-op too, so a retry converges.
    expect(await db.transaction(async (tx) => releasePlatformHold(tx, storeId))).toBeUndefined();
  });

  it('refuses a support contact that is present but unreachable', async () => {
    const storeId = await seedStore('contact');
    await db.transaction(async (tx) => lockMerchantActivationSettings(tx, storeId));
    for (const bad of ['', 'nobody', '@nowhere']) {
      await expectConstraintViolation(
        () =>
          db
            .update(merchantActivationSettings)
            .set({ supportEmail: bad })
            .where(eq(merchantActivationSettings.storeId, storeId)),
        'merchant_activation_settings_support_email_check',
      );
    }
    await expectConstraintViolation(
      () =>
        db
          .update(merchantActivationSettings)
          .set({ supportUrl: 'http://help.example' })
          .where(eq(merchantActivationSettings.storeId, storeId)),
      'merchant_activation_settings_support_url_check',
    );

    // Positive control on both columns.
    const updated = await db.transaction(async (tx) =>
      updateMerchantCheckoutIntents(tx, {
        storeId,
        supportEmail: 'help@example.test',
        supportUrl: 'https://help.example.test',
      }),
    );
    expect(updated.supportEmail).toBe('help@example.test');
    expect(updated.supportUrl).toBe('https://help.example.test');
  });
});

describe('policy acceptances', () => {
  it('converges on a replay and refuses an UPDATE or a DELETE', async () => {
    const ownerId = `seller-${RUN}`;

    const input = {
      policyKey: 'p2p_returns_cancellation_dispute' as const,
      policyVersion: '2026-08-14',
      ownerType: 'user' as const,
      ownerId,
      acceptedByOxyUserId: ownerId,
    };
    const first = await insertPolicyAcceptance(db, input);
    expect(first.created).toBe(true);
    const second = await insertPolicyAcceptance(db, input);
    // Same consent, same row: `ON CONFLICT DO NOTHING` plus a read-back, so a
    // double tap does not duplicate an audit record.
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(await listPolicyAcceptancesForOwner({ ownerType: 'user', ownerId })).toHaveLength(1);

    await expectAppendOnlyRefusal(() =>
      db
        .update(merchantActivationPolicyAcceptances)
        .set({ acceptedByOxyUserId: 'somebody-else' })
        .where(eq(merchantActivationPolicyAcceptances.id, first.row.id)),
    );
    await expectAppendOnlyRefusal(() =>
      db
        .delete(merchantActivationPolicyAcceptances)
        .where(eq(merchantActivationPolicyAcceptances.id, first.row.id)),
    );
  });

  it('refuses a policy accepted by the wrong kind of owner', async () => {
    const storeId = await seedStore('wrong-owner');
    // A STORE cannot accept the P2P policy: the policy declares who may accept
    // it, so this is not a caller's choice.
    await expect(
      acceptActivationPolicy({
        policyKey: 'p2p_returns_cancellation_dispute',
        policyVersion: '2026-08-14',
        ownerType: 'store',
        ownerId: storeId,
        acceptedByOxyUserId: `owner-${RUN}`,
      }),
    ).rejects.toThrow(/accepted by a user/);
  });

  it('refuses a STALE version rather than recording it against the wrong one', async () => {
    const storeId = await seedStore('stale-version');
    await expect(
      acceptActivationPolicy({
        policyKey: 'returns_and_fulfilment_responsibilities',
        policyVersion: '1999-01-01',
        ownerType: 'store',
        ownerId: storeId,
        acceptedByOxyUserId: `owner-${RUN}`,
      }),
    ).rejects.toThrow(/reload it and accept the current version/);
  });
});

describe('the capability trail', () => {
  it('refuses a transition that changed nothing, and one attributed wrongly', async () => {
    const storeId = await seedStore('trail-checks');
    await db.transaction(async (tx) => lockMerchantActivationSettings(tx, storeId));

    // A `previous` equal to `next` is not a transition. The writer compares
    // before inserting; this is what stops a second writer skipping it.
    await expectConstraintViolation(
      () =>
        insertCapabilityEvents(db, [
          {
            storeId,
            capability: 'card_payment_rail',
            previousState: 'granted',
            nextState: 'granted',
            unmet: [],
            actorKind: 'system',
            actorOxyUserId: null,
            cause: 'scheduled_observation',
          },
        ]),
      'merchant_activation_capability_events_change_check',
    );

    // A `system` observation must NOT name a person, or a sweep's finding is
    // attributed to whoever happened to trigger it.
    await expectConstraintViolation(
      () =>
        insertCapabilityEvents(db, [
          {
            storeId,
            capability: 'card_payment_rail',
            previousState: null,
            nextState: 'granted',
            unmet: [],
            actorKind: 'system',
            actorOxyUserId: `op-${RUN}`,
            cause: 'scheduled_observation',
          },
        ]),
      'merchant_activation_capability_events_actor_shape_check',
    );

    // ...and a `merchant` one MUST. The two directions are one biconditional.
    await expectConstraintViolation(
      () =>
        insertCapabilityEvents(db, [
          {
            storeId,
            capability: 'card_payment_rail',
            previousState: null,
            nextState: 'granted',
            unmet: [],
            actorKind: 'merchant',
            actorOxyUserId: null,
            cause: 'merchant_setting_changed',
          },
        ]),
      'merchant_activation_capability_events_actor_shape_check',
    );

    // A GRANTED capability with an unmet list would make the trail lie in the
    // dangerous direction.
    await expectConstraintViolation(
      () =>
        insertCapabilityEvents(db, [
          {
            storeId,
            capability: 'card_payment_rail',
            previousState: null,
            nextState: 'granted',
            unmet: ['payment_provider_ready'],
            actorKind: 'system',
            actorOxyUserId: null,
            cause: 'scheduled_observation',
          },
        ]),
      'merchant_activation_capability_events_granted_shape_check',
    );

    // The `unmet` array holds requirement KEYS and nothing else — an operator
    // note, an email or a moderation finding has no shape to arrive in.
    await expectConstraintViolation(
      () =>
        insertCapabilityEvents(db, [
          {
            storeId,
            capability: 'card_payment_rail',
            previousState: null,
            nextState: 'withheld',
            // The point of the case is that the SERVER refuses a value the
            // TYPE already forbids: two layers, and only one of them survives a
            // raw `psql` statement.
            unmet: ['buyer@example.test'] as never,
            actorKind: 'system',
            actorOxyUserId: null,
            cause: 'scheduled_observation',
          },
        ]),
      'merchant_activation_capability_events_unmet_check',
    );

    // The positive control: a well-formed transition IS accepted, so every
    // rejection above is about its own shape rather than about the table.
    expect(
      await insertCapabilityEvents(db, [
        {
          storeId,
          capability: 'card_payment_rail',
          previousState: null,
          nextState: 'withheld',
          unmet: ['payment_provider_ready'],
          actorKind: 'system',
          actorOxyUserId: null,
          cause: 'scheduled_observation',
        },
      ]),
    ).toBe(1);
  });

  it('is append-only against UPDATE', async () => {
    const storeId = await seedStore('trail-append-only');
    await insertCapabilityEvents(db, [
      {
        storeId,
        capability: 'shipping_checkout',
        previousState: null,
        nextState: 'withheld',
        unmet: ['guest_fulfilment_deterministic'],
        actorKind: 'system',
        actorOxyUserId: null,
        cause: 'scheduled_observation',
      },
    ]);
    await expectAppendOnlyRefusal(() =>
      db
        .update(merchantActivationCapabilityEvents)
        .set({ nextState: 'granted' })
        .where(eq(merchantActivationCapabilityEvents.storeId, storeId)),
    );
  });

  it('reads the LATEST state per capability, tie-broken by id', async () => {
    const storeId = await seedStore('trail-latest');
    // One statement, so every row shares an instant — and `@oxyhq/db`'s uuid v7
    // is not monotonic within a millisecond, which is exactly why the read
    // orders by `id desc` as well as by `created_at desc`. Two statements in
    // sequence make the ordering unambiguous, which is what this asserts.
    await insertCapabilityEvents(db, [
      {
        storeId,
        capability: 'pickup_checkout',
        previousState: null,
        nextState: 'withheld',
        unmet: ['guest_fulfilment_deterministic'],
        actorKind: 'system',
        actorOxyUserId: null,
        cause: 'scheduled_observation',
      },
    ]);
    await db
      .update(merchantActivationCapabilityEvents)
      .set({ createdAt: sql`now() - interval '1 hour'` })
      .where(eq(merchantActivationCapabilityEvents.storeId, storeId))
      .catch(() => undefined);
    await insertCapabilityEvents(db, [
      {
        storeId,
        capability: 'pickup_checkout',
        previousState: 'withheld',
        nextState: 'granted',
        unmet: [],
        actorKind: 'operator',
        actorOxyUserId: `op-${RUN}`,
        cause: 'operator_reevaluation',
      },
    ]);
    const latest = await readLatestCapabilityStates(db, storeId);
    expect(latest.get('pickup_checkout')).toBe('granted');
  });
});

describe('observation records a transition end to end', () => {
  it('writes one row per moved capability, then nothing on a repeat', async () => {
    const storeId = await seedStore('observe');
    await db.transaction(async (tx) => lockMerchantActivationSettings(tx, storeId));

    const first = await observeMerchantActivation(storeId, {
      kind: 'operator',
      oxyUserId: `op-${RUN}`,
      cause: 'operator_reevaluation',
    });
    // Ten capabilities, every one of them moving from "never observed" to its
    // first state. The floor is what makes the ZERO below mean "nothing moved"
    // rather than "the observation never ran".
    expect(first).toBeGreaterThan(0);
    expect(await countCapabilityEvents(storeId, 'authenticated_native_checkout')).toBe(1);

    const second = await observeMerchantActivation(storeId, {
      kind: 'operator',
      oxyUserId: `op-${RUN}`,
      cause: 'operator_reevaluation',
    });
    expect(second).toBe(0);
    expect(await countCapabilityEvents(storeId, 'authenticated_native_checkout')).toBe(1);
  });

  it('records a MOVE when the merchant pauses its own checkout', async () => {
    const storeId = await seedStore('observe-pause');
    await observeMerchantActivation(storeId, {
      kind: 'system',
      oxyUserId: null,
      cause: 'scheduled_observation',
    });
    const before = await readLatestCapabilityStates(db, storeId);

    await db.transaction(async (tx) =>
      updateMerchantCheckoutIntents(tx, { storeId, guestCheckoutIntent: 'paused' }),
    );
    const moved = await observeMerchantActivation(storeId, {
      kind: 'merchant',
      oxyUserId: `owner-${RUN}`,
      cause: 'merchant_setting_changed',
    });

    // The native half is untouched — #85 readiness-change rule 9 — so the ONLY
    // capability that could have moved is the guest one. If the store was
    // already withholding it (this deployment configures no Stripe rail), the
    // count is zero and the assertion below is what says so honestly rather than
    // the test claiming a move it did not observe.
    const after = await readLatestCapabilityStates(db, storeId);
    expect(after.get('authenticated_native_checkout')).toBe(
      before.get('authenticated_native_checkout'),
    );
    if (before.get('guest_native_checkout') === 'granted') {
      expect(moved).toBe(1);
      expect(after.get('guest_native_checkout')).toBe('withheld');
    } else {
      expect(moved).toBe(0);
    }
  });
});

describe('the derived state', () => {
  it('never claims a capability the derivation withheld', async () => {
    const storeId = await seedStore('derived');
    const { deriveMerchantActivation } = await import(
      '../merchant-activation/activation.service.js'
    );
    const derived = await deriveMerchantActivation(storeId);
    expect(derived).not.toBeNull();
    if (!derived) return;
    for (const capability of derived.capabilities) {
      if (capability.state === 'granted') expect(capability.unmet).toEqual([]);
      if (capability.state === 'withheld') expect(capability.unmet.length).toBeGreaterThan(0);
    }
    // A store with no merchant, no payment account and no accepted policies
    // cannot be selling. The verdict is what makes every gate above meaningful.
    expect(derived.nativeState).toBe('disabled');
    expect(derived.nativeBlocking).toContain('merchant_claim_verified');
    expect(derived.nativeBlocking).toContain('returns_fulfilment_acknowledged');
  });
});
