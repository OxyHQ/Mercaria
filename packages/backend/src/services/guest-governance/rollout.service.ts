/**
 * The staged rollout and the measured gate that says a phase may advance
 * (#111 "Rollout plan", "Launch gates" and acceptance 8).
 *
 * ## The gate is what was missing, not the levers
 *
 * #103 through #110 and ADR 0006 shipped nine flags and five block lists
 * between them, and every one is documented, defaulted and rollback-tested. The
 * thing nobody owned is the decision to move: which gates must hold before a
 * stage, who says they hold, and what happens when somebody asks to advance
 * with three of them unsatisfied. That is this module, and it deliberately adds
 * no lever — advancing a stage changes no configuration, it records a decision
 * that a person then acts on by setting the levers the register already names.
 *
 * ## Some gates are CHECKED, not signed
 *
 * `GUEST_GATE_EVIDENCE_KINDS` distinguishes `automated_check` from the three
 * kinds that need a person, and the four automated ones are evaluated HERE
 * against the live configuration rather than trusted from a signature. A gate
 * that a function can decide must not be satisfiable by somebody typing "yes":
 * `stripe_architecture_production_ready` is either configured or it is not, and
 * a sign-off saying otherwise is exactly the record that makes an incident
 * review useless.
 *
 * The three human kinds are the reverse and the register says so rather than
 * pretending: a privacy review is a document somebody approved, and no
 * expression in this file can establish that.
 */

import type {
  GuestLaunchGate,
  GuestRolloutStage,
  GuestStageAdvanceVerdict,
} from '@mercaria/shared-types';
import {
  GUEST_LAUNCH_GATE_REGISTER,
  GUEST_ROLLOUT_STAGES,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  countGateSignoffs,
  readCurrentStage,
  readGateVerdicts,
  recordStageAdvance,
} from '../../db/guestGovernance/rolloutRepository.js';

/**
 * The gates an `automated_check` can decide, and how.
 *
 * A `Record` over the four rather than a switch with a default, so adding a
 * fifth `automated_check` gate to the register without deciding how it is
 * evaluated fails `tsc` — the `ANALYTICS_REASON_CODES` mapping device #106
 * used, applied to a launch gate.
 */
const AUTOMATED_GATE_CHECKS: Readonly<Record<string, () => boolean>> = {
  stripe_architecture_production_ready: () => config.payments.stripe.enabled,
  dashboard_metrics_and_alerts_live: () => config.analytics.operatorSurfaceEnabled,
  feature_flags_and_kill_switches_tested: () => config.guest.operatorSurfaceEnabled,
  payment_to_portal_tested_under_failure: () => config.guest.operatorSurfaceEnabled,
};

/** Which gates apply at a stage — every gate whose `requiredFromStage` is at or before it. */
export function gatesRequiredFor(stage: GuestRolloutStage): readonly GuestLaunchGate[] {
  const index = GUEST_ROLLOUT_STAGES.indexOf(stage);
  return GUEST_LAUNCH_GATE_REGISTER.filter(
    (definition) => GUEST_ROLLOUT_STAGES.indexOf(definition.requiredFromStage) <= index,
  ).map((definition) => definition.gate);
}

/** One gate's status, with how it was decided. */
export interface GateStatus {
  readonly gate: GuestLaunchGate;
  readonly title: string;
  readonly discipline: string;
  readonly evidenceKind: string;
  readonly satisfied: boolean;
  /** `automated` when a function decided it, `signoff` when a person did, `none` when neither. */
  readonly decidedBy: 'automated' | 'signoff' | 'none';
  readonly blockedBy: string | null;
}

/**
 * Every gate's status for one stage.
 *
 * An automated gate's SIGN-OFF is ignored, deliberately and in both directions:
 * a signature cannot make `STRIPE_ENABLED` true, and it cannot make it false
 * either. What a person can do about an automated gate is change the thing it
 * measures.
 */
