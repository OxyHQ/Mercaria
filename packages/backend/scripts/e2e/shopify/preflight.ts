/**
 * #69 Shopify verification preflight: refuse to start a run that would measure
 * the wrong thing.
 *
 * Everything here is checked BEFORE a human spends an hour seeding a store,
 * because each of these failures is invisible once the run is under way:
 *
 *  - a missing `CONNECTOR_ENCRYPTION_KEY` fails at `decryptAuth`, which is
 *    AFTER a connect that reported success;
 *  - a `CONNECTOR_OAUTH_REDIRECT_BASE_URL` that disagrees with the Shopify app
 *    produces a callback Shopify refuses, which reads as a connector bug;
 *  - the API's `SHOPIFY_CLIENT_ID` disagreeing with the credential file means
 *    the run authorizes against a DIFFERENT app than the evidence names;
 *  - a RETIRED `API_VERSION` does not 404. Shopify "falls forward and responds
 *    using the oldest accessible stable version", so every request SUCCEEDS and
 *    the evidence names a version the wire never served. That is the one
 *    failure here that produces a clean, wrong report, so it is a hard refusal.
 *
 * Run:  bun run packages/backend/scripts/e2e/shopify/preflight.ts
 *
 * Exit 0 = safe to proceed. Any other exit = do not start the run.
 */

import { API_VERSION } from '../../../src/connectors/shopify/index.js';
import { SHOPIFY_DEFAULT_SCOPES } from '../../../src/connectors/shopify/config.js';
import {
  describeCredentialsProblem,
  loadShopifyCredentials,
  shopifyCredentialsPath,
} from './credentials.js';
import { describeServedApiVersion, probeServedApiVersion } from './api-version.js';

/** Emit one line. `console` is banned in this repo; the scripts use stdout. */
function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Env vars with no default, and what breaks when each is absent.
 *
 * The consequence is part of the entry because a refusal that only names a
 * variable sends somebody to set it without knowing what it was protecting.
 * The `E2E_*` names are the shared driver harness's, not a second convention.
 */
const REQUIRED_ENV: ReadonlyArray<{ name: string; because: string }> = [
  { name: 'SHOPIFY_CLIENT_ID', because: 'the API cannot build the OAuth authorize URL' },
  {
    name: 'SHOPIFY_CLIENT_SECRET',
    because: 'token exchange AND every webhook/callback HMAC fail',
  },
  {
    name: 'CONNECTOR_OAUTH_REDIRECT_BASE_URL',
    because: 'the redirect URL and the webhook address are derived from it',
  },
  { name: 'CONNECTOR_OAUTH_STATE_SECRET', because: 'the OAuth state cannot be signed' },
  {
    name: 'CONNECTOR_ENCRYPTION_KEY',
    because: 'the access token cannot be stored — and this fails AFTER connect reports success',
  },
  { name: 'DATABASE_URL', because: 'the API does not boot' },
  { name: 'E2E_API_BASE_URL', because: 'the driver has nothing to call' },
  { name: 'E2E_OXY_ACCESS_TOKEN', because: 'every admin route answers 401' },
  { name: 'E2E_STORE_ID', because: 'the channel routes are store-scoped' },
  { name: 'E2E_EVIDENCE_DIR', because: 'there is nowhere to write the evidence' },
];

/**
 * When `version` stops being served AS ITSELF, derived from Shopify's published
 * cadence rather than from a table somebody has to maintain.
 *
 * Shopify releases quarterly on the first of the month and supports each stable
 * version for a minimum of 12 months; the documented "accessible until" dates
 * are the 16th of the month 12 months after release (2025-07 -> 2026-07-16,
 * 2026-01 -> 2027-01-16). Deriving it is what stops this check rotting into a
 * list that silently falls behind Shopify's schedule — and a stale list fails in
 * the PERMISSIVE direction, reporting a retired version as fine.
 *
 * Source: https://shopify.dev/docs/api/usage/versioning
 */
