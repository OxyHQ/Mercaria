/**
 * What a PUBLICATION's impact preview counts, against a REAL PostgreSQL server
 * (#367 Workstream 12, issue #587).
 *
 * ## The defect this file is the gate for
 *
 * `planChange` measured inbound references to the request's own `subjectId`.
 * For `product_type_publish` that subject is the version being published, and a
 * version being published is a `draft` — which is exactly the lifecycle nothing
 * may point at:
 * `RETRIEVABLE_AUTHORING_LIFECYCLES` is `['published', 'deprecated']`, so
 * `catalog_authoring_drafts.product_type_definition_id` **cannot** hold it. The
 * count was therefore zero by construction, and an operator publishing v2 read
 * "no drafts affected" while every draft pinned to v1 was about to be
 * reinterpreted. Not a stale number — a number structurally incapable of being
 * anything else.
 *
 * The population a publication disturbs is the INCUMBENT the same transaction
 * deprecates (`publishProductTypeVersion` deprecates it FIRST, because
 * `product_type_definitions_one_published_per_key` refuses the other order).
 *
 * ## Why this file has a POSITIVE CONTROL before it has an assertion
 *
 * "The count is 1" and "the count is 0" are the same shape of green if the
 * fixture never created the draft. So the premise case measures three things
 * FIRST — the candidate is a draft, nothing points at it, and the incumbent
 * genuinely has a draft pinned to it — and only then does the gate assert what
 * `planChange` reports. Without the third, this file would pass against a fix
 * that counted nothing at all.
 *
 * ## Why a real server
 *
 * The whole premise is a lifecycle allow-list plus a partial unique index
 * (`product_type_definitions_one_published_per_key`) deciding which rows can
 * exist. A mocked repository accepts a draft pinned to a draft version and
 * would make this file green against the very schema rule that creates the bug.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every product type, category, store and draft here lives under this run's
 * own vertical namespace token, and every count is keyed on ids this file
 * minted. The governance rows `planChange` writes are LEFT BEHIND on purpose:
 * `catalog_governance_change_requests` refuses DELETE and
 * `catalog_governance_audit_events` is append-only by trigger, so a teardown
 * would have to switch off the triggers the sibling governance suites assert —
 * which is what would make THOSE assertions pass vacuously.
 * `catalog-governance.realdb.test.ts` leaves its rows for the same reason.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';

import { connectPostgres, type Database } from '../../../db/postgres.js';
import { catalogAuthoringDrafts } from '../../../db/schema/catalogAuthoring.js';
import { productTypeFields } from '../../../db/schema/productTypes.js';
import {
  findProductTypeDefinitionById,
  findPublishedProductTypeDefinition,
  insertProductTypeDefinition,
  type ProductTypeDefinitionRow,
} from '../../../db/productTypes/productTypeRepository.js';
import { findCategoryByKey } from '../../../db/taxonomy/taxonomyRepository.js';
import { governanceActor, type CatalogGovernanceActor } from '../actor.js';
import { planChange } from '../change-request.service.js';
import { GOVERNED_REFERENCE_PLAN, referenceColumnName, referenceTableName } from '../impact-plan.js';
import { resolveImpactSubjects } from '../impact-subjects.js';
import { createDraft } from '../../catalog-authoring/draft.service.js';
import { RETRIEVABLE_AUTHORING_LIFECYCLES } from '../../catalog-authoring/schema.service.js';
import { nsCategoryKey, nsKey, type VerticalNamespace } from '../../../scripts/seed-verticals/apply.js';
import { SMARTPHONE_PACKAGE } from '../../../scripts/seed-verticals/smartphone.js';
import {
  createTestStore,
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../../scripts/seed-verticals/__tests__/vertical-fixture.js';
import { E2E_PERMISSIONS } from '../../../__tests__/vertical-e2e/journey.js';

const TOKEN = verticalRunToken('gov587');
const OPERATOR = `${TOKEN}-operator`;

let db: Database;
let phones: SeededVertical;
let ns: VerticalNamespace;
let storeId: string;
/** The PUBLISHED version this run's drafts pin — the one a publication deprecates. */
let incumbent: ProductTypeDefinitionRow;
/** The DRAFT version a publication would promote. Nothing may point at it. */
let candidate: ProductTypeDefinitionRow;
/** A key with no published version at all — the first-publication case. */
let solo: ProductTypeDefinitionRow;
let pinnedDraftId: string;

/**
 * An actor holding exactly the named roles.
 *
 * The idiom `compatibility-claim-queue.realdb.test.ts` already uses in this
 * domain: `governanceActor` is the only thing that can mint the branded type,
 * and it reads exactly one property off the request.
 */
function actorWith(...roles: Parameters<typeof governanceActor>[1]): CatalogGovernanceActor {
  return governanceActor({ userId: OPERATOR } as unknown as Request, roles);
}

