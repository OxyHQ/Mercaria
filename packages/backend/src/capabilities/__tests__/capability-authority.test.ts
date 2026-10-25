import { generateKeyPairSync } from 'node:crypto';
import type { CapabilityTicketClaims } from '@oxy.so/contracts';
import { issueCapabilityTicket } from '@oxy.so/core/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ serviceRequest: vi.fn() }));

vi.mock('../oxy-service-client.js', () => ({
  requiredOxyServiceClient: () => ({ serviceRequest: mocks.serviceRequest }),
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
  mocks.serviceRequest.mockReset();
  resetMercariaCapabilityAuthorityForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Mercaria capability authority client', () => {
  it('verifies Ed25519 tickets against a cached Oxy JWKS', async () => {
    const key = signingKey('key-1');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 }));
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
    const fetchMock = vi
      .fn()
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
    mocks.serviceRequest.mockResolvedValue({
      active: true,
      decision: { allowed: true, reason: 'authorized' },
      claims: localClaims,
    });

    await expect(introspectMercariaCapabilityTicket('signed-ticket', localClaims)).resolves.toBe(
      true,
    );
    expect(mocks.serviceRequest).toHaveBeenCalledWith(
      'POST',
      '/capabilities/tickets/introspect',
      { ticket: 'signed-ticket' },
      { timeout: 10_000, cache: false },
    );
    mocks.serviceRequest.mockResolvedValueOnce({
      active: true,
      decision: { allowed: true, reason: 'authorized' },
      claims: { ...localClaims, tool: 'readBuyerOrder' },
    });
    await expect(introspectMercariaCapabilityTicket('signed-ticket', localClaims)).resolves.toBe(
      false,
    );
  });

  it('sends only the hashed idempotency key to Oxy audit persistence', async () => {
    mocks.serviceRequest.mockResolvedValue({});

    await auditMercariaCapabilityTicket({
      ticket: 'signed-ticket',
      result: { status: 'succeeded' },
      rollbackSupported: false,
      idempotencyKeyHash: 'a'.repeat(64),
    });

    expect(mocks.serviceRequest.mock.calls[0]?.[2]).toEqual({
      ticket: 'signed-ticket',
      result: { status: 'succeeded' },
      rollback: { supported: false, attempted: false },
      idempotencyKeyHash: 'a'.repeat(64),
    });
  });
});
