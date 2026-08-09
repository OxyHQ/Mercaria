/**
 * Creating a feed, versioning its mapping and activating one (#63 §"Feed
 * configuration", Mapping UX 5 and 6, security 6).
 *
 * ## A feed IS a #62 source, and this is the only place the two are bound
 *
 * `configureIngestionSource` registers the `catalog_sources` row and its
 * `catalog_source_configs` extension; this then writes the `feed_configurations`
 * row and binds the two by putting the configuration's id in
 * `source_account_ref` — which is what the adapter is handed at fetch time.
 * That binding is written ONCE, here, so an adapter cannot be pointed at another
 * store's feed by anything short of an operator editing the source.
 *
 * The source is created in `draft` with NO rights, exactly as #62 does for every
 * source: a feed that has just been configured permits no storage, no display
 * and no refresh until somebody publishes a rights policy and activates it. #63
 * adds no second rights model and no way around that one.
 *
 * ## Activation cites a validation report and refuses a preview
 *
 * `FEED_ACTIVATING_REPORT_MODES` is one member, and this service refuses a
 * report of any other mode by name. It ALSO refuses a report with no valid
 * records — but deliberately not one with SOME invalid records: a feed of a
 * hundred thousand rows with four bad ones is an ordinary feed, and refusing it
 * would make the gate unusable and therefore removed.
 */

import type {
  FeedAuthKind,
  FeedCompression,
  FeedDeliveryMode,
  FeedEncoding,
  FeedFetchMode,
  FeedFieldRole,
  FeedFieldTransform,
  FeedFormat,
} from '@mercaria/shared-types';
import {
  FEED_ACTIVATING_REPORT_MODES,
  FEED_DELIMITED_FORMATS,
  FEED_MAPPABLE_VALUE_ROLES,
  FEED_RECORD_PATH_FORMATS,
  FEED_REQUIRED_FIELD_ROLES,
  ITEM_CONDITION_KEYS,
  OFFER_AVAILABILITY_STATES,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  activateFeedVersion as activateVersionRow,
  findFeedConfiguration,
  findFeedVersion,
  insertFeedConfiguration,
  insertFeedVersion,
  listFieldMappings,
  listValueMappings,
  readFeedVersionSecrets,
  replaceFieldMappings,
  replaceValueMappings,
  type FeedConfigurationRow,
  type FeedConfigurationVersionRow,
  type FeedValueMappingRole,
} from '../../db/feedImport/feedConfigurationRepository.js';
import { findFeedImportReport } from '../../db/feedImport/feedImportReportRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { configureIngestionSource } from '../ingestion/source.service.js';
import { PRODUCT_FEED_PROVIDER } from '../ingestion/adapters/product-feed.js';
import { decryptFeedCredential, encryptFeedCredential } from './auth.js';

export interface CreateFeedConfigurationInput {
  /** `null` for an operator-managed feed; a store id for a merchant-managed one. */
  storeId: string | null;
  /** The `catalog_sources` name. Unique across the registry. */
  sourceName: string;
  label: string;
  /** The feed's OWN key columns. Frozen once written — see the schema docblock. */
  identityKeyFields: readonly string[];
  /** The seller of record every offer from this feed belongs to (#62 boundary 2). */
  merchantId?: string;
  territories?: readonly string[];
  fetchCadenceSeconds?: number;
  freshnessTtlSeconds?: number;
  actorOxyUserId: string;
}

/** Create the #62 source and the feed configuration, and bind them. */
export async function createFeedConfiguration(
  input: CreateFeedConfigurationInput,
): Promise<FeedConfigurationRow> {
  if (input.identityKeyFields.length === 0) {
    throw validationError(
      'A feed must name the columns that identify a product. They are FROZEN once set: ' +
        're-keying a feed re-mints every object and retires the catalogue behind the old ids.',
    );
  }

  const source = await configureIngestionSource({
    name: input.sourceName,
    kind: 'feed',
    provider: PRODUCT_FEED_PROVIDER,
    ...(input.merchantId === undefined ? {} : { merchantId: input.merchantId }),
    ...(input.territories === undefined ? {} : { territories: input.territories }),
    ...(input.fetchCadenceSeconds === undefined
      ? {}
      : { fetchCadenceSeconds: input.fetchCadenceSeconds }),
    ...(input.freshnessTtlSeconds === undefined
      ? {}
      : { freshnessTtlSeconds: input.freshnessTtlSeconds }),
  });

  const configuration = await getDb().transaction(async (tx) =>
    insertFeedConfiguration(tx, {
      sourceId: source.source.config.sourceId,
      ownerKind: input.storeId === null ? 'operator' : 'merchant',
      storeId: input.storeId,
      label: input.label,
      identityKeyFields: input.identityKeyFields,
      createdByOxyUserId: input.actorOxyUserId,
    }),
  );

  // The binding the adapter reads. Written after the configuration exists,
  // through the SAME upsert that created the source — `configureIngestionSource`
  // converges on the registry name, so this is a reconfiguration and not a
  // second source.
  await configureIngestionSource({
    name: input.sourceName,
    kind: 'feed',
    provider: PRODUCT_FEED_PROVIDER,
    sourceAccountRef: configuration.id,
    ...(input.merchantId === undefined ? {} : { merchantId: input.merchantId }),
    ...(input.territories === undefined ? {} : { territories: input.territories }),
    ...(input.fetchCadenceSeconds === undefined
      ? {}
      : { fetchCadenceSeconds: input.fetchCadenceSeconds }),
    ...(input.freshnessTtlSeconds === undefined
      ? {}
      : { freshnessTtlSeconds: input.freshnessTtlSeconds }),
  });

  return configuration;
}

