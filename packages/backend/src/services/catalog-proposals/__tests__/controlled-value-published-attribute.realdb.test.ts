/**
 * Approving a controlled value against a PUBLISHED attribute (#568).
 *
 * `mercaria_attribute_enum_frozen` raises `restrict_violation` for any parent
 * whose `lifecycle_state <> 'draft'`, and `scripts/seed-verticals/apply.ts`
 * publishes every attribute it drafts — so in a seeded deployment every attribute
 * a merchant can see is `active`, and the approval of the only mintable proposal
 * type raised on every request that mattered.
 *
 * ## Why this is a SEPARATE file with its own database
 *
 * `catalog-proposals.realdb.test.ts` runs on the SHARED test database, and its
 * attribute fixture is `draft` for a stated teardown reason:
 * `mercaria_attribute_definition_immutable` refuses to DELETE a definition that
 * has left `draft`, so an `active` fixture is one that file could create and never
 * clean up. That is the fixture choice #568 identifies — it selected the one
 * lifecycle state in which the write works, and the production state went
 * untested in either direction.
 *
 * Cleaning up here would need three trigger-toggle windows (values, aliases,
 * then the definition), each a database-wide `disable trigger` on a server every
 * parallel file shares. A private throwaway database removes the whole class:
 * nothing here is scoped against a sibling, nothing toggles a trigger, and the
 * teardown is dropping the database. The five files already doing this are the
 * precedent, and `docker-compose.postgres.yml` sizes the lock table for it.
 *
 * The DRAFT path is deliberately NOT moved here. It stays pinned where it is, on
 * the shared database, exactly as it was.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@oxyhq/db';
import type postgres from 'postgres';
import * as schema from '../../../db/schema/index.js';
import type { Database } from '../../../db/postgres.js';
import {
  createMercariaTestDatabase,
  dropMercariaTestDatabase,
} from '../../../db/testDatabase.js';
import { listEnumValueVersions } from '../../../db/attributes/definitionRepository.js';
import { submitProposal, type SubmitProposalInput } from '../proposal.service.js';
import { approveProposal } from '../review.service.js';

/** Server to create the throwaway on — the same variable `globalSetup` reads. */
const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';

const P = 'cv568';
const STORE = `${P}-store`;
const MERCHANT = `${P}-merchant`;
const OPERATOR = `${P}-operator`;

/** The PUBLISHED attribute, which is what every case here is about. */
const LIVE_ATTR = `${P}-attr-live`;
const LIVE_KEY = 'cv568_live_colour';
/** A second, never-published attribute — the control for "the draft path". */
const DRAFT_ATTR = `${P}-attr-draft`;
const DRAFT_KEY = 'cv568_draft_colour';

let databaseUrl: string;
let client: postgres.Sql;
let db: Database;

beforeAll(async () => {
  databaseUrl = await createMercariaTestDatabase(ADMIN_URL);
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: { max: 4, onnotice: () => undefined },
  });
  client = instance.client;
  db = instance.db;

  await db.execute(sql`
    insert into stores (id, name, handle, description, brand_color)
    values (${STORE}, 'Published attribute probe', ${`${P}-handle`}, '', '#000000')
  `);

  // Drafted, filled, THEN published — which is the only order the server
  // permits, and the fixture proving the bug is real before a line of it is
  // asserted: `mercaria_attribute_enum_frozen` refuses to insert a value under an
  // already-active parent, so an `active`-from-the-start fixture cannot be built
  // at all. `published_at` moves with the state because
  // `(lifecycle_state = 'draft') = (published_at is null)` is a CHECK.
  await db.execute(sql`
    insert into attribute_definitions
      (id, key, version, lifecycle_state, label, value_type, cardinality, objectivity)
    values (${LIVE_ATTR}, ${LIVE_KEY}, 1, 'draft', 'Colour', 'enum', 'single', 'objective')
  `);
  await db.execute(sql`
    insert into attribute_enum_values (id, attribute_definition_id, value, label, position)
    values (${`${P}-live-black`}, ${LIVE_ATTR}, 'black', 'Black', 0),
           (${`${P}-live-white`}, ${LIVE_ATTR}, 'white', 'White', 1)
  `);
  await db.execute(sql`
    update attribute_definitions set lifecycle_state = 'active', published_at = now()
    where id = ${LIVE_ATTR}
  `);

  await db.execute(sql`
    insert into attribute_definitions
      (id, key, version, lifecycle_state, label, value_type, cardinality, objectivity)
    values (${DRAFT_ATTR}, ${DRAFT_KEY}, 1, 'draft', 'Draft colour', 'enum', 'single', 'objective')
  `);
}, 300_000);

