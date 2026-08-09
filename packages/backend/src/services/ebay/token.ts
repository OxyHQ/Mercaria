/**
 * The eBay client-credentials access token — issue #65 §"Authentication and
 * secret storage".
 *
 * ## The token is NEVER written down, and that is the security decision here
 *
 * Every other durable thing in this integration has a table. This one does not,
 * on purpose. A client-credentials token is a bearer credential with two hours
 * of life and a mint cost of one HTTP call; storing it would create a row that
 * grants API access on eBay's side, in a database whose backups, replicas and
 * operator surfaces would all then need to be reasoned about — to save a call
 * every two hours. A cache in memory dies with the task, is invisible to a
 * `pg_dump`, and cannot be read by anything that is not this process.
 *
 * The consequence is stated rather than hidden: N tasks mint N tokens, so the
 * fleet spends N token calls per two hours. eBay does not meter the token
 * endpoint against the Browse quota, and even if it did, N is single digits
 * against 5,000.
 *
 * ## The SECRET comes from the environment, resolved through the source's locator
 *
 * `catalog_source_configs.credential_ref` is `env:<NAME>` (#62's shape), and
 * this module reads `<NAME>_ID` / `<NAME>_SECRET` from the process environment.
 * Nothing here accepts a credential as an argument, nothing returns one, and the
 * errors name the VARIABLE and never its value.
 *
 * ## Concurrency: one in-flight mint per key, not one per caller
 *
 * Twenty concurrent pages on a cold cache would otherwise make twenty identical
 * token requests and eBay would answer some of them with a rate limit. The
 * in-flight promise is cached alongside the token, so the twentieth caller
 * awaits the first caller's request.
 */

import { CatalogSourceFetchError } from '../ingestion/adapter.js';
import {
  EBAY_API_HOST,
  EBAY_BROWSE_SCOPE,
  EBAY_TOKEN_EXPIRY_SKEW_MS,
  EBAY_TOKEN_PATH,
} from './constants.js';
import { classifyEbayResponse } from './errors.js';
import type { EbayTransport } from './http.js';

/** What a caller gets. A string, and nothing that could be logged by accident. */
export interface EbayAccessToken {
  readonly value: string;
  readonly expiresAt: Date;
}

/** The credential pair, in memory, for the duration of one mint. */
export interface EbayClientCredential {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * How a token is obtained. Injected into the adapter so a test never needs a
 * network, and so the ONE implementation that talks to eBay is this file.
 */
export interface EbayTokenProvider {
  getAccessToken(input: {
    environment: 'sandbox' | 'production';
    credential: EbayClientCredential;
    now: Date;
  }): Promise<EbayAccessToken>;
}

interface CacheEntry {
  token: EbayAccessToken | null;
  inFlight: Promise<EbayAccessToken> | null;
}

/**
 * Read the eBay credential a source's `credential_ref` names.
 *
 * Only the `env:` scheme is supported, and an unsupported one is refused rather
 * than falling back: `connection:` belongs to the connector domain (a merchant's
 * own shop credential, which an eBay application keyset is not) and `ssm:`
 * resolves at deploy time into the environment, which is what the ECS task
 * definition already does. A silent fallback would make a mis-typed locator
 * look like a missing secret.
 *
 * @throws CatalogSourceFetchError `auth_failure`, NOT retryable — a missing
 *   variable answers identically on every attempt, and retrying it would spend
 *   the daily budget re-asking.
 */
export function resolveEbayCredential(
  credentialRef: string | null,
  env: NodeJS.ProcessEnv,
): EbayClientCredential {
  if (credentialRef === null || !credentialRef.startsWith('env:')) {
    throw new CatalogSourceFetchError(
      'auth_failure',
      "The eBay source's credential_ref must name an environment variable (env:<NAME>)",
      { retryable: false },
    );
  }
  const name = credentialRef.slice('env:'.length);
  const clientId = env[`${name}_ID`];
  const clientSecret = env[`${name}_SECRET`];
  if (
    clientId === undefined ||
    clientId.trim() === '' ||
    clientSecret === undefined ||
    clientSecret.trim() === ''
  ) {
    throw new CatalogSourceFetchError(
      'auth_failure',
      `${name}_ID and ${name}_SECRET must both be set for the eBay source`,
      { retryable: false },
    );
  }
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

/**
 * Build a token provider over one transport.
 *
 * The cache is per PROVIDER instance rather than module-global, which is what
 * lets a test drive two environments in one process without one poisoning the
 * other — and which means a fake transport in the contract suite never touches
 * the cache a production instance would use.
 */
export function createEbayTokenProvider(transport: EbayTransport): EbayTokenProvider {
  const cache = new Map<string, CacheEntry>();

  async function mint(
    environment: 'sandbox' | 'production',
    credential: EbayClientCredential,
    now: Date,
  ): Promise<EbayAccessToken> {
    const url = `https://${EBAY_API_HOST[environment]}${EBAY_TOKEN_PATH}`;
    const basic = Buffer.from(`${credential.clientId}:${credential.clientSecret}`, 'utf8').toString(
      'base64',
    );
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: EBAY_BROWSE_SCOPE,
    }).toString();

    const response = await transport.postForm(
      url,
      {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    );

    if (response.status < 200 || response.status >= 300) {
      throw classifyEbayResponse({
        status: response.status,
        body: response.body,
        ...(response.headers['retry-after'] === undefined
          ? {}
          : { retryAfter: response.headers['retry-after'] }),
        now,
        context: 'eBay token exchange',
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new CatalogSourceFetchError('parse_failure', 'eBay token response was not JSON', {
        retryable: false,
      });
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new CatalogSourceFetchError('parse_failure', 'eBay token response was not an object', {
        retryable: false,
      });
    }
    const value = (parsed as { access_token?: unknown }).access_token;
    const expiresIn = (parsed as { expires_in?: unknown }).expires_in;
    if (typeof value !== 'string' || value.length === 0) {
      throw new CatalogSourceFetchError('parse_failure', 'eBay token response carried no token', {
        retryable: false,
      });
    }
    // A missing or absurd lifetime is treated as the shortest useful one rather
    // than trusted: a token cached for a lifetime eBay did not state is a 401 at
    // an unpredictable point in a page.
    const lifetimeMs =
      typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
        ? expiresIn * 1_000
        : EBAY_TOKEN_EXPIRY_SKEW_MS * 2;

    return { value, expiresAt: new Date(now.getTime() + lifetimeMs) };
  }

  return {
    async getAccessToken({ environment, credential, now }) {
      // The client id is enough to key the cache and is not a secret; the secret
      // is deliberately not part of the key, because a key containing it would
      // put it in a `Map` that a heap dump reads as plainly as a column.
      const key = `${environment}:${credential.clientId}`;
      const entry = cache.get(key) ?? { token: null, inFlight: null };
      cache.set(key, entry);

      const fresh =
        entry.token !== null &&
        entry.token.expiresAt.getTime() - EBAY_TOKEN_EXPIRY_SKEW_MS > now.getTime();
      if (fresh && entry.token !== null) return entry.token;

      if (entry.inFlight !== null) return entry.inFlight;

      const pending = mint(environment, credential, now)
        .then((token) => {
          entry.token = token;
          return token;
        })
        .finally(() => {
          entry.inFlight = null;
        });
      entry.inFlight = pending;
      return pending;
    },
  };
}
