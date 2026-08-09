/**
 * Resolving the ACTIVE mapping of one source into everything a pass needs
 * (#63).
 *
 * This is the boundary between "rows in Postgres" and "how to read a file". It
 * is the ONE function that decrypts a feed credential and the ONE function that
 * reads the protected URL column, and both facts are visible in its name and in
 * the repository function it calls (`readFeedVersionSecrets`), which is the
 * point: reading a credential should not look like reading a row.
 *
 * It is also the function the adapter receives INJECTED rather than importing.
 * `services/ingestion/adapters/product-feed.ts` cannot reach a repository — the
 * #62 isolation gate scans that directory for exactly that — so its dependency
 * is a plain function type, satisfied here at registration time. That keeps the
 * write boundary the gate exists for: an adapter still has no path into the
 * commerce graph, because reading its own configuration is not one.
 */

import type {
  FeedCompression,
  FeedDeliveryMode,
  FeedEncoding,
  FeedFetchMode,
  FeedFieldMapping,
  FeedFieldRole,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findActiveFeedVersion,
  findFeedConfiguration,
  findFeedConfigurationBySource,
  findFeedVersion,
  listFieldMappings,
  listValueMappings,
  readFeedVersionSecrets,
  recordFeedValidators,
  type FeedConfigurationVersionRow,
} from '../../db/feedImport/feedConfigurationRepository.js';
import { findFeedUpload } from '../../db/feedImport/feedImportReportRepository.js';
import { decryptFeedCredential, type FeedAuthorization } from './auth.js';
import { FeedImportRefusal } from './errors.js';
import type { FeedValidators } from './fetch.js';
import type { ResolvedFeedMapping } from './mapping.js';
import type { FeedOrigin } from './open.js';
import type { FeedParseOptions } from './parse/index.js';

/** One feed, ready to be read. Carries no row and no drizzle handle. */
export interface ResolvedFeedImport {
  readonly configurationId: string;
  readonly versionId: string;
  readonly deliveryMode: FeedDeliveryMode;
  readonly compression: FeedCompression;
  readonly encoding: FeedEncoding;
  readonly parseOptions: FeedParseOptions;
  readonly mapping: ResolvedFeedMapping;
  readonly origin: FeedOrigin;
}

/**
 * Resolve the active mapping of the feed configuration `configurationId` names.
 *
 * `null` when there is no configuration or no ACTIVE version, which is the
 * fail-closed direction: a source whose mapping is still a draft refuses its
 * run with `configuration_missing` rather than fetching under a mapping nobody
 * validated.
 */
