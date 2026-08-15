/**
 * Drive the REAL WooCommerce provider against the REAL site, over a real socket.
 *
 * This is NOT a scenario run and its output must never be recorded as one. §7's
 * scenarios are properties of the whole system — the admin route, the store
 * permission gate, the sync service, the catalog-write funnels and Postgres —
 * and this probe exercises none of those. What it DOES exercise is the layer the
 * contract suite explicitly cannot testify about (`connector-contract-suite.ts`
 * fakes the socket and says so), which is the wire:
 *
 *   - does a real WordPress publish `X-WP-TotalPages`, and with what value;
 *   - does it publish `date_modified_gmt` WITHOUT a zone suffix, which is what
 *     `connectors/timestamps.ts` appends `Z` to and #221 got wrong in both
 *     directions;
 *   - does a real variation report `manage_stock: 'parent'` — a branch the
 *     provider has and no fixture in this repository has ever produced;
 *   - does `createWooCommerceProvider`'s own zod schema accept the shapes a real
 *     site emits, or reject them.
 *
 * It is READ-ONLY. It calls `verifyConnection` and `fetchProducts` and nothing
 * that writes, so it can be run against a site somebody else is using without
 * changing anything on it.
 *
 * Run:
 *   set -a; . packages/backend/.env.e2e; set +a
 *   bun run --cwd packages/backend scripts/e2e/probe-woocommerce-provider.ts
 */

import { ALL_CURRENCY_CODES } from '@mercaria/shared-types';
import { createWooCommerceProvider } from '../../src/connectors/woocommerce/index.js';
import type { ConnectorAuth, ConnectorCredentials } from '../../src/connectors/types.js';
import { loadWooCredentials, readDriverConfig } from './config.js';
import { redactUrl } from './redact.js';

/** What one probe of the real site established. */
export interface ProbeReport {
  readonly site: string | null;
  readonly verify:
    | { readonly outcome: 'ok'; readonly shopCurrency: string; readonly externalShopId: string }
    | { readonly outcome: 'failed'; readonly error: string };
  readonly firstPage:
    | {
        readonly outcome: 'ok';
        readonly productCount: number;
        readonly hasNextCursor: boolean;
        readonly variantCounts: readonly number[];
        readonly currencies: readonly string[];
        readonly withExternalUpdatedAt: number;
        readonly incompleteVariantSets: number;
      }
    | { readonly outcome: 'failed'; readonly error: string }
    | { readonly outcome: 'skipped'; readonly reason: string };
}

/**
 * Probe the real site and RETURN the report, so the driver can fold these wire
 * facts into its evidence artefact rather than leaving them in a second output
 * nobody correlates.
 */
export async function probeWooCommerceWire(input: {
  readonly siteUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
}): Promise<ProbeReport> {
  const { siteUrl, consumerKey, consumerSecret } = input;
  return runProbe(siteUrl, consumerKey, consumerSecret);
}

async function main(): Promise<void> {
  const config = readDriverConfig();
  const credentials = await loadWooCredentials(config.wooCredentialsFile);

  if (credentials.outcome !== 'available') {
    process.stdout.write(
      `WooCommerce credentials unavailable (${credentials.outcome}); nothing to probe.\n`,
    );
    process.exitCode = 0;
    return;
  }

  const { siteUrl, consumerKey, consumerSecret } = credentials.credentials;
  const result = await runProbe(siteUrl, consumerKey, consumerSecret);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.verify.outcome === 'ok' ? 0 : 1;
}

