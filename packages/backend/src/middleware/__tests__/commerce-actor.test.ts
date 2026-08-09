/**
 * The `CommerceActor` resolver's precedence, CSRF gate and transports
 * (ADR 0003 D1/D2/D9/D10), against controlled fakes.
 *
 * Oxy auth and the guest-session service are MOCKED here on purpose: what
 * this file pins is the middleware's own decision table — which credential
 * wins, what refuses, what never gets consulted — not token verification
 * (the SDK's) or session resolution (pinned against a real database in
 * `services/__tests__/guest-session.realdb.test.ts`). The full HTTP paths run
 * against the REAL app in `routes/__tests__/guest-session.integration.test.ts`.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { GuestSessionRow } from '../../db/guests/guestSessionRepository.js';

// Oxy auth is composition, not subject: the mock attaches whatever the test
// staged on the request and never talks to the network.
vi.mock('../auth.js', () => ({
  optionalAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../services/guest-session.service.js', () => ({
  issueGuestSession: vi.fn(),
  resolveGuestSessionByToken: vi.fn(),
  rotateGuestSession: vi.fn(),
  rotationDue: vi.fn(() => false),
}));

let middleware: typeof import('../commerce-actor.js');
let service: {
  issueGuestSession: ReturnType<typeof vi.fn>;
  resolveGuestSessionByToken: ReturnType<typeof vi.fn>;
  rotateGuestSession: ReturnType<typeof vi.fn>;
  rotationDue: ReturnType<typeof vi.fn>;
};

beforeAll(async () => {
  // Before the dynamic import: `config/index.ts` freezes at module load, and
  // the resolver only reads guest credentials when guest commerce is enabled.
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'unit-test-pii-key';
  process.env.GUEST_EMAIL_HASH_KEY = 'unit-test-email-hash-key';

  middleware = await import('../commerce-actor.js');
  service = (await import(
    '../../services/guest-session.service.js'
  )) as unknown as typeof service;
});

beforeEach(() => {
  service.issueGuestSession.mockReset();
  service.resolveGuestSessionByToken.mockReset();
  service.rotateGuestSession.mockReset();
  service.rotationDue.mockReset();
  service.rotationDue.mockReturnValue(false);
});

/** A plausible session row for staging resolutions. */
function makeSessionRow(overrides: Partial<GuestSessionRow> = {}): GuestSessionRow {
  const now = new Date();
  return {
    id: 'gs-row-1',
    tokenHash: 'a'.repeat(64),
    previousTokenHash: null,
    previousTokenExpiresAt: null,
    clientClass: 'web',
    lastSeenAt: now,
    rotatedAt: null,
    expiresAt: new Date(now.getTime() + 86_400_000),
    revokedAt: null,
    convertedAt: null,
    convertedToOxyUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A syntactically valid token for the transport under test. */
const WELL_FORMED_TOKEN = `mgs_${'A'.repeat(43)}`;

interface FakeResponse {
  res: Response;
  status: () => number | undefined;
  jsonBody: () => unknown;
  cookies: Map<string, { value: string; options: Record<string, unknown> }>;
  clearedCookies: string[];
  headers: Map<string, string>;
}

function makeRes(): FakeResponse {
  let statusCode: number | undefined;
  let body: unknown;
  const cookies = new Map<string, { value: string; options: Record<string, unknown> }>();
  const clearedCookies: string[] = [];
  const headers = new Map<string, string>();
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
    cookie(name: string, value: string, options: Record<string, unknown>) {
      cookies.set(name, { value, options });
      return res;
    },
    clearCookie(name: string) {
      clearedCookies.push(name);
      return res;
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return res;
    },
  } as unknown as Response;
  return { res, status: () => statusCode, jsonBody: () => body, cookies, clearedCookies, headers };
}

function makeReq(input: {
  method?: string;
  headers?: Record<string, string>;
  userId?: string;
}): Request {
  return {
    method: input.method ?? 'GET',
    path: '/test',
    headers: input.headers ?? {},
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
  } as unknown as Request;
}

/** Run the resolver to completion and hand back what it left on the request. */
async function resolve(req: Request, fake: FakeResponse): Promise<{ nextCalls: number }> {
  let nextCalls = 0;
  await new Promise<void>((resolvePromise, reject) => {
    middleware.resolveCommerceActor(req, fake.res, (error?: unknown) => {
      nextCalls += 1;
      if (error !== undefined && error !== null) reject(error instanceof Error ? error : new Error(String(error)));
      else resolvePromise();
    });
    // A refusal answers the response without calling next; settle on a tick.
    setImmediate(() => resolvePromise());
  });
  return { nextCalls };
}

const DEV_COOKIE = 'mercaria_guest_dev';

describe('precedence (D2)', () => {
  it('resolves a verified Oxy user as the actor, carrying a valid guest session only as possession proof', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue({
      session: makeSessionRow(),
      matchedPrevious: false,
    });
    const req = makeReq({
      userId: 'oxy-1',
      headers: { authorization: 'Bearer something', cookie: `${DEV_COOKIE}=${WELL_FORMED_TOKEN}` },
    });
    const fake = makeRes();

    await resolve(req, fake);

    expect(req.commerceActor).toEqual({
      kind: 'oxy',
      oxyUserId: 'oxy-1',
      presentedGuestSessionId: 'gs-row-1',
    });
    expect(req.guestCredential).toBe('valid');
  });

  it('NEVER rotates the guest session when Oxy wins, even with rotation due', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue({
      session: makeSessionRow(),
      matchedPrevious: false,
    });
    service.rotationDue.mockReturnValue(true);
    const req = makeReq({
      userId: 'oxy-1',
      headers: { authorization: 'Bearer something', cookie: `${DEV_COOKIE}=${WELL_FORMED_TOKEN}` },
    });

    await resolve(req, makeRes());

    expect(service.rotateGuestSession).not.toHaveBeenCalled();
  });

  it('answers 401 for a presented-but-unverified Bearer — no downgrade to the guest cookie', async () => {
    const req = makeReq({
      headers: {
        authorization: 'Bearer garbage-that-did-not-verify',
        cookie: `${DEV_COOKIE}=${WELL_FORMED_TOKEN}`,
      },
    });
    const fake = makeRes();

    const { nextCalls } = await resolve(req, fake);

    expect(fake.status()).toBe(401);
    expect(nextCalls).toBe(0);
    // The refusal happens BEFORE the guest credential is even consulted.
    expect(service.resolveGuestSessionByToken).not.toHaveBeenCalled();
  });

  it('resolves a lone valid guest cookie to a guest actor with cookie transport', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue({
      session: makeSessionRow(),
      matchedPrevious: false,
    });
    const req = makeReq({ headers: { cookie: `${DEV_COOKIE}=${WELL_FORMED_TOKEN}` } });

    await resolve(req, makeRes());

    expect(req.commerceActor).toEqual({
      kind: 'guest',
      guestSessionId: 'gs-row-1',
      transport: 'cookie',
    });
  });

  it('reads the header FIRST when both carriages are present (D9)', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue({
      session: makeSessionRow(),
      matchedPrevious: false,
    });
    const headerToken = `mgs_${'B'.repeat(43)}`;
    const req = makeReq({
      headers: {
        'x-mercaria-guest-token': headerToken,
        cookie: `${DEV_COOKIE}=${WELL_FORMED_TOKEN}`,
      },
    });

    await resolve(req, makeRes());

    expect(service.resolveGuestSessionByToken).toHaveBeenCalledTimes(1);
    expect(service.resolveGuestSessionByToken.mock.calls[0][0]).toBe(headerToken);
    expect(req.commerceActor).toEqual({
      kind: 'guest',
      guestSessionId: 'gs-row-1',
      transport: 'header',
    });
  });

  it('treats an INVALID guest credential as absent — anonymous, marked invalid', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue(null);
    const req = makeReq({ headers: { cookie: `${DEV_COOKIE}=${WELL_FORMED_TOKEN}` } });

    await resolve(req, makeRes());

    expect(req.commerceActor).toEqual({ kind: 'anonymous' });
    expect(req.guestCredential).toBe('invalid');
  });

  it('an invalid guest credential beside verified Oxy yields plain Oxy with NO possession proof', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue(null);
    const req = makeReq({
      userId: 'oxy-1',
      headers: { authorization: 'Bearer x', cookie: `${DEV_COOKIE}=${WELL_FORMED_TOKEN}` },
    });

    await resolve(req, makeRes());

    expect(req.commerceActor).toEqual({ kind: 'oxy', oxyUserId: 'oxy-1' });
    expect(req.guestCredential).toBe('invalid');
  });

  it('resolves no credential at all to anonymous, marked absent', async () => {
    const req = makeReq({});

    await resolve(req, makeRes());

    expect(req.commerceActor).toEqual({ kind: 'anonymous' });
    expect(req.guestCredential).toBe('absent');
    expect(service.resolveGuestSessionByToken).not.toHaveBeenCalled();
  });

  it('NEVER issues a session during resolution — reads cannot create rows (acceptance 7)', async () => {
    await resolve(makeReq({}), makeRes());
    await resolve(
      makeReq({ method: 'POST', headers: { origin: 'https://mercaria.co' } }),
      makeRes(),
    );

    expect(service.issueGuestSession).not.toHaveBeenCalled();
  });
});

