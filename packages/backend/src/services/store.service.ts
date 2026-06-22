/**
 * Store service.
 *
 * Owns store lifecycle (create/update), membership management, and the
 * owner-protection invariants:
 *   - the LAST owner of a store can be neither removed nor demoted, and
 *   - only an `owner` may change or remove ANOTHER `owner`.
 *
 * These invariants live HERE (not in middleware) and are enforced by throwing
 * typed `MercariaError`s (`CONFLICT`/`FORBIDDEN`) that controllers map to the
 * response. The creating user becomes the sole `owner` with all permissions.
 */

import type {
  CreateStoreInput,
  UpdateStoreInput,
  InviteMemberInput,
  UpdateMemberInput,
} from '@mercaria/shared-types';
import { Store, ALL_STORE_PERMISSIONS, type IStore, type IStoreMember } from '../models/store.js';
import { Location } from '../models/location.js';
import { ensureUniqueSlug } from '../utils/slug.js';
import { sendNotification } from '../lib/notification-service.js';
import { conflict, forbidden, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Default brand color for a store created without one. */
const DEFAULT_BRAND_COLOR = '#1D4ED8';

/** Count the owners currently on a store. */
function ownerCount(store: Pick<IStore, 'members'>): number {
  return store.members.filter((m) => m.role === 'owner').length;
}

/**
 * Create a store. The caller becomes its sole `owner` (granted every
 * permission). The handle is derived from the name and made unique.
 */
export async function createStore(
  ownerOxyUserId: string,
  input: CreateStoreInput,
): Promise<IStore> {
  const handle = await ensureUniqueSlug(input.name, async (candidate) => {
    const existing = await Store.exists({ handle: candidate });
    return existing !== null;
  });

  if (handle.length === 0) {
    throw validationError('Store name must contain at least one alphanumeric character');
  }

  const member: IStoreMember = {
    oxyUserId: ownerOxyUserId,
    role: 'owner',
    permissions: [...ALL_STORE_PERMISSIONS],
    joinedAt: new Date(),
  };

  const store = await Store.create({
    handle,
    name: input.name,
    description: input.description ?? '',
    brandColor: input.brandColor ?? DEFAULT_BRAND_COLOR,
    ...(input.logoFileId ? { logoFileId: input.logoFileId } : {}),
    ...(input.coverFileId ? { coverFileId: input.coverFileId } : {}),
    defaultCurrency: input.defaultCurrency ?? 'FAIR',
    status: 'active',
    members: [member],
  });

  // Every store starts with exactly one default location; store inventory routes
  // here until the owner adds more locations.
  await Location.create({
    storeId: String(store._id),
    name: 'Default',
    type: 'warehouse',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
  });

  return store.toObject();
}

/** Fetch a store by id, or throw NOT_FOUND. */
export async function getStore(storeId: string): Promise<IStore> {
  const store = await Store.findById(storeId).lean<IStore | null>();
  if (!store) {
    throw notFound('Store not found');
  }
  return store;
}

/** List the stores the given user is a member of. */
export async function listStoresForUser(oxyUserId: string): Promise<IStore[]> {
  return Store.find({ 'members.oxyUserId': oxyUserId })
    .sort({ createdAt: -1 })
    .lean<IStore[]>();
}

/** Update a store's profile/policy fields. Returns the updated store. */
export async function updateStore(
  storeId: string,
  patch: UpdateStoreInput,
): Promise<IStore> {
  const store = await Store.findById(storeId);
  if (!store) {
    throw notFound('Store not found');
  }

  if (patch.name !== undefined) store.name = patch.name;
  if (patch.description !== undefined) store.description = patch.description;
  if (patch.brandColor !== undefined) store.brandColor = patch.brandColor;
  if (patch.logoFileId !== undefined) store.logoFileId = patch.logoFileId;
  if (patch.coverFileId !== undefined) store.coverFileId = patch.coverFileId;
  if (patch.defaultCurrency !== undefined) store.defaultCurrency = patch.defaultCurrency;
  if (patch.textTone !== undefined) store.textTone = patch.textTone;
  if (patch.status !== undefined) store.status = patch.status;
  if (patch.policies !== undefined) {
    if (patch.policies.returnWindowDays !== undefined) {
      store.policies.returnWindowDays = patch.policies.returnWindowDays;
    }
    if (patch.policies.shippingNote !== undefined) {
      store.policies.shippingNote = patch.policies.shippingNote;
    }
  }

  await store.save();
  return store.toObject();
}

/**
 * Invite (add) a member to a store. The acting member's role gates whether they
 * may grant an `owner` role (only an existing owner may create another owner).
 * Rejects duplicates.
 */
export async function inviteMember(
  storeId: string,
  actor: IStoreMember,
  input: InviteMemberInput,
): Promise<IStore> {
  const store = await Store.findById(storeId);
  if (!store) {
    throw notFound('Store not found');
  }

  if (store.members.some((m) => m.oxyUserId === input.oxyUserId)) {
    throw conflict('User is already a member of this store');
  }

  // Only an owner may mint another owner.
  if (input.role === 'owner' && actor.role !== 'owner') {
    throw forbidden('Only an owner may grant the owner role');
  }

  store.members.push({
    oxyUserId: input.oxyUserId,
    role: input.role,
    permissions: input.permissions ?? [],
    invitedBy: actor.oxyUserId,
    joinedAt: new Date(),
  });

  await store.save();

  // Best-effort: notify the invited member. A notification failure must never
  // fail the invite itself.
  try {
    await sendNotification({
      userId: input.oxyUserId,
      type: 'store_member_invited',
      title: 'Store invitation',
      body: `You were added to ${store.name}`,
      data: { storeId: String(store._id), role: input.role },
    });
  } catch (err) {
    log.general.warn({ err, storeId: String(store._id) }, 'store_member_invited notification failed');
  }

  return store.toObject();
}

/**
 * Update a member's role/permissions. Enforces:
 *   - only an owner may modify another owner,
 *   - demoting the last owner away from `owner` is rejected.
 */
export async function updateMember(
  storeId: string,
  actor: IStoreMember,
  targetOxyUserId: string,
  patch: UpdateMemberInput,
): Promise<IStore> {
  const store = await Store.findById(storeId);
  if (!store) {
    throw notFound('Store not found');
  }

  const target = store.members.find((m) => m.oxyUserId === targetOxyUserId);
  if (!target) {
    throw notFound('Member not found');
  }

  // Only an owner may touch another owner.
  if (target.role === 'owner' && actor.role !== 'owner') {
    throw forbidden('Only an owner may modify another owner');
  }

  // Demoting the last owner is rejected.
  if (
    patch.role !== undefined &&
    patch.role !== 'owner' &&
    target.role === 'owner' &&
    ownerCount(store) <= 1
  ) {
    throw conflict('Cannot demote the last owner of the store');
  }

  if (patch.role !== undefined) {
    // Only an owner may promote a member to owner.
    if (patch.role === 'owner' && actor.role !== 'owner') {
      throw forbidden('Only an owner may grant the owner role');
    }
    target.role = patch.role;
  }
  if (patch.permissions !== undefined) {
    target.permissions = [...patch.permissions];
  }

  await store.save();
  return store.toObject();
}

/**
 * Remove a member from a store. Enforces:
 *   - only an owner may remove another owner,
 *   - removing the last owner is rejected.
 */
export async function removeMember(
  storeId: string,
  actor: IStoreMember,
  targetOxyUserId: string,
): Promise<IStore> {
  const store = await Store.findById(storeId);
  if (!store) {
    throw notFound('Store not found');
  }

  const target = store.members.find((m) => m.oxyUserId === targetOxyUserId);
  if (!target) {
    throw notFound('Member not found');
  }

  if (target.role === 'owner') {
    if (actor.role !== 'owner') {
      throw forbidden('Only an owner may remove another owner');
    }
    if (ownerCount(store) <= 1) {
      throw conflict('Cannot remove the last owner of the store');
    }
  }

  store.members = store.members.filter((m) => m.oxyUserId !== targetOxyUserId);
  await store.save();
  return store.toObject();
}