/** One mapping instruction, as a caller supplies it. */
export interface DraftFieldMappingInput {
  role: FeedFieldRole;
  sourceField?: string;
  constantValue?: string;
  transform?: FeedFieldTransform;
}

/** One value rewrite, as a caller supplies it. */
export interface DraftValueMappingInput {
  role: FeedValueMappingRole;
  sourceValue: string;
  targetValue: string;
}

export interface DraftFeedVersionInput {
  configurationId: string;
  fetchMode: FeedFetchMode;
  feedUrl?: string;
  uploadId?: string;
  format: FeedFormat;
  delimiter?: string;
  quoteChar?: string;
  encoding?: FeedEncoding;
  compression?: FeedCompression;
  recordPath?: string;
  hasHeaderRow?: boolean;
  listSeparator?: string;
  defaultCurrency?: string;
  defaultCountry?: string;
  defaultLanguage?: string;
  deliveryMode: FeedDeliveryMode;
  authKind?: FeedAuthKind;
  /** PLAINTEXT. Encrypted here and never stored, logged or returned otherwise. */
  authSecret?: string;
  authParamName?: string;
  mappingNote?: string;
  fieldMappings: readonly DraftFieldMappingInput[];
  valueMappings?: readonly DraftValueMappingInput[];
  actorOxyUserId: string;
}

/**
 * Draft a new mapping version.
 *
 * Every refusal below names the rule in words. The CHECKs refuse the same
 * combinations at the row, and a 23514 never tells a merchant which of their
 * form fields to change.
 */
export async function draftFeedVersion(
  input: DraftFeedVersionInput,
): Promise<FeedConfigurationVersionRow> {
  const configuration = await findFeedConfiguration(getDb(), input.configurationId);
  if (configuration === undefined) throw notFound('Feed configuration not found');

  const format = input.format;
  const isDelimited = FEED_DELIMITED_FORMATS.includes(format);
  const needsRecordPath = FEED_RECORD_PATH_FORMATS.includes(format);

  if (input.fetchMode === 'url' && (input.feedUrl ?? '') === '') {
    throw validationError('A URL feed must state its URL.');
  }
  if (input.fetchMode === 'upload' && (input.uploadId ?? '') === '') {
    throw validationError('An uploaded feed must name the upload it reads.');
  }
  if (input.fetchMode === 'url' && !(input.feedUrl ?? '').toLowerCase().startsWith('https://')) {
    throw validationError(
      'A feed must be fetched over HTTPS. A feed served in cleartext can be rewritten in ' +
        'transit, and a rewritten feed is a catalogue of somebody else’s choosing.',
    );
  }
  if (needsRecordPath && (input.recordPath ?? '') === '') {
    throw validationError(
      `A ${format} feed must state the record path naming the element or array its products ` +
        'are published in. Without it a pass that read the document and produced nothing would ' +
        'report a complete enumeration over an empty catalogue.',
    );
  }
  if (!needsRecordPath && input.recordPath !== undefined) {
    throw validationError(`A ${format} feed's records are its rows or its lines; it has no record path.`);
  }
  if (isDelimited) {
    const delimiter = input.delimiter ?? (format === 'tsv' ? '\t' : ',');
    const quoteChar = input.quoteChar ?? '"';
    if (delimiter.length !== 1 || quoteChar.length !== 1) {
      throw validationError(
        'A delimiter and a quote character are one character each. A multi-character delimiter ' +
          'is a separator pattern, and this importer evaluates none.',
      );
    }
  }
  if (!isDelimited && (input.hasHeaderRow ?? false)) {
    throw validationError('A header row is a property a delimited feed has and a document does not.');
  }

  const authKind: FeedAuthKind = input.authKind ?? 'none';
  if (authKind === 'none' && input.authSecret !== undefined) {
    throw validationError('A credential was supplied for a feed configured with no authentication.');
  }
  if (authKind !== 'none' && (input.authSecret ?? '') === '') {
    throw validationError(
      `A feed configured for ${authKind} authentication must supply the credential. Storing the ` +
        'kind without the secret produces a feed that fetches unauthenticated and reports every ' +
        '401 as a source outage.',
    );
  }
  if ((authKind === 'header' || authKind === 'query_param') && (input.authParamName ?? '') === '') {
    throw validationError(`A ${authKind} credential must name the header or parameter it is sent in.`);
  }

  assertMappingsAreComplete(input.fieldMappings);
  assertValueMappingsAreValid(input.valueMappings ?? []);

  return getDb().transaction(async (tx) => {
    const version = await insertFeedVersion(tx, {
      configurationId: input.configurationId,
      fetchMode: input.fetchMode,
      feedUrl: input.feedUrl ?? null,
      uploadId: input.uploadId ?? null,
      format,
      delimiter: isDelimited ? (input.delimiter ?? (format === 'tsv' ? '\t' : ',')) : null,
      quoteChar: isDelimited ? (input.quoteChar ?? '"') : null,
      encoding: input.encoding ?? 'utf-8',
      compression: input.compression ?? 'none',
      recordPath: input.recordPath ?? null,
      hasHeaderRow: input.hasHeaderRow ?? false,
      listSeparator: input.listSeparator ?? ',',
      defaultCurrency: input.defaultCurrency ?? null,
      defaultCountry: input.defaultCountry ?? null,
      defaultLanguage: input.defaultLanguage ?? null,
      deliveryMode: input.deliveryMode,
      authKind,
      authCiphertext:
        input.authSecret === undefined ? null : encryptFeedCredential(input.authSecret),
      authParamName: input.authParamName ?? null,
      mappingNote: input.mappingNote ?? null,
      createdByOxyUserId: input.actorOxyUserId,
    });

    await replaceFieldMappings(
      tx,
      version.id,
      input.fieldMappings.map((mapping) => ({
        role: mapping.role,
        sourceField: mapping.sourceField ?? null,
        constantValue: mapping.constantValue ?? null,
        transform: mapping.transform ?? null,
      })),
    );
    await replaceValueMappings(tx, version.id, input.valueMappings ?? []);
    return version;
  });
}

