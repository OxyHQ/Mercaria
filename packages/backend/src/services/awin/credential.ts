/**
 * Turning a stored LOCATOR into the key one Awin call needs (#66).
 *
 * `awin_accounts.feed_credential_ref` holds `env:<NAME>` or `ssm:<path>`,
 * shape-CHECKed and length-bounded so a pasted key is refused by the database
 * rather than by a reviewer — #62's `catalog_source_configs.credential_ref`
 * decision, unchanged.
 *
 * ## `env:` resolves and the other two REFUSE, by name
 *
 * Mercaria's own pipeline is GitHub Actions repo secrets → SSM
 * `/oxy/mercaria/*` → the ECS task definition's environment, so by the time this
 * process runs, an SSM parameter IS an environment variable. `env:` is
 * therefore the real path and is the only one implemented.
 *
 * `ssm:` and `connection:` are refused with a reason that NAMES the scheme
 * rather than falling back to anything. A fallback here would be a second
 * answer to "where does this key live", and the one that would eventually be
 * wrong is the silent one — a deployment that thought it was reading a rotated
 * SSM parameter and was reading a stale environment variable instead.
 *
 * ## The value never leaves this module in a form anything logs
 *
 * The resolved key goes straight into a URL by `awinFeedListUrl` /
 * `awinFeedDownloadUrl`, and that URL is treated as a credential everywhere
 * afterwards: `redactFeedUrl` is what reaches a log line, a projection or an
 * error message. Nothing here returns a key to a caller that stores one.
 */

/** A resolved key, or the reason there is none. A union, so neither is optional. */
export type AwinCredentialResolution =
  | { readonly kind: 'resolved'; readonly secret: string }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'not_configured' | 'unsupported_scheme' | 'empty_value';
      /** The SCHEME or the variable NAME — never the value, and never a prefix of it. */
      readonly detail: string;
    };

/**
 * Read the key one locator names.
 *
 * The empty-value case is separate from the absent one on purpose: a deployment
 * that set `AWIN_FEED_API_KEY=` has a variable and no key, which is the shape a
 * placeholder secret takes (`~/Oxy/AGENTS.md`: never set a secret to a
 * placeholder — a sync job overwrites the real value and crashes prod). Telling
 * it apart from "nobody configured this" is what sends somebody to the right
 * place.
 */
export function resolveAwinCredential(locator: string | null): AwinCredentialResolution {
  if (locator === null || locator.trim() === '') {
    return { kind: 'unavailable', reason: 'not_configured', detail: 'no locator recorded' };
  }

  const separator = locator.indexOf(':');
  const scheme = separator === -1 ? locator : locator.slice(0, separator);
  const target = separator === -1 ? '' : locator.slice(separator + 1);

  if (scheme !== 'env') {
    return { kind: 'unavailable', reason: 'unsupported_scheme', detail: scheme };
  }

  const value = process.env[target]?.trim() ?? '';
  if (value === '') {
    return { kind: 'unavailable', reason: 'empty_value', detail: target };
  }
  return { kind: 'resolved', secret: value };
}