/**
 * The plan's own spelling of one relation.
 *
 * Derived from the drizzle column the plan holds rather than written out here,
 * so this file and `impact-plan.ts` compare ONE spelling. A hand-written
 * `'catalog_authoring_drafts'` / `'product_type_definition_id'` pair would be a
 * second spelling that agrees with neither the plan nor the stored row the day
 * `DATABASE_CASING` renders a name differently — and a lookup that matched
 * nothing would make every assertion below read `undefined` rather than fail.
 */
function relationKeyOf(column: (typeof GOVERNED_REFERENCE_PLAN)['product_type_definition'][number]['column']): {
  table: string;
  column: string;
} {
  const reference = GOVERNED_REFERENCE_PLAN.product_type_definition.find(
    (entry) => entry.column === column,
  );
  if (reference === undefined) {
    throw new Error('the impact plan no longer declares the relation this file measures');
  }
  return { table: referenceTableName(reference), column: referenceColumnName(reference) };
}

/** One relation's reported count, or a failure naming the relation that is missing. */
function countFor(
  counts: readonly { referenceTable: string; referenceColumn: string; rowCount: number }[],
  key: { table: string; column: string },
): number {
  const entry = counts.find(
    (count) => count.referenceTable === key.table && count.referenceColumn === key.column,
  );
  expect(entry, `the impact report carries no measurement for ${key.table}.${key.column}`).toBeDefined();
  return entry === undefined ? -1 : entry.rowCount;
}

beforeAll(async () => {
  db = await connectPostgres();
  phones = await seedVerticalForTest(db, SMARTPHONE_PACKAGE, TOKEN);
  ns = phones.ns;

  const category = await findCategoryByKey(nsCategoryKey(ns, 'phones.smartphones'), db);
  if (!category) throw new Error('the seeded smartphone department did not resolve');
  storeId = await createTestStore(db, TOKEN);

  const published = await findPublishedProductTypeDefinition(db, nsKey(ns, 'smartphone'));
  if (published === null) throw new Error('the seeded smartphone product type is not published');
  incumbent = published;

  // The draft that PINS the incumbent. `createDraft` resolves the published
  // version itself, which is the production path — pinning by id here would be
  // this file asserting its own idea of what a draft points at.
  const draft = await createDraft(db, {
    storeId,
    actorOxyUserId: phones.actorOxyUserId,
    categoryId: category.id,
    productTypeKey: nsKey(ns, 'smartphone'),
    flow: 'merchant',
    locale: 'en',
    market: 'ES',
    permissions: E2E_PERMISSIONS,
    ttlSeconds: 3600,
    title: `Impact preview phone ${TOKEN}`,
  });
  pinnedDraftId = draft.id;

  candidate = await insertProductTypeDefinition(db, {
    key: nsKey(ns, 'smartphone'),
    version: incumbent.version + 1,
    name: `Smartphone v${incumbent.version + 1} (${TOKEN})`,
    createdByOxyUserId: phones.actorOxyUserId,
  });

  solo = await insertProductTypeDefinition(db, {
    key: `${ns.snake}_solo`,
    version: 1,
    name: `Never published (${TOKEN})`,
    createdByOxyUserId: phones.actorOxyUserId,
  });
}, 240_000);

afterAll(async () => {
  // The two DRAFT versions this file minted are deletable; a published one is
  // not (`product_type_definitions_immutable_once_published`), which is why the
  // vertical fixture retires its own rather than deleting them. Drafts, the
  // store and the categories are all `teardownVertical`'s.
  await db.execute(
    sql`delete from product_type_definitions where id in (${candidate.id}, ${solo.id})`,
  );
  await teardownVertical(db, TOKEN);
}, 240_000);

describe('the premise: nothing can point at the version being published', () => {
  it('keeps the candidate out of the lifecycles a record may pin', () => {
    expect(candidate.lifecycle).toBe('draft');
    // The rule that makes the old count zero BY CONSTRUCTION rather than by
    // accident. Read from the authoring service's own tuple, so this file
    // states the premise it depends on rather than restating it.
    expect(
      [...RETRIEVABLE_AUTHORING_LIFECYCLES],
      `RETRIEVABLE_AUTHORING_LIFECYCLES is ${RETRIEVABLE_AUTHORING_LIFECYCLES.join(', ')}`,
    ).not.toContain(candidate.lifecycle);
  });

  it('has a draft pinned to the INCUMBENT and none pinned to the candidate', async () => {
    const pinned = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from catalog_authoring_drafts
       where product_type_definition_id = ${incumbent.id}
    `);
    const onCandidate = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from catalog_authoring_drafts
       where product_type_definition_id = ${candidate.id}
    `);
    // The POSITIVE CONTROL. Without it, "the publication counts one draft" and
    // "the fixture created no draft" produce the same green.
    expect([...pinned][0]?.total, 'the fixture created no draft pinned to the incumbent').toBe(1);
    expect([...onCandidate][0]?.total, 'a draft pinned a version that cannot be pinned').toBe(0);
  });

  it('resolves the incumbent as the version the publication supersedes', async () => {
    const subjects = await resolveImpactSubjects(db, 'product_type_publish', candidate.id);
    expect(subjects.subjectId).toBe(candidate.id);
    expect(subjects.supersededIds).toEqual([incumbent.id]);
  });
});

