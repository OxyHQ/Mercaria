/**
 * An autosave of VARIANTS must not destroy the publication gate's reference
 * (#771 — the variant half of #729).
 *
 * `replaceDraftVariants` deleted every variant row of a draft on ANY variants
 * patch and re-inserted them with fresh ids.
 * `catalog_authoring_draft_values.draft_variant_id` carries `ON DELETE cascade`,
 * so every variant-scope answer went with them, and a
 * `catalog_proposal_references.draft_value_id` pointing at one cascaded away
 * too. `listOpenProposalsBlockingDraft` filters on the reference's `draft_id`,
 * so the publication gate stopped blocking: a draft whose unreviewed concept was
 * still open became publishable through the most routine action the wizard
 * performs.
 *
 * Worse than the product-scope case #729 fixed, in one respect: that delete was
 * at least scoped to the fields the client re-sent, while this fired for every
 * variant answer whether or not the patch mentioned it.
 *
 * ## What is asserted, and at which layer
 *
 * `listOpenProposalsBlockingDraft` rather than `validateDraftRow`: it is the
 * gate's SOLE input — the function `draft.service.ts` calls to decide whether an
 * open proposal blocks publication — and it is a DIFFERENT function from the
 * repository under repair, which is what makes this a test of the gate rather
 * than of the fix restating itself.
 *
 * ## Every case asserts the gate blocks BEFORE the patch
 *
 * A gate that stopped blocking and a fixture that never made it block produce
 * the same empty list. The control is not politeness, it is the only thing that
 * tells those apart.
 *
 * ## The intermediate assertions are `expect.soft`, deliberately
 *
 * Inherited from #770, which measured the cost of getting this wrong: with them
 * hard, reverting the fix failed on the re-minted id and threw before
 * `listOpenProposalsBlockingDraft` was ever called — so the assertion the issue
 * is actually about went unevaluated while the file read as mutation-proven.
 * `expect.soft` records and continues, so ONE mutation run exercises both.
 *
 * ## The mutations this file was measured against
 *
 * 1. Reverting `replaceDraftVariants` to delete-and-reinsert reds the autosave
 *    and reorder cases on BOTH the re-minted id and the gate.
 * 2. Deleting the duplicate-signature guard ALONE reds the duplicate-axes case.
 * 3. Deleting the duplicate-slot guard ALONE reds the duplicate-slot case.
 *
 * Cases 2 and 3 land on a draft that ALREADY holds the row, which is the whole
 * point: #770's first duplicate test used an empty draft and passed with its
 * guard deleted, because with no row to match both duplicates take the INSERT
 * branch and the partial unique refuses the second exactly as it always did. The
 * collapse needs a row to UPDATE.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every fixture id carries a per-run suffix and teardown deletes exactly what it
 * created. Nothing here counts a table.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import {
  listDraftValues,
  listDraftVariants,
  replaceDraftVariants,
  replaceVariantScopeValues,
  type NewDraftValue,
  type NewDraftVariant,
} from '../../../db/catalogAuthoring/draftRepository.js';
import { listOpenProposalsBlockingDraft } from '../../../db/catalogProposals/proposalRepository.js';

let db: Database;

const RUN = uuidv7().slice(-12).replace(/\W/gu, '');
const STORE_ID = `var-${RUN}-store`;
const SELLER = `oxy-${RUN}`;

let categoryId = '';
let productTypeDefinitionId = '';
let attributeDefinitionId = '';
let fieldId = '';

/**
 * Two axis signatures this file owns.
 *
 * Real 64-hex digests are not required by any CHECK on this table — the
 * signature column is plain `text` — but they are shaped like the ones
 * `typedVariantSignature` produces so the fixture cannot pass for a reason the
 * production value would not.
 */
const SIG_A = `a${RUN}`.padEnd(64, '0').slice(0, 64);
const SIG_B = `b${RUN}`.padEnd(64, '0').slice(0, 64);

