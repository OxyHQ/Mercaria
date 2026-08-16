/**
 * Authoring a navigation tree: draft, replace, preview, publish, archive
 * (#367 step 7, ADR 0007 D3).
 *
 * ## Publication is a transition, not a sequence of edits
 *
 * A tree is created as a DRAFT, its whole node set is written at once, an
 * operator previews it, and publishing moves it to `published` over a window.
 * Nothing an operator does is ever partially visible to shoppers, because a
 * draft is unreachable from the public read by the query's own predicate rather
 * than by a filter somebody remembered.
 *
 * ## The two refusals worth reading
 *
 * A tree cannot be published EMPTY, and it cannot be published while any node
 * would render as its key. Both are vacuity floors in the
 * `assertCohortIsNotEmpty` sense: publishing an empty menu means the surface
 * renders nothing while every status field says it is live, and publishing an
 * unlabelled node means a menu entry with no words on it — and neither failure
 * announces itself anywhere except on a shopper's screen.
 *
 * ## What this service does NOT do
 *
 * It writes to no table outside this domain. Publishing a menu that points at a
 * category does not touch the category; scheduling a campaign node does not
 * touch the collection it links; nothing here can activate, publish or reorder
 * anything in the taxonomy or in merchandising (ADR 0007 D3, held by
 * `navigation-isolation.test.ts`).
 */

import type { NavigationSurface } from '@mercaria/shared-types';
import type { Database } from '../../db/postgres.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import {
  countNavigationNodesWithoutLabel,
  deleteDraftNavigationTree,
  endNavigationTreeWindow,
  findLatestNavigationTreeVersion,
  insertNavigationSavedQuery,
  insertNavigationTree,
  lockPublishedTreesForSurface,
  markNavigationTreeArchived,
  markNavigationTreePublished,
  replaceNavigationNodes,
  type NewNavigationNode,
  type NewNavigationSavedQuery,
} from '../../db/navigation/navigationWriteRepository.js';
import {
  findLiveNavigationTrees,
  findNavigationTreeById,
} from '../../db/navigation/navigationRepository.js';
import { navigationFallbackChain } from './localization.js';

/** What a new draft tree is asked for. */
export interface CreateNavigationTreeParams {
  readonly key: string;
  readonly market: string;
  readonly locale: string;
  readonly surface: NavigationSurface;
  readonly internalLabel: string;
  readonly supersedesTreeId?: string;
}

/** What a publication is asked for. */
export interface PublishNavigationTreeParams {
  readonly treeId: string;
  readonly actorOxyUserId: string;
  readonly effectiveFrom?: Date;
  readonly effectiveTo?: Date;
  /**
   * Whether the tree currently live on this surface should END where this one
   * begins.
   *
   * Explicit, and defaulting to false. A publication that silently withdrew
   * whatever was live would make "replace the menu" and "schedule a second menu"
   * the same request, and the second is how a campaign strip is scheduled weeks
   * ahead. Without it, an overlap is refused — by the exclusion trigger if
   * nothing else catches it first.
   */
  readonly supersedeLive?: boolean;
}

/** Whether a driver error is a trigger's refusal. */
function isCheckViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } })?.cause;
  // The SQLSTATE lives on `cause`, never on `error.code`: a ported
  // `err.code === '23514'` matches nothing against a drizzle error.
  return cause?.code === '23514' || cause?.code === '23505';
}

/** Create a DRAFT tree, at the next version of its `(key, market, locale)`. */
export async function createNavigationTreeDraft(
  db: Database,
  params: CreateNavigationTreeParams,
): Promise<{ readonly treeId: string; readonly version: number }> {
  return db.transaction(async (tx) => {
    const latest = await findLatestNavigationTreeVersion(tx, {
      key: params.key,
      market: params.market,
      locale: params.locale,
    });
    const version = latest + 1;
    try {
      const treeId = await insertNavigationTree(tx, {
        key: params.key,
        market: params.market,
        locale: params.locale,
        surface: params.surface,
        internalLabel: params.internalLabel,
        version,
        ...(params.supersedesTreeId === undefined
          ? {}
          : { supersedesTreeId: params.supersedesTreeId }),
      });
      return { treeId, version };
    } catch (error) {
      if (isCheckViolation(error)) {
        throw conflict(
          'A navigation tree version with this key, market and locale already exists. ' +
            'Retry: the version number is derived from what is stored.',
        );
      }
      throw error;
    }
  });
}

/**
 * Replace a draft tree's whole node set.
 *
 * The lifecycle is checked here AND refused by the freeze trigger. That is not
 * belt and braces for its own sake: this check produces a legible 409 with a
 * remedy, and the trigger is what holds against `psql`, a future call site and
 * whatever runs the day this function is refactored.
 */
