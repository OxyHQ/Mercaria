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
import type { IStore } from '../../models/store.js';
import {
  createStore,
  listStoresForUser,
  updateStore,
  updateStoreSettings,
} from '../../services/store.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { respondWithError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';

/** Serialize a store document to the `Store` admin DTO. */
export function toStoreDTO(store: IStore): StoreDTO {
  return {
    id: String((store as { _id: unknown })._id),
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
      returnWindowDays: store.policies.returnWindowDays,
      ...(store.policies.shippingNote ? { shippingNote: store.policies.shippingNote } : {}),
      ...(store.policies.refundPolicy ? { refundPolicy: store.policies.refundPolicy } : {}),
      ...(store.policies.privacyPolicy ? { privacyPolicy: store.policies.privacyPolicy } : {}),
      ...(store.policies.termsOfService ? { termsOfService: store.policies.termsOfService } : {}),
    },
    defaultCurrency: store.defaultCurrency as StoreDTO['defaultCurrency'],
    taxSettings: {
      pricesIncludeTax: store.taxSettings?.pricesIncludeTax ?? false,
      chargeTaxOnProducts: store.taxSettings?.chargeTaxOnProducts ?? true,
      ...(store.taxSettings?.taxRegistrationId
        ? { taxRegistrationId: store.taxSettings.taxRegistrationId }
        : {}),
    },
    notificationSettings: {
      lowStockAlerts: store.notificationSettings?.lowStockAlerts ?? true,
      orderEmails: store.notificationSettings?.orderEmails ?? true,
      ...(store.notificationSettings?.lowStockThreshold !== undefined
        ? { lowStockThreshold: store.notificationSettings.lowStockThreshold }
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
    const updated = await updateStore(String((store as { _id: unknown })._id), req.body as UpdateStoreInput);
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
      String((store as { _id: unknown })._id),
      req.body as UpdateStoreSettingsInput,
    );
    sendSuccess(res, toStoreDTO(updated));
  } catch (err) {
    log.general.error({ err }, 'Failed to update store settings');
    respondWithError(res, err, 'Failed to update store settings');
  }
}
