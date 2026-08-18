/**
 * The translation desk's reads (#367 merge-order step 10) — how much of each
 * catalog domain is translated into each locale, and which entities carry no
 * row at all.
 *
 * `read.service.ts` closes with a note reserving exactly this: "the
 * catalogue-wide version — every category still owing a Spanish name — is a
 * translation-desk query, it needs an index this schema deliberately does not
 * carry yet, and it needs a surface to be read from. It arrives with the desk
 * (#367 merge-order step 10), not before it." This is that query; migration
 * `0112` is that index.
 *
 * ## The denominator is the ENTITY population, and that is the whole point
 *
 * A coverage ratio computed over localization ROWS is vacuous. A locale nobody
 * has started has no rows, so `present / rows` is `0 / 0` and "we found nothing"
 * is byte-identical to "there is nothing to find". Every query here counts its
 * denominator from the ENTITY table — `categories`, `product_type_definitions`,
 * `attribute_enum_values` — which no localization row participates in and which
 * cannot be driven to zero by the translation work not having been done.
 *
 * `absent` then falls out as `owed − rows`, and it is the figure the
 * localization tables structurally cannot report: an entity with no row for a
 * locale is invisible to any `group by` over those tables.
 *
 * ## `absent` and `missing` are different facts and are never summed here
 *
 * The schema's `<table>_missing_text_check` makes `missing` a row somebody
 * OPENED to say a translation is owed. `absent` is no row at all. A desk that
 * has triaged its whole backlog and one that has triaged none of it have the
 * same total and completely different next actions, so the two are returned
 * separately and a caller adds them if it wants to.
 *
 * ## Why this is not a sixth completeness query
 *
 * `services/catalog-governance/quality.service.ts` already answers translation
 * completeness — for CATEGORIES, per locale (`measureLocaleCompleteness`), and
 * for product types at a different grain entirely (`measureProductTypeCompleteness`
 * is keyed by product-type KEY with every supported locale as its denominator,
 * so it cannot answer "how complete is Spanish for product types"). Neither
 * covers `attribute_value` at all. What is new here is the uniform
 * (domain × locale) grain plus the `absent` split.
 *
 * Where the two grains coincide — category × locale — they must not disagree,
 * and that is held by a gate rather than by a promise:
 * `completeness-reconciliation.realdb.test.ts` runs both against one database
 * and asserts the same `owed` and the same human-settled count per locale. The
 * numerator definition is imported from the same tuple both read
 * (`HUMAN_SETTLED_LOCALIZATION_STATUSES`), so the two cannot drift on what
 * "settled" means either.
 */

import { sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  HUMAN_SETTLED_LOCALIZATION_STATUSES,
  SUPPORTED_LOCALES,
  type LocalizedEntityKind,
  type SupportedLocale,
} from '@mercaria/shared-types';

/** One domain's row counts in one locale, with the owed population beside them. */
export interface LocalizationDomainLocaleCounts {
  readonly domain: LocalizedEntityKind;
  readonly locale: SupportedLocale;
  readonly owed: number;
  readonly absent: number;
  readonly missing: number;
  readonly machineTranslated: number;
  readonly reviewed: number;
  readonly approved: number;
  readonly stale: number;
  readonly deprecated: number;
}

/**
 * The statuses that count as translated, restated nowhere.
 *
 * Imported rather than re-listed, unlike `quality.service.ts`'s
 * `PRESENT_LOCALIZATION_STATUSES` — that module restates the two members
 * deliberately, so a widening of the tuple for a SERVING decision cannot
 * silently change its metric. The reconciliation gate between the two is what
 * makes importing safe here: if the tuple widened and only one side moved, the
 * gate goes red naming the locale.
 */
export const DESK_SETTLED_STATUSES = HUMAN_SETTLED_LOCALIZATION_STATUSES;

const SUPPORTED: ReadonlySet<string> = new Set(SUPPORTED_LOCALES);

/**
 * Render a locale list as a SQL array literal.
 *
 * Every member is checked against {@link SUPPORTED_LOCALES} first, so the
 * `sql.raw` below cannot carry anything but a tag from a frozen tuple — an
 * injection is unrepresentable rather than escaped. `sql.raw` and not a bound
 * parameter because a bare JS array interpolated into a drizzle template renders
 * as a ROW CONSTRUCTOR, which is the house trap this pattern exists to avoid;
 * `quality.service.ts` renders `SUPPORTED_LOCALES` the same way.
 */
function localeArrayLiteral(locales: readonly SupportedLocale[]): string {
  for (const locale of locales) {
    if (!SUPPORTED.has(locale)) {
      throw new Error(`unsupported locale in completeness read: ${locale}`);
    }
  }
  return `array[${locales.map((locale) => `'${locale}'`).join(', ')}]::text[]`;
}

