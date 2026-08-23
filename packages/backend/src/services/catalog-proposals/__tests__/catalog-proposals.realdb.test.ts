/**
 * Catalog proposals against a REAL PostgreSQL server (#367 step 6,
 * ADR 0007 D9).
 *
 * ## Why this file exists at all
 *
 * Everything it asserts is a property a mocked repository cannot have. The
 * convergence that makes two merchants asking for one colour a single request is
 * a PARTIAL UNIQUE over a STORED GENERATED column; the backfill's idempotency is
 * a compare-and-swap whose empty result set IS the answer; "nobody approves their
 * own request" is a CHECK; and "a decided proposal is not re-decided" is a
 * trigger. A mocked `insert` accepts every one of those statements and would
 * report the domain working while it enforced nothing.
 *
 * `catalog-proposal-schema.test.ts` covers the DECLARATION — what drizzle-kit
 * will emit and what the staging SQL carries — and this covers whether the
 * server agrees.
 *
 * ## The readiness guard, and why it is a TOP-LEVEL await
 *
 * `skipIf` is evaluated when vitest COLLECTS the file, so a flag set in
 * `beforeAll` would still be `false` at collection and every case would skip
 * FOREVER, with a green report. It is a presence QUERY rather than a try/catch
 * around a real statement, because a caught error cannot tell "the table is
 * missing" from "the CHECK I am testing rejected my row", and the second must
 * never become a skip.
 *
 * `0100_same_iron_man` created these four tables and their five triggers, so
 * every case below RUNS. The guard is kept rather than deleted: this file is the
 * first thing that goes red on a database the migration has not reached — a
 * partially migrated throwaway, a `--phase=pre` run, a branch that dropped the
 * file on a rebase — and a missing-relation error there is indistinguishable
 * from a broken CHECK until somebody reads the stack.
 *
 * ## The shared-database rules this file follows
 *
 * The test database is shared across parallel files, so every fixture id carries
 * this file's own prefix, every assertion is scoped to those ids, and the
 * teardown deletes children before parents. Nothing here widens a global bound
 * and nothing takes the global active-matching-policy slot — this domain runs no
 * matcher.
 *
 * `catalog_review_events` is append-only against DELETE, so the teardown opens
 * the one trigger-toggle window this file has — through `withTriggerToggleLock`,
 * over ONE table, re-enabled inside the same window. `advisory-lock-census.test.ts`
 * fails the build on any other spelling, and it caught this file's first
 * attempt: on the POOL that DDL autocommits, so a bare `db.transaction` leaves
 * the trigger off database-wide after a throw and every later file asserting it
 * refuses a write passes VACUOUSLY.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@oxyhq/db';
import type postgres from 'postgres';
import * as schema from '../../../db/schema/index.js';
import { connectPostgres, type Database } from '../../../db/postgres.js';
import { withTriggerToggleLock } from '../../../db/__tests__/trigger-toggle-lock.js';
import { catalogReviewEvents } from '../../../db/schema/catalogProposals.js';
import {
  findOpenProposalByConvergenceKey,
  listDuplicateCandidates,
  listProposalReferences,
  listReviewEvents,
} from '../../../db/catalogProposals/proposalRepository.js';
import { config } from '../../../config/index.js';
import {
  proposalConvergenceKey,
  submitProposal,
  withdrawProposal,
} from '../proposal.service.js';
import { approveProposal, redirectProposal, rejectProposal } from '../review.service.js';
import { runProposalBackfill } from '../backfill.service.js';

/** Everything this file owns. One prefix, so the teardown is one predicate. */
const P = 'catprop-rdb';

const db: Database = await connectPostgres();
const presence = await db.execute<{ present: number }>(sql`
  select count(*)::int as present
  from information_schema.tables
  where table_schema = 'public'
    and table_name in (
      'catalog_proposals',
      'catalog_proposal_duplicate_candidates',
      'catalog_proposal_references',
      'catalog_review_events'
    )
`);
const ready = (presence[0]?.present ?? 0) === 4;

const MERCHANT = `${P}-merchant`;
const OPERATOR = `${P}-operator`;
const SECOND_MERCHANT = `${P}-merchant-2`;

