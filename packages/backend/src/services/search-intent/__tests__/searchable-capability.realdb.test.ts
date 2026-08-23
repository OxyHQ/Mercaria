/**
 * `attribute_definitions.searchable` read by the REAL entrypoint, against a REAL
 * server (#367 line 277).
 *
 * The capability decides whether a shopper's own WORDS may resolve to an
 * attribute. It is applied in exactly one place — `loadDefinitions` in
 * `plan.service.ts`, so that the interpreter's three matching passes,
 * `buildModelVocabulary` and `validateCandidate` all read one already-filtered
 * array — and that is precisely the shape of a mechanism that is GREEN AND
 * INERT. #95's benchmark drives `interpretDeterministically` against an
 * in-memory registry, so the column, the filter and the wiring can all be
 * deleted without turning a single benchmark case red.
 *
 * So this file drives `planShoppingIntent` — the function the controller calls
 * — against definitions it published through the registry service, and asserts
 * what the plan's constraint set does and does not name. Three things make it a
 * measurement rather than a demonstration:
 *
 * - **A positive control**: the identical query shape against a `searchable`
 *   attribute DOES produce a constraint, so a plan that named nothing would not
 *   pass.
 * - **A VERSION control**: the same attribute, the same word, published again
 *   as v2 with `searchable: false`. The term stops being recognised, which is
 *   what proves the column did it rather than the fixture.
 * - **Words no dictionary holds.** Every controlled value here is a nonsense
 *   token minted for this run, so nothing in `dictionaries.ts` can answer it.
 *
 * ## Scoping, because the database is SHARED
 *
 * One throwaway database serves the whole suite in parallel workers, and
 * `loadDefinitions` with no category reads EVERY active definition — so a
 * sibling's fixtures are in scope for these queries. Every assertion therefore
 * names the attribute key this file created rather than counting constraints,
 * and teardown deletes exactly what it wrote.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { attributeDefinitions } from '../../../db/schema/attributeRegistry.js';
import {
  draftAttributeDefinition,
  publishAttributeDefinition,
} from '../../attributes/definition-registry.service.js';
import { planShoppingIntent } from '../plan.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');
const OPERATOR = `operator-${RUN}`;

const createdKeys: string[] = [];

/** Tokens no dictionary, slug, unit or product name in this repository holds. */
const SEARCHABLE_WORD = `zorvimplex${RUN}`;
const WITHHELD_WORD = `quenbaril${RUN}`;

async function publishEnum(
  name: string,
  spelling: string,
  options: { searchable?: boolean; version?: number; key?: string } = {},
): Promise<string> {
  const attributeKey = options.key ?? `${name}_${RUN}`.toLowerCase();
  if (!createdKeys.includes(attributeKey)) createdKeys.push(attributeKey);
  await draftAttributeDefinition({
    key: attributeKey,
    label: `Capability ${name}`,
    valueType: 'enum',
    enumValues: [{ value: 'only_value', label: spelling }],
    ...(options.searchable === undefined ? {} : { searchable: options.searchable }),
    actorOxyUserId: OPERATOR,
  });
  await publishAttributeDefinition(attributeKey, options.version ?? 1, OPERATOR);
  return attributeKey;
}

/** The attribute keys the plan's constraint set names. */
async function constrainedKeys(query: string): Promise<string[]> {
  const plan = await planShoppingIntent({ request: { query, locale: 'en-GB' } }, db);
  expect(plan.status, `planShoppingIntent refused "${query}"`).toBe('planned');
  if (plan.status !== 'planned') return [];
  return plan.result.interpretation.constraints.constraints
    .filter((constraint) => constraint.kind === 'attribute')
    .map((constraint) => constraint.attributeKey);
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (db) {
    if (createdKeys.length > 0) {
      // Every version this file published, drafts and actives alike. A published
      // version refuses DELETE, so it is demoted to `draft` first — the same
      // teardown `attribute-registry.realdb.test.ts` uses, and `deprecatedAt`
      // has to be cleared with it: publishing v2 deprecates v1, and
      // `attribute_definitions_deprecated_at_check` refuses a draft carrying a
      // deprecation instant.
      await db
        .update(attributeDefinitions)
        .set({
          lifecycleState: 'draft',
          publishedAt: null,
          publishedByOxyUserId: null,
          deprecatedAt: null,
        })
        .where(inArray(attributeDefinitions.key, createdKeys));
      await db.delete(attributeDefinitions).where(inArray(attributeDefinitions.key, createdKeys));
    }
    await closePostgres();
  }
}, 60_000);

describe('planShoppingIntent reads #94 `searchable`', () => {
  let searchableKey: string;
  let withheldKey: string;

  beforeAll(async () => {
    searchableKey = await publishEnum('searchable_axis', SEARCHABLE_WORD);
    withheldKey = await publishEnum('withheld_axis', WITHHELD_WORD, { searchable: false });
  }, 120_000);

  it('recognises a controlled value of a SEARCHABLE attribute', async () => {
    // The positive control for everything below: with this red, an assertion
    // that the withheld word produces nothing would be passing because
    // `planShoppingIntent` recognises nothing at all.
    expect(await constrainedKeys(`${SEARCHABLE_WORD} laptop`)).toContain(searchableKey);
  });

  it('recognises no word of an attribute the registry withholds from search', async () => {
    const named = await constrainedKeys(`${WITHHELD_WORD} laptop`);
    expect(named).not.toContain(withheldKey);
    // The two queries are the same shape against two definitions that differ in
    // ONE column, so this is a comparison rather than an absence.
    expect(await constrainedKeys(`${SEARCHABLE_WORD} laptop`)).toContain(searchableKey);
  });

  it('stops recognising a word when the ACTIVE version withdraws the capability', async () => {
    // The removal control, and the one that says the COLUMN did it. A published
    // version's meaning is frozen, so withdrawing a capability is a new version
    // — which is also the change `catalog-governance`'s diff reports as
    // breaking for exactly this reason.
    expect(await constrainedKeys(`${SEARCHABLE_WORD} laptop`)).toContain(searchableKey);

    await draftAttributeDefinition({
      key: searchableKey,
      label: 'Capability searchable_axis',
      valueType: 'enum',
      enumValues: [{ value: 'only_value', label: SEARCHABLE_WORD }],
      searchable: false,
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(searchableKey, 2, OPERATOR);

    expect(await constrainedKeys(`${SEARCHABLE_WORD} laptop`)).not.toContain(searchableKey);
  });
});