/**
 * A `type` alias and not an `interface`, deliberately.
 *
 * `db.execute<T>` constrains `T` to `Record<string, unknown>`, and an interface
 * has no implicit index signature while a type alias does — so the interface
 * spelling fails to satisfy the constraint. The neighbouring services sidestep
 * it by inlining an anonymous object literal at each call site; a named alias
 * keeps the three queries reading one shape.
 */
type RawCountRow = {
  locale: string;
  owed: number;
  rows: number;
  missing: number;
  machine_translated: number;
  reviewed: number;
  approved: number;
  stale: number;
  deprecated: number;
};

function toCounts(domain: LocalizedEntityKind, row: RawCountRow): LocalizationDomainLocaleCounts {
  const owed = Number(row.owed);
  const rows = Number(row.rows);
  return {
    domain,
    locale: row.locale as SupportedLocale,
    owed,
    // Clamped at zero rather than allowed negative. A row can outlive its
    // entity's eligibility — a category translated while published and since
    // deprecated keeps its rows — so `rows > owed` is a legitimate state and a
    // negative `absent` would be a nonsense figure on a dashboard.
    absent: Math.max(0, owed - rows),
    missing: Number(row.missing),
    machineTranslated: Number(row.machine_translated),
    reviewed: Number(row.reviewed),
    approved: Number(row.approved),
    stale: Number(row.stale),
    deprecated: Number(row.deprecated),
  };
}

/**
 * The per-status count columns, shared by all three queries.
 *
 * One string so the three domains cannot come to count six statuses six
 * slightly different ways — the `localizationChecks()` reasoning applied to a
 * projection. `l.id` is counted rather than `*` because the LEFT JOIN below
 * produces one all-NULL row per locale with no localizations, and `count(*)`
 * would report that as one row.
 */
const STATUS_COUNTS = sql.raw(`
  count(l.id)::int as rows,
  count(*) filter (where l.status = 'missing')::int as missing,
  count(*) filter (where l.status = 'machine_translated')::int as machine_translated,
  count(*) filter (where l.status = 'reviewed')::int as reviewed,
  count(*) filter (where l.status = 'approved')::int as approved,
  count(*) filter (where l.status = 'stale')::int as stale,
  count(*) filter (where l.status = 'deprecated')::int as deprecated
`);

/**
 * Categories owed a translation: `lifecycle = 'published'`.
 *
 * `CATEGORY_ACTIVE_LIFECYCLES` is the one derivation of "active" and it is
 * exactly this. A draft is not copy anybody reads and a deprecated or merged
 * category is copy nobody should be paying to translate — and counting them
 * makes every locale look permanently incomplete, which is how a completeness
 * metric comes to be ignored.
 */