export async function replaceNavigationTreeNodes(
  db: Database,
  treeId: string,
  nodes: readonly NewNavigationNode[],
): Promise<number> {
  return db.transaction(async (tx) => {
    const tree = await findNavigationTreeById(tx, treeId);
    if (tree === undefined) throw notFound('Navigation tree not found');
    if (tree.lifecycle !== 'draft') {
      throw conflict(
        'A published navigation tree is frozen. Create a new version and publish that instead.',
      );
    }
    try {
      return await replaceNavigationNodes(tx, treeId, nodes);
    } catch (error) {
      if (isCheckViolation(error)) {
        throw validationError(
          'The node set was refused by the database: check that every node targets exactly one ' +
            'thing, that sibling positions are unique, and that no parent chain forms a cycle.',
        );
      }
      throw error;
    }
  });
}

/** Publish a draft tree over a window. */
export async function publishNavigationTree(
  db: Database,
  params: PublishNavigationTreeParams,
): Promise<{ readonly treeId: string; readonly effectiveFrom: Date }> {
  const now = new Date();
  const effectiveFrom = params.effectiveFrom ?? now;
  if (params.effectiveTo !== undefined && params.effectiveTo.getTime() <= effectiveFrom.getTime()) {
    throw validationError('A navigation tree window must end after it begins');
  }

  return db.transaction(async (tx) => {
    const tree = await findNavigationTreeById(tx, params.treeId);
    if (tree === undefined) throw notFound('Navigation tree not found');
    if (tree.lifecycle !== 'draft') {
      throw conflict('Only a draft navigation tree can be published');
    }

    // Serialize against another publication on the same surface BEFORE reading
    // what is live: the exclusion trigger is a refusal, not a mutual exclusion,
    // and two racers that both read "nothing live" would both pass it.
    await lockPublishedTreesForSurface(tx, {
      market: tree.market,
      locale: tree.locale,
      surface: tree.surface,
    });

    // A vacuity floor, and a label floor. Both are about a publication that
    // reports success and renders nothing.
    const audit = await countNavigationNodesWithoutLabel(
      tx,
      tree.id,
      navigationFallbackChain(tree.locale),
    );
    if (audit.nodeCount === 0) {
      throw validationError(
        'A navigation tree with no nodes cannot be published: the surface would render nothing ' +
          'while reporting that it is live.',
      );
    }
    if (audit.unlabelled.length > 0) {
      throw validationError(
        `These navigation nodes have no label in ${tree.locale} or its fallback chain and would ` +
          `render as their keys: ${audit.unlabelled.join(', ')}`,
      );
    }

    if (params.supersedeLive === true) {
      const live = await findLiveNavigationTrees(tx, {
        market: tree.market,
        locale: tree.locale,
        surface: tree.surface,
        at: effectiveFrom,
      });
      for (const incumbent of live) {
        // Only a tree that is ALREADY running at the new window's start is
        // ended there. One scheduled to start later cannot be ended before it
        // begins — the window CHECK refuses it — and silently deleting somebody
        // else's scheduled campaign is not what "supersede the live one" means.
        await endNavigationTreeWindow(tx, incumbent.id, effectiveFrom);
      }
    }

    try {
      const updated = await markNavigationTreePublished(tx, {
        treeId: tree.id,
        publishedByOxyUserId: params.actorOxyUserId,
        publishedAt: now,
        effectiveFrom,
        ...(params.effectiveTo === undefined ? {} : { effectiveTo: params.effectiveTo }),
      });
      if (updated === 0) {
        throw conflict('The navigation tree left draft while it was being published');
      }
    } catch (error) {
      if (isCheckViolation(error)) {
        throw conflict(
          'Another navigation tree is already published for this market, locale and surface over ' +
            'an overlapping window. Publish with `supersedeLive` to end it where this one begins.',
        );
      }
      throw error;
    }
    return { treeId: tree.id, effectiveFrom };
  });
}

/** Archive a published tree. It stays readable; it stops being live. */
export async function archiveNavigationTree(db: Database, treeId: string): Promise<void> {
  const archived = await markNavigationTreeArchived(db, treeId);
  if (archived === 0) {
    throw conflict('Only a published navigation tree can be archived');
  }
}

/**
 * Delete a DRAFT tree.
 *
 * A published or archived tree is history and is refused here and by the
 * trigger. A draft is not history — nobody saw it — and leaving abandoned drafts
 * forever would make the authoring surface unusable.
 */
export async function deleteNavigationTreeDraft(db: Database, treeId: string): Promise<void> {
  const deleted = await deleteDraftNavigationTree(db, treeId);
  if (deleted === 0) {
    throw conflict('Only a draft navigation tree can be deleted');
  }
}

/** Create a saved query and its attribute filters. */
export async function createNavigationSavedQuery(
  db: Database,
  input: NewNavigationSavedQuery,
): Promise<string> {
  return db.transaction(async (tx) => {
    try {
      return await insertNavigationSavedQuery(tx, input);
    } catch (error) {
      if (isCheckViolation(error)) {
        throw conflict(
          'A saved query with this key already exists, or its filters were refused: a price ' +
            'bound needs one currency for both ends, and every attribute filter needs a value.',
        );
      }
      throw error;
    }
  });
}
