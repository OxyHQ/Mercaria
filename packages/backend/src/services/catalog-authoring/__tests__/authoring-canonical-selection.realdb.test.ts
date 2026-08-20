/**
 * "Does every canonical reference this draft holds still lead somewhere an
 * author may select", against a REAL PostgreSQL server (#758).
 *
 * #766 narrowed the PICKER to `status = 'active'`, which closed the disclosure —
 * a suppressed brand's name was being offered to any authenticated account
 * willing to type a prefix — and deliberately left the mid-flow question open:
 * a draft that ALREADY holds such an id. Filtering a search cannot reach a
 * stored row. This is that half, taking the second of the three readings
 * recorded on the issue: surface it, so the author is asked to choose again.
 *
 * ## Rows in the states it EXCLUDES, one case per state
 *
 * §6 lesson 3 of `docs/reviews/2026-08-17-catalog-authoring-security-review.md`:
 * "a lifecycle or status filter in a READ path deserves a test the way a write
 * chokepoint does, and asserting one requires ROWS IN THE STATES IT EXCLUDES".
 * A suite that only ever holds an ACTIVE reference passes just as well against a
 * check that was deleted. So this file mints a brand in each excluded state and
 * gives each its own case, so a mutation that reddens one leaves the others
 * green and names what it broke.
 *
 * The ACTIVE brand is the positive control and it carries the weight: "the
 * reference was excluded" and "the check refuses everything" produce the same
 * finding, and only a reference that must NOT be reported tells them apart.
 *
 * ## The refusal must not become an oracle
 *
 * `suppressed` is the operator decision to stop showing an entity, so a finding
 * that said WHICH state a reference is in would answer "does this suppressed
 * brand exist" to anybody holding a draft — reopening at validate exactly what
 * #766 closed at search. The suppressed case and the NONEXISTENT case are
 * therefore asserted to produce byte-identical findings. This file can tell them
 * apart because it minted them; the response cannot.
 *
 * ## It drives `validateStoreDraft` and `publishDraft`, not the module alone
 *
 * A mechanism can be green and inert. `canonicalSelectionFindings` passing its
 * own unit test says nothing about whether `validateDraftRow` calls it, and
 * nothing at all about whether a refusal actually stops a publication — so every
 * case goes through the service entry points the HTTP routes use.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every row carries this run's token, the vertical is namespaced, and teardown
 * removes exactly what this file made. Nothing here counts a table a sibling
 * also writes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { connectPostgres, type Database } from '../../../db/postgres.js';
import { findCategoryByKey } from '../../../db/taxonomy/taxonomyRepository.js';
import { createDraft, patchDraft, validateStoreDraft } from '../draft.service.js';
import { publishDraft } from '../publish.service.js';
import {
  nsCategoryKey,
  nsKey,
  type VerticalNamespace,
} from '../../../scripts/seed-verticals/apply.js';
import { SMARTPHONE_PACKAGE } from '../../../scripts/seed-verticals/smartphone.js';
import {
  createTestStore,
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../../scripts/seed-verticals/__tests__/vertical-fixture.js';
import { E2E_PERMISSIONS, enumValueId } from '../../../__tests__/vertical-e2e/journey.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';

const TOKEN = verticalRunToken('cansel');

const CODE = 'canonical_reference_not_selectable';

/**
 * The attribute this file answers with a brand.
 *
 * `battery_capacity` because it is product-scope and OPTIONAL: leaving it empty
 * produces no finding at all, so the baseline every case is measured against is
 * a draft with NO findings rather than one carrying a warning that would have to
 * be filtered out of each assertion.
 *
 * Its declared value type is irrelevant here and that is not an accident —
 * `expectedKind` returns `canonical_reference` from the field's value POLICY
 * before it looks at the type, which is what lets an existing seeded attribute
 * carry a reference without inventing a vertical for this file.
 */
const REFERENCE_ATTRIBUTE = 'battery_capacity';

/**
 * The smartphone package with that ONE field re-declared as a canonical
 * reference.
 *
 * The policy is moved in the PACKAGE rather than by an `update` after seeding,
 * and the difference is not stylistic: `mercaria_product_type_child_frozen`
 * raises on any write to a published definition's fields, which is #367's own
 * immutability rule and is exactly right. The package is data, the seed is
 * namespaced to this run's token, and a modified copy therefore reaches no row
 * any sibling composes.
 */
const REFERENCE_PACKAGE = {
  ...SMARTPHONE_PACKAGE,
  productTypes: SMARTPHONE_PACKAGE.productTypes.map((productType) => ({
    ...productType,
    fields: productType.fields.map((field) =>
      field.attributeKey === REFERENCE_ATTRIBUTE
        ? { ...field, valuePolicy: 'canonical_reference' as const }
        : field,
    ),
  })),
};