afterAll(async () => {
  await client.end({ timeout: 5 });
  await dropMercariaTestDatabase(databaseUrl);
});

function submission(label: string, attributeDefinitionId: string): SubmitProposalInput {
  return {
    type: 'controlled_value',
    storeId: STORE,
    submittedByOxyUserId: MERCHANT,
    proposedLabel: label,
    sourceLocale: 'en',
    proposedDescription: null,
    submitterNote: null,
    categoryId: null,
    productTypeDefinitionId: null,
    attributeDefinitionId,
    attributeDefinitionVersion: 1,
    draftId: null,
    draftValueId: null,
  };
}

/** Every version of a key, oldest first, with what a reader needs to judge it. */
async function versionsOf(key: string): Promise<
  { id: string; version: number; state: string; values: string[] }[]
> {
  const rows = await db.execute<{ id: string; version: number; state: string }>(sql`
    select id, version::int as version, lifecycle_state as state
    from attribute_definitions where key = ${key} order by version asc
  `);
  const out: { id: string; version: number; state: string; values: string[] }[] = [];
  for (const row of rows) {
    const values = await db.execute<{ value: string }>(sql`
      select value from attribute_enum_values
      where attribute_definition_id = ${row.id} order by position asc, value asc
    `);
    out.push({ ...row, values: values.map((entry) => entry.value) });
  }
  return out;
}