export async function readCategoryLocalizationCompleteness(
  locales: readonly SupportedLocale[],
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly LocalizationDomainLocaleCounts[]> {
  if (locales.length === 0) return [];
  const rows = await db.execute<RawCountRow>(sql`
    with owed as (
      select id from categories where lifecycle = 'published'
    ),
    requested as (
      select unnest(${sql.raw(localeArrayLiteral(locales))}) as locale
    )
    select r.locale,
           (select count(*) from owed)::int as owed,
           ${STATUS_COUNTS}
      from requested r
      left join category_localizations l
        on l.locale = r.locale
       and l.category_id in (select id from owed)
     group by r.locale
     order by r.locale
  `);
  return rows.map((row) => toCounts('category', row));
}

/**
 * Product-type VERSIONS owed a translation: `lifecycle = 'published'`.
 *
 * Per version and not per key, because `product_type_localizations` is per
 * version and D5 freezes a published version's meaning: a v2 that changed what a
 * field asks for must not inherit v1's help text.
 *
 * Measured rather than assumed: `product_type_definitions_one_published_per_key`
 * permits exactly ONE published version per key, so today the per-version grain
 * and a per-published-key grain COINCIDE — "a key with two published versions"
 * is unrepresentable. The grain is still stated per version because that is what
 * the localization table is keyed by, so a scheme that ever published two would
 * be counted correctly with no edit here. What the predicate genuinely excludes
 * is the DRAFT successor of a published key: its meaning may still change
 * (`PRODUCT_TYPE_EDITABLE_LIFECYCLES`), and putting it in a translator's backlog
 * is asking for work that a later edit invalidates.
 *
 * This is the grain `measureProductTypeCompleteness` does not have — that one is
 * keyed by product-type key with `SUPPORTED_LOCALES.length` as its denominator,
 * which answers "how many of all supported locales does this type have" and
 * cannot answer "how complete is Spanish".
 */
export async function readProductTypeLocalizationCompleteness(
  locales: readonly SupportedLocale[],
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly LocalizationDomainLocaleCounts[]> {
  if (locales.length === 0) return [];
  const rows = await db.execute<RawCountRow>(sql`
    with owed as (
      select id from product_type_definitions where lifecycle = 'published'
    ),
    requested as (
      select unnest(${sql.raw(localeArrayLiteral(locales))}) as locale
    )
    select r.locale,
           (select count(*) from owed)::int as owed,
           ${STATUS_COUNTS}
      from requested r
      left join product_type_localizations l
        on l.locale = r.locale
       and l.product_type_definition_id in (select id from owed)
     group by r.locale
     order by r.locale
  `);
  return rows.map((row) => toCounts('product_type', row));
}

/**
 * Controlled values owed a translation: those whose DEFINITION is active.
 *
 * `attribute_enum_values` carries no lifecycle of its own, so its parent
 * definition's `lifecycle_state` is the only statement available about whether
 * its labels are still worth translating — the same predicate
 * `tallyAttributeLocalizedLabels` uses one domain over. Values of a deprecated
 * attribute are not a translation gap.
 *
 * No existing surface measures this domain per locale at all.
 */
export async function readAttributeValueLocalizationCompleteness(
  locales: readonly SupportedLocale[],
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly LocalizationDomainLocaleCounts[]> {
  if (locales.length === 0) return [];
  const rows = await db.execute<RawCountRow>(sql`
    with owed as (
      select v.id
        from attribute_enum_values v
        join attribute_definitions d on d.id = v.attribute_definition_id
       where d.lifecycle_state = 'active'
    ),
    requested as (
      select unnest(${sql.raw(localeArrayLiteral(locales))}) as locale
    )
    select r.locale,
           (select count(*) from owed)::int as owed,
           ${STATUS_COUNTS}
      from requested r
      left join attribute_value_localizations l
        on l.locale = r.locale
       and l.attribute_enum_value_id in (select id from owed)
     group by r.locale
     order by r.locale
  `);
  return rows.map((row) => toCounts('attribute_value', row));
}

/**
 * Per-field authoring copy owed a translation (#633, ADR 0007 D10).
 *
 * Two predicates, and the second is the one that matters. The field must belong
 * to a PUBLISHED version — the `product_type` rule, one level down — AND it must
 * carry at least one base-locale string. All four base columns are nullable, so
 * a field with no label, help text, placeholder or example has nothing to
 * translate; counting it would make every locale permanently incomplete by
 * exactly the number of bare fields, which is the "denominator nobody can ever
 * satisfy" failure that gets a metric ignored.
 *
 * The figure this produces has a caveat no other domain needs, and it is
 * published beside it in `LOCALIZATION_STALENESS_DETECTIONS`: nothing carries
 * these translations forward when a version is superseded (#650), so this
 * domain's completeness can collapse to zero for a key through no translator's
 * doing.
 */
export async function readProductTypeFieldLocalizationCompleteness(
  locales: readonly SupportedLocale[],
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly LocalizationDomainLocaleCounts[]> {
  if (locales.length === 0) return [];
  const rows = await db.execute<RawCountRow>(sql`
    with owed as (
      select f.id
        from product_type_fields f
        join product_type_definitions d
          on d.id = f.product_type_definition_id and d.lifecycle = 'published'
       where f.label is not null
          or f.help_text is not null
          or f.placeholder is not null
          or f.example is not null
    ),
    requested as (
      select unnest(${sql.raw(localeArrayLiteral(locales))}) as locale
    )
    select r.locale,
           (select count(*) from owed)::int as owed,
           ${STATUS_COUNTS}
      from requested r
      left join product_type_field_localizations l
        on l.locale = r.locale
       and l.product_type_field_id in (select id from owed)
     group by r.locale
     order by r.locale
  `);
  return rows.map((row) => toCounts('product_type_field', row));
}

/**
 * Every covered domain against every requested locale, in one call.
 *
 * Three statements whatever the locale count — the `readLocalizedCategories`
 * discipline. A per-locale loop would be 3 × 11 statements for the launch set
 * alone, and the desk reads this on every dashboard load.
 */
export async function readLocalizationCompletenessCounts(
  locales: readonly SupportedLocale[],
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly LocalizationDomainLocaleCounts[]> {
  if (locales.length === 0) return [];
  const [categories, productTypes, productTypeFields, attributeValues] = await Promise.all([
    readCategoryLocalizationCompleteness(locales, db),
    readProductTypeLocalizationCompleteness(locales, db),
    readProductTypeFieldLocalizationCompleteness(locales, db),
    readAttributeValueLocalizationCompleteness(locales, db),
  ]);
  return [...categories, ...productTypes, ...productTypeFields, ...attributeValues];
}
