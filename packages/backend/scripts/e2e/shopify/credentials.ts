/**
 * How a Shopify #69 verification credential is read, and what makes one
 * unusable.
 *
 * The Shopify half of the run needs three secrets that a human obtains from the
 * Shopify Dev Dashboard and hands back: the app's client id, its client secret,
 * and the dev store's `*.myshopify.com` host. They arrive in a mode-600 JSON
 * file under `~/.config/oxy/tokens/`, which is the Oxy rule for every secret —
 * never a repo file, never an environment block pasted into an issue, never a
 * PR comment.
 *
 * Both entrypoints read them through here — `preflight.ts` to refuse a run that
 * cannot work, `drive.ts` to perform one. Two readers with two copies of the
 * validation would eventually disagree about what a valid credential is, and the
 * direction that disagreement goes is a run that starts and fails halfway.
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** What a human hands back after creating the Shopify app and dev store. */
export interface ShopifyCredentials {
  /** Shopify "Client ID" (older UI: "API key"). */
  readonly clientId: string;
  /** Shopify "Client secret" — token exchange AND every HMAC. */
  readonly clientSecret: string;
  /** The dev store, `*.myshopify.com`. */
  readonly shopDomain: string;
}

/**
 * Why the credentials could not be used.
 *
 * A STRING discriminant rather than a boolean: this package compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on a boolean-literal discriminant, so `if (!result.ok)` would leave the
 * caller holding the whole union (the #68 finding, and `config.ts` records the
 * same one). The caller genuinely acts on the difference — `absent` means the
 * human step has not happened yet, `insecure` means it happened wrongly, and
 * `unreadable` is a defect in what was written.
 */
export type ShopifyCredentialsResult =
  | { readonly outcome: 'available'; readonly credentials: ShopifyCredentials }
  | { readonly outcome: 'absent'; readonly path: string }
  | { readonly outcome: 'insecure'; readonly path: string; readonly mode: string }
  | { readonly outcome: 'unreadable'; readonly path: string; readonly reason: string };

/** Where the credential file lives unless `E2E_SHOPIFY_CREDENTIALS_FILE` says otherwise. */
export function shopifyCredentialsPath(): string {
  return (
    process.env.E2E_SHOPIFY_CREDENTIALS_FILE?.trim() ||
    path.join(homedir(), '.config', 'oxy', 'tokens', 'mercaria-shopify-e2e.json')
  );
}

/**
 * Load and validate the credential file.
 *
 * REFUSES rather than repairing, and never logs the file's contents. The mode
 * check is not hygiene: this file holds a secret that signs every webhook this
 * deployment will accept, and a group- or world-readable copy on a shared box is
 * a disclosure that no later redaction can undo.
 */
export async function loadShopifyCredentials(
  filePath: string,
): Promise<ShopifyCredentialsResult> {
  let mode: number;
  try {
    mode = (await stat(filePath)).mode & 0o777;
  } catch {
    return { outcome: 'absent', path: filePath };
  }

  if ((mode & 0o077) !== 0) {
    return { outcome: 'insecure', path: filePath, mode: mode.toString(8).padStart(3, '0') };
  }

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    return { outcome: 'unreadable', path: filePath, reason: `could not read: ${(err as Error).name}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { outcome: 'unreadable', path: filePath, reason: 'not valid JSON' };
  }

  const candidate = parsed as Partial<ShopifyCredentials>;
  const missing = (['clientId', 'clientSecret', 'shopDomain'] as const).filter(
    (key) => typeof candidate[key] !== 'string' || !candidate[key]?.trim(),
  );
  if (missing.length > 0) {
    return { outcome: 'unreadable', path: filePath, reason: `missing field(s): ${missing.join(', ')}` };
  }

  const shopDomain = candidate.shopDomain.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
    return {
      outcome: 'unreadable',
      path: filePath,
      reason:
        `shopDomain "${shopDomain}" is not a *.myshopify.com host. connectChannelSchema ` +
        'refuses it, and it is also the SSRF host allow-list — a custom storefront ' +
        'domain is rejected on purpose, so use the admin host.',
    };
  }

  return {
    outcome: 'available',
    credentials: {
      clientId: candidate.clientId.trim(),
      clientSecret: candidate.clientSecret.trim(),
      shopDomain,
    },
  };
}

/** One line an operator can act on, naming no secret. */
export function describeCredentialsProblem(result: ShopifyCredentialsResult): string {
  switch (result.outcome) {
    case 'available':
      return '';
    case 'absent':
      return (
        `No Shopify credential file at ${result.path}. This is the HUMAN step: ` +
        'create the Partner/Dev Dashboard app and the dev store, then write the file ' +
        '(see README §"Where the secrets live"). Nothing can run without it.'
      );
    case 'insecure':
      return (
        `${result.path} has mode ${result.mode}. It holds the secret that signs every ` +
        'webhook this deployment accepts. Fix with: chmod 600 ' +
        `${result.path}`
      );
    case 'unreadable':
      return `${result.path} cannot be used: ${result.reason}`;
  }
}
