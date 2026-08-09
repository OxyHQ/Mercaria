/**
 * Building one advertiser's mapping IN MEMORY, from the columns its feed
 * actually declared (#66).
 *
 * `docs/feed-importer.md` publishes this as the contract for #66 and it is
 * followed literally: `ResolvedFeedMapping` is plain data holding no row id, so
 * an Awin advertiser — which has no `feed_configurations` row and must not have
 * one — gets a mapping without a merchant-facing configuration nobody
 * registered it in. #63's `resolve.ts`, `configuration.service.ts`,
 * `report.service.ts` and `preview.service.ts` are that configuration surface
 * and are deliberately NOT reused; `awin-isolation.test.ts` fails the build if
 * any module here reaches for one.
 *
 * ## Only DECLARED columns are mapped, and that is the point
 *
 * Awin ships only the columns an advertiser MAPPED, which is #64 §6's Awin
 * rule 2: "the adapter must record per-feed column presence and never fabricate
 * absent identifiers". A mapping that named every column regardless would make
 * #63's engine read an absent column as an absent VALUE — indistinguishable
 * from a row that simply has no EAN — and identifier coverage, which is
 * measured per advertiser precisely because it varies, would stop meaning
 * anything.
 */

import type {
  AwinFeedColumn,
  FeedFieldMapping,
  FeedFieldRole,
} from '@mercaria/shared-types';
import { AWIN_FEED_COLUMNS, AWIN_IDENTITY_COLUMNS } from '@mercaria/shared-types';
import type { ResolvedFeedMapping } from '../feed-import/mapping.js';
import { AWIN_COLUMN_ROLES, AWIN_OPTION_AXIS_NAMES, AWIN_VALUE_MAPPINGS } from './constants.js';

/** Which of Awin's columns this feed's header row actually carried. */
export function declaredAwinColumns(headers: Iterable<string>): readonly AwinFeedColumn[] {
  const known = new Set<string>(AWIN_FEED_COLUMNS);
  const seen = new Set<AwinFeedColumn>();
  for (const header of headers) {
    const normalized = header.trim().toLowerCase();
    if (known.has(normalized)) seen.add(normalized as AwinFeedColumn);
  }
  // In the tuple's order, not the header row's: a stable order makes the stored
  // `declared_columns` array comparable between two imports, which is what lets
  // "this advertiser stopped publishing EANs" be a diff rather than a hunt.
  return AWIN_FEED_COLUMNS.filter((column) => seen.has(column));
}

/**
 * One advertiser's mapping.
 *
 * The `declared` set is what Mercaria REQUESTS, and the mapping is built over
 * it rather than over what a particular header row turned out to carry — which
 * has to be that way round: the mapping is needed before the first record is
 * read, and reading a record to discover the header is circular. #63's engine
 * treats a mapped column that is absent from a row exactly as it treats an
 * empty one, so an advertiser who mapped fewer columns loses those FIELDS and
 * nothing else. What varies per advertiser is therefore MEASURED
 * (`declaredAwinColumns`, `awin_advertiser_quality`) rather than configured,
 * which is #64 §6's Awin rule 2: never fabricate absent identifiers.
 *
 * The three option AXES are the only entries built from a constant rather than
 * a column, and they have to be: Awin publishes `colour`, `size` and `material`
 * as values with no accompanying name, and #63's engine drops an option pair
 * when either half is missing. Naming the axis here is what makes a colour an
 * option rather than a discarded string.
 *
 * `defaultCurrency` comes from the FEED LISTING rather than from a row, because
 * a currency column is optional in an Awin feed and a per-row currency that is
 * absent is not a reason to refuse a whole catalogue. It is never a Mercaria
 * default: an advertiser whose listing declares no currency and whose rows
 * carry none leaves the price unreadable, and #63's money reader refuses those
 * rows BY NAME (`unsupported_currency`) rather than guessing.
 */
export function buildAwinMapping(input: {
  declared: readonly AwinFeedColumn[];
  defaultCurrency: string | null;
  defaultCountry: string | null;
  defaultLanguage: string | null;
}): ResolvedFeedMapping {
  const present = new Set<AwinFeedColumn>(input.declared);
  const fieldMappings = new Map<FeedFieldRole, FeedFieldMapping>();

  for (const [column, role] of Object.entries(AWIN_COLUMN_ROLES) as readonly [
    AwinFeedColumn,
    FeedFieldRole,
  ][]) {
    if (!present.has(column)) continue;
    fieldMappings.set(role, { role, sourceField: column });
  }

  // The option axis NAMES, supplied only where the matching value column is
  // present. An axis name with no values is an option nobody can complete.
  if (present.has('colour')) {
    fieldMappings.set('option_name_1', {
      role: 'option_name_1',
      constantValue: AWIN_OPTION_AXIS_NAMES.colour,
    });
  }
  if (present.has('size')) {
    fieldMappings.set('option_name_2', {
      role: 'option_name_2',
      constantValue: AWIN_OPTION_AXIS_NAMES.size,
    });
  }
  if (present.has('material')) {
    fieldMappings.set('option_name_3', {
      role: 'option_name_3',
      constantValue: AWIN_OPTION_AXIS_NAMES.material,
    });
  }

  return {
    fieldMappings,
    valueMappings: new Map(Object.entries(AWIN_VALUE_MAPPINGS)),
    identityKeyFields: [...AWIN_IDENTITY_COLUMNS],
    listSeparator: '|',
    defaultCurrency: input.defaultCurrency,
    defaultCountry: input.defaultCountry,
    defaultLanguage: input.defaultLanguage,
  };
}
