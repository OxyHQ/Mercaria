/**
 * Credential and signed-URL redaction (#63 security 5).
 *
 * ## A feed URL is a credential in this domain
 *
 * The networks that matter carry the key IN the URL: Awin's product-feed
 * download is `https://productdata.awin.com/datafeed/list/apikey/<KEY>`, and
 * several others use a query parameter. So "redact credentials and signed feed
 * URLs from logs and public APIs" is not two rules — treating the URL as a
 * credential is the only reading that survives contact with a real network, and
 * it is why `feed_configuration_versions.feed_url` is registered in
 * `protectedColumns.ts` beside the AES envelope.
 *
 * ## Everything after the host goes
 *
 * Not the query string, not "parameters that look like keys": the whole path
 * and query. A denylist of key-shaped parameter names is correct until the
 * network renames one, which is exactly when a credential appears in a log. The
 * HOST is kept because it is the useful half — it tells an operator which
 * provider a refusal is about — and it is not the secret.
 *
 * ## The redactor is TOTAL
 *
 * A value that will not parse as a URL is replaced entirely rather than passed
 * through. A malformed URL is the one most likely to be a pasted token, and
 * "could not parse it, so I logged it" is how a secret reaches a log line.
 */

import { FEED_REDACTED_PLACEHOLDER } from '@mercaria/shared-types';

/** `https://host/[redacted]` — the host, and nothing else. */
export function redactFeedUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return FEED_REDACTED_PLACEHOLDER;
  }
  return `${parsed.protocol}//${parsed.host}/${FEED_REDACTED_PLACEHOLDER}`;
}

/**
 * Strip anything URL-shaped out of a message before it is logged or stored.
 *
 * Composed messages in this domain never interpolate a URL, and this is the
 * belt-and-braces pass over the ones that come from somewhere else — a driver's
 * error text, a provider's response line. The pattern is anchored on the scheme
 * so ordinary prose is untouched, and the replacement keeps the host for the
 * same reason {@link redactFeedUrl} does.
 */
export function redactFeedMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/gu, (match) => redactFeedUrl(match) ?? FEED_REDACTED_PLACEHOLDER);
}

/** A message bounded to what `feed_import_reports.failure_note` accepts. */
export function boundedFailureNote(message: string, limit: number): string {
  const redacted = redactFeedMessage(message);
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit - 1)}…`;
}
