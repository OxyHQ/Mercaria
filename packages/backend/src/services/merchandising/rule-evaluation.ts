/**
 * Where every merchandising rule of a store stands at ONE instant — pure, so a
 * schedule is tested by passing a clock rather than by waiting for one.
 *
 * Schedules are evaluated when the store page is READ. There is no worker and no
 * stored "is live" flag: a stored verdict would be a second representation of
 * `starts_at`/`ends_at` that a missed sweep could leave wrong
 * (`docs/house-invariants.md`, one stored verdict per fact).
 *
 * ## Precedence
 *
 * - **`sort`** — one rule applies per target (the whole store, or one
 *   collection). Among the live ones the rule whose window STARTED LATEST wins,
 *   an open start counting as the earliest; ties go to the newer rule. So a
 *   scheduled weekend override beats the always-on default without the merchant
 *   pausing anything, and the default is back the moment the override ends.
 *   The others are `superseded`.
 * - **`spotlight`** — up to {@link MAX_LIVE_MERCHANDISING_SPOTLIGHTS} show, most
 *   recently started first; any beyond are `superseded`.
 */

import {
  MAX_LIVE_MERCHANDISING_SPOTLIGHTS,
  type MerchandisingRuleStatus,
} from '@mercaria/shared-types';
import type { MerchandisingRuleRow } from '../../db/merchandising/merchandisingRuleRepository.js';

/** The fields evaluation reads — a row satisfies it, and so does a test's literal. */
export type EvaluatedRuleInput = Pick<
  MerchandisingRuleRow,
  'id' | 'kind' | 'target' | 'collectionId' | 'enabled' | 'startsAt' | 'endsAt' | 'createdAt'
>;

/** Where one rule stands, ignoring every other rule. */
export function windowStatus(
  rule: EvaluatedRuleInput,
  at: Date,
): Exclude<MerchandisingRuleStatus, 'superseded'> {
  if (rule.target === 'collection' && rule.collectionId === null) return 'detached';
  if (!rule.enabled) return 'paused';
  if (rule.startsAt !== null && at.getTime() < rule.startsAt.getTime()) return 'scheduled';
  if (rule.endsAt !== null && at.getTime() >= rule.endsAt.getTime()) return 'ended';
  return 'live';
}

/** The key one `sort` rule competes on: one winner per key. */
function targetKey(rule: EvaluatedRuleInput): string {
  return rule.target === 'store' ? 'store' : `collection:${rule.collectionId}`;
}

/** Latest-started first; an open start is the earliest; then newest; then id, so it is total. */
function byPrecedence(a: EvaluatedRuleInput, b: EvaluatedRuleInput): number {
  const startA = a.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const startB = b.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (startA !== startB) return startB - startA;
  const createdA = a.createdAt.getTime();
  const createdB = b.createdAt.getTime();
  if (createdA !== createdB) return createdB - createdA;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Every rule's status at `at`, with precedence applied. */
export function evaluateRules<T extends EvaluatedRuleInput>(
  rules: readonly T[],
  at: Date,
): Map<string, MerchandisingRuleStatus> {
  const statuses = new Map<string, MerchandisingRuleStatus>();
  const liveSorts = new Map<string, T[]>();
  const liveSpotlights: T[] = [];

  for (const rule of rules) {
    const status = windowStatus(rule, at);
    statuses.set(rule.id, status);
    if (status !== 'live') continue;
    if (rule.kind === 'sort') {
      const key = targetKey(rule);
      liveSorts.set(key, [...(liveSorts.get(key) ?? []), rule]);
    } else {
      liveSpotlights.push(rule);
    }
  }

  for (const contenders of liveSorts.values()) {
    const [, ...losers] = [...contenders].sort(byPrecedence);
    for (const loser of losers) statuses.set(loser.id, 'superseded');
  }
  const shown = [...liveSpotlights].sort(byPrecedence);
  for (const hidden of shown.slice(MAX_LIVE_MERCHANDISING_SPOTLIGHTS)) {
    statuses.set(hidden.id, 'superseded');
  }

  return statuses;
}

/** The rules that apply at `at`: the winning `sort` per target and the shown spotlights, in display order. */
export function applyingRules<T extends EvaluatedRuleInput>(
  rules: readonly T[],
  at: Date,
): { sorts: T[]; spotlights: T[] } {
  const statuses = evaluateRules(rules, at);
  const live = rules.filter((rule) => statuses.get(rule.id) === 'live');
  return {
    sorts: live.filter((rule) => rule.kind === 'sort'),
    spotlights: live.filter((rule) => rule.kind === 'spotlight').sort(byPrecedence),
  };
}