describe('a controlled value approved against a PUBLISHED attribute', () => {
  it('lands in a NEW draft version that carries the vocabulary forward, and publishes nothing', async () => {
    const proposal = await submitProposal(db, submission('Rojo Fuego', LIVE_ATTR));
    const approved = await approveProposal(
      db,
      { proposalId: proposal.proposal.id, operatorOxyUserId: OPERATOR },
      { key: 'rojo_fuego', reason: 'a real colour', recordSubmittedSpellingAsAlias: true },
    );

    expect.soft(approved.state).toBe('approved');
    expect.soft(approved.resolvedEntityId).not.toBeNull();

    const versions = await versionsOf(LIVE_KEY);
    expect.soft(versions.map((entry) => entry.version)).toEqual([1, 2]);

    // v1 is UNTOUCHED. This is the half a "make the trigger allow it" fix would
    // have broken, and it is why the remedy is a new version at all.
    expect.soft(versions[0]?.state).toBe('active');
    expect.soft(versions[0]?.values).toEqual(['black', 'white']);

    // v2 is a DRAFT carrying everything v1 had, plus the approved value appended.
    expect.soft(versions[1]?.state).toBe('draft');
    expect(versions[1]?.values, 'the new version lost or reordered the vocabulary').toEqual([
      'black',
      'white',
      'rojo_fuego',
    ]);

    // `resolvedEntityId` names the VALUE and the value lives in v2 — the id
    // `catalog_authoring_draft_values.value_enum_value_id` points at, unchanged in
    // meaning from the draft path.
    const minted = await db.execute<{ parent: string; label: string }>(sql`
      select attribute_definition_id as parent, label from attribute_enum_values
      where id = ${approved.resolvedEntityId ?? ''}
    `);
    expect.soft(minted[0]?.label, 'the submitter’s words are the LABEL').toBe('Rojo Fuego');
    expect(minted[0]?.parent, 'the value did not land in the new version').toBe(versions[1]?.id);

    // The submitter's verbatim spelling travelled with it.
    const aliases = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from attribute_value_aliases
      where enum_value_id = ${approved.resolvedEntityId ?? ''}
    `);
    expect.soft(aliases[0]?.total).toBe(1);

    // NOTHING was published, and the projection says so rather than leaving
    // `approved` to read as done.
    expect.soft(approved.publication.state).toBe('pending_publication');
    expect(
      approved.publication.state === 'pending_publication'
        ? { id: approved.publication.versionId, number: approved.publication.versionNumber }
        : null,
      'the publication does not name the version the value is waiting in',
    ).toEqual({ id: versions[1]?.id, number: 2 });
  });

  it('does NOT bump the authoring schema revision for a value nobody can use yet', async () => {
    // The counterpart of the draft path's bump, which stays exactly as it was.
    // An authoring schema is composed from the version
    // `product_type_fields.attribute_definition_id` cites; the value is in a
    // version no field cites, and the ACTIVE version compositions DO cite is
    // unchanged — so there is nothing to invalidate and a bump would assert a
    // liveness the value has not got.
    const bumps = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from catalog_authoring_schema_invalidations
      where subject = 'attribute_values'
        and subject_id in (
          select id from attribute_definitions where key = ${LIVE_KEY}
        )
    `);
    expect(bumps[0]?.total, 'a draft version was announced as a live schema change').toBe(0);
  });

  it('accumulates a SECOND approval into the same draft version, losing neither', async () => {
    // The failure this case exists for: drafting from the ACTIVE version every
    // time gives v2 carrying the first value and v3 carrying only the second,
    // because both were built from v1 — and publishing v3 silently discards an
    // approval somebody made. Nothing in the database would refuse it; there is
    // no partial unique forbidding two drafts of one key.
    const before = await versionsOf(LIVE_KEY);
    expect.soft(before.map((entry) => entry.version)).toEqual([1, 2]);

    const proposal = await submitProposal(db, submission('Verde Lima', LIVE_ATTR));
    const approved = await approveProposal(
      db,
      { proposalId: proposal.proposal.id, operatorOxyUserId: OPERATOR },
      { key: 'verde_lima', reason: 'also a real colour' },
    );
    expect.soft(approved.state).toBe('approved');

    const after = await versionsOf(LIVE_KEY);
    expect
      .soft(after.map((entry) => entry.version), 'a rival draft version was minted')
      .toEqual([1, 2]);
    expect(after[1]?.values, 'the second approval did not join the first').toEqual([
      'black',
      'white',
      'rojo_fuego',
      'verde_lima',
    ]);
    expect.soft(after[0]?.values, 'the published version was touched').toEqual(['black', 'white']);
  });

  it('refuses a value the published vocabulary already has, and says to merge instead', async () => {
    const proposal = await submitProposal(db, submission('Negro', LIVE_ATTR));
    await expect(
      approveProposal(
        db,
        { proposalId: proposal.proposal.id, operatorOxyUserId: OPERATOR },
        { key: 'black', reason: 'already there' },
      ),
    ).rejects.toThrow(/already a value/i);
  });

  it('reports `published` once the version is activated, from the version and not the decision', async () => {
    const versions = await versionsOf(LIVE_KEY);
    const draftVersion = versions[1];
    if (draftVersion === undefined) throw new Error('the drafted version is missing');

    // Publish by hand rather than through `publishAttributeDefinition`, which
    // opens its own connection against `getDb()` — a different database from this
    // file's. What is under test is the PROJECTION reading a lifecycle, not the
    // registry's publication ritual, which has its own suite.
    await db.execute(sql`
      update attribute_definitions set lifecycle_state = 'deprecated', deprecated_at = now()
      where id = ${versions[0]?.id ?? ''}
    `);
    await db.execute(sql`
      update attribute_definitions
      set lifecycle_state = 'active', published_at = now(), published_by_oxy_user_id = ${OPERATOR}
      where id = ${draftVersion.id}
    `);

    const rows = await db.execute<{ id: string }>(sql`
      select id from catalog_proposals
      where attribute_definition_id = ${LIVE_ATTR} and state = 'approved'
      order by created_at asc limit 1
    `);
    const proposalId = rows[0]?.id;
    expect.soft(proposalId, 'no approved proposal to re-read').toBeTruthy();

    // Re-read through the same repository the projection uses. Nothing was
    // written to `catalog_proposals` by the publication, which is the point: the
    // answer moved because the VERSION moved.
    const values = await db.execute<{ id: string }>(sql`
      select resolved_entity_id as id from catalog_proposals where id = ${proposalId ?? ''}
    `);
    const versionsForValue = await listEnumValueVersions(db, [values[0]?.id ?? '']);
    expect.soft(versionsForValue).toHaveLength(1);
    expect(versionsForValue[0]?.lifecycleState, 'the value did not become live with its version').toBe(
      'active',
    );
    expect.soft(versionsForValue[0]?.version).toBe(2);
  });
});

