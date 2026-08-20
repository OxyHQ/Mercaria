/**
 * Catalog localization (ADR 0007 D4) — the half that needs no database.
 *
 * Three kinds of gate live here, and each exists because the thing it measures
 * fails SILENTLY:
 *
 * 1. **The family census.** Four per-entity tables buy referential integrity and
 *    cost the one thing a polymorphic table gets for free — a single column set.
 *    The census walks the real drizzle tables and fails the build on a member
 *    whose shape drifted, on a new `_localizations` table nobody registered, and
 *    on an exemption list that grew.
 * 2. **The fallback wiring.** All fourteen registered fields are
 *    `catalog_presentation` today, so a resolver that ignored the descriptor and
 *    hardcoded `'language_then_base'` would pass every behavioural test in this
 *    file. The anchored source census over `resolve.ts` is what closes that: it
 *    asserts every `localeFallbackPlan(...)` and `localeFallbackChain(...)` call
 *    site takes its policy from the field descriptor, from
 *    `fallbackPolicyForFieldClass` or from a forwarded parameter and never from
 *    a literal, and it carries a mutation self-test per token so a broken
 *    pattern cannot report a clean zero. It also asserts the chain has ZERO call
 *    sites there — nothing in that module resolves from a flat locale list,
 *    which is what keeps `exact_locale_then_base` from becoming
 *    `language_then_base` under a new name.
 * 3. **The trigger tuples.** The two triggers are hand-written SQL and the
 *    statuses they name also live in shared-types tuples. Two spellings of one
 *    fact drift; the SQL census reads the file back and asserts the rendered
 *    lists match.
 *
 * The CHECKs, the triggers and the partial uniques themselves are pinned in
 * `catalog-localization.realdb.test.ts` against a REAL server, because a mocked
 * insert accepts a statement the server rejects outright.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import { describe, expect, it } from 'vitest';
import {
  AUTHORED_BASE_FALLBACK_FIELD_CLASSES,
  BASE_LOCALE_STATUS,
  CATALOG_LOCALIZATION_TEXT_TABLES,
  CATALOG_LOCALIZED_FIELDS,
  CROSS_MARKET_FALLBACK_FIELD_CLASSES,
  HUMAN_SETTLED_LOCALIZATION_STATUSES,
  LOCALIZATION_FALLBACK_POLICIES,
  LOCALIZATION_RESOLUTION_BASES,
  LOCALIZATION_FAMILY_COLUMNS,
  LOCALIZATION_FAMILY_COLUMN_EXEMPTIONS,
  LOCALIZATION_PROVENANCES,
  LOCALIZATION_STATUSES,
  NAVIGATION_LOCALIZATION_PROVENANCES,
  NAVIGATION_LOCALIZATION_STATUSES,
  LOCALIZED_ENTITY_KINDS,
  LOCALIZED_FIELD_CLASSES,
  LOCALIZED_FIELD_KEYS,
  MERCARIA_BASE_LOCALE,
  SERVABLE_LOCALIZATION_STATUSES,
  STALE_ON_SOURCE_CHANGE_STATUSES,
  SUPPORTED_LOCALES,
  fallbackPolicyForFieldClass,
  type LocalizationCandidate,
} from '@mercaria/shared-types';
import * as schema from '../schema/index.js';
import { attributeLabels } from '../schema/attributeRegistry.js';
import {
  attributeValueLocalizations,
  canonicalProductFamilyLocalizations,
  canonicalProductLocalizations,
  categoryLocalizations,
  categoryLocalizedSlugs,
  productTypeFieldLocalizations,
  productTypeLocalizations,
} from '../schema/catalogLocalization.js';
import {
  foldLocale,
  isSupportedLocale,
  localeFallbackChain,
  localeFallbackPlan,
  resolveLocalizedField,
  resolveLocalizedSlug,
} from '../../services/catalog-localization/resolve.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_SRC = join(HERE, '..', '..');
const DRIZZLE_DIR = join(BACKEND_SRC, '..', 'drizzle');

const tables = Object.values(schema).flatMap((value) => (is(value, PgTable) ? [value] : []));

/** A localization row, spelled once so a case reads as its own difference. */
function candidate(
  locale: string,
  value: string | null,
  status: LocalizationCandidate['status'] = 'approved',
  provenance: LocalizationCandidate['provenance'] = 'professional',
): LocalizationCandidate {
  return { locale, status, provenance, value };
}

