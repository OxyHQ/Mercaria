/**
 * Catalog governance against a REAL Postgres server (#367 Workstream 12).
 *
 * Everything here is a property the DATABASE holds and a mocked repository
 * cannot: the two impact-coverage CHECKs written as SEPARATE implications, the
 * approver-distinct and second-approval CHECKs, the append-only triggers on the
 * audit trail and the impact counts, the change-request freeze, the role-grant
 * partial unique and its immutability, and the snapshot's count identity. A
 * mocked `insert` accepts any statement, including one the server rejects
 * outright — which is exactly the class of bug this file exists to catch.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel workers. Every row this file writes carries a per-run suffix in a
 * column it owns, every aggregate is scoped to those ids, and teardown deletes
 * exactly what it created — children first, because the audit trail's foreign
 * key onto a change request is `restrict` and agrees with its no-delete trigger.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import {
  catalogGovernanceAuditEvents,
  catalogGovernanceChangeRequests,
  catalogGovernanceDefinitionSnapshots,
  catalogGovernanceImpactCounts,
  catalogGovernanceRoleGrants,
} from '../../../db/schema/catalogGovernance.js';
import {
  insertChangeRequest,
  listImpactCounts,
  transitionChangeRequest,
} from '../../../db/catalogGovernance/changeRequestRepository.js';
import {
  countLiveRoleGrants,
  insertRoleGrant,
  recordAuditEvent,
  revokeRoleGrant,
} from '../../../db/catalogGovernance/auditRepository.js';
import { insertDefinitionSnapshot } from '../../../db/catalogGovernance/snapshotRepository.js';

/** A per-run suffix so parallel workers cannot see each other's rows. */
const RUN = uuidv7().slice(-12);
const actor = (name: string): string => `gov-${name}-${RUN}`;
const subject = (name: string): string => `subj-${name}-${RUN}`;

let db: Database;
const createdRequests: string[] = [];

/** A minimal measured plan. */
async function plan(
  overrides: Partial<Parameters<typeof insertChangeRequest>[1]> = {},
): Promise<string> {
  const row = await db.transaction(async (tx) =>
    insertChangeRequest(tx, {
      domain: 'taxonomy',
      action: 'taxonomy_deprecate',
      subjectKind: 'category',
      subjectId: subject('c'),
      parameters: {},
      reason: 'a stated reason for the change',
      requestedByOxyUserId: actor('requester'),
      requestedAt: new Date(),
      requiresSecondApproval: false,
      impactCoverage: 'measured',
      impactRelationsDeclared: 2,
      impactMeasuredAt: new Date(),
      impactUnmeasuredReason: null,
      counts: [
        { referenceTable: 'listings', referenceColumn: 'categoryId', disposition: 'blocks', rowCount: 3 },
        {
          referenceTable: 'navigation_nodes',
          referenceColumn: 'categoryId',
          disposition: 'rewired_by_domain',
          rowCount: 0,
        },
      ],
      ...overrides,
    }),
  );
  createdRequests.push(row.id);
  return row.id;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  // Children first: `catalog_governance_audit_events.change_request_id` and
  // `catalog_governance_impact_counts.change_request_id` are BOTH `restrict`,
  // deliberately agreeing with their no-delete triggers.
  if (createdRequests.length > 0) {
    await db.execute(
      sql`delete from catalog_governance_audit_events where change_request_id in ${sql.raw(
        `(${createdRequests.map((id) => `'${id}'`).join(', ')})`,
      )}`,
    );
    await db.execute(
      sql`delete from catalog_governance_impact_counts where change_request_id in ${sql.raw(
        `(${createdRequests.map((id) => `'${id}'`).join(', ')})`,
      )}`,
    );
    await db
      .delete(catalogGovernanceChangeRequests)
      .where(inArray(catalogGovernanceChangeRequests.id, createdRequests));
  }
  await db.execute(
    sql`delete from catalog_governance_audit_events where subject_id like ${`%${RUN}`}`,
  );
  await db.delete(catalogGovernanceRoleGrants).where(like(catalogGovernanceRoleGrants.subjectOxyUserId, `%${RUN}`));
  await db
    .delete(catalogGovernanceDefinitionSnapshots)
    .where(like(catalogGovernanceDefinitionSnapshots.createdByOxyUserId, `%${RUN}`));
  await closePostgres();
});

