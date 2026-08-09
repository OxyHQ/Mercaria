/**
 * Resolving ONE source's freshness contract (#68 §"Freshness model").
 *
 * ## This module deliberately imports no configuration, and that is the gate
 *
 * "Do not use one global TTL for every source" is the issue's own sentence, and
 * the way a global TTL would actually get introduced is not a column — it is
 * somebody reaching for `config.offerFreshness.defaultTtlSeconds` here because
 * a source had no policy row. So `../../config/index.js` is not imported, and
 * `freshness-isolation.test.ts` fails the build if it ever is. Every number
 * this module produces is traceable to a row keyed on the source it describes.
 *
 * ## Three layers, and each can only make the lifetime SHORTER
 *
 * 1. **A published freshness version** (`catalog_source_freshness_policies`),
 *    when there is one. Basis `source_policy`.
 * 2. **The source's own configuration** otherwise — `fetch_cadence_seconds` and
 *    `freshness_ttl_seconds` off `catalog_source_configs`, which #62 already
 *    demands per source and already uses to stamp `offers.stale_at`. Basis
 *    `source_configuration`. This layer exists so that adopting #68 does not
 *    withdraw every external offer from comparison on the deploy that adds it
 *    (ADR 0002 D24's rule about rollout levers), and it is still per-source:
 *    the numbers are that row's, never a constant.
 * 3. **The rights policy's contractual cache cap**
 *    (`catalog_source_policies.cache_ttl_seconds`), applied by
 *    `effectiveOfferLifetimeSeconds` as a `min`. A cap a per-source policy
 *    could override would not be a cap, so there is no parameter through which
 *    to lengthen one.
 *
 * A source with NO configuration at all resolves to `null`, and
 * `assessOfferFreshness` answers `unknown` — which never appears in
 * comparison. That is the fail-closed direction: an offer whose source nobody
 * has configured has no contract saying how long it may be shown.
 */

import {
  SOURCE_OUTAGE_GRACE_INTERVALS,
  SOURCE_WARNING_FRACTION,
  type CatalogRefreshMode,
  type SourceAnomalyThresholds,
  type SourceFreshnessPolicy,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findCatalogSourceConfig,
  type CatalogSourceConfigRow,
} from '../../db/ingestion/catalogSourceConfigRepository.js';
import {
  findActiveSourcePolicy,
  type CatalogSourcePolicyRow,
} from '../../db/ingestion/catalogSourcePolicyRepository.js';
import {
  findActiveFreshnessPolicy,
  type CatalogSourceFreshnessPolicyRow,
} from '../../db/offerFreshness/freshnessPolicyRepository.js';
import { DEFAULT_SOURCE_ANOMALY_THRESHOLDS } from '../../db/schema/offerFreshness.js';

/**
 * What the detectors are calibrated to for a source with no published version.
 *
 * Read from the SAME constant the policy table's column defaults are rendered
 * from, so a source with no version and a source with a freshly published one
 * are detected against identical numbers. A second copy typed here would drift
 * silently, in the direction that makes the detectors disagree with the board
 * an operator is reading.
 */
const CONFIGURATION_ANOMALY_THRESHOLDS: SourceAnomalyThresholds = {
  minimumSampleSize: DEFAULT_SOURCE_ANOMALY_THRESHOLDS.minimumSampleSize,
  zeroPriceShare: DEFAULT_SOURCE_ANOMALY_THRESHOLDS.zeroPriceShareBps / 10_000,
  priceScaleFactor: DEFAULT_SOURCE_ANOMALY_THRESHOLDS.priceScaleFactor,
  disappearanceShare: DEFAULT_SOURCE_ANOMALY_THRESHOLDS.disappearanceShareBps / 10_000,
};

/**
 * One source's freshness contract plus the two things only a scheduler needs:
 * which modes it permits and what its anomaly detectors are calibrated to.
 *
 * They ride together because they come from the same row and are resolved by
 * the same read; splitting them would make a refresh tick read the source's
 * policy twice.
 */
export interface ResolvedFreshnessPolicy {
  readonly policy: SourceFreshnessPolicy;
  /** EMPTY means unrestricted — it narrows what the adapter declares, never widens it. */
  readonly permittedRefreshModes: readonly CatalogRefreshMode[];
  readonly anomalyThresholds: SourceAnomalyThresholds;
}

/**
 * The cache cap a rights policy imposes, or `null` when it imposes none.
 *
 * `may_cache` and `cache_ttl_seconds` are a biconditional pair at the row
 * (#62), so reading the TTL alone would be enough — the explicit `mayCache`
 * test is here anyway because a caller reading this function has to be able to
 * see that a source with NO caching right is not a source with an unlimited
 * one.
 */
function cacheCapSeconds(rights: CatalogSourcePolicyRow | undefined): number | null {
  if (rights === undefined || !rights.mayCache) return null;
  return rights.cacheTtlSeconds;
}

/** A published version, read as the derivation's view of it. */
function fromPublishedVersion(
  row: CatalogSourceFreshnessPolicyRow,
  cap: number | null,
): ResolvedFreshnessPolicy {
  return {
    policy: {
      sourceId: row.sourceId,
      basis: 'source_policy',
      policyVersion: row.version,
      expectedRefreshIntervalSeconds: row.expectedRefreshIntervalSeconds,
      warningAfterSeconds: row.warningAfterSeconds,
      expiryAfterSeconds: row.expiryAfterSeconds,
      outageGraceSeconds: row.outageGraceSeconds,
      cacheCapSeconds: cap,
      retireOnSourceUnavailable: row.retireOnSourceUnavailable,
    },
    permittedRefreshModes: row.permittedRefreshModes as readonly CatalogRefreshMode[],
    anomalyThresholds: {
      minimumSampleSize: row.anomalyMinimumSampleSize,
      zeroPriceShare: row.anomalyZeroPriceShareBps / 10_000,
      priceScaleFactor: row.anomalyPriceScaleFactor,
      disappearanceShare: row.anomalyDisappearanceShareBps / 10_000,
    },
  };
}

