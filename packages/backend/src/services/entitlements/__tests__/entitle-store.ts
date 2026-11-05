/**
 * Test helper: make a store hold one paid capability, through a GRANT.
 *
 * A paid tool's realdb suite needs a store that is entitled (and one that is
 * not) without standing up a plan version, prices and a subscription — whose
 * global indexes (`merchant_plans_one_active_free_plan`) other files contend
 * for. A grant is the domain's own way to give a store a capability outside a
 * plan, so the resolver, the counter and the refusal all run unchanged.
 *
 * The definition is written from the CODE catalogue (`syncEntitlementDefinitions`
 * semantics) with availability forced `available`, because the test database is
 * shared across parallel files: a fixture that wrote a different name or kind
 * would race a sibling file's read. Only availability can differ from the code,
 * and only toward the state the capability ships in.
 */

import { uuidv7 } from '@oxy.so/db';
import type { MerchantEntitlementCapability } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../../db/postgres.js';
import { upsertEntitlementDefinition } from '../../../db/merchantPlans/planRepository.js';
import { insertEntitlementGrant } from '../../../db/merchantPlans/grantRepository.js';
import { MERCHANT_CAPABILITY_CATALOG } from '../catalog.js';
import { invalidateMerchantEntitlements } from '../resolve.js';

export async function ensureCapabilityAvailable(
  db: DatabaseOrTransaction,
  capability: MerchantEntitlementCapability,
): Promise<void> {
  const definition = MERCHANT_CAPABILITY_CATALOG[capability];
  await upsertEntitlementDefinition(db, {
    capabilityKey: definition.key,
    name: definition.name,
    description: definition.description,
    limitKind: definition.limitKind,
    availability: 'available',
  });
}

/**
 * Grant `capability` to `storeId`. `limit` is ignored for a `flag` capability;
 * `null` (the default) is unlimited for a quantified one.
 */
export async function entitleStoreForTest(
  db: DatabaseOrTransaction,
  input: {
    storeId: string;
    capability: MerchantEntitlementCapability;
    limit?: number | null;
  },
): Promise<void> {
  await ensureCapabilityAvailable(db, input.capability);
  const limitKind = MERCHANT_CAPABILITY_CATALOG[input.capability].limitKind;
  await insertEntitlementGrant(db, {
    storeId: input.storeId,
    grantKey: `test-${input.capability}-${uuidv7()}`,
    capabilityKey: input.capability,
    limitKind,
    ...(limitKind === 'flag' ? {} : { limitValue: input.limit ?? null }),
    reason: 'operator_exception',
    note: 'test fixture',
    grantedByOxyUserId: 'test-operator',
    startsAt: new Date(Date.now() - 60_000),
  });
  invalidateMerchantEntitlements(input.storeId);
}
