import type { AppCapabilityCatalog, CatalogTool } from '@oxyhq/contracts';

const TOOL_VERSION = '1.0.0';
const MAX_SAFE_MINOR_UNITS = Number.MAX_SAFE_INTEGER;

const identifier = { type: 'string', minLength: 1, maxLength: 255 } as const;
const idempotencyKey = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  description: 'Stable caller-generated key for retry-safe execution.',
} as const;
const objectOutput = { type: 'object', additionalProperties: true } as const;

type ReadToolInput = Omit<
  CatalogTool,
  'version' | 'capabilityPackage' | 'requiredCapabilities' | 'effect' |
  'idempotency' | 'rollback' | 'exposure' | 'limitKeys'
> & {
  capability: string;
  limitKeys?: CatalogTool['limitKeys'];
};

function readTool({ capability, limitKeys = [], ...input }: ReadToolInput): CatalogTool {
  return {
    ...input,
    version: TOOL_VERSION,
    capabilityPackage: 'read',
    requiredCapabilities: [capability],
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
    exposure: ['internal', 'mcp'],
    limitKeys,
  };
}

export const MERCARIA_CAPABILITY_CATALOG: AppCapabilityCatalog = {
  schemaVersion: '1',
  appId: 'mercaria',
  version: '1.0.0',
  audience: 'oxy-mercaria-api',
  internalBaseUrl: 'https://api.mercaria.co',
  externalMcp: { resource: 'https://mcp.mercaria.oxy.so' },
  accountResourceType: 'mercaria_account',
  tools: [
    readTool({
      name: 'searchProducts',
      description: 'Search Mercaria\'s canonical product catalog.',
      capability: 'commerce.search',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 1_000 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          cursor: { type: 'string', maxLength: 2_000 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      outputSchema: objectOutput,
      resourceTypes: ['mercaria_account'],
      limitKeys: [{ key: 'limit', kind: 'maximum_number' }],
      invocation: { method: 'POST', path: '/_oxy/capabilities/searchProducts' },
    }),
    readTool({
      name: 'listBuyerOrders',
      description: 'List orders owned or claimed by one delegated Mercaria account.',
      capability: 'orders.read',
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      outputSchema: objectOutput,
      resourceTypes: ['mercaria_account'],
      limitKeys: [{ key: 'limit', kind: 'maximum_number' }],
      invocation: { method: 'POST', path: '/_oxy/capabilities/listBuyerOrders' },
    }),
    readTool({
      name: 'readBuyerOrder',
      description: 'Read one order owned or claimed by a delegated Mercaria account.',
      capability: 'orders.read',
      inputSchema: {
        type: 'object',
        properties: { orderId: identifier },
        required: ['orderId'],
        additionalProperties: false,
      },
      outputSchema: objectOutput,
      resourceTypes: ['mercaria_account', 'order'],
      invocation: { method: 'POST', path: '/_oxy/capabilities/readBuyerOrder' },
    }),
    readTool({
      name: 'listStoreOrders',
      description: 'List orders for one store the delegated account can operate.',
      capability: 'store.orders.read',
      inputSchema: {
        type: 'object',
        properties: {
          storeId: identifier,
          status: {
            type: 'string',
            enum: [
              'pending_payment', 'paid', 'processing', 'shipped', 'delivered',
              'cancelled', 'refunded', 'partially_refunded',
            ],
          },
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['storeId'],
        additionalProperties: false,
      },
      outputSchema: objectOutput,
      resourceTypes: ['store'],
      limitKeys: [{ key: 'limit', kind: 'maximum_number' }],
      invocation: { method: 'POST', path: '/_oxy/capabilities/listStoreOrders' },
    }),
    readTool({
      name: 'readStoreOrder',
      description: 'Read one order through the merchant-safe projection of its store.',
      capability: 'store.orders.read',
      inputSchema: {
        type: 'object',
        properties: { storeId: identifier, orderId: identifier },
        required: ['storeId', 'orderId'],
        additionalProperties: false,
      },
      outputSchema: objectOutput,
      resourceTypes: ['store', 'order'],
      invocation: { method: 'POST', path: '/_oxy/capabilities/readStoreOrder' },
    }),
    {
      name: 'refundStoreOrder',
      version: TOOL_VERSION,
      description: 'Refund selected items to the original payment destination for one store order.',
      inputSchema: {
        type: 'object',
        properties: {
          idempotencyKey,
          storeId: identifier,
          orderId: identifier,
          maximumAmountMinor: {
            type: 'integer',
            minimum: 0,
            maximum: MAX_SAFE_MINOR_UNITS,
            description: 'Hard ceiling in the order presentment currency; execution fails before effects if exceeded.',
          },
          type: { type: 'string', enum: ['refund', 'return'] },
          reason: { type: 'string', maxLength: 2_000 },
          lineItems: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: {
              type: 'object',
              properties: {
                variantId: identifier,
                quantity: { type: 'integer', minimum: 1, maximum: 100_000 },
                restock: { type: 'boolean' },
                locationId: identifier,
              },
              required: ['variantId', 'quantity'],
              additionalProperties: false,
            },
          },
          refundShipping: { type: 'boolean' },
        },
        required: [
          'idempotencyKey', 'storeId', 'orderId', 'maximumAmountMinor', 'lineItems',
        ],
        additionalProperties: false,
      },
      outputSchema: objectOutput,
      capabilityPackage: 'finance',
      requiredCapabilities: ['store.refunds.execute'],
      resourceTypes: ['store', 'order'],
      effect: 'financial',
      idempotency: 'required',
      rollback: 'none',
      // Financial execution stays on the internal capability-ticket plane.
      // Central OAuth currently grants semantic scopes, but does not persist a
      // consent-bound numeric ceiling. Exposing this over MCP would let the
      // caller choose its own "maximum", which is not an authorization limit.
      exposure: ['internal'],
      limitKeys: [
        { key: 'maximumAmountMinor', kind: 'maximum_number' },
        { key: 'refundShipping', kind: 'exact_boolean' },
      ],
      invocation: { method: 'POST', path: '/_oxy/capabilities/refundStoreOrder' },
    },
  ],
  events: [],
};
