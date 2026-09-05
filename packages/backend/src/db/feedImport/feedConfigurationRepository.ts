/**
 * Reads and writes for `feed_configurations` and `feed_configuration_versions`
 * (#63).
 *
 * ## Every read names its columns, because two of them are PROTECTED
 *
 * `feed_configuration_versions.feed_url` and `.auth_ciphertext` are registered
 * in `protectedColumns.ts`, so a plain `db.select()` here would fail the
 * whole-row-read gate — and correctly: a feed URL in this domain is a credential
 * (the networks that matter carry the key in the path or the query). The
 * ordinary read below therefore uses `publicColumns`, and the ONE function that
 * needs the URL and the envelope — the fetcher's — names them explicitly and
 * says so in its own docblock. That asymmetry is the design: reading a
 * credential should look different from reading a row.
 *
 * ## Activation is supersede-then-insert, in the caller's transaction
 *
 * The `catalog_source_policies` mechanism, for its reason: the superseded
 * version must SURVIVE with its mapping, its activator and its validating
 * report intact, because every observation cites the version it was read under.
 * An upsert would overwrite exactly the row that makes an old fact
 * interpretable.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import type {
  FeedAuthKind,
  FeedCompression,
  FeedConfigurationOwnerKind,
  FeedDeliveryMode,
  FeedEncoding,
  FeedFetchMode,
  FeedFieldRole,
  FeedFieldTransform,
  FeedFormat,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import {
  feedConfigurationVersions,
  feedConfigurations,
  feedFieldMappings,
  feedValueMappings,
} from '../schema/feedImport.js';

export type FeedConfigurationRow = typeof feedConfigurations.$inferSelect;
export type FeedFieldMappingRow = typeof feedFieldMappings.$inferSelect;
export type FeedValueMappingRow = typeof feedValueMappings.$inferSelect;

/**
 * The roles a value map may cover.
 *
 * Read off the COLUMN's own inferred type rather than re-listed, so the
 * repository and `FEED_MAPPABLE_VALUE_ROLES` — which renders the CHECK — cannot
 * drift into a row the service composes and the server refuses.
 */
export type FeedValueMappingRole = FeedValueMappingRow['role'];

/** A version WITHOUT its two protected columns. What every projection reads. */
export type FeedConfigurationVersionRow = Omit<
  typeof feedConfigurationVersions.$inferSelect,
  'feedUrl' | 'authCiphertext'
>;

/** The public column list, resolved once. */
const VERSION_COLUMNS = publicColumns(feedConfigurationVersions, PROTECTED_COLUMNS);

export interface InsertFeedConfigurationInput {
  sourceId: string;
  ownerKind: FeedConfigurationOwnerKind;
  storeId: string | null;
  label: string;
  identityKeyFields: readonly string[];
  createdByOxyUserId: string;
}

export async function insertFeedConfiguration(
  db: DatabaseOrTransaction,
  input: InsertFeedConfigurationInput,
): Promise<FeedConfigurationRow> {
  const [row] = await db
    .insert(feedConfigurations)
    .values({
      sourceId: input.sourceId,
      ownerKind: input.ownerKind,
      storeId: input.storeId,
      label: input.label,
      identityKeyFields: [...input.identityKeyFields],
      createdByOxyUserId: input.createdByOxyUserId,
    })
    .returning();
  if (!row) throw new Error('feed_configurations insert returned no row');
  return row;
}

export async function findFeedConfiguration(
  db: DatabaseOrTransaction,
  configurationId: string,
): Promise<FeedConfigurationRow | undefined> {
  const [row] = await db
    .select()
    .from(feedConfigurations)
    .where(eq(feedConfigurations.id, configurationId))
    .limit(1);
  return row;
}

