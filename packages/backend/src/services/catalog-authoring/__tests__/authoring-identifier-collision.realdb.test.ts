/**
 * "Is this barcode already somebody else's", against a REAL PostgreSQL server
 * (#367 workstream 7, the COLLISION half of "validate identifiers and
 * collisions using existing canonical rules").
 *
 * This is the one new check that reads a row, so it is the one a mocked
 * repository could not test: a mock would accept any statement, and what is
 * under test here is the actual predicate — `status = 'active'`, a SELECTABLE
 * product, and a match on the normalized value OR the zero-padded canonical
 * one. Every one of those is a real filter in
 * `findCanonicalProductsByIdentifier`, and getting any of them wrong produces a
 * validator that silently reports nothing.
 *
 * ## It drives `validateStoreDraft`, not the module in isolation
 *
 * A mechanism can be green and inert. `identifierCollisionFindings` passing its
 * own unit test says nothing about whether `validateDraftRow` calls it, so
 * every case below goes through the public service entry point the HTTP route
 * uses — which means a diff that deleted the call site fails here rather than
 * in a review.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every row carries this run's token, the canonical products are namespaced,
 * and teardown removes exactly what this file made. Nothing here counts a table
 * a sibling also writes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { connectPostgres, type Database } from '../../../db/postgres.js';
import { findCategoryByKey } from '../../../db/taxonomy/taxonomyRepository.js';
import { createDraft, patchDraft, validateStoreDraft } from '../draft.service.js';
import { nsCategoryKey, nsKey, type VerticalNamespace } from '../../../scripts/seed-verticals/apply.js';
import { SMARTPHONE_PACKAGE } from '../../../scripts/seed-verticals/smartphone.js';
import {
  createTestStore,
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../../scripts/seed-verticals/__tests__/vertical-fixture.js';
import { E2E_PERMISSIONS, enumValueId } from '../../../__tests__/vertical-e2e/journey.js';
import { gs1CheckDigit } from '../../canonical/identifiers.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';

const TOKEN = verticalRunToken('idcol');

/** A real EAN-13: a payload plus the check digit it actually needs. */
const PAYLOAD = '840000000001';
const GTIN = `${PAYLOAD}${gs1CheckDigit(PAYLOAD)}`;
/** Its `product_identifiers.canonical_value` form. */
const CANONICAL = GTIN.padStart(14, '0');

/** The catalogue product that OWNS the barcode, and the unrelated one. */
const OWNER_PRODUCT = `${TOKEN}-owner`;
const OTHER_PRODUCT = `${TOKEN}-other`;

let db: Database;
let phones: SeededVertical;
let ns: VerticalNamespace;
let categoryId = '';
let storeId = '';

async function insertCanonicalProduct(id: string, name: string): Promise<void> {
  await db.execute(sql`
    insert into canonical_products (id, slug, name, normalized_name, status)
    values (${id}, ${id}, ${name}, ${name.toLowerCase()}, 'active')
  `);
}

beforeAll(async () => {
  db = await connectPostgres();
  phones = await seedVerticalForTest(db, SMARTPHONE_PACKAGE, TOKEN);
  ns = phones.ns;
  const category = await findCategoryByKey(nsCategoryKey(ns, 'phones.smartphones'), db);
  if (!category) throw new Error('the seeded smartphone department did not resolve');
  categoryId = category.id;
  storeId = await createTestStore(db, TOKEN);

  await insertCanonicalProduct(OWNER_PRODUCT, `Owner phone ${TOKEN}`);
  await insertCanonicalProduct(OTHER_PRODUCT, `Other phone ${TOKEN}`);
  await db.execute(sql`
    insert into product_identifiers
      (id, product_id, scheme, raw_value, normalized_value, canonical_scheme, canonical_value, status)
    values
      (${`${TOKEN}-pid`}, ${OWNER_PRODUCT}, 'ean', ${GTIN}, ${GTIN}, 'gtin', ${CANONICAL}, 'active')
  `);
}, 300_000);

