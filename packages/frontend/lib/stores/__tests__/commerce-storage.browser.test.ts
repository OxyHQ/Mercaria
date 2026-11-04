import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { expect, test } from 'vitest';
import type { createCommerceCredential } from '../commerce-credential';
import type { captureReferralFragment } from '../referral-credential-store';
import type { migrateLegacyReferral } from '../../api/referral-migration';

type Credential = ReturnType<typeof createCommerceCredential>;
declare global {
  interface Window {
    probe: {
      credential: Credential;
      referral: Credential;
      migrateLegacyReferral: typeof migrateLegacyReferral;
      captureReferralFragment: typeof captureReferralFragment;
      postCart: (origin: string) => Promise<{ owner: string }>;
      old: ReturnType<Credential['snapshot']>;
      block: (event: Event) => void;
    };
  }
}

// The real browser executes the actual storage/bridge modules, not a DOM emulation.
test('browser tabs fence rotation/revocation, scrub fragments and preserve referral until durable ACK', async () => {
  const bundle = await build({
    stdin: {
      contents: `
    import {createCommerceCredential,webCredentialStorage} from './lib/stores/commerce-credential';
    import {captureReferralFragment} from './lib/stores/referral-credential-store';
    import {migrateLegacyReferral} from './lib/api/referral-migration';
    import {createCommerceCredentials} from './lib/api/commerce-credentials';
    import {createCommerceTransport} from './lib/api/commerce-transport';
    import {OxyServices} from '@oxy.so/core';
    const credential=createCommerceCredential(webCredentialStorage('browser-guest'));
    const referral=createCommerceCredential(webCredentialStorage('browser-referral'),Date.now,true);
    const first=createCommerceCredential(webCredentialStorage('first-cart'));
    const portal=createCommerceCredential(webCredentialStorage('first-portal'));
    const oxy=new OxyServices({baseURL:location.origin});
    const postCart=async(origin)=>{
      const transport=createCommerceTransport(oxy,origin,createCommerceCredentials(oxy,{guestCredential:first,portalCredential:portal,referralCredential:referral},'web'));
      try { const response=await transport.fetch(origin+'/cart/items',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}}); return await response.json(); }
      finally { transport.dispose(); }
    };
    window.probe={credential,referral,migrateLegacyReferral,captureReferralFragment,postCart};
  `,
      resolveDir: resolve('.'),
      loader: 'ts',
    },
    bundle: true,
    platform: 'browser',
    // The protocol fallback dynamically imports Node crypto only without Web Crypto.
    // Chromium uses its real Web Crypto implementation; leave the Node-only branch external.
    external: ['node:crypto'],
    format: 'iife',
    write: false,
  });
  const script = bundle.outputFiles[0].text;
  const t = Math.floor(Date.parse('2026-10-25T15:00:46Z') / 1000) - 60;
  const carrier = `mrf_${Buffer.from(JSON.stringify({ t, x: t + 86400 })).toString('base64url')}.signed`;
  const expires = new Date((t + 86400) * 1000).toISOString();
  let appOrigin = '';
  let exchanges = 0;
  let acks = 0;
  let guestIssuances = 0;
  const seen: Array<{ origin?: string; cookie?: string; authorization?: string }> = [];
  const api = createServer((req, res) => {
    if (req.headers.origin === appOrigin) {
      res.setHeader('Access-Control-Allow-Origin', appOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'X-Oxy-Activity-Id, Content-Type, X-Mercaria-Referral-Migration, X-Mercaria-Referral-State, X-Mercaria-Guest-Token, X-Mercaria-Guest-Transport, X-Mercaria-Portal-Transport, X-Mercaria-Guest-Client',
      );
      res.setHeader(
        'Access-Control-Expose-Headers',
        'X-Mercaria-Referral-State, X-Mercaria-Referral-Expires-At, X-Mercaria-Guest-Token, X-Mercaria-Guest-Expires-At, X-Mercaria-Guest-Generation',
      );
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    seen.push({
      origin: req.headers.origin,
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
    });
    if (req.url === '/cart/items') {
      expect(req.headers.cookie).toBeUndefined();
      const existing = req.headers['x-mercaria-guest-token'];
      const owner = existing ?? `mgs_owner_${++guestIssuances}`;
      if (!existing) {
        res.setHeader('X-Mercaria-Guest-Token', String(owner));
        res.setHeader('X-Mercaria-Guest-Expires-At', expires);
        res.setHeader('X-Mercaria-Guest-Generation', '1');
      }
      res.setHeader('Content-Type', 'application/json');
      setTimeout(() => res.writeHead(200).end(JSON.stringify({ owner })), 10);
      return;
    }
    if (req.url?.endsWith('exchange')) {
      exchanges++;
      res.setHeader('X-Mercaria-Referral-State', carrier);
      res.setHeader('X-Mercaria-Referral-Expires-At', expires);
    }
    if (req.url?.endsWith('ack')) {
      acks++;
      expect(req.headers['x-mercaria-referral-state']).toBe(carrier);
      res.setHeader('Set-Cookie', 'legacy-referral=; Max-Age=0; HttpOnly; Path=/; SameSite=Lax');
    }
    res.writeHead(204).end();
  });
  const app = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/fixture.js' ? script : '<script src="/fixture.js"></script>');
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const apiOrigin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  appOrigin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    await context.addCookies([
      { name: 'legacy-referral', value: carrier, url: apiOrigin, httpOnly: true, sameSite: 'Lax' },
    ]);
    const a = await context.newPage();
    const b = await context.newPage();
    await a.clock.setFixedTime(new Date('2026-10-25T15:01:00Z'));
    await b.clock.setFixedTime(new Date('2026-10-25T15:01:00Z'));
    await a.goto(appOrigin);
    await b.goto(appOrigin);
    const owners = await Promise.all([
      a.evaluate((origin) => window.probe.postCart(origin), apiOrigin),
      b.evaluate((origin) => window.probe.postCart(origin), apiOrigin),
    ]);
    expect(guestIssuances).toBe(1);
    expect(owners).toEqual([{ owner: 'mgs_owner_1' }, { owner: 'mgs_owner_1' }]);
    const expiry = new Date(Date.now() + 86400000).toISOString();
    await a.evaluate(
      async ({ expiry }) => {
        const p = window.probe;
        await p.credential.ready;
        p.credential.snapshot().accept('mgs_first', expiry, '1');
        await p.credential.settled();
      },
      { expiry },
    );
    await b.waitForFunction(() => window.probe.credential.current().token === 'mgs_first');
    // Model an old response racing BEFORE the other tab's storage event arrives.
    await b.evaluate(() => {
      const p = window.probe;
      p.old = p.credential.snapshot();
      p.block = (event: Event) => event.stopImmediatePropagation();
      window.addEventListener('storage', p.block, true);
    });
    await a.evaluate(async () => {
      const p = window.probe;
      p.credential.clear();
      await p.credential.settled();
    });
    await b.evaluate(
      async ({ expiry }) => {
        const p = window.probe;
        p.old.accept('mgs_late', expiry, '2');
        await p.credential.settled();
        window.removeEventListener('storage', p.block, true);
      },
      { expiry },
    );
    expect(await b.evaluate(() => localStorage.getItem('browser-guest'))).toBeNull();
    expect(await b.evaluate(() => window.probe.credential.current().token)).toBeNull();
    // Successful exchange persists the SAME signed carrier before ACK deletes the cookie.
    await a.evaluate(async (apiOrigin) => {
      const p = window.probe;
      await p.migrateLegacyReferral(apiOrigin, p.referral);
    }, apiOrigin);
    expect(exchanges).toBe(1);
    expect(acks).toBe(1);
    expect(
      await a.evaluate(() => JSON.parse(localStorage.getItem('browser-referral') ?? 'null').token),
    ).toBe(carrier);
    expect((await context.cookies()).find((c) => c.name === 'legacy-referral')).toBeUndefined();
    expect(seen.every((x) => x.authorization === undefined)).toBe(true);
    // A failed durable write never ACKs; the original cookie survives for retry.
    await context.addCookies([
      { name: 'legacy-referral', value: carrier, url: apiOrigin, httpOnly: true, sameSite: 'Lax' },
    ]);
    await a.evaluate(() => localStorage.removeItem('browser-referral'));
    await a.reload();
    await a.evaluate(async (apiOrigin) => {
      const p = window.probe;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'browser-referral') throw new Error('denied');
        return original.call(this, key, value);
      };
      try {
        await p.migrateLegacyReferral(apiOrigin, p.referral);
      } finally {
        Storage.prototype.setItem = original;
      }
    }, apiOrigin);
    expect(acks).toBe(1);
    expect((await context.cookies()).find((c) => c.name === 'legacy-referral')?.value).toBe(
      carrier,
    );
    // Persist succeeds but ACK is lost: the original cookie must still not resurrect
    // attribution after an ordinary redemption/consent-denied clear.
    await a.evaluate(() => localStorage.removeItem('browser-referral'));
    await a.reload();
    await expect(
      a.evaluate(async (apiOrigin) => {
        const p = window.probe;
        await p.migrateLegacyReferral(apiOrigin, p.referral, async (input, init) => {
          if (String(input).endsWith('ack')) throw new TypeError('ACK network lost');
          return fetch(input, init);
        });
      }, apiOrigin),
    ).rejects.toThrow('ACK network lost');
    expect(
      await a.evaluate(() => JSON.parse(localStorage.getItem('browser-referral') ?? 'null').token),
    ).toBe(carrier);
    expect((await context.cookies()).find((c) => c.name === 'legacy-referral')?.value).toBe(
      carrier,
    );
    await a.evaluate(async () => {
      const p = window.probe;
      p.referral.clear();
      await p.referral.settled();
    });
    await a.reload();
    const before = exchanges;
    await a.evaluate(async (apiOrigin) => {
      const p = window.probe;
      await p.migrateLegacyReferral(apiOrigin, p.referral);
    }, apiOrigin);
    expect(exchanges).toBe(before);
    // A genuine new click can replace the clear marker; it is not a global opt-out.
    await a.evaluate(
      async ({ carrier }) => {
        const p = window.probe;
        p.captureReferralFragment(
          { hash: `#mercaria-referral=${encodeURIComponent(carrier)}`, pathname: '/', search: '' },
          { state: null, replaceState: () => {} },
          (token, expiry, generation) => p.referral.snapshot().accept(token, expiry, generation),
        );
        await p.referral.settled();
      },
      { carrier },
    );
    expect(await a.evaluate(() => window.probe.referral.current().cleared)).toBe(false);
    // Unsupported Web Locks is fail-closed, with no pretend cross-tab CAS fallback.
    const unsupported = await context.newPage();
    await unsupported.addInitScript(() =>
      Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }),
    );
    await unsupported.goto(appOrigin);
    expect(
      await unsupported.evaluate(async () => {
        await window.probe.credential.ready;
        return window.probe.credential.current().storageAvailable;
      }),
    ).toBe(false);
    await unsupported.close();
    // Only our exact fragment is removed; ordinary and portal fragments stay untouched.
    const captures = await a.evaluate(
      ({ carrier }) => {
        const p = window.probe;
        const order: string[] = [];
        const history = { state: null, replaceState: () => order.push('scrub') };
        p.captureReferralFragment(
          {
            hash: `#mercaria-referral=${encodeURIComponent(carrier)}`,
            pathname: '/products/x',
            search: '?view=1',
          },
          history,
          () => order.push('store'),
        );
        const untouched = p.captureReferralFragment(
          { hash: '#mgx_private', pathname: '/', search: '' },
          history,
          () => order.push('wrong'),
        );
        return { order, untouched };
      },
      { carrier },
    );
    expect(captures).toEqual({ order: ['scrub', 'store'], untouched: false });
    await expect(
      a.evaluate(async () => {
        const p = window.probe;
        await p.migrateLegacyReferral('https://api.oxy.so', p.referral);
      }),
    ).rejects.toThrow();
  } finally {
    await browser.close();
    app.closeAllConnections();
    api.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => app.close(() => r())),
      new Promise<void>((r) => api.close(() => r())),
    ]);
  }
});
