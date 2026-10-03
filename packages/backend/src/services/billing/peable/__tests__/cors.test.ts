import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Server } from 'node:http';
let server: Server, base: string;
beforeAll(async () => {
  const { createApp } = await import('../../../../app.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
it('actual browser preflight permits the stable billing intent header on an approved origin', async () => {
  const response = await fetch(`${base}/admin/stores/fixture/plan/checkout`, { method: 'OPTIONS', headers: { Origin: 'https://dashboard.mercaria.co', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('access-control-allow-origin')).toBe('https://dashboard.mercaria.co');
  expect(response.headers.get('access-control-allow-headers')?.toLowerCase().split(',').map(v => v.trim())).toContain('idempotency-key');
});
