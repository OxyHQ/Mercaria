/**
 * Turning a staged pass into a report (#63 processing 9 and 10, acceptance 4).
 *
 * ## The dry-run counts are honest about what a dry run can KNOW
 *
 * Issue processing 10 asks for "valid, invalid, changed, matched, created and
 * review". Four of the six are reads. Two of them — a heuristic match and its
 * review verdict — are #58's, and #58 WRITES: a `match_decisions` row, a
 * candidate set, possibly a blocked pair. A dry run that produced them would be
 * a dry run that changed something, which is not one.
 *
 * So `matched`, `created` and `review` are IDENTIFIER-STAGE projections and the
 * report says so: a record whose identifiers resolve to exactly one canonical
 * variant is `matched`, to more than one is `review` (an ambiguity a person
 * settles), and to none is `created` — which is a RECOMMENDATION #60 owns
 * acting on, never a mint. Anything a heuristic stage would have decided is
 * outside what this can claim, and reporting a guess as a count would make a
 * merchant's activation decision rest on a number nobody could reproduce.
 *
 * ## `changed` and `unchanged` come from the framework's OWN hash
 *
 * `redactSourceObservation` is the function #62 uses to compute
 * `source_records.content_hash`, and this module calls exactly it. A second
 * hash here would answer "would this change?" differently from the pipeline
 * that later answers it for real — which is the failure mode a dry run exists to
 * prevent, arriving through the dry run.
 */