function accessibleUntil(version: string): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(version);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month !== 1 && month !== 4 && month !== 7 && month !== 10) return null;
  return new Date(Date.UTC(year + 1, month - 1, 16));
}

const problems: string[] = [];

say('');
say('=== #69 Shopify verification preflight ===');
say('');

// ── 1. The credential file (the HUMAN handoff) ───────────────────────────────
say('1. Shopify credential file');
const credentialsPath = shopifyCredentialsPath();
const credentialsResult = await loadShopifyCredentials(credentialsPath);
say(`   ${credentialsPath}`);
if (credentialsResult.outcome === 'available') {
  say(`   ok       readable, mode 600, shopDomain ${credentialsResult.credentials.shopDomain}`);
} else {
  say(`   PROBLEM  ${credentialsResult.outcome}`);
  problems.push(describeCredentialsProblem(credentialsResult));
}

// ── 2. Environment ───────────────────────────────────────────────────────────
say('');
say('2. Environment');
for (const { name, because } of REQUIRED_ENV) {
  if (!process.env[name]?.trim()) {
    problems.push(`${name} is not set — ${because}`);
    say(`   MISSING  ${name}`);
  } else {
    say(`   ok       ${name}`);
  }
}

const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY?.trim() ?? '';
if (encryptionKey && !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
  problems.push(
    'CONNECTOR_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). A ' +
      'malformed key fails at the first Shopify call, after connect reported success.',
  );
}

// The API reads its Shopify credentials from the ENVIRONMENT; the file is the
// human handoff. If they disagree, the run authorizes against one app and the
// evidence names another — and both halves look entirely healthy.
if (credentialsResult.outcome === 'available') {
  const envClientId = process.env.SHOPIFY_CLIENT_ID?.trim();
  const envSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
  if (envClientId && envClientId !== credentialsResult.credentials.clientId) {
    problems.push(
      'SHOPIFY_CLIENT_ID in the environment does not match the credential file. The ' +
        'API would authorize against a different Shopify app than the evidence names, ' +
        'and nothing downstream could tell.',
    );
  }
  if (envSecret && envSecret !== credentialsResult.credentials.clientSecret) {
    problems.push(
      'SHOPIFY_CLIENT_SECRET in the environment does not match the credential file. ' +
        'Webhook HMACs would be computed with one secret and signed with another, so ' +
        'every delivery is refused as a forgery.',
    );
  }
}

const base = process.env.CONNECTOR_OAUTH_REDIRECT_BASE_URL?.trim() ?? '';
if (base.endsWith('/')) {
  problems.push(
    'CONNECTOR_OAUTH_REDIRECT_BASE_URL has a TRAILING SLASH. The derived URLs become ' +
      '"//channels/..." and Shopify refuses the callback.',
  );
}
if (base && !base.startsWith('https://')) {
  problems.push(
    'CONNECTOR_OAUTH_REDIRECT_BASE_URL is not https. Shopify will not call back to a ' +
      'plain-http redirect URL.',
  );
}

// ── 3. The URLs the Shopify app must carry ───────────────────────────────────
say('');
say('3. The two URLs the Shopify app must be configured with');
if (base) {
  say(`   redirect URL:  ${base}/channels/oauth/shopify/callback`);
  say(`   webhook URL:   ${base}/channels/webhooks/shopify`);
  say('   Both are DERIVED (connectors/config.ts). If either differs from the');
  say('   Shopify dashboard, stop — every scenario would fail for that reason.');
} else {
  say('   (cannot derive — CONNECTOR_OAUTH_REDIRECT_BASE_URL is unset)');
}

// ── 4. Scopes ────────────────────────────────────────────────────────────────
say('');
say('4. Scopes this deployment will REQUEST');
const configured = process.env.SHOPIFY_SCOPES?.trim();
const scopes = configured
  ? configured
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  : [...SHOPIFY_DEFAULT_SCOPES];
say(`   ${scopes.join(',')}`);