beforeAll(async () => {
  db = await connectPostgres();
  await db.execute(sql`
    insert into stores (id, name, handle, description, brand_color)
    values (${STORE_ID}, ${`var ${RUN}`}, ${`var-${RUN}`}, '', '#101010')
  `);
  categoryId = `var-${RUN}-cat`;
  await db.execute(sql`
    insert into categories (id, key, slug, name, lifecycle, selectable)
    values (${categoryId}, ${`var.${RUN}`}, ${`var-${RUN}`}, 'Variant fixture', 'published', true)
  `);
  // DRAFT lifecycle so the fixture is deletable:
  // `product_type_definitions_immutable_once_published` refuses a DELETE from
  // `published` onward.
  productTypeDefinitionId = `var-${RUN}-ptd`;
  await db.execute(sql`
    insert into product_type_definitions (id, key, version, lifecycle, name)
    values (${productTypeDefinitionId}, ${`var_${RUN}`}, 1, 'draft', 'Variant fixture')
  `);
  attributeDefinitionId = `var-${RUN}-attr`;
  await db.execute(sql`
    insert into attribute_definitions (id, key, version, lifecycle_state, label, value_type)
    values (${attributeDefinitionId}, ${`var_colour_${RUN}`}, 1, 'draft', 'Colour', 'string')
  `);
  fieldId = `var-${RUN}-field`;
  await db.execute(sql`
    insert into product_type_fields
      (id, product_type_definition_id, attribute_definition_id, attribute_key,
       attribute_definition_version, scope, flow, requirement, value_policy)
    values
      (${fieldId}, ${productTypeDefinitionId}, ${attributeDefinitionId}, ${`var_colour_${RUN}`},
       1, 'variant', 'merchant', 'optional', 'typed_scalar')
  `);
}, 120_000);

afterAll(async () => {
  await db.execute(sql`delete from catalog_proposals where submitted_by_oxy_user_id = ${SELLER}`);
  await db.execute(sql`delete from catalog_authoring_drafts where store_id = ${STORE_ID}`);
  await db.execute(sql`delete from product_type_fields where id = ${fieldId}`);
  await db.execute(sql`delete from attribute_definitions where id = ${attributeDefinitionId}`);
  await db.execute(sql`delete from product_type_definitions where id = ${productTypeDefinitionId}`);
  await db.execute(sql`delete from categories where id = ${categoryId}`);
  await db.execute(sql`delete from stores where id = ${STORE_ID}`);
  await closePostgres();
}, 120_000);

afterEach(async () => {
  await db.execute(sql`delete from catalog_proposals where submitted_by_oxy_user_id = ${SELLER}`);
  await db.execute(sql`delete from catalog_authoring_drafts where store_id = ${STORE_ID}`);
});

async function insertDraft(): Promise<string> {
  const id = `var-${RUN}-${uuidv7().slice(-8)}`;
  await db.execute(sql`
    insert into catalog_authoring_drafts
      (id, store_id, created_by_oxy_user_id, status, category_id, product_type_definition_id,
       flow, locale, market, schema_hash, version, expires_at)
    values
      (${id}, ${STORE_ID}, ${SELLER}, 'open', ${categoryId}, ${productTypeDefinitionId},
       'merchant', 'en', 'ES', 'etag', 1, now() + interval '1 day')
  `);
  return id;
}

/** One variant the wizard re-sends on every autosave. */
function variant(position: number, axisSignature: string, title: string): NewDraftVariant {
  return {
    position,
    title,
    sku: null,
    barcode: null,
    priceAmount: null,
    priceCurrency: null,
    compareAtPriceAmount: null,
    compareAtPriceCurrency: null,
    inventoryTracked: true,
    inventoryAvailable: 0,
    axisSignature,
    selectedCanonicalVariantId: null,
  };
}

/** A VARIANT-scope answer attached to one variant row. */
function answer(draftVariantId: string, text: string, ordinal = 0): NewDraftValue {
  return {
    draftVariantId,
    fieldId,
    attributeDefinitionId,
    attributeKey: `var_colour_${RUN}`,
    attributeDefinitionVersion: 1,
    scope: 'variant',
    ordinal,
    componentAxis: null,
    kind: 'text',
    valueText: text,
    valueNumber: null,
    valueBoolean: null,
    valueEnumValueId: null,
    canonicalRefKind: null,
    canonicalRefId: null,
    unit: null,
  };
}

