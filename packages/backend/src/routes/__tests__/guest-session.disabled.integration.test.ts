/**
 * The UNCONFIGURED deployment (#103, ADR 0003 M8): `GUEST_COMMERCE_ENABLED`
 * unset — which is production's state until the M8 security review clears.
 *
 * The `/guest/session` mount is gated like the Stripe webhook mount and for
 * the same reason: 404 is the truthful answer from a deployment that will
 * never honour the credential, and it advertises no surface to probe. The
 * half-configuration rule (enabled without the two M8 keys stays OFF) is
 * pinned here too, because this is the one place a misconfigured deployment's
 * actual wire behaviour is observable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

let baseUrl: string;
const servers: Server[] = [];
let closePostgres: typeof import('../../db/postgres.js').closePostgres;

beforeAll(async () => {
  // ENABLED, but missing both M8 keys: the half-configuration rule must
  // resolve this to OFF — the same deployment shape as fully unset.
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  delete process.env.GUEST_PII_ENCRYPTION_KEY;
  delete process.env.GUEST_EMAIL_HASH_KEY;

  const { createApp } = await import('../../app.js');
  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  await postgres.connectPostgres();

  const server = createApp().listen(0);
  servers.push(server);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await closePostgres();
});

describe('GUEST_COMMERCE_ENABLED without the M8 keys — half-configured stays OFF', () => {
  it('does not mount the surface at all: every guest-session path answers 404', async () => {
    const ensure = await fetch(`${baseUrl}/guest/session`, {
      method: 'POST',
      headers: { origin: 'https://mercaria.co' },
    });
    expect(ensure.status).toBe(404);
    expect(ensure.headers.getSetCookie()).toHaveLength(0);

    const inspect = await fetch(`${baseUrl}/guest/session`);
    expect(inspect.status).toBe(404);
  });

  it('keeps the rest of the API serving — the flag turns off guests, not commerce', async () => {
    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(200);
  });
});
