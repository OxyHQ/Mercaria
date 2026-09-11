/**
 * The 3D profile package against a REAL PostgreSQL server (#1015 Workstream 3).
 *
 * ## What it drives
 *
 * The apply, end to end, through #367's own machinery; the composed
 * `AuthoringSchema` a dashboard would actually render, which is what #1015
 * acceptance criterion 18 means by *"authored, not hard-coded"*; the census; a
 * second apply as a genuine no-op; the hand-edit reported rather than corrected;
 * and the reference licences, including what a second run does to them.
 *
 * ## Why the schema composition is the load-bearing case
 *
 * Every other assertion here could be satisfied by rows that exist and serve
 * nobody. `composeAuthoringSchema` is the path the dashboard's wizard takes, and
 * a profile whose fields it cannot compose is a profile no seller can fill in —
 * which is exactly the failure a seed that wrote plausible rows would produce
 * silently. It is also the only case that proves the visibility rule SURVIVED the
 * namespacing: the rule it serves reads the prefixed key, and a rule reading an
 * unprefixed one would evaluate `unknown` forever and hide nine fields on every
 * form with nothing reporting it.
 *
 * ## Scoping, and what this file leaves behind
 *
 * A per-run namespace, because attribute `key`, category `key`/`slug` and
 * product-type `(key, version)` are unique over the whole database and vitest
 * runs files in parallel against one. The attribute and product-type definitions
 * this run publishes CANNOT be deleted
 * (`mercaria_attribute_definition_immutable`,
 * `product_type_definitions_immutable_once_published`), so the teardown retires
 * the categories to `deprecated` — which `isCategoryLifecycleActive` reads as
 * inactive, so `findActiveCategories` never serves them again — and leaves the
 * definitions scoped to those retired categories. That is
 * `scripts/seed-verticals/__tests__/vertical-fixture.ts`' arrangement and its
 * reasoning applies unchanged.
 *
 * **The licences are the exception and are NOT namespaced.** There is exactly one
 * `mercaria-personal` in the database, by a partial unique index over a NULL
 * `store_id`, and that is the point of a reference licence. So this file SHARES
 * those three rows with every other file and with every previous run, every
 * licence assertion is an equality against the published tuple rather than a
 * count of what this run wrote, and the teardown removes none of them — a
 * published licence version refuses DELETE outright.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

import {
  MERCARIA_REFERENCE_LICENCES,
  THREE_D_CLAIM_ATTRIBUTE_KEYS,
} from '@mercaria/shared-types';

import { connectPostgres, type Database } from '../../../../db/postgres.js';
import { findCategoryByKey, setCategoryLifecycle } from '../../../../db/taxonomy/taxonomyRepository.js';
import { composeAuthoringSchema } from '../../../catalog-authoring/schema.service.js';
import { findAssetLicenceBySlug } from '../../../../db/digital/licenceRepository.js';
import {
  applyThreeDProfilePackage,
  censusThreeDProfiles,
  formatProfileCensus,
  namespaceFor,
  nsCategoryKey,
  nsKey,
  type ThreeDNamespace,
} from '../index.js';
import { THREE_D_PROFILE_PACKAGE as PKG } from '../package.js';

const TOKEN = `d3d${randomBytes(3).toString('hex')}`;
const ACTOR = `${TOKEN}-operator`;
const PERMISSIONS = {
  canEditDraft: true,
  canPublish: true,
  canProposeValues: false,
  canSelectCanonicalEntity: true,
} as const;

/**
 * Every message in an error's cause chain, joined.
 *
 * Drizzle wraps a driver error in `Failed query: <sql>` and hangs the real one
 * off `cause`, so `rejects.toThrow(/published/)` matches the SQL text rather than
 * the refusal — and would pass for a constraint nobody named.
 */
function causeChain(raised: unknown): string {
  const messages: string[] = [];
  for (let error: unknown = raised; error !== undefined && error !== null; ) {
    if (error instanceof Error) {
      messages.push(error.message);
      error = error.cause;
      continue;
    }
    messages.push(String(error));
    break;
  }
  return messages.join(' | ');
}

const db: Database = await connectPostgres();
let ns: ThreeDNamespace;
let printModelCategoryId: string;

