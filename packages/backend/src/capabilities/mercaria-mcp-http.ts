import { createCatalogMcpHttpService } from '@oxyhq/mcp';

import { log } from '../lib/logger.js';
import { authorizeMercariaCatalogInvocation } from './mercaria-domain-authority.js';
import { MERCARIA_CAPABILITY_CATALOG } from './mercaria.catalog.js';
import { MERCARIA_MCP_HANDLERS } from './mercaria.handlers.js';
import {
  invalidateOxyServiceToken,
  requiredOxyServiceToken,
} from './oxy-service-client.js';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://chatgpt.com',
  'https://claude.ai',
] as const;

export function parseMercariaMcpAllowedOrigins(
  configured = process.env.MERCARIA_MCP_ALLOWED_ORIGINS,
): string[] {
  return [...new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...(configured ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ])];
}

export function createMercariaMcpHttpService() {
  return createCatalogMcpHttpService({
    catalog: MERCARIA_CAPABILITY_CATALOG,
    handlers: MERCARIA_MCP_HANDLERS,
    authorizationServer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
    getServiceToken: requiredOxyServiceToken,
    invalidateServiceToken: invalidateOxyServiceToken,
    allowedOrigins: parseMercariaMcpAllowedOrigins(),
    authorize: async (input, context) => {
      const decision = await authorizeMercariaCatalogInvocation(
        context.tool.name,
        input,
        context.principal.accountId,
      );
      if (decision.allowed === false) return decision;
      return { allowed: true, effectiveAccountId: context.principal.accountId };
    },
    logger: {
      error(message, error) {
        log.general.error({ err: error }, message);
      },
    },
    serverName: 'mercaria-mcp',
  });
}
