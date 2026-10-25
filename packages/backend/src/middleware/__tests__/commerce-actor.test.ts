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
  service = (await import('../../services/guest-session.service.js')) as unknown as typeof service;
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
      if (error !== undefined && error !== null)
        reject(error instanceof Error ? error : new Error(String(error)));
      else resolvePromise();
    });
    // A refusal answers the response without calling next; settle on a tick.
    setImmediate(() => resolvePromise());
  });
  return { nextCalls };
}

describe('explicit commerce credentials', () => {
  it.each(['', 'Basic invalid', 'Bearer', 'bearer invalid', ' Bearer invalid'])(
    'never downgrades malformed Authorization (%j)',
    async (authorization) => {
      const req = makeReq({
        headers: { authorization, 'x-mercaria-guest-token': WELL_FORMED_TOKEN },
      });
      const fake = makeRes();
      expect((await resolve(req, fake)).nextCalls).toBe(0);
      expect(fake.status()).toBe(401);
      expect(service.resolveGuestSessionByToken).not.toHaveBeenCalled();
      expect(service.issueGuestSession).not.toHaveBeenCalled();
    },
  );

  it('keeps verified Oxy as actor and guest possession inert, without rotating', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue({
      session: makeSessionRow(),
      matchedPrevious: false,
    });
    service.rotationDue.mockReturnValue(true);
    const req = makeReq({
      userId: 'oxy-1',
      headers: { authorization: 'Bearer verified', 'x-mercaria-guest-token': WELL_FORMED_TOKEN },
    });
    await resolve(req, makeRes());
    expect(req.commerceActor).toEqual({
      kind: 'oxy',
      oxyUserId: 'oxy-1',
      presentedGuestSessionId: 'gs-row-1',
    });
    expect(service.rotateGuestSession).not.toHaveBeenCalled();
  });

  it('uses header B even beside legacy cookie A, retaining the persisted web cohort', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue({
      session: makeSessionRow(),
      matchedPrevious: false,
    });
    const req = makeReq({
      headers: {
        'x-mercaria-guest-token': WELL_FORMED_TOKEN,
        cookie: 'mercaria_guest_dev=other',
        'x-mercaria-guest-client': 'android',
      },
    });
    await resolve(req, makeRes());
    expect(service.resolveGuestSessionByToken).toHaveBeenCalledWith(
      WELL_FORMED_TOKEN,
      expect.any(Date),
    );
    expect(req.commerceActor).toEqual({
      kind: 'guest',
      guestSessionId: 'gs-row-1',
      clientClass: 'web',
    });
  });

  it.each(['GET', 'POST'])(
    'refuses cookie-only %s without looking up or minting an owner',
    async (method) => {
      const req = makeReq({
        method,
        headers: {
          cookie: `mercaria_guest_dev=${WELL_FORMED_TOKEN}`,
          origin: 'https://mercaria.co',
        },
      });
      const fake = makeRes();
      await resolve(req, fake);
      expect(fake.status()).toBe(426);
      expect(service.resolveGuestSessionByToken).not.toHaveBeenCalled();
      expect(service.issueGuestSession).not.toHaveBeenCalled();
    },
  );

  it('does not block a verified Oxy actor because an inert old cookie exists', async () => {
    const req = makeReq({
      userId: 'oxy-1',
      headers: { cookie: `mercaria_guest_dev=${WELL_FORMED_TOKEN}` },
    });
    await resolve(req, makeRes());
    expect(req.commerceActor).toEqual({ kind: 'oxy', oxyUserId: 'oxy-1' });
    expect(service.resolveGuestSessionByToken).not.toHaveBeenCalled();
  });

  it('never falls back from an invalid explicit header to a legacy cookie', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue(null);
    const req = makeReq({
      headers: {
        'x-mercaria-guest-token': 'invalid',
        cookie: `mercaria_guest_dev=${WELL_FORMED_TOKEN}`,
      },
    });
    await resolve(req, makeRes());
    expect(req.guestCredential).toBe('invalid');
    expect(req.commerceActor).toEqual({ kind: 'anonymous' });
    expect(service.resolveGuestSessionByToken).toHaveBeenCalledTimes(1);
    expect(service.resolveGuestSessionByToken).toHaveBeenCalledWith('invalid', expect.any(Date));
    expect(service.issueGuestSession).not.toHaveBeenCalled();
  });

  it('creates no identity for an anonymous read', async () => {
    const req = makeReq({});
    await resolve(req, makeRes());
    expect(req.commerceActor).toEqual({ kind: 'anonymous' });
    expect(service.issueGuestSession).not.toHaveBeenCalled();
  });

  it('rotates once with server expiry/generation and never emits a cookie', async () => {
    const session = makeSessionRow();
    const rotated = makeSessionRow({ rotatedAt: new Date() });
    service.resolveGuestSessionByToken.mockResolvedValue({ session, matchedPrevious: false });
    service.rotationDue.mockReturnValue(true);
    service.rotateGuestSession.mockResolvedValue({ session: rotated, token: 'new-token' });
    const req = makeReq({ headers: { 'x-mercaria-guest-token': WELL_FORMED_TOKEN } });
    const fake = makeRes();
    await resolve(req, fake);
    expect(service.rotateGuestSession).toHaveBeenCalledTimes(1);
    expect(req.guestSessionContext?.rotatedInFlight).toBe(true);
    expect(fake.headers.get('x-mercaria-guest-token')).toBe('new-token');
    expect(fake.headers.get('x-mercaria-guest-expires-at')).toBe(rotated.expiresAt.toISOString());
    expect(fake.headers.get('x-mercaria-guest-generation')).toBe(
      String(rotated.rotatedAt?.getTime()),
    );
    expect(fake.headers.get('cache-control')).toBe('no-store');
    expect(fake.cookies.size).toBe(0);
  });

  it('never relabels a grace-window token as the current generation', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue({
      session: makeSessionRow(),
      matchedPrevious: true,
    });
    service.rotationDue.mockReturnValue(true);
    const fake = makeRes();
    await resolve(makeReq({ headers: { 'x-mercaria-guest-token': WELL_FORMED_TOKEN } }), fake);
    expect(service.rotateGuestSession).not.toHaveBeenCalled();
    expect(fake.headers.has('x-mercaria-guest-token')).toBe(false);
  });

  it('a lost rotation CAS never mints a second token or changes the owner', async () => {
    service.resolveGuestSessionByToken.mockResolvedValue({
      session: makeSessionRow(),
      matchedPrevious: false,
    });
    service.rotationDue.mockReturnValue(true);
    service.rotateGuestSession.mockResolvedValue(null);
    const req = makeReq({ headers: { 'x-mercaria-guest-token': WELL_FORMED_TOKEN } });
    const fake = makeRes();
    await resolve(req, fake);
    expect(req.commerceActor).toMatchObject({ kind: 'guest', guestSessionId: 'gs-row-1' });
    expect(fake.headers.has('x-mercaria-guest-token')).toBe(false);
    expect(service.issueGuestSession).not.toHaveBeenCalled();
  });

  it('refuses old issuing clients before creating an orphan session', async () => {
    const fake = makeRes();
    expect(
      await middleware.issueGuestActor(
        makeReq({ method: 'POST', headers: { origin: 'https://mercaria.co' } }),
        fake.res,
      ),
    ).toBeUndefined();
    expect(fake.status()).toBe(426);
    expect(service.issueGuestSession).not.toHaveBeenCalled();
  });
});
