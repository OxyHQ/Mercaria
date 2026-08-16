/**
 * WHETHER THE PILOT ADMITS THIS ATTRIBUTION (#149 "Pilot cohort", acceptance 5).
 *
 * PURE, and that is the point rather than a convenience: every bound #149 names
 * is checked here against values a caller already holds, so the whole of "is
 * this within the pilot" is one function a reader can check and one function a
 * test can drive over every boundary without a database.
 *
 * ## The order of the checks is deliberate
 *
 * Cheapest and least disclosive first: the cohort's own existence, then the
 * programme, then the dates, then the subject kind, then the allow-list, then
 * the live stops, then the entry caps — because the caps are the one answer
 * that costs a `count(*)` and refusing on a bound that needed no read is
 * strictly less work for the same answer.
 *
 * It makes no difference to the PARTNER, who never sees which of the nine
 * fired: `attributeTouch` answers one `pilot_not_admitted` and this vocabulary
 * reaches the `referral_events` row an operator traces from. Distinguishing
 * them would let somebody vary one input at a time and read out the pilot's
 * allow-list, its dates and its remaining entry budget.
 *
 * ## There is no admitted path that does not name a cohort version
 *
 * A PROGRAMME with no active cohort refuses every new attribution —
 * `no_active_cohort` — which is the correct state for a programme that has
 * published no bounds, and is why this domain adds no environment variable of
 * its own: an empty pilot IS the off position. `REFERRALS_ENABLED` (#143) and
 * `referral_program_controls.attribution_enabled` (#143's row lever) remain the
 * flippable ones, and they are checked before this gate is reached.
 *
 * There is no pilot KEY anywhere in this domain and deliberately none: a cohort
 * is looked up by the PROGRAMME a touch already names, so no configured string
 * could point the gate at bounds nobody published — and one global active row
 * would make this table a shared resource between parallel test files, the
 * `match_policy_versions_active_key` hazard this repository has paid for once.
 */

import type {
  ReferralPilotAdmission,
  ReferralPilotStopMetric,
  ReferralPilotStopScope,
  ReferralPilotSubject,
  ReferralSubjectKind,
} from '@mercaria/shared-types';

/**
 * Which subject kinds each pilot admits.
 *
 * A TABLE rather than a branch (#83's `claim-methods.ts` device): a customer
 * pilot attributes buyers and a merchant pilot attributes merchants, and a
 * cohort that admitted both would be two pilots wearing one set of bounds —
 * with one entry cap covering two economies whose costs are not comparable.
 */
export const REFERRAL_PILOT_SUBJECT_KINDS: Record<
  ReferralPilotSubject,
  readonly ReferralSubjectKind[]
> = {
  customer_acquisition: ['oxy_user', 'guest_checkout'],
  merchant_acquisition: ['merchant'],
};

/** One published cohort version's bounds, as the derivation reads them. */
export interface ReferralPilotBounds {
  readonly cohortId: string;
  readonly version: number;
  readonly subject: ReferralPilotSubject;
  readonly programId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly maxAttributionsPerPartner: number;
  readonly maxAttributionsTotal: number;
}

/** A stop that is live right now. */
export interface ReferralPilotLiveStop {
  readonly metric: ReferralPilotStopMetric;
  readonly scope: ReferralPilotStopScope;
  /** Empty for a `pilot`-scoped stop, which covers everything. */
  readonly scopeRef: string;
}

/** One candidate attribution, as `attributeTouch` knows it. */
export interface ReferralPilotEntry {
  readonly programId: string;
  readonly partnerId: string;
  readonly subjectKind: ReferralSubjectKind;
  /**
   * The MARKET this entry belongs to, when the caller knows one.
   *
   * `null` today for every caller, and that is deliberate rather than
   * unfinished: a touch carries no market (#142's `referral_touches` has no such
   * column, because a market is a property of an ORDER and not of a click), so
   * the market bound is enforced at PUBLISH against the program version's own
   * `markets` rather than per entry. The field exists so a market-scoped STOP
   * can be honoured the day a caller does know one — and until then a
   * market-scoped stop covers nothing, which the publish path refuses to let an
   * operator create by accident.
   */
  readonly market: string | null;
  readonly at: Date;
}

