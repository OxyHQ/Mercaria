/**
 * The translation desk's gates (#367 merge-order step 10).
 *
 * Every assertion here had to answer one question: **what would it report if the
 * thing it measures were absent?** A reporting domain is where a check that
 * cannot fail does the most damage, because its output is a number somebody
 * acts on.
 *
 * So each census below carries a vacuity floor (the population it walked is
 * non-empty) and, where the census is derived from a real sweep, a positive
 * control that plants something which genuinely EXISTS. The house note about
 * sharing a wall's own comparison is deliberately not followed for the
 * module-population gates: a planted name absent from the sweep reads as
 * "outside the population" either way, so the control has to be a real module
 * belonging to another domain, checked to exist first.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import { describe, expect, it } from 'vitest';
import {
  ALL_REPORTABLE_LOCALES,
  CATALOG_LOCALIZATION_TEXT_TABLES,
  CATALOG_LOCALIZED_FIELDS,
  LAUNCH_LOCALES,
  LOCALIZATION_ALERT_KINDS,
  LOCALIZATION_ALERT_SEVERITIES,
  LOCALIZATION_COVERAGE_DOMAINS,
  LOCALIZATION_COVERAGE_UNCOVERED_TABLES,
  LOCALIZATION_OWED_POPULATION_RULES,
  LOCALIZATION_STALENESS_DETECTIONS,
  LOCALIZED_FIELD_BASE_SOURCES,
  LOCALIZED_FIELD_KEYS,
  MERCARIA_BASE_LOCALE,
  SUPPORTED_LOCALES,
  isLaunchLocale,
  type LocalizedEntityKind,
} from '@mercaria/shared-types';
import { categories } from '../schema/catalog';
import { productTypeDefinitions, productTypeFields } from '../schema/productTypes';
import { attributeEnumValues } from '../schema/attributeRegistry';
import internalCatalogLocalizationRouter from '../../routes/internal-catalog-localization';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_SRC = join(HERE, '..', '..');
const DRIZZLE_DIR = join(BACKEND_SRC, '..', 'drizzle');
const REPO_ROOT = join(BACKEND_SRC, '..', '..', '..');

/** The localization table each covered domain measures. */
const DOMAIN_TABLES: Readonly<Record<LocalizedEntityKind, string>> = {
  category: 'category_localizations',
  product_type: 'product_type_localizations',
  product_type_field: 'product_type_field_localizations',
  attribute_value: 'attribute_value_localizations',
};

/* -------------------------------------------------------------------------- */

describe('LAUNCH_LOCALES tracks the app locale registry', () => {
  const REGISTRY = join(REPO_ROOT, 'packages', 'ui', 'src', 'i18n', 'locales.ts');

  /**
   * The app registry's tuple, parsed off disk.
   *
   * Read rather than imported: `@mercaria/ui` is an Expo package consumed from
   * source by Metro and the backend has no business resolving it. Parsing is
   * what makes the two halves of one fact committed together checkable at all.
   */
  function appRegistryLocales(): string[] {
    const source = readFileSync(REGISTRY, 'utf8');
    const at = source.indexOf('export const SUPPORTED_LOCALES = [');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = source.slice(at, source.indexOf(']', at));
    return [...body.matchAll(/'([^']+)'/gu)].map((match) => match[1]);
  }

  const fold = (locale: string): string => locale.trim().replace(/_/gu, '-').toLowerCase();

  it('parses a non-empty registry — the floor for every assertion below', () => {
    // Without this, a renamed symbol or a moved file yields an empty tuple and
    // every set comparison below passes by comparing nothing to nothing.
    const parsed = appRegistryLocales();
    expect(parsed.length).toBeGreaterThanOrEqual(2);
    expect(parsed).toContain(MERCARIA_BASE_LOCALE);
  });

  it('is exactly the registry folded, minus the base locale — both directions', () => {
    const derived = appRegistryLocales()
      .map(fold)
      .filter((locale) => locale !== MERCARIA_BASE_LOCALE)
      .sort();
    expect([...LAUNCH_LOCALES].sort()).toEqual(derived);
  });

  it('names only locales the catalog can actually hold a row for', () => {
    // An app shipping a language the catalog has no row shape for is a market
    // that can never have a translated catalogue.
    const supported: readonly string[] = SUPPORTED_LOCALES;
    for (const locale of LAUNCH_LOCALES) expect(supported).toContain(locale);
  });

  it('is non-empty, so the alert surface cannot be vacuously clean', () => {
    // An empty launch set makes every alert run examine zero pairs and report
    // no findings — the exact "100% because we looked at nothing" this domain
    // keeps producing.
    expect(LAUNCH_LOCALES.length).toBeGreaterThan(0);
  });

  it('never contains the base locale, which is a source and not a target', () => {
    expect(LAUNCH_LOCALES).not.toContain(MERCARIA_BASE_LOCALE);
    expect(ALL_REPORTABLE_LOCALES).not.toContain(MERCARIA_BASE_LOCALE);
    expect(isLaunchLocale(MERCARIA_BASE_LOCALE)).toBe(false);
  });

  it('is a strict subset of the reportable set — a positive control on both', () => {
    // If `ALL_REPORTABLE_LOCALES` ever collapsed to the launch set, the `all`
    // scope would silently stop reporting the long tail while still being
    // offered as a distinct option.
    expect(ALL_REPORTABLE_LOCALES.length).toBeGreaterThan(LAUNCH_LOCALES.length);
    for (const locale of LAUNCH_LOCALES) expect(ALL_REPORTABLE_LOCALES).toContain(locale);
  });
});

