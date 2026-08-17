/**
 * Applying an approved change (#367 Workstream 12).
 *
 * **Every function here DRIVES an existing idempotent path.** Nothing in this
 * module writes a catalogue table, and nothing in this module is a second
 * writer of anything: `taxonomyRepository` moves categories,
 * `publishProductTypeVersion` publishes types, the attribute registry publishes
 * and deprecates definitions, `publishNavigationTree` publishes trees. What
 * this module adds is that each of them is reached only after a plan, an impact
 * measurement and — where the impact is large and `CATALOG_FOUR_EYES_REQUIRED`
 * is on — a second operator.
 *
 * `catalog-governance-isolation.test.ts` fails the build if any module in this
 * domain grows a `.insert(` / `.update(` / `.delete(` against a catalogue
 * table, which is what keeps that claim true for the driver somebody adds next.
 *
 * ## The rewire is `bumpAuthoringSchemaInvalidation`, and it is not new
 *
 * "Rewire affected products, listings and search documents safely after an
 * approved change" is answered by three paths that already exist, none of them
 * built here:
 *
 * - `bumpAuthoringSchemaInvalidation` raises the revision every composed
 *   authoring schema is keyed on, so every open draft and every client ETag
 *   re-composes against the changed definition on its next read. **This domain
 *   calls it after a category or product-type change, which nothing did before
 *   #367 Workstream 12 — only proposal approval bumped it.**
 * - `publishAttributeDefinition` already enqueues one
 *   `attribute_reindex_requests` row per affected entity. That is the search /
 *   normalization rewire and it needs nothing from here.
 * - The category triggers already mark dependent localizations stale, and
 *   `moveCategory` already re-splices every descendant's ancestry.
 *
 * ## The one rewire that does NOT exist, stated rather than faked
 *
 * `listings.category_slugs` is denormalized at write time by
 * `catalog-write.service.resolveCategory` and nothing re-derives it. A category
 * rename therefore leaves every listing beneath it carrying the old ancestor
 * path. The honest response is `impact-plan.ts`'s `rewire_path_missing`
 * disposition and an impact report that says so — not a second writer of
 * `listings` here, which is precisely what the house rule forbids and what
 * `taxonomy-write-chokepoint.test.ts` and the listing chokepoints exist to
 * prevent.
 */

import type {
  CatalogGovernanceAction,
  CategoryLifecycle,
  CategoryRedirectReason,
} from '@mercaria/shared-types';
import { conflict, validationError } from '../../lib/errors/error-codes.js';
import type { Database, DatabaseOrTransaction } from '../../db/postgres.js';
import { bumpAuthoringSchemaInvalidation } from '../../db/catalogAuthoring/schemaInvalidationRepository.js';
import {
  insertCategoryRedirect,
  mergeCategory,
  moveCategory,
  setCategoryLifecycle,
  updateCategoryPresentation,
} from '../../db/taxonomy/taxonomyRepository.js';
import { setProductTypeLifecycleIfIn } from '../../db/productTypes/productTypeRepository.js';
import {
  deprecateAttributeDefinition,
  publishAttributeDefinition,
  retireAttributeDefinition,
} from '../attributes/definition-registry.service.js';
import { publishProductTypeVersion } from '../product-types/product-type.service.js';
import {
  archiveNavigationTree,
  publishNavigationTree,
} from '../navigation/authoring.service.js';

/**
 * What an apply produced, for the audit event's `after` snapshot.
 *
 * A string discriminant rather than a boolean, for the `strict: false` reason:
 * without `strictNullChecks` TypeScript does not narrow a union on a
 * boolean-literal discriminant, so a caller writing `if (!result.ok)` is left
 * holding the whole union.
 */
export type ApplyOutcome =
  | { readonly outcome: 'applied'; readonly after: unknown }
  | { readonly outcome: 'refused'; readonly detail: string };

/** Read one required string parameter, refusing an absent or blank one. */
function requireParam(
  parameters: Record<string, unknown>,
  key: string,
  action: CatalogGovernanceAction,
): string {
  const value = parameters[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError(`${action} needs a non-empty ${key} parameter.`);
  }
  return value;
}