/** The entry counts a cap is read against. */
export interface ReferralPilotEntryCounts {
  readonly total: number;
  readonly forPartner: number;
}

/** Everything the derivation reads, gathered by the service. */
export interface ReferralPilotState {
  readonly bounds: ReferralPilotBounds | null;
  readonly allowlistedPartners: ReadonlySet<string>;
  readonly liveStops: readonly ReferralPilotLiveStop[];
  readonly counts: ReferralPilotEntryCounts;
}

/**
 * Whether a live stop covers this entry.
 *
 * A `pilot`-scoped stop covers everything; the other two match their own
 * subject. The comparison is EXACT rather than a prefix test, for
 * `claim-scope.ts`' reason: a prefix would make a stop on partner `acme` also
 * stop `acme-industries`, which is somebody else.
 *
 * A `market`-scoped stop covers nothing while the entry's market is unknown,
 * and that is the SAFE direction stated out loud: admitting on an unknown
 * market would make a market stop advisory, so the publish path refuses a
 * market-scoped threshold instead of letting one be raised that cannot bite.
 */
function stopCovers(stop: ReferralPilotLiveStop, entry: ReferralPilotEntry): boolean {
  switch (stop.scope) {
    case 'pilot':
      return true;
    case 'partner':
      return stop.scopeRef === entry.partnerId;
    case 'market':
      return entry.market !== null && stop.scopeRef === entry.market;
  }
}

/**
 * The pilot's verdict on one candidate attribution.
 *
 * Every refusal is a REASON, never a boolean, because the caller records which
 * bound fired and a boolean would make an operator guess between nine.
 */
export function deriveReferralPilotAdmission(
  state: ReferralPilotState,
  entry: ReferralPilotEntry,
): ReferralPilotAdmission {
  const { bounds } = state;
  if (bounds === null) return { outcome: 'refused', reason: 'no_active_cohort' };

  if (bounds.programId !== entry.programId) {
    return { outcome: 'refused', reason: 'program_not_in_pilot' };
  }

  // #149 pilot cohort 10: explicit start and end dates. Two refusals rather
  // than one `outside_pilot_window`, because "not yet" and "over" send an
  // operator to opposite places — one waits, one publishes a new version.
  if (entry.at.getTime() < bounds.startsAt.getTime()) {
    return { outcome: 'refused', reason: 'before_pilot_start' };
  }
  if (entry.at.getTime() >= bounds.endsAt.getTime()) {
    return { outcome: 'refused', reason: 'after_pilot_end' };
  }

  if (!REFERRAL_PILOT_SUBJECT_KINDS[bounds.subject].includes(entry.subjectKind)) {
    return { outcome: 'refused', reason: 'subject_kind_not_in_pilot' };
  }

  if (!state.allowlistedPartners.has(entry.partnerId)) {
    return { outcome: 'refused', reason: 'partner_not_allowlisted' };
  }

  for (const stop of state.liveStops) {
    if (stopCovers(stop, entry)) {
      return { outcome: 'refused', reason: 'stop_threshold_active' };
    }
  }

  // The caps are `>=`, not `>`: a cap of fifty admits the fiftieth entry and
  // refuses the fifty-first, so `count >= cap` is the refusal. Written this way
  // round rather than as `count + 1 > cap`, which is the same arithmetic and
  // one more place to make an off-by-one.
  if (state.counts.forPartner >= bounds.maxAttributionsPerPartner) {
    return { outcome: 'refused', reason: 'partner_entry_cap_reached' };
  }
  if (state.counts.total >= bounds.maxAttributionsTotal) {
    return { outcome: 'refused', reason: 'program_entry_cap_reached' };
  }

  return { outcome: 'admitted', cohortId: bounds.cohortId, cohortVersion: bounds.version };
}
