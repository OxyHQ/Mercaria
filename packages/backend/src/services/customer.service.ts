/**
 * Customer service — store-scoped buyer records + lifetime aggregates (B5).
 *
 * Owns the store-admin CRUD for `Customer`s plus the two write paths that relate
 * a buyer to a store: `upsertOnPaid` (bumps lifetime `stats` exactly once per paid
 * store order, called from `order.service.transition`) and `resolveOrCreate`
 * (find-or-create at the POS register). Every operation is scoped to its
 * `storeId`, so a member only ever touches their own store's customers. The same
 * Oxy user has ONE customer record PER store (the `{ storeId, oxyUserId }` unique
 * sparse index); a buyer with no Oxy account becomes a WALK-IN record.
 */

import type {
  Money,
  Customer as CustomerDTO,
  CreateCustomerInput,
  UpdateCustomerInput,
  AddressSnapshot,
  OrderSummary,
} from '@mercaria/shared-types';
import {
  Customer,
  type ICustomer,
  type ICustomerAddress,
} from '../models/customer.js';
import { Order, type IOrder } from '../models/order.js';
import { summarizeOrders } from './order-hydration.service.js';
import { conflict, notFound } from '../lib/errors/error-codes.js';

/** Mongo duplicate-key error code (a unique-index violation). */
const MONGO_DUPLICATE_KEY = 11000;

/** True iff `err` is a Mongo duplicate-key (unique-index) error. */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === MONGO_DUPLICATE_KEY
  );
}

/** Map a persisted `{ amount, currency }` sub-document to the `Money` DTO. */
function toMoney(value: { amount: number; currency: string }): Money {
  return { amount: value.amount, currency: value.currency as Money['currency'] };
}

/** Map an input address (or undefined) to the persisted embedded shape (omit absent optionals). */
function toCustomerAddress(address: AddressSnapshot | undefined): ICustomerAddress | undefined {
  if (!address) {
    return undefined;
  }
  const persisted: ICustomerAddress = {
    recipientName: address.recipientName,
    line1: address.line1,
    city: address.city,
    postalCode: address.postalCode,
    country: address.country,
  };
  if (address.label) persisted.label = address.label;
  if (address.line2) persisted.line2 = address.line2;
  if (address.region) persisted.region = address.region;
  if (address.phone) persisted.phone = address.phone;
  return persisted;
}

/** Map a persisted customer address to the `AddressSnapshot` DTO (omit absent optionals). */
function toAddressSnapshot(address: ICustomerAddress): AddressSnapshot {
  const dto: AddressSnapshot = {
    recipientName: address.recipientName,
    line1: address.line1,
    city: address.city,
    postalCode: address.postalCode,
    country: address.country,
  };
  if (address.label) dto.label = address.label;
  if (address.line2) dto.line2 = address.line2;
  if (address.region) dto.region = address.region;
  if (address.phone) dto.phone = address.phone;
  return dto;
}

/** Serialize a customer document to the `Customer` DTO (omit absent optionals). */
export function toCustomerDTO(customer: ICustomer): CustomerDTO {
  const dto: CustomerDTO = {
    id: String((customer as { _id: unknown })._id),
    storeId: customer.storeId,
    isWalkIn: customer.isWalkIn,
    tags: [...customer.tags],
    groupTags: [...customer.groupTags],
    stats: {
      orderCount: customer.stats.orderCount,
      totalSpent: toMoney(customer.stats.totalSpent),
    },
    createdAt: customer.createdAt.toISOString(),
    updatedAt: customer.updatedAt.toISOString(),
  };
  if (customer.oxyUserId) dto.oxyUserId = customer.oxyUserId;
  if (customer.displayName) dto.displayName = customer.displayName;
  if (customer.email) dto.email = customer.email;
  if (customer.phone) dto.phone = customer.phone;
  if (customer.defaultAddress) dto.defaultAddress = toAddressSnapshot(customer.defaultAddress);
  if (customer.stats.lastOrderAt) dto.stats.lastOrderAt = customer.stats.lastOrderAt.toISOString();
  if (customer.notes) dto.notes = customer.notes;
  return dto;
}

/**
 * Bump a store customer's lifetime aggregates when one of their store orders is
 * paid. A single atomic `findOneAndUpdate` (upsert) increments `orderCount` and
 * `totalSpent.amount`, sets `lastOrderAt`, and on insert seeds the identity +
 * `totalSpent.currency`. Called EXACTLY once per paid store order (from the
 * post-CAS side-effects block in `order.service.transition`). The `$inc` and
 * `$setOnInsert` touch DISJOINT leaf paths (`stats.totalSpent.amount` vs
 * `stats.totalSpent.currency`), so they do not conflict; `orderCount` is only
 * `$inc`-ed (not `$setOnInsert`) — on insert mongoose treats the missing path as
 * 0 and applies the increment.
 */