/**
 * The contract a source has by virtue of being CONFIGURED, with no published
 * freshness version.
 *
 * Every number comes from this source's own row, or from a FRACTION or a
 * MULTIPLE of one of them — never from a constant that is itself a duration.
 * `SOURCE_WARNING_FRACTION` is two thirds of a different number for every
 * source, which is what makes it not the global TTL this whole module exists to
 * prevent; `SOURCE_OUTAGE_GRACE_INTERVALS` is two of that source's own expected
 * refresh intervals, i.e. "it missed two refreshes in a row".
 *
 * The anomaly thresholds come from the SAME constant the policy table's column
 * defaults are rendered from — see `CONFIGURATION_ANOMALY_THRESHOLDS`.
 */
function fromConfiguration(
  config: CatalogSourceConfigRow,
  cap: number | null,
): ResolvedFreshnessPolicy {
  // A source with no cadence is webhook-driven (#62 permits exactly that), so
  // "how often is it expected to be refreshed" is answered by how long its
  // facts are good for — which is the only per-source number available and is
  // the honest reading: nothing else has been stated.
  const expectedRefreshIntervalSeconds =
    config.fetchCadenceSeconds ?? config.freshnessTtlSeconds;
  const expiryAfterSeconds = config.freshnessTtlSeconds;
  const warningAfterSeconds = Math.max(
    60,
    Math.min(expiryAfterSeconds - 1, Math.floor(expiryAfterSeconds * SOURCE_WARNING_FRACTION)),
  );

  return {
    policy: {
      sourceId: config.sourceId,
      basis: 'source_configuration',
      policyVersion: null,
      expectedRefreshIntervalSeconds,
      warningAfterSeconds,
      expiryAfterSeconds,
      outageGraceSeconds: expectedRefreshIntervalSeconds * SOURCE_OUTAGE_GRACE_INTERVALS,
      cacheCapSeconds: cap,
      // TRUE, matching the published default: retaining something a source says
      // is gone is the direction that breaks a contract rather than a page.
      retireOnSourceUnavailable: true,
    },
    // EMPTY = unrestricted. A source nobody has published a freshness policy
    // for may be refreshed however its adapter can, which is #62's behaviour
    // today and is what keeps this a widening rather than a withdrawal.
    permittedRefreshModes: [],
    anomalyThresholds: CONFIGURATION_ANOMALY_THRESHOLDS,
  };
}

/**
 * Resolve a contract from rows the CALLER already has.
 *
 * The ingestion page path has just read the config and the active rights policy
 * (`resolveIngestionSource`), and re-reading both here would make every page of
 * every feed pay three round trips for facts already in hand — measured, and it
 * mattered: the adapter contract suite holds the GLOBAL one-active-match-policy
 * slot for its whole file, so per-page work there is time every other realdb
 * file spends waiting.
 *
 * It is the same derivation as {@link resolveSourceFreshnessPolicy}, which is
 * this function plus the two reads. There is deliberately not a second
 * derivation: the layering and the cap are computed in one place.
 */
export async function resolveFreshnessFromRows(
  input: {
    config: CatalogSourceConfigRow;
    rights: CatalogSourcePolicyRow | undefined;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ResolvedFreshnessPolicy> {
  const published = await findActiveFreshnessPolicy(db, input.config.sourceId);
  const cap = cacheCapSeconds(input.rights);
  return published === undefined
    ? fromConfiguration(input.config, cap)
    : fromPublishedVersion(published, cap);
}

/**
 * Resolve one source's freshness contract.
 *
 * `undefined` when the source is not configured for ingestion at all — the
 * `resolveIngestionSource` convention, and the state a native offer or the
 * operator source is in.
 */
export async function resolveSourceFreshnessPolicy(
  sourceId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ResolvedFreshnessPolicy | undefined> {
  const config = await findCatalogSourceConfig(db, sourceId);
  if (config === undefined) return undefined;

  const rights = await findActiveSourcePolicy(db, sourceId);
  return resolveFreshnessFromRows({ config, rights }, db);
}

/**
 * Resolve SEVERAL sources' contracts for one page of offers.
 *
 * A comparison page carries offers from many sources, and resolving each
 * separately would make a twenty-offer read sixty round trips. The map is keyed
 * on the source id, which is also what `assessOfferFreshness` checks the policy
 * against — so a lookup that returned the wrong source's policy would be
 * refused by the derivation rather than applied.
 */
export async function resolveSourceFreshnessPolicies(
  sourceIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ReadonlyMap<string, ResolvedFreshnessPolicy>> {
  const resolved = new Map<string, ResolvedFreshnessPolicy>();
  const unique = [...new Set(sourceIds)];
  if (unique.length === 0) return resolved;

  const entries = await Promise.all(
    unique.map(async (sourceId) => [sourceId, await resolveSourceFreshnessPolicy(sourceId, db)] as const),
  );
  for (const [sourceId, policy] of entries) {
    if (policy !== undefined) resolved.set(sourceId, policy);
  }
  return resolved;
}
