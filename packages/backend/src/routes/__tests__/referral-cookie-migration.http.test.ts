import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  referrals: { stateSecret: 'migration-test-secret' as string | undefined },
}));
vi.mock('../../config/index.js', () => ({ config: fixture }));

import router, {
  REFERRAL_COOKIE_CUTOFF,
  REFERRAL_COOKIE_DEADLINE,
} from '../referral-cookie-migration.js';
import { mintReferralState, verifyReferralState } from '../../services/referrals/referral-state.js';

const server = express().use(express.json()).use('/referrals', router).listen(0, '127.0.0.1');
let baseURL: string;
beforeAll(async () => {
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/referrals`;
});
beforeEach(() => {
  fixture.referrals.stateSecret = 'migration-test-secret';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(REFERRAL_COOKIE_CUTOFF + 1000);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function mint(at = REFERRAL_COOKIE_CUTOFF, lifetime = 90 * 24 * 60 * 60): string {
  return mintReferralState({
    linkId: 'link',
    codeId: 'code',
    clickedAt: new Date(at),
    lifetimeSeconds: lifetime,
  }).token;
}

function exchange(
  token: string,
  extra: Record<string, string> = {},
  path = 'legacy-cookie-exchange',
) {
  return fetch(`${baseURL}/${path}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      origin: 'https://mercaria.co',
      'content-type': 'application/json',
      'x-mercaria-referral-migration': 'header-v1',
      cookie: `mercaria_referral_dev=${encodeURIComponent(token)}`,
      ...extra,
    },
    body: '{}',
  });
}

it('transfers identical signed bytes and expiry after lost responses or concurrent retries, without renewing or clearing', async () => {
  const token = mint();
  const before = verifyReferralState(token, new Date());
  const responses = await Promise.all([exchange(token), exchange(token)]);
  for (const response of responses) {
    expect(response.status).toBe(204);
    expect(response.headers.get('x-mercaria-referral-state')).toBe(token);
    expect(response.headers.get('x-mercaria-referral-expires-at')).toBe(
      new Date(REFERRAL_COOKIE_DEADLINE).toISOString(),
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await response.text()).toBe('');
  }
  expect(verifyReferralState(token, new Date())).toEqual(before);
});

it('cannot substitute cookie A for explicit header B, even if B is malformed', async () => {
  const token = mint();
  for (const presented of ['invalid', mint(REFERRAL_COOKIE_CUTOFF - 1000)]) {
    const res = await exchange(token, { 'x-mercaria-referral-state': presented });
    expect(res.status).toBe(204);
    expect(res.headers.get('x-mercaria-referral-state')).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
  }
});

it('ACK expires only the exact carrier confirmed persisted, without deleting a different tab’s cookie', async () => {
  const a = mint();
  const b = mint();
  const stale = await exchange(b, { 'x-mercaria-referral-state': a }, 'legacy-cookie-ack');
  expect(stale.status).toBe(409);
  expect(stale.headers.getSetCookie()).toEqual([]);
  const ack = await exchange(a, { 'x-mercaria-referral-state': a }, 'legacy-cookie-ack');
  expect(ack.status).toBe(204);
  expect(ack.headers.getSetCookie()).toHaveLength(1);
  expect(ack.headers.getSetCookie()[0]).toContain('Expires=Thu, 01 Jan 1970');
  expect(ack.headers.getSetCookie()[0]).not.toContain(a);
  expect(ack.headers.get('x-mercaria-referral-state')).toBeNull();
});

it('requires exact Origin and the preflight marker, without accepting Referer as a substitute', async () => {
  for (const extra of [
    { origin: 'null' },
    { origin: 'https://mercaria.co.evil.example' },
    { origin: '', referer: 'https://mercaria.co/' },
    { 'x-mercaria-referral-migration': '' },
    { 'content-type': 'text/plain' },
  ]) {
    const res = await exchange(mint(), extra);
    expect(res.status).toBe(403);
    expect(res.headers.get('x-mercaria-referral-state')).toBeNull();
  }
});

it('has a fixed issuance cutoff and deadline, not a sliding migration window', async () => {
  expect((await exchange(mint())).headers.get('x-mercaria-referral-state')).not.toBeNull();
  expect(
    (await exchange(mint(REFERRAL_COOKIE_CUTOFF + 1000))).headers.get('x-mercaria-referral-state'),
  ).toBeNull();
  vi.setSystemTime(REFERRAL_COOKIE_DEADLINE);
  expect((await exchange(mint())).status).toBe(410);
});

it('refuses expired state and missing signing keys uniformly without leaking configuration or minting a substitute', async () => {
  const valid = mint();
  const expired = mint(REFERRAL_COOKIE_CUTOFF - 2000, 1);
  const invalid = await exchange(expired);
  fixture.referrals.stateSecret = undefined;
  const missingKey = await exchange(valid);
  expect(missingKey.status).toBe(invalid.status);
  expect(missingKey.headers.get('x-mercaria-referral-state')).toBeNull();
  expect(missingKey.headers.getSetCookie()).toEqual([]);
  expect(await missingKey.text()).toBe(await invalid.text());
});
