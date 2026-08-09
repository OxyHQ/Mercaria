/**
 * THE eBay BROWSE ADAPTER — issue #65, the first broad-marketplace source #64
 * selected.
 *
 * It implements #62's `CatalogSourceAdapter` and adds nothing to it: data in,
 * data out. It holds no database, no transaction, no repository and no service,
 * and it returns `NormalizedSourceRecord`s that have no canonical id, no
 * merchant id and no offer id to put one in — so every one of #62's write
 * boundaries is a property of this file's signature rather than a rule it
 * follows. `ingestion-isolation.test.ts` scans this directory and would fail the
 * build if that changed.
 *
 * ## What it does have: four narrow capabilities, injected
 *
 * `services/ebay/ports.ts` states each one and why it exists. In summary: eBay
 * meters its quota against the APPLICATION rather than the process, so the
 * budget has to be durable; and "no longer publicly available on eBay" — the
 * deletion obligation in the API License Agreement — is establishable only by
 * asking eBay about items Mercaria already tracks, by id, so the cohort has to
 * come from somewhere. Neither port can return a row, write an entity or carry a
 * canonical id.
 *
 * ## A pass is DISCOVERY then VERIFICATION, and only the second may complete
 *
 * `services/ebay/cursor.ts` holds the reasoning in full, and it is the decision
 * this whole file is arranged around. eBay grants search-driven discovery and
 * refuses a search `offset` beyond 10,000 — so a discovery sweep is provably not
 * an enumeration of anything, and reporting `complete` from one would retire
 * every item below the depth cut on the first sweep after a category grew. A
 * verification pass over every tracked id, untruncated, is an enumeration, and
 * it is the only thing here that sets `complete`.
 *
 * ## Every failure mode lands on "retire nothing"
 *
 * A budget refusal, an offset ceiling, a rate limit, an auth failure, a lost
 * approval, a disabled query, an unreadable cursor: all of them either throw a
 * classified `CatalogSourceFetchError` (which #62 never treats as a complete
 * enumeration) or mark the pass `truncated` (which
 * `mayClaimCompleteEnumeration` refuses). Issue #65 reliability 6 is that
 * conjunction, and it is stated in one expression rather than at six call sites.
 */

import type { CatalogRefreshMode } from '@mercaria/shared-types';
import {
  EBAY_BROWSE_PROVIDER,
  EBAY_GET_ITEMS_MAX_IDS,
  EBAY_MARKETPLACE_IDS,
  EBAY_SEARCH_MAX_OFFSET,
  type EbayMarketplaceId,
} from '@mercaria/shared-types';
import {
  CatalogSourceFetchError,
  type AdapterFetchPage,
  type AdapterFetchRequest,
  type AdapterRecord,
  type CatalogSourceAdapter,
} from '../adapter.js';
import { ebayGetItems, ebaySearch, type EbayBrowseContext } from '../../ebay/browse.js';
import { buildEndUserContext, pageLostAttribution, type EbayAttribution } from '../../ebay/attribution.js';
import {
  mayClaimCompleteEnumeration,
  parseEbayCursor,
  serializeEbayCursor,
  type EbayCursor,
} from '../../ebay/cursor.js';
import type { EbayTransport } from '../../ebay/http.js';
import { normalizeEbayItem, type EbayItem } from '../../ebay/normalize.js';
import type {
  EbayCallBudget,
  EbayClock,
  EbayDiscoveryPlan,
  EbayDiscoveryTarget,
  EbayTrackedItemCohort,
} from '../../ebay/ports.js';
import { resolveEbayCredential, type EbayTokenProvider } from '../../ebay/token.js';