beforeAll(async () => {
  ns = namespaceFor(TOKEN);
  const { report } = await applyThreeDProfilePackage(
    PKG,
    { apply: true, namespace: TOKEN, actorOxyUserId: ACTOR },
    db,
  );
  if (report.divergent > 0) {
    // The refusal is the point: a file whose fixture half-applied would run every
    // case against a catalogue missing the rows those cases are about, and the
    // failures would name whichever assertion touched a missing row first.
    throw new Error(
      `the 3D apply produced divergent steps:\n${report.steps
        .filter((step) => step.outcome === 'divergent')
        .map((step) => `${step.entity} ${step.identity}: ${step.detail ?? 'divergent'}`)
        .join('\n')}`,
    );
  }
  const verdict = await censusThreeDProfiles(db, PKG, ns);
  if (verdict.outcome !== 'matched') {
    throw new Error(`the 3D apply did not match its own census:\n${formatProfileCensus(verdict)}`);
  }
  const category = await findCategoryByKey(nsCategoryKey(ns, 'three_d.print_models'), db);
  if (!category) throw new Error('the print-model category did not resolve');
  printModelCategoryId = category.id;
}, 120_000);

afterAll(async () => {
  // Children-first, and only what the server permits removing. The definitions
  // stay ACTIVE and SCOPED to these categories deliberately:
  // `listActiveDefinitionsForCategory` includes UNSCOPED definitions, so deleting
  // the scope rows — the obvious tidy-up — would make seventeen attributes appear
  // in every sibling file's category.
  const categoryIds = await db.execute<{ id: string }>(
    sql`select id from categories where key like ${`${ns.kebab}.%`} order by key desc`,
  );
  for (const row of [...categoryIds]) {
    await setCategoryLifecycle(row.id, 'deprecated', db);
  }
});

/* -------------------------------------------------------------------------- */

describe('the apply lands the whole package', () => {
  it('publishes seven product types, seventeen active attributes and nine categories', async () => {
    const verdict = await censusThreeDProfiles(db, PKG, ns);
    expect(verdict.outcome, formatProfileCensus(verdict)).toBe('matched');
    // The census is an equality against the package's declared numbers; this
    // restates the two that matter most in the package's own terms, so a future
    // reader does not have to resolve `expect` to learn what was proven.
    if (verdict.outcome !== 'matched') return;
    const byEntity = new Map(verdict.lines.map((line) => [line.entity, line.found]));
    expect(byEntity.get('profiles')).toBe(7);
    expect(byEntity.get('attributes')).toBe(17);
    expect(byEntity.get('categories')).toBe(9);
    expect(byEntity.get('profileFields')).toBe(96);
  });

  it('files every profile under a SELECTABLE leaf of a structural parent', async () => {
    // ADR 0007 D2: `mercaria_category_assignment_selectable` refuses a product
    // filed under a structural node, so a package whose leaves were structural
    // would publish cleanly and then be unusable.
    const rows = await db.execute<{ key: string; selectable: boolean; depth: number }>(sql`
      select key, selectable, coalesce(array_length(ancestor_ids, 1), 0) as depth
      from categories where key like ${`${ns.kebab}.%`} order by key
    `);
    const all = [...rows];
    expect(all.length).toBe(9);
    const leaves = all.filter((row) => row.selectable);
    expect(leaves.length).toBe(7);
    for (const leaf of leaves) expect(leaf.depth, leaf.key).toBe(2);
    for (const structural of all.filter((row) => !row.selectable)) {
      expect(structural.depth, structural.key).toBeLessThan(2);
    }
  });

  it('marks exactly one attribute variant-defining in the database', async () => {
    const rows = await db.execute<{ key: string }>(sql`
      select key from attribute_definitions
      where key like ${`${ns.snake}_%`} and lifecycle_state = 'active' and variant_defining
    `);
    expect([...rows].map((row) => row.key)).toEqual([nsKey(ns, 'deliverable_configuration')]);
  });
});

/* -------------------------------------------------------------------------- */

