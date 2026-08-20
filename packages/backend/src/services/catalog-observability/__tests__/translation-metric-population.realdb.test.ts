/**
 * The translation metrics measure the population their definitions NAME (#565).
 *
 * ## What this exists to catch, and why the producer census cannot
 *
 * `contract-gates.test.ts` runs a producer census in both directions — every
 * definition has a producer and every producer has a definition. That is an
 * EXISTENCE check, and existence is the one thing that was never wrong here.
 * `translation_coverage` published a denominator over "categories, product types
 * and values" and computed one over published CATEGORIES; `translation_missing_count`
 * published "no localization row at all" and counted rows that EXIST carrying
 * `status = 'missing'`, so a locale with nothing written reported ZERO missing.
 * Both had a green gate behind them and always would have.
 *
 * A metric with a published definition is a claim, and the number beside it is
 * what somebody acts on. So what is asserted here is the claim: that perturbing
 * an input the definition NAMES moves the metric, and perturbing one it does
 * NOT name leaves it alone. The second half is what separates measuring the
 * stated population from measuring something correlated with it — a
 * category-only computation passes every "does it move" test as long as the
 * fixture happens to touch categories.
 *
 * ## Why deltas inside a rolled-back transaction
 *
 * One throwaway database serves the whole suite and files run in parallel, so an
 * absolute count is a fact about every other file's fixtures as much as this
 * one's. Each case therefore reads the metric, perturbs ONE domain, reads again,
 * and asserts the DIFFERENCE — which is invariant to whatever else is present.
 * The whole thing rolls back, so it adds no rows the next file has to tolerate.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { connectPostgres, type Database } from '../../../db/postgres.js';
import { categories } from '../../../db/schema/catalog.js';
import { productTypeDefinitions } from '../../../db/schema/productTypes.js';
import {
  attributeDefinitions,
  attributeEnumValues,
} from '../../../db/schema/attributeRegistry.js';
import { collectCatalogMetrics } from '../metrics.service.js';
import type { DatabaseOrTransaction } from '../../../db/postgres.js';

let db: Database;
const RUN = uuidv7().slice(-12);

beforeAll(async () => {
  db = await connectPostgres();
}, 180_000);

interface TranslationReading {
  readonly coverageDenominator: number;
  readonly coverageNumerator: number;
  readonly absent: number;
}

/**
 * Both translation metrics, from ONE real collection.
 *
 * Through `collectCatalogMetrics` rather than through the producers directly:
 * the defect was a producer wired to the wrong reader, and a test that called
 * the reader itself would have passed against the broken wiring.
 */
async function readTranslationMetrics(tx: DatabaseOrTransaction): Promise<TranslationReading> {
  const report = await collectCatalogMetrics({ db: tx });
  const coverage = report.readings.find((row) => row.key === 'translation_coverage');
  const missing = report.readings.find((row) => row.key === 'translation_missing_count');
  if (coverage?.state !== 'measured' || coverage.kind !== 'ratio') {
    throw new Error(`translation_coverage is not a measured ratio: ${JSON.stringify(coverage)}`);
  }
  if (missing?.state !== 'measured' || missing.kind !== 'count') {
    throw new Error(`translation_missing_count is not a measured count: ${JSON.stringify(missing)}`);
  }
  const denominator = coverage.denominator;
  if (denominator === undefined) throw new Error('translation_coverage carries no denominator');
  // A `count` reading carries its total in `numerator` — there is no
  // `denominator` on one, which is the shape `count()` builds.
  return {
    coverageDenominator: denominator,
    coverageNumerator: coverage.numerator,
    absent: missing.numerator,
  };
}

/**
 * Run a case inside a transaction that is always rolled back.
 *
 * A SENTINEL, not `tx.rollback()` wrapped in `rejects.toThrow()`. That idiom was
 * the first version of this file and it made every assertion in it VACUOUS: a
 * failed `expect` throws, `rejects.toThrow()` accepts any throw, so the case
 * passed whether the assertion held or not — both mutations of the producer
 * survived it. Only the sentinel is swallowed here, so an assertion failure
 * propagates and reds the test.
 */
const ROLLBACK = new Error('rollback: this case is complete');