export async function resolveFeedImport(
  configurationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ResolvedFeedImport | null> {
  const configuration = await findFeedConfigurationById(configurationId, db);
  if (configuration === null) return null;
  const version = await findActiveFeedVersion(db, configuration.id);
  if (version === undefined) return null;
  return resolveVersion(configuration, version, db);
}

/**
 * Resolve ONE named version, active or not.
 *
 * The preview and validation surfaces read a DRAFT — that is their whole point,
 * since a version cannot be activated until a validation run has read the feed
 * under it (issue Mapping UX 6). The import path deliberately has no access to
 * this function: `resolveFeedImport` reads the active version and nothing else,
 * so a draft mapping cannot reach a live catalogue by any route.
 */
export async function resolveFeedImportVersion(
  configurationId: string,
  versionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ResolvedFeedImport | null> {
  const configuration = await findFeedConfigurationById(configurationId, db);
  if (configuration === null) return null;
  const version = await findFeedVersion(db, versionId);
  if (version === undefined || version.configurationId !== configuration.id) return null;
  return resolveVersion(configuration, version, db);
}

async function resolveVersion(
  configuration: ResolvedConfigurationFacts,
  version: FeedConfigurationVersionRow,
  db: DatabaseOrTransaction,
): Promise<ResolvedFeedImport | null> {

  const secrets = await readFeedVersionSecrets(db, version.id);
  if (secrets === undefined) return null;

  const authorization: FeedAuthorization = {
    kind: version.authKind,
    secret: secrets.authCiphertext === null ? null : decryptFeedCredential(secrets.authCiphertext),
    paramName: version.authParamName,
  };

  let uploadStorageKey: string | null = null;
  if (version.fetchMode === 'upload' && version.uploadId !== null) {
    const upload = await findFeedUpload(db, version.uploadId);
    if (upload === undefined) {
      throw new FeedImportRefusal(
        'upload_missing',
        'The mapping version names an upload that no longer exists.',
      );
    }
    uploadStorageKey = upload.storageKey;
  }

  const fieldMappings = new Map<FeedFieldRole, FeedFieldMapping>();
  for (const row of await listFieldMappings(db, version.id)) {
    fieldMappings.set(row.role, {
      role: row.role,
      ...(row.sourceField === null ? {} : { sourceField: row.sourceField }),
      ...(row.constantValue === null ? {} : { constantValue: row.constantValue }),
      ...(row.transform === null ? {} : { transform: row.transform }),
    });
  }

  const valueMappings = new Map<string, string>();
  for (const row of await listValueMappings(db, version.id)) {
    valueMappings.set(`${row.role}:${row.sourceValue}`, row.targetValue);
  }

  const fetchMode: FeedFetchMode = version.fetchMode;
  const validators: FeedValidators = {
    etag: configuration.lastEtag,
    lastModified: configuration.lastModifiedHeader,
  };

  return {
    configurationId: configuration.id,
    versionId: version.id,
    deliveryMode: version.deliveryMode,
    compression: version.compression,
    encoding: version.encoding,
    parseOptions: {
      format: version.format,
      // A delimited format's CHECK guarantees both are present; the fallbacks
      // are what the type demands and the database has already refused.
      delimiter: version.delimiter ?? (version.format === 'tsv' ? '\t' : ','),
      quoteChar: version.quoteChar ?? '"',
      hasHeaderRow: version.hasHeaderRow,
      recordPath: version.recordPath,
      listSeparator: version.listSeparator,
      maxRecordBytes: config.feedImport.maxRecordBytes,
      maxRecords: config.feedImport.maxRecords,
    },
    mapping: {
      fieldMappings,
      valueMappings,
      identityKeyFields: configuration.identityKeyFields,
      listSeparator: version.listSeparator,
      defaultCurrency: version.defaultCurrency,
      defaultCountry: version.defaultCountry,
      defaultLanguage: version.defaultLanguage,
    },
    origin: {
      fetchMode,
      feedUrl: secrets.feedUrl,
      uploadStorageKey,
      authorization,
      validators,
      timeoutMs: config.feedImport.fetchTimeoutMs,
    },
  };
}

/**
 * Resolve by CONFIGURATION id, which is what `catalog_source_configs.source_account_ref`
 * carries for a feed source.
 *
 * The adapter is handed `sourceAccountRef` and never a Mercaria row id it could
 * have guessed, and the binding is written once when the source is configured
 * (`configuration.service.ts`), so the two cannot drift into a source pointing
 * at another store's feed.
 */
/** The three configuration facts a resolution needs, and no row. */
interface ResolvedConfigurationFacts {
  readonly id: string;
  readonly identityKeyFields: readonly string[];
  readonly lastEtag: string | null;
  readonly lastModifiedHeader: string | null;
}

async function findFeedConfigurationById(
  configurationId: string,
  db: DatabaseOrTransaction,
): Promise<ResolvedConfigurationFacts | null> {
  const row = await findFeedConfiguration(db, configurationId);
  if (row === undefined) return null;
  return {
    id: row.id,
    identityKeyFields: row.identityKeyFields,
    lastEtag: row.lastEtag,
    lastModifiedHeader: row.lastModifiedHeader,
  };
}

/** Record what the last successful fetch validated with (#63 supported inputs 5). */
export async function recordFeedImportValidators(
  feed: ResolvedFeedImport,
  validators: FeedValidators,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await recordFeedValidators(db, {
    configurationId: feed.configurationId,
    etag: validators.etag,
    lastModified: validators.lastModified,
    now,
  });
}

/** The source id a configuration belongs to — used by the operator projections. */
export async function feedSourceIdFor(
  configurationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string | null> {
  const row = await findFeedConfiguration(db, configurationId);
  return row?.sourceId ?? null;
}

/** Resolve by SOURCE id, for the operator surface's own reads. */
export async function resolveFeedImportBySource(
  sourceId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ResolvedFeedImport | null> {
  const configuration = await findFeedConfigurationBySource(db, sourceId);
  if (configuration === undefined) return null;
  return resolveFeedImport(configuration.id, db);
}