/** An OPEN proposal whose reference names this draft and this value row. */
async function attachOpenProposal(draftId: string, draftValueId: string): Promise<void> {
  const proposalId = `var-${RUN}-${uuidv7().slice(-8)}`;
  const label = `Verde ${uuidv7().slice(-6)}`;
  await db.execute(sql`
    insert into catalog_proposals
      (id, type, state, submitted_by_oxy_user_id, proposed_label, source_locale,
       normalized_label, search_label, attribute_definition_id, attribute_definition_version,
       store_id)
    values
      (${proposalId}, 'controlled_value', 'submitted', ${SELLER}, ${label}, 'en',
       ${label.toLowerCase()}, ${label.toLowerCase()}, ${attributeDefinitionId}, 1,
       ${STORE_ID})
  `);
  await db.execute(sql`
    insert into catalog_proposal_references (id, proposal_id, kind, draft_id, draft_value_id)
    values (${`var-${RUN}-${uuidv7().slice(-8)}`}, ${proposalId}, 'authoring_draft_value',
            ${draftId}, ${draftValueId})
  `);
}

/**
 * A draft holding ONE variant carrying ONE answer, with an open proposal
 * attached to that answer — the state every case below starts from.
 */
async function draftWithBlockedVariant(): Promise<{
  draftId: string;
  variantId: string;
  valueId: string;
}> {
  const draftId = await insertDraft();
  const [row] = await replaceDraftVariants(db, draftId, [variant(0, SIG_A, 'Small')]);
  await replaceVariantScopeValues(db, draftId, [row.id], [answer(row.id, 'Graphite')]);
  const values = await listDraftValues(db, draftId);
  expect(values, 'the fixture wrote no variant answer').toHaveLength(1);
  await attachOpenProposal(draftId, values[0].id);
  return { draftId, variantId: row.id, valueId: values[0].id };
}

async function onlyValueId(draftId: string): Promise<string> {
  const values = await listDraftValues(db, draftId);
  expect(values, 'the fixture wrote no draft value').toHaveLength(1);
  return values[0].id;
}

