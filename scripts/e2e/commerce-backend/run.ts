import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const DEFAULT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const REVIEWED_SOURCE_FILES = [
  'packages/backend/src/app.ts',
  'packages/backend/src/routes/referral-cookie-migration.ts',
  'packages/backend/src/middleware/commerce-transport.ts',
  'packages/backend/src/middleware/commerce-actor.ts',
  'packages/backend/src/middleware/guest-portal.ts',
  'packages/backend/src/services/referrals/referral-state.ts',
  'packages/backend/src/lib/allowed-origins.ts',
];

/** Runs only against a throwaway DB; the real app, CORS and rate limiter are unchanged. */
export async function runCommerceBrowserGate(tree = DEFAULT_ROOT): Promise<void> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) throw new Error('TEST_DATABASE_URL is required; no developer database fallback');
  const output = join(tree, 'test-results/commerce-backend');
  mkdirSync(output, { recursive: true });
  const sourceHashes = () =>
    Object.fromEntries(
      REVIEWED_SOURCE_FILES.map((path) => [
        path,
        createHash('sha256')
          .update(readFileSync(join(tree, path)))
          .digest('hex'),
      ]),
    );
  const sourcesBefore = sourceHashes();
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: tree,
    encoding: 'utf8',
  }).trim();
  const servers: Server[] = [];
  const requests: {
    method: string | undefined;
    path: string | undefined;
    status?: number;
    acac?: string | number | string[] | null;
    rateLimit?: string | number | string[] | null;
  }[] = [];
  const checks: string[] = [];
  const pageServer = () =>
    createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Local synthetic commerce review</title>');
    });
  async function listen(server: Server) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://localhost:${(server.address() as import('node:net').AddressInfo).port}`;
  }
  let databaseUrl: string | undefined;
  let browser: Browser | undefined;
  let closePostgres: (() => Promise<void>) | undefined;
  let cleanup: ((url: string) => Promise<void>) | undefined;
  try {
    const trusted = await listen(pageServer());
    const foreign = await listen(pageServer());
    Object.assign(process.env, {
      NODE_ENV: 'test',
      WEB_URL: trusted,
      REDIS_URL: '',
      OXY_APPLICATION_KEY: '',
      OXY_APPLICATION_SECRET: '',
      GUEST_COMMERCE_ENABLED: 'true',
      GUEST_SESSION_ISSUANCE_ENABLED: 'true',
      GUEST_PII_ENCRYPTION_KEY: 'synthetic-review-only',
      GUEST_EMAIL_HASH_KEY: 'synthetic-review-only',
      REFERRALS_ENABLED: 'false',
      REFERRAL_STATE_SECRET: 'synthetic-review-only',
      PG_MAX_POOL_SIZE: '2',
    });
    const db = await import(`${tree}/packages/backend/src/db/testDatabase.ts`);
    cleanup = db.dropMercariaTestDatabase;
    databaseUrl = await db.createMercariaTestDatabase(adminUrl);
    process.env.DATABASE_URL = databaseUrl;
    const pg = await import(`${tree}/packages/backend/src/db/postgres.ts`);
    closePostgres = pg.closePostgres;
    await pg.connectPostgres();
    const { createApp } = await import(`${tree}/packages/backend/src/app.ts`);
    const { mintReferralState } = await import(
      `${tree}/packages/backend/src/services/referrals/referral-state.ts`
    );
    const { REFERRAL_COOKIE_CUTOFF } = await import(
      `${tree}/packages/backend/src/routes/referral-cookie-migration.ts`
    );
    const app = createApp();
    const api = await listen(
      createServer((req, res) => {
        const entry: (typeof requests)[number] = { method: req.method, path: req.url };
        res.once('finish', () => {
          entry.status = res.statusCode;
          entry.acac = res.getHeader('access-control-allow-credentials') ?? null;
          entry.rateLimit = res.getHeader('ratelimit') ?? res.getHeader('ratelimit-limit') ?? null;
          requests.push(entry);
        });
        app(req, res);
      }),
    );
    const token = mintReferralState({
      linkId: 'synthetic-link',
      codeId: 'synthetic-code',
      clickedAt: new Date(REFERRAL_COOKIE_CUTOFF),
      lifetimeSeconds: 90 * 24 * 60 * 60,
    }).token;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(trusted);
    await context.addCookies([
      {
        name: 'mercaria_referral_dev',
        value: encodeURIComponent(token),
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const call = async (path: string, mode: 'include' | 'omit' = 'include', header?: string) =>
      page.evaluate(
        async ({ api, path, mode, header }) => {
          try {
            const response = await fetch(api + path, {
              method: 'POST',
              credentials: mode,
              redirect: 'error',
              cache: 'no-store',
              headers: {
                'Content-Type': 'application/json',
                'X-Mercaria-Referral-Migration': 'header-v1',
                ...(header ? { 'X-Mercaria-Referral-State': header } : {}),
              },
              body: '{}',
            });
            return {
              status: response.status,
              token: response.headers.get('X-Mercaria-Referral-State'),
              expiry: response.headers.get('X-Mercaria-Referral-Expires-At'),
              cache: response.headers.get('cache-control'),
            };
          } catch (error) {
            return { error: (error as Error).name };
          }
        },
        { api, path, mode, header },
      );
    for (let i = 0; i < 2; i++) {
      const response = await call('/referrals/legacy-cookie-exchange');
      assert.equal(response.status, 204);
      assert.equal(response.token, token);
      assert.ok(response.expiry);
      assert.equal(response.cache, 'no-store');
    }
    assert.ok((await context.cookies(api)).some((c) => c.name === 'mercaria_referral_dev'));
    checks.push(
      'trusted browser preflight+exchange succeeds; original carrier survives lost response/retry',
    );
    assert.ok(
      requests.some(
        (r) =>
          r.method === 'OPTIONS' &&
          r.path === '/referrals/legacy-cookie-exchange' &&
          r.acac === 'true',
      ),
    );
    assert.ok(
      requests.some(
        (r) => r.method === 'POST' && r.path === '/referrals/legacy-cookie-exchange' && r.rateLimit,
      ),
    );
    checks.push('actual createApp CORS and general rate limiter exercised');
    const overridden = await call(
      '/referrals/legacy-cookie-exchange',
      'include',
      'malformed-explicit',
    );
    assert.equal(overridden.status, 204);
    assert.equal(overridden.token, null);
    checks.push('explicit header never falls back to cookie');
    await page.evaluate((t) => localStorage.setItem('synthetic.persisted.referral', t), token);
    assert.equal(
      await page.evaluate(() => localStorage.getItem('synthetic.persisted.referral')),
      token,
    );
    const ack = await call('/referrals/legacy-cookie-ack', 'include', token);
    assert.equal(ack.status, 204);
    assert.ok(!(await context.cookies(api)).some((c) => c.name === 'mercaria_referral_dev'));
    checks.push('ACK after durable browser storage removes exact HttpOnly cookie');
    await context.addCookies([
      {
        name: 'mercaria_guest_dev',
        value: 'mgs_synthetic-stale-token',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const legacy = await page.evaluate(async (api) => {
      try {
        const r = await fetch(`${api}/guest/session`, { credentials: 'include' });
        return { status: r.status };
      } catch (e) {
        return { error: (e as Error).name };
      }
    }, api);
    assert.equal(legacy.error, 'TypeError');
    assert.ok(
      requests.some((r) => r.path === '/guest/session' && r.status === 426 && r.acac === null),
    );
    checks.push(
      'old credentialed browser sees CORS failure; server safely returns426 without ordinary ACAC',
    );
    const modern = await page.evaluate(async (api) => {
      const r = await fetch(`${api}/guest/session`, { credentials: 'omit' });
      return r.status;
    }, api);
    assert.equal(modern, 404);
    checks.push('ordinary omit read succeeds anonymously without ambient cookie owner');
    const foreignPage = await context.newPage();
    await foreignPage.goto(foreign);
    const before = requests.filter(
      (r) => r.method === 'POST' && r.path === '/referrals/legacy-cookie-exchange',
    ).length;
    const denied = await foreignPage.evaluate(async (api) => {
      try {
        await fetch(`${api}/referrals/legacy-cookie-exchange`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Mercaria-Referral-Migration': 'header-v1',
          },
          body: '{}',
        });
        return 'unexpected';
      } catch (e) {
        return (e as Error).name;
      }
    }, api);
    assert.equal(denied, 'TypeError');
    assert.equal(
      requests.filter((r) => r.method === 'POST' && r.path === '/referrals/legacy-cookie-exchange')
        .length,
      before,
    );
    checks.push('foreign-origin browser denied at preflight; POST never dispatched');
    const off = await page.evaluate(async (api) => {
      const r = await fetch(`${api}/referrals/state`, { credentials: 'omit' });
      return r.status;
    }, api);
    assert.equal(off, 404);
    checks.push('referral feature remains disabled despite migration route');
    assert.deepEqual(
      sourceHashes(),
      sourcesBefore,
      'Reviewed source changed during the browser gate',
    );
    writeFileSync(
      `${output}/receipt.json`,
      `${JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          sourceCommit,
          sourceFiles: sourcesBefore,
          browserVersion: browser.version(),
          checks,
          requests,
          syntheticOnly: true,
          productionAccess: false,
        },
        null,
        2,
      )}\n`,
    );
    console.log(JSON.stringify({ success: true, checks }));
  } catch (error) {
    writeFileSync(
      `${output}/failure.json`,
      `${JSON.stringify(
        { observedAt: new Date().toISOString(), checks, requests, error: String(error) },
        null,
        2,
      )}\n`,
    );
    throw error;
  } finally {
    await browser?.close();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await closePostgres?.();
    if (databaseUrl && cleanup) await cleanup(databaseUrl);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCommerceBrowserGate();
}
