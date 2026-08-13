/**
 * Configuring a source, publishing its rights, and moving its lifecycle (#62
 * §"Source definition", §"Rights and controlled extraction").
 *
 * ## Every write here also projects the rights, in the SAME transaction
 *
 * `catalog_sources`' three coarse columns are a projection of
 * `resolveSourceRights`, and `mercaria_catalog_source_rights_agree` is a
 * DEFERRED constraint trigger that refuses any commit where they disagree. So
 * the projection is not something a caller may forget: forgetting it fails the
 * transaction rather than leaving the registry advertising rights the policy
 * withdrew.
 *
 * Deferred matters here specifically. A rights change touches three tables and
 * there is no statement order that makes every intermediate state consistent —
 * superseding the old policy leaves a moment with none active, and updating the
 * registry first leaves a moment where it disagrees with the policy still in
 * force. A trigger checking at COMMIT has no opinion about the order, which is
 * why it can be strict about the outcome.
 */

import type {
  CatalogSourceExtractionMode,
  CatalogSourceKind,
  CatalogSourceRightsVerdict,
  CatalogSourceSellerIdentity,
  CatalogSourceStatus,
} from '@mercaria/shared-types';
import { getDb, type Database, type DatabaseOrTransaction } from '../../db/postgres.js';
import { ensureCatalogSource } from '../../db/canonical/provenanceRepository.js';
import {
  findCatalogSourceConfig,
  findIngestionSource,
  projectSourceRights,
  setCatalogSourceStatus,
  upsertCatalogSourceConfig,
  type CatalogSourceConfigRow,
  type IngestionSourceRow,
} from '../../db/ingestion/catalogSourceConfigRepository.js';
import {
  findActiveSourcePolicy,
  publishSourcePolicy,
  type CatalogSourcePolicyRow,
} from '../../db/ingestion/catalogSourcePolicyRepository.js';
import { notFound, validationError } from '../../lib/errors/error-codes.js';
import { projectedSourceRights, resolveSourceRights, type SourcePolicyRights } from './rights.js';

/** A source, its configuration, its active policy and the rights they imply. */
export interface ResolvedIngestionSource {
  readonly source: IngestionSourceRow;
  readonly policy: CatalogSourcePolicyRow | undefined;
  readonly rights: CatalogSourceRightsVerdict;
}

/** Read a policy row as the pure derivation's view of it. */
export function toPolicyRights(row: CatalogSourcePolicyRow): SourcePolicyRights {
  return {
    mayDisplay: row.mayDisplay,
    mayStore: row.mayStore,
    mayCache: row.mayCache,
    cacheTtlSeconds: row.cacheTtlSeconds,
    mayDisplayPrice: row.mayDisplayPrice,
    mayDisplayMedia: row.mayDisplayMedia,
    mayLinkOut: row.mayLinkOut,
    mayAppendAffiliateParams: row.mayAppendAffiliateParams,
    mayIndex: row.mayIndex,
    mayRefreshAutomatically: row.mayRefreshAutomatically,
    extractionMode: row.extractionMode,
    attributionRequired: row.attributionRequired,
  };
}

