/**
 * Observing and auditing capability transitions (#85 security 10,
 * readiness-change rule 8).
 *
 * ## Why an OBSERVATION and not an event
 *
 * The verdict is derived from eleven tables in eight domains, and not one of
 * those domains knows this one exists. Stripe restricting an account, a
 * connector failing, a jury restricting a catalogue and a fee schedule being
 * superseded are all activation transitions with no actor and no hook — so the
 * only honest way to audit them is to look, compare against what was last seen,
 * and record the difference. That is what this does, and it is why the recorded
 * actor is `system` for everything the sweep finds.
 *
 * Adding a hook from each of those domains was rejected for the reason #57's
 * offer converger gives about a fourth status-only write path: eight callers
 * that must all remember is seven ways to have an unaudited transition, and the
 * one that forgets is invisible.
 *
 * ## The recording is never read by a decision
 *
 * `merchant_activation_capability_events` says what the derivation said when
 * somebody last looked. Nothing gates on it — a cached `granted` survives
 * exactly the restriction that should have withdrawn it — and
 * `merchant-activation-isolation.test.ts` fails the build if a derivation, a
 * gate or a projection starts selecting from it.
 *
 * ## Serialization is the settings row's lock, not a lease table
 *
 * Two observers reading the same previous state would both write a transition.
 * The writer takes `FOR UPDATE` on the store's settings row first — a row that
 * must exist for any observation to be recorded — so per-store observation is
 * serialized without inventing a lease of its own.
 */

import type {
  MerchantActivationActorKind,
  MerchantActivationCause,
  MerchantActivationTransition,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { log } from '../../lib/logger.js';
import {
  listActivationSettingsStoreIdsAfter,
  lockMerchantActivationSettings,
} from '../../db/merchantActivation/activationSettingsRepository.js';
import {
  insertCapabilityEvents,
  listCapabilityEvents,
  readLatestCapabilityStates,
  type NewMerchantActivationCapabilityEvent,
} from '../../db/merchantActivation/capabilityEventRepository.js';
import { deriveMerchantActivation } from './activation.service.js';

/** Who is looking, and why. */
export interface ObservationActor {
  readonly kind: MerchantActivationActorKind;
  /** Mandatory for `merchant` and `operator`, forbidden for `system` — a CHECK. */
  readonly oxyUserId: string | null;
  readonly cause: MerchantActivationCause;
}

/**
 * Observe one store and record every capability whose state MOVED.
 *
 * Returns how many transitions were written, which is the number a caller
 * reports and the number a test asserts against a non-zero floor — an
 * observation that recorded nothing and an observation that never ran produce
 * the same empty history otherwise.
 *
 * A store that does not exist records nothing rather than raising: the sweep
 * pages over settings rows and a store can be deleted between the page and the
 * observation.
 */
export async function observeMerchantActivation(
  storeId: string,
  actor: ObservationActor,
): Promise<number> {
  const derived = await deriveMerchantActivation(storeId);
  if (!derived) return 0;

  return getDb().transaction(async (tx) => {
    await lockMerchantActivationSettings(tx, storeId);
    const previous = await readLatestCapabilityStates(tx, storeId);

    const events: NewMerchantActivationCapabilityEvent[] = [];
    for (const capability of derived.capabilities) {
      const before = previous.get(capability.capability) ?? null;
      if (before === capability.state) continue;
      events.push({
        storeId,
        capability: capability.capability,
        previousState: before,
        nextState: capability.state,
        unmet: capability.unmet,
        actorKind: actor.kind,
        actorOxyUserId: actor.kind === 'system' ? null : actor.oxyUserId,
        cause: actor.cause,
      });
    }
    return insertCapabilityEvents(tx, events);
  });
}

/**
 * The bounded, resumable sweep — the only thing that audits a transition nobody
 * caused.
 *
 * It pages over SETTINGS rows rather than over stores, which is what bounds it
 * to the merchants activation actually applies to: a store nobody has ever
 * written a setting for has also never had a capability observed, so there is no
 * previous state to transition from and nothing an audit could be missing.
 *
 * The cursor is the store id and the order is by id, so a run resumes exactly
 * where it stopped. There is deliberately no lease: two tasks sweeping
 * concurrently both take the per-store row lock, so the worst case is duplicated
 * work rather than a duplicated transition.
 */
export async function sweepMerchantActivation(): Promise<{ stores: number; transitions: number }> {
  const batchSize = config.merchantActivation.observationBatchSize;
  let cursor: string | null = null;
  let stores = 0;
  let transitions = 0;

  for (;;) {
    const page: readonly string[] = await listActivationSettingsStoreIdsAfter(cursor, batchSize);
    if (page.length === 0) break;
    for (const storeId of page) {
      stores += 1;
      transitions += await observeMerchantActivation(storeId, {
        kind: 'system',
        oxyUserId: null,
        cause: 'scheduled_observation',
      });
    }
    cursor = page[page.length - 1] ?? null;
    if (page.length < batchSize) break;
  }
  return { stores, transitions };
}

/**
 * Start the observation loop.
 *
 * Gates the LOOP and never a row — every transition a merchant or an operator
 * causes is still recorded by the write that caused it, and the derivation is
 * unaffected because it is derived. `unref` so a stalled timer cannot hold jest
 * or a shutdown open.
 */
export function startMerchantActivationObserver(): void {
  if (!config.merchantActivation.observationEnabled) {
    log.general.info('[Activation] observation sweep disabled');
    return;
  }
  const interval = setInterval(() => {
    void sweepMerchantActivation()
      .then((result) => {
        if (result.transitions > 0) {
          log.general.info(result, '[Activation] observation sweep recorded transitions');
        }
      })
      .catch((err: unknown) => {
        log.general.error({ err }, '[Activation] observation sweep failed');
      });
  }, config.merchantActivation.observationIntervalMs);
  interval.unref?.();
}

/** One store's transition history, projected for the operator trace. */
export async function readActivationTransitions(
  storeId: string,
  limit: number,
): Promise<readonly MerchantActivationTransition[]> {
  const rows = await listCapabilityEvents(storeId, limit);
  return rows.map((row) => ({
    storeId: row.storeId,
    capability: row.capability,
    previousState: row.previousState,
    nextState: row.nextState,
    unmet: row.unmet as MerchantActivationTransition['unmet'],
    actorKind: row.actorKind,
    actorOxyUserId: row.actorOxyUserId,
    cause: row.cause,
    observedAt: row.createdAt.toISOString(),
  }));
}
