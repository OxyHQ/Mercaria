/**
 * The translation desk's completeness report and its launch-locale alerts
 * (#367 merge-order step 10).
 *
 * Both are DERIVED at read time and neither is stored.
 * `db/schema/catalogLocalization.ts` records a `localization_coverage_runs`
 * table as deliberately absent — coverage is a query over the rows, and storing
 * its answer is a second representation that goes stale the moment a translator
 * saves. So a translation settled a second ago is in the next answer with no
 * sweep having run, and there is nothing here for a rollback to leave behind.
 *
 * ## What each figure would report if the thing it measures were absent
 *
 * The question every count here had to answer:
 *
 * - **`owed`** — counted from the ENTITY table. With no localization rows at all
 *   it is unchanged, which is the point: it is the one figure the translation
 *   work cannot move. With no published entities it is `0`, and
 *   {@link LocalizationCompleteness}'s `no_population` branch then carries no
 *   ratio at all, so an empty deployment cannot render as fully translated.
 * - **`absent`** — `owed − rows`. With nothing translated it equals `owed`; with
 *   everything translated it is `0`. It moves in both directions and it is the
 *   figure a row-only tally structurally cannot produce.
 * - **`evaluatedPairs`** on the alert report — `domains × launchLocales`. An
 *   alert run that examined nothing returns an empty `alerts` array, which is
 *   byte-identical to a run that examined everything and found nothing wrong.
 *   This count is the only thing that tells them apart, so it is in the payload
 *   rather than in a log line.
 *
 * ## The alerts are findings, not a transport
 *
 * Mercaria has no outbound mail transport — `services/guest-portal/transport.ts`
 * is an empty registry and `services/price-alerts/transport.ts` is another, both
 * failing closed and visibly. This surface therefore does what those two do: it
 * produces a durable, readable finding and sends nothing. A `console.log`
 * transport would look like a working feature in every test and deliver nothing
 * in production, which is worse than the honest absence. Routing a translation
 * alert to a person is owed by whichever issue supplies that transport; it is
 * one `registerGuestMessageTransport`-shaped call away and nothing here changes.
 */

import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  ALL_REPORTABLE_LOCALES,
  LAUNCH_LOCALES,
  LOCALIZATION_COVERAGE_DOMAINS,
  LOCALIZATION_COVERAGE_UNCOVERED_TABLES,
  LOCALIZATION_STALENESS_DETECTIONS,
  MERCARIA_BASE_LOCALE,
  isLaunchLocale,
  type LocaleDomainCompleteness,
  type LocalizationAlert,
  type LocalizationAlertReport,
  type LocalizationCompleteness,
  type LocalizationCompletenessReport,
  type LocalizationStalenessDetection,
  type LocalizedEntityKind,
  type SupportedLocale,
} from '@mercaria/shared-types';
import {
  readLocalizationCompletenessCounts,
  type LocalizationDomainLocaleCounts,
} from '../../db/catalogLocalization/completenessRepository.js';

/** The staleness descriptor for one domain. Every covered domain has one. */
export function stalenessDetectionFor(domain: LocalizedEntityKind): LocalizationStalenessDetection {
  const found = LOCALIZATION_STALENESS_DETECTIONS.find((entry) => entry.domain === domain);
  if (!found) {
    // Unreachable while the census test passes — it asserts one detection per
    // covered domain — and a throw rather than a fabricated descriptor, because
    // an invented "watches nothing" would read as a domain with no blind spots.
    throw new Error(`no staleness detection recorded for domain: ${domain}`);
  }
  return found;
}

/**
 * `settled / owed`, or the explicit absence of a question.
 *
 * Basis points and floored, so the figure is an integer a consumer cannot render
 * with spurious precision. The `no_population` branch has no `settledBps`
 * property at all — see the type — so a domain with nothing in it cannot be
 * rendered as a percentage by any caller, including a careless one.
 */
function completenessOf(settled: number, owed: number): LocalizationCompleteness {
  if (owed === 0) return { kind: 'no_population', reason: 'no_translatable_entities' };
  return { kind: 'measured', settled, owed, settledBps: Math.floor((settled / owed) * 10_000) };
}

function toRow(counts: LocalizationDomainLocaleCounts): LocaleDomainCompleteness {
  const settled = counts.reviewed + counts.approved;
  return {
    domain: counts.domain,
    locale: counts.locale,
    launchLocale: isLaunchLocale(counts.locale),
    owed: counts.owed,
    absent: counts.absent,
    missing: counts.missing,
    machineTranslated: counts.machineTranslated,
    reviewed: counts.reviewed,
    approved: counts.approved,
    stale: counts.stale,
    deprecated: counts.deprecated,
    completeness: completenessOf(settled, counts.owed),
  };
}

/**
 * Which locales a report covers.
 *
 * The default is the LAUNCH set rather than all forty, because the desk's
 * standing question is "what is a shopper reading in a market we opened". A
 * caller asking for the long tail says so; a caller asking for a locale
 * Mercaria does not author in gets a refusal from the repository's own
 * membership check rather than a silently empty row.
 */
