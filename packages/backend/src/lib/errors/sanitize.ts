/**
 * Error Sanitization
 *
 * Generic secret scrubbing for user-facing error strings. (Provider-name
 * redaction from the previous AI product has been removed — there are no
 * upstream providers to hide.)
 */

/** Mask anything that looks like an API key, token, or secret. */
export function sanitizeMessage(message: string): string {
  return message
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|pk|api|key|token|secret)[-_]?[a-zA-Z0-9]{20,}\b/gi, '[REDACTED]');
}

/** Sanitize the message/error string fields of an arbitrary error-like object. */
export function sanitizeError<T>(error: T): T {
  if (!error) return error;

  if (typeof error === 'string') {
    return sanitizeMessage(error) as T;
  }

  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string') {
      record.message = sanitizeMessage(record.message);
    }
    if (typeof record.error === 'string') {
      record.error = sanitizeMessage(record.error);
    }
  }

  return error;
}

/** Safely extract a user-facing message from an unknown error. */
export function getSafeErrorMessage(error: unknown, fallback: string): string {
  return sanitizeMessage(error instanceof Error ? error.message : fallback);
}