describe('the localization vocabulary', () => {
  it('authors in lowercase BCP 47 and nothing else', () => {
    expect(SUPPORTED_LOCALES.length).toBeGreaterThanOrEqual(10);
    for (const locale of SUPPORTED_LOCALES) {
      expect(locale).toBe(locale.toLowerCase());
      expect(locale).toMatch(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/u);
    }
    expect(new Set(SUPPORTED_LOCALES).size).toBe(SUPPORTED_LOCALES.length);
  });

  it('has a base locale it can actually author in', () => {
    expect(SUPPORTED_LOCALES).toContain(MERCARIA_BASE_LOCALE);
    // A base locale with a region would make every other market of the same
    // language a fallback from ONE market's copy. See the constant's doc.
    expect(MERCARIA_BASE_LOCALE).not.toContain('-');
  });

  it('serves neither an empty row nor a withdrawn one', () => {
    for (const status of SERVABLE_LOCALIZATION_STATUSES) {
      expect(LOCALIZATION_STATUSES).toContain(status);
    }
    expect(SERVABLE_LOCALIZATION_STATUSES).not.toContain('missing');
    expect(SERVABLE_LOCALIZATION_STATUSES).not.toContain('deprecated');
    // The vacuity floor on the other side: if every status were servable the
    // list would enforce nothing.
    expect(SERVABLE_LOCALIZATION_STATUSES.length).toBeLessThan(LOCALIZATION_STATUSES.length);
  });

  it('refuses a machine write on settled text and permits one on stale text', () => {
    expect([...HUMAN_SETTLED_LOCALIZATION_STATUSES]).toEqual(['reviewed', 'approved']);
    // The deliberate reading of D4, and the one somebody would "fix" without
    // this line: a stale row is human text that no longer describes the source,
    // so a fresh machine translation of the new source replaces it.
    expect(HUMAN_SETTLED_LOCALIZATION_STATUSES).not.toContain('stale');
  });

  it('makes stale from every status that has something to stale', () => {
    for (const status of STALE_ON_SOURCE_CHANGE_STATUSES) {
      expect(LOCALIZATION_STATUSES).toContain(status);
    }
    expect(STALE_ON_SOURCE_CHANGE_STATUSES).not.toContain('missing');
    expect(STALE_ON_SOURCE_CHANGE_STATUSES).not.toContain('deprecated');
    expect(STALE_ON_SOURCE_CHANGE_STATUSES).not.toContain('stale');
  });

  it('grants cross-market fallback by an explicit list that is not everything', () => {
    for (const granted of CROSS_MARKET_FALLBACK_FIELD_CLASSES) {
      expect(LOCALIZED_FIELD_CLASSES).toContain(granted);
    }
    // The whole rule, as a floor: if every class were granted, D4's exclusion of
    // legal and seller-authored text would be enforced by nothing.
    expect(CROSS_MARKET_FALLBACK_FIELD_CLASSES.length).toBeLessThan(
      LOCALIZED_FIELD_CLASSES.length,
    );
    expect(CROSS_MARKET_FALLBACK_FIELD_CLASSES).not.toContain('legal_text');
    // Still excluded, and this line is the one that must not be "fixed" when
    // seller-authored text starts falling back: what it gains is its OWN base
    // text, which is a different grant on a different list.
    expect(CROSS_MARKET_FALLBACK_FIELD_CLASSES).not.toContain('seller_authored');
  });

  it('grants own-base fallback by a SECOND list, disjoint from the first', () => {
    for (const granted of AUTHORED_BASE_FALLBACK_FIELD_CLASSES) {
      expect(LOCALIZED_FIELD_CLASSES).toContain(granted);
    }
    expect(AUTHORED_BASE_FALLBACK_FIELD_CLASSES.length).toBeLessThan(
      LOCALIZED_FIELD_CLASSES.length,
    );
    // Disjoint, so no class is granted by both and the ORDER of the tests inside
    // `fallbackPolicyForFieldClass` decides nothing. Two overlapping grant lists
    // would make the policy a function of which `if` was written first.
    const crossMarket = new Set<string>(CROSS_MARKET_FALLBACK_FIELD_CLASSES);
    for (const granted of AUTHORED_BASE_FALLBACK_FIELD_CLASSES) {
      expect(crossMarket.has(granted)).toBe(false);
    }
    // Legal text is in NEITHER list, and that is the reading to hold: a
    // statement about one market's law is not made true by the same company
    // having written it.
    expect(AUTHORED_BASE_FALLBACK_FIELD_CLASSES).not.toContain('legal_text');

    // A class in neither list gets the NARROWEST policy. Both lists are grants,
    // so a fourth class added later reaches nothing by default.
    const grantedAnywhere = new Set<string>([
      ...CROSS_MARKET_FALLBACK_FIELD_CLASSES,
      ...AUTHORED_BASE_FALLBACK_FIELD_CLASSES,
    ]);
    const ungranted = LOCALIZED_FIELD_CLASSES.filter((cls) => !grantedAnywhere.has(cls));
    // The floor. With every class granted this loop would run zero times and
    // assert nothing, which is exactly how a grant list stops being one.
    expect(ungranted.length).toBeGreaterThanOrEqual(1);
    for (const cls of ungranted) {
      expect(fallbackPolicyForFieldClass(cls)).toBe('exact_locale_only');
    }
  });

  it('derives one policy per class, and all THREE policies are reachable', () => {
    expect(fallbackPolicyForFieldClass('catalog_presentation')).toBe('language_then_base');
    expect(fallbackPolicyForFieldClass('legal_text')).toBe('exact_locale_only');
    expect(fallbackPolicyForFieldClass('seller_authored')).toBe('exact_locale_then_base');
    const derived = new Set(LOCALIZED_FIELD_CLASSES.map(fallbackPolicyForFieldClass));
    // Every published policy is reachable from some class, and every class
    // derives a published policy. A policy nobody can reach is a branch of
    // `localeFallbackPlan` no test can exercise.
    expect([...derived].sort()).toEqual([...LOCALIZATION_FALLBACK_POLICIES].sort());
    expect(derived.size).toBe(3);
  });
});

describe('the field registry', () => {
  it('registers exactly the keys it publishes', () => {
    expect(Object.keys(CATALOG_LOCALIZED_FIELDS).sort()).toEqual([...LOCALIZED_FIELD_KEYS].sort());
    expect(LOCALIZED_FIELD_KEYS.length).toBeGreaterThanOrEqual(4);
  });

  it('never states a fallback policy — every one is derived from the class', () => {
    for (const key of LOCALIZED_FIELD_KEYS) {
      const descriptor = CATALOG_LOCALIZED_FIELDS[key];
      expect(descriptor.key).toBe(key);
      expect(LOCALIZED_ENTITY_KINDS).toContain(descriptor.entity);
      expect(LOCALIZED_FIELD_CLASSES).toContain(descriptor.fieldClass);
      expect(descriptor.fallback).toBe(fallbackPolicyForFieldClass(descriptor.fieldClass));
    }
  });

  it('names a column that exists on the entity table it belongs to', () => {
    const tableForEntity = {
      category: categoryLocalizations,
      product_type: productTypeLocalizations,
      product_type_field: productTypeFieldLocalizations,
      attribute_value: attributeValueLocalizations,
      canonical_product: canonicalProductLocalizations,
      canonical_product_family: canonicalProductFamilyLocalizations,
      // The family's one late joiner. Its columns arrive through a SPREAD of
      // `localizationSettlementColumns()`, so `status` and `provenance` appear
      // nowhere in `attributeRegistry.ts` as literal text — which is exactly why
      // this census reads `getTableColumns()` on the BUILT table instead of
      // grepping source. A name-keyed source scan returns zero here, and the
      // zero is false.
      attribute_definition: attributeLabels,
    } as const;
    for (const key of LOCALIZED_FIELD_KEYS) {
      const descriptor = CATALOG_LOCALIZED_FIELDS[key];
      const columns = getTableColumns(tableForEntity[descriptor.entity]);
      expect(Object.keys(columns)).toContain(descriptor.column);
    }
  });

  it('registers no field whose entity has no table here', () => {
    // This list used to end by explaining why `attribute_definition` was NOT a
    // kind: `attribute_labels` carried no status and no provenance, so a
    // candidate built from one of its rows would have had to invent both, and
    // the comment said "this is the line that fails when somebody adds the kind
    // without adding the columns."
    //
    // Migration 0119 added the columns and this migration adds the kind, in that
    // order and in that dependency — `reviewAttributeDefinitionLocalization`
    // composes a comparison carrying `status` and `provenance` off the row and
    // could not have compiled before them. The gate did exactly what it said it
    // would: it went red on the kind, and closing it meant proving the columns
    // were there first.
    expect([...LOCALIZED_ENTITY_KINDS]).toEqual([
      'category',
      'product_type',
      // `product_type_field` is a SEPARATE kind from `product_type` on purpose:
      // one localizes the form, the other one question on it, and they resolve
      // against different tables. Folding them would make a field's help text
      // and the whole schema's help text the same string.
      'product_type_field',
      'attribute_value',
      // #367 Translation model L2. Mercaria's OWN catalogue copy about a product
      // and a family — `catalog_presentation`, so both fall back across markets.
      // The fields that read like a name and are NOT presentation have no entry
      // in the registry and no column on either table; see
      // `catalog-name-invariance.ts`.
      'canonical_product',
      'canonical_product_family',
      // One ATTRIBUTE DEFINITION's own label and description — the question,
      // where `attribute_value` above is one of its answers. "Charging port" and
      // "USB-C" are not the same string, so folding them into one kind would put
      // a value's translation under its attribute's heading.
      'attribute_definition',
    ]);
  });
});