describe('a dashboard can COMPOSE the print-model form from the database', () => {
  it('serves fourteen merchant fields, with the printable block guarded', async () => {
    const composition = await composeAuthoringSchema(db, {
      productTypeKey: nsKey(ns, 'three_d_print_model'),
      categoryId: printModelCategoryId,
      flow: 'merchant',
      requestedLocale: 'en',
      market: 'ES',
      permissions: PERMISSIONS,
    });
    expect(composition.outcome, JSON.stringify(composition)).toBe('composed');
    if (composition.outcome !== 'composed') return;
    const { schema } = composition;
    // FOURTEEN, not the profile's seventeen: a composition is PER FLOW, and the
    // other three are the P2P form. Asserting the package's total here would be
    // asserting something no form ever renders.
    expect(schema.fields.length).toBe(14);

    // The guard SURVIVED the namespacing. A rule reading the unprefixed key would
    // evaluate `unknown` forever and hide nine fields on every form — and
    // publication would not have caught it, because `findDanglingRuleField` reads
    // the same stored spelling.
    const guarded = schema.fields.filter((field) => field.visibilityRule !== null);
    expect(guarded.length).toBe(9);
    for (const field of guarded) {
      const rule = field.visibilityRule;
      expect(rule?.node).toBe('membership');
      expect(rule !== null && rule.node === 'membership' ? rule.field : '').toBe(
        nsKey(ns, 'intended_use'),
      );
    }
    // And the field the guard reads is in the SAME composition, which is what
    // makes the rule evaluable at all.
    expect(schema.fields.map((field) => field.key)).toContain(nsKey(ns, 'intended_use'));

    // The controlled values arrive WITH the field rather than being hard-coded in
    // a client — the whole of criterion 18. Four deliverable configurations, six
    // intended uses.
    const deliverable = schema.fields.find(
      (field) => field.key === nsKey(ns, 'deliverable_configuration'),
    );
    expect(deliverable?.controlledValues.length).toBe(4);
    expect(deliverable?.variantCapable).toBe(true);
    const intendedUse = schema.fields.find((field) => field.key === nsKey(ns, 'intended_use'));
    expect(intendedUse?.controlledValues.length).toBe(6);
    expect(intendedUse?.variantCapable).toBe(false);
  });

  it('serves the P2P seller a strictly shorter form from the same version', async () => {
    const composition = await composeAuthoringSchema(db, {
      productTypeKey: nsKey(ns, 'three_d_print_model'),
      categoryId: printModelCategoryId,
      flow: 'p2p',
      requestedLocale: 'en',
      market: 'ES',
      permissions: PERMISSIONS,
    });
    expect(composition.outcome).toBe('composed');
    if (composition.outcome !== 'composed') return;
    // Three questions, not seventeen. A P2P seller uploading a model they made at
    // the weekend is asked what it is, what it is for, and whether it needs
    // supports — and the last one only if they said it was for printing.
    expect(composition.schema.fields.length).toBe(3);
    expect(composition.schema.fields.filter((field) => field.visibilityRule !== null).length).toBe(1);
  });

  it('serves Spanish for a Spanish request, from the localization rows the seed wrote', async () => {
    const composition = await composeAuthoringSchema(db, {
      productTypeKey: nsKey(ns, 'three_d_print_model'),
      categoryId: printModelCategoryId,
      flow: 'merchant',
      requestedLocale: 'es',
      market: 'ES',
      permissions: PERMISSIONS,
    });
    expect(composition.outcome).toBe('composed');
    if (composition.outcome !== 'composed') return;
    // The localized text is on `schema.text` and NOT on `schema.productType` —
    // the ref carries identity (id, key, version, lifecycle) and no copy, which
    // is ADR 0007 D1 holding in the contract a client actually reads.
    // `AuthoringLocalizedText` carries no `outcome`: an UNRESOLVED field is
    // ABSENT from `schema.text` entirely (`toText` returns undefined), so the
    // presence of the key is the resolution and `effectiveLocale` is what makes
    // the fallback debuggable rather than invisible.
    const name = composition.schema.text.productTypeName;
    expect(name).toBeDefined();
    expect(name?.value).toBe('Modelo para impresión 3D');
    expect(name?.effectiveLocale).toBe('es');
    // The DESCRIPTION is not translated by the package, and the composition says
    // so rather than hiding it: it falls back to the base locale and NAMES the
    // step it took, which is what makes a missing translation debuggable instead
    // of looking like English copy somebody chose.
    const description = composition.schema.text.productTypeDescription;
    expect(description?.effectiveLocale).toBe('en');
    expect(description?.step).toBe('base');
  });

  it('refuses a profile under a category it is not scoped to', async () => {
    // The scope is a GRANT and names one leaf: a print-model profile has no
    // business on the material-pack shelf, and `product_type_category_scopes`
    // with no matching row is what refuses it.
    const other = await findCategoryByKey(nsCategoryKey(ns, 'three_d.materials_textures'), db);
    expect(other).not.toBeNull();
    const composition = await composeAuthoringSchema(db, {
      productTypeKey: nsKey(ns, 'three_d_print_model'),
      categoryId: other?.id ?? '',
      flow: 'merchant',
      requestedLocale: 'en',
      market: 'ES',
      permissions: PERMISSIONS,
    });
    expect(composition.outcome).toBe('refused');
    expect(composition.outcome === 'refused' ? composition.refusal : '').toBe(
      'category_not_in_product_type_scope',
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('what stops a compatibility claim becoming a variant axis', () => {
  it('is the FREEZE first, and the CHECK behind it', async () => {
    // Measured and recorded rather than assumed, the smartphone package's finding
    // one domain over: the wall a careless UPDATE meets first is NOT
    // `product_type_fields_variant_axis_check` but
    // `mercaria_product_type_child_frozen`, because these versions are published.
    // A test that claimed to drive the CHECK here would be describing a wall
    // nothing reaches.
    const [field] = [
      ...(await db.execute<{ id: string }>(sql`
        select f.id from product_type_fields f
        join product_type_definitions d on d.id = f.product_type_definition_id
        where d.key = ${nsKey(ns, 'three_d_print_model')}
          and f.attribute_key = ${nsKey(ns, 'engine_compatibility')}
        limit 1
      `)),
    ];
    expect(field?.id).toBeDefined();
    let raised: unknown;
    try {
      await db.execute(
        sql`update product_type_fields set variant_capable = true where id = ${field?.id}`,
      );
    } catch (error) {
      raised = error;
    }
    expect(raised, 'the statement was accepted, and it must be refused').toBeDefined();
    // The CAUSE CHAIN, never `toThrow(/.../)`: drizzle wraps the driver error in
    // `Failed query: <sql>`, which contains the table name and the column name and
    // would match for the wrong reason entirely.
    expect(causeChain(raised)).toContain('authoring contract is frozen');
  });

  it('and the CHECK is really there, naming the variant scope', async () => {
    // Read out of `pg_constraint` rather than asserted by driving it, with a floor
    // on the count so a query that matched nothing cannot report a clean result.
    const rows = await db.execute<{ def: string }>(sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'product_type_fields_variant_axis_check'
    `);
    const definitions = [...rows];
    expect(definitions.length).toBe(1);
    expect(definitions[0]?.def).toContain("'variant'");
    expect(definitions[0]?.def).toContain('variant_capable');
  });
});

/* -------------------------------------------------------------------------- */

describe('a second apply is a genuine no-op', () => {
  it('creates nothing new and leaves the census matching', async () => {
    const { report } = await applyThreeDProfilePackage(
      PKG,
      { apply: true, namespace: TOKEN, actorOxyUserId: ACTOR },
      db,
    );
    expect(report.steps.length).toBeGreaterThan(30);
    expect(
      report.created,
      `a re-apply created: ${report.steps
        .filter((step) => step.outcome === 'create')
        .map((step) => `${step.entity} ${step.identity}`)
        .join(', ')}`,
    ).toBe(0);
    expect(report.divergent).toBe(0);
    const verdict = await censusThreeDProfiles(db, PKG, ns);
    expect(verdict.outcome, formatProfileCensus(verdict)).toBe('matched');
  });

  it('REPORTS a hand-edited row as divergent rather than correcting it', async () => {
    // The other half of the posture: the seed adds what is missing and never
    // overwrites a decision somebody made in the database. For a published
    // attribute or licence version the database would refuse the correction
    // anyway, so the alternative to reporting is a crash.
    const ROLLBACK = '3d-profiles: intentional rollback';
    let divergent: string[] = [];
    let edited = 0;
    try {
      await db.transaction(async (tx) => {
        const updated = await tx.execute<{ id: string }>(sql`
          update categories set name = 'Hand edited'
          where key = ${nsCategoryKey(ns, 'three_d.props')}
          returning id
        `);
        edited = [...updated].length;
        // A DRY run, so the case measures the detector and writes nothing even
        // before the rollback.
        const { report } = await applyThreeDProfilePackage(
          PKG,
          { apply: false, namespace: TOKEN, actorOxyUserId: ACTOR },
          tx as unknown as Database,
        );
        divergent = report.steps
          .filter((step) => step.outcome === 'divergent')
          .map((step) => step.identity);
        throw new Error(ROLLBACK);
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
    }
    // Assert the mutation LANDED before asserting the detector fired.
    expect(edited, 'the category was never edited, so the control measured nothing').toBe(1);
    expect(divergent).toEqual([nsCategoryKey(ns, 'three_d.props')]);
  });

  it('reports every catalogue row as PRESENT in a dry run after an apply', async () => {
    const { report } = await applyThreeDProfilePackage(
      PKG,
      { apply: false, namespace: TOKEN, actorOxyUserId: ACTOR },
      db,
    );
    expect(report.created).toBe(0);
    expect(report.divergent).toBe(0);
    expect(report.present).toBeGreaterThan(30);
  });
});

/* -------------------------------------------------------------------------- */

describe('the reference licences', () => {
  it('exist once, published, with the published terms', async () => {
    for (const reference of MERCARIA_REFERENCE_LICENCES) {
      const licence = await findAssetLicenceBySlug(null, reference.slug, db);
      expect(licence, reference.slug).not.toBeNull();
      expect(licence?.authorship).toBe('mercaria_reference');
      expect(licence?.storeId).toBeNull();
      expect(licence?.name).toBe(reference.name);

      const versions = await db.execute<{
        version: number;
        state: string;
        rights: string[];
        summary: string;
        seat_limit: number | null;
      }>(sql`
        select version, state, rights, summary, seat_limit
        from asset_licence_versions where licence_id = ${licence?.id ?? ''} order by version
      `);
      const all = [...versions];
      // EXACTLY one version, which is the idempotency claim in its sharpest
      // form: a second run that inserted a second version would be visible here
      // and nowhere else.
      expect(all.length, reference.slug).toBe(1);
      expect(all[0]?.version).toBe(1);
      expect(all[0]?.state).toBe('published');
      expect([...(all[0]?.rights ?? [])].sort()).toEqual([...reference.terms.rights].sort());
      expect(all[0]?.summary).toBe(reference.summary);
      expect(all[0]?.seat_limit ?? null).toBe(reference.terms.seatLimit);
    }
  });

  it('is shared, global and NOT namespaced — asserted, because it looks like an omission', async () => {
    // A namespaced reference licence would be a second row claiming to be the
    // platform's standard terms, which the partial unique index over a NULL
    // `store_id` exists to prevent. So there is no `${TOKEN}-mercaria-personal`,
    // and this file's licences are the same three rows every other run sees.
    const rows = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from asset_licences
      where store_id is null and slug like ${`%${TOKEN}%`}
    `);
    expect([...rows][0]?.count).toBe(0);
  });

  it('refuses to DELETE a published version, which is why there is no reset', async () => {
    const licence = await findAssetLicenceBySlug(null, MERCARIA_REFERENCE_LICENCES[0]?.slug ?? '', db);
    expect(licence).not.toBeNull();
    const ROLLBACK = '3d-profiles: licence delete rollback';
    let refusal: string | null = null;
    try {
      await db.transaction(async (tx) => {
        try {
          await tx.execute(
            sql`delete from asset_licence_versions where licence_id = ${licence?.id ?? ''}`,
          );
        } catch (error) {
          refusal = causeChain(error);
        }
        throw new Error(ROLLBACK);
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
    }
    expect(refusal, 'the delete was not refused').not.toBeNull();
    expect(refusal ?? '').toMatch(/never deleted/u);
  });
});

/* -------------------------------------------------------------------------- */

describe('the seeded vocabulary is the published vocabulary', () => {
  it('stores every claim key, prefixed, and nothing else under this namespace', async () => {
    const rows = await db.execute<{ key: string }>(sql`
      select key from attribute_definitions
      where key like ${`${ns.snake}_%`} and lifecycle_state = 'active' order by key
    `);
    expect([...rows].map((row) => row.key).sort()).toEqual(
      [...THREE_D_CLAIM_ATTRIBUTE_KEYS].map((key) => nsKey(ns, key)).sort(),
    );
  });

  it('scopes the whole vocabulary to the 3D subtree and not to the world', async () => {
    // An attribute scope NARROWS: an EMPTY scope means everywhere, so a seed that
    // forgot the scope rows would put `minimum_wall_thickness` on a footwear form
    // — and every existing test would stay green.
    const rows = await db.execute<{ key: string; scopes: number }>(sql`
      select d.key, count(c.id)::int as scopes
      from attribute_definitions d
      left join attribute_definition_categories c on c.attribute_definition_id = d.id
      where d.key like ${`${ns.snake}_%`} and d.lifecycle_state = 'active'
      group by d.key
    `);
    const all = [...rows];
    expect(all.length).toBe(17);
    for (const row of all) expect(row.scopes, row.key).toBeGreaterThan(0);
  });
});