describe('CSRF on cookie-authenticated writes (D10, acceptance 3)', () => {
  const cookieHeaders = { cookie: `${DEV_COOKIE}=${WELL_FORMED_TOKEN}` };

  it('refuses a cookie-authenticated POST from a non-allow-listed Origin, before any lookup', async () => {
    const req = makeReq({
      method: 'POST',
      headers: { ...cookieHeaders, origin: 'https://evil.example' },
    });
    const fake = makeRes();

    const { nextCalls } = await resolve(req, fake);

    expect(fake.status()).toBe(403);
    expect(nextCalls).toBe(0);
    expect(service.resolveGuestSessionByToken).not.toHaveBeenCalled();
  });

  it('refuses a cookie-authenticated POST carrying neither Origin nor Referer', async () => {
    const req = makeReq({ method: 'POST', headers: cookieHeaders });
    const fake = makeRes();

    await resolve(req, fake);

    expect(fake.status()).toBe(403);
  });

  it('accepts an allow-listed Referer when Origin is absent', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue({
      session: makeSessionRow(),
      matchedPrevious: false,
    });
    const req = makeReq({
      method: 'POST',
      headers: { ...cookieHeaders, referer: 'https://mercaria.co/cart' },
    });
    const fake = makeRes();

    await resolve(req, fake);

    expect(fake.status()).toBeUndefined();
    expect(req.commerceActor?.kind).toBe('guest');
  });

  it('does not gate SAFE methods — a cookie GET resolves without any Origin', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue({
      session: makeSessionRow(),
      matchedPrevious: false,
    });
    const req = makeReq({ headers: cookieHeaders });
    const fake = makeRes();

    await resolve(req, fake);

    expect(fake.status()).toBeUndefined();
    expect(req.commerceActor?.kind).toBe('guest');
  });

  it('does not gate HEADER transport — the CORS preflight is that carriage’s control', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue({
      session: makeSessionRow(),
      matchedPrevious: false,
    });
    const req = makeReq({
      method: 'POST',
      headers: { 'x-mercaria-guest-token': WELL_FORMED_TOKEN },
    });
    const fake = makeRes();

    await resolve(req, fake);

    expect(fake.status()).toBeUndefined();
    expect(req.commerceActor).toEqual({
      kind: 'guest',
      guestSessionId: 'gs-row-1',
      transport: 'header',
    });
  });
});