/** The probe itself, shared by the CLI entrypoint and {@link probeWooCommerceWire}. */
async function runProbe(
  siteUrl: string,
  consumerKey: string,
  consumerSecret: string,
): Promise<ProbeReport> {

  // The pair joins into HTTP Basic userinfo, exactly as `connector-sync.service`
  // composes it from the decrypted credential blob. Composing it the same way
  // here is what makes this a probe of the provider rather than of a second
  // spelling of the credential.
  const auth: ConnectorAuth = {
    accessToken: `${consumerKey}:${consumerSecret}`,
    shopDomain: siteUrl,
  };

  // The REAL factory with its REAL default transport — no injected fake.
  const provider = createWooCommerceProvider();

  const report: ProbeReport = {
    site: redactUrl(siteUrl),
    verify: { outcome: 'failed', error: 'not attempted' },
    firstPage: { outcome: 'skipped', reason: 'verifyConnection did not succeed' },
  };

  let verify: ProbeReport['verify'];
  try {
    const identity = await provider.verifyConnection(auth);
    verify = {
      outcome: 'ok',
      // `ShopIdentity.shopCurrency` — a RAW ISO-4217 string that may sit outside
      // Mercaria's `CurrencyCode` set. `connector-sync.service` is the one place
      // that validates it, which is why the probe reports it verbatim and
      // refuses below rather than coercing.
      shopCurrency: identity.shopCurrency ?? '<none>',
      externalShopId: identity.externalShopId ? `…${identity.externalShopId.slice(-4)}` : '<none>',
    };
  } catch (err) {
    verify = { outcome: 'failed', error: `${(err as Error).name}: ${(err as Error).message}` };
  }

  let firstPage: ProbeReport['firstPage'];
  if (verify.outcome !== 'ok') {
    firstPage = { outcome: 'skipped', reason: 'verifyConnection did not succeed' };
  } else {
    if (!(ALL_CURRENCY_CODES as readonly string[]).includes(verify.shopCurrency)) {
      // Refuse rather than passing an unsupported code through. `CURRENCY_PRECISION`
      // has no entry for one, so `decimalStringToMinor` computes `10 ** undefined`
      // = NaN and reports it as "exceeds the safe integer range" — a message that
      // names the wrong problem. The real path cannot reach that state because
      // `connector-sync.service` validates the code first; a probe that skipped
      // the same check would report a provider defect that does not exist.
      firstPage = {
        outcome: 'skipped',
        reason:
          `the site reports currency "${verify.shopCurrency}", which is not in ` +
          'ALL_CURRENCY_CODES, so no price can be parsed for it',
      };
      return { ...report, verify, firstPage };
    }
    try {
      const creds: ConnectorCredentials = {
        ...auth,
        // The site's own currency, as the site reported it. `fetchProducts`
        // stamps every pulled price with this — Mercaria stores native and
        // converts nothing on the write side.
        shopCurrency: verify.shopCurrency as ConnectorCredentials['shopCurrency'],
      };
      const page = await provider.fetchProducts(creds);
      const variantCounts: number[] = [];
      const currencies = new Set<string>();
      let withExternalUpdatedAt = 0;
      let incompleteVariantSets = 0;

      for (const product of page.products) {
        // #259 made `variants` a union whose `incomplete` branch carries a GAP
        // and no variant list, so an unproven enumeration cannot be read as one.
        const variants = product.variants as unknown as
          | { kind?: string; variants?: unknown[] }
          | unknown[];
        if (Array.isArray(variants)) {
          variantCounts.push(variants.length);
        } else if (variants && typeof variants === 'object' && 'variants' in variants) {
          variantCounts.push((variants.variants ?? []).length);
        } else {
          incompleteVariantSets += 1;
        }
        // TOP-LEVEL on `NormalizedProduct`, not under `source` — reading the
        // wrong path reported 0 of 100 and looked exactly like a real defect in
        // #221's timestamp handling.
        if (product.externalUpdatedAt) withExternalUpdatedAt += 1;
        for (const v of collectVariants(product)) {
          if (v?.price?.currency) currencies.add(v.price.currency);
        }
      }

      firstPage = {
        outcome: 'ok',
        productCount: page.products.length,
        hasNextCursor: Boolean(page.nextCursor),
        variantCounts,
        currencies: [...currencies].sort(),
        withExternalUpdatedAt,
        incompleteVariantSets,
      };
    } catch (err) {
      firstPage = { outcome: 'failed', error: `${(err as Error).name}: ${(err as Error).message}` };
    }
  }

  return { ...report, verify, firstPage };
}

/** Pull the variant array out of #259's union, whichever branch it is. */
function collectVariants(product: unknown): Array<{ price?: { currency?: string } }> {
  const variants = (product as { variants?: unknown }).variants;
  if (Array.isArray(variants)) return variants as Array<{ price?: { currency?: string } }>;
  if (variants && typeof variants === 'object' && Array.isArray((variants as { variants?: unknown }).variants)) {
    return (variants as { variants: Array<{ price?: { currency?: string } }> }).variants;
  }
  return [];
}

// Only run as a CLI. Importing this module (the driver does) must not execute it.
if (import.meta.main) {
  await main();
}
