/**
 * THE registry of every place Mercaria holds an Oxy file id (Oxy ADR 0043 D4):
 * per reference `entityType`, which rows hold its files, which row id is the
 * `entityId`, who owns the bytes, and what a blocked or deleted file does to the
 * holding row. `docs/catalog-media.md` renders this table for people.
 *
 * Three consumers read it, and nothing else decides any of this:
 *
 * - the reference worker (`file-reference-outbox.ts`) — what an entity holds
 *   NOW, to diff against what Oxy was told;
 * - the reconciliation (`file-reference-reconciliation.ts`) — the whole
 *   inventory of a type, paged;
 * - the file-event handler (`file-events.ts`) — which rows hold a file, and the
 *   presentation change a takedown makes.
 *
 * `oxy-file-reference-registry.test.ts` holds it complete: every entity type has
 * exactly one entry, and every column `deferredForeignKeys.ts` classifies as an
 * Oxy file id is a holding column of some entry — so a NEW file column that
 * nobody registered fails the build instead of silently reading as unused to
 * Oxy, which collects an unused application file.
 */

import {
  OXY_FILE_REFERENCE_ENTITY_TYPES,
  isOxyFileId,
  type OxyFileEventAction,
  type OxyFileEventType,
  type OxyFileOwnerKind,
  type OxyFileReferenceEntityType,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  readHoldingEntityPage,
  readHoldingRows,
  readHoldingRowsForFile,
  type HoldingSource,
  type HoldingValueKind,
} from '../../db/oxyFiles/holdingsRepository.js';
import { clearCategoryImagesByFile } from '../../db/taxonomy/taxonomyRepository.js';
import { suppressCanonicalImagesByFile } from '../../db/canonical/attributeRepository.js';
import {
  clearBrandLogosByFile,
  clearCollectionImagesByFile,
  clearStoreArtworkByFile,
  removeAuthoringDraftImagesByFile,
  removeListingImagesByFile,
  removeReviewMediaByFile,
  removeSellerDraftImagesByFile,
  rewriteHtmlColumnsByFile,
  suppressConditionPhotosByFile,
} from '../../db/oxyFiles/detachRepository.js';
import { findAssetFileIdPage, findAssetFileStorageKey } from '../../db/digital/assetRepository.js';
import { descriptionImageFileIds, withoutDescriptionImage } from './description.js';
import { storedMediaFileId } from './urls.js';

/** Who owns the bytes, for the documentation and the backfills. */
export type FileReferenceOwner =
  /** `stores.oxy_account_id`, or a P2P listing's seller. */
  | 'store_or_seller'
  | 'store'
  /** The Mercaria application (ADR 0043 D1): content no account owns. */
  | 'application'
  /** Whoever uploaded it — a buyer's review media, a party's evidence. */
  | 'uploader'
  /** The creator's private deliverable, stored by `services/digital/storage.ts`. */
  | 'creator';

/** How a holding row learns its reference changed. */
export type FileReferenceRegistration =
  /** A trigger of migration `0170` enqueues every write (the default). */
  | 'trigger'
  /** Only the nightly reconciliation registers it; the writer is never made to depend on this. */
  | 'reconciliation'
  /** Registered by its one writer at write time; reconciled only from a dedicated `inventory`. */
  | 'writer';

export interface FileEventOutcome {
  readonly action: OxyFileEventAction;
  readonly entityIds: readonly string[];
}