if (configured) {
  const narrowed = SHOPIFY_DEFAULT_SCOPES.filter((scope) => !scopes.includes(scope));
  if (narrowed.length > 0) {
    say('');
    say(`   NOTE: narrower than the code default (omits ${narrowed.join(', ')}).`);
    say('   That is a supported choice. Shopify will REFUSE each webhook topic whose');
    say('   read scope is missing; expect webhookFailures to name them and the');
    say('   readiness catalogue axis to read "degraded". Record them rather than');
    say('   treating them as a connector fault.');
  }
}

if (scopes.includes('read_all_orders')) {
  problems.push(
    'SHOPIFY_SCOPES requests read_all_orders. Shopify grants it only on approval ' +
      '(Partner dashboard -> app -> API access -> Request access). If it was not ' +
      'approved for THIS app the whole OAuth grant is refused rather than narrowed, ' +
      'so connect fails outright.',
  );
} else {
  say('');
  say('   NOT requested, and it bounds what S7 can show:');
  say('     read_all_orders — without it GET /orders.json serves only the last 60 DAYS');
  say('     of orders. Test orders placed during the run are minutes old and are');
  say('     unaffected; a backfill of an OLDER catalogue is silently truncated, and a');
  say('     truncated import looks exactly like a complete one. Recorded, not worked');
  say('     around: the scope needs Shopify approval and is not needed to verify the');
  say('     connector.');
}

// ── 5. The pinned API version ────────────────────────────────────────────────
say('');
say('5. Shopify Admin API version pinned by the code');
say(`   API_VERSION = ${API_VERSION}  (connectors/shopify/index.ts)`);
const until = accessibleUntil(API_VERSION);
if (!until) {
  problems.push(
    `API_VERSION "${API_VERSION}" is not a recognisable Shopify quarterly version ` +
      '(YYYY-01 / -04 / -07 / -10), so whether Shopify still serves it cannot be judged.',
  );
} else {
  say(`   served as itself until ~${until.toISOString().slice(0, 10)} (derived)`);

  // The DERIVED date says what Shopify's schedule implies; the header says what
  // Shopify is actually doing. Ask, rather than infer, whenever there is a shop
  // to ask — a retired pin does not fail, so the header is the only evidence.
  if (credentialsResult.outcome === 'available') {
    const probe = await probeServedApiVersion(
      credentialsResult.credentials.shopDomain,
      API_VERSION,
    );
    say(`   read back: ${describeServedApiVersion(probe)}`);
    if (probe.outcome === 'served' && probe.served !== API_VERSION) {
      problems.push(
        `Shopify SERVED ${probe.served} for a request pinned at ${API_VERSION} — measured, ` +
          'not derived. Every scenario would run against a version nobody selected.',
      );
    }
  }

  if (new Date() >= until) {
    problems.push(
      `API_VERSION ${API_VERSION} is RETIRED (past ~${until.toISOString().slice(0, 10)}). ` +
        'Shopify does not 404 an unsupported version — it falls forward and responds ' +
        'using the oldest accessible stable version. Every request will SUCCEED, and ' +
        'the evidence will name a version the wire never served, so the run cannot say ' +
        'which version it measured. Fix the pin (and re-check the REST product/order ' +
        'shapes for that version) before verifying anything. ' +
        'https://shopify.dev/docs/api/usage/versioning',
    );
  }
}

// ── Verdict ──────────────────────────────────────────────────────────────────
say('');
if (problems.length === 0) {
  say('PREFLIGHT PASSED — safe to run drive.ts.');
  say('');
} else {
  say(`PREFLIGHT FAILED — ${problems.length} problem(s):`);
  say('');
  for (const [index, problem] of problems.entries()) {
    say(`  ${index + 1}. ${problem}`);
  }
  say('');
  say('Nothing was measured. Fix these before seeding a store or starting a run.');
  process.exitCode = 1;
}