afterAll(async () => {
  // Own children first — the identifier row this file minted. Then the products
  // through `deleteTestCanonicalRows` rather than a direct DELETE: the matcher's
  // retrieval is a trigram scan over EVERY `canonical_products` row, so a
  // sibling file's `runMatch` can record a `match_decisions` row citing a
  // fixture of ours, and both citing columns are `ON DELETE restrict`. The
  // helper DECLINES exactly the cited ids instead of deleting a sibling's row.
  // `db/__tests__/canonical-fixture-census.test.ts` fails the build on a fixture
  // that deletes canonical rows any other way, and it caught this file.
  await db.execute(sql`delete from product_identifiers where id = ${`${TOKEN}-pid`}`);
  await deleteTestCanonicalRows(db, { productIds: [OWNER_PRODUCT, OTHER_PRODUCT] });
  await teardownVertical(db, TOKEN);
}, 300_000);

afterEach(async () => {
  await db.execute(sql`delete from catalog_authoring_drafts where store_id = ${storeId}`);
});

/**
 * Author one draft carrying `barcode`, optionally pinned to a canonical
 * product, and return the codes `validateStoreDraft` answers.
 */
async function validateWith(options: {
  barcode: string;
  selectedCanonicalProductId?: string | null;
}): Promise<string[]> {
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
    title: `Collision phone ${TOKEN}`,
  });

  const patched = await patchDraft(db, {
    storeId,
    draftId: draft.id,
    expectedVersion: draft.version,
    permissions: E2E_PERMISSIONS,
    description: 'A phone whose barcode the catalogue may already know.',
    ...(options.selectedCanonicalProductId === undefined
      ? {}
      : { selectedCanonicalProductId: options.selectedCanonicalProductId }),
    fields: [
      {
        attributeKey: nsKey(ns, 'chipset'),
        values: [{ enumValueId: await enumValueId(db, ns, 'chipset', 'snapdragon_8_gen_4') }],
      },
      { attributeKey: nsKey(ns, 'screen_size'), values: [{ number: 6.9, unit: 'in' }] },
    ],
    variants: [
      {
        sku: `${TOKEN}-sku`,
        barcode: options.barcode,
        price: { amount: 90_000, currency: 'EUR' },
        inventoryAvailable: 4,
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

  const result = await validateStoreDraft(db, {
    storeId,
    draftId: patched.id,
    permissions: E2E_PERMISSIONS,
  });
  return result.findings.map((entry) => entry.code);
}

describe('the fixture states what every case below is measured against', () => {
  it('the barcode is a REAL EAN-13, and the catalogue really owns it', async () => {
    // Both halves are load-bearing. A fixture barcode with a bad check digit
    // would be classified `invalid`, never reach the collision read at all, and
    // every "no collision" assertion below would pass for the wrong reason.
    expect(GTIN).toHaveLength(13);
    expect(gs1CheckDigit(GTIN.slice(0, -1))).toBe(Number(GTIN.slice(-1)));

    const [row] = [
      ...(await db.execute<{ product_id: string; canonical_value: string }>(sql`
        select product_id, canonical_value from product_identifiers
        where id = ${`${TOKEN}-pid`} and status = 'active'
      `)),
    ];
    expect(row?.product_id).toBe(OWNER_PRODUCT);
    expect(row?.canonical_value).toBe(CANONICAL);
  });
});

describe('a barcode the catalogue attributes elsewhere is reported', () => {
  it('reports a collision when the draft is pinned to a DIFFERENT product', async () => {
    const codes = await validateWith({
      barcode: GTIN,
      selectedCanonicalProductId: OTHER_PRODUCT,
    });
    expect(codes).toContain('identifier_collision');
  });

  it('says NOTHING when the draft is pinned to the product that owns it', async () => {
    // The control that matters most: this is the commonest correct state — an
    // author picked the right product and typed its barcode. A collision check
    // that fired on "an owner exists" rather than on "a FOREIGN owner exists"
    // would report every one of them, and would still pass the case above.
    const codes = await validateWith({
      barcode: GTIN,
      selectedCanonicalProductId: OWNER_PRODUCT,
    });
    expect(codes).not.toContain('identifier_collision');
  });

  it('says NOTHING when the draft names no canonical product', async () => {
    // With no selection there is no contradiction: an owned barcode is then
    // evidence the author is describing that product, which is the matcher's
    // conclusion to draw. Reporting it would tell somebody their correct
    // barcode is a problem.
    const codes = await validateWith({ barcode: GTIN });
    expect(codes).not.toContain('identifier_collision');
  });

  it('says NOTHING about a valid barcode the catalogue has never seen', async () => {
    // The positive control for the read itself. Without it, a repository call
    // that returned every row — or that matched on nothing — would satisfy the
    // first case and be indistinguishable from a working one.
    const unseenPayload = '840000000999';
    const unseen = `${unseenPayload}${gs1CheckDigit(unseenPayload)}`;
    expect(unseen).not.toBe(GTIN);
    const codes = await validateWith({
      barcode: unseen,
      selectedCanonicalProductId: OTHER_PRODUCT,
    });
    expect(codes).not.toContain('identifier_collision');
  });

  it('never asks the catalogue about a barcode that failed its check digit', async () => {
    // A string that is not an identifier has nothing to collide with, and
    // `identifier_check_digit_invalid` has already said the true thing about
    // it. Both halves are asserted: the malformed value IS reported, and it is
    // NOT reported as a collision.
    const broken = `${GTIN.slice(0, -1)}${(Number(GTIN.slice(-1)) + 1) % 10}`;
    const codes = await validateWith({
      barcode: broken,
      selectedCanonicalProductId: OTHER_PRODUCT,
    });
    expect(codes).toContain('identifier_check_digit_invalid');
    expect(codes).not.toContain('identifier_collision');
  });

  it('is a WARNING and does not block publication', async () => {
    // ADR 0001-era posture, applied here: `assignIdentifier` answers `disputed`
    // and keeps both rows rather than refusing, and #58's
    // `match_decisions_blockers_auto_check` already stops a conflicting valid
    // identifier auto-merging. Blocking would let one catalogue row — not
    // editable by this merchant — stop a publication the CHECK already protects.
    const draftCodes = await validateWith({
      barcode: GTIN,
      selectedCanonicalProductId: OTHER_PRODUCT,
    });
    expect(draftCodes).toContain('identifier_collision');

    const result = await validateStoreDraft(db, {
      storeId,
      draftId: (
        await db.execute<{ id: string }>(sql`
          select id from catalog_authoring_drafts where store_id = ${storeId} limit 1
        `)
      )[0]?.id as string,
      permissions: E2E_PERMISSIONS,
    });
    const collision = result.findings.find((entry) => entry.code === 'identifier_collision');
    expect(collision?.severity).toBe('warning');
    // The draft is otherwise complete, so the collision is the ONLY thing that
    // could have blocked it — which is what makes this assertion about the
    // severity rather than about the fixture.
    expect(result.findings.filter((entry) => entry.severity === 'error')).toEqual([]);
    expect(result.publishable).toBe(true);
  });
});

describe('a stored identifier that is not ACTIVE owns nothing', () => {
  it('ignores a retired identifier row', async () => {
    // `findCanonicalProductsByIdentifier` filters `status = 'active'`. A
    // collision read that dropped that filter would report a barcode somebody
    // deliberately retired as still owned — and no unit test over a mock could
    // tell, because a mock accepts the statement either way.
    await db.execute(
      sql`update product_identifiers set status = 'retired' where id = ${`${TOKEN}-pid`}`,
    );
    try {
      const codes = await validateWith({
        barcode: GTIN,
        selectedCanonicalProductId: OTHER_PRODUCT,
      });
      expect(codes).not.toContain('identifier_collision');
    } finally {
      await db.execute(
        sql`update product_identifiers set status = 'active' where id = ${`${TOKEN}-pid`}`,
      );
    }
    // Restored, and PROVED restored — a `finally` that silently failed would
    // leave every later file in this run measuring a retired row.
    const codes = await validateWith({
      barcode: GTIN,
      selectedCanonicalProductId: OTHER_PRODUCT,
    });
    expect(codes).toContain('identifier_collision');
  });
});
