/**
 * Whether a public catalogue page may SHOW a fact it holds (#72 identity rule 3,
 * acceptance 7).
 *
 * A brand's logo and description are frequently somebody else's work, observed
 * from a source under a contract. #62 already models what each source permits —
 * `catalog_sources.may_display` as the umbrella, the active policy version's
 * `display_media` and `index` rights underneath it, `attribution_required`
 * beside them — and this module does nothing but ASK, per asset, and fail
 * closed when it cannot.
 *
 * ## Three states, not a boolean
 *
 * `absent` (Mercaria holds nothing), `withheld` (Mercaria holds it and may not
 * show it) and `displayable` are three different things for a page to render,
 * and collapsing the first two would make a brand with a contractually
 * unshowable logo look identical to one nobody has ever photographed.
 *
 * ## Unresolvable provenance WITHHOLDS
 *
 * An asset whose source record or registry row cannot be read answers
 * `unresolved_provenance` rather than `displayable`. "We could not check" and
 * "we checked and it is fine" must not produce the same page — the direction a
 * rights check fails in is the whole of its value.
 *
 * ## An OPERATOR-uploaded asset needs no source
 *
 * A logo with no `logo_source_record_id` was put there by an operator through
 * `/internal/canonical-catalog`, which is an upload right rather than a source
 * licence. That is the `operator_uploaded` basis, and it is the reason this
 * module answers a two-member basis rather than assuming everything came from a
 * feed.
 */

import type {
  CatalogAssetRightsBasis,
  CatalogAssetProvenance,
  CatalogPageAsset,
  CatalogPageText,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findCatalogSourceById,
  findSourceRecordById,
  findSourceRecordsByIds,
} from '../../db/canonical/provenanceRepository.js';
import { resolveIngestionSource } from '../ingestion/source.service.js';

/** What a page learned about one source's willingness to be shown. */
export interface ResolvedDisplayRights {
  readonly basis: CatalogAssetRightsBasis;
  /**
   * Whether the provenance chain could be READ at all.
   *
   * Separate from `mayDisplay` because the two withhold for different reasons a
   * reader should be told apart: a source that refuses display is a contract,
   * and a source record that cannot be resolved is a gap in Mercaria's own
   * data. Both withhold; only one is anybody's fault.
   */
  readonly provenanceResolved: boolean;
  readonly mayDisplay: boolean;
  /** The narrower media right. Equal to `mayDisplay` when no policy narrows it. */
  readonly mayDisplayMedia: boolean;
  /** #62's `index` right — what decides whether a page may be indexed at all. */
  readonly mayIndex: boolean;
  readonly provenance?: CatalogAssetProvenance;
}

/** An operator upload: no source, every display right, no provenance to state. */
export const OPERATOR_UPLOAD_RIGHTS: ResolvedDisplayRights = Object.freeze({
  basis: 'operator_uploaded',
  provenanceResolved: true,
  mayDisplay: true,
  mayDisplayMedia: true,
  mayIndex: true,
});

/** Nothing is showable and nothing is known — the fail-closed answer. */
export const UNRESOLVED_DISPLAY_RIGHTS: ResolvedDisplayRights = Object.freeze({
  basis: 'source_licensed',
  provenanceResolved: false,
  mayDisplay: false,
  mayDisplayMedia: false,
  mayIndex: false,
});

/**
 * The rights behind one observed fact, from the source record it came from.
 *
 * Reads the coarse registry row FIRST — every source has one, including #60's
 * backfill source and the operator source, which have no ingestion config at
 * all — and narrows it with the active policy's media and index rights only
 * where a config exists. Narrowing only, never widening: a source whose
 * registry row says `may_display = false` stays unshowable whatever a policy
 * version says, which is the direction the deferrable rights-agreement trigger
 * already enforces at the row.
 */
export async function resolveSourceRecordDisplayRights(
  db: DatabaseOrTransaction,
  sourceRecordId: string | null,
): Promise<ResolvedDisplayRights> {
  if (sourceRecordId === null) return OPERATOR_UPLOAD_RIGHTS;

  const record = await findSourceRecordById(db, sourceRecordId);
  if (!record) return UNRESOLVED_DISPLAY_RIGHTS;
  const source = await findCatalogSourceById(db, record.sourceId);
  if (!source) return UNRESOLVED_DISPLAY_RIGHTS;

  const resolved = await resolveIngestionSource(record.sourceId, db);
  const mayDisplay = source.mayDisplay;
  const mayDisplayMedia = mayDisplay && (resolved === undefined || resolved.rights.display_media);
  const mayIndex = mayDisplay && (resolved === undefined || resolved.rights.index);

  const provenance: CatalogAssetProvenance = {
    sourceKind: source.kind,
    observedAt: record.observedAt.toISOString(),
    ...(record.staleAt === null ? {} : { staleAt: record.staleAt.toISOString() }),
    // Named ONLY when the source demands it. The string is the registry name,
    // which is the only display identity a source has — so a source configured
    // with attribution required must be named for a reader, and that is a real
    // operational consequence rather than a hidden one.
    ...(source.attributionRequired ? { attribution: source.name } : {}),
  };

  return {
    basis: 'source_licensed',
    provenanceResolved: true,
    mayDisplay,
    mayDisplayMedia,
    mayIndex,
    provenance,
  };
}

