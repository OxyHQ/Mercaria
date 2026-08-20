/**
 * An autosave must not destroy the reference a publication gate reads (#729).
 *
 * ## The defect, and why it needed a real server
 *
 * `replaceProductScopeValues` used to DELETE the value rows for every field the
 * client re-sent and re-INSERT them with fresh ids. `catalog_proposal_
 * references.draft_value_id` carries `ON DELETE cascade`, so the reference row
 * went with them — and `listOpenProposalsBlockingDraft` filters on that row's
 * `draft_id`, so **the publication gate stopped blocking**. A draft whose
 * missing concept was still unreviewed became publishable, through the most
 * routine action the wizard performs.
 *
 * Nothing about that is visible to a mocked repository: the cascade is a
 * property of the FK, and the id re-minting is a property of the statement the
 * server actually ran.
 *
 * ## The control comes FIRST, and it is the point
 *
 * A gate that stopped blocking and a fixture that never made it block produce
 * the SAME observation — an empty list. So every case here asserts the gate
 * DOES block **before** the autosave, and the assertion after it is only
 * meaningful because of that. Without the control this file would pass against
 * a fixture that wired up nothing.
 *
 * ## What is asserted, and at which layer
 *
 * ## The mutation this file was measured against
 *
 * Reverting `replaceProductScopeValues` to its delete-and-reinsert form (a
 * `git checkout` of the pre-fix file) turns the two autosave cases RED, on both
 * the re-minted id AND `listOpenProposalsBlockingDraft` returning nothing. The
 * two clearing cases stay green, which is correct: neither depends on the
 * repair. The intermediate assertions are `expect.soft` precisely so the gate
 * assertion is REACHED on that run — with them hard, the mutation failed on the
 * id alone and the gate assertion was never evaluated, which would have left
 * the assertion the issue is about untested while the file looked mutation-proven.
 *
 * `listOpenProposalsBlockingDraft` rather than `validateDraftRow`: it is the
 * gate's SOLE input — the function `draft.service.ts` calls to decide whether an
 * open proposal blocks publication — and it is a DIFFERENT function from the
 * repository under repair, which is what makes the mutation case below a test of
 * the gate rather than of the cascade. Reaching `validateDraftRow` itself would
 * additionally require a fully publishable draft (schema hash, fields, a
 * published product-type version), none of which bears on this defect.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import {
  listDraftValues,
  replaceProductScopeValues,
  type NewDraftValue,
} from '../../../db/catalogAuthoring/draftRepository.js';
import { listOpenProposalsBlockingDraft } from '../../../db/catalogProposals/proposalRepository.js';

let db: Database;

/** Unique to this run: one throwaway database serves every parallel file. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');
const STORE_ID = `auto-${RUN}-store`;
const SELLER = `auto-${RUN}-seller`;

let categoryId = '';
let productTypeDefinitionId = '';
let attributeDefinitionId = '';
let fieldId = '';

beforeAll(async () => {
  db = await connectPostgres();
  await db.execute(sql`
    insert into stores (id, name, handle, description, brand_color)
    values (${STORE_ID}, ${`auto ${RUN}`}, ${`auto-${RUN}`}, '', '#101010')
  `);
  categoryId = `auto-${RUN}-cat`;
  await db.execute(sql`
    insert into categories (id, key, slug, name, lifecycle, selectable)
    values (${categoryId}, ${`auto.${RUN}`}, ${`auto-${RUN}`}, 'Autosave fixture', 'published', true)
  `);
  // DRAFT lifecycle, so the fixture is deletable —
  // `product_type_definitions_immutable_once_published` refuses a DELETE from
  // `published` onward, and nothing here needs a published version.
  productTypeDefinitionId = `auto-${RUN}-ptd`;
  await db.execute(sql`
    insert into product_type_definitions (id, key, version, lifecycle, name)
    values (${productTypeDefinitionId}, ${`auto_${RUN}`}, 1, 'draft', 'Autosave fixture')
  `);
  attributeDefinitionId = `auto-${RUN}-attr`;
  await db.execute(sql`
    insert into attribute_definitions (id, key, version, lifecycle_state, label, value_type)
    values (${attributeDefinitionId}, ${`auto_colour_${RUN}`}, 1, 'draft', 'Colour', 'string')
  `);
  fieldId = `auto-${RUN}-field`;
  await db.execute(sql`
    insert into product_type_fields
      (id, product_type_definition_id, attribute_definition_id, attribute_key,
       attribute_definition_version, scope, flow, requirement, value_policy)
    values
      (${fieldId}, ${productTypeDefinitionId}, ${attributeDefinitionId}, ${`auto_colour_${RUN}`},
       1, 'product', 'merchant', 'optional', 'typed_scalar')
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
  const id = `auto-${RUN}-${uuidv7().slice(-8)}`;
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

/** The answer the wizard re-sends on every autosave. `text` varies it. */
function answer(text: string): NewDraftValue {
  return {
    draftVariantId: null,
    fieldId,
    attributeDefinitionId,
    attributeKey: `auto_colour_${RUN}`,
    attributeDefinitionVersion: 1,
    scope: 'product',
    ordinal: 0,
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
  const proposalId = `auto-${RUN}-${uuidv7().slice(-8)}`;
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
    values (${`auto-${RUN}-${uuidv7().slice(-8)}`}, ${proposalId}, 'authoring_draft_value',
            ${draftId}, ${draftValueId})
  `);
}

async function onlyValueId(draftId: string): Promise<string> {
  const values = await listDraftValues(db, draftId);
  expect(values, 'the fixture wrote no draft value').toHaveLength(1);
  return values[0].id;
}

describe('an autosave that re-sends a field keeps the proposal blocking (#729)', () => {
  it('CONTROL: an open proposal blocks the draft BEFORE any autosave', async () => {
    const draftId = await insertDraft();
    await replaceProductScopeValues(db, draftId, [fieldId], [answer('Graphite')]);
    await attachOpenProposal(draftId, await onlyValueId(draftId));

    // Without this passing, every assertion below is satisfied by a fixture
    // that never wired the gate up at all.
    expect(await listOpenProposalsBlockingDraft(db, draftId)).toHaveLength(1);
  });

  it('still blocks after an autosave re-sends the SAME answer', async () => {
    const draftId = await insertDraft();
    await replaceProductScopeValues(db, draftId, [fieldId], [answer('Graphite')]);
    const before = await onlyValueId(draftId);
    await attachOpenProposal(draftId, before);
    expect(await listOpenProposalsBlockingDraft(db, draftId), 'control').toHaveLength(1);

    // The autosave: the wizard re-sends the field, unchanged.
    await replaceProductScopeValues(db, draftId, [fieldId], [answer('Graphite')]);

    // The row is the SAME row — which is what the schema's own identity rule
    // says it is: one answer per (draft, variant, field, component, ordinal).
    //
    // SOFT, deliberately. A hard assertion here throws before the gate
    // assertion below is ever evaluated, so a mutation run would report the
    // re-minted id and say NOTHING about whether the gate check works — the
    // gate being the thing #729 is actually about. Measured: with both hard,
    // reverting the fix failed only on this line, leaving the assertion that
    // matters unproven. `expect.soft` records and continues, so ONE mutation
    // run exercises both.
    expect.soft(await onlyValueId(draftId), 'the value row was re-minted').toBe(before);
    expect(
      await listOpenProposalsBlockingDraft(db, draftId),
      'the gate stopped blocking after an autosave',
    ).toHaveLength(1);
  });

  it('still blocks after an autosave CHANGES the answer', async () => {
    // The likelier case in practice, and the one a naive "skip identical rows"
    // fix would miss: the answer's TEXT moved, but it is still the same answer
    // slot, so the proposal about that slot is still open.
    const draftId = await insertDraft();
    await replaceProductScopeValues(db, draftId, [fieldId], [answer('Graphite')]);
    const before = await onlyValueId(draftId);
    await attachOpenProposal(draftId, before);
    expect(await listOpenProposalsBlockingDraft(db, draftId), 'control').toHaveLength(1);

    await replaceProductScopeValues(db, draftId, [fieldId], [answer('Charcoal')]);

    // Soft for the same reason as the case above: the gate assertion is the
    // subject, and it must be REACHED on a mutation run to be worth anything.
    expect.soft(await onlyValueId(draftId), 'the value row was re-minted').toBe(before);
    const values = await listDraftValues(db, draftId);
    expect.soft(values[0].valueText, 'the new answer was not written').toBe('Charcoal');
    expect(
      await listOpenProposalsBlockingDraft(db, draftId),
      'the gate stopped blocking after an autosave that changed the answer',
    ).toHaveLength(1);
  });

  it('REFUSES a patch that answers one slot twice, rather than collapsing it', async () => {
    // Not a pre-existing property being re-asserted: the delete-and-insert this
    // replaced got this for free from
    // `catalog_authoring_draft_values_product_key`, which refused the second
    // INSERT. A reconcile keyed on that same tuple would instead update one row
    // twice and keep the last answer — so the repair had to make the refusal
    // deliberate, or it would have shipped a silent collapse.
    //
    // `mapProductScopeValues` restarts `ordinal` at 0 for each entry and the
    // request schema does not dedupe `attributeKey`, so a client sending one
    // field twice reaches exactly this.
    const draftId = await insertDraft();

    await expect(
      replaceProductScopeValues(db, draftId, [fieldId], [answer('Graphite'), answer('Charcoal')]),
    ).rejects.toThrow(/same slot twice/u);

    // Nothing was written: a refusal that had already stored one of them would
    // be the collapse under another name.
    expect(await listDraftValues(db, draftId)).toHaveLength(0);
  });

  it('DOES release the reference when the answer genuinely goes away', async () => {
    // The cascade is not the bug and is deliberately intact. An answer that is
    // withdrawn takes its proposal's reference with it, because the proposal was
    // about an answer that no longer exists — and a fix that kept the reference
    // alive here would be blocking publication on a question nobody is asking.
    const draftId = await insertDraft();
    await replaceProductScopeValues(db, draftId, [fieldId], [answer('Graphite')]);
    await attachOpenProposal(draftId, await onlyValueId(draftId));
    expect(await listOpenProposalsBlockingDraft(db, draftId), 'control').toHaveLength(1);

    // The field is re-sent with NO answer: the user cleared it.
    await replaceProductScopeValues(db, draftId, [fieldId], []);

    expect(await listDraftValues(db, draftId)).toHaveLength(0);
    expect(await listOpenProposalsBlockingDraft(db, draftId)).toHaveLength(0);
  });
});