/** Read one optional string parameter. */
function optionalParam(parameters: Record<string, unknown>, key: string): string | null {
  const value = parameters[key];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

/** Read a required positive integer parameter. */
function requireVersion(
  parameters: Record<string, unknown>,
  key: string,
  action: CatalogGovernanceAction,
): number {
  const value = parameters[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw validationError(`${action} needs a ${key} parameter that is a version number.`);
  }
  return value;
}

/**
 * The taxonomy drivers.
 *
 * Each takes the transaction, so the catalogue write, the state move and the
 * audit event commit together. `moveCategory` detects an existing transaction
 * (its `isTransaction` discriminator) and re-splices the subtree in one
 * statement inside ours rather than opening a second connection.
 */
async function applyTaxonomy(
  tx: DatabaseOrTransaction,
  action: CatalogGovernanceAction,
  subjectId: string,
  parameters: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case 'taxonomy_rename': {
      const name = optionalParam(parameters, 'name');
      const slug = optionalParam(parameters, 'slug');
      if (name === null && slug === null) {
        throw validationError('taxonomy_rename needs a name, a slug, or both.');
      }
      // `updateCategoryPresentation` rewrites every descendant's ancestor_slugs
      // when the slug changes. It deliberately cannot touch `key`, `parentId` or
      // `lifecycle` — those are the other three actions.
      return updateCategoryPresentation(
        subjectId,
        { name: name ?? undefined, slug: slug ?? undefined },
        tx,
      );
    }
    case 'taxonomy_move': {
      // A null parent is a legitimate destination — it makes the category a
      // root — so this reads the key's PRESENCE rather than its truthiness.
      if (!('parentId' in parameters)) {
        throw validationError('taxonomy_move needs a parentId parameter (null makes it a root).');
      }
      const raw = parameters.parentId;
      const parentId = raw === null ? null : typeof raw === 'string' && raw !== '' ? raw : undefined;
      if (parentId === undefined) {
        throw validationError('taxonomy_move needs parentId to be a category id or null.');
      }
      return moveCategory(subjectId, parentId, tx);
    }
    case 'taxonomy_merge': {
      const into = requireParam(parameters, 'intoCategoryId', action);
      // Writes the lifecycle, the pointer AND the redirect in one transaction;
      // the hierarchy trigger refuses a merge into a descendant.
      return mergeCategory(subjectId, into, tx);
    }
    case 'taxonomy_redirect': {
      const target = requireParam(parameters, 'targetCategoryId', action);
      const reason = requireParam(parameters, 'redirectReason', action) as CategoryRedirectReason;
      const locale = optionalParam(parameters, 'locale');
      const slug = optionalParam(parameters, 'slug');
      const subject =
        locale !== null && slug !== null
          ? ({ kind: 'localized_slug', locale, slug } as const)
          : ({ kind: 'category_id', categoryId: subjectId } as const);
      return insertCategoryRedirect({ subject, targetCategoryId: target, reason }, tx);
    }
    case 'taxonomy_publish':
    case 'taxonomy_restore':
    case 'taxonomy_deprecate':
    case 'taxonomy_suppress': {
      // Four actions, three lifecycles, one call. `publish` and `restore` reach
      // the same state and are separate ACTIONS because the audit trail has to
      // say which was meant: "this went live" and "this came back" lead a
      // reader to different questions. `setCategoryLifecycle` refuses `merged`
      // at the type level, which is why merging has its own driver.
      const lifecycle: Exclude<CategoryLifecycle, 'merged'> =
        action === 'taxonomy_deprecate'
          ? 'deprecated'
          : action === 'taxonomy_suppress'
            ? 'suppressed'
            : 'published';
      return setCategoryLifecycle(subjectId, lifecycle, tx);
    }
    default:
      throw conflict(`${action} is not a taxonomy action.`);
  }
}

/**
 * Apply one approved change.
 *
 * Runs inside the caller's transaction wherever the domain writer accepts one.
 * Three do not, and each says so beside its call: `publishProductTypeVersion`,
 * `publishAttributeDefinition` and `publishNavigationTree` open their own, so
 * this domain hands them the root handle and the state move commits separately
 * — the payment-outbox arrangement, and for its reason. An apply that half-ran
 * leaves a `failed` request naming what happened, which is a state an operator
 * can read; forcing them into our transaction would deadlock against it.
 */