beforeAll(async () => {
  if (!ready) return;
  await db.execute(sql`
    insert into stores (id, name, handle, description, brand_color)
    values (${`${P}-store`}, 'Proposal probe', ${`${P}-store-handle`}, '', '#000000')
    on conflict (id) do nothing
  `);
  await db.execute(sql`
    insert into categories (id, key, name, slug, lifecycle, selectable)
    values (${`${P}-cat`}, ${'catprop_rdb.primary'}, 'Probe', ${`${P}-cat-slug`}, 'published', true)
    on conflict (id) do nothing
  `);
  // `draft`, for the teardown reason `catalog-authoring.realdb.test.ts` records:
  // `mercaria_attribute_definition_immutable` refuses to DELETE a definition that
  // has left `draft`, so an `active` fixture is one this file could create and
  // never clean up on a shared database.
  await db.execute(sql`
    insert into attribute_definitions
      (id, key, version, lifecycle_state, label, value_type, cardinality, objectivity)
    values (${`${P}-attr`}, ${'catprop_rdb_colour'}, 1, 'draft', 'Colour', 'enum', 'single', 'objective')
    on conflict (id) do nothing
  `);
  await db.execute(sql`
    insert into attribute_enum_values (id, attribute_definition_id, value, label, position)
    values (${`${P}-enum-black`}, ${`${P}-attr`}, 'black', 'Black', 0)
    on conflict (id) do nothing
  `);
  await db.execute(sql`
    insert into product_type_definitions (id, key, version, lifecycle, name, pending_proposal_policy)
    values (${`${P}-ptd`}, ${'catprop_rdb_type'}, 1, 'draft', 'Probe type', 'block_publication')
    on conflict (id) do nothing
  `);
  await db.execute(sql`
    insert into product_type_fields
      (id, product_type_definition_id, attribute_definition_id, attribute_key,
       attribute_definition_version, scope, flow, requirement, value_policy, variant_capable, position)
    values (${`${P}-field`}, ${`${P}-ptd`}, ${`${P}-attr`}, ${'catprop_rdb_colour'},
            1, 'product', 'merchant', 'optional', 'proposal_enabled', false, 0)
    on conflict (id) do nothing
  `);
  await db.execute(sql`
    insert into catalog_authoring_drafts
      (id, store_id, created_by_oxy_user_id, status, category_id, product_type_definition_id,
       flow, locale, market, schema_hash, version, expires_at)
    values (${`${P}-draft`}, ${`${P}-store`}, ${MERCHANT}, 'open', ${`${P}-cat`}, ${`${P}-ptd`},
            'merchant', 'en', 'ES', 'h', 1, now() + interval '1 day')
    on conflict (id) do nothing
  `);
  await db.execute(sql`
    insert into catalog_authoring_draft_values
      (id, draft_id, field_id, attribute_definition_id, attribute_key,
       attribute_definition_version, scope, ordinal, kind, value_text)
    values (${`${P}-value`}, ${`${P}-draft`}, ${`${P}-field`}, ${`${P}-attr`}, ${'catprop_rdb_colour'},
            1, 'product', 0, 'text', 'Verde Bosque')
    on conflict (id) do nothing
  `);
});

afterAll(async () => {
  if (!ready) return;
  // `catalog_review_events` refuses DELETE by trigger, which is the property
  // under test — and `catalog_review_events.proposal_id` is `restrict`, so the
  // rows have to go before their proposals do. The window is therefore real and
  // not avoidable by narrowing: the trigger's events are `UPDATE OR DELETE`, so
  // a delete genuinely needs it off.
  //
  // `withTriggerToggleLock` and not a bare `db.transaction`: on the POOL that DDL
  // AUTOCOMMITS, so a throw between the disable and the enable leaves the trigger
  // off database-wide for the rest of the run, and every later file asserting it
  // refuses a write passes VACUOUSLY. `advisory-lock-census.test.ts` fails the
  // build on the bare spelling — measured here on this file's first run.
  //
  // ONE table, one trigger, both statements on `tx`, re-enabled in the same
  // window.
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(
      sql`alter table catalog_review_events disable trigger mercaria_catalog_review_event_append_only`,
    );
    await tx.execute(
      sql`delete from catalog_review_events where proposal_id in (select id from catalog_proposals where submitted_by_oxy_user_id like ${`${P}%`})`,
    );
    await tx.execute(
      sql`alter table catalog_review_events enable trigger mercaria_catalog_review_event_append_only`,
    );
  });
  await db.execute(
    sql`delete from catalog_proposal_references where proposal_id in (select id from catalog_proposals where submitted_by_oxy_user_id like ${`${P}%`})`,
  );
  await db.execute(
    sql`delete from catalog_proposal_duplicate_candidates where proposal_id in (select id from catalog_proposals where submitted_by_oxy_user_id like ${`${P}%`})`,
  );
  // TWO passes over one table, because `redirected_to_proposal_id` is a
  // `restrict` self-FK: the REDIRECTED row points at its successor, so it has to
  // go first or the successor's delete is refused.
  //
  // Clearing the pointer instead does NOT work and the failure is the schema
  // behaving correctly — measured on this file's first run. Moving the row out of
  // `redirected` is refused by `mercaria_catalog_proposal_state` (a decided
  // proposal is not re-decided), and leaving the state while nulling the pointer
  // is refused by `catalog_proposals_redirect_check`. Deleting in dependency
  // order is the only way out, which is what the two `restrict`s are for.
  await db.execute(
    sql`delete from catalog_proposals where submitted_by_oxy_user_id like ${`${P}%`} and redirected_to_proposal_id is not null`,
  );
  await db.execute(sql`delete from catalog_proposals where submitted_by_oxy_user_id like ${`${P}%`}`);
  await db.execute(sql`delete from catalog_authoring_draft_values where draft_id like ${`${P}%`}`);
  await db.execute(sql`delete from catalog_authoring_drafts where id like ${`${P}%`}`);
  await db.execute(sql`delete from catalog_authoring_schema_invalidations where subject_id like ${`${P}%`}`);
  await db.execute(sql`delete from attribute_value_aliases where attribute_definition_id like ${`${P}%`}`);
  await db.execute(sql`delete from attribute_enum_values where attribute_definition_id like ${`${P}%`}`);
  await db.execute(sql`delete from product_type_fields where id like ${`${P}%`}`);
  await db.execute(sql`delete from product_type_definitions where id like ${`${P}%`}`);
  await db.execute(sql`delete from attribute_definitions where id like ${`${P}%`}`);
  await db.execute(sql`delete from categories where id like ${`${P}%`}`);
  await db.execute(sql`delete from stores where id like ${`${P}%`}`);
});