/**
 * Copy an earlier version into a new DRAFT — the rollback of issue Mapping UX 5.
 *
 * A copy rather than a resurrection, because a version is frozen once it leaves
 * `draft` and every stored observation cites the version it was read under.
 * Re-activating an old row would make "which mapping produced this fact"
 * ambiguous for every observation taken under it since; a new version numbered
 * after the current head keeps the chain readable backwards in time.
 *
 * The URL and the credential come from `readFeedVersionSecrets` — the ONE
 * function that reads the two PROTECTED columns — and are re-encrypted under
 * the current key on the way in. Neither value leaves the backend at any point
 * in this call, and asking a merchant to re-type a feed key to undo a mapping
 * mistake would be a rollback nobody performs.
 */
export async function revertToFeedVersion(input: {
  configurationId: string;
  versionId: string;
  actorOxyUserId: string;
}): Promise<FeedConfigurationVersionRow> {
  const db = getDb();
  const source = await findFeedVersion(db, input.versionId);
  if (source === undefined || source.configurationId !== input.configurationId) {
    throw notFound('Mapping version not found for this feed');
  }
  const secrets = await readFeedVersionSecrets(db, source.id);
  if (secrets === undefined) throw notFound('Mapping version not found for this feed');
  const fieldMappings = await listFieldMappings(db, source.id);
  const valueMappings = await listValueMappings(db, source.id);

  return draftFeedVersion({
    configurationId: input.configurationId,
    fetchMode: source.fetchMode,
    ...(source.uploadId === null ? {} : { uploadId: source.uploadId }),
    format: source.format,
    ...(source.delimiter === null ? {} : { delimiter: source.delimiter }),
    ...(source.quoteChar === null ? {} : { quoteChar: source.quoteChar }),
    encoding: source.encoding,
    compression: source.compression,
    ...(source.recordPath === null ? {} : { recordPath: source.recordPath }),
    hasHeaderRow: source.hasHeaderRow,
    listSeparator: source.listSeparator,
    ...(source.defaultCurrency === null ? {} : { defaultCurrency: source.defaultCurrency }),
    ...(source.defaultCountry === null ? {} : { defaultCountry: source.defaultCountry }),
    ...(source.defaultLanguage === null ? {} : { defaultLanguage: source.defaultLanguage }),
    deliveryMode: source.deliveryMode,
    authKind: source.authKind,
    ...(secrets.authCiphertext === null
      ? {}
      : { authSecret: decryptFeedCredential(secrets.authCiphertext) }),
    ...(source.authParamName === null ? {} : { authParamName: source.authParamName }),
    mappingNote: `Reverted from version ${source.version}`,
    fieldMappings: fieldMappings.map((mapping) => ({
      role: mapping.role,
      ...(mapping.sourceField === null ? {} : { sourceField: mapping.sourceField }),
      ...(mapping.constantValue === null ? {} : { constantValue: mapping.constantValue }),
      ...(mapping.transform === null ? {} : { transform: mapping.transform }),
    })),
    valueMappings: valueMappings.map((mapping) => ({
      role: mapping.role,
      sourceValue: mapping.sourceValue,
      targetValue: mapping.targetValue,
    })),
    actorOxyUserId: input.actorOxyUserId,
    ...(secrets.feedUrl === null ? {} : { feedUrl: secrets.feedUrl }),
  });
}