/** The brands, one per state the check must decide differently. */
const ACTIVE_BRAND = `${TOKEN}-brand-active`;
const INACTIVE_BRAND = `${TOKEN}-brand-inactive`;
const SUPPRESSED_BRAND = `${TOKEN}-brand-suppressed`;
/** Merged into the active one — the routine catalogue event, which must NOT report. */
const MERGED_TO_ACTIVE_BRAND = `${TOKEN}-brand-merged-ok`;
/** Merged into the suppressed one — a chain whose END is not selectable. */
const MERGED_TO_SUPPRESSED_BRAND = `${TOKEN}-brand-merged-dead`;
/** Names no row at all. Must be indistinguishable from the suppressed one. */
const ABSENT_BRAND = `${TOKEN}-brand-never-existed`;

/** The canonical rows behind the two SELECTION columns a draft carries. */
const ACTIVE_PRODUCT = `${TOKEN}-product-active`;
const SUPPRESSED_PRODUCT = `${TOKEN}-product-suppressed`;
const SUPPRESSED_VARIANT = `${TOKEN}-variant-suppressed`;

let db: Database;
let phones: SeededVertical;
let ns: VerticalNamespace;
let categoryId = '';
let storeId = '';

async function insertBrand(id: string, status: string, mergedIntoId: string | null): Promise<void> {
  await db.execute(sql`
    insert into brands (id, slug, name, normalized_name, status, merged_into_id)
    values (${id}, ${id}, ${id}, ${id}, ${status}, ${mergedIntoId})
  `);
}

async function insertCanonicalProduct(id: string, status: string): Promise<void> {
  await db.execute(sql`
    insert into canonical_products (id, slug, name, normalized_name, status)
    values (${id}, ${id}, ${id}, ${id}, ${status})
  `);
}

beforeAll(async () => {
  db = await connectPostgres();
  phones = await seedVerticalForTest(db, REFERENCE_PACKAGE, TOKEN);
  ns = phones.ns;
  const category = await findCategoryByKey(nsCategoryKey(ns, 'phones.smartphones'), db);
  if (!category) throw new Error('the seeded smartphone department did not resolve');
  categoryId = category.id;
  storeId = await createTestStore(db, TOKEN);

  await insertBrand(ACTIVE_BRAND, 'active', null);
  await insertBrand(INACTIVE_BRAND, 'inactive', null);
  await insertBrand(SUPPRESSED_BRAND, 'suppressed', null);
  await insertBrand(MERGED_TO_ACTIVE_BRAND, 'merged', ACTIVE_BRAND);
  await insertBrand(MERGED_TO_SUPPRESSED_BRAND, 'merged', SUPPRESSED_BRAND);

  await insertCanonicalProduct(ACTIVE_PRODUCT, 'active');
  await insertCanonicalProduct(SUPPRESSED_PRODUCT, 'suppressed');
  await db.execute(sql`
    insert into canonical_variants (id, product_id, name, signature, status)
    values (${SUPPRESSED_VARIANT}, ${SUPPRESSED_PRODUCT}, ${SUPPRESSED_VARIANT},
            encode(sha256(${SUPPRESSED_VARIANT}::bytea), 'hex'), 'suppressed')
  `);
}, 300_000);

afterAll(async () => {
  await deleteTestCanonicalRows(db, {
    productIds: [ACTIVE_PRODUCT, SUPPRESSED_PRODUCT],
    variantIds: [SUPPRESSED_VARIANT],
  });
  // The merged rows first: `brands.merged_into_id` is `ON DELETE restrict`, so a
  // tombstone outlives the row it points at only if the pointer goes first.
  await db.execute(
    sql`delete from brands where id in (${MERGED_TO_ACTIVE_BRAND}, ${MERGED_TO_SUPPRESSED_BRAND})`,
  );
  await db.execute(
    sql`delete from brands where id in (${ACTIVE_BRAND}, ${INACTIVE_BRAND}, ${SUPPRESSED_BRAND})`,
  );
  await teardownVertical(db, TOKEN);
}, 300_000);

afterEach(async () => {
  await db.execute(sql`delete from catalog_authoring_drafts where store_id = ${storeId}`);
});

