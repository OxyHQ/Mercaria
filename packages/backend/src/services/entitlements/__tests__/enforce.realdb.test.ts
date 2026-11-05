/**
 * The paid-tool enforcement API against a real server: the refusal a tool's
 * route answers, the allowance a create takes in its own transaction, and the
 * allowance a delete gives back (#89, the plans going on sale).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { stores } from '../../../db/schema/stores.js';
import { findEntitlementUsage } from '../../../db/merchantPlans/usageRepository.js';
import { ErrorCodes } from '../../../utils/api-response.js';
import {
  PlanCapabilityRefusal,
  consumeCapabilityOrThrow,
  holdsCapability,
  releaseCapability,
  requireCapability,
} from '../enforce.js';
import { buildStoreCapabilities } from '../projection.js';
import { entitleStoreForTest, ensureCapabilityAvailable } from './entitle-store.js';

let db: Database;
const RUN = uuidv7().slice(-12);

beforeAll(async () => {
  db = await connectPostgres();
  await ensureCapabilityAvailable(db, 'automation_rules');
  await ensureCapabilityAvailable(db, 'advanced_demand_analytics');
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

async function mintStore(label: string): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      oxyAccountId: 'oxy-account-fixture',
      handle: `enforce-${RUN}-${label}`,
      name: `Enforce ${label}`,
      description: '',
      brandColor: '#101010',
    })
    .returning();
  if (!row) throw new Error('store insert returned no row');
  return row.id;
}

async function refusalOf(promise: Promise<unknown>): Promise<PlanCapabilityRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PlanCapabilityRefusal) return error;
    throw error;
  }
  throw new Error('expected a plan refusal, and the call succeeded');
}

describe('a store without the capability is refused by name', () => {
  it('answers PLAN_CAPABILITY_REQUIRED with a 403, and holdsCapability is false', async () => {
    const storeId = await mintStore('none');
    const refusal = await refusalOf(
      requireCapability({ storeId, capability: 'advanced_demand_analytics' }),
    );
    expect(refusal.code).toBe(ErrorCodes.PLAN_CAPABILITY_REQUIRED);
    expect(refusal.httpStatus).toBe(403);
    expect(refusal.capability).toBe('advanced_demand_analytics');
    expect(await holdsCapability({ storeId, capability: 'advanced_demand_analytics' })).toBe(false);
  });
});

describe('a total allowance is taken by a create and given back by a delete', () => {
  it('takes up to the limit, refuses the next with PLAN_LIMIT_REACHED, and frees room on release', async () => {
    const storeId = await mintStore('total');
    await entitleStoreForTest(db, { storeId, capability: 'automation_rules', limit: 2 });

    await db.transaction((tx) =>
      consumeCapabilityOrThrow(tx, { storeId, capability: 'automation_rules' }),
    );
    await db.transaction((tx) =>
      consumeCapabilityOrThrow(tx, { storeId, capability: 'automation_rules' }),
    );
    const over = await refusalOf(
      db.transaction((tx) =>
        consumeCapabilityOrThrow(tx, { storeId, capability: 'automation_rules' }),
      ),
    );
    expect(over.code).toBe(ErrorCodes.PLAN_LIMIT_REACHED);

    // At the ceiling the store still RUNS what it created.
    await expect(
      requireCapability({ storeId, capability: 'automation_rules' }),
    ).resolves.toMatchObject({ outcome: 'granted' });

    await db.transaction((tx) =>
      releaseCapability(tx, { storeId, capability: 'automation_rules' }),
    );
    const counter = await findEntitlementUsage(db, {
      storeId,
      capabilityKey: 'automation_rules',
      periodKey: 'total',
    });
    expect(counter?.used).toBe(1);
    await db.transaction((tx) =>
      consumeCapabilityOrThrow(tx, { storeId, capability: 'automation_rules' }),
    );
  });

  it('a create that rolls back takes nothing', async () => {
    const storeId = await mintStore('rollback');
    await entitleStoreForTest(db, { storeId, capability: 'automation_rules', limit: 1 });
    await expect(
      db.transaction(async (tx) => {
        await consumeCapabilityOrThrow(tx, { storeId, capability: 'automation_rules' });
        throw new Error('the counted row failed to write');
      }),
    ).rejects.toThrow('the counted row failed to write');
    await db.transaction((tx) =>
      consumeCapabilityOrThrow(tx, { storeId, capability: 'automation_rules' }),
    );
  });

  it('release never takes the counter below zero, even concurrently', async () => {
    const storeId = await mintStore('floor');
    await entitleStoreForTest(db, { storeId, capability: 'automation_rules', limit: 5 });
    await db.transaction((tx) =>
      consumeCapabilityOrThrow(tx, { storeId, capability: 'automation_rules' }),
    );
    await Promise.all(
      Array.from({ length: 4 }, () =>
        releaseCapability(db, { storeId, capability: 'automation_rules' }),
      ),
    );
    const counter = await findEntitlementUsage(db, {
      storeId,
      capabilityKey: 'automation_rules',
      periodKey: 'total',
    });
    expect(counter?.used).toBe(0);
  });

  it('refuses to release a per-period allowance', async () => {
    await expect(
      releaseCapability(db, { storeId: 'irrelevant', capability: 'scheduled_exports' }),
    ).rejects.toThrow(RangeError);
  });
});

describe('the members view of the paid tools', () => {
  it('lists an available capability, entitled or not, with its usage', async () => {
    const storeId = await mintStore('view');
    const before = await buildStoreCapabilities({ storeId });
    const analytics = before.capabilities.find((c) => c.capability === 'advanced_demand_analytics');
    expect(analytics?.entitled).toBe(false);

    await entitleStoreForTest(db, { storeId, capability: 'automation_rules', limit: 3 });
    await db.transaction((tx) =>
      consumeCapabilityOrThrow(tx, { storeId, capability: 'automation_rules' }),
    );
    const after = await buildStoreCapabilities({ storeId });
    const rules = after.capabilities.find((c) => c.capability === 'automation_rules');
    expect(rules).toMatchObject({ entitled: true, limitKind: 'total', limit: 3, used: 1 });
  });
});