/* -------------------------------------------------------------------------- */

describe('the report carries its own coverage', () => {
  it('covers every localization family table or names it uncovered, exactly', () => {
    // The `merge-plan-census` device. A new family member fails the build until
    // somebody decides whether the desk measures it — because a domain nobody
    // looked at and a domain with nothing outstanding render identically in a
    // report that does not carry this list.
    const covered = LOCALIZATION_COVERAGE_DOMAINS.map((domain) => DOMAIN_TABLES[domain]);
    const uncovered = LOCALIZATION_COVERAGE_UNCOVERED_TABLES.map((entry) => entry.table);
    expect([...covered, ...uncovered].sort()).toEqual([...CATALOG_LOCALIZATION_TEXT_TABLES].sort());
  });

  it('walked a non-empty family — the floor', () => {
    expect(CATALOG_LOCALIZATION_TEXT_TABLES.length).toBeGreaterThan(1);
    expect(LOCALIZATION_COVERAGE_DOMAINS.length).toBeGreaterThan(0);
  });

  it('does not claim a table as both covered and uncovered', () => {
    const covered = new Set(LOCALIZATION_COVERAGE_DOMAINS.map((d) => DOMAIN_TABLES[d]));
    for (const entry of LOCALIZATION_COVERAGE_UNCOVERED_TABLES) {
      expect(covered.has(entry.table)).toBe(false);
    }
  });

  it('gives every uncovered table a non-trivial reason', () => {
    // A reason is what makes the omission a decision rather than a gap. A short
    // one is a placeholder, and a placeholder is how a census stops being one.
    expect(LOCALIZATION_COVERAGE_UNCOVERED_TABLES.length).toBeGreaterThan(0);
    for (const entry of LOCALIZATION_COVERAGE_UNCOVERED_TABLES) {
      expect(entry.reason.length).toBeGreaterThan(60);
    }
  });

  it('states an owed-population rule for every covered domain', () => {
    for (const domain of LOCALIZATION_COVERAGE_DOMAINS) {
      expect(LOCALIZATION_OWED_POPULATION_RULES[domain]).toBeTruthy();
      expect(LOCALIZATION_OWED_POPULATION_RULES[domain].length).toBeGreaterThan(60);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('staleness detection is described per domain and matches the SQL', () => {
  /**
   * The migration holding a trigger body, located by CONTENT and asserted found
   * exactly once — `catalog-localization.test.ts`'s device. A path lookup would
   * silently measure a stale copy after a regeneration moved the block.
   */
  function fileContaining(needle: string): { path: string; text: string } {
    const candidates = [join(BACKEND_SRC, 'db', 'schema', 'catalogLocalization.pending.sql')];
    for (const entry of readdirSync(DRIZZLE_DIR)) {
      if (entry.endsWith('.sql')) candidates.push(join(DRIZZLE_DIR, entry));
    }
    const found = candidates
      .filter((path) => existsSync(path))
      .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
      .filter((file) => file.text.includes(needle));
    expect(found.map((file) => file.path)).toHaveLength(1);
    return found[0];
  }

  it('describes exactly the covered domains, one each', () => {
    const described = LOCALIZATION_STALENESS_DETECTIONS.map((entry) => entry.domain).sort();
    expect(described).toEqual([...LOCALIZATION_COVERAGE_DOMAINS].sort());
    expect(described).toHaveLength(new Set(described).size);
  });

  it('names a real trigger for every database_trigger domain, watching what it claims', () => {
    const triggerDomains = LOCALIZATION_STALENESS_DETECTIONS.filter(
      (entry) => entry.mechanism === 'database_trigger',
    );
    // The floor: if the mechanism value were renamed, this filter would be empty
    // and every assertion in the loop would pass by not running.
    expect(triggerDomains.length).toBeGreaterThan(0);

    for (const detection of triggerDomains) {
      const file = fileContaining(`CREATE TRIGGER ${detection.performedBy}`);
      // The WHEN clause is what the descriptor's `watches` claims to mirror, and
      // it is the half a reader of the report depends on: it decides which
      // source edits can ever produce a `stale` count.
      const at = file.text.indexOf(`CREATE TRIGGER ${detection.performedBy}`);
      const when = file.text.slice(at, file.text.indexOf('EXECUTE FUNCTION', at));
      for (const source of detection.watches) {
        const column = source.split('.')[1];
        expect(when).toContain(`NEW.${column}`);
      }
      // And the claimed blind spots really are blind: a column named in
      // `unwatched` must NOT appear in the WHEN clause, or the caveat is a
      // warning about a case that is actually covered.
      for (const source of detection.unwatched) {
        const column = source.split('.')[1].split(' ')[0];
        expect(when).not.toContain(`NEW.${column}`);
      }
    }
  });

  it("the category trigger's description blind spot is real and load-bearing", () => {
    // The single most consequential caveat this domain publishes: a registered
    // localized field (`category.description`) whose source edit marks nothing
    // stale. Asserted directly rather than only through the loop above, because
    // if it were ever fixed, the descriptor must be updated in the same change —
    // and a caveat claiming a blind spot that no longer exists is a report
    // telling operators to distrust a number that is fine.
    const detection = LOCALIZATION_STALENESS_DETECTIONS.find((e) => e.domain === 'category');
    expect(detection).toBeDefined();
    expect(detection.unwatched).toContain('categories.description');
    expect(LOCALIZED_FIELD_KEYS).toContain('category.description');
  });

  it('the service-staled domain names a function that exists in the source', () => {
    const detection = LOCALIZATION_STALENESS_DETECTIONS.find(
      (entry) => entry.mechanism === 'service_copy_forward',
    );
    expect(detection).toBeDefined();
    const repository = readFileSync(
      join(BACKEND_SRC, 'db', 'catalogLocalization', 'productTypeLocalizationRepository.ts'),
      'utf8',
    );
    expect(repository).toContain(`export async function ${detection.performedBy}`);
    // …and there is genuinely NO trigger writing `stale` into the VERSION-level
    // table, which is the asymmetry the whole descriptor exists to publish. A
    // trigger added later must move this domain to `database_trigger` rather
    // than leave two mechanisms disagreeing.
    //
    // Keyed on the STATEMENT rather than on a trigger-name pattern. #633 added
    // `mercaria_product_type_fields_localization_stale`, which a name pattern
    // like `\w*product_type\w*_localization_stale` matches — so the obvious
    // spelling started reporting a trigger for THIS domain that belongs to a
    // different one. What the descriptor claims is that nothing marks
    // `product_type_localizations` stale, and that is what is asserted.
    const staleWrite = /UPDATE "product_type_localizations"\s*\n\s*SET status = 'stale'/u;
    const files = readdirSync(DRIZZLE_DIR)
      .filter((entry) => entry.endsWith('.sql'))
      .map((entry) => readFileSync(join(DRIZZLE_DIR, entry), 'utf8'));
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((text) => staleWrite.test(text))).toBe(false);
    // Positive control: the SAME pattern against a table that IS staled by a
    // trigger must match, or the assertion above is a regex that can never fire.
    const fieldStaleWrite = /UPDATE "product_type_field_localizations"\s*\n\s*SET status = 'stale'/u;
    expect(files.some((text) => fieldStaleWrite.test(text))).toBe(true);
  });

  it('mechanisms are not all the same value — the asymmetry is the finding', () => {
    // If every domain staled the same way, a single summed `stale` count would
    // be honest and this whole descriptor would be ceremony. It is not, and this
    // is what fails if somebody "simplifies" it to one mechanism.
    const mechanisms = new Set(LOCALIZATION_STALENESS_DETECTIONS.map((e) => e.mechanism));
    expect(mechanisms.size).toBeGreaterThan(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('every registered field states where its base text lives', () => {
  const TABLES = {
    categories,
    product_type_definitions: productTypeDefinitions,
    product_type_fields: productTypeFields,
    attribute_enum_values: attributeEnumValues,
  };

  function columnNames(table: keyof typeof TABLES): string[] {
    const drizzleTable = TABLES[table];
    return Object.values(getTableColumns(drizzleTable)).map((column) => sqlColumnName(column));
  }

  it('has an entry for every registered field and no others', () => {
    expect(Object.keys(LOCALIZED_FIELD_BASE_SOURCES).sort()).toEqual([...LOCALIZED_FIELD_KEYS].sort());
  });

  it('names a column that really exists, for every `column` entry', () => {
    const named = Object.values(LOCALIZED_FIELD_BASE_SOURCES).filter((s) => s.kind === 'column');
    // Floor: if the discriminant were renamed this filter empties and the loop
    // asserts nothing.
    expect(named.length).toBeGreaterThan(0);
    for (const source of named) {
      expect(getTableName(TABLES[source.table as keyof typeof TABLES])).toBe(source.table);
      expect(columnNames(source.table as keyof typeof TABLES)).toContain(source.column);
    }
  });

  it('is right that a `none` field has no such column — the direction that rots', () => {
    // This is the assertion that matters over time. A `none` entry is a claim
    // that the schema has no counterpart; if somebody ADDS `categories.description`
    // later, the desk would go on reporting "no source" for a field that now has
    // one, and a reviewer would see an empty box beside real English text.
    const noneEntries = Object.entries(LOCALIZED_FIELD_BASE_SOURCES).filter(
      ([, source]) => source.kind === 'none',
    );
    expect(noneEntries.length).toBeGreaterThan(0);
    for (const [field, source] of noneEntries) {
      expect(source.kind).toBe('none');
      const descriptor = CATALOG_LOCALIZED_FIELDS[field];
      const table =
        descriptor.entity === 'category'
          ? 'categories'
          : descriptor.entity === 'product_type'
            ? 'product_type_definitions'
            : 'attribute_enum_values';
      expect(columnNames(table as keyof typeof TABLES)).not.toContain(descriptor.column);
    }
  });

  it('positive control: a column the entity DOES have is detected', () => {
    // Proves the column walk above can actually find something, so a `not
    // .toContain` passing is evidence rather than an empty read.
    expect(columnNames('categories')).toContain('name');
    expect(columnNames('product_type_definitions')).toContain('description');
    expect(columnNames('attribute_enum_values')).toContain('label');
  });
});

/* -------------------------------------------------------------------------- */

describe('the operator route set is closed', () => {
  function registeredPaths(): string[] {
    const stack = (internalCatalogLocalizationRouter as unknown as {
      stack: { route?: { path: string; methods: Record<string, boolean> } }[];
    }).stack;
    return stack
      .filter((layer) => layer.route)
      .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`)
      .sort();
  }

  it('registers exactly three GETs and nothing else', () => {
    // Asserted EXACTLY rather than by containment, so a fourth route is a
    // decision somebody makes on purpose — `/internal/catalog-metrics`' device.
    expect(registeredPaths()).toEqual([
      'GET /alerts',
      'GET /completeness',
      'GET /review/:domain/:entityId',
    ]);
  });

  it('registers no write verb at all', () => {
    const stack = (internalCatalogLocalizationRouter as unknown as {
      stack: { route?: { methods: Record<string, boolean> } }[];
    }).stack;
    const verbs = new Set(
      stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods)),
    );
    // The review DECISION lives at `/internal/catalog-governance/reviews/localization`.
    // A second route to one decision is how two surfaces come to disagree.
    expect([...verbs].sort()).toEqual(['get']);
  });
});

/* -------------------------------------------------------------------------- */

describe('the vocabularies are closed and non-degenerate', () => {
  it('alert kinds and severities are distinct and non-empty', () => {
    expect(LOCALIZATION_ALERT_KINDS.length).toBeGreaterThan(1);
    expect(new Set(LOCALIZATION_ALERT_KINDS).size).toBe(LOCALIZATION_ALERT_KINDS.length);
    expect(new Set(LOCALIZATION_ALERT_SEVERITIES).size).toBe(LOCALIZATION_ALERT_SEVERITIES.length);
  });

  it('has no `ok` alert kind — an alert set is the findings', () => {
    // A "no problem" finding is how a list of problems acquires padding that
    // hides the real ones.
    expect(LOCALIZATION_ALERT_KINDS).not.toContain('ok');
    expect(LOCALIZATION_ALERT_KINDS).not.toContain('none');
  });
});
