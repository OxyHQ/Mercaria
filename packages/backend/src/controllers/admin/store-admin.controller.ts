/**
 * Store-admin controller (THIN) — store create/list/get/update.
 *
 * `POST /admin/stores` and `GET /admin/stores` operate on the CALLER (no
 * `loadStore`): create makes the caller the owner; list returns the caller's
 * stores. `GET/PATCH /admin/stores/:storeId` operate on the already-loaded
 * `req.store` (resolved + authorized by `loadStore`). All business logic lives
 * in `store.service`.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type {
  CreateStoreInput,
  UpdateStoreInput,
  UpdateStoreSettingsInput,
  Store as StoreDTO,
} from '@mercaria/shared-types';
import type { StoreRecord } from '../../db/stores/storeRepository.js';
import {
  createStore,
  listStoresForUser,
  updateStore,
  updateStoreSettings,
} from '../../services/store.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { respondWithError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';

/**
 * Serialize a store row to the `Store` admin DTO.
 *
 * The four embedded Mongoose sub-documents are now flat columns, so the
 * `?? false` / `?? true` fallbacks the old serializer carried are gone: every
 * one of those columns is NOT NULL with the same default the fallback
 * substituted, and keeping them would suggest a state that can no longer exist.
 * The nullable columns (`logo_file_id`, the four policy bodies,
 * `tax_settings_tax_registration_id`, `notification_settings_low_stock_threshold`)
 * stay conditional, because for those NULL is a real value.
 */
export function toStoreDTO(store: StoreRecord): StoreDTO {
  return {
    id: store.id,
    handle: store.handle,
    name: store.name,
    description: store.description,
    ...(store.logoFileId ? { logoFileId: store.logoFileId } : {}),
    ...(store.coverFileId ? { coverFileId: store.coverFileId } : {}),
    brandColor: store.brandColor,
    textTone: store.textTone,
    status: store.status,
    members: store.members.map((m) => ({
      oxyUserId: m.oxyUserId,
      role: m.role,
      permissions: [...m.permissions],
      joinedAt: m.joinedAt.toISOString(),
    })),
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

/** POST /admin/stores — create a store; the caller becomes its owner. */
export async function createStoreHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const store = await createStore(oxyUserId, req.body as CreateStoreInput);
    sendSuccess(res, toStoreDTO(store), 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create store');
    respondWithError(res, err, 'Failed to create store');
  }
}

/** GET /admin/stores — the caller's stores. */
export async function listMyStores(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const stores = await listStoresForUser(oxyUserId);
    sendSuccess(res, stores.map(toStoreDTO));
  } catch (err) {
    log.general.error({ err }, 'Failed to list stores');
    respondWithError(res, err, 'Failed to load your stores');
  }
}

/** GET /admin/stores/:storeId — the loaded store (caller is a member). */
export function getStoreHandler(req: Request, res: Response): void {
  // `loadStore` guarantees req.store is set for this route.
  const store = req.store;
  if (!store) {
    respondWithError(res, undefined, 'Store not loaded');
    return;
  }
  sendSuccess(res, toStoreDTO(store));
}

/** PATCH /admin/stores/:storeId — update the loaded store. */
export async function updateStoreHandler(req: Request, res: Response): Promise<void> {
  const store = req.store;
  if (!store) {
    respondWithError(res, undefined, 'Store not loaded');
    return;
  }
  try {
    const updated = await updateStore(store.id, req.body as UpdateStoreInput);
    sendSuccess(res, toStoreDTO(updated));
  } catch (err) {
    log.general.error({ err }, 'Failed to update store');
    respondWithError(res, err, 'Failed to update store');
  }
}

/** PATCH /admin/stores/:storeId/settings — update policies/notifications/tax. */
export async function updateStoreSettingsHandler(req: Request, res: Response): Promise<void> {
  const store = req.store;
  if (!store) {
    respondWithError(res, undefined, 'Store not loaded');
    return;
  }
  try {
    const updated = await updateStoreSettings(
      store.id,
      req.body as UpdateStoreSettingsInput,
    );
    sendSuccess(res, toStoreDTO(updated));
  } catch (err) {
    log.general.error({ err }, 'Failed to update store settings');
    respondWithError(res, err, 'Failed to update store settings');
  }
}