export interface FileReferenceEntityDefinition {
  readonly entityType: OxyFileReferenceEntityType;
  readonly ownerKind: OxyFileOwnerKind;
  readonly owner: FileReferenceOwner;
  /** What the `entityId` is, in words — rendered into `docs/catalog-media.md`. */
  readonly entityId: string;
  readonly registration: FileReferenceRegistration;
  /** The rows that hold this type's files. Empty only for a `writer` type. */
  readonly sources: readonly HoldingSource[];
  /**
   * The inventory, when the holding rows cannot be read by the generic holding
   * queries (a protected column read through its one sanctioned function).
   * Such a type has no `sources`, so it is never converged by the outbox — only
   * registered by its writer and reconciled from this.
   */
  readonly inventory?: (
    db: DatabaseOrTransaction,
  ) => AsyncIterable<{ fileId: string; entityId: string }>;
  /**
   * What a blocked or deleted file does to the holding rows. Absent: the rows
   * are history and are only recorded (`retained`).
   */
  readonly detach?: (
    tx: DatabaseOrTransaction,
    fileId: string,
    event: OxyFileEventType,
  ) => Promise<FileEventOutcome>;
}

/**
 * Oxy's own bound on a file id (`serviceReferenceSchema`: at most 64). A value
 * past it is no Oxy file, and sending one would make Oxy refuse the WHOLE batch
 * of 100 it rides in — one legacy row would hold up every entity beside it.
 */
const MAX_OXY_FILE_ID_LENGTH = 64;

function isReferenceableFileId(value: unknown): value is string {
  return isOxyFileId(value) && value.length <= MAX_OXY_FILE_ID_LENGTH;
}

/** The file ids one raw column value holds. */
export function fileIdsOf(kind: HoldingValueKind, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  switch (kind) {
    case 'file_id':
      return isReferenceableFileId(value) ? [value] : [];
    case 'file_id_array':
      return Array.isArray(value)
        ? value.filter((item): item is string => isReferenceableFileId(item))
        : [];
    case 'stored_url': {
      const fileId = typeof value === 'string' ? storedMediaFileId(value) : undefined;
      return isReferenceableFileId(fileId) ? [fileId] : [];
    }
    case 'html':
      return typeof value === 'string'
        ? descriptionImageFileIds(value).filter(isReferenceableFileId)
        : [];
  }
}

function single(table: string, entityColumn: string, column: string, kind: HoldingValueKind) {
  return { table, entityColumn, columns: [{ name: column, kind }] } satisfies HoldingSource;
}

function removed(entityIds: readonly string[]): FileEventOutcome {
  return { action: 'removed', entityIds };
}

function suppressed(entityIds: readonly string[]): FileEventOutcome {
  return { action: 'suppressed', entityIds };
}

/** Remove the file's `<img>` from every HTML column of the given sources. */
function htmlDetach(sources: readonly HoldingSource[]) {
  return async (tx: DatabaseOrTransaction, fileId: string): Promise<FileEventOutcome> => {
    const changed: string[] = [];
    for (const source of sources) {
      changed.push(
        ...(await rewriteHtmlColumnsByFile(tx, {
          table: source.table,
          entityColumn: source.entityColumn,
          columns: source.columns.map((column) => column.name),
          fileId,
          rewrite: (html) => withoutDescriptionImage(html, fileId),
        })),
      );
    }
    return removed([...new Set(changed)]);
  };
}

const LISTING_DESCRIPTION_SOURCES = [
  single('listings', 'id', 'description', 'html'),
  single('listing_localizations', 'listing_id', 'description', 'html'),
] as const;
const CANONICAL_DESCRIPTION_SOURCES = [
  single('canonical_products', 'id', 'description', 'html'),
  single('canonical_product_localizations', 'canonical_product_id', 'description', 'html'),
] as const;
const STORE_POLICY_SOURCES = [
  {
    table: 'stores',
    entityColumn: 'id',
    columns: [
      { name: 'policies_shipping_note', kind: 'html' },
      { name: 'policies_refund_policy', kind: 'html' },
      { name: 'policies_privacy_policy', kind: 'html' },
      { name: 'policies_terms_of_service', kind: 'html' },
    ],
  },
] as const satisfies readonly HoldingSource[];