describe('the 7-day rotation cadence, answered in kind (D3/D9)', () => {
  it('rotates a due cookie session and answers with Set-Cookie, marking rotatedInFlight', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue({
      session: makeSessionRow(),
      matchedPrevious: false,
    });
    service.rotationDue.mockReturnValue(true);
    const rotatedRow = makeSessionRow({ rotatedAt: new Date() });
    service.rotateGuestSession.mockResolvedValue({
      session: rotatedRow,
      token: `mgs_${'C'.repeat(43)}`,
    });
    const req = makeReq({ headers: { cookie: `${DEV_COOKIE}=${WELL_FORMED_TOKEN}` } });
    const fake = makeRes();

    await resolve(req, fake);

    expect(service.rotateGuestSession).toHaveBeenCalledTimes(1);
    expect(fake.cookies.get(DEV_COOKIE)?.value).toBe(`mgs_${'C'.repeat(43)}`);
    expect(req.guestSessionContext?.rotatedInFlight).toBe(true);
    expect(req.commerceActor?.kind).toBe('guest');
  });

  it('rotates a due header session onto the response header, never a cookie', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue({
      session: makeSessionRow(),
      matchedPrevious: false,
    });
    service.rotationDue.mockReturnValue(true);
    service.rotateGuestSession.mockResolvedValue({
      session: makeSessionRow({ rotatedAt: new Date() }),
      token: `mgs_${'D'.repeat(43)}`,
    });
    const req = makeReq({ headers: { 'x-mercaria-guest-token': WELL_FORMED_TOKEN } });
    const fake = makeRes();

    await resolve(req, fake);

    expect(fake.headers.get('x-mercaria-guest-token')).toBe(`mgs_${'D'.repeat(43)}`);
    expect(fake.cookies.size).toBe(0);
  });

  it('never auto-rotates on a grace-window (previous-hash) match', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue({
      session: makeSessionRow(),
      matchedPrevious: true,
    });
    service.rotationDue.mockReturnValue(true);
    const req = makeReq({ headers: { cookie: `${DEV_COOKIE}=${WELL_FORMED_TOKEN}` } });

    await resolve(req, makeRes());

    expect(service.rotateGuestSession).not.toHaveBeenCalled();
  });
});

