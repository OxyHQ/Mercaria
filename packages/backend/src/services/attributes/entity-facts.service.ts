/**
 * Loading the facts one candidate offers an evaluation (#94 API rule 4).
 *
 * The evaluator is pure and takes {@link CandidateFacts}; this is the only place
 * that reads them out of Postgres. Keeping the two apart is what lets the
 * evaluation rules be tested exhaustively over fixtures without a database, and
 * it is why the evaluator cannot accidentally issue an offer query of its own.
 *
 * ## Only SELECTED values reach an evaluation
 *
 * A conflicting value is a disagreement Mercaria has not resolved, and an
 * unparsed one is a string. Neither is a fact the catalogue is willing to state,
 * so neither may satisfy a requirement. What they DO produce is an honest
 * `unknown`, because the absence of a selected value is exactly what the
 * evaluator's missing-data handling is for.
 */

import { eq, sql } from 'drizzle-orm';
import type { CurrencyCode } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { listSelectedAttributeValues } from '../../db/canonical/attributeRepository.js';
import { canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { offerFactsPort, type OfferFactsContext } from './offer-facts.port.js';
import type { CandidateFacts, EvaluableFact } from './constraint-evaluation.js';

export interface LoadCandidateFactsOptions {
  /** The viewer context the offer port's eligibility legitimately depends on. */
  readonly offerContext?: OfferFactsContext;
}

/**
 * Load everything one canonical product and its variants offer an evaluation.
 *
 * @returns `undefined` when the product does not exist. A product with no
 *   attributes and no offers loads fine and evaluates to `unknown` everywhere,
 *   which is the correct answer for a catalogue entry nobody has enriched.
 */
export async function loadCandidateFacts(
  productId: string,
  options: LoadCandidateFactsOptions = {},
): Promise<CandidateFacts | undefined> {
  const db = getDb();
  const products = await db
    .select({
      id: canonicalProducts.id,
      name: canonicalProducts.name,
      description: canonicalProducts.description,
      categoryId: canonicalProducts.categoryId,
      brandId: canonicalProducts.brandId,
      familyId: canonicalProducts.familyId,
    })
    .from(canonicalProducts)
    .where(eq(canonicalProducts.id, productId))
    .limit(1);
  const product = products[0];
  if (!product) return undefined;

  const variants = await db
    .select({ id: canonicalVariants.id })
    .from(canonicalVariants)
    .where(eq(canonicalVariants.productId, productId));
  const variantIds = variants.map((variant) => variant.id);

  const [productValues, variantValues] = await Promise.all([
    listSelectedAttributeValues(db, 'product', [productId]),
    listSelectedAttributeValues(db, 'variant', variantIds),
  ]);

  const variantFacts = new Map<string, EvaluableFact[]>();
  for (const id of variantIds) variantFacts.set(id, []);
  for (const row of variantValues) {
    if (row.variantId === null) continue;
    const list = variantFacts.get(row.variantId);
    if (list) list.push(toEvaluableFact(row));
  }

  const offerFacts = await offerFactsPort().factsForVariants(variantIds, options.offerContext ?? {});

  return {
    productId,
    productFacts: productValues.map(toEvaluableFact),
    variantFacts,
    ...(product.categoryId === null ? {} : { categoryId: product.categoryId }),
    ...(product.categoryId === null
      ? {}
      : { categoryAncestorIds: await ancestorIdsOf(db, product.categoryId) }),
    ...(product.brandId === null ? {} : { brandId: product.brandId }),
    ...(product.familyId === null ? {} : { productFamilyId: product.familyId }),
    offerFacts,
    text: {
      name: product.name,
      ...(product.description === null ? {} : { description: product.description }),
    },
  };
}

/**
 * A category's strict ancestors, nearest first.
 *
 * A recursive CTE for the reason the registry's scope resolution uses one:
 * `categories.ancestor_slugs` is a maintained denormalization, and a taxonomy
 * constraint deciding whether a product is "under Electronics" must not be able
 * to answer wrongly because a rollup went stale.
 */
async function ancestorIdsOf(
  db: DatabaseOrTransaction,
  categoryId: string,
): Promise<string[]> {
  const rows = await db.execute<{ id: string; depth: number }>(sql`
    with recursive ancestry as (
      select id, parent_id, 0 as depth from categories where id = ${categoryId}
      union all
      select c.id, c.parent_id, ancestry.depth + 1
      from categories c join ancestry on c.id = ancestry.parent_id
    )
    select id, depth from ancestry where depth > 0 order by depth
  `);
  return [...rows].map((row) => row.id);
}

/** A stored value, in the shape the pure evaluator reads. */
function toEvaluableFact(row: {
  attributeKey: string;
  definitionVersion: number | null;
  normalizedText: string | null;
  normalizedNumber: number | null;
  normalizedNumberMax: number | null;
  rangeLowerInclusive: boolean | null;
  rangeUpperInclusive: boolean | null;
  normalizedBoolean: boolean | null;
  normalizedDate: Date | null;
  normalizedAmountMinor: number | null;
  componentAxis: string | null;
}): EvaluableFact {
  return {
    attributeKey: row.attributeKey,
    definitionVersion: row.definitionVersion ?? 0,
    ...(row.normalizedText === null ? {} : { normalizedText: row.normalizedText }),
    ...(row.normalizedNumber === null ? {} : { normalizedNumber: row.normalizedNumber }),
    ...(row.normalizedNumberMax === null ? {} : { normalizedNumberMax: row.normalizedNumberMax }),
    ...(row.rangeLowerInclusive === null ? {} : { rangeLowerInclusive: row.rangeLowerInclusive }),
    ...(row.rangeUpperInclusive === null ? {} : { rangeUpperInclusive: row.rangeUpperInclusive }),
    ...(row.normalizedBoolean === null ? {} : { normalizedBoolean: row.normalizedBoolean }),
    ...(row.normalizedDate === null ? {} : { normalizedDate: row.normalizedDate.getTime() }),
    ...(row.normalizedAmountMinor === null
      ? {}
      : { normalizedAmountMinor: row.normalizedAmountMinor }),
    ...(row.componentAxis === null ? {} : { componentAxis: row.componentAxis }),
    // Every stored value carries a NOT NULL `source_record_id`, so a value that
    // exists is source-backed by construction (#56's provenance decision). The
    // field is here so the explanation can say so without a second read.
    sourceBacked: true,
  };
}

/** The presentment currency an offer context carries, when the caller named one. */
export function offerContextFor(currency?: CurrencyCode, territory?: string): OfferFactsContext {
  return {
    ...(currency === undefined ? {} : { currency }),
    ...(territory === undefined ? {} : { territory }),
  };
}
