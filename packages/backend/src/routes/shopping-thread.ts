import { Router } from 'express';
import { z } from 'zod';
import { SHOPPING_THREAD_ROLES } from '@mercaria/shared-types';
import { authenticateToken } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { shoppingThreadConfig } from '../config/shopping-thread.js';
import { oxyServiceClient } from '../capabilities/oxy-service-client.js';
import { replyToShoppingThread } from '../services/shopping-thread.service.js';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';

export const shoppingThreadSchema = z
  .object({
    // Assistant history must accept the full reply limit, or a valid long reply
    // makes the shopper's next turn fail validation.
    messages: z
      .array(
        z
          .object({
            role: z.enum(SHOPPING_THREAD_ROLES),
            content: z.string().trim().min(1).max(64_000),
          })
          .strict()
          .refine(
            (message) => message.role === 'assistant' || message.content.length <= 4000,
            'Shopper messages are limited to 4000 characters',
          ),
      )
      .min(1)
      .max(24)
      .refine(
        (messages) => messages.at(-1)?.role === 'user',
        'The last message must be from the shopper',
      ),
    locale: z.string().min(2).max(35),
  })
  .strict();

const router = Router();
router.get('/', (_req, res) =>
  sendSuccess(res, { available: Boolean(shoppingThreadConfig().agentId && oxyServiceClient()) }),
);
router.post(
  '/',
  authenticateToken,
  makeRateLimiter('shopping-thread', { authenticatedMax: 20, anonymousMax: 0, windowMs: 60_000 }),
  validateBody(shoppingThreadSchema),
  async (req, res) => {
    if (!req.accessToken) {
      sendError(res, ErrorCodes.UNAUTHORIZED, 'Sign in to continue', 401);
      return;
    }
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);
    try {
      const reply = await replyToShoppingThread(
        req.body,
        req.accessToken,
        AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
      );
      if (!controller.signal.aborted) sendSuccess(res, reply);
    } catch {
      if (!controller.signal.aborted)
        sendError(
          res,
          ErrorCodes.SERVICE_UNAVAILABLE,
          'The shopping assistant is unavailable right now',
          503,
        );
    } finally {
      res.off('close', onClose);
    }
  },
);
export default router;