describe('the seam refuses what it cannot honestly do', () => {
  it('refuses when every version of the key is out of service', async () => {
    // A key whose only version is `deprecated`: there is nothing to carry
    // forward, and reviving one is a registry decision rather than a consequence
    // of approving a value.
    const goneAttr = `${P}-attr-gone`;
    await db.execute(sql`
      insert into attribute_definitions
        (id, key, version, lifecycle_state, label, value_type, cardinality, objectivity)
      values (${goneAttr}, ${'cv568_gone_colour'}, 1, 'draft', 'Gone', 'enum', 'single', 'objective')
    `);
    await db.execute(sql`
      update attribute_definitions
      set lifecycle_state = 'deprecated', published_at = now(), deprecated_at = now()
      where id = ${goneAttr}
    `);
    const proposal = await submitProposal(db, submission('Fantasma', goneAttr));
    await expect(
      approveProposal(
        db,
        { proposalId: proposal.proposal.id, operatorOxyUserId: OPERATOR },
        { key: 'fantasma', reason: 'nowhere to put it' },
      ),
    ).rejects.toThrow(/no active version to extend/i);
  });
});

describe('the DRAFT path is unchanged', () => {
  it('inserts into the SAME definition, mints no version, and DOES bump the schema revision', async () => {
    // The pre-#568 behaviour, pinned here as well as on the shared database —
    // this file's whole subject is the branch beside it, and a change that
    // quietly unified the two would pass every assertion above.
    const proposal = await submitProposal(db, submission('Gris Perla', DRAFT_ATTR));
    const approved = await approveProposal(
      db,
      { proposalId: proposal.proposal.id, operatorOxyUserId: OPERATOR },
      { key: 'gris_perla', reason: 'into the draft' },
    );

    const versions = await versionsOf(DRAFT_KEY);
    expect.soft(versions.map((entry) => entry.version), 'the draft path drafted a version').toEqual([
      1,
    ]);
    expect.soft(versions[0]?.state).toBe('draft');
    expect.soft(versions[0]?.values).toEqual(['gris_perla']);

    const minted = await db.execute<{ parent: string }>(sql`
      select attribute_definition_id as parent from attribute_enum_values
      where id = ${approved.resolvedEntityId ?? ''}
    `);
    expect(minted[0]?.parent, 'the value left the definition the proposal named').toBe(DRAFT_ATTR);

    const bumps = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from catalog_authoring_schema_invalidations
      where subject = 'attribute_values' and subject_id = ${DRAFT_ATTR}
    `);
    expect(bumps[0]?.total, 'the draft path stopped announcing its change').toBeGreaterThanOrEqual(
      1,
    );

    // A value in a draft version is not live either, and the projection says the
    // same thing it says on the other branch — the state comes from the VERSION,
    // so the two paths cannot report differently about the same fact.
    expect(approved.publication.state).toBe('pending_publication');
  });
});
