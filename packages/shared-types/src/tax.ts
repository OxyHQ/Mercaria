/**
 * Tax DTOs for the Mercaria pricing engine (B4).
 *
 * A `TaxRate` is a store-scoped rule that adds (or, when prices are tax-inclusive,
 * informationally backs out) tax on a cart's taxable base. Rates are matched by
 * region (country / region / postal-code pattern) and optionally narrowed to a
 * set of product types. The resulting `TaxLine`s — one per applied rate — are
 * persisted on the placed order. A store's `TaxSettings` decides whether prices
 * already include tax and whether product tax is charged at all.
 *
 * All amounts are FAIR integer minor units; `rateBps` is basis points
 * (800 = 8%). Authoritative tax math runs server-side in the pricing service.
 */

import type { Money } from './money';

/** The geographic scope a tax rate applies to. */
export interface TaxRegion {
  /** ISO-3166 alpha-2 country the rate applies to (unset = any country). */
  country?: string;
  /** State/region within the country the rate applies to (unset = the whole country). */
  region?: string;
  /** A regex matched against the shipping postal code (unset = any postal code). */
  postalCodePattern?: string;
}

/** A store-scoped tax rule. */
export interface TaxRate {
  /** Stable tax-rate id. */
  id: string;
  /** The store that owns the rate. */
  storeId: string;
  /** Admin-facing name (e.g. "US Sales Tax"). */
  name: string;
  /** The rate in basis points (800 = 8%). */
  rateBps: number;
  /** The geographic scope the rate applies to. */
  region: TaxRegion;
  /** Whether the rate also taxes shipping (reserved; shipping is a later seam). */
  appliesToShipping: boolean;
  /** Product types the rate is narrowed to (empty/absent = all product types). */
  productTypeScope?: string[];
  /** Higher priority rates are evaluated first when several match. */
  priority: number;
  /** Whether the rate is currently enabled. */
  isActive: boolean;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 last-update time. */
  updatedAt: string;
}

/** One applied tax rate's contribution to an order, persisted on the placed order. */
export interface TaxLine {
  /** The tax rate's name at apply time (snapshot). */
  name: string;
  /** The rate in basis points at apply time (snapshot). */
  rateBps: number;
  /** The tax amount this line contributes (FAIR minor units). */
  amount: Money;
}

/** Store-level tax behavior. */
export interface TaxSettings {
  /**
   * Whether product prices already INCLUDE tax. When true, taxes are backed out
   * informationally and NOT added to the grand total; when false, tax is added.
   */
  pricesIncludeTax: boolean;
  /** Optional tax registration id surfaced on receipts/invoices. */
  taxRegistrationId?: string;
  /** Whether product tax is charged at all (false ⇒ no tax lines emitted). */
  chargeTaxOnProducts: boolean;
}

/** Payload accepted when creating a tax rate. */
export interface CreateTaxRateInput {
  name: string;
  rateBps: number;
  region: TaxRegion;
  appliesToShipping?: boolean;
  productTypeScope?: string[];
  priority?: number;
  isActive?: boolean;
}

/** Partial payload accepted when updating a tax rate. */
export type UpdateTaxRateInput = Partial<CreateTaxRateInput>;

/** Partial payload accepted when updating a store's tax settings. */
export type UpdateTaxSettingsInput = Partial<TaxSettings>;
