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
 *
 * ## Ported to Postgres
 *
 * `Store.members` was an embedded array and is now `store_members`, so a
 * membership change is an INSERT/UPDATE/DELETE on one row rather than a rewrite
 * of the whole document. The owner-protection checks are unchanged in substance
 * and still read the members through {@link StoreRecord}, which the repository
 * assembles — nothing above this layer joins the two tables.
 *
 * The one behaviour that genuinely changes: `UNIQUE(store_id, oxy_user_id)` now
 * makes a duplicate membership impossible at the database. The service still
 * checks for one first, so a human gets CONFLICT rather than a 500 — but two
 * concurrent invites of the same user can no longer BOTH win, which under Mongo
 * they could.
 */

import type {
  CreateStoreInput,
  UpdateStoreInput,
  UpdateStoreSettingsInput,
  UpdateStorePoliciesInput,
  InviteMemberInput,
  UpdateMemberInput,
} from '@mercaria/shared-types';
import { STORE_PERMISSIONS } from '../db/schema/stores.js';
import {
  findStoreById,
  findStoresForMember,
  insertStore,
  insertStoreMember,
  deleteStoreMember,
  storeHandleExists,
  updateStoreColumns,
  updateStoreMember,
  type StoreMemberRecord,
  type StoreRecord,
} from '../db/stores/storeRepository.js';
import { insertLocation } from '../db/stores/locationRepository.js';
import { ensureUniqueSlug } from '../utils/slug.js';
import { sendNotification } from '../lib/notification-service.js';
import { conflict, forbidden, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Default brand color for a store created without one. */
const DEFAULT_BRAND_COLOR = '#1D4ED8';

/** Count the owners currently on a store. */
function ownerCount(store: StoreRecord): number {
  return store.members.filter((m) => m.role === 'owner').length;
}

/**
 * The `policies` patch as a column patch on `stores`.
 *
 * The five fields were one embedded object and are now five flat columns, so
 * "only the supplied fields are touched" — which Mongoose gave for free by
 * mutating the sub-document — becomes an explicit `undefined` check per field.
 * Shared by the core store update (`PATCH /admin/stores/:storeId`) and the
 * settings update (`PATCH /admin/stores/:storeId/settings`).
 */
function policyPatch(patch: UpdateStorePoliciesInput): Partial<StoreRecord> {
  return {
    ...(patch.returnWindowDays !== undefined
      ? { policiesReturnWindowDays: patch.returnWindowDays }
      : {}),
    ...(patch.shippingNote !== undefined ? { policiesShippingNote: patch.shippingNote } : {}),
    ...(patch.refundPolicy !== undefined ? { policiesRefundPolicy: patch.refundPolicy } : {}),
    ...(patch.privacyPolicy !== undefined ? { policiesPrivacyPolicy: patch.privacyPolicy } : {}),
    ...(patch.termsOfService !== undefined
      ? { policiesTermsOfService: patch.termsOfService }
      : {}),
  };
}

/**
 * Create a store. The caller becomes its sole `owner` (granted every
 * permission). The handle is derived from the name and made unique.
 */
export async function createStore(
  ownerOxyUserId: string,
  input: CreateStoreInput,
): Promise<StoreRecord> {
  const handle = await ensureUniqueSlug(input.name, (candidate) => storeHandleExists(candidate));

  if (handle.length === 0) {
    throw validationError('Store name must contain at least one alphanumeric character');
  }

  const store = await insertStore(
    {
      handle,
      name: input.name,
      // The `''` Mongoose supplied as a column DEFAULT is written explicitly
      // here — `listings`/`stores.description` deliberately carry no default,
      // so that "absent" and "empty" cannot become the same row by accident.
      description: input.description ?? '',
      brandColor: input.brandColor ?? DEFAULT_BRAND_COLOR,
      defaultCurrency: input.defaultCurrency ?? 'FAIR',
      ...(input.logoFileId ? { logoFileId: input.logoFileId } : {}),
      ...(input.coverFileId ? { coverFileId: input.coverFileId } : {}),
    },
    [{ oxyUserId: ownerOxyUserId, role: 'owner', permissions: [...STORE_PERMISSIONS] }],
  );

  // Every store starts with exactly one default location; store inventory routes
  // here until the owner adds more locations.
  await insertLocation(store.id, {
    name: 'Default',
    type: 'warehouse',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
  });

  return store;
}

/** Fetch a store by id, or throw NOT_FOUND. */
export async function getStore(storeId: string): Promise<StoreRecord> {
  const store = await findStoreById(storeId);
  if (!store) {
    throw notFound('Store not found');
  }
  return store;
}

/** List the stores the given user is a member of. */
export async function listStoresForUser(oxyUserId: string): Promise<StoreRecord[]> {
  return findStoresForMember(oxyUserId);
}

/** Update a store's profile/policy fields. Returns the updated store. */
export async function updateStore(
  storeId: string,
  patch: UpdateStoreInput,
): Promise<StoreRecord> {
  const updated = await updateStoreColumns(storeId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.brandColor !== undefined ? { brandColor: patch.brandColor } : {}),
    ...(patch.logoFileId !== undefined ? { logoFileId: patch.logoFileId } : {}),
    ...(patch.coverFileId !== undefined ? { coverFileId: patch.coverFileId } : {}),
    ...(patch.defaultCurrency !== undefined ? { defaultCurrency: patch.defaultCurrency } : {}),
    ...(patch.textTone !== undefined ? { textTone: patch.textTone } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.policies !== undefined ? policyPatch(patch.policies) : {}),
  });

  if (!updated) {
    throw notFound('Store not found');
  }
  return updated;
}

