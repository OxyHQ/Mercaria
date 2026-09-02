import type { AddressInfo } from 'node:net';
import express from 'express';
import type { CapabilityTicketClaims } from '@oxyhq/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  authorizeDomain: vi.fn(),
  execute: vi.fn(),
  introspect: vi.fn(),
  verify: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../capabilities/capability-authority.js', () => ({
  auditMercariaCapabilityTicket: mocks.audit,
  introspectMercariaCapabilityTicket: mocks.introspect,
  verifyMercariaCapabilityTicket: mocks.verify,
}));
vi.mock('../../capabilities/mercaria-domain-authority.js', () => ({
  authorizeMercariaCatalogInvocation: mocks.authorizeDomain,
}));
vi.mock('../../capabilities/mercaria.handlers.js', () => ({
  executeMercariaCatalogTool: mocks.execute,
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { error: mocks.logError } },
}));

import capabilitiesRouter from '../capabilities.js';

const TOKEN = 'signed-ticket';

function claims(overrides: Partial<CapabilityTicketClaims> = {}): CapabilityTicketClaims {
  const now = Math.floor(Date.now() / 1_000);
  return {
    iss: 'https://api.oxy.so',
    aud: 'oxy-mercaria-api',
    sub: 'agent-account',
    jti: 'ticket-1',
    iat: now,
    exp: now + 60,
    runId: 'run-1',
    stepId: 'step-1',
    executionAuthorization: { kind: 'direct_request', id: 'authorization-1' },
    coordinator: { applicationId: 'alia-app', credentialId: 'alia-credential' },
    requesterAccountId: 'requester-account',
    ownerAccountId: 'owner-account',
    actor: { type: 'agent', accountId: 'agent-account' },
    resource: {
      appId: 'mercaria',
      effectiveAccountId: 'owner-account',
      resourceType: 'mercaria_account',
      resourceId: 'owner-account',
    },
    tool: 'listBuyerOrders',
    capabilities: ['orders.read'],
    limits: [],
    autonomy: 'execute_on_request',
    ...overrides,
  };
}

async function request(
  path: string,
  body: Record<string, unknown>,
  authorization = `Capability ${TOKEN}`,
) {
  const app = express();
  app.use(express.json());
  app.use('/_oxy/capabilities', capabilitiesRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${port}/_oxy/capabilities/${path}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.verify.mockResolvedValue(claims());
  mocks.introspect.mockResolvedValue(true);
  mocks.authorizeDomain.mockResolvedValue({ allowed: true });
  mocks.execute.mockResolvedValue({ orders: [], pagination: { page: 1, limit: 20 } });
  mocks.audit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Mercaria internal capability routes', () => {
  it('requires a capability ticket and marks every response non-cacheable', async () => {
    const response = await request('listBuyerOrders', {}, 'Bearer user-session');

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('rechecks live authority, executes as the delegated account and audits the real agent', async () => {
    const response = await request('listBuyerOrders', { page: 1, limit: 20 });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.verify).toHaveBeenCalledWith(TOKEN);
    expect(mocks.introspect).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ jti: 'ticket-1' }));
    expect(mocks.authorizeDomain).toHaveBeenCalledWith(
      'listBuyerOrders',
      { page: 1, limit: 20 },
      'owner-account',
    );
    expect(mocks.execute).toHaveBeenCalledWith(
      'listBuyerOrders',
      { page: 1, limit: 20 },
      'owner-account',
      'agent-account',
    );
    expect(mocks.audit).toHaveBeenCalledWith({
      ticket: TOKEN,
      result: { status: 'succeeded' },
      rollbackSupported: false,
      idempotencyKeyHash: undefined,
    });
  });

  it('blocks a ticket revoked between planning and execution', async () => {
    mocks.introspect.mockResolvedValueOnce(false);

    const response = await request('listBuyerOrders', {});

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'capability_revoked_or_denied' });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      result: { status: 'denied', code: 'capability_revoked_or_denied' },
    }));
  });

  it('enforces signed financial limits before introspection or domain effects', async () => {
    mocks.verify.mockResolvedValueOnce(claims({
      tool: 'refundStoreOrder',
      capabilities: ['store.refunds.execute'],
      resource: {
        appId: 'mercaria',
        effectiveAccountId: 'owner-account',
        resourceType: 'store',
        resourceId: 'store-1',
      },
      limits: [{ tool: 'refundStoreOrder', key: 'maximumAmountMinor', value: 5_000 }],
    }));

    const response = await request('refundStoreOrder', {
      idempotencyKey: 'run-1:step-1',
      storeId: 'store-1',
      orderId: 'order-1',
      maximumAmountMinor: 5_001,
      lineItems: [{ variantId: 'variant-1', quantity: 1 }],
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'capability_limit_exceeded' });
    expect(mocks.introspect).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('fails closed when Mercaria cannot recalculate live domain authority', async () => {
    mocks.authorizeDomain.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await request('listBuyerOrders', {});

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'domain_authority_unavailable' });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      result: { status: 'failed', code: 'domain_authority_unavailable' },
    }));
  });

  it('refuses non-schema input before any authority-controlled effect', async () => {
    const response = await request('listBuyerOrders', { limit: '20' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'capability_input_schema_mismatch' });
    expect(mocks.introspect).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      result: { status: 'denied', code: 'capability_input_schema_mismatch' },
    }));
  });
});
