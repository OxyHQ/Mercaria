/**
 * Store service.
 *
 * Owns store lifecycle (create/update/move to another owning account) and the
 * per-person permission overrides. Who may act for a store is NOT here: a
 * store is owned by an Oxy account (`stores.oxy_account_id`, ADR 0012), Oxy
 * decides who belongs to it, and `store-access.service.ts` maps that onto
 * permissions. There is no member list to protect, so there are no
 * last-owner rules either — an Oxy account always has an owner, and that is
 * Oxy's invariant to keep.
 */

import type {
  CreateStoreInput,
  StoreAccess,
  StorePermission,
  UpdateStoreInput,
  UpdateStoreSettingsInput,
  UpdateStorePoliciesInput,
} from '@mercaria/shared-types';
import {
  deleteStorePermissionOverride,
  findStoreById,
  insertStore,
  storeHandleExists,
  updateStoreColumns,
  upsertStorePermissionOverride,
  type StorePermissionOverrideRow,
  type StoreRow,
} from '../db/stores/storeRepository.js';
import { insertLocation } from '../db/stores/locationRepository.js';
import { ensureUniqueSlug } from '../utils/slug.js';
import { forbidden, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';
import { assertMayOwnStores, storeAuditActor, type StoreCaller } from './store-access.service.js';

/** Default brand color for a store created without one. */
const DEFAULT_BRAND_COLOR = '#1D4ED8';

/**
 * The `policies` patch as a column patch on `stores`.
 *
 * The five fields were one embedded object and are now five flat columns, so
 * "only the supplied fields are touched" — which Mongoose gave for free by
 * mutating the sub-document — becomes an explicit `undefined` check per field.
 * Shared by the core store update (`PATCH /admin/stores/:storeId`) and the
 * settings update (`PATCH /admin/stores/:storeId/settings`).
 */
function policyPatch(patch: UpdateStorePoliciesInput): Partial<StoreRow> {
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
 * Create a store owned by `oxyAccountId`. The handle is derived from the name
 * and made unique. Authorizes nothing: a caller-facing path checks the caller
 * may give that account a store first ({@link createStoreForCaller}).
 */
export async function createStore(
  oxyAccountId: string,
  input: Omit<CreateStoreInput, 'oxyAccountId'>,
): Promise<StoreRow> {
  const handle = await ensureUniqueSlug(input.name, (candidate) => storeHandleExists(candidate));

  if (handle.length === 0) {
    throw validationError('Store name must contain at least one alphanumeric character');
  }

  const store = await insertStore({
    oxyAccountId,
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
  });

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

/**
 * Create a store for the caller. The owning account is `input.oxyAccountId`
 * when given, else the account the session speaks as — and either way the
 * caller must be that account undelegated, or its owner or admin. The default
 * is checked too: a person operating an organization as an `editor` speaks as
 * it, and an editor does not commit an organization to a new store.
 */
export async function createStoreForCaller(
  caller: StoreCaller,
  input: CreateStoreInput,
): Promise<StoreRow> {
  const { oxyAccountId = caller.accountId, ...rest } = input;
  await assertMayOwnStores(caller, oxyAccountId);
  return createStore(oxyAccountId, rest);
}

/** Fetch a store by id, or throw NOT_FOUND. */
export async function getStore(storeId: string): Promise<StoreRow> {
  const store = await findStoreById(storeId);
  if (!store) {
    throw notFound('Store not found');
  }
  return store;
}

/** Update a store's profile/policy fields. Returns the updated store. */
export async function updateStore(
  storeId: string,
  patch: UpdateStoreInput,
): Promise<StoreRow> {
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
): Promise<StoreRow> {
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
 * Move a store to another owning Oxy account — the last step of "convert to
 * organization". The route already required `store:manage` on the store; this
 * requires the caller to be an owner or admin of the TARGET account too, so a
 * store can be neither pushed onto an organization that did not take it nor
 * pulled into one by somebody who cannot manage the store.
 *
 * An override naming the new owning account is removed: the owning account
 * holds every permission, so an exception for it could only ever mislead.
 */
export async function transferStoreOwnerAccount(
  store: StoreRow,
  caller: StoreCaller,
  oxyAccountId: string,
): Promise<StoreRow> {
  if (store.oxyAccountId === oxyAccountId) return store;
  await assertMayOwnStores(caller, oxyAccountId);

  const updated = await updateStoreColumns(store.id, { oxyAccountId });
  if (!updated) throw notFound('Store not found');
  await deleteStorePermissionOverride(store.id, oxyAccountId);

  log.general.info(
    {
      storeId: store.id,
      fromOxyAccountId: store.oxyAccountId,
      toOxyAccountId: oxyAccountId,
      actorOxyUserId: storeAuditActor(caller),
    },
    '[Stores] store moved to another owning Oxy account',
  );
  return updated;
}

/**
 * Write one person's exception to the role map — or remove it, when both sets
 * are empty, because "no exception" is the absence of a row.
 *
 * Refused:
 *  - for the owning account itself, which holds everything and is nobody's
 *    member, so an exception could only mislead;
 *  - for a permission both granted and revoked (no safe reading to store);
 *  - for any permission the CALLER does not hold. Granting what you lack is an
 *    escalation, and revoking what you lack edits a boundary you sit outside —
 *    Oxy applies the same rule to its own member grants.
 */
export async function setStorePermissionOverride(input: {
  store: StoreRow;
  caller: StoreCaller;
  callerAccess: StoreAccess;
  oxyUserId: string;
  granted: readonly StorePermission[];
  revoked: readonly StorePermission[];
}): Promise<StorePermissionOverrideRow | null> {
  const { store, caller, callerAccess, oxyUserId } = input;
  if (oxyUserId === store.oxyAccountId) {
    throw validationError('The account that owns the store holds every permission already');
  }
  const granted = [...new Set(input.granted)];
  const revoked = [...new Set(input.revoked)];
  if (granted.some((permission) => revoked.includes(permission))) {
    throw validationError('A permission cannot be both granted and revoked');
  }
  const lacking = [...granted, ...revoked].filter(
    (permission) => !callerAccess.permissions.includes(permission),
  );
  if (lacking.length > 0) {
    throw forbidden(`You cannot grant or revoke a permission you do not hold: ${lacking.join(', ')}`);
  }

  if (granted.length === 0 && revoked.length === 0) {
    await deleteStorePermissionOverride(store.id, oxyUserId);
    return null;
  }
  return upsertStorePermissionOverride({
    storeId: store.id,
    oxyUserId,
    granted,
    revoked,
    updatedByOxyUserId: storeAuditActor(caller),
  });
}

/** Remove one person's exception. NOT_FOUND when there was none. */
export async function removeStorePermissionOverride(
  storeId: string,
  oxyUserId: string,
): Promise<void> {
  if (!(await deleteStorePermissionOverride(storeId, oxyUserId))) {
    throw notFound('No permission override for that account');
  }
}