/** What the composition root hands this adapter. */
export interface EbayAdapterDeps {
  readonly transport: EbayTransport;
  readonly tokens: EbayTokenProvider;
  readonly budget: EbayCallBudget;
  readonly cohort: EbayTrackedItemCohort;
  readonly plan: EbayDiscoveryPlan;
  readonly clock: EbayClock;
  /** `sandbox` or `production`. A sandbox keyset never feeds public pages (#64 §9.1). */
  readonly environment: 'sandbox' | 'production';
  /**
   * The EPN campaign attribution, or `null` to run unattributed.
   *
   * `null` is a working configuration and is what a deployment without EPN
   * approval has: eBay answers with plain item URLs, #62 makes the offers
   * `external` rather than `affiliate`, and nothing pretends a commission is
   * being earned.
   *
   * A FUNCTION, like the two switches below and for their reason: it is read
   * fresh on every page, so removing a campaign id during an incident takes
   * effect on the next page rather than on the next process restart.
   */
  readonly attribution: () => EbayAttribution | null;
  /** The HARD fetch kill switch. Separate from any display right — see the README. */
  readonly fetchEnabled: () => boolean;
  /** The marketplaces this deployment may query at all — the rollout cohort. */
  readonly enabledMarketplaces: () => readonly EbayMarketplaceId[];
  /** Reads the process environment for the credential the source's locator names. */
  readonly env: NodeJS.ProcessEnv;
  /** Where a lost attribution is reported. Injected so a test can observe it. */
  readonly onAttributionLost: (input: { sourceAccountRef: string | null }) => void;
}

/** How many tracked ids one verification page asks the cohort for. */
const VERIFY_PAGE_IDS = EBAY_GET_ITEMS_MAX_IDS;

/** The refresh modes this adapter declares. See the `refreshModes` docblock. */
const EBAY_REFRESH_MODES: readonly CatalogRefreshMode[] = [
  'full_snapshot',
  'query_driven',
  'targeted',
];

function isEbayMarketplaceId(value: string): value is EbayMarketplaceId {
  return (EBAY_MARKETPLACE_IDS as readonly string[]).includes(value);
}

/**
 * The marketplace one request runs against.
 *
 * A discovery target names its own; a verification batch has none of its own and
 * takes the source's FIRST configured territory, mapped back to a marketplace.
 * A source configured for no marketplace this deployment enabled cannot be
 * verified, which is refused rather than defaulted — defaulting would verify a
 * Spanish cohort against the German marketplace and retire everything.
 */
function resolveVerificationMarketplace(
  targets: readonly EbayDiscoveryTarget[],
  enabled: readonly EbayMarketplaceId[],
): EbayMarketplaceId | null {
  for (const target of targets) {
    if (isEbayMarketplaceId(target.marketplaceId) && enabled.includes(target.marketplaceId)) {
      return target.marketplaceId;
    }
  }
  return null;
}

