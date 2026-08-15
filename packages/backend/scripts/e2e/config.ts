/**
 * Inputs to the #69 real-store driver, resolved once and refused loudly.
 *
 * Every value is read from the environment or from a mode-600 credential file
 * the provisioning side writes. Nothing here has a DEFAULT that could stand in
 * for a real credential: a driver that invents a site URL or a token produces
 * evidence about nothing, and the whole point of #69 is that the existing
 * suites already cover everything a fixture can say.
 */

import { readFile, stat } from 'node:fs/promises';

/** The WooCommerce site the provisioning agent stood up. */
export interface WooCredentials {
  /** `https://…` — the provider's transport refuses plain http. */
  readonly siteUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
}

/** Everything the driver needs in order to run. */
export interface DriverConfig {
  readonly apiBaseUrl: string;
  readonly databaseUrl: string;
  readonly redisUrl: string | null;
  readonly oxyAccessToken: string | null;
  readonly oxyUserId: string | null;
  readonly evidenceDir: string;
  readonly wooCredentialsFile: string;
  readonly defaultCategorySlug: string;
  /** The PUBLIC base the platform delivers webhooks to, when one is configured. */
  readonly publicBaseUrl: string | null;
}

/** Read a required environment variable or throw naming it. */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. See packages/backend/.env.e2e.example.`);
  }
  return value;
}

/** Read an optional environment variable, normalising empty to null. */
function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** Resolve the driver's configuration from the environment. */
export function readDriverConfig(): DriverConfig {
  return {
    apiBaseUrl: (optional('E2E_API_BASE_URL') ?? 'http://127.0.0.1:4169').replace(/\/+$/, ''),
    databaseUrl: required('DATABASE_URL'),
    redisUrl: optional('REDIS_URL'),
    oxyAccessToken: optional('E2E_OXY_ACCESS_TOKEN'),
    oxyUserId: optional('E2E_OXY_USER_ID'),
    evidenceDir: required('E2E_EVIDENCE_DIR'),
    wooCredentialsFile:
      optional('E2E_WOO_CREDENTIALS_FILE') ??
      '/home/nate/.config/oxy/tokens/mercaria-woo-e2e.json',
    defaultCategorySlug: optional('CONNECTOR_DEFAULT_CATEGORY_SLUG') ?? 'home',
  publicBaseUrl: optional('CONNECTOR_OAUTH_REDIRECT_BASE_URL'),
  };
}

/**
 * Why the WooCommerce credentials could not be read.
 *
 * A STRING discriminant rather than a boolean: this package compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on a boolean-literal discriminant — so `if (!result.ok)` would leave the
 * caller holding the whole union. The #68 finding, and the caller here really
 * does act on the difference (a missing file is "not provisioned yet"; a
 * malformed one is a defect on the provisioning side).
 */
export type WooCredentialsResult =
  | { readonly outcome: 'available'; readonly credentials: WooCredentials }
  | { readonly outcome: 'absent'; readonly path: string }
  | { readonly outcome: 'unreadable'; readonly path: string; readonly reason: string };

/**
 * Load `{siteUrl, consumerKey, consumerSecret}` from the credential file.
 *
 * REFUSES rather than repairing: a site URL that is not `https:` would be
 * rejected by `connectKeyChannelSchema` anyway, and reporting it here names the
 * problem where somebody can fix it. Never logs the file's contents.
 */
export async function loadWooCredentials(path: string): Promise<WooCredentialsResult> {
  try {
    await stat(path);
  } catch {
    return { outcome: 'absent', path };
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    return { outcome: 'unreadable', path, reason: `could not read: ${(err as Error).name}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { outcome: 'unreadable', path, reason: 'not valid JSON' };
  }

  const candidate = parsed as Partial<WooCredentials>;
  const missing = (['siteUrl', 'consumerKey', 'consumerSecret'] as const).filter(
    (key) => typeof candidate[key] !== 'string' || !candidate[key]?.trim(),
  );
  if (missing.length > 0) {
    return { outcome: 'unreadable', path, reason: `missing field(s): ${missing.join(', ')}` };
  }

  let siteUrl: string;
  try {
    const url = new URL(candidate.siteUrl.trim());
    if (url.protocol !== 'https:') {
      return {
        outcome: 'unreadable',
        path,
        reason: `siteUrl is ${url.protocol}//… — the WooCommerce transport refuses plain http`,
      };
    }
    siteUrl = url.origin;
  } catch {
    return { outcome: 'unreadable', path, reason: 'siteUrl is not a URL' };
  }

  return {
    outcome: 'available',
    credentials: {
      siteUrl,
      consumerKey: candidate.consumerKey.trim(),
      consumerSecret: candidate.consumerSecret.trim(),
    },
  };
}
