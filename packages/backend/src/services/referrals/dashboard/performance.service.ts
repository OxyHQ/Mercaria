/**
 * One partner's own performance, by one dimension, over one window (#147
 * "Performance views", under ADR 0005 A5).
 *
 * Composes two independent aggregate reads and puts them through the floor.
 * Nothing here reads a subject, an order or a person: `performanceRepository`
 * has no function that could return one, and every read it does have takes a
 * partner id.
 *
 * ## The window is bounded, and the bound is not politeness
 *
 * A dimension of `date` over an unbounded range is one row per day forever, and
 * a `market` breakdown over all time is the union of every market this partner
 * ever reached — which is a larger disclosure than the same breakdown over a
 * month, because the floor is applied per cell and a longer window makes small
 * cells pass. {@link MAX_PERFORMANCE_WINDOW_DAYS} caps it at a year; the schema
 * refuses a longer one rather than silently truncating, because a truncated
 * window reports numbers for a period the caller did not ask about.
 */

import {
  REFERRAL_METRIC_DEFINITIONS,
  REFERRAL_PARTNER_DISCLOSURE_FLOOR,
  type ReferralMetricDefinition,
  type ReferralPartnerPerformance,
  type ReferralPerformanceDimension,
  type ReferralPerformanceRow,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import {
  countPartnerClicks,
  countPartnerClicksByDimension,
  countPartnerConversions,
  countPartnerConversionsByDimension,
} from '../../../db/referrals/performanceRepository.js';
import { listCodesByPartner } from '../../../db/referrals/instrumentRepository.js';
import { findActiveProgramVersion } from '../../../db/referrals/programRepository.js';
import { applyDisclosureFloor, dimensionRevealsSubject } from './disclosure.js';

/** A year. Long enough for an annual review, short enough to bound the read. */
export const MAX_PERFORMANCE_WINDOW_DAYS = 366;

/** How many instruments a label lookup will resolve. The partner cap, one over. */
const LABEL_LOOKUP_LIMIT = 200;

/** The two figures every breakdown publishes, so a client renders their definitions. */
const PERFORMANCE_METRIC_KEYS = ['referral_human_clicks', 'referral_qualified_conversions'] as const;

export function performanceMetricDefinitions(): ReferralMetricDefinition[] {
  return PERFORMANCE_METRIC_KEYS.map((key) => REFERRAL_METRIC_DEFINITIONS[key]);
}

/** `YYYY-MM-DD` for a UTC instant. */
function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Resolve the human-readable label for each key of one dimension.
 *
 * A separate pass rather than a join in the aggregate, because the aggregate is
 * a `group by` over one column and adding a name to it would make the grouping
 * depend on a string that can change. A program renamed between two reads must
 * not split its own history into two rows.
 */
async function resolveLabels(
  db: DatabaseOrTransaction,
  input: { partnerId: string; dimension: ReferralPerformanceDimension; keys: readonly string[] },
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (input.dimension === 'instrument') {
    const codes = await listCodesByPartner(db, {
      partnerId: input.partnerId,
      limit: LABEL_LOOKUP_LIMIT,
    });
    for (const code of codes) labels.set(code.id, code.code);
    return labels;
  }
  if (input.dimension === 'program') {
    for (const key of input.keys) {
      const active = await findActiveProgramVersion(db, key);
      if (active) labels.set(key, active.name);
    }
    return labels;
  }
  return labels;
}

/** The empty-key label, per dimension. Never the bare string `''`. */
function emptyKeyLabel(dimension: ReferralPerformanceDimension): string {
  switch (dimension) {
    case 'campaign':
      return 'No campaign';
    case 'market':
      return 'No market set';
    case 'client_surface':
      return 'Unknown surface';
    default:
      return 'Unattributed';
  }
}

export interface PartnerPerformanceInput {
  partnerId: string;
  dimension: ReferralPerformanceDimension;
  /** Inclusive `YYYY-MM-DD`. */
  from: string;
  /** Inclusive `YYYY-MM-DD`. */
  through: string;
}

/**
 * Read one partner's breakdown.
 *
 * The two counts are merged by KEY, and a key present on one side only carries
 * a genuine zero on the other — "no clicks were recorded on this code in this
 * window" is a measurement, not an absence of information, which is why this is
 * the one place a zero is written and why the three dimensions a click cannot
 * carry were removed from the vocabulary rather than answered with one.
 */
export async function readPartnerPerformance(
  input: PartnerPerformanceInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralPartnerPerformance> {
  const from = new Date(`${input.from}T00:00:00.000Z`);
  // Inclusive `through`: the caller names a DAY, so the window runs to the last
  // instant of it. An exclusive midnight boundary silently drops everything
  // that happened on the day somebody asked about.
  const until = new Date(`${input.through}T23:59:59.999Z`);
  const window = { partnerId: input.partnerId, from, until };

  const [clicks, conversions, clickTotal, conversionTotal] = await Promise.all([
    countPartnerClicksByDimension(db, { ...window, dimension: input.dimension }),
    countPartnerConversionsByDimension(db, { ...window, dimension: input.dimension }),
    countPartnerClicks(db, window),
    countPartnerConversions(db, window),
  ]);

  const merged = new Map<string, { humanClicks: number; qualifiedConversions: number }>();
  for (const bucket of clicks) {
    merged.set(bucket.key, { humanClicks: bucket.count, qualifiedConversions: 0 });
  }
  for (const bucket of conversions) {
    const existing = merged.get(bucket.key);
    if (existing) existing.qualifiedConversions = bucket.count;
    else merged.set(bucket.key, { humanClicks: 0, qualifiedConversions: bucket.count });
  }

  const keys = [...merged.keys()];
  const labels = await resolveLabels(db, {
    partnerId: input.partnerId,
    dimension: input.dimension,
    keys,
  });

  const measured: ReferralPerformanceRow[] = keys
    .map((key) => ({
      key,
      label: key === '' ? emptyKeyLabel(input.dimension) : (labels.get(key) ?? key),
      humanClicks: merged.get(key)?.humanClicks ?? 0,
      qualifiedConversions: merged.get(key)?.qualifiedConversions ?? 0,
    }))
    .sort((a, b) => {
      // A date breakdown reads forwards; every other reads by size, because
      // "which of my codes works" is the question a partner has.
      if (input.dimension === 'date') return a.key.localeCompare(b.key);
      const bySize = b.qualifiedConversions - a.qualifiedConversions;
      return bySize !== 0 ? bySize : b.humanClicks - a.humanClicks;
    });

  const disclosed = applyDisclosureFloor(measured, input.dimension);

  return {
    dimension: input.dimension,
    from: input.from,
    through: input.through,
    ...(dimensionRevealsSubject(input.dimension)
      ? { disclosureFloor: REFERRAL_PARTNER_DISCLOSURE_FLOOR }
      : {}),
    rows: disclosed.rows,
    totals: { humanClicks: clickTotal, qualifiedConversions: conversionTotal },
    withheldRowCount: disclosed.withheldRowCount,
    ...(disclosed.withheldReason !== undefined
      ? { withheldReason: disclosed.withheldReason }
      : {}),
    metrics: performanceMetricDefinitions(),
  };
}

/** The trailing 30 days, by date — what the dashboard's first paint shows. */
export function defaultPerformanceWindow(now: Date = new Date()): {
  from: string;
  through: string;
} {
  const through = isoDay(now);
  const from = isoDay(new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000));
  return { from, through };
}
