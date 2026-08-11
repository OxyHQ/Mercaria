/**
 * The abuse decision (#111 "Abuse controls").
 *
 * ## The verdict is a union with a STRING discriminant
 *
 * The backend compiles with `strict: false`, and without `strictNullChecks`
 * TypeScript does not narrow a union on the truthiness of a boolean-literal
 * discriminant — the #68 finding, hit again by #110. A caller here must act on
 * the difference: `permitted` continues, `friction` refuses with an explicit,
 * bounded, dated measure the person is told about.
 *
 * ## What this module cannot do
 *
 * It cannot deny service silently, demote a ranking, reduce a merchant's
 * visibility, or read anything about a device.
 * {@link GUEST_FORBIDDEN_FRICTION_MEASURES} names the first three as VALUES
 * disjoint from the measures it may apply, and `subject.ts` is the only way a
 * subject enters — it takes a session id, a checkout id, an email hash or a
 * coarse network range, and nothing else.
 *
 * ## Counting happens BEFORE the flag is consulted, and that is deliberate
 *
 * `config.guest.governance.abuseControlsEnabled` gates whether FRICTION is
 * applied. It does not gate the counter, so a deployment that switched the
 * controls off during an incident can still see what was happening while they
 * were off, and turning them back on does not start from zero. Gate the loop,
 * never the durable record — applied to a control rather than to a queue.
 */

import type {
  GuestAbusePattern,
  GuestAbusePolicy,
  GuestAbuseScope,
  GuestFrictionMeasure,
} from '@mercaria/shared-types';
import { GUEST_ABUSE_POLICIES } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import {
  countAbuseAttempt,
  findLiveIntervention,
  recordIntervention,
} from '../../db/guestGovernance/abuseRepository.js';
import { abuseSubjectHash, windowStartFor } from './subject.js';
import { recordSecuritySignal } from './security-signals.service.js';

/** What an abuse check answers. */
export type GuestAbuseVerdict =
  | { readonly outcome: 'permitted' }
  | {
      readonly outcome: 'friction';
      readonly pattern: GuestAbusePattern;
      readonly measure: GuestFrictionMeasure;
      /** When the friction stops. The response carries it — a stated wait, never a silent one. */
      readonly retryAt: Date;
    };

/** The policy for one scope, or `undefined` where no pattern watches it. */
function policyForScope(scope: GuestAbuseScope): GuestAbusePolicy | undefined {
  return GUEST_ABUSE_POLICIES.find((policy) => policy.scope === scope);
}

/**
 * Count one action and decide whether friction applies.
 *
 * The order is: read the live intervention, then count, then compare. Reading
 * first matters — somebody already under a cooldown must be refused without
 * their refused attempt inflating the counter that produced the cooldown, or
 * every refusal extends the friction that caused it and a fifteen-minute wait
 * becomes permanent for anybody who retries.
 */
export async function checkGuestAbuse(input: {
  scope: GuestAbuseScope;
  /** The already-safe subject value: a session id, a checkout id, a hash or a range. */
  subjectValue: string;
  now: Date;
}): Promise<GuestAbuseVerdict> {
  const policy = policyForScope(input.scope);
  if (policy === undefined) return { outcome: 'permitted' };
  if (!config.guest.governance.abuseControlsEnabled) return { outcome: 'permitted' };

  const db = getDb();
  const subjectHash = abuseSubjectHash({
    scope: policy.scope,
    axis: policy.axis,
    value: input.subjectValue,
  });

  const live = await findLiveIntervention(db, {
    pattern: policy.pattern,
    subjectHash,
    now: input.now,
  });
  if (live !== null) {
    return {
      outcome: 'friction',
      pattern: live.pattern,
      measure: live.measure,
      retryAt: live.expiresAt,
    };
  }

  const observed = await countAbuseAttempt(db, {
    scope: policy.scope,
    axis: policy.axis,
    subjectHash,
    windowStartedAt: windowStartFor(input.now, policy.windowSeconds),
  });
  if (observed < policy.threshold) return { outcome: 'permitted' };

  const expiresAt = new Date(input.now.getTime() + policy.frictionSeconds * 1000);
  await recordIntervention(db, {
    pattern: policy.pattern,
    scope: policy.scope,
    axis: policy.axis,
    subjectHash,
    measure: policy.measure,
    observedCount: observed,
    thresholdCount: policy.threshold,
    expiresAt,
  });
  // The log line names the PATTERN and the counts and never the subject. An
  // operator investigating reaches the intervention row, which carries the same
  // facts and also cannot name anybody.
  log.guest.warn(
    { pattern: policy.pattern, scope: policy.scope, observed, threshold: policy.threshold },
    '[GuestAbuse] friction applied',
  );
  recordSecuritySignal(
    policy.pattern === 'session_farming' ? 'session_issuance_rate' : 'recovery_request_spike',
    1,
  );
  return {
    outcome: 'friction',
    pattern: policy.pattern,
    measure: policy.measure,
    retryAt: expiresAt,
  };
}

/**
 * The bounded reason code a refusal carries.
 *
 * Three codes for three measures, and the asymmetry with
 * `guest_rollout_blocked` (one code for four levers) is deliberate: a rollout
 * lever is an operator's private choice a buyer cannot act on, while friction
 * is something the person must be able to act on — by waiting, by proving their
 * inbox, or by knowing a human will look. Naming the measure discloses no
 * threshold, and the pattern and the count stay in the intervention row where
 * the reader is an operator.
 */
export function abuseReasonCodeFor(
  measure: GuestFrictionMeasure,
): 'abuse_cooldown' | 'abuse_verification_required' | 'abuse_manual_review' {
  switch (measure) {
    case 'cooldown':
      return 'abuse_cooldown';
    case 'email_verification_required':
      return 'abuse_verification_required';
    case 'manual_review':
      return 'abuse_manual_review';
  }
}
