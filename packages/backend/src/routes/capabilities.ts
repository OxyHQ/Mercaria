import { createHash } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { CapabilityTicketClaims, CatalogTool } from '@oxyhq/contracts';
import {
  CapabilityTicketError,
  inputSatisfiesCapabilityLimits,
  readCapabilityAuthorization,
} from '@oxyhq/core/server';
import { jsonObjectSchemaToZod } from '@oxyhq/mcp';

import {
  auditMercariaCapabilityTicket,
  introspectMercariaCapabilityTicket,
  verifyMercariaCapabilityTicket,
} from '../capabilities/capability-authority.js';
import {
  authorizeMercariaCatalogInvocation,
  type MercariaAuthorizationDecision,
} from '../capabilities/mercaria-domain-authority.js';
import { MERCARIA_CAPABILITY_CATALOG } from '../capabilities/mercaria.catalog.js';
import { executeMercariaCatalogTool } from '../capabilities/mercaria.handlers.js';
import { isMercariaError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

const router = Router();

router.use((_request, response, next) => {
  response.set('cache-control', 'no-store');
  next();
});

function resourceMatches(
  claims: CapabilityTicketClaims,
  tool: CatalogTool,
  input: Readonly<Record<string, unknown>>,
): boolean {
  const resource = claims.resource;
  if (resource.appId !== MERCARIA_CAPABILITY_CATALOG.appId) return false;
  if (!tool.resourceTypes.includes(resource.resourceType)) return false;
  if (resource.resourceType === MERCARIA_CAPABILITY_CATALOG.accountResourceType) {
    return resource.resourceId === resource.effectiveAccountId;
  }
  if (resource.resourceType === 'store') return input.storeId === resource.resourceId;
  if (resource.resourceType === 'order') return input.orderId === resource.resourceId;
  return false;
}

function actorAccountId(claims: CapabilityTicketClaims): string {
  return claims.actor.type === 'agent' ? claims.actor.accountId : claims.actor.ownerAccountId;
}

function registerRoute(tool: CatalogTool, handler: RequestHandler): void {
  const path = `/${tool.name}`;
  switch (tool.invocation.method) {
    case 'GET': router.get(path, handler); break;
    case 'POST': router.post(path, handler); break;
    case 'PATCH': router.patch(path, handler); break;
    case 'PUT': router.put(path, handler); break;
    case 'DELETE': router.delete(path, handler); break;
  }
}

async function auditDenied(
  ticket: string,
  tool: CatalogTool,
  code: string,
  claims?: CapabilityTicketClaims,
): Promise<void> {
  await auditMercariaCapabilityTicket({
    ticket,
    result: { status: 'denied', code },
    rollbackSupported: tool.rollback === 'supported',
  }).catch((error: unknown) => {
    log.general.error({ err: error, ticketId: claims?.jti, tool: tool.name }, 'Capability denial audit failed');
  });
}

for (const tool of MERCARIA_CAPABILITY_CATALOG.tools.filter(({ exposure }) =>
  exposure.includes('internal'),
)) {
  const parseInput = jsonObjectSchemaToZod(tool.inputSchema);
  const parseOutput = tool.outputSchema ? jsonObjectSchemaToZod(tool.outputSchema) : null;

  registerRoute(tool, async (request, response) => {
    const ticket = readCapabilityAuthorization(request.header('authorization'));
    if (!ticket) {
      response.status(401).json({ error: 'capability_ticket_required' });
      return;
    }

    let claims: CapabilityTicketClaims;
    try {
      claims = await verifyMercariaCapabilityTicket(ticket);
    } catch (error) {
      const code = error instanceof CapabilityTicketError ? error.code : 'jwks_unavailable';
      response.status(code === 'jwks_unavailable' ? 503 : 401).json({
        error: code === 'jwks_unavailable'
          ? 'capability_authority_unavailable'
          : 'invalid_capability_ticket',
        code,
      });
      return;
    }

    const rawInput = tool.invocation.method === 'GET' ? request.query : request.body;
    const parsedInput = parseInput.safeParse(rawInput);
    if (!parsedInput.success) {
      await auditDenied(ticket, tool, 'capability_input_schema_mismatch', claims);
      response.status(400).json({ error: 'capability_input_schema_mismatch' });
      return;
    }
    const input = parsedInput.data as Record<string, unknown>;
    const capabilityMatches = tool.requiredCapabilities.every((required) =>
      claims.capabilities.includes(required),
    );
    if (claims.tool !== tool.name || !capabilityMatches || !resourceMatches(claims, tool, input)) {
      await auditDenied(ticket, tool, 'capability_scope_mismatch', claims);
      response.status(403).json({ error: 'capability_scope_mismatch' });
      return;
    }
    if (!inputSatisfiesCapabilityLimits(tool.name, input, claims.limits)) {
      await auditDenied(ticket, tool, 'capability_limit_exceeded', claims);
      response.status(403).json({ error: 'capability_limit_exceeded' });
      return;
    }

    try {
      if (!await introspectMercariaCapabilityTicket(ticket, claims)) {
        await auditDenied(ticket, tool, 'capability_revoked_or_denied', claims);
        response.status(403).json({ error: 'capability_revoked_or_denied' });
        return;
      }
    } catch (error) {
      log.general.error({ err: error, ticketId: claims.jti }, 'Capability introspection failed');
      response.status(503).json({ error: 'capability_authority_unavailable' });
      return;
    }

    let domainDecision: MercariaAuthorizationDecision;
    try {
      domainDecision = await authorizeMercariaCatalogInvocation(
        tool.name,
        input,
        claims.resource.effectiveAccountId,
      );
    } catch (error) {
      log.general.error({ err: error, ticketId: claims.jti }, 'Mercaria domain authorization failed');
      await auditMercariaCapabilityTicket({
        ticket,
        result: { status: 'failed', code: 'domain_authority_unavailable' },
        rollbackSupported: tool.rollback === 'supported',
      }).catch((auditError: unknown) => {
        log.general.error({ err: auditError, ticketId: claims.jti }, 'Capability failure audit failed');
      });
      response.status(503).json({ error: 'domain_authority_unavailable' });
      return;
    }
    if (domainDecision.allowed === false) {
      await auditDenied(ticket, tool, domainDecision.reason, claims);
      response.status(403).json({ error: domainDecision.reason });
      return;
    }

    const rawIdempotencyKey = typeof input.idempotencyKey === 'string'
      ? input.idempotencyKey
      : undefined;
    const idempotencyKeyHash = rawIdempotencyKey
      ? createHash('sha256').update(rawIdempotencyKey).digest('hex')
      : undefined;

    try {
      const result = await executeMercariaCatalogTool(
        tool.name,
        input,
        claims.resource.effectiveAccountId,
        actorAccountId(claims),
      );
      const output = parseOutput ? parseOutput.parse(result) : result;
      await auditMercariaCapabilityTicket({
        ticket,
        result: { status: 'succeeded' },
        rollbackSupported: tool.rollback === 'supported',
        idempotencyKeyHash,
      }).catch((error: unknown) => {
        log.general.error({ err: error, ticketId: claims.jti }, 'Capability success audit failed');
      });
      response.json(output);
    } catch (error) {
      const denied = isMercariaError(error) && error.httpStatus === 403;
      const code = isMercariaError(error) ? error.code : 'capability_execution_failed';
      await auditMercariaCapabilityTicket({
        ticket,
        result: { status: denied ? 'denied' : 'failed', code },
        rollbackSupported: tool.rollback === 'supported',
        idempotencyKeyHash,
      }).catch((auditError: unknown) => {
        log.general.error({ err: auditError, ticketId: claims.jti }, 'Capability failure audit failed');
      });
      if (!isMercariaError(error)) {
        log.general.error({ err: error, ticketId: claims.jti, tool: tool.name }, 'Capability execution failed');
      }
      response.status(isMercariaError(error) ? error.httpStatus : 500).json({ error: code });
    }
  });
}

export default router;