describe('the family census', () => {
  const localizationTables = tables.filter((table) => getTableName(table).endsWith('_localizations'));

  it('finds every `_localizations` table registered in the family list', () => {
    // The floor: a broken import or a renamed barrel would traverse nothing and
    // report a clean family.
    expect(localizationTables.length).toBeGreaterThanOrEqual(3);
    for (const table of localizationTables) {
      expect(CATALOG_LOCALIZATION_TEXT_TABLES).toContain(getTableName(table));
    }
  });

  it('names only tables that exist', () => {
    const present = new Set(tables.map(getTableName));
    for (const name of CATALOG_LOCALIZATION_TEXT_TABLES) {
      expect(present.has(name)).toBe(true);
    }
  });

  it('gives every non-exempt member the identical column set', () => {
    const exempt: ReadonlySet<string> = new Set<string>(
      LOCALIZATION_FAMILY_COLUMN_EXEMPTIONS.map((entry) => entry.table),
    );
    const checked: string[] = [];
    for (const name of CATALOG_LOCALIZATION_TEXT_TABLES) {
      if (exempt.has(name)) continue;
      const table = tables.find((entry) => getTableName(entry) === name);
      expect(table).toBeDefined();
      const columnNames = Object.values(getTableColumns(table)).map(sqlColumnName);
      for (const required of LOCALIZATION_FAMILY_COLUMNS) {
        expect(columnNames).toContain(required);
      }
      checked.push(name);
    }
    expect(checked.length).toBeGreaterThanOrEqual(3);
  });

  it('holds every member to ONE status and provenance vocabulary', () => {
    // `navigation_node_localizations` (ADR 0007 D3) carries its own copies of
    // D4's two tuples, and its own doc comment names the hazard exactly: "two
    // vocabularies can disagree, and the direction they disagree in is always
    // the permissive one." They are identical today; this is what notices the
    // day they are not. The swap its comment describes — importing these tuples
    // and re-rendering the CHECKs — is one edit plus one migration, and belongs
    // to whoever owns that file rather than to this rebase.
    expect([...NAVIGATION_LOCALIZATION_STATUSES]).toEqual([...LOCALIZATION_STATUSES]);
    expect([...NAVIGATION_LOCALIZATION_PROVENANCES]).toEqual([...LOCALIZATION_PROVENANCES]);
  });

  it('keeps the exemption list EMPTY, and any entry that returns real', () => {
    // It reached zero, which is what it was built to do. `attribute_labels` was
    // the one entry: it predated ADR 0007 D4, carried no `status` and no
    // `provenance`, and therefore could not execute the machine-write guard —
    // the guard's body reads both. It now carries all seven family columns and
    // the guard is attached, so the exemption described nothing and was
    // deleted.
    //
    // The exact count stays asserted rather than relaxed to "0 or more". A
    // silent re-entry is precisely what this census exists to prevent, and a
    // floor of zero is satisfied by any list at all.
    expect(
      LOCALIZATION_FAMILY_COLUMN_EXEMPTIONS,
      'a family member has been exempted again — an exemption is a decision and belongs in a diff',
    ).toHaveLength(0);

    // The loop is KEPT against the empty list rather than deleted with it. If a
    // future member is exempted, it is held to the same two rules on the same
    // day it is added: a reason somebody can read, and a gap that is genuinely
    // there. Deleting the loop would mean the next exemption arrives ungated.
    for (const entry of LOCALIZATION_FAMILY_COLUMN_EXEMPTIONS) {
      expect(entry.reason.length).toBeGreaterThan(40);
      const table = tables.find((candidateTable) => getTableName(candidateTable) === entry.table);
      expect(table).toBeDefined();
      const columnNames = new Set(Object.values(getTableColumns(table)).map(sqlColumnName));
      const missing = LOCALIZATION_FAMILY_COLUMNS.filter((name) => !columnNames.has(name));
      // An exemption for a table that already complies is an exemption nobody
      // removed, and it is how a census stops being one.
      expect(missing.length).toBeGreaterThan(0);
    }
  });

  it('carries the localized-slug table outside the text family, deliberately', () => {
    const slugColumns = new Set(
      Object.values(getTableColumns(categoryLocalizedSlugs)).map(sqlColumnName),
    );
    // `superseded_at` is a slug's whole lifecycle, so a `status` column beside it
    // would be a second answer to the one question a slug has.
    expect(slugColumns.has('superseded_at')).toBe(true);
    expect(slugColumns.has('status')).toBe(false);
    expect(slugColumns.has('provenance')).toBe(true);
    expect(CATALOG_LOCALIZATION_TEXT_TABLES).not.toContain('category_localized_slugs');
  });
});

describe('the fallback chain', () => {
  it('answers the exact locale first', () => {
    expect(localeFallbackChain('es-ES', 'language_then_base')[0]).toBe('es-es');
  });

  it('falls from a market to its language and then to base', () => {
    expect([...localeFallbackChain('es-mx', 'language_then_base')]).toEqual(['es-mx', 'es', 'en']);
  });

  it('reaches a language even when the market tag is not one Mercaria authors', () => {
    // `es-cl` is not in SUPPORTED_LOCALES, so it contributes only its truncation.
    // A chain that named it would name a locale with no row shape at all.
    expect([...localeFallbackChain('es-CL', 'language_then_base')]).toEqual(['es', 'en']);
  });

  it('always ends at the base locale, even for a language it does not know', () => {
    expect([...localeFallbackChain('sw-KE', 'language_then_base')]).toEqual(['en']);
  });

  it('never leaves the exact locale under the exclusion policy', () => {
    expect([...localeFallbackChain('es-mx', 'exact_locale_only')]).toEqual(['es-mx']);
    // …and answers nothing at all for a market Mercaria does not author in,
    // which is what turns a legal-text request into `unsupported_locale` rather
    // than into another market's copy.
    expect([...localeFallbackChain('es-CL', 'exact_locale_only')]).toEqual([]);
    expect([...localeFallbackChain('sw-KE', 'exact_locale_only')]).toEqual([]);
  });

  it('folds case and repairs a POSIX tag', () => {
    expect(foldLocale('  es_MX ')).toBe('es-mx');
    expect(isSupportedLocale(foldLocale('ZH-Hans'))).toBe(true);
    expect(isSupportedLocale('sw-ke')).toBe(false);
  });

  it('narrows a QUERY on a superset that keeps the base locale', () => {
    // `localeFallbackChain` is not the resolver's reach and must not be read as
    // one. It answers "which locales might a row I need be stored under", and it
    // keeps the base locale because `attribute_labels` deliberately carries no
    // base-locale CHECK — its own schema comment names "a stray `en` row", and
    // `schema.service.ts` walks this list over exactly that table.
    expect(localeFallbackChain('es-mx', 'language_then_base')).toContain(MERCARIA_BASE_LOCALE);
    // The plan does NOT, because a base-locale row is unrepresentable in the
    // family tables and the base string is the entity's own column.
    expect(localeFallbackPlan('es-mx', 'language_then_base').rowLocales).not.toContain(
      MERCARIA_BASE_LOCALE,
    );
  });
});