/** A `controlled_value` submission against the probe attribute. */
function submission(label: string, actor: string, withDraft: boolean) {
  return {
    type: 'controlled_value' as const,
    storeId: `${P}-store`,
    submittedByOxyUserId: actor,
    proposedLabel: label,
    sourceLocale: 'en',
    proposedDescription: null,
    submitterNote: null,
    categoryId: `${P}-cat`,
    productTypeDefinitionId: `${P}-ptd`,
    attributeDefinitionId: `${P}-attr`,
    attributeDefinitionVersion: 1,
    draftId: withDraft ? `${P}-draft` : null,
    draftValueId: withDraft ? `${P}-value` : null,
  };
}

describe.skipIf(!ready)('submission, convergence and the scan evidence', () => {
  it('stores the proposal, its scan counters and TWO review events', async () => {
    const result = await submitProposal(db, submission('Verde Bosque', MERCHANT, true));
    expect(result.outcome).toBe('created');
    expect(result.proposal.state).toBe('submitted');
    expect(result.proposal.normalizedLabel).toBe('verde bosque');
    // The POSITIVE CONTROL on the scan: the attribute carries one enum value, so
    // a population of zero would mean the detector examined nothing — which is
    // the failure the counter exists to expose, and which an empty candidate list
    // alone cannot distinguish.
    expect(result.proposal.duplicateScanPopulation).toBeGreaterThan(0);

    const events = await listReviewEvents(db, result.proposal.id);
    // ORDERED, and it is a fact rather than a rendering choice: the scan event
    // carries `fromState: 'submitted'`, which presupposes the submission (#775).
    expect(events.map((event) => event.action)).toEqual(['submitted', 'duplicate_scan_recorded']);
    // The scan event carries the numbers, so "it says it found nothing" is
    // checkable against what it looked at.
    expect(events[1]?.reason).toContain('examined');

    // Both events are written from ONE `now` in one transaction, so `at` cannot
    // separate them — asserted rather than assumed, because if the two ever got
    // distinct instants this case would pass for a reason that has nothing to do
    // with the fix and the ordering could rot underneath it.
    expect(events[0]?.at.getTime()).toBe(events[1]?.at.getTime());
    // And the sequence is what does the separating.
    expect(events.map((event) => event.sequence)).toEqual([
      events[0]?.sequence,
      (events[0]?.sequence ?? 0) + 1,
    ]);
  });

  /**
   * The ordering is carried by `sequence` and NOT by the id — deterministically,
   * which the case above cannot show.
   *
   * That one passes whenever the uuid v7 tiebreak happens to agree with the
   * write order, which is most of the time; before #775 it was green four runs
   * out of four in isolation and red once under load. So it cannot tell a fixed
   * reader from a lucky one.
   *
   * Here the ids are CHOSEN to disagree: `zz-…-b` is written first and `zz-…-a`
   * second, so `asc(id)` returns them reversed and only `asc(sequence)` returns
   * them as written. Removing that term from `listReviewEvents` reds this case
   * every time rather than one run in twelve.
   */
  it('orders two events written in one millisecond by SEQUENCE, not by id', async () => {
    const result = await submitProposal(db, submission('Azul Profundo', MERCHANT, true));
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') return;
    const proposalId = result.proposal.id;
    const at = new Date();

    /**
     * Inserted through drizzle rather than `insertReviewEvent`, deliberately:
     * the subject here is the READER's ordering, and the repository writer mints
     * its own id, so it cannot construct the disagreement this case needs. The
     * ids come from this file's own `P` prefix, so the existing teardown covers
     * them.
     */
    const rows = [
      { suffix: 'b', reason: 'written first, sorts second by id' },
      { suffix: 'a', reason: 'written second, sorts first by id' },
    ];
    const written: { id: string; sequence: number | null }[] = [];
    for (const row of rows) {
      const [inserted] = await db
        .insert(catalogReviewEvents)
        .values({
          id: `${P}-775-${row.suffix}`,
          proposalId,
          action: 'information_requested',
          actorKind: 'system',
          actorOxyUserId: null,
          fromState: 'submitted',
          toState: 'submitted',
          reason: row.reason,
          at,
        })
        .returning({ id: catalogReviewEvents.id, sequence: catalogReviewEvents.sequence });
      written.push(inserted);
    }
    const [first, second] = written;

    // The premise, measured rather than trusted: the ids really do disagree with
    // the write order, and the sequence really was assigned. Without both, this
    // case is adverse to nothing and would pass against the unfixed reader.
    expect((first?.id ?? '') > (second?.id ?? '')).toBe(true);
    expect(Number(second?.sequence)).toBeGreaterThan(Number(first?.sequence));

    const events = await listReviewEvents(db, proposalId);
    const mine = events.filter((event) => event.id.startsWith(`${P}-775-`));
    expect(mine.map((event) => event.reason)).toEqual([
      'written first, sorts second by id',
      'written second, sorts first by id',
    ]);
  });

  it('the service’s convergence key equals the STORED GENERATED column', async () => {
    // Two spellings of one key: a service key that drifted from the column's
    // would make the pre-submission check answer a different question from the
    // constraint, silently, in the direction where the constraint refuses a
    // submission the scan said was fine.
    const rows = await db.execute<{ id: string; convergence_key: string }>(sql`
      select id, convergence_key from catalog_proposals
      where submitted_by_oxy_user_id = ${MERCHANT} and normalized_label = 'verde bosque'
      limit 1
    `);
    const stored = rows[0];
    expect(stored).toBeDefined();
    expect(stored?.convergence_key).toBe(
      proposalConvergenceKey({
        type: 'controlled_value',
        attributeDefinitionId: `${P}-attr`,
        categoryId: `${P}-cat`,
        productTypeDefinitionId: `${P}-ptd`,
        normalizedLabel: 'verde bosque',
      }),
    );
  });

  it('a SECOND merchant asking for the same concept CONVERGES rather than duplicating', async () => {
    const first = await findOpenProposalByConvergenceKey(
      db,
      proposalConvergenceKey({
        type: 'controlled_value',
        attributeDefinitionId: `${P}-attr`,
        categoryId: `${P}-cat`,
        productTypeDefinitionId: `${P}-ptd`,
        normalizedLabel: 'verde bosque',
      }),
    );
    expect(first).not.toBeNull();

    // A different SPELLING that normalizes to the same thing — which is what
    // makes convergence worth having rather than a string equality.
    const second = await submitProposal(db, submission('  verde   bosque ', SECOND_MERCHANT, false));
    expect(second.outcome).toBe('converged');
    expect(second.proposal.id).toBe(first?.id);

    const count = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from catalog_proposals
      where convergence_key = ${first?.convergenceKey ?? ''}
        and state in ('submitted', 'needs_information', 'deferred')
    `);
    expect(count[0]?.total).toBe(1);
  });

  it('REFUSES a submission for a controlled value that already exists', async () => {
    // `black` is an `attribute_enum_values` row in the fixtures. The remedy is to
    // use it, and the refusal names it.
    await expect(submitProposal(db, submission('Black', MERCHANT, false))).rejects.toThrow(
      /already exists in the catalogue/i,
    );
  });

  it('REFUSES a label with no letters or digits', async () => {
    await expect(submitProposal(db, submission('— *** —', MERCHANT, false))).rejects.toThrow(
      /no letters or digits/i,
    );
  });
});

describe.skipIf(!ready)('the operator decision', () => {
  it('REFUSES an approval by the account that submitted it', async () => {
    const proposal = await submitProposal(db, submission('Azul Marino', MERCHANT, false));
    await expect(
      approveProposal(
        db,
        { proposalId: proposal.proposal.id, operatorOxyUserId: MERCHANT },
        { key: 'azul_marino', reason: 'mine' },
      ),
    ).rejects.toThrow(/other than the account that submitted/i);
  });

  it('MINTS the controlled value, records an alias and bumps the schema revision', async () => {
    const proposal = await submitProposal(db, submission('Rojo Fuego', MERCHANT, false));
    const approved = await approveProposal(
      db,
      { proposalId: proposal.proposal.id, operatorOxyUserId: OPERATOR },
      { key: 'rojo_fuego', reason: 'a real colour', recordSubmittedSpellingAsAlias: true },
    );
    expect(approved.state).toBe('approved');
    expect(approved.resolvedEntityId).not.toBeNull();

    const minted = await db.execute<{ value: string; label: string }>(sql`
      select value, label from attribute_enum_values where id = ${approved.resolvedEntityId ?? ''}
    `);
    // The KEY is the operator's and the LABEL is the submitter's words — the
    // whole of ADR 0007 D1 in one row.
    expect(minted[0]?.value).toBe('rojo_fuego');
    expect(minted[0]?.label).toBe('Rojo Fuego');

    const alias = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from attribute_value_aliases
      where enum_value_id = ${approved.resolvedEntityId ?? ''}
    `);
    expect(alias[0]?.total).toBe(1);

    // The controlled-value set is one of the four subjects an authoring schema
    // memoizes on, so the revision must move IN the approval's transaction — an
    // outbox would leave every task serving a form without the value an operator
    // just approved.
    const revision = await db.execute<{ revision: number }>(sql`
      select revision::int as revision from catalog_authoring_schema_invalidations
      where subject = 'attribute_values' and subject_id = ${`${P}-attr`}
    `);
    expect(revision[0]?.revision).toBeGreaterThanOrEqual(1);
  });

  it('REFUSES to mint anything but a controlled value, and names the owning surface', async () => {
    const proposal = await submitProposal(db, {
      ...submission('Acme Tools', MERCHANT, false),
      type: 'brand',
      attributeDefinitionId: null,
      attributeDefinitionVersion: null,
    });
    await expect(
      approveProposal(
        db,
        { proposalId: proposal.proposal.id, operatorOxyUserId: OPERATOR },
        { key: 'acme_tools', reason: 'a real brand' },
      ),
    ).rejects.toThrow(/canonical-catalog/i);
  });

  it('a rejected proposal cannot be re-decided — the state trigger', async () => {
    const proposal = await submitProposal(db, submission('Gris Perla', MERCHANT, false));
    await rejectProposal(
      db,
      { proposalId: proposal.proposal.id, operatorOxyUserId: OPERATOR },
      { rejectionReason: 'not_a_distinct_concept', reason: 'this is grey' },
    );
    await expect(
      approveProposal(
        db,
        { proposalId: proposal.proposal.id, operatorOxyUserId: OPERATOR },
        { key: 'gris_perla', reason: 'changed my mind' },
      ),
    ).rejects.toThrow(/already rejected/i);
  });

  it('a redirect mints an OPERATOR-origin successor with no store', async () => {
    const proposal = await submitProposal(db, {
      ...submission('Talla Grande', MERCHANT, false),
      type: 'attribute',
    });
    const redirected = await redirectProposal(
      db,
      { proposalId: proposal.proposal.id, operatorOxyUserId: OPERATOR },
      { toType: 'controlled_value', attributeDefinitionId: `${P}-attr`, reason: 'a value, not an attribute' },
    );
    expect(redirected.state).toBe('redirected');
    expect(redirected.redirectedToProposalId).not.toBeNull();

    const successor = await db.execute<{ origin: string; store_id: string | null }>(sql`
      select origin, store_id from catalog_proposals where id = ${redirected.redirectedToProposalId ?? ''}
    `);
    // Attributing the continuation to the merchant would put an assertion in
    // their name that they did not make.
    expect(successor[0]?.origin).toBe('operator');
    expect(successor[0]?.store_id).toBeNull();
  });

  it('only the submitter may withdraw their own request', async () => {
    const proposal = await submitProposal(db, submission('Verde Lima', MERCHANT, false));
    await expect(
      withdrawProposal(db, {
        proposalId: proposal.proposal.id,
        storeId: `${P}-store`,
        actorOxyUserId: SECOND_MERCHANT,
        reason: null,
      }),
    ).rejects.toThrow(/only the account that submitted/i);

    const withdrawn = await withdrawProposal(db, {
      proposalId: proposal.proposal.id,
      storeId: `${P}-store`,
      actorOxyUserId: MERCHANT,
      reason: 'mistake',
    });
    expect(withdrawn.state).toBe('withdrawn');
  });
});

