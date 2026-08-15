/**
 * Prove the seeded site is reachable through the connector's OWN transport —
 * not through curl, which shares none of its constraints.
 *
 * `verify.sh` establishes that the host resolves publicly and that the REST API
 * answers. That is necessary and it is not the same claim: the WooCommerce
 * provider dispatches through `woocommerce/http.ts`, which refuses any non-https
 * URL before a lookup and routes every call through `@oxyhq/core/server`'s
 * `safeFetch` — which re-validates each hop against the private/link-local/
 * metadata denylist and PINS the connection to the validated IP. A site curl can
 * reach and `safeFetch` refuses looks exactly like a working site until the
 * first sync fails.
 *
 * All three transport methods are exercised, because they are three different
 * code paths and only one of them is a GET:
 *   - `get`  → `safeFetch`
 *   - `post` → the IP-pinned raw `https.request` (webhook registration)
 *   - `del`  → `safeFetch` again, but the method WooCommerce gates differently
 *
 * The POST creates a real webhook in the `paused` state (so WooCommerce attempts
 * no delivery) and the DELETE removes it, so the probe leaves the site as it
 * found it.
 *
 * Run from `packages/backend`:
 *
 * ```sh
 * bun run scripts/e2e/woocommerce/verify-transport.ts
 * ```
 *
 * It reads the credential from the tokens file and prints NO secret.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { wooCommerceTransport } from '../../../src/connectors/woocommerce/http.js';

interface Credential {
  siteUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

const TOKEN_FILE =
  process.env.MERCARIA_WOO_E2E_TOKEN_FILE ??
  join(homedir(), '.config', 'oxy', 'tokens', 'mercaria-woo-e2e.json');

/** The exact header the provider builds: HTTP Basic over HTTPS. */
function authHeaders(credential: Credential): Record<string, string> {
  const basic = Buffer.from(
    `${credential.consumerKey}:${credential.consumerSecret}`,
    'utf8',
  ).toString('base64');
  return { Authorization: `Basic ${basic}`, Accept: 'application/json' };
}

function fail(message: string): never {
  console.error(`verify-transport: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const raw = await readFile(TOKEN_FILE, 'utf8').catch(() => {
    fail(`no credential at ${TOKEN_FILE} — run up.sh, seed.sh and issue-key.sh first`);
  });
  const credential = JSON.parse(raw) as Credential;
  if (!credential.siteUrl?.startsWith('https://')) {
    fail(`the recorded site URL is not https: ${credential.siteUrl}`);
  }

  // The provider's own base construction: `{site}/wp-json/wc/v3`.
  const restBase = `${credential.siteUrl.replace(/\/+$/, '')}/wp-json/wc/v3`;
  const headers = authHeaders(credential);

  console.log(`site       : ${credential.siteUrl}`);
  console.log(`REST base  : ${restBase}`);
  console.log('transport  : woocommerce/http.ts (safeFetch + 429 retry)');
  console.log('');

  // --- GET, the path every pull uses ---------------------------------------
  const products = await wooCommerceTransport.get(`${restBase}/products?per_page=1`, headers);
  console.log(`GET  /products?per_page=1        -> ${products.status}`);
  if (products.status !== 200) {
    fail(`the products endpoint answered ${products.status} through the real transport`);
  }
  const totalPages = products.headers['x-wp-totalpages'];
  const total = products.headers['x-wp-total'];
  console.log(`     X-WP-Total                  = ${total ?? '(absent)'}`);
  console.log(`     X-WP-TotalPages             = ${totalPages ?? '(ABSENT — runbook W9 applies)'}`);
  if (!total) {
    fail('X-WP-Total is absent through the real transport; pagination cannot be measured');
  }

  // The endpoint `verifyConnection` calls — this is what a real connect runs.
  const currency = await wooCommerceTransport.get(`${restBase}/data/currencies/current`, headers);
  console.log(`GET  /data/currencies/current    -> ${currency.status}`);
  if (currency.status !== 200) {
    fail(`verifyConnection's endpoint answered ${currency.status}`);
  }
  const currencyCode = (JSON.parse(currency.body) as { code?: string }).code;
  console.log(`     currency                    = ${currencyCode}`);
  if (currencyCode === 'USD' || currencyCode === 'FAIR') {
    fail(`the store currency is ${currencyCode}; the seed must use a currency that makes native-currency preservation observable`);
  }

  // --- POST, the path webhook registration uses ----------------------------
  const probeUrl = 'https://mercaria-transport-probe.invalid/hook';
  const created = await wooCommerceTransport.post(
    `${restBase}/webhooks`,
    { ...headers, 'Content-Type': 'application/json' },
    JSON.stringify({
      name: 'Mercaria transport probe',
      topic: 'product.updated',
      delivery_url: probeUrl,
      // Paused, so WooCommerce never attempts a delivery to the probe URL.
      status: 'paused',
    }),
  );
  console.log(`POST /webhooks                   -> ${created.status}`);
  if (created.status !== 201) {
    fail(
      `webhook registration answered ${created.status} through the IP-pinned POST path; ` +
        'a Read/Write key is required (runbook §4.2 step 2)',
    );
  }
  const webhookId = (JSON.parse(created.body) as { id?: number }).id;
  if (!webhookId) {
    fail('the created webhook carried no id');
  }

  // --- DELETE, the path disconnect uses ------------------------------------
  const deleted = await wooCommerceTransport.del(
    `${restBase}/webhooks/${webhookId}?force=true`,
    headers,
  );
  console.log(`DEL  /webhooks/${webhookId}${' '.repeat(Math.max(0, 18 - String(webhookId).length))}-> ${deleted.status}`);
  if (deleted.status !== 200) {
    fail(`the probe webhook ${webhookId} could not be deleted (${deleted.status}); remove it by hand`);
  }

  console.log('');
  console.log('OK — GET, POST and DELETE all succeed through the connector transport.');
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
});