/**
 * The gate for `exact_locale_then_base` (#367).
 *
 * The failure it exists to catch is silent and looks like a feature working: a
 * policy that reaches the truncation chain is `language_then_base` under a new
 * name, every behavioural test still passes, and the cross-market exclusion the
 * whole class system exists for is gone with nothing saying so.
 */
describe('the own-base policy reaches exactly two places', () => {
  /**
   * A population, not a handful of examples.
   *
   * Every supported locale, plus tags Mercaria does not author in — including
   * the ones with a supported TRUNCATION, which are the only ones on which a
   * chain walk and an exact lookup differ.
   */
  const UNSUPPORTED_WITH_SUPPORTED_TRUNCATION = ['es-cl', 'en-au', 'fr-ma', 'zh-hant-tw'] as const;
  const UNSUPPORTED_ENTIRELY = ['sw-ke', 'is', 'xx-yy'] as const;
  const PROBES: readonly string[] = [
    ...SUPPORTED_LOCALES,
    ...UNSUPPORTED_WITH_SUPPORTED_TRUNCATION,
    ...UNSUPPORTED_ENTIRELY,
  ];

  it('never reaches more than the requested locale itself', () => {
    // The floor. A probe list that collapsed to nothing would assert nothing.
    expect(PROBES.length).toBeGreaterThanOrEqual(40);
    for (const probe of PROBES) {
      const plan = localeFallbackPlan(probe, 'exact_locale_then_base');
      expect(plan.rowLocales.length, probe).toBeLessThanOrEqual(1);
      if (plan.rowLocales.length === 1) {
        expect(plan.rowLocales[0], probe).toBe(foldLocale(probe));
      }
      // The second of the two places, and the only thing it may add.
      expect(plan.baseText, probe).toBe('permitted');
    }
  });

  it('reaches EXACTLY what exact_locale_only reaches, plus the base column', () => {
    // The strongest statement of the rule, and the one that makes the existing
    // policy provably untouched: the two policies share ONE row-locale producer,
    // so any widening of the new one is a widening of the old one in the same
    // edit. `baseText` is the whole of the difference.
    let differed = 0;
    for (const probe of PROBES) {
      const exact = localeFallbackPlan(probe, 'exact_locale_only');
      const thenBase = localeFallbackPlan(probe, 'exact_locale_then_base');
      expect([...thenBase.rowLocales], probe).toEqual([...exact.rowLocales]);
      expect(exact.baseText, probe).toBe('withheld');
      expect(thenBase.baseText, probe).toBe('permitted');
      differed += 1;
    }
    expect(differed).toBe(PROBES.length);
  });

  it('is genuinely narrower than the cross-market chain — the positive control', () => {
    // Without this the two assertions above are satisfied by a `localeFallbackPlan`
    // that reaches nothing at all for every policy. At least one probe must show
    // `language_then_base` reaching strictly further.
    const widened = PROBES.filter(
      (probe) =>
        localeFallbackPlan(probe, 'language_then_base').rowLocales.length >
        localeFallbackPlan(probe, 'exact_locale_then_base').rowLocales.length,
    );
    expect(widened.length).toBeGreaterThanOrEqual(1);
    // …and name one, so a reader can see which case the difference lives in.
    expect(widened).toContain('es-cl');
    expect([...localeFallbackPlan('es-cl', 'language_then_base').rowLocales]).toEqual(['es']);
    expect([...localeFallbackPlan('es-cl', 'exact_locale_then_base').rowLocales]).toEqual([]);
  });

  it('detects a chain walk — the mutation self-test', () => {
    // What the gate above would look at if `onlyTheRequestedLocale` were
    // widened to walk truncations. Both of the first two assertions must fail on
    // it, or they are measuring nothing.
    const mutated = (probe: string) => localeFallbackPlan(probe, 'language_then_base').rowLocales;
    const es = mutated('es-mx');
    expect(es.length).toBeGreaterThan(1);
    expect([...es]).not.toEqual([...localeFallbackPlan('es-mx', 'exact_locale_only').rowLocales]);
  });
});

describe('resolving a seller-authored field', () => {
  /**
   * `CATALOG_LOCALIZED_FIELDS` carries no `seller_authored` member today, so the
   * policy is exercised through the ONE derivation every descriptor uses rather
   * than through a registered key. The alternative — registering a fake field —
   * would put a key in the public union that no table backs.
   */
  const OWN_BASE = fallbackPolicyForFieldClass('seller_authored');

  it('answers the requested locale from its own row, as before', () => {
    const plan = localeFallbackPlan('fr', OWN_BASE);
    expect([...plan.rowLocales]).toEqual(['fr']);
  });

  it('answers a MISSING locale from the seller’s own base text, not from a sibling', () => {
    // The motivating case: a French shopper on a listing with no French row.
    // `fr-ca` truncates to `fr`, and a French-Canadian row must NOT answer it.
    const plan = localeFallbackPlan('fr', OWN_BASE);
    expect(plan.rowLocales).not.toContain('fr-ca');
    expect(plan.rowLocales).not.toContain('es');
    expect(plan.baseText).toBe('permitted');
  });

  it('reaches the base for a market Mercaria does not author in', () => {
    // `es-cl` is unsupported. Under `exact_locale_only` this is
    // `unsupported_locale` and the page is empty; under the new policy it is the
    // seller's own words, and it still never sees the `es` row.
    const plan = localeFallbackPlan('es-CL', OWN_BASE);
    expect([...plan.rowLocales]).toEqual([]);
    expect(plan.baseText).toBe('permitted');
  });

  it('leaves exact_locale_only answering `unavailable` on a missing row', () => {
    // The untouched-policy proof, driven through the real resolver rather than
    // through the plan: `category.name` is `catalog_presentation`, so it is
    // resolved under the policy its own class derives, and this case is the
    // behaviour a legal-text field will rely on.
    const plan = localeFallbackPlan('es-mx', 'exact_locale_only');
    expect([...plan.rowLocales]).toEqual(['es-mx']);
    expect(plan.baseText).toBe('withheld');

    const unsupported = localeFallbackPlan('es-CL', 'exact_locale_only');
    expect([...unsupported.rowLocales]).toEqual([]);
    expect(unsupported.baseText).toBe('withheld');
  });
});