/** One configured source with everything a runner or an operator needs. */
export async function resolveIngestionSource(
  sourceId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ResolvedIngestionSource | undefined> {
  const source = await findIngestionSource(db, sourceId);
  if (!source) return undefined;
  const policy = await findActiveSourcePolicy(db, sourceId);
  return {
    source,
    policy,
    rights: resolveSourceRights(
      source.config.status,
      policy === undefined ? null : toPolicyRights(policy),
    ),
  };
}

/**
 * Re-project the coarse rights from whatever is currently stored.
 *
 * Called at the end of every write path here. It reads the config and the
 * active policy back rather than taking them as arguments, so a caller that
 * changed one of them cannot hand it a stale copy of the other.
 */
async function reprojectRights(db: DatabaseOrTransaction, sourceId: string): Promise<void> {
  const config = await findCatalogSourceConfig(db, sourceId);
  if (!config) return;
  const policy = await findActiveSourcePolicy(db, sourceId);
  const projected = projectedSourceRights(
    config.status,
    policy === undefined ? null : toPolicyRights(policy),
  );
  await projectSourceRights(db, { sourceId, ...projected });
}

export interface ConfigureIngestionSourceInput {
  /** The registry row's unique name. Converges rather than minting a second. */
  name: string;
  kind: CatalogSourceKind;
  provider: string;
  sourceAccountRef?: string;
  merchantId?: string;
  storefrontId?: string;
  territories?: readonly string[];
  credentialRef?: string;
  fetchCadenceSeconds?: number;
  freshnessTtlSeconds?: number;
  rateLimitPerMinute?: number;
  rateLimitConcurrency?: number;
  rateLimitMinIntervalMs?: number;
  pageSize?: number;
  /**
   * WHERE the seller of record comes from (#65). Omitted keeps what is stored,
   * which for every source that predates #65 is `source_bound`.
   */
  sellerIdentity?: CatalogSourceSellerIdentity;
  rightsNote?: string;
}

/**
 * Register or reconfigure an ingesting source.
 *
 * The registry row is created with NO rights (`resolveSourceRights` of a
 * `draft` source with no policy), which is the fail-closed direction: a source
 * exists, is configured, and permits nothing until somebody reviews its terms.
 *
 * It deliberately does not accept a status. Configuration and activation are
 * different acts by different people at different times, and an "activate on
 * create" parameter is how a source starts refreshing before its policy has
 * been read.
 *
 * `db` is the house trailing-handle convention, here so a realdb file can bring
 * a source up inside its OWN throwaway database. It decides which DATABASE the
 * configuration is written to and nothing else — there is no scoping predicate
 * to add and none may be. In production every caller takes the default. It is
 * typed `Database` rather than `DatabaseOrTransaction` because the body opens a
 * transaction, and a `Transaction` cannot open a second one.
 */
export async function configureIngestionSource(
  input: ConfigureIngestionSourceInput,
  db: Database = getDb(),
): Promise<ResolvedIngestionSource> {
  const configured = await db.transaction(async (tx) => {
    const source = await ensureCatalogSource(tx, {
      kind: input.kind,
      name: input.name,
      mayDisplay: false,
      mayStore: false,
      attributionRequired: true,
      ...(input.rightsNote === undefined ? {} : { rightsNote: input.rightsNote }),
    });

    await upsertCatalogSourceConfig(tx, {
      sourceId: source.id,
      provider: input.provider,
      sourceAccountRef: input.sourceAccountRef ?? null,
      merchantId: input.merchantId ?? null,
      storefrontId: input.storefrontId ?? null,
      territories: input.territories ?? [],
      credentialRef: input.credentialRef ?? null,
      fetchCadenceSeconds: input.fetchCadenceSeconds ?? null,
      rateLimitPerMinute: input.rateLimitPerMinute ?? null,
      rateLimitConcurrency: input.rateLimitConcurrency ?? null,
      rateLimitMinIntervalMs: input.rateLimitMinIntervalMs ?? null,
      ...(input.freshnessTtlSeconds === undefined
        ? {}
        : { freshnessTtlSeconds: input.freshnessTtlSeconds }),
      ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
      ...(input.sellerIdentity === undefined ? {} : { sellerIdentity: input.sellerIdentity }),
    });

    await reprojectRights(tx, source.id);
    return source.id;
  });

  const resolved = await resolveIngestionSource(configured, db);
  if (!resolved) throw new Error(`Source ${configured} vanished immediately after configuration.`);
  return resolved;
}

export interface PublishPolicyInput {
  sourceId: string;
  reviewedByOxyUserId: string;
  mayDisplay: boolean;
  mayStore: boolean;
  mayCache: boolean;
  cacheTtlSeconds?: number;
  mayDisplayPrice: boolean;
  mayDisplayMedia: boolean;
  mayLinkOut: boolean;
  mayAppendAffiliateParams: boolean;
  mayIndex: boolean;
  mayRefreshAutomatically: boolean;
  extractionMode: CatalogSourceExtractionMode;
  extractionMaxRequestsPerDay?: number;
  extractionUserAgent?: string;
  attributionRequired: boolean;
  termsVersion?: string;
  termsUrl?: string;
  reviewNote?: string;
}

/**
 * Publish and activate a new rights version, superseding whatever was active.
 *
 * This is also the SUSPENSION path, and there is deliberately no other one: a
 * version granting nothing withdraws every right while the version that granted
 * them survives with its reviewer, its date and its terms intact. Issue
 * acceptance 6 — "rights/policy can disable display/refresh without deleting
 * audit history" — is that arrangement rather than a `suspended` flag, because
 * a flag would leave the question "what were we permitted to do last March"
 * unanswerable.
 *
 * `db` as on {@link configureIngestionSource}: which DATABASE, never which rows.
 */
export async function publishIngestionSourcePolicy(
  input: PublishPolicyInput,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<ResolvedIngestionSource> {
  const existing = await resolveIngestionSource(input.sourceId, db);
  if (!existing) throw notFound('Source is not configured for ingestion');

  // The CHECKs refuse these combinations at the row; refusing here names the
  // rule in words a reviewer publishing a policy can act on, which a 23514
  // never does.
  if (input.mayCache && input.cacheTtlSeconds === undefined) {
    throw validationError('A cacheable source must state how long its data may be cached');
  }
  if (!input.mayCache && input.cacheTtlSeconds !== undefined) {
    throw validationError('cacheTtlSeconds is meaningless without the cache right');
  }
  if (!input.mayDisplay && (input.mayDisplayPrice || input.mayDisplayMedia)) {
    throw validationError('Displaying a price or media is a way of displaying');
  }
  if (!input.mayLinkOut && input.mayAppendAffiliateParams) {
    throw validationError('Affiliate parameters need an outbound link to be appended to');
  }
  if (
    input.extractionMode !== 'disallowed' &&
    (input.extractionMaxRequestsPerDay === undefined || input.extractionUserAgent === undefined)
  ) {
    throw validationError(
      'Permitted extraction must state a daily request budget and an identifying user agent',
    );
  }

  await db.transaction(async (tx) => {
    await publishSourcePolicy(tx, {
      sourceId: input.sourceId,
      mayDisplay: input.mayDisplay,
      mayStore: input.mayStore,
      mayCache: input.mayCache,
      cacheTtlSeconds: input.cacheTtlSeconds ?? null,
      mayDisplayPrice: input.mayDisplayPrice,
      mayDisplayMedia: input.mayDisplayMedia,
      mayLinkOut: input.mayLinkOut,
      mayAppendAffiliateParams: input.mayAppendAffiliateParams,
      mayIndex: input.mayIndex,
      mayRefreshAutomatically: input.mayRefreshAutomatically,
      extractionMode: input.extractionMode,
      extractionMaxRequestsPerDay: input.extractionMaxRequestsPerDay ?? null,
      extractionUserAgent: input.extractionUserAgent ?? null,
      attributionRequired: input.attributionRequired,
      termsVersion: input.termsVersion ?? null,
      termsUrl: input.termsUrl ?? null,
      reviewNote: input.reviewNote ?? null,
      reviewedByOxyUserId: input.reviewedByOxyUserId,
      now,
    });
    await reprojectRights(tx, input.sourceId);
  });

  const resolved = await resolveIngestionSource(input.sourceId, db);
  if (!resolved) throw new Error(`Source ${input.sourceId} vanished immediately after publication.`);
  return resolved;
}

/**
 * Move a source's lifecycle.
 *
 * `active` requires an active policy — a source cannot be switched on before
 * anybody has read its terms, which is the "explicit policy/terms review before
 * activation" rule turned into a refusal rather than a hope. Every other
 * transition is unconditional: pausing, revoking and returning to draft are all
 * ways of doing LESS, and none of them should ever be blocked.
 *
 * `db` as on {@link configureIngestionSource}: which DATABASE, never which rows.
 */
export async function changeIngestionSourceStatus(
  input: {
    sourceId: string;
    status: CatalogSourceStatus;
    actorOxyUserId: string;
    reason: string;
  },
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<ResolvedIngestionSource> {
  const existing = await resolveIngestionSource(input.sourceId, db);
  if (!existing) throw notFound('Source is not configured for ingestion');
  if (input.status === 'active' && existing.policy === undefined) {
    throw validationError(
      'A source cannot be activated before a rights and terms policy version is published',
    );
  }

  await db.transaction(async (tx) => {
    await setCatalogSourceStatus(tx, {
      sourceId: input.sourceId,
      status: input.status,
      actorOxyUserId: input.actorOxyUserId,
      reason: input.reason,
      now,
    });
    await reprojectRights(tx, input.sourceId);
  });

  const resolved = await resolveIngestionSource(input.sourceId, db);
  if (!resolved) throw new Error(`Source ${input.sourceId} vanished immediately after a status change.`);
  return resolved;
}

/** The config row, for callers that need it without the policy read. */
export async function readSourceConfig(
  sourceId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogSourceConfigRow | undefined> {
  return findCatalogSourceConfig(db, sourceId);
}