/** Author one complete, publishable draft and return its id. */
async function authorDraft(options: {
  brandId?: string;
  selectedCanonicalProductId?: string | null;
  selectedCanonicalVariantId?: string | null;
}): Promise<string> {
  const draft = await createDraft(db, {
    storeId,
    actorOxyUserId: phones.actorOxyUserId,
    categoryId,
    productTypeKey: nsKey(ns, 'smartphone'),
    flow: 'merchant',
    locale: 'en',
    market: 'ES',
    permissions: E2E_PERMISSIONS,
    ttlSeconds: 3600,
    title: `Reference phone ${TOKEN}`,
  });

  const patched = await patchDraft(db, {
    storeId,
    draftId: draft.id,
    expectedVersion: draft.version,
    permissions: E2E_PERMISSIONS,
    description: 'A phone whose catalogue references may have moved underneath it.',
    ...(options.selectedCanonicalProductId === undefined
      ? {}
      : { selectedCanonicalProductId: options.selectedCanonicalProductId }),
    fields: [
      {
        attributeKey: nsKey(ns, 'chipset'),
        values: [{ enumValueId: await enumValueId(db, ns, 'chipset', 'snapdragon_8_gen_4') }],
      },
      { attributeKey: nsKey(ns, 'screen_size'), values: [{ number: 6.9, unit: 'in' }] },
      ...(options.brandId === undefined
        ? []
        : [
            {
              attributeKey: nsKey(ns, REFERENCE_ATTRIBUTE),
              values: [{ canonicalRef: { kind: 'brand' as const, id: options.brandId } }],
            },
          ]),
    ],
    variants: [
      {
        sku: `${TOKEN}-sku`,
        price: { amount: 90_000, currency: 'EUR' },
        inventoryAvailable: 4,
        ...(options.selectedCanonicalVariantId === undefined
          ? {}
          : { selectedCanonicalVariantId: options.selectedCanonicalVariantId }),
        axes: [
          {
            attributeKey: nsKey(ns, 'phone_color'),
            values: [{ enumValueId: await enumValueId(db, ns, 'phone_color', 'black') }],
          },
          { attributeKey: nsKey(ns, 'storage_capacity'), values: [{ number: 256, unit: 'GB' }] },
        ],
      },
    ],
  });
  return patched.id;
}

/** The findings `validateStoreDraft` answers for one authored draft. */
async function validateWith(
  options: Parameters<typeof authorDraft>[0],
): Promise<{ codes: string[]; findings: readonly { code: string; severity: string; path: string }[]; publishable: boolean }> {
  const draftId = await authorDraft(options);
  const result = await validateStoreDraft(db, {
    storeId,
    draftId,
    permissions: E2E_PERMISSIONS,
  });
  return {
    codes: result.findings.map((entry) => entry.code),
    findings: result.findings.map((entry) => ({
      code: entry.code,
      severity: entry.severity,
      path: entry.path,
    })),
    publishable: result.publishable,
  };
}

describe('the fixture states what every case below is measured against', () => {
  it('minted one brand in each state, and the field really asks for a reference', async () => {
    // Without this the whole file could be measuring a `value_type_mismatch`: if
    // the value policy had not moved, a `canonicalRef` answer would be refused
    // as the wrong kind and never reach the read under test at all.
    const rows = [
      ...(await db.execute<{ id: string; status: string; merged_into_id: string | null }>(sql`
        select id, status, merged_into_id from brands where id like ${`${TOKEN}-brand-%`}
        order by id
      `)),
    ];
    expect(rows.map((row) => `${row.id}:${row.status}`).sort()).toEqual(
      [
        `${ACTIVE_BRAND}:active`,
        `${INACTIVE_BRAND}:inactive`,
        `${MERGED_TO_ACTIVE_BRAND}:merged`,
        `${MERGED_TO_SUPPRESSED_BRAND}:merged`,
        `${SUPPRESSED_BRAND}:suppressed`,
      ].sort(),
    );

    const [policy] = [
      ...(await db.execute<{ value_policy: string }>(sql`
        select value_policy from product_type_fields
        where attribute_key = ${nsKey(ns, REFERENCE_ATTRIBUTE)} limit 1
      `)),
    ];
    expect(policy?.value_policy).toBe('canonical_reference');

    // And the id that must be indistinguishable from a suppressed one really
    // names nothing — otherwise the oracle case below compares two live rows.
    const absent = [
      ...(await db.execute<{ id: string }>(sql`select id from brands where id = ${ABSENT_BRAND}`)),
    ];
    expect(absent).toHaveLength(0);
  });
});

describe('a reference the catalogue still offers is left alone', () => {
  it('says NOTHING about an ACTIVE brand', async () => {
    // The positive control, and the case that carries the file: without it a
    // check that reported every reference would satisfy all five cases below.
    const result = await validateWith({ brandId: ACTIVE_BRAND });
    expect(result.codes).not.toContain(CODE);
    expect(result.publishable).toBe(true);
  });

  it('says NOTHING about a MERGED brand whose winner is active', async () => {
    // A merge is routine and the author did nothing. `resolveBrandSelection`
    // follows the pointer, as `resolveCanonicalProductSelection` already does at
    // publish, so reporting this would refuse a publication that works today for
    // a catalogue event the merchant cannot see.
    const result = await validateWith({ brandId: MERGED_TO_ACTIVE_BRAND });
    expect(result.codes).not.toContain(CODE);
    expect(result.publishable).toBe(true);
  });

  it('says NOTHING about a draft holding no reference at all', async () => {
    // The ordinary merchant case, and the assertion that keeps the read from
    // issuing statements — or findings — for a draft that names nothing.
    const result = await validateWith({});
    expect(result.codes).not.toContain(CODE);
    expect(result.publishable).toBe(true);
  });
});