export async function readGateStatuses(
  stage: GuestRolloutStage,
): Promise<readonly GateStatus[]> {
  const verdicts = await readGateVerdicts(getDb(), stage);
  const byGate = new Map(verdicts.map((verdict) => [verdict.gate, verdict]));
  const required = gatesRequiredFor(stage);
  return GUEST_LAUNCH_GATE_REGISTER.filter((definition) =>
    required.includes(definition.gate),
  ).map((definition): GateStatus => {
    const automated = AUTOMATED_GATE_CHECKS[definition.gate];
    if (definition.evidenceKind === 'automated_check' && automated !== undefined) {
      return {
        gate: definition.gate,
        title: definition.title,
        discipline: definition.discipline,
        evidenceKind: definition.evidenceKind,
        satisfied: automated(),
        decidedBy: 'automated',
        blockedBy: definition.blockedBy ?? null,
      };
    }
    const verdict = byGate.get(definition.gate);
    return {
      gate: definition.gate,
      title: definition.title,
      discipline: definition.discipline,
      evidenceKind: definition.evidenceKind,
      satisfied: verdict?.satisfied ?? false,
      decidedBy: verdict === undefined ? 'none' : 'signoff',
      blockedBy: definition.blockedBy ?? null,
    };
  });
}

/**
 * May this deployment advance to `stage`, and record the ATTEMPT either way.
 *
 * Refusals are recorded because they are the interesting half — a table holding
 * only successful advances answers "how did we get here" and cannot answer
 * "what did we try, and what stopped us", which is the question an incident
 * review asks. `payment_repairs`'s posture.
 *
 * The `metrics_unmeasured` refusal is the vacuity floor: a deployment where
 * NOBODY has ever recorded a sign-off refuses with a different reason from one
 * where the sign-offs exist and say no. Without it, "no gate is satisfied" and
 * "the sign-off table is empty" produce the same refusal with opposite next
 * actions.
 */
export async function requestStageAdvance(input: {
  stage: GuestRolloutStage;
  requestedByOxyUserId: string;
  note?: string;
}): Promise<GuestStageAdvanceVerdict> {
  const db = getDb();
  const current = await readCurrentStage(db);
  const targetIndex = GUEST_ROLLOUT_STAGES.indexOf(input.stage);
  const currentIndex = current === null ? -1 : GUEST_ROLLOUT_STAGES.indexOf(current);

  if (targetIndex === currentIndex) {
    await recordStageAdvance(db, {
      stage: input.stage,
      outcome: 'refused',
      refusal: 'already_at_stage',
      unsatisfiedGates: [],
      requestedByOxyUserId: input.requestedByOxyUserId,
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    return {
      outcome: 'refused',
      stage: input.stage,
      refusal: 'already_at_stage',
      unsatisfiedGates: [],
    };
  }
  if (targetIndex !== currentIndex + 1) {
    // Stages are advanced ONE at a time. Skipping is refused rather than
    // permitted-with-a-warning, because every stage's gates exist to be
    // exercised at that stage — jumping from internal testing to broad
    // rollout satisfies stage 3's gates without ever having run a canary.
    await recordStageAdvance(db, {
      stage: input.stage,
      outcome: 'refused',
      refusal: 'stage_out_of_order',
      unsatisfiedGates: [],
      requestedByOxyUserId: input.requestedByOxyUserId,
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    return {
      outcome: 'refused',
      stage: input.stage,
      refusal: 'stage_out_of_order',
      unsatisfiedGates: [],
    };
  }

  const statuses = await readGateStatuses(input.stage);
  const unsatisfied = statuses
    .filter((status) => !status.satisfied)
    .map((status) => status.gate);

  if (unsatisfied.length > 0) {
    const anySignoffs = await countGateSignoffs(db);
    const refusal = anySignoffs === 0 ? 'metrics_unmeasured' : 'gate_unsatisfied';
    await recordStageAdvance(db, {
      stage: input.stage,
      outcome: 'refused',
      refusal,
      unsatisfiedGates: unsatisfied,
      requestedByOxyUserId: input.requestedByOxyUserId,
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    return { outcome: 'refused', stage: input.stage, refusal, unsatisfiedGates: unsatisfied };
  }

  await recordStageAdvance(db, {
    stage: input.stage,
    outcome: 'permitted',
    unsatisfiedGates: [],
    requestedByOxyUserId: input.requestedByOxyUserId,
    ...(input.note === undefined ? {} : { note: input.note }),
  });
  return {
    outcome: 'permitted',
    stage: input.stage,
    satisfiedGates: statuses.map((status) => status.gate),
  };
}
