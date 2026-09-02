import { generateKeyPairSync } from 'node:crypto';
import type { CapabilityTicketClaims } from '@oxyhq/contracts';
import { issueCapabilityTicket } from '@oxyhq/core/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requiredOxyServiceToken: vi.fn() }));

vi.mock('../oxy-service-client.js', () => ({
  requiredOxyServiceToken: mocks.requiredOxyServiceToken,
}));

import {
  auditMercariaCapabilityTicket,
  introspectMercariaCapabilityTicket,
  resetMercariaCapabilityAuthorityForTests,
  verifyMercariaCapabilityTicket,
} from '../capability-authority.js';

const NOW = new Date('2026-08-01T10:00:00.000Z');

function unsignedClaims(): Parameters<typeof issueCapabilityTicket>[0] {
  return {
    aud: 'oxy-mercaria-api',
    sub: 'agent-account',
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
  };
}

function signingKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'EdDSA' },
  };
}

function ticket(key: ReturnType<typeof signingKey>): string {
  return issueCapabilityTicket(unsignedClaims(), {
    privateKey: key.privateKey,
    keyId: key.kid,
    issuer: 'https://api.oxy.so',
    now: NOW,
    ttlSeconds: 60,
    jti: `ticket-${key.kid}`,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.unstubAllGlobals();
  mocks.requiredOxyServiceToken.mockReset();
  mocks.requiredOxyServiceToken.mockResolvedValue('service-token');
  resetMercariaCapabilityAuthorityForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Mercaria capability authority client', () => {
  it('verifies Ed25519 tickets against a cached Oxy JWKS', async () => {
    const key = signingKey('key-1');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(verifyMercariaCapabilityTicket(ticket(key))).resolves.toMatchObject({
      jti: 'ticket-key-1',
      tool: 'listBuyerOrders',
      aud: 'oxy-mercaria-api',
    });
    await verifyMercariaCapabilityTicket(ticket(key));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.oxy.so/capabilities/.well-known/jwks.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('refreshes JWKS once when Oxy rotates to a previously unknown key', async () => {
    const oldKey = signingKey('old-key');
    const newKey = signingKey('new-key');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [oldKey.jwk] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [newKey.jwk] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(verifyMercariaCapabilityTicket(ticket(newKey))).resolves.toMatchObject({
      jti: 'ticket-new-key',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('binds live introspection to the locally verified ticket identity', async () => {
    const localClaims = {
      ...unsignedClaims(),
      iss: 'https://api.oxy.so',
      iat: Math.floor(NOW.getTime() / 1_000),
      exp: Math.floor(NOW.getTime() / 1_000) + 60,
      jti: 'ticket-1',
    } as CapabilityTicketClaims;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      active: true,
      decision: { allowed: true, reason: 'authorized' },
      claims: localClaims,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(introspectMercariaCapabilityTicket('signed-ticket', localClaims)).resolves.toBe(true);
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(request.headers).toEqual({
      authorization: 'Bearer service-token',
      'content-type': 'application/json',
    });
    expect(JSON.parse(request.body as string)).toEqual({ ticket: 'signed-ticket' });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      active: true,
      decision: { allowed: true, reason: 'authorized' },
      claims: { ...localClaims, tool: 'readBuyerOrder' },
    }), { status: 200 }));
    await expect(introspectMercariaCapabilityTicket('signed-ticket', localClaims)).resolves.toBe(false);
  });

  it('sends only the hashed idempotency key to Oxy audit persistence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await auditMercariaCapabilityTicket({
      ticket: 'signed-ticket',
      result: { status: 'succeeded' },
      rollbackSupported: false,
      idempotencyKeyHash: 'a'.repeat(64),
    });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(request.body as string)).toEqual({
      ticket: 'signed-ticket',
      result: { status: 'succeeded' },
      rollback: { supported: false, attempted: false },
      idempotencyKey: 'a'.repeat(64),
    });
  });
});