describe.skipIf(!ready)('the idempotent backfill', () => {
  it('settles the waiting draft answer, and a SECOND pass applies nothing', async () => {
    // The very first submission attached `${P}-draft` / `${P}-value`, so the
    // reference is already there.
    const open = await findOpenProposalByConvergenceKey(
      db,
      proposalConvergenceKey({
        type: 'controlled_value',
        attributeDefinitionId: `${P}-attr`,
        categoryId: `${P}-cat`,
        productTypeDefinitionId: `${P}-ptd`,
        normalizedLabel: 'verde bosque',
      }),
    );
    expect(open).not.toBeNull();
    const proposalId = open?.id ?? '';

    const references = await listProposalReferences(db, proposalId);
    expect(references).toHaveLength(1);
    expect(references[0]?.draftValueId).toBe(`${P}-value`);

    const approved = await approveProposal(
      db,
      { proposalId, operatorOxyUserId: OPERATOR },
      { key: 'verde_bosque', reason: 'a real colour' },
    );

    // The draft's local claim became the typed answer it was asking for.
    const value = await db.execute<{ kind: string; value_enum_value_id: string | null; value_text: string | null }>(sql`
      select kind, value_enum_value_id, value_text from catalog_authoring_draft_values
      where id = ${`${P}-value`}
    `);
    expect(value[0]?.kind).toBe('controlled_value');
    expect(value[0]?.value_enum_value_id).toBe(approved.resolvedEntityId);
    expect(value[0]?.value_text).toBeNull();

    // …and the draft's optimistic-concurrency token moved, so a client holding
    // the old one re-reads rather than writing its stale free text back over the
    // value an operator just approved.
    const draft = await db.execute<{ version: number }>(sql`
      select version from catalog_authoring_drafts where id = ${`${P}-draft`}
    `);
    expect(draft[0]?.version).toBeGreaterThan(1);

    // The SECOND pass. `applied` with `appliedNow: 0` — the work is finished —
    // which is a DIFFERENT report from `nothing_to_apply`, and telling them apart
    // is the whole reason the outcome is a union.
    const again = await runProposalBackfill(db, { proposalId, operatorOxyUserId: OPERATOR });
    expect(again.outcome).toBe('applied');
    if (again.outcome === 'applied') {
      expect(again.appliedNow).toBe(0);
      expect(again.referencesTotal).toBe(1);
      expect(again.referencesRemaining).toBe(0);
    }
  });

  it('reports `nothing_to_apply` — NOT four zeroes — when nobody is waiting', async () => {
    const proposal = await submitProposal(db, submission('Naranja Sol', MERCHANT, false));
    const approved = await approveProposal(
      db,
      { proposalId: proposal.proposal.id, operatorOxyUserId: OPERATOR },
      { key: 'naranja_sol', reason: 'a real colour' },
    );
    const result = await runProposalBackfill(db, {
      proposalId: approved.id,
      operatorOxyUserId: OPERATOR,
    });
    // The vacuity floor. A pass over a proposal nobody was waiting on and a pass
    // whose work is finished produce the same numbers, and only this names the
    // first.
    expect(result.outcome).toBe('nothing_to_apply');
  });

  it('REFUSES to backfill a proposal nobody has decided', async () => {
    const proposal = await submitProposal(db, submission('Amarillo Sol', MERCHANT, false));
    await expect(
      runProposalBackfill(db, {
        proposalId: proposal.proposal.id,
        operatorOxyUserId: OPERATOR,
      }),
    ).rejects.toThrow(/approved or merged/i);
  });
});