function evidence(
  entityType: OxyFileReferenceEntityType,
  table: string,
  column: string,
): FileReferenceEntityDefinition {
  return {
    entityType,
    ownerKind: 'account',
    owner: 'uploader',
    entityId: `${table}.id`,
    registration: 'trigger',
    sources: [single(table, 'id', column, 'file_id')],
  };
}

const DEFINITIONS: readonly FileReferenceEntityDefinition[] = [
  {
    entityType: 'listing_image',
    ownerKind: 'account',
    owner: 'store_or_seller',
    entityId: 'listings.id (one reference per file per gallery)',
    registration: 'trigger',
    sources: [single('listing_images', 'listing_id', 'file_id', 'file_id')],
    detach: async (tx, fileId) => removed(await removeListingImagesByFile(tx, fileId)),
  },
  {
    entityType: 'listing_description_image',
    ownerKind: 'account',
    owner: 'store_or_seller',
    entityId: 'listings.id (its description and every localized one)',
    registration: 'trigger',
    sources: LISTING_DESCRIPTION_SOURCES,
    detach: htmlDetach(LISTING_DESCRIPTION_SOURCES),
  },
  {
    entityType: 'condition_photo',
    ownerKind: 'account',
    owner: 'store_or_seller',
    entityId: 'listing_condition_photos.id',
    registration: 'trigger',
    sources: [single('listing_condition_photos', 'id', 'file_id', 'file_id')],
    detach: async (tx, fileId, event) =>
      suppressed(
        await suppressConditionPhotosByFile(
          tx,
          fileId,
          event === 'file.blocked' ? 'rejected' : 'withdrawn',
        ),
      ),
  },
  {
    entityType: 'store_logo',
    ownerKind: 'account',
    owner: 'store',
    entityId: 'stores.id',
    registration: 'trigger',
    sources: [single('stores', 'id', 'logo_file_id', 'file_id')],
    detach: async (tx, fileId) => removed(await clearStoreArtworkByFile(tx, fileId, 'logo')),
  },
  {
    entityType: 'store_cover',
    ownerKind: 'account',
    owner: 'store',
    entityId: 'stores.id',
    registration: 'trigger',
    sources: [single('stores', 'id', 'cover_file_id', 'file_id')],
    detach: async (tx, fileId) => removed(await clearStoreArtworkByFile(tx, fileId, 'cover')),
  },
  {
    entityType: 'store_policy_image',
    ownerKind: 'account',
    owner: 'store',
    entityId: 'stores.id (its four policy texts)',
    registration: 'trigger',
    sources: STORE_POLICY_SOURCES,
    detach: htmlDetach(STORE_POLICY_SOURCES),
  },
  {
    entityType: 'collection_image',
    ownerKind: 'account',
    owner: 'store',
    entityId: 'collections.id',
    registration: 'trigger',
    sources: [single('collections', 'id', 'image_file_id', 'file_id')],
    detach: async (tx, fileId) => removed(await clearCollectionImagesByFile(tx, fileId)),
  },
  {
    entityType: 'seller_draft_image',
    ownerKind: 'account',
    owner: 'store_or_seller',
    entityId: 'seller_listing_drafts.id',
    registration: 'trigger',
    sources: [single('seller_draft_images', 'draft_id', 'file_id', 'file_id')],
    detach: async (tx, fileId) => removed(await removeSellerDraftImagesByFile(tx, fileId)),
  },
  {
    entityType: 'authoring_draft_image',
    ownerKind: 'account',
    owner: 'store',
    entityId: 'catalog_authoring_drafts.id',
    registration: 'trigger',
    sources: [single('catalog_authoring_drafts', 'id', 'image_file_ids', 'file_id_array')],
    detach: async (tx, fileId) => removed(await removeAuthoringDraftImagesByFile(tx, fileId)),
  },
  {
    entityType: 'canonical_image',
    ownerKind: 'application',
    owner: 'application',
    entityId: 'canonical_images.id (product or variant grain)',
    registration: 'trigger',
    sources: [single('canonical_images', 'id', 'file_id', 'file_id')],
    detach: async (tx, fileId) => suppressed(await suppressCanonicalImagesByFile(tx, fileId)),
  },
  {
    entityType: 'canonical_description_image',
    ownerKind: 'application',
    owner: 'application',
    entityId: 'canonical_products.id (its description and every localized one)',
    registration: 'trigger',
    sources: CANONICAL_DESCRIPTION_SOURCES,
    detach: htmlDetach(CANONICAL_DESCRIPTION_SOURCES),
  },
  {
    entityType: 'category_image',
    ownerKind: 'application',
    owner: 'application',
    entityId: 'categories.id',
    registration: 'trigger',
    sources: [
      {
        table: 'categories',
        entityColumn: 'id',
        columns: [
          { name: 'image_file_id', kind: 'file_id' },
          { name: 'image_url', kind: 'stored_url' },
        ],
      },
    ],
    detach: async (tx, fileId) =>
      removed(
        await clearCategoryImagesByFile(tx, fileId, (url) => storedMediaFileId(url) === fileId),
      ),
  },
  {
    entityType: 'brand_logo',
    ownerKind: 'application',
    owner: 'application',
    entityId: 'brands.id',
    registration: 'trigger',
    sources: [single('brands', 'id', 'logo_file_id', 'file_id')],
    detach: async (tx, fileId) => removed(await clearBrandLogosByFile(tx, fileId)),
  },
  {
    // Immutable migration evidence (`central_organization_identity_freeze`):
    // what an organization's identity WAS, never rewritten.
    entityType: 'organization_archive_logo',
    ownerKind: 'application',
    owner: 'application',
    entityId: 'organization_identity_archives.id',
    registration: 'trigger',
    sources: [single('organization_identity_archives', 'id', 'logo_file_id', 'file_id')],
  },
  {
    entityType: 'review_media',
    ownerKind: 'account',
    owner: 'uploader',
    entityId: 'reviews.id (one reference per file per review)',
    registration: 'trigger',
    sources: [single('review_media', 'review_id', 'file_id', 'file_id')],
    detach: async (tx, fileId) => removed(await removeReviewMediaByFile(tx, fileId)),
  },
  evidence('return_request_evidence', 'return_request_evidence', 'file_id'),
  evidence('retail_service_request_evidence', 'retail_service_request_evidence', 'file_id'),
  evidence('supplier_agreement_evidence', 'supplier_agreement_evidence', 'oxy_file_id'),
  evidence('retail_resale_evidence', 'retail_resale_evidence', 'oxy_file_id'),
  evidence('retail_compliance_evidence', 'retail_compliance_evidence', 'oxy_file_id'),
  evidence('merchant_claim_evidence', 'merchant_claim_evidence', 'oxy_file_id'),
  evidence('relationship_evidence', 'relationship_evidence', 'oxy_file_id'),
  {
    // An order snapshot keeps its URL text forever (financial history). It is
    // registered by the reconciliation only: checkout is never made to depend
    // on a reference write, and a snapshot's file is still referenced by its
    // listing at the moment the order is written. A file trashed after the
    // listing let go of it is restored by the next run's reference (Oxy keeps
    // a trashed file 30 days; an account's file is never collected at all).
    entityType: 'order_item_image',
    ownerKind: 'account',
    owner: 'store_or_seller',
    entityId: 'order_items.id',
    registration: 'reconciliation',
    sources: [single('order_items', 'id', 'image_url', 'stored_url')],
  },
  {
    // `asset_files.storage_key` is read in exactly ONE place — the function
    // `findAssetFileStorageKey` (house-invariants) — so the generic holding
    // queries may not read it. The storage port registers the reference when it
    // stores or copies an object, and the reconciliation's inventory reads each
    // key through that one function. Since Oxy ADR 0043 the deliverable is an
    // APPLICATION file, which Oxy collects once nothing references it — so this
    // type IS reconciled, nightly like the rest.
    entityType: 'digital_asset_file',
    ownerKind: 'application',
    owner: 'creator',
    entityId: 'the storage key itself (no asset_files row exists yet at upload)',
    registration: 'writer',
    sources: [],
    inventory: async function* (db) {
      let after: string | undefined;
      for (;;) {
        const ids = await findAssetFileIdPage({ ...(after ? { after } : {}), limit: 500 }, db);
        if (ids.length === 0) return;
        after = ids[ids.length - 1];
        for (const id of ids) {
          const file = await findAssetFileStorageKey(id, db);
          if (file && isReferenceableFileId(file.storageKey))
            yield { fileId: file.storageKey, entityId: file.storageKey };
        }
        if (ids.length < 500) return;
      }
    },
  },
];

