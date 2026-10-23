import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { OxyServer, type OxyAuthRequest } from '@oxy.so/core/server';
import { createMercariaClient } from '@mercaria.co/sdk';
import { mercariaForOxyService, MERCARIA_SERVICE_AUDIENCE } from '@mercaria.co/sdk/server';

const seen = vi.hoisted(() => ({ principals: [] as unknown[], redirect: '' }));
// Business projections are covered by public-api-sdk-contract.realdb.test.ts.
// This suite keeps the actual router, shared auth, limiter, transport and HTTP.
vi.mock('../../controllers/public-api.controller.js', () => ({
  publicApiRoute: () => (req: OxyAuthRequest, res: express.Response) => {
    seen.principals.push({ user: req.user, app: req.serviceApp });
    if (req.query.q === 'redirect') return res.redirect(seen.redirect);
    res.json({ items: [], nextCursor: null });
  },
  sendPublicError: (_res: unknown) => undefined,
}));
vi.mock('@oxy.so/core/server/aws', () => ({
  createAwsWorkloadCredentialProvider: () => async () => ({
    AccessKeyId: 'ASIA_TEST',
    SecretAccessKey: 'test-only',
    Token: 'temporary-test',
  }),
}));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const expiry = Math.floor(Date.now() / 1000) + 300;
const base = {
  type: 'service',
  appId: 'clarity',
  appName: 'Clarity',
  credentialId: 'wl_clarity',
  ownerAccountId: 'project-owner',
  environment: 'production',
  tier: 'internal',
  iss: 'oxy-auth',
  iat: expiry - 300,
  exp: expiry,
};
function jwt(claims: Record<string, unknown>) {
  const body = `${Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'fixture', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
}
function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}
async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
let authority: Awaited<ReturnType<typeof listen>>;
let recipient: Awaited<ReturnType<typeof listen>>;
let leak: Awaited<ReturnType<typeof listen>>;
let caller: OxyServer;
let receiver: OxyServer;
let active = true;
let foreignCalls = 0;
const mints: Array<Record<string, unknown>> = [];
const own = () => jwt({ ...base, authority: 'first_party', aud: MERCARIA_SERVICE_AUDIENCE });
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.get('/.well-known/jwks.json', (_req, res) =>
    res.json({
      keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'EdDSA', use: 'sig' }],
    }),
  );
  app.post('/auth/service-token/workload/challenge', (_req, res) => res.json({ nonce: 'fixture' }));
  app.post('/auth/service-token/workload', (req, res) => {
    mints.push(req.body);
    res.json({
      token: jwt({ ...base, authority: 'first_party', aud: req.body.audience }),
      expiresIn: 300,
    });
  });
  app.post('/auth/resources/introspect', (req, res) => {
    const value = decode(req.body.token);
    res.json(
      active
        ? {
            active: true,
            authority: value.authority,
            applicationId: value.appId,
            credentialId: value.credentialId,
            accountId: value.ownerAccountId,
            environment: value.environment,
            audience: value.aud,
            expiresAt: new Date(expiry * 1000).toISOString(),
            ...(value.authority === 'external' ? { scopes: ['catalog:read'] } : {}),
          }
        : { active: false },
    );
  });
  app.use((_req, res) => res.status(403).json({ authorized: false }));
  authority = await listen(app);
  vi.stubEnv('OXY_API_URL', authority.url);
  const auth = await import('../auth.js');
  receiver = auth.oxyClient;
  const { makeRateLimiter } = await import('../../lib/rate-limit.js');
  const router = (await import('../../routes/public-api.js')).default;
  const target = express();
  target.use(makeRateLimiter('general'));
  target.use('/public/v1', router);
  recipient = await listen(target);
  const foreign = express();
  foreign.use((_req, res) => {
    foreignCalls++;
    res.json({ items: [], nextCursor: null });
  });
  leak = await listen(foreign);
  seen.redirect = leak.url;
  caller = new OxyServer({
    baseURL: authority.url,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIA_TEST',
      SecretAccessKey: 'test-only',
      Token: 'temporary-test',
    }),
  });
});
beforeEach(() => {
  active = true;
  seen.principals.length = 0;
  foreignCalls = 0;
});
afterAll(async () => {
  caller?.dispose();
  receiver?.dispose();
  vi.unstubAllEnvs();
  for (const fixture of [recipient, authority, leak]) {
    fixture?.server.closeAllConnections();
    if (fixture) await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});
describe('Mercaria public workload boundary', () => {
  it('composes the SDK with real mint and verified receiver without inventing a user', async () => {
    const client = mercariaForOxyService(caller, { apiBaseUrl: recipient.url });
    expect(await client.products.search()).toEqual({ items: [], nextCursor: null });
    expect(seen.principals.at(-1)).toMatchObject({
      user: null,
      app: { authority: 'first_party', appId: 'clarity' },
    });
    expect(mints).toContainEqual(
      expect.objectContaining({ protocolVersion: 2, audience: MERCARIA_SERVICE_AUDIENCE }),
    );
    expect(mints.every((mint) => !('scopes' in mint))).toBe(true);
    active = false;
    await expect(client.products.search()).rejects.toMatchObject({ status: 401 });
    client.dispose();
  });
  it('preserves external service identity and anonymous payloads, ignoring branding as authority', async () => {
    const token = jwt({
      ...base,
      credentialId: 'customer-key',
      authority: 'external',
      aud: 'oxy-api',
      scopes: ['catalog:read', 'stale:permission'],
    });
    const external = createMercariaClient({
      apiBaseUrl: recipient.url,
      getAccessToken: () => token,
    });
    expect(await external.products.search()).toEqual({ items: [], nextCursor: null });
    expect(seen.principals.at(-1)).toMatchObject({
      user: null,
      app: { authority: 'external', tier: 'external', scopes: ['catalog:read'] },
    });
    const anonymous = createMercariaClient({ apiBaseUrl: recipient.url });
    expect(await anonymous.products.search()).toEqual({ items: [], nextCursor: null });
  });
  it('rejects wrong recipients and unproved accounts, and never forwards authority on redirect', async () => {
    const wrong = jwt({ ...base, authority: 'first_party', aud: 'oxy-service:other' });
    expect(
      (
        await fetch(`${recipient.url}/public/v1/products`, {
          headers: { Authorization: `Bearer ${wrong}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${recipient.url}/public/v1/products`, {
          headers: { Authorization: `Bearer ${own()}`, 'X-Oxy-User-Id': 'another-account' },
        })
      ).status,
    ).toBe(403);
    const client = mercariaForOxyService(caller, { apiBaseUrl: recipient.url });
    await expect(client.products.search({ query: 'redirect' })).rejects.toThrow();
    expect(foreignCalls).toBe(0);
    client.dispose();
  });
});