describe.skipIf(!ready)('the durable submission budget (#367 Workstream 18)', () => {
  /**
   * The per-submitter and per-store axes are counted in POSTGRES
   * (`proposal.service.ts:assertWithinSubmissionBudget`), and until now nothing
   * exercised either of them. That is the gap a rate-limit test most often has:
   * the refusal is asserted with the offending attempt never made, so the
   * assertion passes because there was nothing to refuse.
   *
   * This spends the REAL configured budget rather than narrowing it through the
   * environment. Narrowing would be faster and is the wrong trade on a shared
   * database: `config` is frozen at import and `process.env` is shared across
   * every file a vitest worker runs, so a smaller budget set here would still be
   * the budget the NEXT file loads — and the sibling it breaks is the one that
   * submits several proposals legitimately.
   */
  it('refuses the submission past the per-submitter hourly bound, and admits a colleague', async () => {
    const bound = config.catalogProposals.maxPerSubmitterPerHour;
    // A floor on the fixture, not on the code: a bound of zero would make the
    // refusal below fire without a single proposal having been submitted, which
    // is the vacuous version of this test.
    expect(bound).toBeGreaterThan(0);
    // And the other axis must not fire first, or the refusal would be evidence
    // about the store budget while claiming to be about the submitter's.
    expect(config.catalogProposals.maxPerStorePerDay).toBeGreaterThan(bound);

    // A submitter of this file's own, so the count is over rows this case wrote
    // and nothing a sibling did. The `P` prefix is what the teardown deletes by.
    const spender = `${P}-budget-spender`;
    for (let i = 0; i < bound; i += 1) {
      // DISTINCT concepts: identical labels CONVERGE onto one row, so a loop
      // submitting one label `bound` times would spend a budget of 1 and the
      // refusal would never arrive.
      const result = await submitProposal(db, submission(`Budget Colour ${i}`, spender, false));
      expect({ i, outcome: result.outcome }).toEqual({ i, outcome: 'created' });
    }

    await expect(
      submitProposal(db, submission('Budget Colour Overflow', spender, false)),
    ).rejects.toThrow(/too many catalogue proposals/iu);

    // The axis control. Without it the refusal above is equally consistent with
    // a budget counted per STORE, per category or over the whole table — and the
    // per-store axis is the one a merchant would notice, because it would stop
    // every colleague the moment one person was busy.
    const colleague = `${P}-budget-colleague`;
    const admitted = await submitProposal(db, submission('Colleague Colour', colleague, false));
    expect(admitted.outcome).toBe('created');
  });

  it('counts within the WINDOW, so yesterday\'s proposals do not spend today\'s budget', async () => {
    // The bound is "per hour", not "ever". Driven through `submitProposal`
    // rather than through the counter, because the horizon under test is the
    // SERVICE's: a case that called `countProposalsSince` with its own `since`
    // would prove the repository honours the argument it was handed and say
    // nothing about the argument the service hands it. Without this, a budget
    // counted from the beginning of time passes every other case here and locks
    // a busy store out permanently.
    const spender = `${P}-budget-window`;
    const bound = config.catalogProposals.maxPerSubmitterPerHour;
    for (let i = 0; i < bound; i += 1) {
      await submitProposal(db, submission(`Window Colour ${i}`, spender, false));
    }
    // Spent — the same refusal the case above asserts, restated here as this
    // case's OWN precondition rather than assumed from the one before it.
    await expect(
      submitProposal(db, submission('Window Overflow Before', spender, false)),
    ).rejects.toThrow(/too many catalogue proposals/iu);

    // Backdated PAST the hour. Derived from what the server stamped rather than
    // from a literal instant, so the case cannot rot into passing on a clock.
    await db.execute(
      sql`update catalog_proposals set created_at = created_at - interval '2 hours' where submitted_by_oxy_user_id = ${spender}`,
    );

    const admitted = await submitProposal(db, submission('Window Overflow After', spender, false));
    expect(admitted.outcome).toBe('created');
  });
});