describe('planning a publication measures the population it disturbs', () => {
  it('counts the drafts pinned to the version it deprecates', async () => {
    const planned = await planChange(db, actorWith('propose'), {
      action: 'product_type_publish',
      subjectId: candidate.id,
      parameters: {},
      reason: 'publishing the next smartphone schema version',
    });

    // A measured report first: an `unmeasured` one carries NO counts at all, so
    // every assertion below would fail for a reason that has nothing to do with
    // the subject being measured.
    expect(planned.request.impact.coverage).toBe('measured');
    expect(planned.request.impact.relationsCounted).toBe(
      planned.request.impact.relationsDeclared,
    );
    expect(
      planned.request.impact.relationsCounted,
      `${String(planned.request.impact.relationsCounted)} relations counted`,
    ).toBeGreaterThan(0);

    // THE GATE. Zero on the pre-fix tree, which counted the candidate alone.
    const drafts = countFor(
      planned.request.impact.counts,
      relationKeyOf(catalogAuthoringDrafts.productTypeDefinitionId),
    );
    expect(
      drafts,
      'a publication reported no affected drafts while a draft was pinned to the version it deprecates',
    ).toBe(1);

    // The incumbent's FIELDS — the schema that stops being current — are the
    // second population the old measurement could not see. The candidate has
    // none of its own, so any positive number here comes from the incumbent.
    const fields = countFor(
      planned.request.impact.counts,
      relationKeyOf(productTypeFields.productTypeDefinitionId),
    );
    expect(fields, `${String(fields)} product-type fields counted`).toBeGreaterThan(0);

    // The request still names its OWN subject. Widening what is COUNTED must
    // not silently rename what is being changed — `applyChangeRequest` drives
    // `publishProductTypeVersion` with this id.
    expect(planned.request.subjectId).toBe(candidate.id);
    expect(planned.request.impact.subjectId).toBe(candidate.id);
  }, 60_000);

  it('records the superseded version on the audit trail, where a re-read can find it', async () => {
    const planned = await planChange(db, actorWith('propose'), {
      action: 'product_type_publish',
      subjectId: candidate.id,
      parameters: {},
      reason: 'a second plan, so the audit row can be read by request id',
    });

    const rows = await db.execute<{ after: { impactSupersededSubjectIds?: string[] } }>(sql`
      select after from catalog_governance_audit_events
       where change_request_id = ${planned.request.id} and action = 'change_requested'
    `);
    const [row] = [...rows];
    expect(row, 'planning wrote no change_requested audit event').toBeDefined();
    // The report itself cannot carry this: `reportFromStoredRows` rebuilds it
    // from columns that do not hold it, so a field would be right at plan time
    // and wrong on every later read.
    expect(row?.after.impactSupersededSubjectIds).toEqual([incumbent.id]);
  }, 60_000);
});

describe('a FIRST publication supersedes nothing, and says so with a measurement', () => {
  it('counts the subject alone and still reports measured coverage', async () => {
    const subjects = await resolveImpactSubjects(db, 'product_type_publish', solo.id);
    expect(subjects.supersededIds).toEqual([]);

    const planned = await planChange(db, actorWith('propose'), {
      action: 'product_type_publish',
      subjectId: solo.id,
      parameters: {},
      reason: 'the first version of a product type nobody has published',
    });

    // Zero affected drafts is the TRUE answer here — nothing is deprecated, so
    // nothing pinned elsewhere moves. It is not the same fact as a missing
    // measurement, and `relationsCounted` is what tells the two apart.
    expect(planned.request.impact.coverage).toBe('measured');
    expect(planned.request.impact.relationsCounted).toBe(
      planned.request.impact.relationsDeclared,
    );
    expect(
      countFor(planned.request.impact.counts, relationKeyOf(catalogAuthoringDrafts.productTypeDefinitionId)),
    ).toBe(0);

    // And the version really is unpublished, so the zero above is about the
    // absence of an incumbent rather than about a lookup that failed.
    const reread = await findProductTypeDefinitionById(db, solo.id);
    expect(reread?.lifecycle).toBe('draft');
    expect(await findPublishedProductTypeDefinition(db, solo.key)).toBeNull();
  }, 60_000);
});