/**
 * Update a store's settings: long-form policies and notification preferences
 * (and, optionally, tax settings) in one call. Only supplied fields are touched;
 * absent fields keep their current value. Gated on `settings:write`.
 *
 * The Mongo version defaulted an ABSENT `notificationSettings`/`taxSettings`
 * block on a pre-B7 store before patching it. That branch is gone: all six
 * columns are NOT NULL with the same defaults the old code substituted, so there
 * is no "absent block" left to reconstruct.
 */
export async function updateStoreSettings(
  storeId: string,
  patch: UpdateStoreSettingsInput,
): Promise<StoreRecord> {
  const notifications = patch.notificationSettings;
  const tax = patch.taxSettings;

  const updated = await updateStoreColumns(storeId, {
    ...(patch.policies !== undefined ? policyPatch(patch.policies) : {}),
    ...(notifications?.lowStockAlerts !== undefined
      ? { notificationSettingsLowStockAlerts: notifications.lowStockAlerts }
      : {}),
    ...(notifications?.orderEmails !== undefined
      ? { notificationSettingsOrderEmails: notifications.orderEmails }
      : {}),
    ...(notifications?.lowStockThreshold !== undefined
      ? { notificationSettingsLowStockThreshold: notifications.lowStockThreshold }
      : {}),
    ...(tax?.pricesIncludeTax !== undefined
      ? { taxSettingsPricesIncludeTax: tax.pricesIncludeTax }
      : {}),
    ...(tax?.chargeTaxOnProducts !== undefined
      ? { taxSettingsChargeTaxOnProducts: tax.chargeTaxOnProducts }
      : {}),
    ...(tax?.taxRegistrationId !== undefined
      ? { taxSettingsTaxRegistrationId: tax.taxRegistrationId }
      : {}),
  });

  if (!updated) {
    throw notFound('Store not found');
  }
  return updated;
}

/**
 * Invite (add) a member to a store. The acting member's role gates whether they
 * may grant an `owner` role (only an existing owner may create another owner).
 * Rejects duplicates.
 */
export async function inviteMember(
  storeId: string,
  actor: StoreMemberRecord,
  input: InviteMemberInput,
): Promise<StoreRecord> {
  const store = await findStoreById(storeId);
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

  await insertStoreMember(storeId, {
    oxyUserId: input.oxyUserId,
    role: input.role,
    permissions: input.permissions ?? [],
    invitedBy: actor.oxyUserId,
  });

  // Best-effort: notify the invited member. A notification failure must never
  // fail the invite itself.
  try {
    await sendNotification({
      userId: input.oxyUserId,
      type: 'store_member_invited',
      title: 'Store invitation',
      body: `You were added to ${store.name}`,
      data: { storeId, role: input.role },
    });
  } catch (err) {
    log.general.warn({ err, storeId }, 'store_member_invited notification failed');
  }

  return getStore(storeId);
}

/**
 * Update a member's role/permissions. Enforces:
 *   - only an owner may modify another owner,
 *   - demoting the last owner away from `owner` is rejected.
 */
export async function updateMember(
  storeId: string,
  actor: StoreMemberRecord,
  targetOxyUserId: string,
  patch: UpdateMemberInput,
): Promise<StoreRecord> {
  const store = await findStoreById(storeId);
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

  // Only an owner may promote a member to owner.
  if (patch.role === 'owner' && actor.role !== 'owner') {
    throw forbidden('Only an owner may grant the owner role');
  }

  await updateStoreMember(storeId, targetOxyUserId, {
    ...(patch.role !== undefined ? { role: patch.role } : {}),
    ...(patch.permissions !== undefined ? { permissions: [...patch.permissions] } : {}),
  });

  return getStore(storeId);
}

/**
 * Remove a member from a store. Enforces:
 *   - only an owner may remove another owner,
 *   - removing the last owner is rejected.
 */
export async function removeMember(
  storeId: string,
  actor: StoreMemberRecord,
  targetOxyUserId: string,
): Promise<StoreRecord> {
  const store = await findStoreById(storeId);
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

  await deleteStoreMember(storeId, targetOxyUserId);
  return getStore(storeId);
}
