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
 * 2. **The fallback wiring.** Every registered field is `catalog_presentation`
 *    today, so a resolver that ignored the descriptor and hardcoded
 *    `'language_then_base'` would pass every behavioural test in this file. The
 *    anchored source census over `resolve.ts` is what closes that: it asserts
 *    every `localeFallbackChain(...)` call site takes its policy from the field
 *    descriptor or from `fallbackPolicyForFieldClass`, and it carries a mutation
 *    self-test so a broken pattern cannot report a clean zero.
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
  CATALOG_LOCALIZATION_TEXT_TABLES,
  CATALOG_LOCALIZED_FIELDS,
  CROSS_MARKET_FALLBACK_FIELD_CLASSES,
  HUMAN_SETTLED_LOCALIZATION_STATUSES,
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
import {
  attributeValueLocalizations,
  categoryLocalizations,
  categoryLocalizedSlugs,
  productTypeFieldLocalizations,
  productTypeLocalizations,
} from '../schema/catalogLocalization.js';
import {
  foldLocale,
  isSupportedLocale,
  localeFallbackChain,
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
    expect(CROSS_MARKET_FALLBACK_FIELD_CLASSES).not.toContain('seller_authored');
  });

  it('derives one policy per class, and both policies are reachable', () => {
    expect(fallbackPolicyForFieldClass('catalog_presentation')).toBe('language_then_base');
    expect(fallbackPolicyForFieldClass('legal_text')).toBe('exact_locale_only');
    expect(fallbackPolicyForFieldClass('seller_authored')).toBe('exact_locale_only');
    const derived = new Set(LOCALIZED_FIELD_CLASSES.map(fallbackPolicyForFieldClass));
    expect(derived.size).toBe(2);
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
    } as const;
    for (const key of LOCALIZED_FIELD_KEYS) {
      const descriptor = CATALOG_LOCALIZED_FIELDS[key];
      const columns = getTableColumns(tableForEntity[descriptor.entity]);
      expect(Object.keys(columns)).toContain(descriptor.column);
    }
  });

  it('registers no field whose entity has no table here', () => {
    // `attribute_definition` is deliberately NOT an entity kind: `attribute_labels`
    // carries no status and no provenance, so a candidate built from one of its
    // rows would have to invent both. This is the line that fails when somebody
    // adds the kind without adding the columns.
    expect([...LOCALIZED_ENTITY_KINDS]).toEqual([
      'category',
      'product_type',
      // `product_type_field` is a SEPARATE kind from `product_type` on purpose:
      // one localizes the form, the other one question on it, and they resolve
      // against different tables. Folding them would make a field's help text
      // and the whole schema's help text the same string.
      'product_type_field',
      'attribute_value',
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

  it('keeps the exemption list at exactly one, and the exemption real', () => {
    expect(LOCALIZATION_FAMILY_COLUMN_EXEMPTIONS).toHaveLength(1);
    for (const entry of LOCALIZATION_FAMILY_COLUMN_EXEMPTIONS) {
      expect(entry.reason.length).toBeGreaterThan(40);
      const table = tables.find((candidateTable) => getTableName(candidateTable) === entry.table);
      expect(table).toBeDefined();
      const columnNames = new Set(Object.values(getTableColumns(table)).map(sqlColumnName));
      const missing = LOCALIZATION_FAMILY_COLUMNS.filter((name) => !columnNames.has(name));
      // An exemption for a table that already complies is an exemption nobody
      // removed, and it is how a census stops being one. When #94's owner adds
      // the family columns to `attribute_labels`, THIS line goes red and the
      // entry is deleted rather than left behind.
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
    expect(resolved.status).toBe('approved');
    expect(resolved.provenance).toBe('mercaria');
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
  function policyArguments(source: string): string[] {
    const text = stripComments(source);
    const token = 'localeFallbackChain(';
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

  it('passes a derived policy at every call site', () => {
    const policies = policyArguments(SOURCE);
    // The floor. A pattern that matched nothing would report a clean zero and
    // guard the two call sites that exist against nothing at all.
    expect(policies.length).toBeGreaterThanOrEqual(2);
    for (const policy of policies) {
      expect(policy === 'descriptor.fallback' || policy.startsWith('fallbackPolicyForFieldClass(')).toBe(
        true,
      );
    }
  });

  it('detects a hardcoded policy — the mutation self-test', () => {
    const mutated = "const chain = localeFallbackChain(requested, 'language_then_base');";
    const policies = policyArguments(mutated);
    expect(policies).toEqual(["'language_then_base'"]);
    expect(policies[0] === 'descriptor.fallback').toBe(false);
    expect(policies[0].startsWith('fallbackPolicyForFieldClass(')).toBe(false);
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
    const exempt = new Set(LOCALIZATION_FAMILY_COLUMN_EXEMPTIONS.map((entry) => entry.table));
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

    process.stdout.write(
      `\n  [family guard census] ${guarded.length} non-exempt text tables, ` +
        `${exempt.size} exempt, ${chain.length} migration files scanned\n`,
    );
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
