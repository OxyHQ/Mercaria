import { describe, expect, it } from 'vitest';
import { appCapabilityCatalogSchema } from '@oxyhq/contracts';
import { createCatalogMcpToolDefinitions } from '@oxyhq/mcp';

import { MERCARIA_CAPABILITY_CATALOG } from '../mercaria.catalog.js';
import { MERCARIA_MCP_HANDLERS } from '../mercaria.handlers.js';
import { parseMercariaMcpAllowedOrigins } from '../mercaria-mcp-http.js';

describe('Mercaria capability catalog', () => {
  it('is valid and derives the MCP surface from the same canonical tools', () => {
    expect(appCapabilityCatalogSchema.parse(MERCARIA_CAPABILITY_CATALOG))
      .toEqual(MERCARIA_CAPABILITY_CATALOG);

    const exposedNames = MERCARIA_CAPABILITY_CATALOG.tools
      .filter(({ exposure }) => exposure.includes('mcp'))
      .map(({ name }) => name);
    const mcpNames = createCatalogMcpToolDefinitions(
      MERCARIA_CAPABILITY_CATALOG,
      MERCARIA_MCP_HANDLERS,
    ).map(({ tool }) => tool.name);

    expect(mcpNames).toEqual(exposedNames);
    expect(mcpNames).toEqual([
      'searchProducts',
      'listBuyerOrders',
      'readBuyerOrder',
      'listStoreOrders',
      'readStoreOrder',
    ]);
  });

  it('keeps financial execution internal and requires both an amount ceiling and idempotency', () => {
    const refund = MERCARIA_CAPABILITY_CATALOG.tools.find(
      ({ name }) => name === 'refundStoreOrder',
    );

    expect(refund).toMatchObject({
      effect: 'financial',
      capabilityPackage: 'finance',
      requiredCapabilities: ['store.refunds.execute'],
      idempotency: 'required',
      rollback: 'none',
      exposure: ['internal'],
      limitKeys: [
        { key: 'maximumAmountMinor', kind: 'maximum_number' },
        { key: 'refundShipping', kind: 'exact_boolean' },
      ],
    });
    expect(refund?.inputSchema.required).toEqual(expect.arrayContaining([
      'idempotencyKey',
      'storeId',
      'orderId',
      'maximumAmountMinor',
    ]));
  });

  it('uses a small default browser allow-list and de-duplicates configured origins', () => {
    expect(parseMercariaMcpAllowedOrigins(
      'https://example.com, https://chatgpt.com,https://example.com',
    )).toEqual([
      'https://chatgpt.com',
      'https://claude.ai',
      'https://example.com',
    ]);
  });
});