/** Activate a version, citing the validation run that justified it. */
export async function activateFeedVersion(input: {
  configurationId: string;
  versionId: string;
  reportId: string;
  actorOxyUserId: string;
}): Promise<void> {
  const db = getDb();
  const version = await findFeedVersion(db, input.versionId);
  if (version === undefined || version.configurationId !== input.configurationId) {
    throw notFound('Mapping version not found for this feed');
  }
  if (version.status !== 'draft') {
    throw conflict('Only a draft mapping version can be activated.');
  }

  const report = await findFeedImportReport(db, input.reportId);
  if (report === undefined || report.versionId !== input.versionId) {
    throw notFound('Validation report not found for this mapping version');
  }
  if (!FEED_ACTIVATING_REPORT_MODES.includes(report.mode)) {
    throw validationError(
      `A ${report.mode} report cannot justify an activation. A preview reads a bounded sample, ` +
        'and a mapping breaks at the fifty-thousandth row rather than the fiftieth.',
    );
  }
  if (report.valid === 0) {
    throw validationError(
      'The validation run produced no valid records. Activating would publish a mapping that ' +
        'reads nothing, and on a snapshot feed a complete enumeration of nothing retires the ' +
        'whole catalogue.',
    );
  }

  await db.transaction(async (tx) => {
    await activateVersionRow(tx, {
      configurationId: input.configurationId,
      versionId: input.versionId,
      validatedReportId: input.reportId,
      activatedByOxyUserId: input.actorOxyUserId,
      now: new Date(),
    });
  });
}

/**
 * Every required role is mapped, and every mapping states exactly one source.
 *
 * The `num_nonnulls` CHECK refuses the second at the row; refusing it here names
 * the role a merchant has to fix, which a 23514 never does.
 */
function assertMappingsAreComplete(mappings: readonly DraftFieldMappingInput[]): void {
  const roles = new Set(mappings.map((mapping) => mapping.role));
  for (const required of FEED_REQUIRED_FIELD_ROLES) {
    if (!roles.has(required)) {
      throw validationError(`The mapping must fill the '${required}' role.`);
    }
  }
  for (const mapping of mappings) {
    const sources = [mapping.sourceField, mapping.constantValue].filter(
      (value) => value !== undefined && value !== '',
    );
    if (sources.length !== 1) {
      throw validationError(
        `The '${mapping.role}' mapping must name exactly one of a source column or a constant ` +
          'value. There is deliberately no expression, template or fallback chain.',
      );
    }
  }
}

/**
 * A value rewrite targets a value the domain that owns it recognises.
 *
 * Availability is checked against `OFFER_AVAILABILITY_STATES` and condition
 * against #90's `ITEM_CONDITION_KEYS`, because those are the vocabularies the
 * two roles land in. Mercaria still stores the condition LABEL verbatim — #90
 * owns mapping it — so this refusal is about the merchant's own table being
 * useful rather than about Mercaria reinterpreting their word.
 */
function assertValueMappingsAreValid(mappings: readonly DraftValueMappingInput[]): void {
  for (const mapping of mappings) {
    if (!FEED_MAPPABLE_VALUE_ROLES.includes(mapping.role)) {
      throw validationError(
        `Values cannot be rewritten for the '${mapping.role}' role. A per-value rewrite table ` +
          'over free text is a find-and-replace engine.',
      );
    }
    if (
      mapping.role === 'availability' &&
      !(OFFER_AVAILABILITY_STATES as readonly string[]).includes(mapping.targetValue)
    ) {
      throw validationError(
        `'${mapping.targetValue}' is not an availability Mercaria represents. The states are ` +
          `${OFFER_AVAILABILITY_STATES.join(', ')}.`,
      );
    }
    if (
      mapping.role === 'condition' &&
      !(ITEM_CONDITION_KEYS as readonly string[]).includes(mapping.targetValue)
    ) {
      throw validationError(
        `'${mapping.targetValue}' is not one of Mercaria's condition keys. The label is stored ` +
          'verbatim either way; a rewrite exists so the mapping lands on a key #90 recognises.',
      );
    }
  }
}