async function rolledBack(
  work: (tx: DatabaseOrTransaction) => Promise<void>,
): Promise<void> {
  try {
    await db.transaction(
      async (tx) => {
        await work(tx);
        throw ROLLBACK;
      },
      // REPEATABLE READ, and it is load-bearing rather than tidy. Every case
      // here reads a metric, writes one row, and reads again, attributing the
      // DIFFERENCE to that row. Under the default `read committed` each
      // statement takes a fresh snapshot, so a sibling file committing an
      // attribute definition or a category between the two reads lands in the
      // delta — measured: this file passes alone and reds under the full suite.
      // A snapshot makes the only changes visible to the second read the ones
      // this transaction made itself.
      { isolationLevel: 'repeatable read' },
    );
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

describe('#565 — the denominator covers every domain the definition names', () => {
  it('a published CATEGORY moves both metrics', async () => {
    await rolledBack(async (tx) => {
    const before = await readTranslationMetrics(tx);
    await tx.insert(categories).values({
      name: `Pop Cat ${RUN}`,
      slug: `pop-cat-${RUN}`,
      key: `pop.cat.${RUN}`,
      lifecycle: 'published',
    });
    const after = await readTranslationMetrics(tx);
    expect(after.coverageDenominator - before.coverageDenominator).toBeGreaterThan(0);
    expect(after.absent - before.absent).toBeGreaterThan(0);
    });
  }, 180_000);

  it('a published PRODUCT TYPE moves both metrics — the domain the old producer could not see', async () => {
    await rolledBack(async (tx) => {
    const before = await readTranslationMetrics(tx);
    await tx.insert(productTypeDefinitions).values({
      key: `pop_pt_${RUN}`,
      version: 1,
      name: `Pop PT ${RUN}`,
      // `published` is not a bare status: `product_type_definitions_published_audit_check`
      // requires the publication to name who made it and when.
      lifecycle: 'published',
      publishedByOxyUserId: `oxy_${RUN}`,
      publishedAt: new Date(),
    });
    const after = await readTranslationMetrics(tx);
    // Against the pre-#565 producer this delta is ZERO: its denominator was
    // `select count(*) from categories where lifecycle = 'published'`, which
    // a product type cannot move.
    expect(after.coverageDenominator - before.coverageDenominator).toBeGreaterThan(0);
    expect(after.absent - before.absent).toBeGreaterThan(0);
    });
  }, 180_000);

  it('an ATTRIBUTE VALUE moves both metrics, and an attribute DEFINITION alone does not', async () => {
    await rolledBack(async (tx) => {
      const before = await readTranslationMetrics(tx);

      // The NEGATIVE control, and it is the half that matters. An ACTIVE
      // attribute definition is an entity of the `attribute_definition` domain,
      // which the desk measures and which these two definitions do NOT name. A
      // producer summing the desk wholesale moves here; one filtered to the
      // three named domains does not.
      await tx.insert(attributeDefinitions).values({
        key: `pop_attr_solo_${RUN}`,
        version: 1,
        // The same publication audit CHECK as the product type above.
        lifecycleState: 'active',
        publishedByOxyUserId: `oxy_${RUN}`,
        publishedAt: new Date(),
        label: `Pop Attr Solo ${RUN}`,
        valueType: 'enum',
      });

      const afterUnnamed = await readTranslationMetrics(tx);
      expect(
        afterUnnamed.coverageDenominator - before.coverageDenominator,
        'an UNNAMED domain moved the coverage denominator — the metric is measuring a wider '
          + 'population than the one its definition publishes',
      ).toBe(0);
      expect(
        afterUnnamed.absent - before.absent,
        'an UNNAMED domain moved the absent count',
      ).toBe(0);

      // Now the NAMED one. It needs a SECOND definition, created `draft`,
      // because a trigger freezes an active definition's value vocabulary —
      // "publish a new version instead". So the value is added while the parent
      // is draft and the parent is promoted afterwards.
      const [parent] = await tx
        .insert(attributeDefinitions)
        .values({
          key: `pop_attr_parent_${RUN}`,
          version: 1,
          lifecycleState: 'draft',
          label: `Pop Attr Parent ${RUN}`,
          valueType: 'enum',
        })
        .returning();
      if (!parent) throw new Error('attribute definition insert returned no row');
      await tx.insert(attributeEnumValues).values({
        attributeDefinitionId: parent.id,
        value: `pop_value_${RUN}`,
        label: `Pop Value ${RUN}`,
      });

      // Still nothing: the desk's `attribute_value` population joins its parent
      // on `lifecycle_state = 'active'`, so a value under a draft is not owed.
      const afterDraft = await readTranslationMetrics(tx);
      expect(
        afterDraft.coverageDenominator - afterUnnamed.coverageDenominator,
        'a value under a DRAFT definition entered the denominator',
      ).toBe(0);

      await tx
        .update(attributeDefinitions)
        .set({
          lifecycleState: 'active',
          publishedByOxyUserId: `oxy_${RUN}`,
          publishedAt: new Date(),
        })
        .where(eq(attributeDefinitions.id, parent.id));

      // The promotion adds one active DEFINITION too, but the negative control
      // above established that contributes zero — so this delta is the VALUE.
      const afterNamed = await readTranslationMetrics(tx);
      expect(afterNamed.coverageDenominator - afterDraft.coverageDenominator).toBeGreaterThan(0);
      expect(afterNamed.absent - afterDraft.absent).toBeGreaterThan(0);
    });
  }, 180_000);
});