export async function applyChange(
  db: Database,
  tx: DatabaseOrTransaction,
  input: {
    readonly action: CatalogGovernanceAction;
    readonly subjectId: string;
    readonly parameters: Record<string, unknown>;
    readonly actorOxyUserId: string;
  },
): Promise<ApplyOutcome> {
  const { action, subjectId, parameters, actorOxyUserId } = input;

  switch (action) {
    case 'taxonomy_rename':
    case 'taxonomy_move':
    case 'taxonomy_merge':
    case 'taxonomy_redirect':
    case 'taxonomy_publish':
    case 'taxonomy_restore':
    case 'taxonomy_deprecate':
    case 'taxonomy_suppress': {
      const after = await applyTaxonomy(tx, action, subjectId, parameters);
      // The rewire. Nothing bumped this for a taxonomy change before #367
      // Workstream 12, so every open authoring draft went on composing against
      // a category whose lifecycle or slug had moved until its own TTL expired.
      await bumpAuthoringSchemaInvalidation(tx, { subject: 'category', subjectId });
      return { outcome: 'applied', after };
    }

    case 'product_type_publish': {
      // Opens its own transaction — see the function doc.
      const result = await publishProductTypeVersion(db, {
        definitionId: subjectId,
        publishedByOxyUserId: actorOxyUserId,
      });
      if (result.outcome === 'refused') {
        return { outcome: 'refused', detail: `${result.refusal}: ${result.detail}` };
      }
      await bumpAuthoringSchemaInvalidation(tx, { subject: 'product_type', subjectId });
      return { outcome: 'applied', after: result.definition };
    }

    case 'product_type_deprecate': {
      const row = await setProductTypeLifecycleIfIn(tx, subjectId, ['published'], 'deprecated', {
        deprecatedAt: new Date(),
      });
      if (!row) {
        // The CAS lost, or the version was never published. Both are the same
        // answer to an operator: the row is not in the state the plan read.
        return {
          outcome: 'refused',
          detail:
            'This product type version is no longer published, so there is nothing to deprecate. Re-plan against its current state.',
        };
      }
      await bumpAuthoringSchemaInvalidation(tx, { subject: 'product_type', subjectId });
      return { outcome: 'applied', after: row };
    }

    case 'attribute_publish': {
      // Takes (key, version) rather than an id, and enqueues one
      // `attribute_reindex_requests` row per affected entity — the existing
      // durable re-normalization path, which is the search rewire.
      const key = requireParam(parameters, 'attributeKey', action);
      const version = requireVersion(parameters, 'attributeVersion', action);
      const after = await publishAttributeDefinition(key, version, actorOxyUserId);
      await bumpAuthoringSchemaInvalidation(tx, { subject: 'attribute_values', subjectId });
      return { outcome: 'applied', after };
    }

    case 'attribute_deprecate': {
      const key = requireParam(parameters, 'attributeKey', action);
      const version = requireVersion(parameters, 'attributeVersion', action);
      const after = await deprecateAttributeDefinition(key, version);
      await bumpAuthoringSchemaInvalidation(tx, { subject: 'attribute_values', subjectId });
      return { outcome: 'applied', after };
    }

    case 'attribute_retire': {
      const key = requireParam(parameters, 'attributeKey', action);
      const version = requireVersion(parameters, 'attributeVersion', action);
      const after = await retireAttributeDefinition(key, version);
      await bumpAuthoringSchemaInvalidation(tx, { subject: 'attribute_values', subjectId });
      return { outcome: 'applied', after };
    }

    case 'navigation_publish': {
      // Opens its own transaction and takes the surface lock itself; it also
      // refuses an empty node set and any node with no label in the fallback
      // chain, which is a validation this domain deliberately does not repeat.
      const effectiveFrom = optionalParam(parameters, 'effectiveFrom');
      const effectiveTo = optionalParam(parameters, 'effectiveTo');
      const after = await publishNavigationTree(db, {
        treeId: subjectId,
        actorOxyUserId,
        effectiveFrom: effectiveFrom === null ? undefined : new Date(effectiveFrom),
        effectiveTo: effectiveTo === null ? undefined : new Date(effectiveTo),
        supersedeLive: parameters.supersedeLive === true,
      });
      return { outcome: 'applied', after };
    }

    case 'navigation_archive': {
      await archiveNavigationTree(db, subjectId);
      return { outcome: 'applied', after: { treeId: subjectId, lifecycle: 'archived' } };
    }

    case 'definition_snapshot_restore':
    case 'vertical_package_apply':
      // Both are driven by `snapshot.service.ts` and `vertical-package.service.ts`
      // rather than from here, because both are multi-entity and page their own
      // work. `change-request.service.ts` routes them before reaching this
      // switch; arriving here means the routing was edited and the driver was
      // not, which is a defect and not a state to absorb.
      throw conflict(`${action} is applied by its own service, not by applyChange.`);

    default:
      throw conflict(`No governance driver is registered for ${String(action)}.`);
  }
}

/**
 * The actions `applyChange` handles, as data.
 *
 * `change-request.service.ts` routes on this rather than on a second switch, so
 * the two cannot disagree about which actions have a driver — the failure that
 * shape produces is an approved request that reaches no driver and reports a
 * generic conflict, days after somebody approved it.
 */
export const DIRECT_APPLY_ACTIONS: readonly CatalogGovernanceAction[] = [
  'taxonomy_rename',
  'taxonomy_move',
  'taxonomy_merge',
  'taxonomy_redirect',
  'taxonomy_publish',
  'taxonomy_restore',
  'taxonomy_deprecate',
  'taxonomy_suppress',
  'product_type_publish',
  'product_type_deprecate',
  'attribute_publish',
  'attribute_deprecate',
  'attribute_retire',
  'navigation_publish',
  'navigation_archive',
];