describe('an autosave of VARIANTS keeps the proposal blocking (#771)', () => {
  it('CONTROL: an open proposal blocks the draft BEFORE any variants patch', async () => {
    const { draftId } = await draftWithBlockedVariant();

    // Without this passing, every assertion below is satisfied by a fixture
    // that never wired the gate up at all.
    expect(await listOpenProposalsBlockingDraft(db, draftId)).toHaveLength(1);
  });

  it('still blocks after an autosave re-sends the SAME variant matrix', async () => {
    const { draftId, variantId, valueId } = await draftWithBlockedVariant();
    expect(await listOpenProposalsBlockingDraft(db, draftId), 'control').toHaveLength(1);

    // The autosave: the wizard re-sends the matrix, unchanged.
    const rows = await replaceDraftVariants(db, draftId, [variant(0, SIG_A, 'Small')]);
    await replaceVariantScopeValues(db, draftId, [rows[0].id], [answer(rows[0].id, 'Graphite')]);

    // SOFT — see the header. A hard assertion here throws before the gate
    // assertion below is reached, which is exactly how #770's file looked
    // mutation-proven while its real subject went untested.
    expect.soft(rows[0].id, 'the variant row was re-minted').toBe(variantId);
    expect.soft(await onlyValueId(draftId), 'the answer row was re-minted').toBe(valueId);
    expect(
      await listOpenProposalsBlockingDraft(db, draftId),
      'the gate stopped blocking after a variants autosave',
    ).toHaveLength(1);
  });

  it('still blocks after an autosave that REORDERS the variants', async () => {
    // The two-phase position park, which is the part of this repair that the
    // schema actively fights: `catalog_authoring_draft_variants_position_key` is
    // a plain unique INDEX and Postgres can only defer a CONSTRAINT, so an
    // in-place 0↔1 swap collides mid-update. Without the park this case fails
    // with a 23505 rather than a wrong answer.
    const draftId = await insertDraft();
    const rows = await replaceDraftVariants(db, draftId, [
      variant(0, SIG_A, 'Small'),
      variant(1, SIG_B, 'Large'),
    ]);
    await replaceVariantScopeValues(
      db,
      draftId,
      rows.map((row) => row.id),
      [answer(rows[0].id, 'Graphite'), answer(rows[1].id, 'Charcoal')],
    );
    const before = new Map(rows.map((row) => [row.axisSignature, row.id]));
    const values = await listDraftValues(db, draftId);
    const blocked = values.find((value) => value.draftVariantId === rows[0].id);
    expect(blocked, 'the fixture attached no answer to the first variant').toBeDefined();
    await attachOpenProposal(draftId, blocked === undefined ? '' : blocked.id);
    expect(await listOpenProposalsBlockingDraft(db, draftId), 'control').toHaveLength(1);

    // The author drags Large above Small. Same two variants, swapped positions.
    const reordered = await replaceDraftVariants(db, draftId, [
      variant(0, SIG_B, 'Large'),
      variant(1, SIG_A, 'Small'),
    ]);

    // Identity follows the AXES, not the slot: each signature keeps its row.
    expect.soft(reordered[0].id, 'the reordered variant was re-minted').toBe(before.get(SIG_B));
    expect.soft(reordered[1].id, 'the reordered variant was re-minted').toBe(before.get(SIG_A));
    const positions = (await listDraftVariants(db, draftId)).map((row) => [
      row.axisSignature,
      row.position,
    ]);
    expect.soft(positions, 'the swap did not settle').toEqual([
      [SIG_B, 0],
      [SIG_A, 1],
    ]);
    expect(
      await listOpenProposalsBlockingDraft(db, draftId),
      'the gate stopped blocking after a reorder',
    ).toHaveLength(1);
  });

  it('DOES release the reference when the variant genuinely goes away', async () => {
    // The other direction, and the reason the cascade is left alone: when the
    // answer's variant really is removed the proposal about it is moot. A repair
    // that kept blocking here would have replaced one bug with another.
    const { draftId } = await draftWithBlockedVariant();
    expect(await listOpenProposalsBlockingDraft(db, draftId), 'control').toHaveLength(1);

    await replaceDraftVariants(db, draftId, [variant(0, SIG_B, 'Large')]);

    expect(await listDraftValues(db, draftId), 'the old variant kept its answers').toHaveLength(0);
    expect(await listOpenProposalsBlockingDraft(db, draftId)).toHaveLength(0);
  });

  it('REFUSES a patch sending two variants with the SAME axis set', async () => {
    // Not a pre-existing property being re-asserted. Delete-and-insert got this
    // free from `catalog_authoring_draft_variants_signature_key`, which refused
    // the second INSERT; a reconcile would resolve both to one row and update it
    // twice, keeping whichever arrived last.
    //
    // The draft ALREADY holds the row, which is what makes the case real — see
    // the header. Against an empty draft both duplicates take the INSERT branch
    // and the unique index refuses the second exactly as it always did, so the
    // guard could be deleted and the case would stay green.
    const { draftId, variantId } = await draftWithBlockedVariant();

    await expect(
      replaceDraftVariants(db, draftId, [
        variant(0, SIG_A, 'Small'),
        variant(1, SIG_A, 'Small again'),
      ]),
    ).rejects.toThrow(/same axis set/u);

    // Nothing was applied — a refusal that had already parked or updated a row
    // would be the collapse under another name.
    const rows = await listDraftVariants(db, draftId);
    expect(rows.map((row) => row.id), 'a refused patch was partly applied').toEqual([variantId]);
    expect(rows[0].position, 'a refused patch left a row parked').toBe(0);
    expect(await listOpenProposalsBlockingDraft(db, draftId)).toHaveLength(1);
  });

  it('REFUSES a patch answering one VARIANT slot twice', async () => {
    // #770's guard, one level up, and reachable the same way: the request schema
    // does not dedupe and `ordinal` restarts at 0 per entry.
    //
    // Again the answer must ALREADY exist, or the partial unique refuses the
    // second insert and the guard is untested.
    const { draftId, variantId, valueId } = await draftWithBlockedVariant();

    await expect(
      replaceVariantScopeValues(
        db,
        draftId,
        [variantId],
        [answer(variantId, 'Slate'), answer(variantId, 'Charcoal')],
      ),
    ).rejects.toThrow(/same variant slot twice/u);

    // The stored answer is untouched.
    expect(await onlyValueId(draftId)).toBe(valueId);
    const values = await listDraftValues(db, draftId);
    expect(values[0].valueText, 'a refused patch was partly applied').toBe('Graphite');
  });
});
