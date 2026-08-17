/**
 * Who may publish a global catalog change (#367 Workstream 12).
 *
 * "A merchant role may never publish a global catalog change" is held here, and
 * it is a property of the CALL GRAPH rather than a check.
 *
 * `CatalogGovernanceActor` carries `GOVERNANCE_ACTOR_BRAND`, a `unique symbol`
 * declared in this module and exported from nowhere. The type cannot be
 * constructed by a caller, an object literal, a cast a reviewer would notice,
 * or a `JSON.parse` — only `governanceActor(req)` mints one, and that function
 * reads `catalogOperatorId(req)`, which is only meaningful after
 * `requireCatalogOperator` has run.
 *
 * Every apply and every review function in this domain takes one. A
 * merchant-scoped request holds a store membership from `requireStorePermission`
 * — and there is no function anywhere in this repository that turns a store
 * membership into a `CatalogGovernanceActor`, so the question "did this path
 * check that the caller is an operator?" is answered by the path COMPILING at
 * all. #110's `BuyerRequestActor` is the precedent, and it is used here for the
 * same reason: the alternative is a branch, and a branch can be inverted by a
 * refactor that looks like a simplification.
 *
 * The role a given actor holds is a SEPARATE question, answered by
 * `role.service.ts` against the grant table. This module answers "may you be
 * here at all"; that one answers "may you do this".
 */

import type { Request } from 'express';
import type { CatalogGovernanceRole } from '@mercaria/shared-types';
import { catalogOperatorId } from '../../middleware/catalog-operator-authz.js';

/**
 * Module-private. Not exported, not re-exported by any barrel — this domain has
 * no barrel — and not nameable from outside this file.
 */
declare const GOVERNANCE_ACTOR_BRAND: unique symbol;

/**
 * A verified catalog operator. The only way to obtain one is `governanceActor`.
 *
 * `roles` is the set the grant table resolved for this person at the moment the
 * request was authorized, snapshotted onto the actor so a long-running apply
 * cannot have its capability change underneath it mid-transaction.
 */
export interface CatalogGovernanceActor {
  readonly oxyUserId: string;
  readonly roles: readonly CatalogGovernanceRole[];
  readonly [GOVERNANCE_ACTOR_BRAND]: true;
}

/**
 * Mint an actor from an authorized request.
 *
 * `catalogOperatorId` throws when the request carries no verified Oxy id, so
 * there is no branch here that could return an unauthenticated actor. The
 * middleware order in `routes/internal-catalog-governance.ts` is
 * `authenticateToken` then `requireCatalogOperator` then the handler — an
 * allow-list consulted before authentication would compare against whatever a
 * client claimed.
 */
export function governanceActor(
  req: Request,
  roles: readonly CatalogGovernanceRole[],
): CatalogGovernanceActor {
  const oxyUserId = catalogOperatorId(req);
  return { oxyUserId, roles } as CatalogGovernanceActor;
}

/**
 * The actor a background path acts as — a sweep, a retention job, a
 * reconciliation that has nobody in front of it.
 *
 * It holds NO roles, deliberately, so a system path cannot apply a change
 * request: `requireGovernanceRole` refuses it exactly as it refuses an operator
 * without the grant. Audit rows written on this path carry
 * `actorKind: 'system'` and no `actorOxyUserId`, which the
 * `catalog_governance_audit_events_actor_presence_check` biconditional makes the
 * only representable shape for one.
 */
export function systemGovernanceActor(): CatalogGovernanceActor {
  const roles: readonly CatalogGovernanceRole[] = [];
  return { oxyUserId: '', roles } as CatalogGovernanceActor;
}

/** Whether an actor is the system rather than a person. */
export function isSystemActor(actor: CatalogGovernanceActor): boolean {
  return actor.oxyUserId === '';
}
