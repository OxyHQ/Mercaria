/**
 * The Express application, built without listening.
 *
 * Split from `index.ts` so the app can be constructed in a test WITHOUT opening a
 * port, connecting to Mongo or starting the socket server. That is not a
 * cosmetic split: the CrowdSource webhook's guarantee is that no body parser runs
 * before it, and the only honest way to assert that is to send a real request
 * through the REAL middleware chain and observe `req.body` inside a route on that
 * path. A test that rebuilt an app-shaped object of its own would prove something
 * about the test, not about production.
 *
 * `index.ts` owns the HTTP server, the socket server, Mongo and the background
 * workers; this file owns only the middleware chain and the routes.
 */

import express from 'express';
import cors from 'cors';
import { log } from './lib/logger.js';
// Routes
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import feedbackRouter from './routes/feedback.js';
import notificationsRouter from './routes/notifications.js';
import listingsRouter from './routes/listings.js';
import feedRouter from './routes/feed.js';
import categoriesRouter from './routes/categories.js';
import storesRouter from './routes/stores.js';
import favoritesRouter from './routes/favorites.js';
import cartRouter from './routes/cart.js';
import addressesRouter from './routes/addresses.js';
import checkoutRouter from './routes/checkout.js';
import ordersRouter from './routes/orders.js';
import reviewsRouter from './routes/reviews.js';
import sellerRouter from './routes/seller.js';
import ratesRouter from './routes/rates.js';
import meRouter from './routes/me.js';
import adminRouter from './routes/admin/index.js';
import channelsOauthRouter from './routes/channels-oauth.js';
import channelsWebhooksRouter from './routes/channels-webhooks.js';
import channelsIngestRouter from './routes/channels-ingest.js';
import reportsRouter from './routes/reports.js';
import crowdSourceWebhookRouter from './routes/crowdsource-webhook.js';
import { makeRateLimiter } from './lib/rate-limit.js';

/**
 * Build the application.
 *
 * MOUNT ORDER IS LOAD-BEARING and is asserted by
 * `routes/__tests__/crowdsource-webhook.integration.test.ts`: both webhook
 * routers must be registered BEFORE `express.json()`, or the raw bytes their
 * signatures cover are consumed before they can be verified.
 */
export function createApp(): express.Express {
  const app = express();

  // CORS — restricted to known origins
  const PRODUCTION_ORIGINS = [
    'https://mercaria.co',
    'https://console.mercaria.co',
    'https://gateway.mercaria.co',
    'https://dashboard.mercaria.co',
    'https://pos.mercaria.co',
  ];

  const DEV_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8081',
    'exp://localhost:8081',
    'http://10.0.2.2:8081',
    // Sibling Expo web apps run on incrementing ports (frontend 8081,
    // dashboard 8082, pos 8083) when started concurrently.
    'http://localhost:8082',
    'exp://localhost:8082',
    'http://10.0.2.2:8082',
    'http://localhost:8083',
    'exp://localhost:8083',
    'http://10.0.2.2:8083',
    'http://localhost:8092',
    'exp://localhost:8092',
  ];

  const allowedOrigins = [
    ...(process.env.WEB_URL ? [process.env.WEB_URL] : []),
    ...PRODUCTION_ORIGINS,
    ...DEV_ORIGINS,
  ];

  app.use((req, res, next) => {
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);

        if (allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-Service-Name', 'X-Timestamp', 'X-Signature', 'X-Session-Id', 'X-Device-Info', 'X-Oxy-User-Id', 'X-Workspace-Id'],
      optionsSuccessStatus: 200,
    })(req, res, next);
  });

  // Allow cross-origin resource loading (fixes ERR_BLOCKED_BY_RESPONSE.NotSameOrigin)
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });

  // Inbound connector webhooks (server-to-server). MUST be mounted BEFORE the
  // global express.json() so the RAW request body survives for HMAC verification
  // (the router mounts its own express.raw parser for that path).
  app.use('/channels/webhooks', channelsWebhooksRouter);

  // Inbound CrowdSource moderation webhooks. Same rule, stricter consequence: the
  // SDK handler reads the request STREAM and verifies the signature over the bytes
  // that arrived. If a parser consumed them first it REFUSES rather than verifying
  // a re-serialisation — so mounting this after express.json() does not weaken the
  // check, it breaks every delivery. Guarded by a test that asserts
  // `typeof req.body === 'undefined'` inside a route on this path.
  app.use('/webhooks/crowdsource', crowdSourceWebhookRouter);

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Global rate limiter — per-user for authenticated callers, per-IP for anon.
  // (The SDK exempts health probes + CORS preflight internally.)
  app.use(makeRateLimiter('general'));

  // Routes
  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/feedback', feedbackRouter);
  app.use('/notifications', notificationsRouter);
  app.use('/listings', listingsRouter);
  app.use('/feed', feedRouter);
  app.use('/categories', categoriesRouter);
  app.use('/stores', storesRouter);
  app.use('/favorites', favoritesRouter);
  app.use('/cart', cartRouter);
  app.use('/addresses', addressesRouter);
  app.use('/checkout', checkoutRouter);
  app.use('/orders', ordersRouter);
  app.use('/reviews', reviewsRouter);
  // Abuse reports. Unrelated to the store SALES ANALYTICS at
  // /admin/stores/:storeId/reports/* — same word, different domain.
  app.use('/reports', reportsRouter);
  app.use('/seller', sellerRouter);
  app.use('/rates', ratesRouter);
  app.use('/me', meRouter);
  app.use('/admin', adminRouter);
  // Public connector OAuth callback (server-to-server; no browser CORS, no session).
  app.use('/channels/oauth', channelsOauthRouter);
  // Token-free channel ingestion (external push client authenticated by a channel key).
  app.use('/channels/ingest', channelsIngestRouter);
  // (Inbound connector webhooks are mounted above, before express.json.)

  // Root route
  app.get('/', (_req, res) => {
    res.json({
      message: 'Mercaria API',
      version: '1.0.0',
      endpoints: [
        '/health',
        '/auth',
        '/feedback',
        '/notifications',
        '/listings',
        '/feed',
        '/categories',
        '/stores',
        '/favorites',
        '/cart',
        '/addresses',
        '/checkout',
        '/orders',
        '/reviews',
        '/seller',
        '/rates',
        '/me',
        '/admin',
        '/channels/oauth',
        '/channels/ingest',
        '/channels/webhooks',
      ]
    });
  });

  // Error handler
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.general.error({ err }, 'Unhandled Express error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong!' });
    }
  });

  return app;
}