const BY_TYPE = new Map(DEFINITIONS.map((definition) => [definition.entityType, definition]));

/** Every definition, in `OXY_FILE_REFERENCE_ENTITY_TYPES` order. */
export function fileReferenceDefinitions(): readonly FileReferenceEntityDefinition[] {
  return OXY_FILE_REFERENCE_ENTITY_TYPES.map((type) => fileReferenceDefinition(type));
}

export function fileReferenceDefinition(
  entityType: OxyFileReferenceEntityType,
): FileReferenceEntityDefinition {
  const definition = BY_TYPE.get(entityType);
  if (!definition) throw new Error(`No file reference definition for ${entityType}`);
  return definition;
}

/** What each entity holds NOW: entity id → its distinct file ids (absent = none). */
export async function readEntityHoldings(
  definition: FileReferenceEntityDefinition,
  entityIds: readonly string[],
  db: DatabaseOrTransaction,
): Promise<Map<string, Set<string>>> {
  const holdings = new Map<string, Set<string>>();
  for (const source of definition.sources) {
    for (const row of await readHoldingRows(source, entityIds, db)) {
      source.columns.forEach((column, index) => {
        for (const fileId of fileIdsOf(column.kind, row.values[index])) {
          const held = holdings.get(row.entityId) ?? new Set<string>();
          held.add(fileId);
          holdings.set(row.entityId, held);
        }
      });
    }
  }
  return holdings;
}