export type CompletenessLocaleScope = 'launch' | 'all';

export function localesForScope(scope: CompletenessLocaleScope): readonly SupportedLocale[] {
  return scope === 'all' ? ALL_REPORTABLE_LOCALES : LAUNCH_LOCALES;
}

/**
 * Completeness for every covered domain against every locale in scope.
 *
 * The coverage census and the staleness caveats travel in the PAYLOAD, not in
 * documentation: a caveat a consumer has to look up is a caveat three consumers
 * render three ways and two of them omit. `uncoveredTables` in particular is
 * what stops this report's silence about `attribute_labels` and
 * `navigation_node_localizations` reading as those domains being complete.
 */
export async function readLocalizationCompleteness(
  scope: CompletenessLocaleScope = 'launch',
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizationCompletenessReport> {
  const locales = localesForScope(scope);
  const counts = await readLocalizationCompletenessCounts(locales, db);
  return {
    generatedAt: new Date().toISOString(),
    baseLocale: MERCARIA_BASE_LOCALE,
    locales,
    domains: LOCALIZATION_COVERAGE_DOMAINS,
    rows: counts.map(toRow),
    uncoveredTables: LOCALIZATION_COVERAGE_UNCOVERED_TABLES,
    stalenessDetections: LOCALIZATION_STALENESS_DETECTIONS,
  };
}

/**
 * The findings for one (domain, locale) pair in a launched market.
 *
 * Order is deliberate and the severities are categorical rather than scored:
 *
 * - `untranslated` is BLOCKING. A launched market whose shopper reads English
 *   category names is the state this whole domain exists to prevent, and it is
 *   the only one that cannot be explained away by a translator being mid-pass.
 * - `stale` is a warning: the text is still served and still the best available,
 *   which is exactly why `stale` never blanks anything.
 * - `machine_only` is a warning: there IS servable text, nobody has settled it.
 *   Reported only when no human-settled row exists at all, because one approved
 *   row beside many machine ones is a pass in progress rather than a gap.
 * - `unmeasurable` is the vacuity finding: rows exist for a locale whose owed
 *   population is zero. It means the denominator rule and the data disagree —
 *   somebody translated entities nothing considers owed — and it is a finding
 *   precisely because every ratio over that pair is unanswerable.
 */
function alertsForRow(row: LocaleDomainCompleteness): readonly LocalizationAlert[] {
  const detection = stalenessDetectionFor(row.domain);
  // The caveat travels with the FINDING rather than only with the report, so a
  // consumer rendering one alert in isolation still shows what its count cannot
  // see. A domain whose detection watches everything it localizes carries none.
  const caveats = detection.unwatched.map(
    (source) =>
      `a change to ${source} does not mark this domain's translations stale ` +
      `(${detection.mechanism} \`${detection.performedBy}\`), so the stale count is a floor`,
  );
  const found: LocalizationAlert[] = [];

  if (row.completeness.kind === 'no_population') {
    const rows =
      row.missing + row.machineTranslated + row.reviewed + row.approved + row.stale + row.deprecated;
    if (rows > 0) {
      found.push({
        kind: 'unmeasurable',
        severity: 'warning',
        domain: row.domain,
        locale: row.locale,
        affected: rows,
        owed: 0,
        caveats,
      });
    }
    return found;
  }

  const untranslated = row.absent + row.missing;
  if (untranslated > 0) {
    found.push({
      kind: 'untranslated',
      severity: 'blocking',
      domain: row.domain,
      locale: row.locale,
      affected: untranslated,
      owed: row.owed,
      caveats,
    });
  }
  if (row.stale > 0) {
    found.push({
      kind: 'stale',
      severity: 'warning',
      domain: row.domain,
      locale: row.locale,
      affected: row.stale,
      owed: row.owed,
      caveats,
    });
  }
  if (row.machineTranslated > 0 && row.reviewed + row.approved === 0) {
    found.push({
      kind: 'machine_only',
      severity: 'warning',
      domain: row.domain,
      locale: row.locale,
      affected: row.machineTranslated,
      owed: row.owed,
      caveats,
    });
  }
  return found;
}

/**
 * Every launch-locale gap, with the count of pairs actually examined.
 *
 * Scoped to {@link LAUNCH_LOCALES} by construction rather than by a filter a
 * caller passes: an alert about a locale no app ships reaches no shopper, and a
 * surface that could be asked for the long tail is one somebody would page on.
 */
export async function readLocalizationAlerts(
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizationAlertReport> {
  const report = await readLocalizationCompleteness('launch', db);
  const alerts = report.rows.flatMap((row) => alertsForRow(row));
  return {
    generatedAt: report.generatedAt,
    launchLocales: LAUNCH_LOCALES,
    // Counted from the SHAPE of what was asked for, not from `report.rows.length`.
    // A repository that silently returned fewer rows would otherwise lower this
    // floor to match its own shortfall, which is the direction that makes a
    // vacuous run look thorough.
    evaluatedPairs: LOCALIZATION_COVERAGE_DOMAINS.length * LAUNCH_LOCALES.length,
    alerts,
  };
}