describe('a reference the catalogue has decided against is reported', () => {
  it('reports a SUPPRESSED brand', async () => {
    const result = await validateWith({ brandId: SUPPRESSED_BRAND });
    expect(result.codes).toContain(CODE);
  });

  it('reports an INACTIVE brand', async () => {
    // Its own case, not folded into the one above: `brands_status_check` carries
    // four statuses and the pointer filter #766 replaced admitted BOTH of these.
    // One case for two states would stay green with half the fix.
    const result = await validateWith({ brandId: INACTIVE_BRAND });
    expect(result.codes).toContain(CODE);
  });

  it('reports a MERGED brand whose chain ends somewhere not selectable', async () => {
    // The case a one-hop `status <> 'merged'` test cannot see, and the reason
    // the resolver walks rather than reading one row.
    const result = await validateWith({ brandId: MERGED_TO_SUPPRESSED_BRAND });
    expect(result.codes).toContain(CODE);
  });

  it('is an ERROR on the answered field, and blocks publication', async () => {
    const result = await validateWith({ brandId: SUPPRESSED_BRAND });
    const finding = result.findings.find((entry) => entry.code === CODE);
    expect(finding?.severity).toBe('error');
    expect(finding?.path).toBe(`fields.${nsKey(ns, REFERENCE_ATTRIBUTE)}`);
    // The draft is otherwise complete, so the reference is the only thing that
    // could have blocked it — which is what makes this about the severity rather
    // than about the fixture.
    expect(result.findings.filter((entry) => entry.severity === 'error')).toHaveLength(1);
    expect(result.publishable).toBe(false);
  });

  it('refuses the PUBLISH, not only the validate', async () => {
    // `validateStoreDraft` being red says nothing about whether publication
    // consults it. This is the assertion a diff that removed the merge would
    // fail.
    const draftId = await authorDraft({ brandId: SUPPRESSED_BRAND });
    const published = await publishDraft(db, {
      storeId,
      draftId,
      actorOxyUserId: phones.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      idempotencyKey: null,
    });
    expect(published.outcome).toBe('refused');
    if (published.outcome !== 'refused') throw new Error('unreachable');
    expect(published.validation.findings.map((entry) => entry.code)).toContain(CODE);
    expect(published.validation.publishable).toBe(false);
  });
});

describe('the refusal is not an oracle', () => {
  it('answers a suppressed brand and a brand that never existed identically', async () => {
    // `suppressed` is the operator decision to stop showing a brand. A finding
    // that distinguished the two would answer "does this brand exist" to anybody
    // holding a draft — the disclosure #766 closed at the search half of this
    // same surface, reopened at the validate half. This file knows which is
    // which because it minted them; the response does not.
    const suppressed = await validateWith({ brandId: SUPPRESSED_BRAND });
    const absent = await validateWith({ brandId: ABSENT_BRAND });
    expect(absent.findings).toEqual(suppressed.findings);
    expect(absent.publishable).toBe(false);
  });
});

describe('the two SELECTION columns are asked the same question', () => {
  it('reports a selected canonical PRODUCT that is suppressed', async () => {
    // Before #758 this was the silent one: `publishDraft` coerced the
    // unresolvable selection to `null` (`?.id ?? null`) and published unlinked,
    // which also skipped the variant belongs-to consistency check. Its own case,
    // because it is a different reader from the answered field above.
    const result = await validateWith({ selectedCanonicalProductId: SUPPRESSED_PRODUCT });
    expect(result.codes).toContain(CODE);
    const finding = result.findings.find((entry) => entry.code === CODE);
    expect(finding?.path).toBe('classification.selectedCanonicalProductId');
    expect(result.publishable).toBe(false);
  });

  it('says NOTHING about a selected canonical product that is active', async () => {
    const result = await validateWith({ selectedCanonicalProductId: ACTIVE_PRODUCT });
    expect(result.codes).not.toContain(CODE);
    expect(result.publishable).toBe(true);
  });

  it('reports a selected canonical VARIANT that is suppressed', async () => {
    const result = await validateWith({
      selectedCanonicalProductId: SUPPRESSED_PRODUCT,
      selectedCanonicalVariantId: SUPPRESSED_VARIANT,
    });
    const paths = result.findings.filter((entry) => entry.code === CODE).map((entry) => entry.path);
    expect(paths).toContain('variants[0].selectedCanonicalVariantId');
  });
});
