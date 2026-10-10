/**
 * Store-admin controller (THIN) — store create/list/get/update/move.
 *
 * `POST /admin/stores` and `GET /admin/stores` operate on the CALLER (no
 * `loadStore`): create places the store under an Oxy account the caller may
 * give one; list returns every store the caller's Oxy accounts reach.
 * `GET/PATCH /admin/stores/:storeId[/…]` operate on the already-loaded
 * `req.store` with the caller's `req.storeAccess` (resolved by `loadStore`).
 * All business logic lives in `store.service` and `store-access.service`.
 */

import type { Request, Response } from 'express';
import type {
  CreateStoreInput,
  StoreAccess,
  TransferStoreOwnerAccountInput,
  UpdateStoreInput,
  UpdateStoreSettingsInput,
  Store as StoreDTO,
} from '@mercaria/shared-types';
import type { StoreRow } from '../../db/stores/storeRepository.js';
import {
  createStoreForCaller,
  transferStoreOwnerAccount,
  updateStore,
  updateStoreSettings,
} from '../../services/store.service.js';
import {
  listAccessibleStores,
  resolveStoreAccess,
  storeCallerFrom,
  type StoreCaller,
} from '../../services/store-access.service.js';
import { sendError, sendSuccess, ErrorCodes } from '../../utils/api-response.js';
import { respondWithError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';

/**
 * Serialize a store row to the `Store` admin DTO.
 *
 * The policy, tax and notification settings are flat columns, so there are no
 * `?? false` / `?? true` fallbacks: every one of those columns is NOT NULL with
 * a default, and a fallback would suggest a state that cannot exist.
 * The nullable columns (`logo_file_id`, the four policy bodies,
 * `tax_settings_tax_registration_id`, `notification_settings_low_stock_threshold`)
 * stay conditional, because for those NULL is a real value.
 */
export function toStoreDTO(store: StoreRow, access: StoreAccess): StoreDTO {
  return {
    id: store.id,
    oxyAccountId: store.oxyAccountId,
    access: { role: access.role, permissions: [...access.permissions] },
    handle: store.handle,
    name: store.name,
    description: store.description,
    ...(store.logoFileId ? { logoFileId: store.logoFileId } : {}),
    ...(store.coverFileId ? { coverFileId: store.coverFileId } : {}),
    brandColor: store.brandColor,
    textTone: store.textTone,
    status: store.status,
    policies: {
      returnWindowDays: store.policiesReturnWindowDays,
      ...(store.policiesShippingNote ? { shippingNote: store.policiesShippingNote } : {}),
      ...(store.policiesRefundPolicy ? { refundPolicy: store.policiesRefundPolicy } : {}),
      ...(store.policiesPrivacyPolicy ? { privacyPolicy: store.policiesPrivacyPolicy } : {}),
      ...(store.policiesTermsOfService
        ? { termsOfService: store.policiesTermsOfService }
        : {}),
    },
    defaultCurrency: store.defaultCurrency as StoreDTO['defaultCurrency'],
    taxSettings: {
      pricesIncludeTax: store.taxSettingsPricesIncludeTax,
      chargeTaxOnProducts: store.taxSettingsChargeTaxOnProducts,
      ...(store.taxSettingsTaxRegistrationId
        ? { taxRegistrationId: store.taxSettingsTaxRegistrationId }
        : {}),
    },
    notificationSettings: {
      lowStockAlerts: store.notificationSettingsLowStockAlerts,
      orderEmails: store.notificationSettingsOrderEmails,
      ...(store.notificationSettingsLowStockThreshold !== null
        ? { lowStockThreshold: store.notificationSettingsLowStockThreshold }
        : {}),
    },
    rating: store.rating,
    reviewCount: store.reviewCount,
    productCount: store.productCount,
    createdAt: store.createdAt.toISOString(),
    updatedAt: store.updatedAt.toISOString(),
  };
}

/** The verified caller, or a 401 already sent. */
function requireCaller(req: Request, res: Response): StoreCaller | null {
  const caller = storeCallerFrom(req);
  if (!caller) sendError(res, ErrorCodes.UNAUTHORIZED, 'Authentication required', 401);
  return caller;
}

/** The loaded store and the caller's access to it, or a 500 already sent. */
function loaded(req: Request, res: Response): { store: StoreRow; access: StoreAccess } | null {
  const { store, storeAccess } = req;
  if (!store || !storeAccess) {
    respondWithError(res, undefined, 'Store not loaded');
    return null;
  }
  return { store, access: storeAccess };
}

/** POST /admin/stores — create a store under an Oxy account the caller governs. */
export async function createStoreHandler(req: Request, res: Response): Promise<void> {
  const caller = requireCaller(req, res);
  if (!caller) return;
  try {
    const store = await createStoreForCaller(caller, req.body as CreateStoreInput);
    sendSuccess(res, toStoreDTO(store, await accessAfterWrite(caller, store)), 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create store');
    respondWithError(res, err, 'Failed to create store');
  }
}

/** GET /admin/stores — every store the caller's Oxy accounts reach. */
export async function listMyStores(req: Request, res: Response): Promise<void> {
  const caller = requireCaller(req, res);
  if (!caller) return;
  try {
    const stores = await listAccessibleStores(caller);
    sendSuccess(res, stores.map(({ store, access }) => toStoreDTO(store, access)));
  } catch (err) {
    log.general.error({ err }, 'Failed to list stores');
    respondWithError(res, err, 'Failed to load your stores');
  }
}

/** GET /admin/stores/:storeId — the loaded store, with the caller's access. */
export function getStoreHandler(req: Request, res: Response): void {
  const ctx = loaded(req, res);
  if (!ctx) return;
  sendSuccess(res, toStoreDTO(ctx.store, ctx.access));
}

/** PATCH /admin/stores/:storeId — update the loaded store. */
export async function updateStoreHandler(req: Request, res: Response): Promise<void> {
  const ctx = loaded(req, res);
  if (!ctx) return;
  try {
    const updated = await updateStore(ctx.store.id, req.body as UpdateStoreInput);
    sendSuccess(res, toStoreDTO(updated, ctx.access));
  } catch (err) {
    log.general.error({ err }, 'Failed to update store');
    respondWithError(res, err, 'Failed to update store');
  }
}

/** PATCH /admin/stores/:storeId/settings — update policies/notifications/tax. */
export async function updateStoreSettingsHandler(req: Request, res: Response): Promise<void> {
  const ctx = loaded(req, res);
  if (!ctx) return;
  try {
    const updated = await updateStoreSettings(
      ctx.store.id,
      req.body as UpdateStoreSettingsInput,
    );
    sendSuccess(res, toStoreDTO(updated, ctx.access));
  } catch (err) {
    log.general.error({ err }, 'Failed to update store settings');
    respondWithError(res, err, 'Failed to update store settings');
  }
}

/**
 * PATCH /admin/stores/:storeId/owner-account — move the store to another Oxy
 * account (the last step of "convert to organization"). The route requires
 * `store:manage`; the service requires owner/admin of the target account.
 */
export async function transferStoreOwnerAccountHandler(req: Request, res: Response): Promise<void> {
  const ctx = loaded(req, res);
  if (!ctx) return;
  const caller = requireCaller(req, res);
  if (!caller) return;
  try {
    const { oxyAccountId } = req.body as TransferStoreOwnerAccountInput;
    const moved = await transferStoreOwnerAccount(ctx.store, caller, oxyAccountId);
    sendSuccess(res, toStoreDTO(moved, await accessAfterWrite(caller, moved)));
  } catch (err) {
    log.general.error({ err }, 'Failed to move store to another Oxy account');
    respondWithError(res, err, 'Failed to move the store');
  }
}

/**
 * The caller's access to a store they just created or moved. The write proved
 * they own or administer its account, so this resolves (from the role cache,
 * as a rule); the fallback is the narrowest true statement, never a guess at
 * more.
 */
async function accessAfterWrite(caller: StoreCaller, store: StoreRow): Promise<StoreAccess> {
  return (await resolveStoreAccess(caller, store)) ?? { role: 'viewer', permissions: [] };
}
