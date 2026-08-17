/**
 * Role-based permissions for view, propose, review, translate and publish
 * (#367 Workstream 12).
 *
 * ## This is not a seventh allow-list, and it structurally cannot become one
 *
 * `CATALOG_OPERATOR_OXY_USER_IDS` decides who reaches this surface at all.
 * `requireCatalogOperator` answers 404 to an account absent from it, before any
 * row here is read — so nothing in this table can ADMIT anybody. A grant can
 * only ever narrow what somebody the deployment already trusts may do.
 * `grant_operator_membership` is named in
 * `CATALOG_GOVERNANCE_FORBIDDEN_CAPABILITIES` for the reader who wonders
 * whether that stays true, and `catalog-governance-isolation.test.ts` fails the
 * build if this domain learns to write `config.catalog.graphOperatorOxyUserIds`.
 *
 * ## An empty grant table means role separation has not been adopted
 *
 * Every allow-listed operator then holds every role — today's behaviour, which
 * is what a rollout mechanism has to default to. The moment ANY live grant
 * exists the deployment has adopted role separation and grants are
 * authoritative.
 *
 * That transition is a cliff, and it is guarded rather than hidden:
 * `grantRole`/`revokeRole` refuse a mutation that would leave a non-empty grant
 * set with no live `publish` holder. Without it the first grant ever made locks
 * the deployment out of publishing its own catalogue, recoverable only by
 * somebody with database access — which is a worse property than the cliff.
 *
 * The guard is a service invariant and not a CHECK, because "at least one row
 * elsewhere in this table" is a subquery and a CHECK may not contain one. It
 * runs inside the same transaction as the mutation, against a locked count, and
 * a realdb case drives both directions.
 */

import type { CatalogGovernanceRole } from '@mercaria/shared-types';
import {
  CATALOG_GOVERNANCE_ACTION_ROLES,
  CATALOG_GOVERNANCE_ROLES,
} from '@mercaria/shared-types';
import { conflict, forbidden } from '../../lib/errors/error-codes.js';
import { getDb, type Database, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  countLiveRoleGrants,
  insertRoleGrant,
  listAllRoleGrants,
  listLiveRoleGrants,
  recordAuditEvent,
  revokeRoleGrant,
  type CatalogGovernanceRoleGrantRow,
} from '../../db/catalogGovernance/auditRepository.js';
import type { CatalogGovernanceActor } from './actor.js';

/**
 * What the grant table says about one person, plus WHY.
 *
 * A string discriminant, not a boolean: the backend compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant — a caller writing
 * `if (!resolution.enforced)` is left holding the whole union. #68 found this
 * the hard way and #110 hit it again on its first typecheck.
 */
export type RoleResolution =
  | { readonly mode: 'unrestricted'; readonly roles: readonly CatalogGovernanceRole[] }
  | { readonly mode: 'granted'; readonly roles: readonly CatalogGovernanceRole[] };

/**
 * Resolve the roles an allow-listed operator holds.
 *
 * The caller has already passed `requireCatalogOperator`, so this answers "what
 * may you do" and never "may you be here".
 */