/** Build the adapter. The composition root (`services/ebay/register.ts`) wires it. */
export function createEbayBrowseAdapter(deps: EbayAdapterDeps): CatalogSourceAdapter {
  /**
   * One page of the pass.
   *
   * Bounded in every direction: at most one provider call per page for
   * discovery, at most one for verification. That is what makes the run's lease,
   * the budget and the cursor all mean the same thing — a page is a call.
   */
  async function fetchPage(request: AdapterFetchRequest): Promise<AdapterFetchPage> {
    const now = deps.clock.now();
    const startedAt = Date.now();

    /**
     * THE HARD FETCH KILL SWITCH.
     *
     * Raised as a RETRYABLE outage rather than answered with an empty page. #62
     * then RELEASES the run — the cursor stays exactly where it was, the source
     * health is not moved, nothing is retired, and the moment the switch flips
     * back the queued run resumes from the page it was on. An empty page would
     * instead close the run as `partial_feed`, which is indistinguishable in the
     * operator's health read from a feed that truncated, and that is precisely
     * the distinction an incident needs. The message names the lever.
     */
    if (!deps.fetchEnabled()) {
      throw new CatalogSourceFetchError(
        'source_outage',
        'eBay fetching is disabled by EBAY_FETCH_ENABLED',
        { retryable: true },
      );
    }

    const credential = resolveEbayCredential(request.credentialRef, deps.env);
    const enabled = deps.enabledMarketplaces();
    const targets = (await deps.plan.listDiscoveryTargets({ sourceId: request.sourceId }))
      .filter((target) => isEbayMarketplaceId(target.marketplaceId))
      .filter((target) => enabled.includes(target.marketplaceId as EbayMarketplaceId));

    const parsed = parseEbayCursor(request.cursor);
    // Stamp the pass anchor on its FIRST page. Verification later enumerates
    // only what discovery did not re-observe since this instant — see
    // `EbayCursor.startedAt`.
    const cursor: EbayCursor =
      parsed.startedAt === null ? { ...parsed, startedAt: now.toISOString() } : parsed;

    /**
     * #68's MODE decides the shape of the pass, and only one of them may
     * conclude an absence.
     *
     * - `full_snapshot` — discovery, then verification of the WHOLE tracked
     *   cohort. The only mode that may complete, because it is the only one
     *   that asks eBay about every item Mercaria holds.
     * - `query_driven` — discovery only. A search enumerates nothing (see
     *   `cursor.ts`), so it never completes.
     * - `targeted` — verification of the NAMED ids and nothing else, which is
     *   what a priority refresh needs. A named subset establishes nothing about
     *   the items outside it, so it never completes either.
     * - `incremental` is not declared and cannot arrive: the Browse API
     *   publishes no change feed, and the scheduler reads `refreshModes` before
     *   opening a task. It is refused rather than quietly served as something
     *   else, because a mode silently downgraded is a quota bill nobody asked
     *   for and a completeness claim nobody checked.
     */
    if (request.mode === 'incremental') {
      throw new CatalogSourceFetchError(
        'schema_drift',
        'The eBay Browse API publishes no change feed; this adapter declares no incremental mode',
        { retryable: false },
      );
    }
    const mayConclude = request.mode === 'full_snapshot';

    if (request.mode === 'targeted') {
      return runVerifyPage({
        request,
        cursor: { ...cursor, phase: 'verify' },
        targets,
        credential,
        now,
        startedAt,
        mayConclude,
        enabled,
        targetedIds: request.externalIds ?? [],
      });
    }

    if (cursor.phase === 'discovery') {
      return runDiscoveryPage({ request, cursor, targets, credential, now, startedAt, mayConclude });
    }
    return runVerifyPage({
      request,
      cursor,
      targets,
      credential,
      now,
      startedAt,
      mayConclude,
      enabled,
      targetedIds: null,
    });
  }

  /** Reserve ONE provider call, or report that the budget refused. */
  async function reserveOneCall(request: AdapterFetchRequest, now: Date): Promise<boolean> {
    const grant = await deps.budget.reserve({
      applicationKey: applicationKeyFor(request),
      calls: 1,
      now,
    });
    return grant.granted;
  }

  /**
   * The budget key: the source's own credential locator.
   *
   * Keyed on the CREDENTIAL and not on the source, because eBay meters against
   * the keyset and Mercaria runs one source per marketplace. Five sources on one
   * keyset sharing one budget is the correct arrangement; five budgets would let
   * the fleet draw 25,000 calls against a 5,000-call agreement.
   */
  function applicationKeyFor(request: AdapterFetchRequest): string {
    return request.credentialRef ?? EBAY_BROWSE_PROVIDER;
  }

  async function runDiscoveryPage(args: {
    request: AdapterFetchRequest;
    cursor: EbayCursor;
    targets: readonly EbayDiscoveryTarget[];
    credential: { clientId: string; clientSecret: string };
    now: Date;
    startedAt: number;
    mayConclude: boolean;
  }): Promise<AdapterFetchPage> {
    const { request, cursor, targets, credential, now, startedAt, mayConclude } = args;

    const target = targets[cursor.targetIndex];
    if (target === undefined) {
      // Discovery is exhausted — either every target was swept, or the source
      // has none configured at all. A `full_snapshot` pass goes on to verify
      // what it did not just re-observe; a `query_driven` one stops here,
      // because it was never entitled to conclude an absence.
      return {
        records: [],
        nextCursor: mayConclude
          ? serializeEbayCursor({ ...cursor, phase: 'verify', afterExternalId: null })
          : null,
        complete: false,
        fetchDurationMs: Date.now() - startedAt,
        rateLimitHits: 0,
      };
    }

    if (!(await reserveOneCall(request, now))) {
      /**
       * The budget refused. The pass is TRUNCATED and moves straight to the end.
       *
       * Not an error: eBay is fine, Mercaria has simply spent its allowance, and
       * a thrown failure would move the source's health as though the provider
       * were at fault. The `truncated` flag then makes
       * `mayClaimCompleteEnumeration` refuse, so nothing is retired on a pass
       * that stopped early — which is the whole point of carrying the flag.
       */
      return {
        records: [],
        nextCursor: null,
        complete: false,
        fetchDurationMs: Date.now() - startedAt,
        rateLimitHits: 0,
      };
    }

    const marketplaceId = target.marketplaceId as EbayMarketplaceId;
    const context = await browseContext({ request, credential, marketplaceId, now });
    const limit = Math.max(1, Math.min(request.pageSize, 200));
    const page = await ebaySearch(context, {
      kind: target.queryKind,
      value: target.queryValue,
      offset: cursor.offset,
      limit,
    });

    const records = toRecords({ items: page.items, marketplaceId, now });
    reportAttribution({ request, itemCount: page.items.length, records });

    const nextOffset = cursor.offset + limit;
    /**
     * The two ceilings, and the difference between them.
     *
     * The target's own `max_offset` is Mercaria's choice about how much of a
     * category is worth sweeping. `EBAY_SEARCH_MAX_OFFSET` is eBay's refusal
     * point, and reaching it is the provider stating that the query has more
     * results than it will ever serve — which is a TRUNCATION of the pass and
     * not merely the end of a target.
     */
    const hitProviderCeiling = nextOffset >= EBAY_SEARCH_MAX_OFFSET;
    const targetExhausted =
      page.items.length < limit || nextOffset >= target.maxOffset || hitProviderCeiling;

    const nextCursor: EbayCursor = targetExhausted
      ? {
          ...cursor,
          targetIndex: cursor.targetIndex + 1,
          offset: 0,
          truncated: cursor.truncated || hitProviderCeiling,
        }
      : { ...cursor, offset: nextOffset };

    return {
      records,
      nextCursor: serializeEbayCursor(nextCursor),
      // A DISCOVERY page never claims completeness. See `cursor.ts`.
      complete: false,
      fetchDurationMs: Date.now() - startedAt,
      rateLimitHits: 0,
    };
  }

  async function runVerifyPage(args: {
    request: AdapterFetchRequest;
    cursor: EbayCursor;
    targets: readonly EbayDiscoveryTarget[];
    credential: { clientId: string; clientSecret: string };
    now: Date;
    startedAt: number;
    mayConclude: boolean;
    enabled: readonly EbayMarketplaceId[];
    /** The ids a TARGETED refresh named, or `null` to walk the whole cohort. */
    targetedIds: readonly string[] | null;
  }): Promise<AdapterFetchPage> {
    const { request, cursor, targets, credential, now, startedAt, mayConclude, enabled } = args;

    const marketplaceId = resolveVerificationMarketplace(targets, enabled);
    if (marketplaceId === null) {
      // Nothing to verify AGAINST. Ending the pass here is honest and, crucially,
      // claims no completeness: a source whose marketplaces are all disabled has
      // not established that anything stopped existing.
      return {
        records: [],
        nextCursor: null,
        complete: false,
        fetchDurationMs: Date.now() - startedAt,
        rateLimitHits: 0,
      };
    }

    /**
     * A TARGETED refresh re-reads exactly what it was given.
     *
     * It does not consult the cohort at all: the caller has already decided
     * which items matter (#68's priority refresh), and walking the cohort would
     * spend the budget re-reading everything else. The page bound is eBay's own
     * `getItems` cap, so a longer list pages through the cursor like any other.
     */
    const ids =
      args.targetedIds === null
        ? await deps.cohort.listTrackedItemIds({
            sourceId: request.sourceId,
            afterExternalId: cursor.afterExternalId,
            limit: VERIFY_PAGE_IDS,
            notSeenSince: cursor.startedAt === null ? null : new Date(cursor.startedAt),
          })
        : args.targetedIds
            .filter((id) => cursor.afterExternalId === null || id > cursor.afterExternalId)
            .slice(0, VERIFY_PAGE_IDS);

    if (ids.length === 0) {
      /**
       * THE COHORT IS EXHAUSTED — the one place a complete enumeration is
       * claimed, and only if the whole pass earned it.
       */
      return {
        records: [],
        nextCursor: null,
        complete: mayClaimCompleteEnumeration({
          phase: 'verify',
          cohortExhausted: true,
          truncated: cursor.truncated,
          mayConclude,
        }),
        fetchDurationMs: Date.now() - startedAt,
        rateLimitHits: 0,
      };
    }

    if (!(await reserveOneCall(request, now))) {
      // Truncated, and therefore no completeness claim on the way out — the same
      // reasoning as the discovery branch, one phase later.
      return {
        records: [],
        nextCursor: null,
        complete: false,
        fetchDurationMs: Date.now() - startedAt,
        rateLimitHits: 0,
      };
    }

    const context = await browseContext({ request, credential, marketplaceId, now });
    const result = await ebayGetItems(context, ids);
    const records = toRecords({ items: result.items, marketplaceId, now });
    reportAttribution({ request, itemCount: result.items.length, records });

    /**
     * The ids eBay no longer answers for are simply NOT EMITTED.
     *
     * That is the whole retirement mechanism, and it works because #62 retires
     * what a complete enumeration did not mention. Emitting a tombstone record
     * would need a shape `NormalizedSourceRecord` does not have, and deleting
     * anything from here would be the write boundary this adapter exists not to
     * have. `result.missingIds` is therefore consumed by nothing — the absence
     * IS the report.
     */
    const lastId = ids[ids.length - 1] ?? cursor.afterExternalId;
    return {
      records,
      nextCursor: serializeEbayCursor({ ...cursor, afterExternalId: lastId }),
      complete: false,
      fetchDurationMs: Date.now() - startedAt,
      rateLimitHits: 0,
    };
  }

  async function browseContext(args: {
    request: AdapterFetchRequest;
    credential: { clientId: string; clientSecret: string };
    marketplaceId: EbayMarketplaceId;
    now: Date;
  }): Promise<EbayBrowseContext> {
    const token = await deps.tokens.getAccessToken({
      environment: deps.environment,
      credential: args.credential,
      now: args.now,
    });
    return {
      transport: deps.transport,
      environment: deps.environment,
      accessToken: token.value,
      marketplaceId: args.marketplaceId,
      endUserContext: buildEndUserContext(deps.attribution()),
      now: args.now,
    };
  }

  function toRecords(args: {
    items: readonly EbayItem[];
    marketplaceId: EbayMarketplaceId;
    now: Date;
  }): AdapterRecord[] {
    const records: AdapterRecord[] = [];
    for (const item of args.items) {
      const normalized = normalizeEbayItem({
        item,
        marketplaceId: args.marketplaceId,
        now: args.now,
      });
      // A record with no id or no title is not an observation. It is DROPPED
      // here rather than emitted, because #62's own rejection path would record
      // it as `missing_title` against an external id this adapter could not
      // supply — a rejection nobody could trace back to anything.
      if (normalized === null) continue;
      records.push({
        externalType: 'offer',
        externalId: normalized.externalId,
        observedAt: args.now,
        raw: item,
        normalized: normalized.record,
      });
    }
    return records;
  }

  /**
   * Report a page on which attribution was requested and NOT ONE item carried
   * it.
   *
   * The only detector this integration has for EPN approval or campaign-id loss:
   * an unattributed link is a working link, so nothing else anywhere errors,
   * rate-limits or 4xxs. It REPORTS rather than throws, because refusing the
   * page would turn a revenue problem into a catalogue outage.
   */
  function reportAttribution(args: {
    request: AdapterFetchRequest;
    itemCount: number;
    records: readonly AdapterRecord[];
  }): void {
    const affiliateUrlCount = args.records.filter(
      (record) => record.normalized.affiliateUrl !== undefined,
    ).length;
    if (
      pageLostAttribution({
        attributionRequested: deps.attribution() !== null,
        itemCount: args.itemCount,
        affiliateUrlCount,
      })
    ) {
      deps.onAttributionLost({ sourceAccountRef: args.request.sourceAccountRef });
    }
  }

  return {
    provider: EBAY_BROWSE_PROVIDER,
    kind: 'marketplace_api',
    /**
     * NOT an extraction adapter. eBay is read through an approved API under a
     * signed contract, which is the opposite of the last-resort source type
     * #62's `extraction_mode` governs — and declaring it as one would make the
     * run demand an extraction right nobody should ever grant for a partner API.
     */
    extraction: false,
    /**
     * What this adapter can actually DO (#68 scheduler 1).
     *
     * `query_driven` is discovery; `targeted` re-reads a named list, which is
     * what a priority refresh needs; and `full_snapshot` is the
     * discovery-then-verification pass — the only one that may conclude an
     * absence, because it is the only one that asks eBay about every item
     * Mercaria tracks.
     *
     * `full_snapshot` here means "this pass enumerated everything a retirement
     * could act on", which is #68's own definition ("the only one that
     * establishes absence"), and NOT "this pass enumerated eBay". No Browse
     * call enumerates a marketplace, and none is claimed to: `cursor.ts` is
     * what makes a discovery sweep unable to report completeness at all.
     *
     * `incremental` is absent because the Browse API publishes no change feed.
     * Declaring it would let the scheduler open a task no call can serve.
     */
    refreshModes: EBAY_REFRESH_MODES,
    fetchPage,
  };
}