export async function findFeedConfigurationBySource(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<FeedConfigurationRow | undefined> {
  const [row] = await db
    .select()
    .from(feedConfigurations)
    .where(eq(feedConfigurations.sourceId, sourceId))
    .limit(1);
  return row;
}

/** Every configuration a STORE owns — the tenant read (#63 security 6). */
export async function listFeedConfigurationsForOwner(
  db: DatabaseOrTransaction,
  storeId: string | null,
): Promise<FeedConfigurationRow[]> {
  return db
    .select()
    .from(feedConfigurations)
    .where(
      // `eq(column, null)` renders `= NULL`, which is never true — so the
      // platform's own feeds would come back as an empty list rather than as
      // themselves, and the surface would report "you have no feeds" to the
      // operator who just created one. `isNull` is the only spelling that
      // reads a NULL owner.
      storeId === null
        ? isNull(feedConfigurations.storeId)
        : eq(feedConfigurations.storeId, storeId),
    )
    .orderBy(desc(feedConfigurations.createdAt));
}

/** Every configuration, for the operator surface. */
export async function listAllFeedConfigurations(
  db: DatabaseOrTransaction,
  limit: number,
): Promise<FeedConfigurationRow[]> {
  return db
    .select()
    .from(feedConfigurations)
    .orderBy(desc(feedConfigurations.createdAt))
    .limit(limit);
}

/**
 * Record what the last successful fetch validated with.
 *
 * Written on `feed_configurations` and never on a version, because a version is
 * frozen and this is not a mapping decision — it is a fact about the last
 * conversation with the host.
 */
export async function recordFeedValidators(
  db: DatabaseOrTransaction,
  input: { configurationId: string; etag: string | null; lastModified: string | null; now: Date },
): Promise<void> {
  await db
    .update(feedConfigurations)
    .set({
      lastEtag: input.etag,
      lastModifiedHeader: input.lastModified,
      lastFetchedAt: input.now,
    })
    .where(eq(feedConfigurations.id, input.configurationId));
}

export interface InsertFeedVersionInput {
  configurationId: string;
  fetchMode: FeedFetchMode;
  feedUrl: string | null;
  uploadId: string | null;
  format: FeedFormat;
  delimiter: string | null;
  quoteChar: string | null;
  encoding: FeedEncoding;
  compression: FeedCompression;
  recordPath: string | null;
  hasHeaderRow: boolean;
  listSeparator: string;
  defaultCurrency: string | null;
  defaultCountry: string | null;
  defaultLanguage: string | null;
  deliveryMode: FeedDeliveryMode;
  authKind: FeedAuthKind;
  authCiphertext: string | null;
  authParamName: string | null;
  mappingNote: string | null;
  createdByOxyUserId: string;
}

/**
 * Draft a new version, numbered after the highest this configuration has had.
 *
 * `max(version) + 1` inside the caller's transaction, and the
 * `feed_configuration_versions_version_key` unique is what makes two concurrent
 * drafts converge on a refusal rather than on two version 4s. The `+ 1` is
 * computed in SQL rather than in JavaScript for the `bigint`-as-string reason
 * `~/Oxy/AGENTS.md` states — `integer` is safe here, but computing it in the
 * statement also makes it atomic with the insert.
 */
export async function insertFeedVersion(
  db: DatabaseOrTransaction,
  input: InsertFeedVersionInput,
): Promise<FeedConfigurationVersionRow> {
  const [row] = await db
    .insert(feedConfigurationVersions)
    .values({
      configurationId: input.configurationId,
      version: sql`(select coalesce(max(v.version), 0) + 1 from feed_configuration_versions v where v.configuration_id = ${input.configurationId})`,
      status: 'draft',
      fetchMode: input.fetchMode,
      feedUrl: input.feedUrl,
      uploadId: input.uploadId,
      format: input.format,
      delimiter: input.delimiter,
      quoteChar: input.quoteChar,
      encoding: input.encoding,
      compression: input.compression,
      recordPath: input.recordPath,
      hasHeaderRow: input.hasHeaderRow,
      listSeparator: input.listSeparator,
      defaultCurrency: input.defaultCurrency,
      defaultCountry: input.defaultCountry,
      defaultLanguage: input.defaultLanguage,
      deliveryMode: input.deliveryMode,
      authKind: input.authKind,
      authCiphertext: input.authCiphertext,
      authParamName: input.authParamName,
      mappingNote: input.mappingNote,
      createdByOxyUserId: input.createdByOxyUserId,
    })
    .returning(VERSION_COLUMNS);
  if (!row) throw new Error('feed_configuration_versions insert returned no row');
  return row;
}

export async function findFeedVersion(
  db: DatabaseOrTransaction,
  versionId: string,
): Promise<FeedConfigurationVersionRow | undefined> {
  const [row] = await db
    .select(VERSION_COLUMNS)
    .from(feedConfigurationVersions)
    .where(eq(feedConfigurationVersions.id, versionId))
    .limit(1);
  return row;
}

export async function listFeedVersions(
  db: DatabaseOrTransaction,
  configurationId: string,
): Promise<FeedConfigurationVersionRow[]> {
  return db
    .select(VERSION_COLUMNS)
    .from(feedConfigurationVersions)
    .where(eq(feedConfigurationVersions.configurationId, configurationId))
    .orderBy(desc(feedConfigurationVersions.version));
}

export async function findActiveFeedVersion(
  db: DatabaseOrTransaction,
  configurationId: string,
): Promise<FeedConfigurationVersionRow | undefined> {
  const [row] = await db
    .select(VERSION_COLUMNS)
    .from(feedConfigurationVersions)
    .where(
      and(
        eq(feedConfigurationVersions.configurationId, configurationId),
        eq(feedConfigurationVersions.status, 'active'),
      ),
    )
    .limit(1);
  return row;
}

/**
 * The two PROTECTED columns of one version.
 *
 * The one function in this repository that reads a credential, and it is
 * separate so that reading one looks different from reading a row. Its callers
 * are the fetcher and nothing else; a projection that reached for it would be
 * visible in review by the name alone.
 */
export async function readFeedVersionSecrets(
  db: DatabaseOrTransaction,
  versionId: string,
): Promise<{ feedUrl: string | null; authCiphertext: string | null } | undefined> {
  const [row] = await db
    .select({
      feedUrl: feedConfigurationVersions.feedUrl,
      authCiphertext: feedConfigurationVersions.authCiphertext,
    })
    .from(feedConfigurationVersions)
    .where(eq(feedConfigurationVersions.id, versionId))
    .limit(1);
  return row;
}

/** Supersede whatever is active, then activate this version. Caller's transaction. */
export async function activateFeedVersion(
  db: DatabaseOrTransaction,
  input: {
    configurationId: string;
    versionId: string;
    validatedReportId: string;
    activatedByOxyUserId: string;
    now: Date;
  },
): Promise<void> {
  await db
    .update(feedConfigurationVersions)
    .set({ status: 'superseded', supersededAt: input.now })
    .where(
      and(
        eq(feedConfigurationVersions.configurationId, input.configurationId),
        eq(feedConfigurationVersions.status, 'active'),
      ),
    );

  await db
    .update(feedConfigurationVersions)
    .set({
      status: 'active',
      validatedReportId: input.validatedReportId,
      activatedByOxyUserId: input.activatedByOxyUserId,
      activatedAt: input.now,
    })
    .where(
      and(
        eq(feedConfigurationVersions.id, input.versionId),
        eq(feedConfigurationVersions.status, 'draft'),
      ),
    );
}

export async function replaceFieldMappings(
  db: DatabaseOrTransaction,
  versionId: string,
  mappings: readonly {
    role: FeedFieldRole;
    sourceField: string | null;
    constantValue: string | null;
    transform: FeedFieldTransform | null;
  }[],
): Promise<void> {
  await db.delete(feedFieldMappings).where(eq(feedFieldMappings.versionId, versionId));
  if (mappings.length === 0) return;
  await db.insert(feedFieldMappings).values(
    mappings.map((mapping) => ({
      versionId,
      role: mapping.role,
      sourceField: mapping.sourceField,
      constantValue: mapping.constantValue,
      transform: mapping.transform,
    })),
  );
}

export async function replaceValueMappings(
  db: DatabaseOrTransaction,
  versionId: string,
  mappings: readonly { role: FeedValueMappingRole; sourceValue: string; targetValue: string }[],
): Promise<void> {
  await db.delete(feedValueMappings).where(eq(feedValueMappings.versionId, versionId));
  if (mappings.length === 0) return;
  await db.insert(feedValueMappings).values(
    mappings.map((mapping) => ({
      versionId,
      role: mapping.role,
      // Stored already lower-cased, which is what makes the unique index the
      // thing that resolves `In Stock` and `in stock` rather than two rules
      // racing at read time.
      sourceValue: mapping.sourceValue.trim().toLowerCase(),
      targetValue: mapping.targetValue.trim(),
    })),
  );
}

export async function listFieldMappings(
  db: DatabaseOrTransaction,
  versionId: string,
): Promise<FeedFieldMappingRow[]> {
  return db.select().from(feedFieldMappings).where(eq(feedFieldMappings.versionId, versionId));
}

export async function listValueMappings(
  db: DatabaseOrTransaction,
  versionId: string,
): Promise<FeedValueMappingRow[]> {
  return db.select().from(feedValueMappings).where(eq(feedValueMappings.versionId, versionId));
}

/** The default handle, for callers with no transaction of their own. */
export function feedImportDb(): DatabaseOrTransaction {
  return getDb();
}