describe('the own-base policy is reachable only from the classes it is assigned to', () => {
  /**
   * The before/after COUNT this change is measured by.
   *
   * Counted off the registry itself rather than claimed. Today every registered
   * field is `catalog_presentation`, so assigning `seller_authored` a new policy
   * moves NO registered field — which is the honest reading of "this changes
   * nothing today", stated as a number somebody can re-run.
   */
  const byPolicy = (policy: string): readonly string[] =>
    LOCALIZED_FIELD_KEYS.filter((key) => CATALOG_LOCALIZED_FIELDS[key].fallback === policy);

  it('moves no registered field, and says how many that is', () => {
    expect(LOCALIZED_FIELD_KEYS.length).toBe(14);
    expect(byPolicy('language_then_base')).toHaveLength(14);
    expect(byPolicy('exact_locale_then_base')).toHaveLength(0);
    expect(byPolicy('exact_locale_only')).toHaveLength(0);
  });

  it('can SEE a field on the new policy — the positive control', () => {
    // Without this, "0 fields on the new policy" and "the census cannot read
    // `fallback` at all" produce the same green. A synthetic descriptor built
    // by the same derivation the registry uses must be counted.
    const synthetic = {
      ...CATALOG_LOCALIZED_FIELDS['category.name'],
      fieldClass: 'seller_authored' as const,
      fallback: fallbackPolicyForFieldClass('seller_authored'),
    };
    expect(synthetic.fallback).toBe('exact_locale_then_base');
    const withSynthetic = [
      ...LOCALIZED_FIELD_KEYS.map((key) => CATALOG_LOCALIZED_FIELDS[key]),
      synthetic,
    ].filter((descriptor) => descriptor.fallback === 'exact_locale_then_base');
    expect(withSynthetic).toHaveLength(1);
  });

  it('publishes exactly the bases the resolver can produce', () => {
    // The tuple is a vocabulary, not decoration: a member nobody can produce is
    // a branch no client will ever handle, and a basis the resolver produces
    // that is NOT in the tuple is a value a client switch has no case for.
    const fromRow = resolveLocalizedField({
      field: 'category.name',
      requestedLocale: 'es',
      candidates: [candidate('es', 'Zapatos')],
      baseValue: 'Shoes',
    });
    const fromBase = resolveLocalizedField({
      field: 'category.name',
      requestedLocale: 'fr',
      candidates: [],
      baseValue: 'Shoes',
    });
    expect(fromRow.outcome).toBe('resolved');
    expect(fromBase.outcome).toBe('resolved');
    if (fromRow.outcome !== 'resolved' || fromBase.outcome !== 'resolved') return;
    const produced = new Set([fromRow.basis, fromBase.basis]);
    expect([...produced].sort()).toEqual([...LOCALIZATION_RESOLUTION_BASES].sort());
  });

  it('grants the new policy to no class outside the grant list', () => {
    const granted = new Set<string>(AUTHORED_BASE_FALLBACK_FIELD_CLASSES);
    for (const cls of LOCALIZED_FIELD_CLASSES) {
      const isGranted = fallbackPolicyForFieldClass(cls) === 'exact_locale_then_base';
      expect(isGranted, cls).toBe(granted.has(cls));
    }
    // The floor: with an empty grant list every class would answer `false` on
    // both sides and this loop would agree with itself about nothing.
    expect(AUTHORED_BASE_FALLBACK_FIELD_CLASSES.length).toBeGreaterThanOrEqual(1);
  });
});

describe('resolving a field', () => {
  it('reports an exact hit as exact, with its status and provenance', () => {
    const resolved = resolveLocalizedField({
      field: 'category.name',
      requestedLocale: 'es-ES',
      candidates: [candidate('es-es', 'Zapatos', 'reviewed', 'professional')],
      baseValue: 'Shoes',
    });
    expect(resolved).toEqual({
      outcome: 'resolved',
      basis: 'localization_row',
      value: 'Zapatos',
      requestedLocale: 'es-es',
      effectiveLocale: 'es-es',
      step: 'exact',
      status: 'reviewed',
      provenance: 'professional',
    });
  });

  it('falls to the language and says so', () => {
    const resolved = resolveLocalizedField({
      field: 'category.name',
      requestedLocale: 'es-mx',
      candidates: [candidate('es', 'Zapatos')],
      baseValue: 'Shoes',
    });
    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome !== 'resolved') return;
    expect(resolved.value).toBe('Zapatos');
    expect(resolved.effectiveLocale).toBe('es');
    expect(resolved.step).toBe('language');
  });

  it('falls to the base value, which lives on the entity and never in a row', () => {
    const resolved = resolveLocalizedField({
      field: 'category.name',
      requestedLocale: 'fr',
      candidates: [],
      baseValue: 'Shoes',
    });
    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome !== 'resolved') return;
    expect(resolved.value).toBe('Shoes');
    expect(resolved.effectiveLocale).toBe(MERCARIA_BASE_LOCALE);
    expect(resolved.step).toBe('base');
    // A base string is not a translation and never claims to be one.
    expect(resolved.basis).toBe('authored_base_text');
    expect(resolved.status).toBe(BASE_LOCALE_STATUS);
    // …and it does not claim an AUTHOR either. The property is absent, not
    // `undefined`-valued: `provenance: 'mercaria'` on a `seller_authored`
    // field's base text would be a false statement about who wrote it, and a
    // storefront would render the seller's own words as Mercaria's copy.
    expect('provenance' in resolved).toBe(false);
  });

  it('serves stale text rather than nothing, and reports that it is stale', () => {
    const resolved = resolveLocalizedField({
      field: 'category.name',
      requestedLocale: 'es',
      candidates: [candidate('es', 'Zapatos', 'stale', 'professional')],
      baseValue: 'Shoes',
    });
    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome !== 'resolved') return;
    expect(resolved.value).toBe('Zapatos');
    expect(resolved.status).toBe('stale');
  });

  it('walks PAST a withdrawn or empty row instead of stopping at it', () => {
    const withdrawn = resolveLocalizedField({
      field: 'category.name',
      requestedLocale: 'es-mx',
      candidates: [
        candidate('es-mx', 'Zapatos MX', 'deprecated', 'community_reviewed'),
        candidate('es', 'Zapatos'),
      ],
      baseValue: 'Shoes',
    });
    expect(withdrawn.outcome).toBe('resolved');
    if (withdrawn.outcome !== 'resolved') return;
    expect(withdrawn.value).toBe('Zapatos');
    expect(withdrawn.effectiveLocale).toBe('es');

    const owed = resolveLocalizedField({
      field: 'category.name',
      requestedLocale: 'es-mx',
      candidates: [candidate('es-mx', null, 'missing', 'mercaria'), candidate('es', 'Zapatos')],
      baseValue: 'Shoes',
    });
    expect(owed.outcome).toBe('resolved');
    if (owed.outcome !== 'resolved') return;
    expect(owed.effectiveLocale).toBe('es');
  });

  it('never answers from a locale outside the field’s own chain', () => {
    // The behavioural half of the wiring gate: a French row cannot answer a
    // Spanish request, whatever else is in the candidate list.
    const resolved = resolveLocalizedField({
      field: 'category.name',
      requestedLocale: 'es-mx',
      candidates: [candidate('fr', 'Chaussures'), candidate('de', 'Schuhe')],
      baseValue: null,
    });
    expect(resolved).toEqual({
      outcome: 'unavailable',
      requestedLocale: 'es-mx',
      reason: 'no_text_in_locale',
    });
  });

  it('has no value to render when nothing answered', () => {
    const resolved = resolveLocalizedField({
      field: 'category.description',
      requestedLocale: 'es',
      candidates: [],
      baseValue: null,
    });
    expect(resolved.outcome).toBe('unavailable');
    expect('value' in resolved).toBe(false);
  });

  it('reports the base step rather than the language step when the two coincide', () => {
    const resolved = resolveLocalizedField({
      field: 'category.name',
      requestedLocale: 'en-us',
      candidates: [],
      baseValue: 'Shoes',
    });
    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome !== 'resolved') return;
    expect(resolved.step).toBe('base');
  });
});

