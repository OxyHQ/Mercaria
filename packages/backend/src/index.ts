import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { connectDB } from './lib/db.js';
import { log } from './lib/logger.js';
import { isAbortError, isFatalError, isTransientNetworkError } from './lib/error-classification.js';

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

// Socket.io
import { initSocket } from './socket.js';
import { makeRateLimiter } from './lib/rate-limit.js';

// Fix for ES Modules __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from the api directory (not the monorepo root)
dotenv.config({ path: join(__dirname, '../.env') });

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Create HTTP server with optimized settings
const server = http.createServer({
  // Increase max header size for long authentication tokens
  maxHeaderSize: 16384,
  keepAlive: true,
  keepAliveTimeout: 65000, // Slightly higher than default
}, app);

// Handle HTTP server errors (e.g. EADDRINUSE)
server.on('error', (error: NodeJS.ErrnoException) => {
  log.general.error({ err: error }, '[Server] HTTP server error');
  if (error.code === 'EADDRINUSE') {
    log.general.error({ port: PORT }, 'Port already in use');
    process.exit(1);
  }
});

server.on('connection', (socket) => {
  // Disable Nagle's algorithm for all connections to reduce latency
  socket.setNoDelay(true);
  // Set keep-alive
  socket.setKeepAlive(true, 60000);
});

initSocket(server);

// CORS — restricted to known origins
const PRODUCTION_ORIGINS = [
  'https://mercaria.co',
  'https://console.mercaria.co',
  'https://gateway.mercaria.co',
];

const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8081',
  'exp://localhost:8081',
  'http://10.0.2.2:8081',
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
app.use('/seller', sellerRouter);
app.use('/rates', ratesRouter);
app.use('/me', meRouter);
app.use('/admin', adminRouter);

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

// Process-level error handlers — prevent crashes from taking down all users.
process.on('unhandledRejection', (reason) => {
  // AbortError: intentional cancellation — suppress
  if (isAbortError(reason)) return;

  // Fatal: OOM, worker failures — must exit
  if (isFatalError(reason)) {
    log.general.error({ err: reason }, '[Process] FATAL unhandled rejection — shutting down');
    setTimeout(() => process.exit(1), 5000).unref();
    return;
  }

  // Transient network: ECONNRESET, ETIMEDOUT, etc.
  if (isTransientNetworkError(reason)) {
    log.general.warn({ err: reason }, '[Process] Transient network error (continuing)');
    return;
  }

  // Everything else: log as error but keep running
  log.general.error({ reason: reason instanceof Error ? reason : String(reason) }, '[Process] Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  log.general.error({ err: error }, '[Process] Uncaught exception — shutting down');
  setTimeout(() => process.exit(1), 5000).unref();
});

// Connect to MongoDB before starting the server
connectDB()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      log.general.info({ port: PORT }, `API Server running on http://0.0.0.0:${PORT}`);
      // Verify Redis connectivity (non-blocking)
      import('./lib/redis.js').then(({ getRedisClient }) => {
        const redis = getRedisClient();
        if (redis) {
          redis.ping()
            .then(() => log.general.info('Redis readiness check passed'))
            .catch((err) => log.general.warn({ err }, 'Redis readiness check failed — rate limiting will fail-open'));
        } else {
          log.general.info('Redis not configured (REDIS_URL not set) — rate limiting disabled');
        }
      }).catch((err) => log.general.error({ err }, 'Redis readiness import failed'));

      // Start marketplace queue workers when Redis is configured; otherwise
      // async jobs run inline via the producers.
      import('./queue/connection.js').then(({ isQueueEnabled }) => {
        if (isQueueEnabled()) {
          import('./queue/workers.js').then(({ startWorkers }) => startWorkers())
            .catch((err) => log.general.error({ err }, 'startWorkers import failed'));
        } else {
          log.general.info('Marketplace queue disabled (REDIS_URL not set) — async jobs run inline');
        }
      }).catch((err) => log.general.error({ err }, 'Queue connection import failed'));
    });

    // Graceful shutdown handler
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.general.info(`Received ${signal}. Starting graceful shutdown...`);

      // Stop accepting new connections
      server.close(() => {
        log.general.info('HTTP server closed (no new connections)');
      });

      // Give in-flight requests 30 seconds to complete
      const forceTimeout = setTimeout(() => {
        log.general.error('Force exit after 30s grace period');
        process.exit(1);
      }, 30_000);
      forceTimeout.unref();

      try {
        // Close Socket.IO connections
        const { getIO } = await import('./socket.js');
        const io = getIO();
        if (io) {
          await new Promise<void>((resolve) => io.close(() => resolve()));
          log.general.info('Socket.IO closed');
        }

        // Stop marketplace queue workers BEFORE closing Redis.
        const { shutdownQueues } = await import('./queue/workers.js');
        await shutdownQueues();
        log.general.info('Marketplace queues closed');

        // Close Redis connections
        const { closeRedis } = await import('./lib/redis.js');
        await closeRedis();
        log.general.info('Redis connections closed');

        // Close MongoDB connection
        const mongoose = await import('mongoose');
        await mongoose.default.connection.close();
        log.general.info('MongoDB connection closed');

        clearTimeout(forceTimeout);
        log.general.info('Graceful shutdown complete');
        process.exit(0);
      } catch (error) {
        log.general.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((error) => {
    log.general.error({ err: error }, 'Failed to connect to MongoDB');
    process.exit(1);
  });
