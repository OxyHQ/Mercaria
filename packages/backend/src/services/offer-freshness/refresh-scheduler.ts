/**
 * Deciding WHAT gets re-read and in what order (#68 §"Scheduler and jobs" 1–2).
 *
 * ## Capability first, priority second
 *
 * A refresh mode is a fact about somebody else's API. `chooseRefreshMode` reads
 * the ADAPTER's declaration, narrowed by the source's own policy, and returns
 * `undefined` when nothing survives — which is a refusal an operator can read
 * rather than a snapshot nobody's feed can perform. Narrowing only: a policy
 * listing `full_snapshot` for an adapter that cannot enumerate does not make it
 * able to, and treating a policy as permission would let a Mercaria row
 * authorise retiring a catalogue on a search result.
 *
 * ## Priority is a request, never a promise
 *
 * `requestPriorityRefresh` enqueues a durable row and returns. It takes no
 * lease, makes no provider call and cannot fail because a quota is spent —
 * "gate the LOOP, never the durable record", so an alert raised while the
 * dispatcher is off is served when it comes back rather than lost.
 *
 * The four reasons are ordered by `highestRefreshPriority` and every one
 * of them is kept beside the winner, so a queue an operator is looking at says
 * WHY each row is where it is. Popularity, clicks and alerts are supplied by
 * their owners (#77 measures popularity, #37 owns outbound clicks, #78/#79 own
 * alerts) — this module publishes the entry point and never invents a signal,
 * which `freshness-isolation.test.ts` pins by refusing this domain any import
 * of the analytics, referral or ranking layers.
 */

import type { CatalogRefreshMode, OfferRefreshPriorityClass } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { findCatalogSourceConfig } from '../../db/ingestion/catalogSourceConfigRepository.js';
import {
  enqueueRefreshTask,
  type OfferRefreshTaskRow,
} from '../../db/offerFreshness/refreshTaskRepository.js';
import { resolveCatalogSourceAdapter } from '../ingestion/registry.js';
import { resolveSourceFreshnessPolicy } from './policy.js';

/**
 * Which mode a whole-source pass should run in.
 *
 * The order of preference is the order of INFORMATION: a complete snapshot
 * establishes absence and is the only mode that can retire, an incremental pass
 * carries changes, a query-driven pass re-reads what a search would return. A
 * source that can do none of them yields `undefined`.
 *
 * `wantsSnapshot` is the caller's ask, not an override: a caller that wants a
 * snapshot from an adapter that cannot enumerate gets the next best mode rather
 * than a snapshot that would lie about its own completeness.
 */
export function chooseRefreshMode(input: {
  adapterModes: readonly CatalogRefreshMode[];
  /** EMPTY means unrestricted — the `territories` semantics, one domain over. */
  permittedModes: readonly CatalogRefreshMode[];
  wantsSnapshot: boolean;
}): CatalogRefreshMode | undefined {
  const permitted = (mode: CatalogRefreshMode): boolean =>
    input.adapterModes.includes(mode) &&
    (input.permittedModes.length === 0 || input.permittedModes.includes(mode));

  if (input.wantsSnapshot && permitted('full_snapshot')) return 'full_snapshot';
  if (permitted('incremental')) return 'incremental';
  if (permitted('query_driven')) return 'query_driven';
  if (permitted('full_snapshot')) return 'full_snapshot';
  return undefined;
}

/** Whether a source's adapter can re-read one named object (#68 scheduler 2). */
export function supportsTargetedRefresh(input: {
  adapterModes: readonly CatalogRefreshMode[];
  permittedModes: readonly CatalogRefreshMode[];
}): boolean {
  return (
    input.adapterModes.includes('targeted') &&
    (input.permittedModes.length === 0 || input.permittedModes.includes('targeted'))
  );
}

/**
 * Ask for one external object to be re-read soon, because somebody cares.
 *
 * Durable and unconditional: the row is written whether or not an adapter is
 * registered, whether or not the loop is running and whether or not the
 * source's budget is spent. Refusing here would make an alert vanish because a
 * provider was busy, and the whole point of the queue is that it is not.
 *
 * The mode is `targeted` and the enqueue converges on
 * `(source, mode, subject)`, so five buyers watching one price owe ONE re-read.
 */
export async function requestPriorityRefresh(
  input: {
    sourceId: string;
    externalObjectKey: string;
    offerId?: string;
    reason: OfferRefreshPriorityClass;
    requestedByOxyUserId?: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<OfferRefreshTaskRow> {
  const now = input.now ?? new Date();
  return enqueueRefreshTask(db, {
    sourceId: input.sourceId,
    mode: 'targeted',
    externalObjectKey: input.externalObjectKey,
    ...(input.offerId === undefined ? {} : { offerId: input.offerId }),
    priorityReason: input.reason,
    // Immediately due. The queue's ORDER is what makes an alert beat a
    // scheduled sweep, not a shorter delay — a delay would only push it behind
    // rows that are already due.
    availableAt: now,
    ...(input.requestedByOxyUserId === undefined
      ? {}
      : { requestedByOxyUserId: input.requestedByOxyUserId }),
    now,
  });
}

/**
 * Schedule one source's next whole-source pass.
 *
 * Returns the task, or `undefined` when the source has no adapter or no mode
 * survives its policy — both of which are states an operator can see on the
 * health surface and fix, rather than errors to swallow.
 */
export async function scheduleSourceRefresh(
  input: {
    sourceId: string;
    wantsSnapshot: boolean;
    availableAt: Date;
    reason?: OfferRefreshPriorityClass;
    requestedByOxyUserId?: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<OfferRefreshTaskRow | undefined> {
  const now = input.now ?? new Date();
  const resolved = await resolveSourceFreshnessPolicy(input.sourceId, db);
  if (resolved === undefined) return undefined;

  const config = await findCatalogSourceConfig(db, input.sourceId);
  if (config === undefined) return undefined;

  const adapter = resolveCatalogSourceAdapter(config.provider);
  if (adapter === undefined) return undefined;

  const mode = chooseRefreshMode({
    adapterModes: adapter.refreshModes,
    permittedModes: resolved.permittedRefreshModes,
    wantsSnapshot: input.wantsSnapshot,
  });
  if (mode === undefined) return undefined;

  return enqueueRefreshTask(db, {
    sourceId: input.sourceId,
    mode,
    priorityReason: input.reason ?? 'scheduled',
    availableAt: input.availableAt,
    ...(input.requestedByOxyUserId === undefined
      ? {}
      : { requestedByOxyUserId: input.requestedByOxyUserId }),
    now,
  });
}