describe('resolving a slug', () => {
  it('answers the current localized slug, and never a retired one', () => {
    const resolved = resolveLocalizedSlug({
      requestedLocale: 'es',
      candidates: [
        { locale: 'es', slug: 'calzado', provenance: 'mercaria', superseded: 'yes' },
        { locale: 'es', slug: 'zapatos', provenance: 'mercaria', superseded: 'no' },
      ],
      baseSlug: 'shoes',
    });
    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome !== 'resolved') return;
    expect(resolved.slug).toBe('zapatos');
  });

  it('falls back to the base slug rather than serving a retired one', () => {
    const resolved = resolveLocalizedSlug({
      requestedLocale: 'es',
      candidates: [{ locale: 'es', slug: 'calzado', provenance: 'mercaria', superseded: 'yes' }],
      baseSlug: 'shoes',
    });
    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome !== 'resolved') return;
    expect(resolved.slug).toBe('shoes');
    expect(resolved.step).toBe('base');
  });
});

describe('the resolver takes its policy from the field, not from a literal', () => {
  const SOURCE = readFileSync(join(BACKEND_SRC, 'services', 'catalog-localization', 'resolve.ts'), 'utf8');

  /**
   * Comment-stripped, because this module documents the policies it refuses to
   * hardcode in the same vocabulary it would hardcode them in.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
  }

  /**
   * Every `localeFallbackChain(a, b)` CALL, with `b` captured.
   *
   * A balanced-paren scan rather than a regex, because the argument this gate
   * exists to read is itself a call — `fallbackPolicyForFieldClass('…')` — and a
   * regex that stops at the first `)` captures half of it. The DECLARATION is
   * skipped by looking backwards for `function`, so the gate measures call sites
   * and not the signature.
   */
  function policyArguments(source: string, token: string): string[] {
    const text = stripComments(source);
    const policies: string[] = [];
    for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
      if (/function\s*$/u.test(text.slice(Math.max(0, at - 20), at))) continue;
      let depth = 0;
      let end = -1;
      for (let cursor = at + token.length - 1; cursor < text.length; cursor += 1) {
        if (text[cursor] === '(') depth += 1;
        if (text[cursor] === ')') {
          depth -= 1;
          if (depth === 0) {
            end = cursor;
            break;
          }
        }
      }
      if (end === -1) continue;
      const args = text.slice(at + token.length, end);
      let nesting = 0;
      let split = -1;
      for (let cursor = args.length - 1; cursor >= 0; cursor -= 1) {
        if (args[cursor] === ')') nesting += 1;
        if (args[cursor] === '(') nesting -= 1;
        if (args[cursor] === ',' && nesting === 0) {
          split = cursor;
          break;
        }
      }
      policies.push(args.slice(split + 1).trim());
    }
    return policies;
  }

  /**
   * BOTH entry points, because there are now two.
   *
   * `localeFallbackPlan` is what the resolvers call and `localeFallbackChain` is
   * the query-narrowing projection over it. Scanning only the older token would
   * have left every resolver call site unguarded the moment they moved — and it
   * would have reported a clean ZERO rather than failing, which is why the floor
   * below counts the union.
   */
  const ENTRY_POINTS = ['localeFallbackPlan(', 'localeFallbackChain('] as const;

  function everyPolicyArgument(source: string): string[] {
    return ENTRY_POINTS.flatMap((token) => policyArguments(source, token));
  }

  it('passes a derived policy at every call site', () => {
    const policies = everyPolicyArgument(SOURCE);
    // The floor. A pattern that matched nothing would report a clean zero and
    // guard the call sites that exist against nothing at all.
    expect(policies.length).toBeGreaterThanOrEqual(3);
    for (const policy of policies) {
      expect(
        // `policy` is the forwarded PARAMETER of `localeFallbackChain`, whose own
        // signature already demands a `LocalizationFallbackPolicy`. It is not a
        // literal, which is the thing this gate exists to refuse — see the
        // mutation self-test below, which is what keeps that distinction real.
        policy === 'descriptor.fallback' ||
          policy === 'policy' ||
          policy.startsWith('fallbackPolicyForFieldClass('),
        policy,
      ).toBe(true);
      // Stated separately and positively: no call site anywhere names a policy
      // as a string literal, whatever else it does.
      expect(policy.startsWith("'"), policy).toBe(false);
    }
  });

  it('resolves from the PLAN and never from the flat chain', () => {
    // Condition 1 of `exact_locale_then_base`, as a census rather than a
    // promise: nothing in this module answers a request out of the flat locale
    // list. A flat list cannot say whether its last entry means a ROW or the
    // entity's own COLUMN, so walking one is precisely how the new policy would
    // become `language_then_base` with every behavioural test still green.
    expect(policyArguments(SOURCE, 'localeFallbackChain(')).toEqual([]);
    // The rest of the module's calls go to the plan, and there is more than one.
    expect(policyArguments(SOURCE, 'localeFallbackPlan(').length).toBeGreaterThanOrEqual(3);
  });

  it('can SEE a call to the flat chain — the positive control', () => {
    // Without this, the empty expectation above is satisfied just as well by a
    // broken pattern, a renamed function or a NUL byte in the file.
    expect(
      policyArguments(
        'const c = localeFallbackChain(requested, descriptor.fallback);',
        'localeFallbackChain(',
      ),
    ).toEqual(['descriptor.fallback']);
    // …and it skips the DECLARATION rather than counting it as a call, which is
    // the other way `[]` could be reached for the wrong reason.
    expect(
      policyArguments(
        'export function localeFallbackChain(a: string, policy: P) { return a; }',
        'localeFallbackChain(',
      ),
    ).toEqual([]);
  });

  it('detects a hardcoded policy — the mutation self-test', () => {
    for (const token of ENTRY_POINTS) {
      const mutated = `const chain = ${token}requested, 'language_then_base');`;
      const policies = policyArguments(mutated, token);
      expect(policies).toEqual(["'language_then_base'"]);
      expect(policies[0] === 'descriptor.fallback').toBe(false);
      expect(policies[0] === 'policy').toBe(false);
      expect(policies[0].startsWith('fallbackPolicyForFieldClass(')).toBe(false);
      expect(policies[0].startsWith("'")).toBe(true);
    }
  });
});

