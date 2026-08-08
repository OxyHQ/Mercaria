/**
 * Tax service — store-admin lifecycle for tax rates + tax settings (B4).
 *
 * Owns create/list/update/delete for a store's tax rates plus the `TaxRate` DTO
 * serializer and the store-level `taxSettings` patch. Every operation is scoped to
 * its `storeId`. The matching/computation side lives in `pricing.service`; this
 * module is the admin CRUD only.
 *
 * ## What the Postgres port changed
 *
 * The embedded `region` sub-document became three flat columns, so an ABSENT
 * field is a NULL column rather than a missing key — which is why the DTO
 * serializer below tests for `null` and the old one tested for `undefined`.
 *
 * `product_type_scope` keeps a distinction Mongo blurred and the service must
 * preserve: NULL means "not scoped to any product type", i.e. applies to all of
 * them, while an EMPTY array means "scoped to no product type at all" and matches
 * nothing. A patch that wrote `[]` intending to clear the scope would silently
 * disable the rate.
 */

import type {
  CreateTaxRateInput,
  UpdateTaxRateInput,
  UpdateTaxSettingsInput,
  TaxRate as TaxRateDTO,
} from '@mercaria/shared-types';
import {
  deleteTaxRate as deleteTaxRateRow,
  findTaxRate,
  findTaxRatesByStore,
  insertTaxRate,
  updateTaxRate as updateTaxRateRow,
  type TaxRateRecord,
} from '../db/stores/taxRateRepository.js';
import { updateStoreColumns, type StoreRecord } from '../db/stores/storeRepository.js';
import { notFound } from '../lib/errors/error-codes.js';

export type { TaxRateRecord };

/** Serialize a tax-rate row to the `TaxRate` DTO. */
export function toTaxRateDTO(rate: TaxRateRecord): TaxRateDTO {
  const dto: TaxRateDTO = {
    id: rate.id,
    storeId: rate.storeId,
    name: rate.name,
    rateBps: rate.rateBps,
    region: {
      ...(rate.regionCountry !== null ? { country: rate.regionCountry } : {}),
      ...(rate.regionRegion !== null ? { region: rate.regionRegion } : {}),
      ...(rate.regionPostalCodePattern !== null
        ? { postalCodePattern: rate.regionPostalCodePattern }
        : {}),
    },
    appliesToShipping: rate.appliesToShipping,
    priority: rate.priority,
    isActive: rate.isActive,
    createdAt: rate.createdAt.toISOString(),
    updatedAt: rate.updatedAt.toISOString(),
  };
  if (rate.productTypeScope !== null) {
    dto.productTypeScope = [...rate.productTypeScope];
  }
  return dto;
}

/** List a store's tax rates, highest priority first then newest. */
export async function listTaxRates(storeId: string): Promise<TaxRateRecord[]> {
  return findTaxRatesByStore(storeId);
}

/** Load one tax rate scoped to its store, or throw NOT_FOUND. */
export async function getTaxRate(storeId: string, taxRateId: string): Promise<TaxRateRecord> {
  const rate = await findTaxRate(storeId, taxRateId);
  if (!rate) {
    throw notFound('Tax rate not found');
  }
  return rate;
}

/** Create a tax rate for a store. */
export async function createTaxRate(
  storeId: string,
  input: CreateTaxRateInput,
): Promise<TaxRateRecord> {
  return insertTaxRate(storeId, {
    name: input.name,
    rateBps: input.rateBps,
    regionCountry: input.region.country ?? null,
    regionRegion: input.region.region ?? null,
    regionPostalCodePattern: input.region.postalCodePattern ?? null,
    appliesToShipping: input.appliesToShipping ?? false,
    productTypeScope: input.productTypeScope ? [...input.productTypeScope] : null,
    priority: input.priority ?? 0,
    isActive: input.isActive ?? true,
  });
}

/** Update a tax rate in place (scoped to `storeId`, else NOT_FOUND). */
export async function updateTaxRate(
  storeId: string,
  taxRateId: string,
  patch: UpdateTaxRateInput,
): Promise<TaxRateRecord> {
  const updated = await updateTaxRateRow(storeId, taxRateId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.rateBps !== undefined ? { rateBps: patch.rateBps } : {}),
    // `region` is replaced wholesale, exactly as the Mongoose sub-document was:
    // a supplied region with no `country` CLEARS the country rather than keeping
    // the previous one.
    ...(patch.region !== undefined
      ? {
          regionCountry: patch.region.country ?? null,
          regionRegion: patch.region.region ?? null,
          regionPostalCodePattern: patch.region.postalCodePattern ?? null,
        }
      : {}),
    ...(patch.appliesToShipping !== undefined
      ? { appliesToShipping: patch.appliesToShipping }
      : {}),
    ...(patch.productTypeScope !== undefined
      ? { productTypeScope: [...patch.productTypeScope] }
      : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
  });

  if (!updated) {
    throw notFound('Tax rate not found');
  }
  return updated;
}

/** Delete a tax rate (scoped to `storeId`, else NOT_FOUND). */
export async function deleteTaxRate(storeId: string, taxRateId: string): Promise<void> {
  const deleted = await deleteTaxRateRow(storeId, taxRateId);
  if (!deleted) {
    throw notFound('Tax rate not found');
  }
}

/**
 * Patch a store's tax settings (scoped to `storeId`, else NOT_FOUND). Only the
 * supplied fields are touched.
 *
 * The Mongo version reconstructed an absent `taxSettings` block from defaults
 * before patching it. That branch is gone: all three columns are NOT NULL with
 * the same defaults it substituted, so there is no absent block left to rebuild.
 */
export async function updateTaxSettings(
  storeId: string,
  patch: UpdateTaxSettingsInput,
): Promise<StoreRecord> {
  const updated = await updateStoreColumns(storeId, {
    ...(patch.pricesIncludeTax !== undefined
      ? { taxSettingsPricesIncludeTax: patch.pricesIncludeTax }
      : {}),
    ...(patch.chargeTaxOnProducts !== undefined
      ? { taxSettingsChargeTaxOnProducts: patch.chargeTaxOnProducts }
      : {}),
    ...(patch.taxRegistrationId !== undefined
      ? { taxSettingsTaxRegistrationId: patch.taxRegistrationId }
      : {}),
  });

  if (!updated) {
    throw notFound('Store not found');
  }
  return updated;
}
