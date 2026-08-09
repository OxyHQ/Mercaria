/**
 * The guest ISSUANCE KILL SWITCH deployment (#103, ADR 0003 M8): guest
 * commerce ON, `GUEST_SESSION_ISSUANCE_ENABLED=false`.
 *
 * Its own file because a process has ONE frozen config: the main integration
 * file runs the fully-enabled deployment, `guest-session.disabled` the
 * unconfigured one, and this one the incident lever — new sessions refused
 * while everything already issued keeps working. The "existing sessions keep
 * resolving" half cannot be shown here (nothing can be issued to keep
 * working), so it is stated by the service split itself: the kill switch is
 * read ONLY by `issueGuestSession`, never by the resolver — pinned below by
 * the resolver still answering its ordinary 404/401, not a 503.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

let baseUrl: string;
const servers: Server[] = [];
let closePostgres: typeof import('../../db/postgres.js').closePostgres;

beforeAll(async () => {
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'kill-switch-test-pii-key';
  process.env.GUEST_EMAIL_HASH_KEY = 'kill-switch-test-email-hash-key';
  process.env.GUEST_SESSION_ISSUANCE_ENABLED = 'false';

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

describe('GUEST_SESSION_ISSUANCE_ENABLED=false', () => {
  it('refuses NEW issuance with 503 GUEST_ISSUANCE_DISABLED and sets no credential', async () => {
    const res = await fetch(`${baseUrl}/guest/session`, {
      method: 'POST',
      headers: { origin: 'https://mercaria.co' },
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('GUEST_ISSUANCE_DISABLED');
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(res.headers.get('x-mercaria-guest-token')).toBeNull();
  });

  it('leaves the REST of the surface mounted and resolving — only minting is stopped', async () => {
    // The resolver path answers its ordinary answers, not 503: absent → 404,
    // invalid → 401. A kill switch that broke resolution would log every
    // guest out to stop a farmer, which is exactly what M8's two-lever split
    // exists to avoid.
    const inspect = await fetch(`${baseUrl}/guest/session`);
    expect(inspect.status).toBe(404);

    const invalid = await fetch(`${baseUrl}/guest/session`, {
      headers: { 'x-mercaria-guest-token': `mgs_${'A'.repeat(43)}` },
    });
    expect(invalid.status).toBe(401);

    const revoke = await fetch(`${baseUrl}/guest/session`, {
      method: 'DELETE',
      headers: { origin: 'https://mercaria.co' },
    });
    expect(revoke.status).toBe(204);
  });
});