describe.skipIf(!ready)('the trigram near-duplicate path writes evidence (#630)', () => {
  /**
   * Before this block, `catalog_proposal_duplicate_candidates` appeared in the
   * whole test tree ONLY in teardown DELETEs — so no test had ever caused a
   * candidate row to be written, and nothing asserted what a near-duplicate
   * produces. The constant was pinned (`CATALOG_PROPOSAL_BLOCKING_DETECTORS`
   * excludes `trigram_similarity`) and the behaviour it describes was not.
   *
   * The EXACT path is covered — "REFUSES a submission for a controlled value
   * that already exists" above. That is a different detector
   * (`exact_normalized`) reaching a different outcome, and a reader scanning for
   * "is duplicate detection tested" finds it and stops.
   *
   * ## The fixture labels are MEASURED, not guessed
   *
   * The threshold is `duplicateNearThreshold` (0.45 by default) and it is applied
   * in JS rather than in SQL, because the query is `ORDER BY x <-> $1 LIMIT n` —
   * the one shape a trigram index can serve — so it always returns n rows however
   * unlike they are. Against the fixture's single enum value `black`, measured on
   * a real server with `similarity()`:
   *
   *     jet black  0.60   → recorded
   *     crimson    0.00   → not recorded
   *
   * `Jet Black` is comfortably above the threshold and is not an exact match, so
   * it must be RECORDED and must not be REFUSED. `Crimson` shares no trigram at
   * all, which is what makes it a control rather than a second near-duplicate.
   */
  it('records a trigram candidate for a near match, and does NOT refuse it', async () => {
    const result = await submitProposal(db, submission('Jet Black', MERCHANT, false));

    // A score must never refuse a submission — the property
    // `CATALOG_PROPOSAL_BLOCKING_DETECTORS` states as a constant and nothing
    // exercised. A merchant with a legitimately similar name would otherwise be
    // told their concept already exists, with no remedy.
    expect(result.outcome).toBe('created');

    const candidates = await listDuplicateCandidates(db, result.proposal.id);
    const trigram = candidates.filter((row) => row.detector === 'trigram_similarity');
    expect(trigram, 'the near match recorded no evidence').toHaveLength(1);
    // The SUBJECT, not merely a row: a candidate naming something else would
    // satisfy a length check and be useless to the operator reading it.
    expect(trigram[0].candidateRef).toBe(`${P}-enum-black`);
    expect(trigram[0].candidateLabel).toBe('Black');
    expect(trigram[0].kind).toBe('existing_entity');
    // Recorded ABOVE the threshold the service applied, so a similarity stored
    // as null or zero — which a broken probe would produce — fails here.
    expect(trigram[0].similarity).not.toBeNull();
    expect(Number(trigram[0].similarity)).toBeGreaterThanOrEqual(
      config.catalogProposals.duplicateNearThreshold,
    );
  });

  /**
   * CONTROL — and the label is chosen to sit in the ONE band where it bites.
   *
   * #630 says this half exists because "a similarity threshold of zero would
   * pass" without it. **That is not true of this schema**, and the correction is
   * worth keeping because it decides the fixture:
   * `catalog_proposal_duplicate_candidates_similarity_range_check` is
   * `similarity is null or (similarity > 0 and similarity <= 1)`, so a
   * zero-similarity candidate is refused by the DATABASE. MEASURED: forcing the
   * threshold to zero does not silently record junk — it fails every submission
   * with a 23514 on that CHECK, loudly.
   *
   * So a distinct label scoring EXACTLY 0 (`crimson`, the first fixture here)
   * could only be recorded under a threshold the CHECK already refuses, and the
   * control would defend nothing.
   *
   * The real hazard is the threshold being LOWERED to a small POSITIVE value,
   * which admits genuinely unlike labels silently and breaks nothing. `Blush`
   * scores 0.2 against `black` — above the CHECK's floor and below the 0.45
   * threshold — which is the only band in which this case can distinguish a
   * correct threshold from a weakened one.
   */
  it('CONTROL — a label below the threshold records no trigram candidate', async () => {
    const result = await submitProposal(db, submission('Blush', MERCHANT, false));
    expect(result.outcome).toBe('created');

    const candidates = await listDuplicateCandidates(db, result.proposal.id);
    expect(
      candidates.filter((row) => row.detector === 'trigram_similarity'),
      'a label scoring below the threshold was recorded as a near match',
    ).toEqual([]);

    // ...and the scan still RAN. An empty candidate list and a scan that
    // examined nothing are the same silence otherwise, which is exactly what
    // the population counter exists to tell apart.
    expect(result.proposal.duplicateScanPopulation).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Convergence under a genuine race (#367 line 432)                           */
/* -------------------------------------------------------------------------- */

/**
 * #367 line 432 asks for idempotency keys on the create/publish mutations.
 *
 * **This endpoint needs no key, and adding one would be a defect.** It already
 * converges, on something strictly stronger than a transport retry token: a
 * SEMANTIC key — `type : attribute : category : product type : normalized
 * label`, a STORED GENERATED column — behind the partial unique
 * `catalog_proposals_open_convergence_key`, with the loser reading the winner
 * back inside the SAME transaction. That converges two DIFFERENT merchants
 * proposing one concept, which an `Idempotency-Key` cannot do; and the two
 * would disagree exactly where it matters, because a resubmission under one
 * header key with an edited label IS a different concept and only the semantic
 * key can say so. Two answers to "what makes two submissions the same" is the
 * failure this repository names everywhere else.
 *
 * The retry path is already covered elsewhere in the domain and was measured
 * rather than assumed: `insertProposalReference` is `onConflictDoNothing`, so a
 * retry attaches nothing twice, and the submission budget is a COUNT over a
 * window rather than an increment, so a converged retry — which writes no row —
 * consumes none of it.
 *
 * What was missing is the same thing the drafts create was missing: a case a
 * RACE can fail. `a SECOND merchant asking for the same concept CONVERGES`
 * above is sequential, so it passes identically against a read-then-write with
 * no unique index at all.
 *
 * So the holder sits on the key uncommitted, the racer runs the REAL service on
 * its own `max: 1` pool, and `pg_blocking_pids` is polled until it reports a
 * genuine wait — `waitUntilBlocked` THROWS if that never happens, so a case
 * which degenerated into a sequential pair fails loudly rather than passing
 * quietly. A third local copy of that barrier (`concurrent-publish.realdb.test.ts`
 * and `canonical-teardown.realdb.test.ts` carry the other two), kept local
 * because each names the mechanism it is proving in its own failure message.
 */
describe.skipIf(!ready)('convergence under a genuine race', () => {
  const SUFFIX = Math.random().toString(36).slice(2, 8);
  /** Normalizes to `race <suffix>` — a concept no other case in this file uses. */
  const RACE_LABEL = `  Race   ${SUFFIX} `;
  const RACE_NORMALIZED = `race ${SUFFIX}`;

  interface Solo {
    readonly db: Database;
    readonly client: postgres.Sql;
    readonly pid: number;
  }

  const solos: Solo[] = [];
  let racer: Solo;
  let holder: Solo;
  let probe: Solo;

  async function openSolo(): Promise<Solo> {
    const databaseUrl = process.env['DATABASE_URL'];
    if (databaseUrl === undefined) {
      throw new Error('vitest.pg.globalSetup did not publish DATABASE_URL');
    }
    const instance = createDatabase({
      databaseUrl,
      schema,
      client: { max: 1, onnotice: () => undefined },
    });
    const rows = await instance.client<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const pid = rows[0]?.pid;
    if (pid === undefined) throw new Error('the solo connection did not report a backend pid');
    const solo: Solo = { db: instance.db, client: instance.client, pid };
    solos.push(solo);
    return solo;
  }

  async function waitUntilBlocked(waiterPid: number, holderPid: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const rows = await probe.client<{ blockers: number[] }[]>`
        select pg_blocking_pids(${waiterPid}) as blockers`;
      if ((rows[0]?.blockers ?? []).includes(holderPid)) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `backend ${String(waiterPid)} was never blocked by ${String(holderPid)}: this case ` +
            'measured a sequential run rather than a race. If ' +
            '`catalog_proposals_open_convergence_key` has stopped being a unique index, this is ' +
            'the assertion that says so.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeAll(async () => {
    racer = await openSolo();
    holder = await openSolo();
    probe = await openSolo();
  }, 120_000);

  afterAll(async () => {
    // Before the FILE-level teardown, which deletes rows these still hold a
    // snapshot of — and a pool left open outlives the run and holds a backend
    // on a server many worktrees share.
    for (const solo of solos) await solo.client.end({ timeout: 5 });
  }, 120_000);

  it('converges on the winner rather than minting a second open proposal', async () => {
    // A seed proposal under a DIFFERENT concept, so the holder's row can be
    // copied from a real one and inherit every NOT NULL column. `convergence_key`
    // is GENERATED, so overriding the normalized label is what re-keys it — and
    // is why this cannot be written by inserting the key directly.
    const seed = await submitProposal(db, submission(`Seed ${SUFFIX}`, MERCHANT, false));
    const holderId = `${P}-race-${SUFFIX}`;

    // Declared OUTSIDE the transaction and NOT returned from `begin`: postgres.js
    // commits only when the callback resolves, so returning the racer's promise
    // deadlocks the case against the very commit it is waiting for.
    let racing: ReturnType<typeof submitProposal> | undefined;

    await holder.client.begin(async (tx) => {
      await tx`
        insert into catalog_proposals
          (id, type, origin, store_id, submitted_by_oxy_user_id, proposed_label, source_locale,
           normalized_label, search_label, state, category_id, product_type_definition_id,
           attribute_definition_id, attribute_definition_version,
           duplicate_scan_population, duplicate_scan_candidates, duplicate_scan_at)
        select ${holderId}, type, origin, store_id, submitted_by_oxy_user_id,
               ${`Race ${SUFFIX}`}, source_locale, ${RACE_NORMALIZED}, ${RACE_NORMALIZED},
               'submitted', category_id, product_type_definition_id, attribute_definition_id,
               attribute_definition_version, duplicate_scan_population, duplicate_scan_candidates,
               duplicate_scan_at
        from catalog_proposals where id = ${seed.proposal.id}
      `;

      // The racer runs the REAL service on its own connection. Not awaited: it
      // is about to block on the uncommitted tuple above.
      racing = submitProposal(racer.db, submission(RACE_LABEL, SECOND_MERCHANT, false));

      // The non-vacuity control.
      await waitUntilBlocked(racer.pid, holder.pid);

      // Resolving the callback commits, which turns the racer's WAIT into the
      // conflict it has to converge on.
    });

    if (racing === undefined) throw new Error('the racer never started');
    const converged = await racing;

    // The SERVICE's own answer, which a table read cannot make.
    expect(converged.outcome).toBe('converged');
    expect(converged.proposal.id).toBe(holderId);

    // …and exactly one OPEN proposal carries the concept.
    const key = proposalConvergenceKey({
      type: 'controlled_value',
      attributeDefinitionId: `${P}-attr`,
      categoryId: `${P}-cat`,
      productTypeDefinitionId: `${P}-ptd`,
      normalizedLabel: RACE_NORMALIZED,
    });
    const count = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from catalog_proposals
      where convergence_key = ${key} and state in ('submitted', 'needs_information', 'deferred')
    `);
    expect(count[0]?.total).toBe(1);
  }, 120_000);
});