import type {
  FeedImportReportMode,
  FeedRecordIssue,
  IdentifierScheme,
  NormalizedIdentifierScheme,
  NormalizedSourceRecord,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { findActiveCanonicalOwner } from '../../db/canonical/productIdentifierRepository.js';
import { insertFeedImportReport, type FeedImportReportRow } from '../../db/feedImport/feedImportReportRepository.js';
import { normalizeIdentifier } from '../canonical/identifiers.js';
import { redactSourceObservation } from '../ingestion/redact.js';
import { boundedFailureNote } from './redact.js';
import { readFeedStagePage, type FeedStage } from './staging.js';
import { FEED_IMPORT_MAX_TEXT_LENGTH } from '../../db/schema/feedImport.js';
import { catalogSourceObjects } from '../../db/schema/ingestion.js';
import { and, eq, inArray } from 'drizzle-orm';

/** What a dry run measured, beyond the stage's own partition. */
export interface FeedDryRunTallies {
  changed: number;
  unchanged: number;
  matched: number;
  created: number;
  review: number;
}

export interface ComposeFeedReportInput {
  readonly configurationId: string;
  readonly versionId: string;
  readonly sourceId: string;
  readonly mode: FeedImportReportMode;
  readonly stage: FeedStage;
  readonly requestedByOxyUserId: string;
  readonly failureNote?: string;
  readonly now?: Date;
}

/**
 * Write one report, its entries and its dry-run tallies.
 *
 * Runs in the caller's transaction when one is supplied, so an activation and
 * the validation report it cites commit together — a `validated_report_id`
 * pointing at a report that rolled back is a foreign-key violation nobody can
 * act on.
 */
export async function composeFeedImportReport(
  input: ComposeFeedReportInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<FeedImportReportRow> {
  const now = input.now ?? new Date();
  const tallies = await measureDryRunTallies(input.sourceId, input.stage, db);

  return insertFeedImportReport(db, {
    configurationId: input.configurationId,
    versionId: input.versionId,
    mode: input.mode,
    scanned: input.stage.manifest.scanned,
    valid: input.stage.manifest.valid,
    invalid: input.stage.manifest.invalid,
    changed: tallies.changed,
    unchanged: tallies.unchanged,
    matched: tallies.matched,
    created: tallies.created,
    review: tallies.review,
    warnings: input.stage.manifest.warnings,
    enumerationComplete: input.stage.manifest.enumeratedFully,
    bytesRead: input.stage.manifest.bytesRead,
    durationMs: input.stage.manifest.durationMs,
    failureNote:
      input.failureNote === undefined
        ? null
        : boundedFailureNote(input.failureNote, FEED_IMPORT_MAX_TEXT_LENGTH),
    requestedByOxyUserId: input.requestedByOxyUserId,
    issues: input.stage.issues,
    now,
  });
}

/**
 * Walk the staged records and answer the five questions a dry run can answer.
 *
 * Bounded: it reads at most `FEED_IMPORT_MAX_REPORT_ENTRIES` records, because
 * this is a REPORT and a full identifier resolution over a five-million-row feed
 * is a five-million-statement read that would take longer than the import it is
 * predicting. The report's `scanned` is the whole feed; these tallies are over a
 * prefix, and the surface labels them as such rather than implying otherwise.
 */
async function measureDryRunTallies(
  sourceId: string,
  stage: FeedStage,
  db: DatabaseOrTransaction,
): Promise<FeedDryRunTallies> {
  const tallies: FeedDryRunTallies = {
    changed: 0,
    unchanged: 0,
    matched: 0,
    created: 0,
    review: 0,
  };
  const budget = Math.min(stage.manifest.valid, config.feedImport.maxReportEntries);
  if (budget === 0) return tallies;

  let byteOffset = 0;
  let seen = 0;
  while (seen < budget) {
    const page = await readFeedStagePage(
      stage.manifest.digest,
      byteOffset,
      Math.min(200, budget - seen),
      seen,
    );
    if (page.records.length === 0) break;

    const byExternalId = new Map<string, string>();
    for (const record of page.records) {
      // The SAME function #62 computes `source_records.content_hash` with, and
      // the same `raw` the adapter will hand it — so "would this change?" is
      // answered here exactly as the pipeline answers it later. A `null` is an
      // oversized projection the framework would refuse too, and it is counted
      // as CHANGED rather than skipped: the record will not converge, and a dry
      // run that quietly dropped it would under-report the work.
      const observation = redactSourceObservation(record.normalized, {
        feedRecordIndex: record.index,
        sourceDigest: record.sourceDigest,
      });
      byExternalId.set(record.externalId, observation === null ? '' : observation.contentHash);
    }
    const existing = await readCurrentHashes(sourceId, [...byExternalId.keys()], db);
    for (const [externalId, hash] of byExternalId) {
      const current = existing.get(externalId);
      if (current === undefined) tallies.changed += 1;
      else if (current === hash) tallies.unchanged += 1;
      else tallies.changed += 1;
    }

    for (const record of page.records) {
      const owners = await resolveIdentifierOwners(record.normalized, db);
      if (owners.size === 1) tallies.matched += 1;
      else if (owners.size > 1) tallies.review += 1;
      else tallies.created += 1;
    }

    seen += page.records.length;
    byteOffset = page.nextByteOffset;
    if (page.done) break;
  }
  return tallies;
}

/** The current content hash of each external id this source already holds. */
async function readCurrentHashes(
  sourceId: string,
  externalIds: readonly string[],
  db: DatabaseOrTransaction,
): Promise<Map<string, string>> {
  if (externalIds.length === 0) return new Map();
  const rows = await db
    .select({
      externalId: catalogSourceObjects.externalId,
      currentContentHash: catalogSourceObjects.currentContentHash,
    })
    .from(catalogSourceObjects)
    .where(
      and(
        eq(catalogSourceObjects.sourceId, sourceId),
        eq(catalogSourceObjects.externalType, 'offer'),
        inArray(catalogSourceObjects.externalId, [...externalIds]),
      ),
    );
  return new Map(rows.map((row) => [row.externalId, row.currentContentHash]));
}

/**
 * Which canonical variants this record's identifiers ALREADY belong to.
 *
 * Deterministic only — a check digit and a single active owner, which is #58's
 * identifier stage and the one part of matching that has no error rate to
 * measure. Nothing here scores a title, and the empty answer is `create_new`'s
 * recommendation rather than "no match": a record with no identifier at all is
 * exactly the unbranded P2P case #58 rule 5 refuses to punish.
 */
async function resolveIdentifierOwners(
  record: NormalizedSourceRecord,
  db: DatabaseOrTransaction,
): Promise<Set<string>> {
  const owners = new Set<string>();
  for (const identifier of record.identifiers) {
    const normalization = normalizeIdentifier(
      ASSERTED_SCHEME[identifier.scheme],
      identifier.value,
    );
    if (normalization.kind !== 'valid') continue;
    const canonicalScheme = normalization.identifier.canonicalScheme;
    const canonicalValue = normalization.identifier.canonicalValue;
    if (canonicalScheme === undefined || canonicalValue === undefined) continue;
    const owner = await findActiveCanonicalOwner(db, canonicalScheme, canonicalValue);
    if (owner !== undefined && owner.variantId !== null) owners.add(owner.variantId);
  }
  return owners;
}

/**
 * The scheme each observed field is ASSERTED under — `subject-loader.ts`'s map,
 * copied deliberately rather than re-derived.
 *
 * The matcher reads a stored payload's `gtin` as an `ean` assertion and lets
 * validation decide whether the claim holds, because "a 12-digit value in a
 * `gtin` field is refused as an EAN rather than silently re-read as a UPC".
 * This dry run has to agree with it exactly: a projection that guessed a
 * different scheme would predict a match the import then refuses, or the
 * reverse, and the merchant's activation decision would rest on it.
 */
const ASSERTED_SCHEME: Readonly<Record<NormalizedIdentifierScheme, IdentifierScheme>> = {
  gtin: 'ean',
  ean: 'ean',
  upc: 'upc',
  isbn: 'isbn13',
  mpn: 'mpn',
};

/** The record-level issues a caller may render without touching the database. */
export function feedReportIssues(stage: FeedStage): readonly FeedRecordIssue[] {
  return stage.issues;
}
