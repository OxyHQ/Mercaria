/**
 * The writes: a merchant's own switches, a policy acceptance, an operator's hold
 * (#85).
 *
 * Every one of them records a capability observation in the SAME transaction as
 * the change, so #85 security 10 ("all guest-capability changes are audited with
 * actor, reason and prior state") holds without a sweep having run. The sweep
 * exists for the transitions nobody causes — a Stripe restriction, a connector
 * failure — and these four are the ones that have an actor to name.
 *
 * ## The observation is INSIDE the transaction, and the derivation is outside it
 *
 * `observeMerchantActivation` opens its own transaction and re-derives from
 * eleven tables, so calling it inside this one would deadlock against the
 * settings row this one already locked — #59's merge-runner failure, which
 * presents as a hang with no error. So the write commits first and the
 * observation follows, which means a crash between them loses an AUDIT ROW and
 * never a decision: the verdict is derived, so the next read is already correct
 * and the next observation records the transition with `scheduled_observation`
 * instead of the actor's name. That is the right thing to lose.
 */

import type {
  MerchantActivationPolicyKey,
  MerchantCheckoutIntent,
  ProviderAccountOwnerType,
} from '@mercaria/shared-types';
import { MERCHANT_ACTIVATION_POLICIES } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import {
  applyPlatformHold,
  findMerchantActivationSettings,
  releasePlatformHold,
  updateMerchantCheckoutIntents,
} from '../../db/merchantActivation/activationSettingsRepository.js';
import { insertPolicyAcceptance } from '../../db/merchantActivation/policyAcceptanceRepository.js';
import { observeMerchantActivation } from './transitions.service.js';

/** What a merchant may change about its own activation. */
export interface MerchantActivationSettingsPatch {
  readonly nativeCheckoutIntent?: MerchantCheckoutIntent;
  readonly guestCheckoutIntent?: MerchantCheckoutIntent;
  readonly supportEmail?: string | null;
  readonly supportUrl?: string | null;
}

/**
 * A merchant changes its own switches or its public support contact.
 *
 * There is no hold parameter here and none on the repository function this
 * calls, which is how #85 permissions rule 11 is structural rather than checked:
 * a controller cannot pass one however its body is shaped.
 */
export async function updateMerchantActivationSettings(input: {
  storeId: string;
  patch: MerchantActivationSettingsPatch;
  actorOxyUserId: string;
}): Promise<void> {
  await getDb().transaction(async (tx) => {
    await updateMerchantCheckoutIntents(tx, { storeId: input.storeId, ...input.patch });
  });
  await observeMerchantActivation(input.storeId, {
    kind: 'merchant',
    oxyUserId: input.actorOxyUserId,
    cause: 'merchant_setting_changed',
  });
}

/**
 * A seller accepts a published policy version.
 *
 * The body echoes the version the seller's screen showed, and it is checked
 * against the version actually published — a stale dialog is refused with the
 * current one rather than recorded against the wrong one, exactly as #88's fee
 * acceptance is. A replay of the same acceptance converges on the existing row.
 *
 * `ownerType` is not a parameter a caller chooses freely: the POLICY declares
 * who may accept it, so a store cannot accept the P2P policy and an individual
 * seller cannot accept a store's. That is what makes #112's `policies_accepted`
 * criterion answerable by somebody who has no store and no `store:manage`.
 */
export async function acceptActivationPolicy(input: {
  policyKey: MerchantActivationPolicyKey;
  policyVersion: string;
  ownerType: ProviderAccountOwnerType;
  ownerId: string;
  acceptedByOxyUserId: string;
}): Promise<{ created: boolean; acceptedAt: string }> {
  const policy = MERCHANT_ACTIVATION_POLICIES[input.policyKey];
  if (!policy) throw notFound('Unknown activation policy');
  if (policy.appliesTo !== input.ownerType) {
    throw validationError(
      `The ${input.policyKey} policy is accepted by a ${policy.appliesTo}, not by a ${input.ownerType}.`,
    );
  }
  if (policy.version !== input.policyVersion) {
    throw conflict(
      `The published ${input.policyKey} policy is now version ${policy.version}; ` +
        'reload it and accept the current version.',
    );
  }

  const result = await insertPolicyAcceptance(getDb(), {
    policyKey: input.policyKey,
    policyVersion: policy.version,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    acceptedByOxyUserId: input.acceptedByOxyUserId,
  });

  // Only a STORE acceptance moves a capability. An individual seller has no
  // store row to observe and no capability trail — #112 records the P2P
  // decision and this domain records only the consent.
  if (input.ownerType === 'store') {
    await observeMerchantActivation(input.ownerId, {
      kind: 'merchant',
      oxyUserId: input.acceptedByOxyUserId,
      cause: 'policy_accepted',
    });
  }
  return { created: result.created, acceptedAt: result.row.createdAt.toISOString() };
}

/**
 * An operator holds a store's checkout.
 *
 * A second hold over a live one is a NO-OP and answers 409, because the
 * incumbent's reason and actor are what an incident review reads and replacing
 * them loses who acted first.
 */
export async function holdStoreActivation(input: {
  storeId: string;
  reason: string;
  operatorOxyUserId: string;
}): Promise<void> {
  const applied = await getDb().transaction(async (tx) =>
    applyPlatformHold(tx, input),
  );
  if (!applied) throw conflict('This store is already held.');
  await observeMerchantActivation(input.storeId, {
    kind: 'operator',
    oxyUserId: input.operatorOxyUserId,
    cause: 'operator_hold_applied',
  });
}

/** An operator releases a hold. Releasing a store that is not held is a 409. */
export async function releaseStoreActivationHold(input: {
  storeId: string;
  operatorOxyUserId: string;
}): Promise<void> {
  const released = await getDb().transaction(async (tx) =>
    releasePlatformHold(tx, input.storeId),
  );
  if (!released) throw conflict('This store is not currently held.');
  await observeMerchantActivation(input.storeId, {
    kind: 'operator',
    oxyUserId: input.operatorOxyUserId,
    cause: 'operator_hold_released',
  });
}

/** The hold's stated reason and actor — the operator trace only. */
export async function readPlatformHoldDetail(storeId: string): Promise<
  | { readonly reason: string; readonly heldByOxyUserId: string; readonly heldAt: string }
  | undefined
> {
  const row = await findMerchantActivationSettings(getDb(), storeId);
  if (!row || row.platformHeldAt === null) return undefined;
  // The three columns move together — `merchant_activation_settings_hold_shape_check`
  // makes a partial hold unrepresentable — so reading one implies the others.
  return {
    reason: row.platformHoldReason ?? '',
    heldByOxyUserId: row.platformHeldByOxyUserId ?? '',
    heldAt: row.platformHeldAt.toISOString(),
  };
}
