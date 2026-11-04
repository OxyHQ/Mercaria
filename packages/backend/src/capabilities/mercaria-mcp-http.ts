import { createCatalogMcpHttpService } from '@oxy.so/mcp';
import type { OxyServer } from '@oxy.so/core/server';

import { OXY_API_URL } from '../config/oxy-identity.js';
import { log } from '../lib/logger.js';
import { oxyClient } from '../middleware/auth.js';
import { authorizeMercariaCatalogInvocation } from './mercaria-domain-authority.js';
import { MERCARIA_CAPABILITY_CATALOG } from './mercaria.catalog.js';
import { MERCARIA_MCP_HANDLERS } from './mercaria.handlers.js';

let platform: ReturnType<OxyServer['createServiceClient']> | undefined;

/**
 * Mercaria's workload calling Oxy for the MCP service (token introspection and
 * the authority checks behind it). Built on first use from the ONE `oxyClient`,
 * whose token cache it shares, so a process that never serves MCP mints nothing.
 */
const oxyPlatformTransport = {
  fetch(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> {
    platform ??= oxyClient.createServiceClient({ baseURL: OXY_API_URL, audience: 'oxy-api' });
    return platform.fetch(input, init);
  },
};

const DEFAULT_ALLOWED_ORIGINS = ['https://chatgpt.com', 'https://claude.ai'] as const;

export function parseMercariaMcpAllowedOrigins(
  configured = process.env.MERCARIA_MCP_ALLOWED_ORIGINS,
): string[] {
  return [
    ...new Set([
      ...DEFAULT_ALLOWED_ORIGINS,
      ...(configured ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ]),
  ];
}

export function createMercariaMcpHttpService() {
  return createCatalogMcpHttpService({
    catalog: MERCARIA_CAPABILITY_CATALOG,
    handlers: MERCARIA_MCP_HANDLERS,
    authorizationServer: OXY_API_URL,
    transport: oxyPlatformTransport,
    allowedOrigins: parseMercariaMcpAllowedOrigins(),
    authorize: async (input, context) => {
      const decision = await authorizeMercariaCatalogInvocation(
        context.tool.name,
        input,
        context.principal.activeAccountId,
      );
      if (decision.allowed === false) return decision;
      return { allowed: true, effectiveAccountId: context.principal.activeAccountId };
    },
    logger: {
      error(message, error) {
        log.general.error({ err: error }, message);
      },
    },
    serverName: 'mercaria-mcp',
  });
}