/**
 * The rights behind a whole PAGE of observations, in a bounded number of
 * statements.
 *
 * A grid of twenty-four product cards would otherwise resolve rights per card —
 * three statements each — and the answer is the same for every card whose image
 * came from the same source. So the records are read in ONE statement and the
 * rights are computed once per DISTINCT SOURCE, of which a page has one or two:
 * a brand's catalogue images come from the feed that supplied them.
 *
 * A record id that resolves to nothing is simply absent from the map, and the
 * caller's `?? UNRESOLVED` fallback is what withholds — the same fail-closed
 * direction as the single-record path.
 */
export async function resolveDisplayRightsByRecord(
  db: DatabaseOrTransaction,
  sourceRecordIds: readonly string[],
): Promise<Map<string, ResolvedDisplayRights>> {
  const distinct = [...new Set(sourceRecordIds)];
  const byRecord = new Map<string, ResolvedDisplayRights>();
  if (distinct.length === 0) return byRecord;

  const records = await findSourceRecordsByIds(db, distinct);
  const bySource = new Map<string, ResolvedDisplayRights>();

  for (const record of records) {
    let sourceRights = bySource.get(record.sourceId);
    if (sourceRights === undefined) {
      sourceRights = await resolveSourceDisplayRights(db, record.sourceId);
      bySource.set(record.sourceId, sourceRights);
    }
    const sourceProvenance = sourceRights.provenance;
    if (sourceProvenance === undefined) {
      byRecord.set(record.id, sourceRights);
      continue;
    }
    byRecord.set(record.id, {
      ...sourceRights,
      provenance: {
        ...sourceProvenance,
        observedAt: record.observedAt.toISOString(),
        ...(record.staleAt === null ? {} : { staleAt: record.staleAt.toISOString() }),
      },
    });
  }
  return byRecord;
}

/** The rights of one SOURCE, with no observation instant attached yet. */
async function resolveSourceDisplayRights(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<ResolvedDisplayRights> {
  const source = await findCatalogSourceById(db, sourceId);
  if (!source) return UNRESOLVED_DISPLAY_RIGHTS;
  const resolved = await resolveIngestionSource(sourceId, db);
  const mayDisplay = source.mayDisplay;
  return {
    basis: 'source_licensed',
    provenanceResolved: true,
    mayDisplay,
    mayDisplayMedia: mayDisplay && (resolved === undefined || resolved.rights.display_media),
    mayIndex: mayDisplay && (resolved === undefined || resolved.rights.index),
    provenance: {
      sourceKind: source.kind,
      ...(source.attributionRequired ? { attribution: source.name } : {}),
    },
  };
}

/**
 * The rights behind an entity-level TEXT field (a brand's or a family's
 * description).
 *
 * Unlike a logo, a description has no per-field source column: #53 records
 * provenance for these entities at the ENTITY grain through their
 * `<entity>_source_links`, so the newest active observation is what a
 * description was last written from. Two exceptions come FIRST:
 *
 *  - A field an operator PINNED (`pinned_fields`) is Mercaria's own text by
 *    construction — pinning is what stops a source re-applying over it — so it
 *    carries the upload basis and no source's refusal can withhold it.
 *  - An entity with no active observation at all has no external licence
 *    behind it either: it was minted by an operator or by #60's backfill from
 *    Mercaria's own listings. That is the same `operator_uploaded` basis, and
 *    treating it as unresolved provenance would withhold the description of
 *    every brand the backfill created.
 */
export async function resolveEntityFieldRights(
  db: DatabaseOrTransaction,
  input: {
    field: string;
    pinnedFields: readonly string[];
    latestSourceRecordId: string | null;
  },
): Promise<ResolvedDisplayRights> {
  if (input.pinnedFields.includes(input.field)) return OPERATOR_UPLOAD_RIGHTS;
  if (input.latestSourceRecordId === null) return OPERATOR_UPLOAD_RIGHTS;
  return resolveSourceRecordDisplayRights(db, input.latestSourceRecordId);
}

/** Project one image file id under the rights that were resolved for it. */
export function projectAsset(
  fileId: string | null,
  rights: ResolvedDisplayRights,
): CatalogPageAsset {
  if (fileId === null || fileId.length === 0) return { state: 'absent' };
  if (!rights.provenanceResolved) return { state: 'withheld', reason: 'unresolved_provenance' };
  if (!rights.mayDisplay || !rights.mayDisplayMedia) {
    return { state: 'withheld', reason: 'no_display_right' };
  }
  return {
    state: 'displayable',
    fileId,
    rightsBasis: rights.basis,
    ...(rights.provenance === undefined ? {} : { provenance: rights.provenance }),
  };
}

/** Project one public text field under the rights that were resolved for it. */
export function projectText(text: string | null, rights: ResolvedDisplayRights): CatalogPageText {
  const trimmed = text === null ? '' : text.trim();
  if (trimmed.length === 0) return { state: 'absent' };
  if (!rights.provenanceResolved) return { state: 'withheld', reason: 'unresolved_provenance' };
  if (!rights.mayDisplay) {
    return { state: 'withheld', reason: 'no_display_right' };
  }
  return {
    state: 'displayable',
    text: trimmed,
    rightsBasis: rights.basis,
    ...(rights.provenance === undefined ? {} : { provenance: rights.provenance }),
  };
}