export async function resolveGovernanceRoles(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RoleResolution> {
  const live = await countLiveRoleGrants(db);
  if (live.total === 0) {
    return { mode: 'unrestricted', roles: [...CATALOG_GOVERNANCE_ROLES] };
  }
  const grants = await listLiveRoleGrants(db, oxyUserId);
  return { mode: 'granted', roles: grants.map((grant) => grant.role) };
}

/**
 * Refuse an actor who does not hold a role.
 *
 * Takes the actor rather than an id, so a caller cannot check one person's
 * roles and then act as another — the branded type is what makes that a
 * compile-time property rather than a code-review one.
 */
export function requireGovernanceRole(
  actor: CatalogGovernanceActor,
  role: CatalogGovernanceRole,
): void {
  if (actor.roles.includes(role)) return;
  throw forbidden(
    `This action needs the ${role} role on the catalog governance surface. Ask an operator who holds publish to grant it.`,
  );
}

/**
 * The role a governance act needs.
 *
 * A total `Record` lookup, so an action added to either tuple without a role
 * fails `tsc` at the declaration — which is the only moment anybody is thinking
 * about the question. An array of pairs would have compiled and refused every
 * caller of the new action at runtime, which reads as a permissions bug.
 */
export function roleForAction(
  action: keyof typeof CATALOG_GOVERNANCE_ACTION_ROLES,
): CatalogGovernanceRole {
  return CATALOG_GOVERNANCE_ACTION_ROLES[action];
}

/** What a grant or revocation returns. `converged` means it was already so. */
export type RoleMutation =
  | { readonly outcome: 'changed'; readonly grant: CatalogGovernanceRoleGrantRow }
  | { readonly outcome: 'converged' };

/**
 * Grant a role.
 *
 * The lockout guard runs on the REVOKE path only — a grant can never remove the
 * last publisher — but the count is read here too, because a first grant that
 * does not include `publish` for somebody is the OTHER way to arrive with no
 * publisher: the table becomes non-empty, enforcement switches on, and nobody
 * holds the role. That refusal names the fix.
 */
export async function grantRole(
  db: Database,
  actor: CatalogGovernanceActor,
  input: {
    readonly subjectOxyUserId: string;
    readonly role: CatalogGovernanceRole;
    readonly reason: string;
  },
): Promise<RoleMutation> {
  requireGovernanceRole(actor, 'publish');

  return db.transaction(async (tx) => {
    const before = await countLiveRoleGrants(tx);
    if (before.total === 0 && before.publishers === 0 && input.role !== 'publish') {
      throw conflict(
        'This is the first grant on this deployment, so it switches role enforcement on for everybody. Grant publish to at least one operator first, or nobody will be able to publish a catalogue change.',
      );
    }

    const now = new Date();
    const grant = await insertRoleGrant(tx, {
      subjectOxyUserId: input.subjectOxyUserId,
      role: input.role,
      grantedByOxyUserId: actor.oxyUserId,
      grantedAt: now,
      reason: input.reason,
    });

    if (!grant) return { outcome: 'converged' };

    await recordAuditEvent(tx, {
      domain: 'governance',
      action: 'role_granted',
      subjectKind: 'operator_role',
      subjectId: input.subjectOxyUserId,
      actorKind: 'operator',
      actorOxyUserId: actor.oxyUserId,
      reason: input.reason,
      source: 'operator_console',
      changeRequestId: null,
      before: null,
      after: { role: input.role, subjectOxyUserId: input.subjectOxyUserId },
      at: now,
    });

    return { outcome: 'changed', grant };
  });
}

/**
 * Revoke a role.
 *
 * Refuses the revocation that would leave an enforcing deployment with no
 * publisher. The check reads the count AFTER the update inside the same
 * transaction rather than predicting it, because predicting it means
 * re-implementing the partial unique's own semantics and getting the
 * already-revoked case wrong.
 */
export async function revokeRole(
  db: Database,
  actor: CatalogGovernanceActor,
  input: {
    readonly subjectOxyUserId: string;
    readonly role: CatalogGovernanceRole;
    readonly reason: string;
  },
): Promise<RoleMutation> {
  requireGovernanceRole(actor, 'publish');

  return db.transaction(async (tx) => {
    const now = new Date();
    const revoked = await revokeRoleGrant(
      tx,
      input.subjectOxyUserId,
      input.role,
      actor.oxyUserId,
      now,
    );
    if (!revoked) return { outcome: 'converged' };

    const after = await countLiveRoleGrants(tx);
    if (after.total > 0 && after.publishers === 0) {
      throw conflict(
        'Revoking this would leave the deployment with no operator holding publish, and role enforcement is on. Grant publish to somebody else first.',
      );
    }

    await recordAuditEvent(tx, {
      domain: 'governance',
      action: 'role_revoked',
      subjectKind: 'operator_role',
      subjectId: input.subjectOxyUserId,
      actorKind: 'operator',
      actorOxyUserId: actor.oxyUserId,
      reason: input.reason,
      source: 'operator_console',
      changeRequestId: null,
      before: { role: input.role, subjectOxyUserId: input.subjectOxyUserId },
      after: null,
      at: now,
    });

    return { outcome: 'changed', grant: revoked };
  });
}

/** Every grant, live and revoked — the history a role audit reads. */
export async function listRoleGrants(
  db: DatabaseOrTransaction,
  limit: number,
  offset: number,
): Promise<CatalogGovernanceRoleGrantRow[]> {
  return listAllRoleGrants(db, limit, offset);
}
