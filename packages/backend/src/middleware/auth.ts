import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { OxyServices } from '@oxyhq/core';
import {
  createOptionalOxyAuth,
  createOxyAuthMiddleware,
  type OxyRequestUser,
  type OxyServiceAppContext,
} from '@oxyhq/core/server';
import { log } from '../lib/logger.js';
import { getClientIp } from '../lib/net-utils.js';

// Initialize Oxy client
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
export const oxyClient = new OxyServices({
  baseURL: OXY_API_URL,
});

// Extend Express Request for API keys and service tokens
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      accessToken?: string;
      user?: OxyRequestUser | null;
      apiKey?: {
        id: string;
        appId: string;
        userId: string;
        scopes: string[];
      };
      serviceApp?: OxyServiceAppContext;
      workspace?: {
        id: string | null;
        role?: 'owner' | 'admin' | 'member';
      };
    }
  }
}

/**
 * Oxy authentication middleware (official @oxyhq/core/server)
 * Validates JWT tokens (including service tokens) and sets req.userId, req.user, req.accessToken
 */
export const authenticateToken = createOxyAuthMiddleware(oxyClient, { auth: { debug: true } });

/**
 * Service-only auth — rejects anything that isn't a service token.
 * Use for internal-only endpoints (e.g., /internal/trigger).
 */
export const oxyServiceAuth = oxyClient.serviceAuth({ debug: true });

/**
 * Optional auth - attaches user if token present, doesn't block if absent
 * Tries bot auth first (Telegram), then Oxy JWT auth
 */
const oxyOptionalAuth = createOptionalOxyAuth(oxyClient, { auth: { debug: true } });

export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Uses @oxyhq/core/server optional auth — attaches user if valid, continues if not.
  oxyOptionalAuth(req, res, next);
}

/**
 * Accepts Oxy JWT tokens and the internal service secret.
 */
export function authenticateTokenOrApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Already authenticated (e.g., by channel bot pre-middleware)
  if (req.user) {
    return next();
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Internal service auth (server-to-server calls using the shared service secret)
  const serviceSecret = process.env.SERVICE_SECRET;
  if (serviceSecret && token.length === serviceSecret.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(serviceSecret))) {
    req.userId = 'system';
    req.user = { id: 'system' };
    req.serviceApp = {
      appId: 'internal',
      appName: 'internal',
      credentialId: 'service-secret',
      scopes: ['internal'],
    };
    return next();
  }

  // Oxy JWT auth
  authenticateToken(req, res, next);
}

/**
 * Check if API key has a specific scope
 */
export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Session users have all scopes
    if (req.user && !req.apiKey) {
      return next();
    }

    if (req.apiKey?.scopes.includes(scope)) {
      return next();
    }

    res.status(403).json({
      error: 'Insufficient permissions',
      required_scope: scope
    });
  };
}

/**
 * Authenticate internal Telegram bot requests
 * The bot is a trusted server component that can act on behalf of linked users
 *
 * Security layers:
 * 1. Verifies bot secret matches server-side secret
 * 2. Validates user ID is provided
 * 3. Uses constant-time comparison to prevent timing attacks
 * 4. Logs authentication attempts for audit trail
 */
export async function authenticateTelegramBot(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const startTime = Date.now();

  try {
    const botSecret = req.headers['x-telegram-bot-secret'] as string;
    const oxyUserId = req.headers['x-oxy-user-id'] as string;
    const telegramId = req.headers['x-telegram-id'] as string;

    // Verify bot secret is configured
    const expectedSecret = process.env.TELEGRAM_BOT_SECRET;
    if (!expectedSecret) {
      log.auth.error('TELEGRAM_BOT_SECRET not configured');
      res.status(500).json({ error: 'Bot authentication not configured' });
      return;
    }

    // Verify secret provided
    if (!botSecret) {
      log.auth.warn({ ip: getClientIp(req) }, 'Missing bot secret');
      res.status(401).json({ error: 'Bot authentication required' });
      return;
    }

    // Use crypto.timingSafeEqual to prevent timing attacks
    const expectedBuffer = Buffer.from(expectedSecret);
    const providedBuffer = Buffer.from(botSecret);

    if (expectedBuffer.length !== providedBuffer.length) {
      log.auth.warn({ ip: getClientIp(req) }, 'Invalid bot secret length');
      res.status(401).json({ error: 'Invalid bot authentication' });
      return;
    }

    const crypto = await import('crypto');
    if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
      log.auth.warn({ ip: getClientIp(req) }, 'Invalid bot secret');
      res.status(401).json({ error: 'Invalid bot authentication' });
      return;
    }

    // Verify telegram ID is provided
    if (!telegramId) {
      log.auth.warn('Missing telegram ID in bot request');
      res.status(400).json({ error: 'Telegram ID required for bot requests' });
      return;
    }

    // Log successful auth for audit trail
    const duration = Date.now() - startTime;
    log.auth.info({ telegramId, oxyUserId: oxyUserId || 'unknown', ip: getClientIp(req), endpoint: req.path, durationMs: duration }, 'Telegram bot authenticated');

    // Set user context if provided - the bot is acting on behalf of this user
    if (oxyUserId) {
      req.userId = oxyUserId;
      req.user = { id: oxyUserId };
    }
    next();
  } catch (error) {
    log.auth.error({ err: error }, 'Bot authentication error');
    res.status(500).json({ error: 'Authentication failed' });
  }
}
