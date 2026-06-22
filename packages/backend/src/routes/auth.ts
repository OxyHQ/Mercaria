import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { getMe, logout } from '../controllers/auth.controller.js';

/**
 * Auth API — session-adjacent compatibility endpoints.
 *
 * Authentication is owned by Oxy (`authenticateToken`). `GET /auth/me` returns
 * the caller's Oxy profile; `POST /auth/logout` is a client-driven no-op kept
 * for API compatibility. Metered on the `'general'` scope.
 */
const router = Router();

router.use(authenticateToken);

router.get('/me', makeRateLimiter('general'), getMe);
router.post('/logout', makeRateLimiter('general'), logout);

export default router;