describe('the impact coverage CHECKs', () => {
  it('accepts a measured plan whose counters are all present', async () => {
    const id = await plan();
    const [row] = await db
      .select()
      .from(catalogGovernanceChangeRequests)
      .where(eq(catalogGovernanceChangeRequests.id, id));
    expect(row.impactCoverage).toBe('measured');
    expect(row.impactRelationsCounted).toBe(2);
    expect(row.impactTotal).toBe(3);
    const counts = await listImpactCounts(db, id);
    // The vacuity floor: the ROW COUNT, not the sum. Two relations counted, one
    // of them zero — which is a measurement, and the whole difference between
    // "nothing points at this" and "we did not look".
    expect(counts).toHaveLength(2);
    expect(counts.filter((entry) => entry.rowCount === 0)).toHaveLength(1);
  });

  it('REFUSES a measured plan carrying no counters at all', async () => {
    // The row a `0 = 0 + 0 + 0` sum check would happily accept.
    await expect(
      db.execute(sql`
        insert into catalog_governance_change_requests
          (id, domain, action, subject_kind, subject_id, parameters, reason,
           requested_by_oxy_user_id, requested_at, impact_coverage)
        values (${uuidv7()}, 'taxonomy', 'taxonomy_deprecate', 'category', ${subject('bad')},
                '{}'::jsonb, 'no counters', ${actor('r')}, now(), 'measured')
      `),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES an unmeasured plan that carries counters anyway', async () => {
    // The other half, and the reason the two implications are SEPARATE CHECKs:
    // written as one CHECK over their conjunction, a row that is neither shape
    // satisfies it because both sides evaluate false — the #68 finding, which
    // cost a constraint that admitted exactly the row it existed to refuse.
    await expect(
      db.execute(sql`
        insert into catalog_governance_change_requests
          (id, domain, action, subject_kind, subject_id, parameters, reason,
           requested_by_oxy_user_id, requested_at, impact_coverage,
           impact_relations_declared, impact_relations_counted, impact_total,
           impact_measured_at, impact_unmeasured_reason)
        values (${uuidv7()}, 'taxonomy', 'taxonomy_deprecate', 'category', ${subject('bad2')},
                '{}'::jsonb, 'contradictory', ${actor('r')}, now(), 'unmeasured',
                2, 2, 5, now(), 'a reason')
      `),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES an unmeasured plan with no stated reason', async () => {
    await expect(
      db.execute(sql`
        insert into catalog_governance_change_requests
          (id, domain, action, subject_kind, subject_id, parameters, reason,
           requested_by_oxy_user_id, requested_at, impact_coverage)
        values (${uuidv7()}, 'taxonomy', 'taxonomy_deprecate', 'category', ${subject('bad3')},
                '{}'::jsonb, 'unmeasured with no why', ${actor('r')}, now(), 'unmeasured')
      `),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES applying an unmeasured plan', async () => {
    const [row] = await db
      .insert(catalogGovernanceChangeRequests)
      .values({
        domain: 'taxonomy',
        action: 'taxonomy_deprecate',
        subjectKind: 'category',
        subjectId: subject('unmeasured'),
        parameters: {},
        reason: 'could not measure',
        requestedByOxyUserId: actor('r'),
        requestedAt: new Date(),
        impactCoverage: 'unmeasured',
        impactUnmeasuredReason: 'the count failed',
      })
      .returning();
    createdRequests.push(row.id);

    // An unmeasured plan may be RECORDED — an operator has to be able to see
    // what was attempted — and may never execute.
    await expect(
      db
        .update(catalogGovernanceChangeRequests)
        .set({ state: 'applied', appliedAt: new Date() })
        .where(eq(catalogGovernanceChangeRequests.id, row.id)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES a duplicate measurement of one relation', async () => {
    const id = await plan();
    await expect(
      db.insert(catalogGovernanceImpactCounts).values({
        changeRequestId: id,
        referenceTable: 'listings',
        referenceColumn: 'categoryId',
        disposition: 'blocks',
        rowCount: 99,
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('refuses a plan the service can see is short of its declared relations', async () => {
    // The service-side half of the floor, refused before any SQL is issued:
    // the CHECK can compare the counted number against the declared one, and
    // only the writer can compare it against the rows it is about to write.
    await expect(
      plan({ impactRelationsDeclared: 20 }),
    ).rejects.toThrow(/Impact measurement is incomplete/u);
  });
});

describe('the four-eyes CHECKs', () => {
  it('REFUSES an approver who is the requester', async () => {
    const id = await plan();
    await expect(
      db
        .update(catalogGovernanceChangeRequests)
        .set({
          state: 'approved',
          approvedByOxyUserId: actor('requester'),
          approvedAt: new Date(),
        })
        .where(eq(catalogGovernanceChangeRequests.id, id)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES an approver with no instant', async () => {
    const id = await plan();
    await expect(
      db
        .update(catalogGovernanceChangeRequests)
        .set({ state: 'approved', approvedByOxyUserId: actor('approver') })
        .where(eq(catalogGovernanceChangeRequests.id, id)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES applying a high-impact change with no second approval', async () => {
    const id = await plan({ requiresSecondApproval: true });
    // This is the constraint that makes the gate real: a service bug that
    // skipped the approval step is refused by the database rather than by the
    // reviewer who did not notice.
    await expect(
      db
        .update(catalogGovernanceChangeRequests)
        .set({ state: 'applied', appliedAt: new Date() })
        .where(eq(catalogGovernanceChangeRequests.id, id)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('accepts a high-impact change once a DIFFERENT operator approved it', async () => {
    const id = await plan({ requiresSecondApproval: true });
    const approved = await transitionChangeRequest(db, id, ['planned'], {
      state: 'approved',
      approvedByOxyUserId: actor('approver'),
      approvedAt: new Date(),
    });
    expect(approved).not.toBeNull();
    const applied = await transitionChangeRequest(db, id, ['approved'], {
      state: 'applied',
      appliedAt: new Date(),
    });
    expect(applied?.state).toBe('applied');
  });
});

describe('the immutability triggers', () => {
  it('freezes the plan once the request leaves planned', async () => {
    const id = await plan();
    await transitionChangeRequest(db, id, ['planned'], {
      state: 'approved',
      approvedByOxyUserId: actor('approver'),
      approvedAt: new Date(),
    });
    // The plan an approver READ is the plan that executes. Without the freeze,
    // "approve" means "approve whatever this row says at apply time".
    await expect(
      db
        .update(catalogGovernanceChangeRequests)
        .set({ parameters: { intoCategoryId: 'somewhere-else' } })
        .where(eq(catalogGovernanceChangeRequests.id, id)),
    ).rejects.toThrow(/frozen once it leaves planned/u);
  });

  it('refuses a DELETE of a change request', async () => {
    const id = await plan();
    await expect(
      db.execute(sql`delete from catalog_governance_change_requests where id = ${id}`),
    ).rejects.toThrow(/refuses DELETE/u);
    // The row survives, so the teardown still has to clean it up.
  });

  it('refuses re-approving an already approved request', async () => {
    const id = await plan();
    await transitionChangeRequest(db, id, ['planned'], {
      state: 'approved',
      approvedByOxyUserId: actor('approver'),
      approvedAt: new Date(),
    });
    await expect(
      db
        .update(catalogGovernanceChangeRequests)
        .set({ approvedByOxyUserId: actor('other'), approvedAt: new Date() })
        .where(eq(catalogGovernanceChangeRequests.id, id)),
    ).rejects.toThrow(/approval is written once/u);
  });

  it('refuses moving a terminal request', async () => {
    const id = await plan();
    await transitionChangeRequest(db, id, ['planned'], { state: 'rejected' });
    await expect(
      db
        .update(catalogGovernanceChangeRequests)
        .set({ state: 'planned' })
        .where(eq(catalogGovernanceChangeRequests.id, id)),
    ).rejects.toThrow(/is terminal/u);
  });

  it('makes the audit trail append-only against UPDATE and DELETE', async () => {
    const id = await plan();
    const event = await db.transaction(async (tx) =>
      recordAuditEvent(tx, {
        domain: 'taxonomy',
        action: 'change_requested',
        subjectKind: 'category',
        subjectId: subject('audit'),
        actorKind: 'operator',
        actorOxyUserId: actor('requester'),
        reason: 'planned a change',
        source: 'operator_console',
        changeRequestId: id,
        before: null,
        after: { ok: true },
        at: new Date(),
      }),
    );

    await expect(
      db
        .update(catalogGovernanceAuditEvents)
        .set({ reason: 'a different reason' })
        .where(eq(catalogGovernanceAuditEvents.id, event.id)),
    ).rejects.toThrow(/append-only/u);
    await expect(
      db.execute(sql`delete from catalog_governance_audit_events where id = ${event.id}`),
    ).rejects.toThrow(/append-only/u);
  });

  it('makes impact counts append-only', async () => {
    const id = await plan();
    const [count] = await listImpactCounts(db, id);
    await expect(
      db
        .update(catalogGovernanceImpactCounts)
        .set({ rowCount: 0 })
        .where(eq(catalogGovernanceImpactCounts.id, count.id)),
    ).rejects.toThrow(/append-only/u);
  });

  it('REFUSES an audit event whose actor kind and actor id disagree', async () => {
    await expect(
      db.execute(sql`
        insert into catalog_governance_audit_events
          (id, domain, action, subject_kind, subject_id, actor_kind, actor_oxy_user_id,
           reason, source, at)
        values (${uuidv7()}, 'taxonomy', 'change_requested', 'category', ${subject('mismatch')},
                'system', ${actor('somebody')}, 'a reason', 'operator_console', now())
      `),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('role grants', () => {
  it('converges a repeated grant on one live row', async () => {
    const person = actor('grantee');
    const first = await db.transaction(async (tx) =>
      insertRoleGrant(tx, {
        subjectOxyUserId: person,
        role: 'publish',
        grantedByOxyUserId: actor('granter'),
        grantedAt: new Date(),
        reason: 'runs the catalogue',
      }),
    );
    expect(first).not.toBeNull();

    const second = await db.transaction(async (tx) =>
      insertRoleGrant(tx, {
        subjectOxyUserId: person,
        role: 'publish',
        grantedByOxyUserId: actor('granter2'),
        grantedAt: new Date(),
        reason: 'also runs the catalogue',
      }),
    );
    // Two operators granting one capability to one person is convergent intent,
    // not a conflict — the partial unique makes the second a no-op.
    expect(second).toBeNull();
  });

  it('permits a re-grant after a revocation, and keeps the revoked row', async () => {
    const person = actor('regrantee');
    await db.transaction(async (tx) =>
      insertRoleGrant(tx, {
        subjectOxyUserId: person,
        role: 'review',
        grantedByOxyUserId: actor('granter'),
        grantedAt: new Date(),
        reason: 'reviews mappings',
      }),
    );
    const revoked = await db.transaction(async (tx) =>
      revokeRoleGrant(tx, person, 'review', actor('revoker'), new Date()),
    );
    expect(revoked).not.toBeNull();

    const again = await db.transaction(async (tx) =>
      insertRoleGrant(tx, {
        subjectOxyUserId: person,
        role: 'review',
        grantedByOxyUserId: actor('granter'),
        grantedAt: new Date(),
        reason: 'reviews mappings again',
      }),
    );
    // The partial unique is `WHERE revoked_at is null`, so a re-grant is
    // permitted and the history of who held it survives — "who could publish
    // last March" is a question an incident asks first.
    expect(again).not.toBeNull();
    const rows = await db
      .select()
      .from(catalogGovernanceRoleGrants)
      .where(eq(catalogGovernanceRoleGrants.subjectOxyUserId, person));
    expect(rows).toHaveLength(2);
  });

  it('refuses a DELETE and refuses editing a grant', async () => {
    const person = actor('frozen');
    const grant = await db.transaction(async (tx) =>
      insertRoleGrant(tx, {
        subjectOxyUserId: person,
        role: 'translate',
        grantedByOxyUserId: actor('granter'),
        grantedAt: new Date(),
        reason: 'translates the catalogue',
      }),
    );
    await expect(
      db.execute(sql`delete from catalog_governance_role_grants where id = ${grant?.id}`),
    ).rejects.toThrow(/refuses DELETE/u);
    await expect(
      db
        .update(catalogGovernanceRoleGrants)
        .set({ reason: 'a different reason' })
        .where(eq(catalogGovernanceRoleGrants.id, grant?.id ?? '')),
    ).rejects.toThrow(/immutable/u);
  });

  it('counts live grants and publishers together', async () => {
    // Read together deliberately: the first says whether the deployment has
    // adopted role separation, the second is the lockout guard, and reading
    // them separately leaves a window between "unrestricted" and "nobody can
    // publish".
    const counts = await countLiveRoleGrants(db);
    expect(counts.total).toBeGreaterThanOrEqual(counts.publishers);
    expect(counts.publishers).toBeGreaterThan(0);
  });
});

describe('definition snapshots', () => {
  it('derives the entity count from its parts and refuses an empty export', async () => {
    const row = await db.transaction(async (tx) =>
      insertDefinitionSnapshot(tx, {
        scope: 'taxonomy',
        contentDigest: 'a'.repeat(64),
        document: { scope: 'taxonomy', categories: [{ key: 'k' }] },
        counts: {
          categoryCount: 3,
          productTypeCount: 1,
          attributeCount: 2,
          localizationCount: 0,
          navigationTreeCount: 0,
        },
        createdByOxyUserId: actor('exporter'),
        reason: 'a pre-change export',
      }),
    );
    expect(row.entityCount).toBe(6);

    await expect(
      db.transaction(async (tx) =>
        insertDefinitionSnapshot(tx, {
          scope: 'taxonomy',
          contentDigest: 'b'.repeat(64),
          document: {},
          counts: {
            categoryCount: 0,
            productTypeCount: 0,
            attributeCount: 0,
            localizationCount: 0,
            navigationTreeCount: 0,
          },
          createdByOxyUserId: actor('exporter'),
          reason: 'an empty export',
        }),
      ),
      // An empty snapshot digests cleanly, restores cleanly and reports
      // "nothing to do" — the one failure mode a restore cannot recover from.
    ).rejects.toThrow(/read no definitions/u);
  });

  it('REFUSES a snapshot whose headline disagrees with its parts', async () => {
    await expect(
      db.execute(sql`
        insert into catalog_governance_definition_snapshots
          (id, scope, content_digest, document, entity_count, category_count,
           product_type_count, attribute_count, localization_count,
           navigation_tree_count, created_by_oxy_user_id, reason)
        values (${uuidv7()}, 'taxonomy', ${'c'.repeat(64)}, '{}'::jsonb,
                99, 1, 1, 1, 1, 1, ${actor('exporter')}, 'a lie')
      `),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES a digest that is not a sha-256', async () => {
    await expect(
      db.execute(sql`
        insert into catalog_governance_definition_snapshots
          (id, scope, content_digest, document, entity_count, category_count,
           product_type_count, attribute_count, localization_count,
           navigation_tree_count, created_by_oxy_user_id, reason)
        values (${uuidv7()}, 'taxonomy', 'not-a-digest', '{}'::jsonb,
                1, 1, 0, 0, 0, 0, ${actor('exporter')}, 'a bad digest')
      `),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses editing a stored snapshot', async () => {
    const [row] = await db
      .select()
      .from(catalogGovernanceDefinitionSnapshots)
      .where(eq(catalogGovernanceDefinitionSnapshots.createdByOxyUserId, actor('exporter')))
      .limit(1);
    await expect(
      db
        .update(catalogGovernanceDefinitionSnapshots)
        .set({ reason: 'a different reason' })
        .where(eq(catalogGovernanceDefinitionSnapshots.id, row.id)),
    ).rejects.toThrow(/immutable/u);
  });
});