/**
 * The whole inventory of a type as `(fileId, entityId)` pairs, streamed in
 * keyset pages of entities (over the union of the type's sources) so a type
 * with millions of rows never sits in memory.
 */
export async function* streamEntityInventory(
  definition: FileReferenceEntityDefinition,
  db: DatabaseOrTransaction,
  pageSize = 500,
): AsyncGenerator<{ fileId: string; entityId: string }> {
  if (definition.inventory) {
    yield* definition.inventory(db);
    return;
  }
  let after: string | undefined;
  for (;;) {
    const entityIds = await readHoldingEntityPage(definition.sources, after, pageSize, db);
    if (entityIds.length === 0) return;
    after = entityIds[entityIds.length - 1];
    const holdings = await readEntityHoldings(definition, entityIds, db);
    for (const entityId of entityIds) {
      for (const fileId of holdings.get(entityId) ?? []) yield { fileId, entityId };
    }
    if (entityIds.length < pageSize) return;
  }
}

/** Every entity of a type whose rows hold `fileId` now. */
export async function findEntitiesHoldingFile(
  definition: FileReferenceEntityDefinition,
  fileId: string,
  db: DatabaseOrTransaction,
): Promise<string[]> {
  const holders = new Set<string>();
  for (const source of definition.sources) {
    for (const row of await readHoldingRowsForFile(source, fileId, db)) {
      if (
        source.columns.some((column, index) =>
          fileIdsOf(column.kind, row.values[index]).includes(fileId),
        )
      )
        holders.add(row.entityId);
    }
  }
  return [...holders];
}
