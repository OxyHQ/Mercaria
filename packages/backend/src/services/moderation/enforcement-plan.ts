/**
 * Deciding what Mercaria will do about a decision — and nothing else.
 *
 * Pure: no database, no clock, no configuration. A decision in, a plan out. That
 * is what makes the mapping testable as a table rather than as an integration
 * scenario, and it is why `observe` mode is a real audit rather than a comment —
 * the plan is computed identically in every mode and only its EXECUTION is gated.
 *
 * ## Mercaria maps recommendations, not findings
 *
 * The jury classified the material and the consensus engine turned that into a
 * recommendation under a VERSIONED policy. An application that re-derived its
 * action from raw severity would be quietly re-deciding the case with a second,
 * unversioned policy of its own, and the two would diverge the first time
 * CrowdSource updated theirs. Severity is a fallback only, for a `violation` that
 * arrives with no recommendation at all — because a violation Mercaria did
 * nothing about would be worse than a roughly-mapped one.
 *
 * ## Mercaria is the first Oxy application where the commerce actions are real
 *
 * `freeze_transaction` and `request_changes` exist in the baseline taxonomy and
 * every other Oxy app maps them to `manual_review`, because a social network has
 * no order to freeze and no draft to send a listing back to. A marketplace has
 * both, and they are genuinely DIFFERENT levers rather than synonyms for removal:
 *
 * - `restrict` stops FUTURE sales. `status: 'restricted'` fails every catalogue
 *   read (all of which filter `status: 'active'`), the cart marks the line stale,
 *   and checkout refuses stale lines.
 * - `freeze_transaction` stops money and goods ALREADY IN FLIGHT. Restricting a
 *   listing does nothing to an order placed yesterday that is about to ship, so
 *   this holds the orders themselves and `order.service.transition` refuses to
 *   advance a held one.
 * - `request_changes` is the middle ground only commerce has: the listing goes
 *   back to `draft` and the seller is told. It takes the item down without a
 *   finding against the seller, and — unlike `restrict` — THEY can fix it and
 *   republish. Mapping this to removal would throw away the one outcome that
 *   ends with a compliant listing and a seller who learned something.
 *
 * ## What Mercaria deliberately cannot do
 *
 * `label`, `age_gate` and `reduce_distribution` all ask for a middle setting
 * between "listed" and "not listed", and Mercaria has none: there is no sensitive
 * flag on a listing and no distribution dial, only the `status: 'active'` gate
 * that every read shares. Mapping them to `restrict` would over-enforce — removing
 * an item a jury asked to merely label — and mapping them to `none` would record
 * an effect that did not happen. So they go to a human, and the record says which
 * recommendation the human is being asked about.
 */

import type { Decision, RecommendedAction, Severity } from '@oxyhq/crowdsource-contracts';
import type { ModerationEnforcementAction } from '@mercaria/shared-types';

export interface PlannedEnforcementAction {
  readonly action: ModerationEnforcementAction;
  /** Why, in words an operator reads. Never reported material. */
  readonly reason: string;
  /** The recommendation this came from, when it came from one. */
  readonly recommendedAction?: RecommendedAction;
}

/**
 * What each recommended action becomes in Mercaria.
 *
 * A total `Record`, so a recommendation added to the contract stops compiling here
 * rather than silently falling through to a default. Deciding what a new
 * recommendation means is a policy question, and it should be answered on purpose.
 */
const RECOMMENDATION_TO_ACTION: Readonly<
  Record<RecommendedAction, ModerationEnforcementAction>
> = Object.freeze({
  remove: 'restrict',
  remove_or_restrict: 'restrict',
  hide: 'restrict',

  /** The commerce levers, real here for the first time. */
  request_changes: 'request_changes',
  freeze_transaction: 'freeze_transaction',

  allow: 'none',
  no_action: 'none',
  no_global_effect: 'none',
  restore: 'restore',

  /**
   * Asks for a middle setting Mercaria does not have. A human decides, and the
   * row records which recommendation they are answering.
   */
  label: 'manual_review',
  allow_with_label: 'manual_review',
  age_gate: 'manual_review',
  reduce_distribution: 'manual_review',

  /** Levers Mercaria does not hold at all. `suspend_user` is Oxy's. */
  suspend_user: 'manual_review',
  request_more_context: 'manual_review',
  hold: 'manual_review',
  local_manual_review: 'manual_review',
  keep_restricted_temporarily: 'manual_review',
  escalate: 'manual_review',
  specialist_queue: 'manual_review',
  legal_queue: 'manual_review',
  safety_queue: 'manual_review',
});

/**
 * The action a violation gets when the decision recommended nothing.
 *
 * Severity only, and deliberately cautious at BOTH ends. A `low`-severity
 * violation with no recommendation is not something to delist a seller's item
 * over, and `critical` goes to a human rather than straight to removal: critical
 * material routes to a specialist team under legal protocol, and an automatic
 * removal driven by a webhook is not that. The difference is a policy decision
 * with legal weight, and a mapping table is the wrong place to make it.
 */
const SEVERITY_FALLBACK: Readonly<Record<Severity, ModerationEnforcementAction>> =
  Object.freeze({
    critical: 'manual_review',
    high: 'restrict',
    medium: 'request_changes',
    low: 'manual_review',
  });

const SEVERITY_ORDER: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

