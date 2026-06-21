import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../../lib/logger.js', () => ({
  log: {
    auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('../../lib/net-utils.js', () => ({
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@oxyhq/core', () => {
  interface MockAuthRequest extends Request {
    userId?: string;
    user?: { id: string };
  }

  const passThroughMiddleware = (req: Request, _res: Response, next: NextFunction) => {
    const authReq = req as MockAuthRequest;
    authReq.userId = 'oxy-user-1';
    authReq.user = { id: 'oxy-user-1' };
    next();
  };

  class MockOxyServices {
    auth() { return vi.fn(passThroughMiddleware); }
    serviceAuth() { return vi.fn(passThroughMiddleware); }
  }

  return { OxyServices: MockOxyServices };
});

import {
  authenticateTelegramBot,
  authenticateTokenOrApiKey,
  requireScope,
} from '../auth.js';

type MockFn = ReturnType<typeof vi.fn>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    path: '/test',
    method: 'GET',
    ...overrides,
  } as Request;
}

type MockResponse = Response & {
  status: MockFn;
  json: MockFn;
};

function mockRes(): MockResponse {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    statusCode: 200,
  };
  return res as unknown as MockResponse;
}

describe('auth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TELEGRAM_BOT_SECRET;
    delete process.env.SERVICE_SECRET;
  });

  describe('authenticateTelegramBot', () => {
    it('rejects when TELEGRAM_BOT_SECRET is not configured', async () => {
      const req = mockReq({ headers: { 'x-telegram-bot-secret': 'some-secret' } });
      const res = mockRes();
      const next = vi.fn();

      await authenticateTelegramBot(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects missing bot secret', async () => {
      process.env.TELEGRAM_BOT_SECRET = 'correct-secret';

      const req = mockReq({ headers: {} });
      const res = mockRes();
      const next = vi.fn();

      await authenticateTelegramBot(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects wrong-length secret', async () => {
      process.env.TELEGRAM_BOT_SECRET = 'correct-secret';

      const req = mockReq({ headers: { 'x-telegram-bot-secret': 'short' } });
      const res = mockRes();
      const next = vi.fn();

      await authenticateTelegramBot(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects incorrect secret', async () => {
      process.env.TELEGRAM_BOT_SECRET = 'correct-secret';

      const req = mockReq({
        headers: {
          'x-telegram-bot-secret': 'wrong--secret',
          'x-telegram-id': '12345',
        },
      });
      const res = mockRes();
      const next = vi.fn();

      await authenticateTelegramBot(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects missing telegram ID', async () => {
      process.env.TELEGRAM_BOT_SECRET = 'test-secret';

      const req = mockReq({
        headers: {
          'x-telegram-bot-secret': 'test-secret',
        },
      });
      const res = mockRes();
      const next = vi.fn();

      await authenticateTelegramBot(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('sets user context with valid credentials', async () => {
      process.env.TELEGRAM_BOT_SECRET = 'test-secret';

      const req = mockReq({
        headers: {
          'x-telegram-bot-secret': 'test-secret',
          'x-telegram-id': '12345',
          'x-oxy-user-id': 'user-1',
        },
      });
      const res = mockRes();
      const next = vi.fn();

      await authenticateTelegramBot(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.userId).toBe('user-1');
      expect(req.user).toEqual({ id: 'user-1' });
    });
  });

  describe('authenticateTokenOrApiKey', () => {
    it('skips auth if user is already set', () => {
      const req = mockReq();
      req.user = { id: 'user-1' };
      const res = mockRes();
      const next = vi.fn();

      authenticateTokenOrApiKey(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('rejects when no auth is provided', () => {
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      authenticateTokenOrApiKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    });

    it('allows service secret auth', () => {
      process.env.SERVICE_SECRET = 'my-service-secret';

      const req = mockReq({ headers: { authorization: 'Bearer my-service-secret' } });
      const res = mockRes();
      const next = vi.fn();

      authenticateTokenOrApiKey(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.userId).toBe('system');
      expect(req.user).toEqual({ id: 'system' });
      expect(req.serviceApp?.appName).toBe('internal');
    });

    it('delegates bearer tokens to Oxy auth', () => {
      const req = mockReq({ headers: { authorization: 'Bearer oxy-session-token' } });
      const res = mockRes();
      const next = vi.fn();

      authenticateTokenOrApiKey(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('requireScope', () => {
    it('passes session users without checking scope', () => {
      const req = mockReq();
      req.user = { id: 'user-1' };
      const res = mockRes();
      const next = vi.fn();

      requireScope('chat')(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('passes API key context with matching scope', () => {
      const req = mockReq();
      req.user = { id: 'user-1' };
      req.apiKey = { id: 'key-1', appId: 'app-1', userId: 'user-1', scopes: ['chat', 'memory'] };
      const res = mockRes();
      const next = vi.fn();

      requireScope('chat')(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('rejects API key context without matching scope', () => {
      const req = mockReq();
      req.user = { id: 'user-1' };
      req.apiKey = { id: 'key-1', appId: 'app-1', userId: 'user-1', scopes: ['memory'] };
      const res = mockRes();
      const next = vi.fn();

      requireScope('chat')(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Insufficient permissions',
        required_scope: 'chat',
      });
    });
  });
});