describe('issueGuestActor — the lazy-issuance primitive', () => {
  it('refuses cookie-transport issuance without an allow-listed Origin (403), issuing nothing', async () => {
    const req = makeReq({ method: 'POST', headers: {} });
    const fake = makeRes();

    const context = await middleware.issueGuestActor(req, fake.res);

    expect(context).toBeUndefined();
    expect(fake.status()).toBe(403);
    expect(service.issueGuestSession).not.toHaveBeenCalled();
  });

  it('issues over cookie transport with a valid Origin: Set-Cookie, no token in any header', async () => {
    service.issueGuestSession.mockResolvedValue({
      session: makeSessionRow(),
      token: `mgs_${'E'.repeat(43)}`,
    });
    const req = makeReq({ method: 'POST', headers: { origin: 'https://mercaria.co' } });
    const fake = makeRes();

    const context = await middleware.issueGuestActor(req, fake.res);

    expect(context?.transport).toBe('cookie');
    expect(service.issueGuestSession).toHaveBeenCalledWith(
      expect.objectContaining({ clientClass: 'web' }),
    );
    expect(fake.cookies.get(DEV_COOKIE)?.value).toBe(`mgs_${'E'.repeat(43)}`);
    expect(fake.headers.has('x-mercaria-guest-token')).toBe(false);
    expect(req.commerceActor).toEqual({
      kind: 'guest',
      guestSessionId: 'gs-row-1',
      transport: 'cookie',
    });
  });

  it('issues over declared header transport with no Origin at all: header out, no cookie', async () => {
    service.issueGuestSession.mockResolvedValue({
      session: makeSessionRow({ clientClass: 'ios' }),
      token: `mgs_${'F'.repeat(43)}`,
    });
    const req = makeReq({
      method: 'POST',
      headers: { 'x-mercaria-guest-transport': 'header', 'x-mercaria-guest-client': 'ios' },
    });
    const fake = makeRes();

    const context = await middleware.issueGuestActor(req, fake.res);

    expect(context?.transport).toBe('header');
    expect(service.issueGuestSession).toHaveBeenCalledWith(
      expect.objectContaining({ clientClass: 'ios' }),
    );
    expect(fake.headers.get('x-mercaria-guest-token')).toBe(`mgs_${'F'.repeat(43)}`);
    expect(fake.cookies.size).toBe(0);
  });

  it('allow-lists the declared client class — garbage falls back to the transport default', async () => {
    service.issueGuestSession.mockResolvedValue({
      session: makeSessionRow(),
      token: `mgs_${'G'.repeat(43)}`,
    });
    const req = makeReq({
      method: 'POST',
      headers: { 'x-mercaria-guest-transport': 'header', 'x-mercaria-guest-client': 'smart-fridge' },
    });

    await middleware.issueGuestActor(req, makeRes().res);

    expect(service.issueGuestSession).toHaveBeenCalledWith(
      expect.objectContaining({ clientClass: 'other' }),
    );
  });
});

describe('the cookie profile (D9) and the scoped cookie read', () => {
  it('is __Host-, HttpOnly, Secure, SameSite=Lax, Path=/ in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const profile = middleware.guestCookieProfile();
      expect(profile.name).toBe('__Host-mercaria_guest');
      expect(profile.options).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('downgrades EXPLICITLY in development: different name, no Secure, same everything else', () => {
    const profile = middleware.guestCookieProfile();
    expect(profile.name).toBe(DEV_COOKIE);
    expect(profile.options).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
    });
  });

  it('reads exactly the named cookie out of a shared jar, quoted or not', () => {
    const jar = `other=1; ${DEV_COOKIE}="${WELL_FORMED_TOKEN}"; trailing=x`;
    expect(middleware.readGuestCookie(jar, DEV_COOKIE)).toBe(WELL_FORMED_TOKEN);
    expect(middleware.readGuestCookie(`a=1; b=2`, DEV_COOKIE)).toBeUndefined();
    expect(middleware.readGuestCookie(undefined, DEV_COOKIE)).toBeUndefined();
  });

  it('refuses an oversized Cookie header outright', () => {
    const jar = `${DEV_COOKIE}=${WELL_FORMED_TOKEN}; junk=${'x'.repeat(9_000)}`;
    expect(middleware.readGuestCookie(jar, DEV_COOKIE)).toBeUndefined();
  });
});