function highestSeverity(decision: Decision): Severity | undefined {
  let highest: Severity | undefined;
  for (const finding of decision.findings) {
    if (
      highest === undefined ||
      SEVERITY_ORDER.indexOf(finding.severity) > SEVERITY_ORDER.indexOf(highest)
    ) {
      highest = finding.severity;
    }
  }
  return highest;
}

/**
 * `no_violation` always carries a restore, whatever it recommended.
 *
 * This exists because of a failure that is very easy to ship and very hard to see.
 * A correction — an accepted appeal — is a new revision whose outcome is
 * `no_violation`, and its recommendation is frequently `no_action`, which means
 * "take no NEW action" rather than "leave what you already did in place". Mapping
 * that straight through plans `none`, and the listing an earlier revision
 * restricted stays delisted forever: the appeal succeeded, the case says the item
 * was fine, and nothing in Mercaria ever puts it back on sale. No error, no log
 * line, no failing test anywhere else.
 *
 * The plan therefore always includes the restore, and the executor records "there
 * was nothing restricted" when that is the case — which is evidence, rather than a
 * silent no-op.
 */
function withRestoreForNoViolation(
  decision: Decision,
  planned: readonly PlannedEnforcementAction[],
): readonly PlannedEnforcementAction[] {
  if (decision.outcome !== 'no_violation') return planned;
  if (planned.some((entry) => entry.action === 'restore')) return planned;
  return [
    ...planned,
    { action: 'restore', reason: 'No violation: undo any earlier restriction' },
  ];
}

/**
 * Collapse a plan to the actions that can coexist.
 *
 * A decision may recommend both removal and a change request; a restricted listing
 * is not also awaiting the seller's edits, and recording both would claim two
 * effects where one happened. `restrict` therefore absorbs `request_changes`,
 * `none` and `restore`.
 *
 * `freeze_transaction` SURVIVES alongside `restrict`, and that is the one pairing
 * worth stating explicitly: they act on different objects. Restricting the listing
 * stops new orders; freezing stops the ones already placed. Collapsing them the
 * way a social app collapses "remove" and "label" would leave a delisted
 * counterfeit item whose in-flight orders ship anyway.
 *
 * `manual_review` always survives too — it is a note for a human, and dropping it
 * because something else was also done is how a `suspend_user` recommendation gets
 * lost.
 */
function collapse(
  actions: readonly PlannedEnforcementAction[],
): PlannedEnforcementAction[] {
  const byAction = new Map<ModerationEnforcementAction, PlannedEnforcementAction>();
  for (const planned of actions) {
    if (!byAction.has(planned.action)) byAction.set(planned.action, planned);
  }

  if (byAction.has('restrict')) {
    byAction.delete('request_changes');
    byAction.delete('none');
    byAction.delete('restore');
  }
  if (byAction.size > 1) byAction.delete('none');

  return Array.from(byAction.values());
}

/**
 * What Mercaria will do about this decision.
 *
 * Never empty: a decision that produces no action produces an explicit `none`,
 * because a row saying "we decided to do nothing, and why" is evidence and an
 * absent row is a question.
 */
export function planEnforcement(decision: Decision): PlannedEnforcementAction[] {
  const fromRecommendations = decision.recommendedActions.map(
    (recommended): PlannedEnforcementAction => ({
      action: RECOMMENDATION_TO_ACTION[recommended.action] ?? 'manual_review',
      reason: `CrowdSource recommended ${recommended.action}`,
      recommendedAction: recommended.action,
    }),
  );

  if (fromRecommendations.length > 0) {
    const collapsed = collapse(withRestoreForNoViolation(decision, fromRecommendations));
    return collapsed.length > 0
      ? collapsed
      : [{ action: 'none', reason: 'No recommended action maps to a Mercaria effect' }];
  }

  switch (decision.outcome) {
    case 'violation': {
      const severity = highestSeverity(decision);
      /**
       * A `violation` with no findings cannot happen — the contract refuses it —
       * so an absent severity here means a newer CrowdSource sent something this
       * code has not seen. A human looks at it rather than a default delisting a
       * seller's item.
       */
      if (severity === undefined) {
        return [
          {
            action: 'manual_review',
            reason: 'Violation carried no finding severity this version understands',
          },
        ];
      }
      return [
        {
          action: SEVERITY_FALLBACK[severity],
          reason: `Violation with no recommended action, highest severity ${severity}`,
        },
      ];
    }

    case 'no_violation':
      return [{ action: 'restore', reason: 'No violation: undo any earlier restriction' }];

    case 'insufficient_context':
    case 'inconclusive':
    case 'escalated':
      /**
       * Absence of consensus is neither guilt nor innocence, so Mercaria changes
       * nothing on its own and asks a human.
       */
      return [
        {
          action: 'manual_review',
          reason: `Outcome ${decision.outcome}: no automatic action, internal review`,
        },
      ];

    case 'content_unavailable':
    case 'duplicate':
      return [{ action: 'none', reason: `Outcome ${decision.outcome}: nothing to enforce` }];

    default:
      /**
       * An outcome this version does not define. A newer server must not break an
       * older client, and the safe reading of an unknown outcome is a human, never
       * a default effect.
       */
      return [
        {
          action: 'manual_review',
          reason: 'Decision outcome not recognised by this version of Mercaria',
        },
      ];
  }
}
