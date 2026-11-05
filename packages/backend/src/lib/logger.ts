/**
 * Structured Logger for Mercaria API
 *
 * Uses pino for production-grade JSON logging with:
 * - Automatic pretty printing in development
 * - JSON output in production (for log aggregators)
 * - Sensitive data redaction (API keys, tokens)
 * - Subsystem child loggers
 *
 * Inspired by OpenClaw's logging patterns, adapted for server-side production use.
 */

import pino from 'pino';

// Patterns to redact from log output
export const REDACT_PATHS = [
  'apiKey',
  'token',
  'authorization',
  'password',
  'secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.cookie',
  '*.headers.cookie',
  'headers["x-mercaria-guest-token"]',
  'req.headers["x-mercaria-guest-token"]',
  '*.headers["x-mercaria-guest-token"]',
  'headers["x-mercaria-portal-token"]',
  'req.headers["x-mercaria-portal-token"]',
  '*.headers["x-mercaria-portal-token"]',
  'headers["x-mercaria-referral-state"]',
  'req.headers["x-mercaria-referral-state"]',
  '*.headers["x-mercaria-referral-state"]',
  'headers["X-Mercaria-Guest-Token"]',
  '*.headers["X-Mercaria-Guest-Token"]',
  'headers["X-Mercaria-Portal-Token"]',
  '*.headers["X-Mercaria-Portal-Token"]',
  'headers["X-Mercaria-Referral-State"]',
  '*.headers["X-Mercaria-Referral-State"]',
  'req.headers["x-api-key"]',
  'accessToken',
  '*.accessToken',
  'body.accessToken',
  'req.body.accessToken',
  'requesterToken',
  '*.requesterToken',
  'body.requesterToken',
  'req.body.requesterToken',
  'subjectToken',
  '*.subjectToken',
  'body.subjectToken',
  'req.body.subjectToken',
  'requesterContext',
  '*.requesterContext',
  'body.requesterContext',
  'req.body.requesterContext',
  'capabilityTicket',
  '*.capabilityTicket',
  'body.capabilityTicket',
  'req.body.capabilityTicket',
  'connectionToken',
  '*.connectionToken',
  'body.connectionToken',
  'req.body.connectionToken',
  'presentedServiceToken',
  '*.presentedServiceToken',
  'body.presentedServiceToken',
  'req.body.presentedServiceToken',
  'presentedRequesterContext',
  '*.presentedRequesterContext',
  'body.presentedRequesterContext',
  'req.body.presentedRequesterContext',
  'ticket',
  '*.ticket',
  'body.ticket',
  'req.body.ticket',
  'headers["x-oxy-requester-token"]',
  'req.headers["x-oxy-requester-token"]',
  '*.headers["x-oxy-requester-token"]',
  'headers["x-oxy-task-id"]',
  'req.headers["x-oxy-task-id"]',
  '*.headers["x-oxy-task-id"]',
  'headers["x-oxy-capability-ticket"]',
  'req.headers["x-oxy-capability-ticket"]',
  '*.headers["x-oxy-capability-ticket"]',
  'headers["x-oxy-media-token"]',
  'req.headers["x-oxy-media-token"]',
  '*.headers["x-oxy-media-token"]',
  'headers["x-oxy-requester-context"]',
  'req.headers["x-oxy-requester-context"]',
  '*.headers["x-oxy-requester-context"]',
  'headers["x-oxy-presented-requester-context"]',
  'req.headers["x-oxy-presented-requester-context"]',
  '*.headers["x-oxy-presented-requester-context"]',
  'headers["x-oxy-presented-service-token"]',
  'req.headers["x-oxy-presented-service-token"]',
  '*.headers["x-oxy-presented-service-token"]',
  'req.serviceActingAs.requesterContext',
];

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Root logger instance.
 * - Development: pretty-printed with colors
 * - Production: JSON (fast, machine-parseable)
 */
const rootLogger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : {
        // Production: raw JSON to stdout for log aggregators
        formatters: {
          level(label: string) {
            return { level: label };
          },
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }),
});

/**
 * Create a child logger with a subsystem label.
 *
 * Usage:
 *   const log = createLogger('auth');
 *   log.info({ userId }, 'User authenticated');
 *   log.error({ err }, 'Auth failed');
 */
export function createLogger(subsystem: string) {
  return rootLogger.child({ subsystem });
}

/**
 * Sanitize a string by removing potential API keys and tokens.
 * Use as a safety net before logging user-facing messages.
 */
export function sanitizeForLog(value: string): string {
  return (
    value
      // Bearer tokens
      .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED]')
      // Mercaria developer keys
      .replace(/mercaria_sk_[a-zA-Z0-9_-]+/g, 'mercaria_sk_[REDACTED]')
      // Generic sk- / key- prefixed secrets
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-[REDACTED]')
      .replace(/key-[a-zA-Z0-9]{20,}/g, 'key-[REDACTED]')
  );
}

// Pre-built loggers for common subsystems
export const log = {
  auth: createLogger('auth'),
  guest: createLogger('guest'),
  health: createLogger('health'),
  moderation: createLogger('moderation'),
  general: rootLogger,
};

export default rootLogger;
