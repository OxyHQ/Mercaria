/**
 * Stage `source_readvance` — re-ask #58's matcher about every `unmatched`
 * ingested object (ADR 0014 D4).
 *
 * #62's page loop skips an observation whose content is unchanged, which is
 * right for every redelivery and leaves one gap: an object stored before the
 * product it describes existed in the catalogue is never matched again. After
 * `reference_products` seeds a GTIN, the Open Prices price for it — ingested
 * days earlier, still `unmatched` — needs exactly one more question. This stage
 * asks it through #62's own `advanceObject` (via the writer), so the answer is
 * the matcher's and the offer is #57's, by the same path a page takes.
 *
 * Every source's objects, not only seeding ones: the price feeds are the point.
 * A dry run asks nothing and reports what it would re-ask.
 *
 * ## Only objects the catalogue can now answer
 *
 * An object is re-asked only when the GTIN its current observation asserts is
 * now held by an ACTIVE canonical identifier. Re-asking the rest would put the
 * same question to the matcher and get the same `create_new`, once per object
 * per pass — at Open Prices scale, hundreds of thousands of answers already
 * known. Objects without a GTIN (games, cards, fuel) match heuristically and
 * are not re-asked here; ADR 0014 leaves their identity to a later decision.
 *
 * The payload stores each scheme's value as the source asserted it, and a
 * canonical GTIN is the 14-digit zero-padded form (`product_identifiers.
 * canonical_value`), so the comparison pads. A malformed value pads to
 * something no identifier holds, which is the right answer for it.
 */

import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';
import type { CatalogBackfillReasonCode } from '@mercaria/shared-types';
import { getDb } from '../../../db/postgres.js';
import { catalogSourceObjects } from '../../../db/schema/ingestion.js';
import { sourceRecords } from '../../../db/schema/provenance.js';
import { productIdentifiers } from '../../../db/schema/canonicalCatalog.js';
import {
  examineAll,
  nextKeysetCursor,
  type StageContext,
  type StagePageResult,
  type SubjectVerdict,
} from '../stage-context.js';

export async function runSourceReadvancePage(context: StageContext): Promise<StagePageResult> {
  const keyset: SQL | undefined = context.cursor === null ? undefined : gt(catalogSourceObjects.id, context.cursor);
  const asserted = (key: string) => sql`lpad(${sourceRecords.payload} ->> ${key}, 14, '0')`;
  const nowOwned = sql`exists (
    select 1 from ${productIdentifiers}
    where ${productIdentifiers.status} = 'active'
      and ${productIdentifiers.canonicalScheme} = 'gtin'
      and ${productIdentifiers.canonicalValue} in (${asserted('gtin')}, ${asserted('ean')}, ${asserted('upc')}, ${asserted('isbn')})
  )`;
  const rows = await getDb()
    .select({ id: catalogSourceObjects.id })
    .from(catalogSourceObjects)
    .innerJoin(sourceRecords, eq(sourceRecords.id, catalogSourceObjects.currentSourceRecordId))
    .where(and(eq(catalogSourceObjects.state, 'unmatched'), nowOwned, keyset))
    .orderBy(asc(catalogSourceObjects.id))
    .limit(context.limit);

  const counters = await examineAll(
    context,
    rows,
    (row) => ({ kind: 'source_object', sourceObjectId: row.id }),
    (row) => readvance(context, row.id),
  );
  return { counters, nextCursor: nextKeysetCursor(rows, context.limit) };
}

const REASON: Readonly<Record<string, CatalogBackfillReasonCode>> = {
  matched: 'readvance_matched',
  review_required: 'readvance_review_required',
  unmatched: 'readvance_unmatched',
  // The object moved on between the page read and the ask (a concurrent page
  // matched it), its source may no longer store, or its payload predates this
  // projection. None is attachable now, and none is a failure.
  not_readvanceable: 'readvance_unmatched',
  not_written: 'readvance_requested',
};

async function readvance(context: StageContext, sourceObjectId: string): Promise<SubjectVerdict> {
  const result = await context.writer.readvanceSourceObject(sourceObjectId);
  const reasonCode = REASON[result.outcome] ?? 'readvance_unmatched';
  return {
    reasonCode,
    detail:
      result.outcome === 'matched'
        ? `object ${sourceObjectId} attached; offer ${result.id}`
        : `object ${sourceObjectId}: ${result.outcome}`,
  };
}