export async function upsertOnPaid(
  storeId: string,
  buyerOxyUserId: string,
  orderGrandTotal: Money,
): Promise<void> {
  await Customer.findOneAndUpdate(
    { storeId, oxyUserId: buyerOxyUserId },
    {
      $inc: {
        'stats.orderCount': 1,
        'stats.totalSpent.amount': orderGrandTotal.amount,
      },
      $set: { 'stats.lastOrderAt': new Date() },
      $setOnInsert: {
        storeId,
        oxyUserId: buyerOxyUserId,
        isWalkIn: false,
        tags: [],
        groupTags: [],
        'stats.totalSpent.currency': orderGrandTotal.currency,
      },
    },
    { upsert: true, new: true },
  );
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
 *   - with `oxyUserId`: upsert the store's `{ storeId, oxyUserId }` record (Oxy-backed).
 *   - else with `email`: return the store's existing customer matching that email.
 *   - else: create a WALK-IN record (no oxyUserId) from the given details.
 */
export async function resolveOrCreate(
  storeId: string,
  params: ResolveOrCreateParams,
): Promise<ICustomer> {
  if (params.oxyUserId) {
    const set: Record<string, unknown> = { isWalkIn: false };
    if (params.displayName) set.displayName = params.displayName;
    if (params.email) set.email = params.email;
    if (params.phone) set.phone = params.phone;
    const customer = await Customer.findOneAndUpdate(
      { storeId, oxyUserId: params.oxyUserId },
      {
        $set: set,
        $setOnInsert: { storeId, oxyUserId: params.oxyUserId, tags: [], groupTags: [] },
      },
      { upsert: true, new: true },
    );
    return customer.toObject();
  }

  if (params.email) {
    const existing = await Customer.findOne({ storeId, email: params.email });
    if (existing) {
      return existing.toObject();
    }
  }

  const created = await Customer.create({
    storeId,
    isWalkIn: true,
    ...(params.displayName ? { displayName: params.displayName } : {}),
    ...(params.email ? { email: params.email } : {}),
    ...(params.phone ? { phone: params.phone } : {}),
  });
  return created.toObject();
}

/** Escape a user-supplied string for safe use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Offset-paginated customer list parameters. */
interface ListCustomersParams {
  page: number;
  limit: number;
  search?: string;
}

/** A page of customers plus the total matching count (controller paginates). */
interface CustomerPage {
  data: ICustomer[];
  total: number;
}

/** List a store's customers (newest first), optionally filtered by a name/email search. */
export async function listCustomers(
  storeId: string,
  { page, limit, search }: ListCustomersParams,
): Promise<CustomerPage> {
  const filter: Record<string, unknown> = { storeId };
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), 'i');
    filter.$or = [{ displayName: pattern }, { email: pattern }];
  }
  const [data, total] = await Promise.all([
    Customer.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<ICustomer[]>(),
    Customer.countDocuments(filter),
  ]);
  return { data, total };
}

/** Load one customer scoped to its store, or throw NOT_FOUND. */
export async function getCustomer(storeId: string, customerId: string): Promise<ICustomer> {
  const customer = await Customer.findOne({ _id: customerId, storeId }).lean<ICustomer | null>();
  if (!customer) {
    throw notFound('Customer not found');
  }
  return customer;
}

/**
 * Create a customer for a store. A customer with `oxyUserId` is Oxy-backed; one
 * without is a walk-in. A duplicate `{ storeId, oxyUserId }` maps to a CONFLICT.
 */
export async function createCustomer(
  storeId: string,
  input: CreateCustomerInput,
): Promise<ICustomer> {
  const address = toCustomerAddress(input.defaultAddress);
  const doc: Partial<ICustomer> = {
    storeId,
    isWalkIn: !input.oxyUserId,
    tags: input.tags ? [...input.tags] : [],
    groupTags: input.groupTags ? [...input.groupTags] : [],
  };
  if (input.oxyUserId) doc.oxyUserId = input.oxyUserId;
  if (input.displayName) doc.displayName = input.displayName;
  if (input.email) doc.email = input.email;
  if (input.phone) doc.phone = input.phone;
  if (address) doc.defaultAddress = address;
  if (input.notes) doc.notes = input.notes;

  try {
    const created = await Customer.create(doc);
    return created.toObject();
  } catch (err) {
    if (isDuplicateKeyError(err)) {
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
): Promise<ICustomer> {
  const customer = await Customer.findOne({ _id: customerId, storeId });
  if (!customer) {
    throw notFound('Customer not found');
  }

  if (patch.oxyUserId !== undefined) {
    customer.oxyUserId = patch.oxyUserId;
    customer.isWalkIn = false;
  }
  if (patch.displayName !== undefined) customer.displayName = patch.displayName;
  if (patch.email !== undefined) customer.email = patch.email;
  if (patch.phone !== undefined) customer.phone = patch.phone;
  if (patch.defaultAddress !== undefined) {
    customer.defaultAddress = toCustomerAddress(patch.defaultAddress);
  }
  if (patch.tags !== undefined) customer.tags = [...patch.tags];
  if (patch.groupTags !== undefined) customer.groupTags = [...patch.groupTags];
  if (patch.notes !== undefined) customer.notes = patch.notes;

  try {
    await customer.save();
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw conflict('A customer for that Oxy account already exists');
    }
    throw err;
  }
  return customer.toObject();
}

/** List a customer's orders at the store (newest first), summarized. */
export async function getCustomerOrders(
  storeId: string,
  customerId: string,
): Promise<OrderSummary[]> {
  const orders = await Order.find({ storeId, customerId })
    .sort({ createdAt: -1 })
    .lean<IOrder[]>();
  return summarizeOrders(orders);
}
