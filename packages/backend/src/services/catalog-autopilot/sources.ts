/**
 * Converge the database onto the sources declared in code.
 *
 * For each `DECLARED_OPEN_DATA_SOURCES` entry, in #62's own order:
 * 1. the retailer merchant exists (by slug);
 * 2. the source is configured — `configureIngestionSource` converges on the
 *    name, so this is an upsert of the declared configuration;
 * 3. its rights policy is the declared one;
 * 4. a source still in `draft` is activated.
 *
 * Every step goes through the same service an operator's request does, so a
 * declared source is indistinguishable from one configured by hand, and every
 * rule those services enforce (rights coherence, "no activation without a
 * policy") applies.
 *
 * ## An operator's decision wins
 *
 * The declaration is a default, not an override. A source an operator paused or
 * revoked stays that way — only `draft` is activated. A policy an operator
 * published stays in force — only a policy THIS module published is replaced
 * when the declaration changes. Without both rules an incident response would
 * be undone by the next deploy.
 *
 * Each source is reconciled on its own; one that fails is logged and retried on
 * the next pass, and never stops the others.
 */

import { getDb } from '../../db/postgres.js';
import { findMerchantBySlug, insertMerchant } from '../../db/commerce-graph/merchantRepository.js';
import type { CatalogSourcePolicyRow } from '../../db/ingestion/catalogSourcePolicyRepository.js';
import { log } from '../../lib/logger.js';
import {
  changeIngestionSourceStatus,
  configureIngestionSource,
  publishIngestionSourcePolicy,
} from '../ingestion/source.service.js';
import { findOpenDataProvider } from '../open-data/catalogue.js';
import type { DeclaredMerchant, DeclaredOpenDataSource, DeclaredSourceRights } from '../open-data/sources.js';
import { CATALOG_AUTOPILOT_ACTOR } from './actor.js';

export interface SourceReconciliation {
  readonly name: string;
  readonly sourceId: string | null;
  readonly policyPublished: boolean;
  readonly activated: boolean;
  readonly error: string | null;
}

/** The merchant a price source is bound to, created on first sight. */
async function ensureMerchant(declared: DeclaredMerchant): Promise<string> {
  const db = getDb();
  const existing = await findMerchantBySlug(db, declared.slug);
  if (existing !== undefined) return existing.id;
  try {
    const created = await insertMerchant(db, {
      name: declared.name,
      slug: declared.slug,
      merchantType: 'retailer',
    });
    return created.id;
  } catch (error: unknown) {
    // Another task created it between the read and the insert; anything else
    // leaves no row behind and is rethrown.
    const raced = await findMerchantBySlug(db, declared.slug);
    if (raced === undefined) throw error;
    return raced.id;
  }
}

/** Does the active policy already say exactly what the declaration says? */
export function policyMatchesDeclaration(
  active: CatalogSourcePolicyRow,
  declared: DeclaredSourceRights,
): boolean {
  return (
    active.mayDisplay === declared.mayDisplay &&
    active.mayStore === declared.mayStore &&
    active.mayCache === declared.mayCache &&
    active.cacheTtlSeconds === declared.cacheTtlSeconds &&
    active.mayDisplayPrice === declared.mayDisplayPrice &&
    active.mayDisplayMedia === declared.mayDisplayMedia &&
    active.mayLinkOut === declared.mayLinkOut &&
    active.mayAppendAffiliateParams === declared.mayAppendAffiliateParams &&
    active.mayIndex === declared.mayIndex &&
    active.mayRefreshAutomatically === declared.mayRefreshAutomatically &&
    active.maySeedCatalog === declared.maySeedCatalog &&
    active.extractionMode === declared.extractionMode &&
    active.extractionMaxRequestsPerDay === (declared.extractionMaxRequestsPerDay ?? null) &&
    active.extractionUserAgent === (declared.extractionUserAgent ?? null) &&
    active.attributionRequired === declared.attributionRequired &&
    active.termsVersion === declared.termsVersion &&
    active.termsUrl === declared.termsUrl
  );
}

/**
 * Whether to publish the declared policy over what is active: when nothing is
 * active, or when this module published the active one and the declaration has
 * since changed. Never over an operator's.
 */
export function shouldPublishDeclaredPolicy(
  active: CatalogSourcePolicyRow | undefined,
  declared: DeclaredSourceRights,
): boolean {
  if (active === undefined) return true;
  if (active.reviewedByOxyUserId !== CATALOG_AUTOPILOT_ACTOR) return false;
  return !policyMatchesDeclaration(active, declared);
}

async function reconcileOne(declared: DeclaredOpenDataSource): Promise<SourceReconciliation> {
  const provider = findOpenDataProvider(declared.provider);
  if (provider === undefined) throw new Error(`Unknown open-data provider ${declared.provider}.`);

  const merchantId = declared.merchant === null ? undefined : await ensureMerchant(declared.merchant);
  const configured = await configureIngestionSource({
    name: declared.name,
    kind: provider.kind,
    provider: provider.slug,
    ...(declared.accountRef === null ? {} : { sourceAccountRef: declared.accountRef }),
    ...(merchantId === undefined ? {} : { merchantId }),
    territories: declared.territories,
    fetchCadenceSeconds: declared.fetchCadenceSeconds,
    freshnessTtlSeconds: declared.freshnessTtlSeconds,
    pageSize: declared.pageSize,
    rightsNote: `${provider.attribution}. Declared in services/open-data/sources.ts.`,
  });
  const sourceId = configured.source.config.sourceId;

  const policyPublished = shouldPublishDeclaredPolicy(configured.policy, declared.rights);
  if (policyPublished) {
    await publishIngestionSourcePolicy({
      sourceId,
      reviewedByOxyUserId: CATALOG_AUTOPILOT_ACTOR,
      ...declared.rights,
      reviewNote: `Declared in services/open-data/sources.ts under ${declared.rights.termsVersion}.`,
    });
  }

  const activated = configured.source.config.status === 'draft';
  if (activated) {
    await changeIngestionSourceStatus({
      sourceId,
      status: 'active',
      actorOxyUserId: CATALOG_AUTOPILOT_ACTOR,
      reason: 'Declared in services/open-data/sources.ts',
    });
  }

  return { name: declared.name, sourceId, policyPublished, activated, error: null };
}

/** Reconcile every declared source; one failure never stops the rest. */
export async function reconcileDeclaredSources(
  declared: readonly DeclaredOpenDataSource[],
): Promise<SourceReconciliation[]> {
  const results: SourceReconciliation[] = [];
  for (const source of declared) {
    try {
      results.push(await reconcileOne(source));
    } catch (error: unknown) {
      log.general.error({ err: error, source: source.name }, '[CatalogAutopilot] source reconciliation failed');
      results.push({
        name: source.name,
        sourceId: null,
        policyPublished: false,
        activated: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