describe('the hand-written trigger SQL', () => {
  /**
   * The file holding the trigger block — the pending SQL before the migration
   * slot is granted, the generated migration afterwards.
   *
   * Located by CONTENT rather than by path, and asserted to be found EXACTLY
   * once: two copies of one trigger body is the second representation this whole
   * domain is written against, and a path-based lookup would silently measure
   * the stale one after the migration lands.
   */
  const GUARD_FUNCTION = 'mercaria_localization_machine_write_guard';

  /**
   * The DEFINITION of the guard, not a mention of it.
   *
   * The distinction is load-bearing and was found by this gate firing. A
   * migration that attaches the existing guard to a NEW family table names the
   * function on its `EXECUTE FUNCTION` line and carries no copy of the body —
   * that is the mechanism being reused, which is the outcome this file wants.
   * A migration that re-declares the body is the second representation it
   * forbids, and the hazard is worse than duplication: migrations apply in
   * journal order, so on a from-zero apply the LATER copy wins and a correction
   * made to the earlier one is silently reverted.
   *
   * Matching on the bare name could not tell those apart, so it reported the
   * safe case and the dangerous one identically.
   */
  const GUARD_DEFINITION = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${GUARD_FUNCTION}\s*\(`,
  );

  function allSqlFiles(): { path: string; text: string }[] {
    const files = [join(BACKEND_SRC, 'db', 'schema', 'catalogLocalization.pending.sql')];
    for (const entry of readdirSync(DRIZZLE_DIR)) {
      if (entry.endsWith('.sql')) files.push(join(DRIZZLE_DIR, entry));
    }
    return files
      .filter((path) => existsSync(path))
      .map((path) => ({ path, text: readFileSync(path, 'utf8') }));
  }

  function candidateSqlFiles(): { path: string; text: string }[] {
    return allSqlFiles().filter((file) => GUARD_DEFINITION.test(file.text));
  }

  function renderList(values: readonly string[]): string {
    return `(${values.map((value) => `'${value}'`).join(', ')})`;
  }

  it('lives in exactly one file', () => {
    const found = candidateSqlFiles();
    expect(found.map((file) => file.path)).toHaveLength(1);
  });

  it('tells a DEFINITION from a mention — the mutation self-test', () => {
    // The safe shape: a later migration attaching the existing guard to a new
    // family table. It names the function and carries no body.
    const attachesOnly = [
      'CREATE TRIGGER mercaria_product_type_field_localizations_machine_guard',
      '  BEFORE UPDATE ON "product_type_field_localizations"',
      `  FOR EACH ROW EXECUTE FUNCTION ${GUARD_FUNCTION}();`,
    ].join('\n');
    expect(GUARD_DEFINITION.test(attachesOnly)).toBe(false);

    // The dangerous shape this gate exists for: a second copy of the body. On a
    // from-zero apply it runs last and wins, silently reverting any correction
    // made to the original.
    const redeclares = `CREATE OR REPLACE FUNCTION ${GUARD_FUNCTION}()\nRETURNS trigger AS $$`;
    expect(GUARD_DEFINITION.test(redeclares)).toBe(true);
    // …and a plain CREATE, which is the same hazard without the OR REPLACE.
    expect(GUARD_DEFINITION.test(`CREATE FUNCTION ${GUARD_FUNCTION}()`)).toBe(true);
  });

  it('attaches an update-time guard to every non-exempt family text table', () => {
    // DERIVED from the shared-types tuple, never hand-listed: a family member
    // added later is in this population automatically, which is the direction
    // that matters. The exempt member carries no `status` and no `provenance`,
    // so the guard's own body could not read it.
    const exempt = new Set<string>(
      LOCALIZATION_FAMILY_COLUMN_EXEMPTIONS.map((entry) => entry.table),
    );
    const guarded = CATALOG_LOCALIZATION_TEXT_TABLES.filter((name) => !exempt.has(name));

    // The floor. A population that shrank to nothing would pass every loop
    // below while measuring no table at all.
    expect(guarded.length).toBeGreaterThanOrEqual(4);

    const chain = allSqlFiles();
    // The table name is matched BOTH quoted and bare, because the family does
    // not spell it consistently — `navigation_node_localizations`' trigger is
    // written unquoted, and a quoted-only matcher reports it as UNGUARDED. That
    // false absence was produced by an earlier draft of this very check.
    for (const name of guarded) {
      const attached = chain.filter((file) =>
        new RegExp(String.raw`BEFORE\s+UPDATE\s+ON\s+"?${name}"?`).test(file.text),
      );
      expect(attached.length, `${name} has no BEFORE UPDATE guard in the migration chain`)
        .toBeGreaterThanOrEqual(1);
    }

    // THE CONTROL, and its shape is the load-bearing part.
    //
    // The obvious control is to run the matcher against a table name that does
    // not exist and watch it report nothing. That measures NOTHING: an absent
    // name is absent from the chain whether the matcher works or is broken, so
    // it passes identically either way. What is needed is a subject that REALLY
    // EXISTS and really has no guard, so a matcher that has silently started
    // matching everything is caught.
    //
    // It USED to be `attribute_labels`, the one exemption, and that comment said
    // this line would fail the day somebody gave it the family columns and a
    // guard — "which is the conversation that change should start". It did, and
    // this is the other side of it: the control had to be replaced rather than
    // deleted, because a census whose negative subject was removed is a census
    // that can no longer fail.
    //
    // `attribute_definition_categories` is the replacement, and the reason it can
    // be a PERMANENT control is the part that matters.
    //
    // The first candidate was `category_localized_slugs`, and THIS CENSUS
    // REJECTED IT: it carries `mercaria_category_localized_slug_frozen`, a real
    // BEFORE UPDATE trigger, so it would have reported the matcher as broken
    // when the matcher was fine. That is the control doing its job on the person
    // replacing it, and it is why the subject below was measured against
    // `pg_trigger` on an applied database rather than reasoned about.
    //
    // The junction table is unguarded for a STRUCTURAL reason: it is two foreign
    // keys, a boolean and a timestamp, with **no human-readable text column at
    // all**. There is nothing about it to translate, so it can never carry a
    // `status`, and `mercaria_localization_machine_write_guard` reads
    // `OLD.status`. Nothing a future change could do would give it a guard.
    //
    // That is the property to preserve if this ever moves again: the control has
    // to be unguarded because it CANNOT be guarded, not merely because nobody
    // has guarded it yet — otherwise the census loses its negative subject the
    // next time somebody closes a gap, which is exactly what happened here.
    const controlName = 'attribute_definition_categories';
    expect(
      CATALOG_LOCALIZATION_TEXT_TABLES as readonly string[],
      'the control must sit OUTSIDE the guarded population, or it proves nothing',
    ).not.toContain(controlName);
    const controlTable = tables.find(
      (candidateTable) => getTableName(candidateTable) === controlName,
    );
    expect(controlTable, `${controlName} is not a real table; the control is a name only`).toBeDefined();
    const controlColumns = new Set(
      Object.values(getTableColumns(controlTable)).map(sqlColumnName),
    );
    expect(
      controlColumns.has('status'),
      `${controlName} has grown a status column, so it could now carry the guard — ` +
        'it has stopped being a structural control and this census needs a new one',
    ).toBe(false);
    // The stronger claim, asserted rather than described: no localizable text.
    // A table with a text column could one day be translated and would then be a
    // legitimate gap rather than a control.
    for (const localizable of ['label', 'name', 'description', 'help_text', 'slug']) {
      expect(
        controlColumns.has(localizable),
        `${controlName} carries "${localizable}" — it holds translatable text now, ` +
          'so being unguarded is a question rather than a structural fact',
      ).toBe(false);
    }
    const attachedToControl = chain.filter((file) =>
      new RegExp(String.raw`BEFORE\s+UPDATE\s+ON\s+"?${controlName}"?`).test(file.text),
    );
    expect(
      attachedToControl,
      `${controlName} is expected to have NO update guard — if the matcher reports one, ` +
        'it has started matching everything and every assertion above is vacuous',
    ).toHaveLength(0);

    process.stdout.write(
      `\n  [family guard census] ${guarded.length} non-exempt text tables guarded, ` +
        `${exempt.size} exempt (control: ${controlName} has none, structurally), ` +
        `${chain.length} migration files scanned\n`,
    );
  });

  it('attaches EVERY trigger function it defines to a trigger', () => {
    // A trigger function with no `CREATE TRIGGER` naming it is INERT: created,
    // readable, `db:generate` happy, migration applies cleanly, never runs.
    // That has happened in this chain — a sibling lane shipped five revision
    // functions where six were owed — and it is invisible to every check that
    // READS the SQL rather than counting it.
    //
    // ## The population is `RETURNS trigger`, and that took two corrections
    //
    // The first draft required every `mercaria_*` function to be attached and
    // reported five offenders, all false:
    //
    //   * `mercaria_immutable_array_to_string` is a helper called from CHECK
    //     constraints and a generated column;
    //   * `mercaria_navigation_tree_is_editable` is a predicate called from
    //     another trigger's BODY;
    //   * the three affiliate functions ARE attached — with `FOR EACH STATEMENT`
    //     on the same line, which the first draft's `FOR EACH ROW`-only pattern
    //     did not match.
    //
    // So the population is narrowed to functions that declare `RETURNS trigger`
    // (a helper cannot be attached and demanding it is a category error), and
    // the attachment pattern matches `EXECUTE FUNCTION` or the legacy
    // `EXECUTE PROCEDURE` anywhere on a line rather than anchored behind one
    // spelling of the row/statement clause.
    //
    // A gate that fires on correct code is worse than none, because the fix
    // somebody reaches for is to delete it.
    const chain = allSqlFiles();
    const triggerFunctions = new Map<string, string>();
    const attached = new Set<string>();

    for (const file of chain) {
      const lines = file.text.split('\n');
      for (const [index, line] of lines.entries()) {
        const definition = /^CREATE OR REPLACE FUNCTION (mercaria_[a-z0-9_]+)\s*\(/u.exec(line);
        if (definition?.[1] !== undefined) {
          // `RETURNS trigger` sits on the same line or just below it in every
          // spelling this chain uses; three lines is generous and bounded.
          const head = lines.slice(index, index + 4).join(' ');
          if (/RETURNS\s+trigger/iu.test(head)) triggerFunctions.set(definition[1], file.path);
        }
        const attachment = /EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(mercaria_[a-z0-9_]+)\s*\(/u.exec(
          line,
        );
        if (attachment?.[1] !== undefined) attached.add(attachment[1]);
      }
    }

    // Two floors, because a walk that found no functions and one that found no
    // attachments fail identically against a comparison of two empty sets.
    expect(
      triggerFunctions.size,
      `the scan found ${String(triggerFunctions.size)} RETURNS trigger functions`,
    ).toBeGreaterThan(20);
    expect(
      attached.size,
      `the scan found ${String(attached.size)} EXECUTE FUNCTION/PROCEDURE references`,
    ).toBeGreaterThan(20);

    const inert = [...triggerFunctions.keys()].filter((name) => !attached.has(name)).sort();
    expect(
      inert,
      'these trigger functions are DEFINED and never attached, so they are created and never ' +
        'run. A migration carrying one applies cleanly and enforces nothing.',
    ).toEqual([]);
  });

  it('is mutation-tested: an unattached trigger function is reported', () => {
    // Without this the case above passes on a chain where the ATTACHMENT
    // pattern silently matched everything — which is how the first draft's
    // `FOR EACH STATEMENT` blind spot would have read once somebody "fixed" it
    // by loosening the pattern instead of narrowing the population.
    const planted = [
      'CREATE OR REPLACE FUNCTION mercaria_planted_inert()',
      'RETURNS trigger AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql;',
    ].join('\n');
    const defined = /^CREATE OR REPLACE FUNCTION (mercaria_[a-z0-9_]+)\s*\(/mu.exec(planted);
    expect(defined?.[1]).toBe('mercaria_planted_inert');
    expect(/RETURNS\s+trigger/iu.test(planted)).toBe(true);
    expect(
      /EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+mercaria_planted_inert\s*\(/u.test(planted),
      'the planted function has no attachment, so the detector must not find one',
    ).toBe(false);
  });

  it('names the same settled statuses the tuple does', () => {
    const [file] = candidateSqlFiles();
    expect(file).toBeDefined();
    expect(file.text).toContain(
      `OLD.status IN ${renderList(HUMAN_SETTLED_LOCALIZATION_STATUSES)}`,
    );
  });

  it('makes stale from the same statuses the tuple does, on every source table', () => {
    const [file] = candidateSqlFiles();
    expect(file).toBeDefined();
    const rendered = `status IN ${renderList(STALE_ON_SOURCE_CHANGE_STATUSES)}`;
    const occurrences = file.text.split(rendered).length - 1;
    // One per source table — `categories` and `attribute_enum_values`. A count
    // rather than a containment check, because one of the two silently missing
    // is exactly the shape of a stale trigger that fires for categories and not
    // for controlled values.
    expect(occurrences).toBe(2);
  });

  it('excludes the base locale using the constant, not a repeated literal', () => {
    const [file] = candidateSqlFiles();
    expect(file).toBeDefined();
    const occurrences = file.text.split(`<> '${MERCARIA_BASE_LOCALE}'`).length - 1;
    // Four tables carry the exclusion: the three text tables and the slug table.
    expect(occurrences).toBe(4);
  });

  it('renders every closed value set the family CHECKs read', () => {
    const [file] = candidateSqlFiles();
    expect(file).toBeDefined();
    expect(file.text).toContain(`in ${renderList(LOCALIZATION_STATUSES)}`);
    expect(file.text).toContain(`in ${renderList(LOCALIZATION_PROVENANCES)}`);
    expect(file.text).toContain(`in ${renderList(SUPPORTED_LOCALES)}`);
  });
});
