/**
 * The eBay adapter's COMPOSITION ROOT — the one place the ports of
 * `services/ebay/ports.ts` are bound to real Postgres-backed implementations.
 *
 * ## Why registration is a call and not a module side effect
 *
 * #62 registers no adapter by default, and states why: *"a test-only provider
 * auto-registered in production is exactly the kind of thing that ends up
 * ingesting into a live catalogue."* The same reasoning applies in the other
 * direction to a real one — an adapter that registered itself on import would be
 * live in every process that happened to pull the module graph in, including a
 * migration runner and a test that only wanted the normalizer.
 *
 * `registerEbayBrowseAdapter` is therefore called ONCE, from the application
 * bootstrap, and it is a no-op when `EBAY_ENABLED` is false. #62's registry
 * refuses a second registration for one slug rather than replacing it, so a
 * double call throws at bootstrap where it is cheapest to find.
 *
 * ## What each binding is, in one line
 *
 * - `budget` → `reserveEbayCalls`, the conditional UPDATE that bounds the fleet.
 * - `cohort` → `listTrackedEbayItemIds`, the provider ids of what this source
 *   publishes, for the verification pass.
 * - `plan` → `listEnabledEbayDiscoveryQueries`, the rollout cohort an operator
 *   configured.
 * - `tokens` → the in-memory client-credentials cache. Nothing is written down.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import {
  ebayApplicationKey,
  reserveEbayCalls,
} from '../../db/ebay/ebayBudgetRepository.js';
import { listTrackedEbayItemIds } from '../../db/ebay/ebayCohortRepository.js';
import { listEnabledEbayDiscoveryQueries } from '../../db/ebay/ebayDiscoveryRepository.js';
import { createEbayBrowseAdapter, type EbayAdapterDeps } from '../ingestion/adapters/ebay.js';
import { registerCatalogSourceAdapter } from '../ingestion/registry.js';
import { isValidEbayCampaignId, type EbayAttribution } from './attribution.js';
import { ebayTransport } from './http.js';
import type { EbayCallBudget, EbayDiscoveryPlan, EbayTrackedItemCohort } from './ports.js';
import { createEbayTokenProvider } from './token.js';

/**
 * The EPN attribution this deployment runs under, or `null`.
 *
 * `null` is a WORKING configuration and is what a deployment without EPN
 * approval has: eBay answers with plain item URLs, #62 makes the offers
 * `external` rather than `affiliate`, and nothing pretends a commission is being
 * earned. A malformed campaign id resolves to `null` too rather than being sent:
 * eBay ignores an unrecognised one and answers with plain URLs, so passing a
 * typo through would present as "attribution silently stopped working".
 */
export function resolveEbayAttribution(): EbayAttribution | null {
  if (!config.ebay.attributionEnabled) return null;
  if (!isValidEbayCampaignId(config.ebay.campaignId)) return null;
  return {
    campaignId: config.ebay.campaignId,
    // The EPN `affiliateReferenceId`. Deliberately a CONSTANT rather than
    // anything per buyer, per session or per request: a reference id travels to
    // eBay and is echoed in EPN reporting, and a buyer-shaped value there would
    // be an identifier Mercaria exported to a third party for no purpose the
    // feature needs. #67 owns per-click attribution and has its own carrier.
    reference: 'mercaria',
  };
}

/** The Postgres-backed budget. */
const budget: EbayCallBudget = {
  async reserve({ applicationKey, calls, now }) {
    const result = await reserveEbayCalls(getDb(), {
      applicationKey: ebayApplicationKey(applicationKey),
      calls,
      dailyLimit: config.ebay.dailyCallLimit,
      now,
    });
    return {
      granted: result.granted,
      callsUsed: result.callsUsed,
      dailyLimit: result.dailyLimit,
    };
  },
};

/** The tracked-item cohort a verification pass enumerates. */
const cohort: EbayTrackedItemCohort = {
  async listTrackedItemIds({ sourceId, afterExternalId, limit, notSeenSince }) {
    return listTrackedEbayItemIds(getDb(), { sourceId, afterExternalId, limit, notSeenSince });
  },
};

/** The discovery cohort an operator configured. */
const plan: EbayDiscoveryPlan = {
  async listDiscoveryTargets({ sourceId }) {
    const rows = await listEnabledEbayDiscoveryQueries(getDb(), sourceId);
    return rows.map((row) => ({
      marketplaceId: row.marketplaceId,
      queryKind: row.queryKind,
      queryValue: row.queryValue,
      maxOffset: row.maxOffset,
    }));
  },
};

/** Everything the adapter is constructed with, wired to production. */
export function ebayAdapterDeps(): EbayAdapterDeps {
  return {
    transport: ebayTransport,
    tokens: createEbayTokenProvider(ebayTransport),
    budget,
    cohort,
    plan,
    clock: { now: () => new Date() },
    environment: config.ebay.environment,
    attribution: resolveEbayAttribution,
    fetchEnabled: () => config.ebay.fetchEnabled,
    enabledMarketplaces: () => config.ebay.markets,
    env: process.env,
    /**
     * A lost attribution is LOGGED and nothing else.
     *
     * There is no throw and no health transition, because an unattributed link
     * is a working link: refusing the page would turn a revenue problem into a
     * catalogue outage. The durable record is the reconciliation sweep's
     * `affiliate_attribution_missing` finding, which is the surface an operator
     * reads; this is the signal in the meantime.
     */
    onAttributionLost: ({ sourceAccountRef }) => {
      log.general.warn(
        { sourceAccountRef },
        '[eBay] a page of items carried no affiliate URL while attribution was requested — check the EPN campaign and approval',
      );
    },
  };
}

/**
 * Register the eBay adapter, if this deployment has it enabled.
 *
 * Called once from the bootstrap. A no-op with `EBAY_ENABLED=false`, which is
 * the default and which leaves every eBay source configurable, reviewable and
 * refusing its runs with `adapter_missing` — #62's seam that fails closed and
 * reports why.
 */
export function registerEbayBrowseAdapter(): void {
  if (!config.ebay.enabled) return;
  registerCatalogSourceAdapter(createEbayBrowseAdapter(ebayAdapterDeps()));
  log.general.info(
    {
      environment: config.ebay.environment,
      markets: config.ebay.markets,
      attribution: config.ebay.attributionEnabled,
      fetchEnabled: config.ebay.fetchEnabled,
    },
    '[eBay] Browse catalog source adapter registered',
  );
}
