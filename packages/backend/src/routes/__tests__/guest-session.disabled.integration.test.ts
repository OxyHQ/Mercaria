/**
 * The UNCONFIGURED deployment (#103, ADR 0003 M8): neither M8 key resolves.
 * Guest commerce has no switch — it is on exactly when
 * `GUEST_PII_ENCRYPTION_KEY` and `GUEST_EMAIL_HASH_KEY` both resolve — so this
 * is the only way a deployment is without it.
 *
 * The `/guest/session` mount is gated like the Stripe webhook mount and for
 * the same reason: 404 is the truthful answer from a deployment that will
 * never honour the credential, and it advertises no surface to probe. Pinned
 * here because this is the one place an unconfigured deployment's actual wire
 * behaviour is observable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

let baseUrl: string;
const servers: Server[] = [];
let closePostgres: typeof import('../../db/postgres.js').closePostgres;

beforeAll(async () => {
  // Missing both M8 keys: guest commerce must resolve OFF.
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

describe('guest commerce without the M8 keys stays OFF', () => {
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

  it('keeps the rest of the API serving — no keys turns off guests, not commerce', async () => {
    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(200);
  });
});
