/**
 * Customer service — store-scoped buyer records + lifetime aggregates (B5).
 *
 * Owns the store-admin CRUD plus the two write paths that relate a buyer to a
 * store: `upsertOnPaid` (bumps lifetime stats exactly once per paid store order,
 * called from `order.service.transition`) and `resolveOrCreate` (find-or-create
 * at the POS register). Every operation is scoped to its `storeId`, so a member
 * only ever touches their own store's customers. The same Oxy user has ONE
 * customer record PER store (`customers_store_id_oxy_user_id_key`); a buyer with
 * no Oxy account becomes a WALK-IN record.
 *
 * ## `totalSpent` needs a currency the moment a record exists
 *
 * `stats.totalSpent` is a NOT NULL `Money`, so a customer created before their
 * first order still has to declare which currency their lifetime spend is
 * denominated in. It is the STORE's settlement currency — the same basis every
 * report `$match`es on — so every create path resolves it from the store rather
 * than defaulting to FAIR, which would silently put a EUR shop's customer
 * aggregates in a currency no order of theirs is ever priced in.
 */

import type {
  Money,
  Customer as CustomerDTO,
  CreateCustomerInput,
  UpdateCustomerInput,
  AddressSnapshot,
  CurrencyCode,
  OrderSummary,
} from '@mercaria/shared-types';
import { isUniqueViolation } from '@oxyhq/db';
import {
  decrementCustomerOnRefund,
  findCustomer,
  findCustomerByEmail,
  findCustomersPage,
  insertCustomer,
  updateCustomer as updateCustomerRow,
  upsertCustomerOnPaid,
  upsertPosCustomer,
  type CustomerRecord,
} from '../db/stores/customerRepository.js';
import { findOrders } from '../db/orders/orderRepository.js';
import { findStoreRow } from '../db/stores/storeRepository.js';
import { summarizeOrders } from './order-hydration.service.js';
import { conflict, notFound } from '../lib/errors/error-codes.js';

export type { CustomerRecord };

/** Settlement currency used when a store row is missing — mirrors the column default. */
const DEFAULT_CURRENCY: CurrencyCode = 'FAIR';

/** The unique index a duplicate `{store, Oxy account}` violates. */
const CUSTOMER_OXY_USER_KEY = 'customers_store_id_oxy_user_id_key';

/** A store's settlement currency, for the `totalSpent` a new record must carry. */
async function storeCurrency(storeId: string): Promise<CurrencyCode> {
  const store = await findStoreRow(storeId);
  return (store?.defaultCurrency as CurrencyCode | undefined) ?? DEFAULT_CURRENCY;
}

/**
 * The customer's default address, or `undefined` when they have none.
 *
 * "Has an address" is `recipient_name is not null`: the nine columns are all
 * nullable together, so there is no separate flag to read, and the required
 * subfields are exactly the ones that cannot be absent on a real address.
 */
function toAddressSnapshot(customer: CustomerRecord): AddressSnapshot | undefined {
  if (
    customer.defaultAddressRecipientName === null ||
    customer.defaultAddressLine1 === null ||
    customer.defaultAddressCity === null ||
    customer.defaultAddressPostalCode === null ||
    customer.defaultAddressCountry === null
  ) {
    return undefined;
  }
  const dto: AddressSnapshot = {
    recipientName: customer.defaultAddressRecipientName,
    line1: customer.defaultAddressLine1,
    city: customer.defaultAddressCity,
    postalCode: customer.defaultAddressPostalCode,
    country: customer.defaultAddressCountry,
  };
  if (customer.defaultAddressLabel) dto.label = customer.defaultAddressLabel;
  if (customer.defaultAddressLine2) dto.line2 = customer.defaultAddressLine2;
  if (customer.defaultAddressRegion) dto.region = customer.defaultAddressRegion;
  if (customer.defaultAddressPhone) dto.phone = customer.defaultAddressPhone;
  return dto;
}

/** Serialize a customer row to the `Customer` DTO (omit absent optionals). */
export function toCustomerDTO(customer: CustomerRecord): CustomerDTO {
  const dto: CustomerDTO = {
    id: customer.id,
    storeId: customer.storeId,
    isWalkIn: customer.isWalkIn,
    tags: [...customer.tags],
    groupTags: [...customer.groupTags],
    stats: {
      orderCount: customer.statsOrderCount,
      totalSpent: {
        amount: customer.statsTotalSpentAmount,
        currency: customer.statsTotalSpentCurrency,
      },
    },
    createdAt: customer.createdAt.toISOString(),
    updatedAt: customer.updatedAt.toISOString(),
  };
  if (customer.oxyUserId) dto.oxyUserId = customer.oxyUserId;
  if (customer.displayName) dto.displayName = customer.displayName;
  if (customer.email) dto.email = customer.email;
  if (customer.phone) dto.phone = customer.phone;
  const address = toAddressSnapshot(customer);
  if (address) dto.defaultAddress = address;
  if (customer.statsLastOrderAt) dto.stats.lastOrderAt = customer.statsLastOrderAt.toISOString();
  if (customer.notes) dto.notes = customer.notes;
  return dto;
}

/**
 * Bump a store customer's lifetime aggregates when one of their store orders is
 * paid. ONE upsert increments `orderCount` and `totalSpent`, sets `lastOrderAt`,
 * and on insert seeds the identity. Called EXACTLY once per paid store order
 * (from the post-CAS side-effects block in `order.service.transition`).
 */
