/**
 * The capability verifier is the SDK's (`createLiveCapabilityTicketVerifier` +
 * `createOxyJwksKeyResolver`), and these cases drive it for real — a ticket
 * signed with a generated Ed25519 key, Oxy's JWKS served from a stubbed
 * `fetch`, and Oxy's live introspection from a stubbed `oxyClient` — so what is
 * asserted is the composition Mercaria ships, not a mock of it.
 */

import { generateKeyPairSync } from 'node:crypto';
import type { CapabilityTicketClaims } from '@oxy.so/contracts';
import { CapabilityTicketError, issueCapabilityTicket } from '@oxy.so/core/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ serviceRequest: vi.fn(), introspect: vi.fn() }));

vi.mock('../../middleware/auth.js', () => ({
  oxyClient: {
    serviceRequest: mocks.serviceRequest,
    agency: { introspectCapabilityTicket: mocks.introspect },
  },
}));

const NOW = new Date('2026-08-01T10:00:00.000Z');

function signingKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'EdDSA' },
  };
}

const KEY = signingKey('key-1');

function unsignedClaims(): Parameters<typeof issueCapabilityTicket>[0] {
  return {
    aud: 'oxy-mercaria-api',
    sub: 'agent-account',
    runId: 'run-1',
    stepId: 'step-1',
    executionAuthorization: { kind: 'direct_request', id: 'authorization-1' },
    authority: 'first_party',
    coordinator: { applicationId: 'alia-app', credentialId: 'alia-credential' },
    catalog: { registrationId: 'registration-1', version: '1.0.0', digest: 'a'.repeat(64) },
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

function ticket(key = KEY): string {
  return issueCapabilityTicket(unsignedClaims(), {
    privateKey: key.privateKey,
    keyId: key.kid,
    issuer: 'https://api.oxy.so',
    now: NOW,
    ttlSeconds: 60,
    jti: 'ticket-1',
  });
}

/** The claims Oxy signed, as its introspection reports them. */
function signedClaims(): CapabilityTicketClaims {
  const iat = Math.floor(NOW.getTime() / 1_000);
  return {
    ...unsignedClaims(),
    iss: 'https://api.oxy.so',
    iat,
    exp: iat + 60,
    jti: 'ticket-1',
  } as CapabilityTicketClaims;
}

// Stubbed BEFORE the module is imported: the SDK's JWKS resolver takes the
// global `fetch` when it is built, which is once, at module load.
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify({ keys: [KEY.jwk] }), { status: 200 }),
  );
  mocks.serviceRequest.mockReset();
  mocks.introspect.mockReset();
  mocks.introspect.mockResolvedValue({
    active: true,
    decision: { allowed: true, reason: 'authorized' },
    claims: signedClaims(),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const {
  CapabilityTicketRevokedError,
  auditMercariaCapabilityTicket,
  verifyMercariaCapabilityTicket,
} = await import('../capability-authority.js');

describe('Mercaria capability verifier', () => {
  it('accepts a ticket Oxy signed and still stands behind, keyed from its JWKS', async () => {
    await expect(verifyMercariaCapabilityTicket(ticket())).resolves.toMatchObject({
      jti: 'ticket-1',
      tool: 'listBuyerOrders',
      aud: 'oxy-mercaria-api',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.oxy.so/capabilities/.well-known/jwks.json',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(mocks.introspect).toHaveBeenCalledWith(
      ticket(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    ['inactive', { active: false }],
    ['denied by policy', { active: true, decision: { allowed: false, reason: 'revoked' } }],
  ])('refuses a ticket Oxy answers %s as revoked', async (_case, answer) => {
    mocks.introspect.mockResolvedValueOnce({ ...answer, claims: signedClaims() });
    await expect(verifyMercariaCapabilityTicket(ticket())).rejects.toBeInstanceOf(
      CapabilityTicketRevokedError,
    );
  });

  it('refuses when Oxy disagrees with the signed claims, and not as a revocation', async () => {
    mocks.introspect.mockResolvedValueOnce({
      active: true,
      decision: { allowed: true, reason: 'authorized' },
      claims: { ...signedClaims(), tool: 'readBuyerOrder' },
    });
    const outcome = verifyMercariaCapabilityTicket(ticket());
    await expect(outcome).rejects.toThrow();
    await expect(outcome).rejects.not.toBeInstanceOf(CapabilityTicketRevokedError);
  });

  it('reports an Oxy outage as neither an invalid ticket nor a revocation', async () => {
    mocks.introspect.mockRejectedValueOnce(
      Object.assign(new Error('Bad Gateway'), { status: 502 }),
    );
    const outcome = verifyMercariaCapabilityTicket(ticket());
    await expect(outcome).rejects.toThrow('Bad Gateway');
    await expect(outcome).rejects.not.toBeInstanceOf(CapabilityTicketRevokedError);
    await expect(outcome).rejects.not.toBeInstanceOf(CapabilityTicketError);
  });

  it('refuses a ticket signed by a key Oxy does not publish, without asking Oxy', async () => {
    await expect(
      verifyMercariaCapabilityTicket(ticket(signingKey('rogue'))),
    ).rejects.toBeInstanceOf(CapabilityTicketError);
    expect(mocks.introspect).not.toHaveBeenCalled();
  });

  it('sends only the hashed idempotency key to Oxy audit persistence', async () => {
    mocks.serviceRequest.mockResolvedValue({});

    await auditMercariaCapabilityTicket({
      ticket: 'signed-ticket',
      result: { status: 'succeeded' },
      rollbackSupported: false,
      idempotencyKeyHash: 'a'.repeat(64),
    });

    expect(mocks.serviceRequest).toHaveBeenCalledWith(
      'POST',
      '/capabilities/audit',
      {
        ticket: 'signed-ticket',
        result: { status: 'succeeded' },
        rollback: { supported: false, attempted: false },
        idempotencyKeyHash: 'a'.repeat(64),
      },
      { timeout: 10_000, cache: false },
    );
  });
});
