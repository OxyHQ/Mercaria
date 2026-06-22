/**
 * Tax service — store-admin lifecycle for tax rates + tax settings (B4).
 *
 * Owns create/list/update/delete for a store's `TaxRate`s plus the `TaxRate` DTO
 * serializer and the store-level `taxSettings` patch. Every operation is scoped to
 * its `storeId`. The matching/computation side lives in `pricing.service`; this
 * module is the admin CRUD only.
 */

import type {
  CreateTaxRateInput,
  UpdateTaxRateInput,
  UpdateTaxSettingsInput,
  TaxRate as TaxRateDTO,
  TaxSettings,
} from '@mercaria/shared-types';
import { TaxRate, type ITaxRate, type ITaxRegion } from '../models/tax-rate.js';
import { Store, type IStore } from '../models/store.js';
import { notFound } from '../lib/errors/error-codes.js';

/** Build the persisted region sub-document from input (omit absent optionals). */
function buildRegion(input: CreateTaxRateInput['region']): ITaxRegion {
  const region: ITaxRegion = {};
  if (input.country !== undefined) region.country = input.country;
  if (input.region !== undefined) region.region = input.region;
  if (input.postalCodePattern !== undefined) region.postalCodePattern = input.postalCodePattern;
  return region;
}

/** Serialize a tax-rate document to the `TaxRate` DTO. */
export function toTaxRateDTO(rate: ITaxRate): TaxRateDTO {
  const dto: TaxRateDTO = {
    id: String((rate as { _id: unknown })._id),
    storeId: rate.storeId,
    name: rate.name,
    rateBps: rate.rateBps,
    region: {
      ...(rate.region.country !== undefined ? { country: rate.region.country } : {}),
      ...(rate.region.region !== undefined ? { region: rate.region.region } : {}),
      ...(rate.region.postalCodePattern !== undefined
        ? { postalCodePattern: rate.region.postalCodePattern }
        : {}),
    },
    appliesToShipping: rate.appliesToShipping,
    priority: rate.priority,
    isActive: rate.isActive,
    createdAt: rate.createdAt.toISOString(),
    updatedAt: rate.updatedAt.toISOString(),
  };
  if (rate.productTypeScope) {
    dto.productTypeScope = [...rate.productTypeScope];
  }
  return dto;
}

/** List a store's tax rates, highest priority first then newest. */
export async function listTaxRates(storeId: string): Promise<ITaxRate[]> {
  return TaxRate.find({ storeId }).sort({ priority: -1, createdAt: -1 }).lean<ITaxRate[]>();
}

/** Load one tax rate scoped to its store, or throw NOT_FOUND. */
export async function getTaxRate(storeId: string, taxRateId: string): Promise<ITaxRate> {
  const rate = await TaxRate.findOne({ _id: taxRateId, storeId }).lean<ITaxRate | null>();
  if (!rate) {
    throw notFound('Tax rate not found');
  }
  return rate;
}

/** Create a tax rate for a store. */
export async function createTaxRate(
  storeId: string,
  input: CreateTaxRateInput,
): Promise<ITaxRate> {
  const doc: Partial<ITaxRate> = {
    storeId,
    name: input.name,
    rateBps: input.rateBps,
    region: buildRegion(input.region),
    appliesToShipping: input.appliesToShipping ?? false,
    priority: input.priority ?? 0,
    isActive: input.isActive ?? true,
  };
  if (input.productTypeScope) doc.productTypeScope = [...input.productTypeScope];

  const created = await TaxRate.create(doc);
  return created.toObject();
}

/** Update a tax rate in place (scoped to `storeId`, else NOT_FOUND). */
export async function updateTaxRate(
  storeId: string,
  taxRateId: string,
  patch: UpdateTaxRateInput,
): Promise<ITaxRate> {
  const rate = await TaxRate.findOne({ _id: taxRateId, storeId });
  if (!rate) {
    throw notFound('Tax rate not found');
  }

  if (patch.name !== undefined) rate.name = patch.name;
  if (patch.rateBps !== undefined) rate.rateBps = patch.rateBps;
  if (patch.region !== undefined) rate.region = buildRegion(patch.region);
  if (patch.appliesToShipping !== undefined) rate.appliesToShipping = patch.appliesToShipping;
  if (patch.productTypeScope !== undefined) rate.productTypeScope = [...patch.productTypeScope];
  if (patch.priority !== undefined) rate.priority = patch.priority;
  if (patch.isActive !== undefined) rate.isActive = patch.isActive;

  await rate.save();
  return rate.toObject();
}

/** Delete a tax rate (scoped to `storeId`, else NOT_FOUND). */
export async function deleteTaxRate(storeId: string, taxRateId: string): Promise<void> {
  const result = await TaxRate.deleteOne({ _id: taxRateId, storeId });
  if (result.deletedCount === 0) {
    throw notFound('Tax rate not found');
  }
}

/**
 * Patch a store's `taxSettings` (scoped to `storeId`, else NOT_FOUND). Only the
 * supplied fields are touched; absent fields keep their current value (defaulting
 * an absent stored block on a pre-B4 store).
 */
export async function updateTaxSettings(
  storeId: string,
  patch: UpdateTaxSettingsInput,
): Promise<IStore> {
  const store = await Store.findById(storeId);
  if (!store) {
    throw notFound('Store not found');
  }

  const current: TaxSettings = {
    pricesIncludeTax: store.taxSettings?.pricesIncludeTax ?? false,
    chargeTaxOnProducts: store.taxSettings?.chargeTaxOnProducts ?? true,
    ...(store.taxSettings?.taxRegistrationId
      ? { taxRegistrationId: store.taxSettings.taxRegistrationId }
      : {}),
  };

  store.taxSettings = {
    pricesIncludeTax: patch.pricesIncludeTax ?? current.pricesIncludeTax,
    chargeTaxOnProducts: patch.chargeTaxOnProducts ?? current.chargeTaxOnProducts,
    ...(patch.taxRegistrationId !== undefined
      ? { taxRegistrationId: patch.taxRegistrationId }
      : current.taxRegistrationId
        ? { taxRegistrationId: current.taxRegistrationId }
        : {}),
  };

  await store.save();
  return store.toObject();
}