export async function upsertOnPaid(
  storeId: string,
  buyerOxyUserId: string,
  orderGrandTotal: Money,
): Promise<void> {
  await upsertCustomerOnPaid(storeId, buyerOxyUserId, orderGrandTotal);
}

/**
 * Give back a refunded amount from a store customer's lifetime spend (mirrors the
 * `upsertOnPaid` bump, in reverse). NOT an upsert: a refund for a buyer with no
 * customer record is a no-op. `orderCount` is intentionally left untouched — a
 * refund does not un-count the order.
 */
export async function decrementOnRefund(
  storeId: string,
  buyerOxyUserId: string,
  refundAmount: Money,
): Promise<void> {
  await decrementCustomerOnRefund(storeId, buyerOxyUserId, refundAmount);
}

/** Params accepted by `resolveOrCreate` at the POS register. */
interface ResolveOrCreateParams {
  oxyUserId?: string;
  displayName?: string;
  email?: string;
  phone?: string;
}

/**
 * Resolve a customer for a POS sale, creating one when needed:
 *   - with `oxyUserId`: upsert the store's record for that Oxy account.
 *   - else with `email`: return the store's existing customer matching that email.
 *   - else: create a WALK-IN record (no oxyUserId) from the given details.
 */
export async function resolveOrCreate(
  storeId: string,
  params: ResolveOrCreateParams,
): Promise<CustomerRecord> {
  const currency = await storeCurrency(storeId);

  if (params.oxyUserId) {
    return upsertPosCustomer(
      storeId,
      params.oxyUserId,
      {
        ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
        ...(params.email !== undefined ? { email: params.email } : {}),
        ...(params.phone !== undefined ? { phone: params.phone } : {}),
      },
      currency,
    );
  }

  if (params.email) {
    const existing = await findCustomerByEmail(storeId, params.email);
    if (existing) {
      return existing;
    }
  }

  return insertCustomer(storeId, {
    isWalkIn: true,
    ...(params.displayName ? { displayName: params.displayName } : {}),
    ...(params.email ? { email: params.email } : {}),
    ...(params.phone ? { phone: params.phone } : {}),
    tags: [],
    groupTags: [],
    totalSpentCurrency: currency,
  });
}

/** Offset-paginated customer list parameters. */
interface ListCustomersParams {
  page: number;
  limit: number;
  search?: string;
}

/** A page of customers plus the total matching count (controller paginates). */
interface CustomerPage {
  data: CustomerRecord[];
  total: number;
}

/** List a store's customers (newest first), optionally filtered by a name/email search. */
export async function listCustomers(
  storeId: string,
  { page, limit, search }: ListCustomersParams,
): Promise<CustomerPage> {
  const { rows, total } = await findCustomersPage(
    storeId,
    search !== undefined ? { search } : {},
    page,
    limit,
  );
  return { data: rows, total };
}

/** Load one customer scoped to its store, or throw NOT_FOUND. */
export async function getCustomer(
  storeId: string,
  customerId: string,
): Promise<CustomerRecord> {
  const customer = await findCustomer(storeId, customerId);
  if (!customer) {
    throw notFound('Customer not found');
  }
  return customer;
}

/**
 * Create a customer for a store. A customer with `oxyUserId` is Oxy-backed; one
 * without is a walk-in. A duplicate `{store, Oxy account}` maps to a CONFLICT.
 */
export async function createCustomer(
  storeId: string,
  input: CreateCustomerInput,
): Promise<CustomerRecord> {
  try {
    return await insertCustomer(storeId, {
      ...(input.oxyUserId ? { oxyUserId: input.oxyUserId } : {}),
      isWalkIn: !input.oxyUserId,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.defaultAddress ? { defaultAddress: input.defaultAddress } : {}),
      tags: input.tags ? [...input.tags] : [],
      groupTags: input.groupTags ? [...input.groupTags] : [],
      ...(input.notes ? { notes: input.notes } : {}),
      totalSpentCurrency: await storeCurrency(storeId),
    });
  } catch (err) {
    if (isUniqueViolation(err, CUSTOMER_OXY_USER_KEY)) {
      throw conflict('A customer for that Oxy account already exists');
    }
    throw err;
  }
}

/** Update a customer in place (scoped to `storeId`, else NOT_FOUND). */
export async function updateCustomer(
  storeId: string,
  customerId: string,
  patch: UpdateCustomerInput,
): Promise<CustomerRecord> {
  try {
    const updated = await updateCustomerRow(storeId, customerId, {
      // Claiming an Oxy account also stops the record being a walk-in — the two
      // move together, exactly as they did when the service set both by hand.
      ...(patch.oxyUserId !== undefined
        ? { oxyUserId: patch.oxyUserId, isWalkIn: false }
        : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
      // `'defaultAddress' in patch` rather than `!== undefined`: an explicit
      // `undefined` is how a caller CLEARS the address, and the repository writes
      // nine NULLs for it. Testing for `undefined` would make clearing a no-op.
      ...('defaultAddress' in patch ? { defaultAddress: patch.defaultAddress } : {}),
      ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
      ...(patch.groupTags !== undefined ? { groupTags: [...patch.groupTags] } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    });
    if (!updated) {
      throw notFound('Customer not found');
    }
    return updated;
  } catch (err) {
    if (isUniqueViolation(err, CUSTOMER_OXY_USER_KEY)) {
      throw conflict('A customer for that Oxy account already exists');
    }
    throw err;
  }
}

/** List a customer's orders at the store (newest first), summarized. */
export async function getCustomerOrders(
  storeId: string,
  customerId: string,
): Promise<OrderSummary[]> {
  return summarizeOrders(await findOrders({ storeId, customerId }));
}
