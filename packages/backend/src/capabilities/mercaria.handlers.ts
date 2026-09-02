import type {
  CreateRefundInput,
  OrderStatus,
  RefundLineInput,
} from '@mercaria/shared-types';
import type { CatalogToolHandlers } from '@oxyhq/mcp';

import { config } from '../config/index.js';
import { notFound, validationError } from '../lib/errors/error-codes.js';
import {
  getBuyerOrders,
  getOrderForBuyer,
  getOrderForStore,
  getStoreOrders,
} from '../services/order.service.js';
import { process as processRefund } from '../services/refund.service.js';
import { runCanonicalSearch } from '../services/search/canonical-search.service.js';
import { MERCARIA_CAPABILITY_CATALOG } from './mercaria.catalog.js';

function requiredString(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`${key} is required`);
  }
  return value;
}

function optionalPositiveInteger(
  input: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = input[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function requiredNonNegativeInteger(
  input: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw validationError(`${key} must be non-negative safe minor units`);
  }
  return value;
}

function refundLines(value: unknown): RefundLineInput[] {
  if (!Array.isArray(value)) throw validationError('lineItems is required');
  return value.map((line) => {
    if (typeof line !== 'object' || line === null || Array.isArray(line)) {
      throw validationError('Every refund line must be an object');
    }
    const record = line as Record<string, unknown>;
    const quantity = record.quantity;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
      throw validationError('Refund quantity must be a positive integer');
    }
    return {
      variantId: requiredString(record, 'variantId'),
      quantity,
      ...(typeof record.restock === 'boolean' ? { restock: record.restock } : {}),
      ...(typeof record.locationId === 'string' ? { locationId: record.locationId } : {}),
    };
  });
}

function pagination(page: number, limit: number, total: number) {
  return { page, limit, total, pages: Math.ceil(total / limit) };
}

export async function executeMercariaCatalogTool(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  effectiveAccountId: string,
  actorAccountId: string,
): Promise<Record<string, unknown>> {
  switch (toolName) {
    case 'searchProducts': {
      if (config.canonicalRollout.search !== 'on') throw notFound('Canonical search is not available');
      const outcome = await runCanonicalSearch({
        term: requiredString(input, 'query'),
        kinds: [],
        filters: {},
        limit: optionalPositiveInteger(input, 'limit', 20),
        ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
      });
      return { search: outcome.response };
    }
    case 'listBuyerOrders': {
      const page = optionalPositiveInteger(input, 'page', 1);
      const limit = optionalPositiveInteger(input, 'limit', 20);
      const result = await getBuyerOrders(effectiveAccountId, { page, limit });
      return { orders: result.data, pagination: pagination(page, limit, result.total) };
    }
    case 'readBuyerOrder':
      return {
        order: await getOrderForBuyer(effectiveAccountId, requiredString(input, 'orderId')),
      };
    case 'listStoreOrders': {
      const page = optionalPositiveInteger(input, 'page', 1);
      const limit = optionalPositiveInteger(input, 'limit', 20);
      const status = typeof input.status === 'string' ? input.status as OrderStatus : undefined;
      const result = await getStoreOrders(requiredString(input, 'storeId'), {
        page,
        limit,
        ...(status ? { status } : {}),
      });
      return { orders: result.data, pagination: pagination(page, limit, result.total) };
    }
    case 'readStoreOrder':
      return {
        order: await getOrderForStore(
          requiredString(input, 'storeId'),
          requiredString(input, 'orderId'),
        ),
      };
    case 'refundStoreOrder': {
      const refundInput: CreateRefundInput = {
        idempotencyKey: requiredString(input, 'idempotencyKey'),
        lineItems: refundLines(input.lineItems),
        ...(input.type === 'refund' || input.type === 'return' ? { type: input.type } : {}),
        ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
        ...(typeof input.refundShipping === 'boolean'
          ? { refundShipping: input.refundShipping }
          : {}),
      };
      const refund = await processRefund(
        requiredString(input, 'storeId'),
        requiredString(input, 'orderId'),
        refundInput,
        actorAccountId,
        { maximumPresentmentAmountMinor: requiredNonNegativeInteger(input, 'maximumAmountMinor') },
      );
      return { refund };
    }
    default:
      throw validationError(`Unknown Mercaria catalog tool: ${toolName}`);
  }
}

export const MERCARIA_MCP_HANDLERS: CatalogToolHandlers = Object.fromEntries(
  MERCARIA_CAPABILITY_CATALOG.tools.map(({ name }) => [
    name,
    async (input, context) => ({
      structuredContent: await executeMercariaCatalogTool(
        name,
        input,
        context.principal.accountId,
        context.principal.accountId,
      ),
    }),
  ]),
);

