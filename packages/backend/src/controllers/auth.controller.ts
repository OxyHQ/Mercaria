/**
 * Auth controller (THIN) — session-adjacent compatibility endpoints.
 *
 * Authentication itself is owned by Oxy (the `authenticateToken` middleware
 * validates the session and sets `req.user`). `GET /auth/me` returns the
 * caller's Oxy profile; `POST /auth/logout` is a client-driven no-op kept for
 * API compatibility. The canonical `name.displayName` is rendered directly — it
 * is never recomposed from `name.first` / `name.last` / `username`.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { oxyClient } from '../middleware/auth.js';
import { log } from '../lib/logger.js';

/** GET /auth/me — the authenticated caller's Oxy profile. */
export async function getMe(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const user = await oxyClient.getUserById(oxyUserId);
    sendSuccess(res, {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.name.displayName,
        avatar: user.avatar,
      },
    });
  } catch (err) {
    log.auth.error({ err }, 'Failed to get current user');
    respondWithError(res, err, 'Failed to get user');
  }
}

/** POST /auth/logout — client-driven (Oxy) logout; this endpoint is a no-op ack. */
export function logout(_req: Request, res: Response): void {
  sendSuccess(res, { message: 'Logged out successfully' });
}
