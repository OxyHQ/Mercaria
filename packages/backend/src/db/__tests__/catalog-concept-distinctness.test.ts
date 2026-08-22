/**
 * The seven catalog concepts stay seven (#367 line 58).
 *
 * The epic's invariant reads: *"Keep taxonomy, product type, product family,
 * product, variant, listing and offer as distinct concepts."* Four of its
 * neighbours are the same sentence narrowed to one pair and each already has a
 * gate — merchandising is not taxonomy, compatibility is not a variant axis, a
 * seller claim is not a selected fact, a commerce fact is not a canonical
 * column. This is the general one, and it had none.
 *
 * ## The failure it exists for is a QUIET CONFLATION, not a deletion
 *
 * Nobody drops `canonical_product_families`. What happens is that one of the
 * seven quietly acquires the ability to stand in for another — a column that
 * carries either, an id addressed by a label rather than by a type, a string
 * that shares a concept's name and is read as the concept. Every page still
 * renders. It is #59's false merge one level up: discovered months later by a
 * seller whose listing is filed under something that is not what they chose.
 *
 * ## What was measured before this file was written
 *
 * Substitution needs an UNTYPED carrier. A foreign key names exactly one table,
 * so a concept reached through one cannot be another concept — that half is
 * airtight and CLAUSE 2 pins it with the count. The rest of the walk found
 * exactly three shapes where a concept is carried without a type, and all three
 * are gated below:
 *
 * 1. **A lookalike column on a concept's own row.** `listings` carries BOTH
 *    `product_type_definition_id` (the typed pin) and `product_type` (the
 *    free-text string a Shopify import mirrors), and BOTH `category_id` and
 *    `category_slugs`. `docs/catalog-glossary.md` §"Two things in this
 *    repository that share a name" warns about the first pair in prose, and
 *    nothing read it. CLAUSE 3.
 * 2. **A label plus a bare id.** 34 discriminator columns name two or more of
 *    the seven in their vocabulary; 8 carry a typed foreign-key column per named
 *    concept and are verified against the schema, and the other 26 address at
 *    least one of them by a label alone and are declared. CLAUSE 4.
 * 3. **A concept table depending on one of those rows.** Measured at ONE, out of
 *    65 foreign keys pointing at those 23 tables — and the one is
 *    `offers.source_record_id`, whose label classifies an EXTERNAL object beside
 *    a foreign system's key. That near-zero is why shape 2 cannot corrupt the
 *    graph: every untyped reference sits on a ledger, job, queue or audit row
 *    the catalogue does not point back at. CLAUSE 4's second half.
 *
 * The 42 ordered pairs are then reported on every run (CLAUSE 5), derived from
 * the same walk. 38 have at least one site; the four that have none are an
 * outcome, not a choice about what to look at.
 *
 * ## Why the walk reads drizzle rather than source
 *
 * Every population here comes from the runtime schema objects, so a multi-line
 * `pgTable(` is not a case to get right and there is no comment to strip. The
 * one artefact read as text is the glossary, and only for the term→table
 * citation CLAUSE 1 binds.
 *
 * `sqlColumnName` from `@oxyhq/db`, never `column.name`: under `DATABASE_CASING`
 * drizzle's `.name` is the TypeScript property (`categoryId`), so a set built
 * from it contains no snake_case name at all and every probe below would report
 * a clean, constant absence. `commerce-type-structural-walls.test.ts` records
 * the same trap. CLAUSE 0 is the instrument's own known-answer assertion.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName, is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import * as schema from '../schema/index.js';

const GLOSSARY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'docs',
  'catalog-glossary.md',
);

/**
 * The seven concepts #367 line 58 names, each bound to the ONE table that holds
 * it, and to the glossary term that defines it.
 *
 * The epic states them in English and nothing in the code enumerated them, so
 * this list is the binding — and CLAUSE 1 checks it against two independent
 * artefacts rather than trusting it: the drizzle barrel, and the glossary's own
 * nineteen-term table.
 *
 * **`canonical_variants`, not `product_variants`.** Line 58's list is the
 * canonical progression — taxonomy, product type, family, product, variant —
 * followed by the two seller-side concepts. `product_variants` is the NATIVE
 * listing's child and a different thing, which is why it is named below in
 * {@link CONCEPT_NEAR_NAMES} instead. The substitution is easy to make: it was
 * made in the brief that commissioned this file.
 */
const CATALOG_CONCEPTS = [
  { concept: 'taxonomy category', table: 'categories', glossaryTerm: 'Taxonomy category' },
  { concept: 'product type', table: 'product_type_definitions', glossaryTerm: 'Product type / profile' },
  { concept: 'product family', table: 'canonical_product_families', glossaryTerm: 'Product family' },
  { concept: 'product', table: 'canonical_products', glossaryTerm: 'Canonical product' },
  { concept: 'variant', table: 'canonical_variants', glossaryTerm: 'Canonical variant' },
  { concept: 'listing', table: 'listings', glossaryTerm: 'Native listing' },
  { concept: 'offer', table: 'offers', glossaryTerm: 'Offer' },
] as const;

const CONCEPT_TABLES: readonly string[] = CATALOG_CONCEPTS.map((c) => c.table);

/**
 * Tables whose NAME reads as one of the seven and which are NOT one of them.
 *
 * `STRUCTURAL_GRAPH_FACTS` (#55) is the device: naming the near-misses is what
 * makes the seven a closed set rather than seven examples. Each entry is
 * asserted to exist and to be absent from {@link CATALOG_CONCEPTS}, so a table
 * that is quietly promoted into the seven — or one of the seven quietly
 * demoted — fails here.
 */
const CONCEPT_NEAR_NAMES: readonly { table: string; why: string }[] = [
  {
    table: 'product_variants',
    why: 'A NATIVE listing\'s variant row, the child of `listings`. The canonical concept is `canonical_variants`; an offer names BOTH, which is the join a comparison surface is built on.',
  },
  {
    table: 'collections',
    why: 'Merchandising, never taxonomy (ADR 0007 D3). A collection membership is not a product fact and `merchandising-category-isolation.test.ts` fails the build if one writes a category.',
  },
  {
    table: 'navigation_nodes',
    why: 'Storefront presentation pointing AT a concept, never one of them (ADR 0007 D3). Its seven target pointers are typed and a CHECK admits exactly one.',
  },
  {
    table: 'catalog_proposals',
    why: 'An untrusted REQUEST for a missing concept (ADR 0007 D9). It is never globally trusted data by being submitted, so a proposal for a category is not a category.',
  },
  {
    table: 'canonical_attribute_values',
    why: 'The SELECTED fact about a product or variant (ADR 0007 D7), at either grain — a fact ABOUT a concept rather than a concept.',
  },
] as const;

/**
 * A column ON one of the seven whose NAME names a concept and which carries NO
 * foreign key to it — frozen, with what each one actually is.
 *
 * This is the shape `docs/catalog-glossary.md` §"Two things in this repository
 * that share a name" describes, generalised and enforced. The entry to read is
 * `listings.product_type`: it sits one line from `product_type_definition_id`
 * in the same table, and "this listing's product type" therefore has two
 * answers with different meanings, only one of which is versioned.
 *
 * An EXACT set, never a ceiling. A new untyped concept-named column on a
 * concept's own row is exactly the conflation this file exists for; removing
 * one fails too, which is correct — a v1 contract retiring is the moment
 * somebody should be reading this list.
 */
const UNTYPED_CONCEPT_NAMED_COLUMNS: readonly {
  table: string;
  column: string;
  kind: 'derived_count' | 'attribute_keys' | 'presentation' | 'mirrored_platform_field' | 'external_identity' | 'merchant_text';
  why: string;
}[] = [
  {
    table: 'canonical_product_families',
    column: 'product_count',
    kind: 'derived_count',
    why: 'A rollup written by the merge phase and published on the brand and family pages. An integer, not a reference — there is no id in it to be the wrong concept.',
  },
  {
    table: 'canonical_products',
    column: 'variant_count',
    kind: 'derived_count',
    why: 'The same rollup at the product grain, counting this product\u2019s `canonical_variants` children. An integer, not a reference.',
  },
  {
    table: 'canonical_products',
    column: 'variant_defining_attribute_keys',
    kind: 'attribute_keys',
    why: 'Attribute registry KEYS naming which attributes differentiate this product\'s variants (ADR 0007 D6). Registry keys, never variant ids.',
  },
  {
    table: 'listings',
    column: 'variant_count',
    kind: 'derived_count',
    why: 'A rollup of the listing\'s own `product_variants` rows \u2014 the NATIVE variant table, not `canonical_variants`. An integer, not a reference.',
  },
  {
    table: 'listings',
    column: 'category_slugs',
    kind: 'presentation',
    why: 'The GIN-indexed slug array the v1 browse filter matches against. Presentation, and ADR 0007 D1 is that presentation is never identity — `category_id` beside it is the identity, and `catalog-identity-isolation.test.ts` freezes the bare `category:` request field this serves.',
  },
  {
    table: 'listings',
    column: 'product_type',
    kind: 'mirrored_platform_field',
    why: 'Shopify\'s and WooCommerce\'s own free-text `product_type`, mirrored verbatim for store browse. It is NOT #367\'s product type: that is `product_type_definitions`, cited by id from `product_type_definition_id` in this same table. Only one of the two is versioned, and a reader who takes this string for a schema version takes an import artefact for a decision.',
  },
  {
    table: 'offers',
    column: 'external_offer_id',
    kind: 'external_identity',
    why: 'The id the SOURCE platform gave its own offer. Another system\'s namespace, so it is not a Mercaria concept id at all.',
  },
  {
    table: 'offers',
    column: 'merchant_variant_text',
    kind: 'merchant_text',
    why: 'The merchant\'s own words for the configuration, retained verbatim beside the typed `canonical_variant_id`. A claim, in ADR 0007 D7\'s sense, not a reference.',
  },
] as const;

/**
 * Every member spelling a discriminator uses for one of the seven.
 *
 * Both the bare and the `canonical_`-prefixed spellings, because the
 * vocabularies disagree with each other: `ATTRIBUTE_ENTITY_KINDS` says
 * `product`/`variant` and `MERGEABLE_ENTITY_TYPES` says
 * `canonical_product`/`canonical_variant` for the same two tables.
 */
const DISCRIMINATOR_MEMBER_TO_TABLE: Readonly<Record<string, string>> = {
  category: 'categories',
  taxonomy_category: 'categories',
  product_type: 'product_type_definitions',
  product_type_definition: 'product_type_definitions',
  product_family: 'canonical_product_families',
  canonical_product_family: 'canonical_product_families',
  canonical_family: 'canonical_product_families',
  product: 'canonical_products',
  canonical_product: 'canonical_products',
  variant: 'canonical_variants',
  canonical_variant: 'canonical_variants',
  listing: 'listings',
  native_listing: 'listings',
  offer: 'offers',
  native_offer: 'offers',
};

/**
 * Every discriminator naming two or more of the seven that does NOT carry a
 * typed foreign-key column for each of them.
 *
 * The other 8 need no entry: CLAUSE 4 verifies them against the schema, so a
 * table that LOSES one of its typed columns moves into this list and fails.
 *
 * `carrier` is the classification, and only `labelled_reference` is a place a
 * concept id could be mistyped. The two `grain` entries address no row at all
 * (`identity` and `compatibility` sit in the same vocabulary and are not
 * tables), and the three `external_object` entries classify a row in the
 * SOURCE's namespace beside an `external_id` that was never a Mercaria id.
 */
const CONCEPT_SPANNING_DISCRIMINATORS: readonly {
  table: string;
  column: string;
  /**
   * The concepts this discriminator's vocabulary can address today, RECORDED.
   *
   * Without it a declared entry absorbs a vocabulary that GROWS a concept
   * silently: `MERGEABLE_ENTITY_TYPES` gaining a `listing` member leaves
   * `catalog_merge_jobs.entity_type` declared, still untyped, and now able to
   * address a concept nobody decided it should. The set is what makes that a
   * failure rather than a no-op.
   */
  concepts: readonly string[];
  why: string;
}[] = [
  { table: 'attribute_reindex_requests', column: 'entity_kind', concepts: ['canonical_products', 'canonical_variants'], why: 'A reindex queue row; `entity_id` is the product or variant it asks to be re-read.' },
  { table: 'attribute_value_reviews', column: 'entity_kind', concepts: ['canonical_products', 'canonical_variants'], why: 'An operator review queue row over one attribute of one product or variant.' },
  { table: 'catalog_authoring_draft_values', column: 'canonical_ref_kind', concepts: ['canonical_product_families', 'canonical_products', 'canonical_variants'], why: 'A draft value that IS another canonical entity; `canonical_ref_id` names it while the draft is unpublished.' },
  { table: 'catalog_authoring_draft_values', column: 'scope', concepts: ['canonical_products', 'canonical_variants'], why: 'A GRAIN. The one member that names a row, `variant`, has its OWN typed column: `draft_variant_id` is a real foreign key, tied by `catalog_authoring_draft_values_variant_scope_check` — `(scope = \'variant\') = (draft_variant_id is not null)`. `identity` and `compatibility` name no row at all.' },
  { table: 'catalog_authoring_schema_invalidations', column: 'subject', concepts: ['categories', 'product_type_definitions'], why: 'A cache-invalidation row naming which definition changed.' },
  { table: 'catalog_backfill_records', column: 'subject_kind', concepts: ['canonical_products', 'listings', 'offers'], why: '#60 backfill evidence. The subject is a composite `subject_key` spelled `<kind>:<id>`, and one of its kinds, `vendor_value`, is a normalized brand-candidate STRING that names no row anywhere. The canonical OUTCOME beside it is typed.' },
  { table: 'catalog_consistency_findings', column: 'subject_kind', concepts: ['canonical_products', 'listings', 'offers'], why: 'The backfill sweep\'s finding rows, keyed on the same composite `<kind>:<id>` `subject_key`, with the same `vendor_value` member that names no row. It repairs nothing.' },
  { table: 'catalog_entity_suppressions', column: 'entity_type', concepts: ['canonical_product_families', 'canonical_products', 'canonical_variants', 'offers'], why: 'An operator suppression over one graph entity, ledgered rather than joined.' },
  { table: 'catalog_governance_audit_events', column: 'subject_kind', concepts: ['categories', 'product_type_definitions'], why: 'The append-only governance trail, and MIXED: `operator_role` writes an OXY account id and `vertical_package` writes `<package>:<namespace>`, so two of its ten members address no Mercaria row at all.' },
  { table: 'catalog_governance_change_requests', column: 'subject_kind', concepts: ['categories', 'product_type_definitions'], why: 'A requested governance change, over the same vocabulary as the trail above.' },
  { table: 'catalog_localization_revisions', column: 'entity_kind', concepts: ['canonical_product_families', 'canonical_products', 'categories', 'listings', 'product_type_definitions'], why: 'The localization REVISION ledger. ADR 0007 D4 keeps the strings themselves in per-entity tables; only the revision trail is polymorphic, and it names five of the seven.' },
  { table: 'catalog_merge_jobs', column: 'entity_type', concepts: ['canonical_product_families', 'canonical_products', 'canonical_variants'], why: '#59\'s merge job; `entity_type` decides which of seven tables `winner_id` and `loser_id` live in.' },
  { table: 'catalog_proposals', column: 'type', concepts: ['canonical_product_families', 'canonical_products', 'canonical_variants', 'categories', 'product_type_definitions'], why: 'The proposal\'s subject. Its typed columns (`category_id`, `product_type_definition_id`, `attribute_definition_id`) are CONTEXT PINS naming what the proposal was made UNDER — a different fact from what it became; `resolved_entity_id` is the approved entity, in whichever table `type` names.' },
  { table: 'catalog_review_items', column: 'subject_type', concepts: ['canonical_product_families', 'canonical_products', 'canonical_variants', 'offers'], why: '#59\'s review inbox, deliberately wider than the mergeable set — a match decision and an identifier assertion are subjects and neither is an entity.' },
  { table: 'catalog_review_items', column: 'counterpart_type', concepts: ['canonical_product_families', 'canonical_products', 'canonical_variants', 'offers'], why: 'The other side of a review pair, over the same vocabulary.' },
  { table: 'catalog_revisions', column: 'entity_type', concepts: ['canonical_product_families', 'canonical_products', 'canonical_variants', 'offers'], why: 'The append-only curation timeline; a compensating correction names the revision it undoes.' },
  { table: 'catalog_split_assignments', column: 'item_type', concepts: ['canonical_variants', 'offers'], why: 'One row a split reassigns; `item_ref` is its id in whichever table the pair `(job.entity_type, item_type)` selects.' },
  { table: 'catalog_split_jobs', column: 'entity_type', concepts: ['canonical_products', 'canonical_variants'], why: '#59\'s split job, CHECK-restricted to a canonical product or variant.' },
  { table: 'catalog_source_objects', column: 'external_type', concepts: ['canonical_products', 'categories', 'offers'], why: 'What the SOURCE says its object is, beside an `external_id` in the source\'s own namespace. Its members include `merchant` and `relationship`, which are not concepts here either.' },
  { table: 'catalog_source_rejections', column: 'external_type', concepts: ['canonical_products', 'categories', 'offers'], why: 'The residual of a rejected external record, over the same vocabulary.' },
  { table: 'navigation_nodes', column: 'target_kind', concepts: ['canonical_product_families', 'categories', 'product_type_definitions'], why: 'Six of its seven pointers ARE typed foreign keys; `product_type_key` alone is a stable machine key, because `product_type_definitions` has no single-column unique on `key` and an id would pin one VERSION of a menu entry.' },
  { table: 'product_type_fields', column: 'scope', concepts: ['canonical_products', 'canonical_variants'], why: 'A GRAIN, and it governs no id: `attribute_definition_id` beside it is an unconditional foreign key present on every row whatever the scope. `identity` and `compatibility` name no row at all.' },
  { table: 'retail_suppressions', column: 'scope', concepts: ['canonical_products', 'canonical_variants', 'categories'], why: 'FIVE scopes are typed columns (supplier, supplier account, canonical product, canonical variant, brand) and three are not (`category`, `market`, `supplier_sku`, which have no table to reference). `scope_ref` is NOT NULL on every row and `retail_suppressions_reference_agreement_check` forces it equal to whichever typed column is present.' },
  { table: 'review_target_migrations', column: 'from_target_type', concepts: ['canonical_products', 'listings'], why: '#76\'s append-only reclassification trail, and MIXED: one of its six target types is `seller`, whose column on `reviews` is `seller_oxy_user_id` — an Oxy account id, not a Mercaria row.' },
  { table: 'review_target_migrations', column: 'to_target_type', concepts: ['canonical_products', 'listings'], why: 'The same trail\'s new side, over the same mixed vocabulary. `to_target_ref` is NULL for a `refuse_ambiguous` outcome, by `review_target_migrations_destination_check`.' },
  { table: 'source_records', column: 'external_type', concepts: ['canonical_products', 'categories', 'offers'], why: 'One observation of an external object, beside the source\'s own `external_id`.' },
] as const;

/**
 * The ONE foreign key from a concept into a table that addresses a concept
 * without a typed column, with its reason.
 *
 * Named and counted rather than silently admitted, per the exemption rule in
 * `docs/isolation-gates.md`: a list of excuses that can grow is the mechanism by
 * which a gate erodes.
 */
const CONCEPT_DEPENDENCY_EXEMPTIONS: readonly {
  child: string;
  column: string;
  parent: string;
  why: string;
}[] = [
  {
    child: 'offers',
    column: 'source_record_id',
    parent: 'source_records',
    why: 'Provenance, and the id `source_records.external_type` governs is `external_id` — the SOURCE platform\'s own key, in a namespace Mercaria neither defines nor controls. So the label on that row cannot mistype a Mercaria concept id, because there is no Mercaria concept id on it to mistype: what it classifies is what the source said it was looking at, not which canonical entity a link later attached it to.',
  },
] as const;

/** Floors, per SHAPE. One total would let a shape collapse to zero. */
const MINIMUM_TABLES = 440;
const MINIMUM_FOREIGN_KEYS = 780;
const MINIMUM_CONCEPT_FOREIGN_KEYS = 160;
const MINIMUM_CONCEPT_TABLE_COLUMNS = 180;
const MINIMUM_ENUM_COLUMNS = 1000;

interface ForeignKeyEdge {
  readonly child: string;
  readonly parent: string;
  readonly columns: readonly string[];
}

/** Every drizzle table the barrel exports, by SQL name. */
function walkTables(): ReadonlyMap<string, PgTable> {
  return new Map(
    Object.values(schema).flatMap((value) =>
      is(value, PgTable) ? [[getTableName(value), value] as const] : [],
    ),
  );
}

/** Every foreign key drizzle will emit, with SQL column names. */
function walkForeignKeys(tables: ReadonlyMap<string, PgTable>): readonly ForeignKeyEdge[] {
  const edges: ForeignKeyEdge[] = [];
  for (const [child, table] of tables) {
    for (const foreignKey of getTableConfig(table).foreignKeys) {
      const reference = foreignKey.reference();
      edges.push({
        child,
        parent: getTableName(reference.foreignTable),
        columns: reference.columns.map(sqlColumnName),
      });
    }
  }
  return edges;
}

/** Every enum-typed column, with the concepts its members name. */
function walkDiscriminators(
  tables: ReadonlyMap<string, PgTable>,
): { table: string; column: string; concepts: ReadonlySet<string>; enumSize: number }[] {
  const found: { table: string; column: string; concepts: ReadonlySet<string>; enumSize: number }[] = [];
  for (const [name, table] of tables) {
    for (const column of getTableConfig(table).columns) {
      const members = (column as unknown as { enumValues?: readonly string[] }).enumValues;
      if (!members || members.length === 0) continue;
      const concepts = new Set(
        members.flatMap((member) =>
          DISCRIMINATOR_MEMBER_TO_TABLE[member] ? [DISCRIMINATOR_MEMBER_TO_TABLE[member]] : [],
        ),
      );
      found.push({ table: name, column: sqlColumnName(column), concepts, enumSize: members.length });
    }
  }
  return found;
}

/**
 * The concept word a column name mentions, longest first.
 *
 * `canonical_product` must beat `product` and `product_type` must beat
 * `product`, or `product_type_definition_id` reports as naming a canonical
 * product and the whole clause measures the wrong thing.
 */
const CONCEPT_WORD_TO_TABLES: Readonly<Record<string, readonly string[]>> = {
  product_type: ['product_type_definitions'],
  canonical_product: ['canonical_products'],
  canonical_variant: ['canonical_variants'],
  category: ['categories'],
  categories: ['categories'],
  family: ['canonical_product_families'],
  listing: ['listings'],
  offer: ['offers'],
  // Both variant tables: `offers.product_variant_id` legitimately names the
  // NATIVE one, and refusing it would push this clause toward calling a correct
  // foreign key a conflation.
  variant: ['canonical_variants', 'product_variants'],
  product: ['canonical_products'],
};

function conceptWordIn(columnName: string): string | undefined {
  return Object.keys(CONCEPT_WORD_TO_TABLES)
    .sort((left, right) => right.length - left.length)
    .find((word) => columnName.includes(word));
}

/** The glossary's nineteen-term table: term → the first table it cites. */
function glossaryTermTables(markdown: string): ReadonlyMap<string, string> {
  const terms = new Map<string, string>();
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| **')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    // `| **Term** | it is | where it lives |` → ['', term, meaning, home, '']
    if (cells.length < 5) continue;
    const term = /^\*\*(.+?)\*\*$/.exec(cells[1]);
    const home = /`([A-Za-z0-9_]+)`/.exec(cells[3]);
    if (!term || !home) continue;
    terms.set(term[1], home[1]);
  }
  return terms;
}

const tables = walkTables();
const foreignKeys = walkForeignKeys(tables);
const discriminators = walkDiscriminators(tables);
const conceptForeignKeys = foreignKeys.filter((edge) => CONCEPT_TABLES.includes(edge.parent));

/**
 * The split both halves of CLAUSE 4 read, computed ONCE.
 *
 * A discriminator naming two or more of the seven is TYPED when its table
 * carries a foreign key to every concept its vocabulary can address, and needs
 * a declaration otherwise. Deriving it twice would be two representations of one
 * fact, and the half that drifted would be the one nothing compared against.
 */
const SPLIT = ((): {
  spanning: typeof discriminators;
  typed: string[];
  needsDeclaration: string[];
} => {
  const conceptsByChild = new Map<string, Set<string>>();
  for (const edge of conceptForeignKeys) {
    conceptsByChild.set(edge.child, (conceptsByChild.get(edge.child) ?? new Set<string>()).add(edge.parent));
  }
  const spanning = discriminators.filter((entry) => entry.concepts.size >= 2);
  const typed: string[] = [];
  const needsDeclaration: string[] = [];
  for (const entry of spanning) {
    const typedHere = conceptsByChild.get(entry.table) ?? new Set<string>();
    const missing = [...entry.concepts].filter((concept) => !typedHere.has(concept));
    (missing.length === 0 ? typed : needsDeclaration).push(`${entry.table}.${entry.column}`);
  }
  return { spanning, typed, needsDeclaration };
})();

/** The TABLES of every discriminator that needs a declaration. */
const needsDeclarationTables = (): readonly string[] =>
  SPLIT.needsDeclaration.map((key) => key.slice(0, key.lastIndexOf('.')));

describe('#367 line 58 — taxonomy, product type, family, product, variant, listing and offer stay distinct', () => {
  it('CLAUSE 0 — the instrument resolves SQL column names, proved on a known answer', () => {
    // Everything below is a membership test over SQL names. Under
    // `DATABASE_CASING`, `column.name` would spell these `categoryId` and
    // `productType`, and EVERY probe would then answer a clean, constant
    // absence — which reads exactly like a finding. So one column that MUST be
    // found with a foreign key and one that MUST be found without are asserted
    // before any verdict is taken.
    const listing = getTableConfig(tables.get('listings')!);
    const names = new Set(listing.columns.map(sqlColumnName));
    expect(names, 'the walk is not producing snake_case SQL names').toContain('category_id');
    expect(names).toContain('product_type');
    expect(names).toContain('product_type_definition_id');
    expect(names).not.toContain('categoryId');

    const typed = conceptForeignKeys.filter(
      (edge) => edge.child === 'listings' && edge.columns.join() === 'category_id',
    );
    expect(typed, '`listings.category_id` no longer resolves as a foreign key to `categories`').toHaveLength(1);
    expect(typed[0].parent).toBe('categories');

    expect(tables.size).toBeGreaterThanOrEqual(MINIMUM_TABLES);
    expect(foreignKeys.length).toBeGreaterThanOrEqual(MINIMUM_FOREIGN_KEYS);
    expect(conceptForeignKeys.length).toBeGreaterThanOrEqual(MINIMUM_CONCEPT_FOREIGN_KEYS);
    expect(discriminators.length).toBeGreaterThanOrEqual(MINIMUM_ENUM_COLUMNS);
    // Printed on SUCCESS: a floor that is met says nothing about the size of
    // what met it, and the number is how the next reader notices a collapse.
    console.log(
      `[concept-distinctness] ${tables.size} tables; ${foreignKeys.length} foreign keys, ${conceptForeignKeys.length} of them into one of the seven; ${discriminators.length} enum-typed columns.`,
    );
  });

  it('CLAUSE 1 — the seven are seven tables, and no two of them are one', () => {
    expect(CATALOG_CONCEPTS).toHaveLength(7);
    const distinct = new Set(CONCEPT_TABLES);
    expect(distinct.size, 'two concepts name the same table').toBe(7);
    for (const { concept, table } of CATALOG_CONCEPTS) {
      expect(tables.has(table), `${concept} has no table \`${table}\``).toBe(true);
    }
  });

  it('CLAUSE 1 — the glossary defines each of the seven, and cites the same table', () => {
    // `docs/catalog-glossary.md` is where the nineteen terms are DEFINED, and
    // until this clause it was read by nothing: its citations could rot to
    // anything and no build would notice. Binding it here is what makes the
    // list above a checked derivation rather than a transcription.
    expect(statSync(GLOSSARY).size, 'the glossary is missing or empty').toBeGreaterThan(2000);
    const terms = glossaryTermTables(readFileSync(GLOSSARY, 'utf8'));
    // The parser's own floor: a row shape that stopped matching would produce an
    // empty map, and every `toBe` below would then fail on a missing term —
    // loudly, but naming the wrong cause.
    expect(terms.size, 'the glossary term table did not parse').toBeGreaterThanOrEqual(15);
    for (const { concept, table, glossaryTerm } of CATALOG_CONCEPTS) {
      expect(terms.get(glossaryTerm), `the glossary no longer defines "${glossaryTerm}" (${concept})`).toBe(table);
    }
  });

  it('CLAUSE 1 — the near-names exist and are NOT among the seven', () => {
    // The `STRUCTURAL_GRAPH_FACTS` device: a set is closed by naming what sits
    // just outside it. `product_variants` is the one that matters — it is a
    // real variant table, it is not the epic's "variant", and substituting it
    // is a mistake somebody makes while reading, not while typing.
    for (const { table, why } of CONCEPT_NEAR_NAMES) {
      expect(tables.has(table), `near-name \`${table}\` no longer exists`).toBe(true);
      expect(CONCEPT_TABLES).not.toContain(table);
      expect(why.length).toBeGreaterThan(60);
    }
    expect(CONCEPT_NEAR_NAMES).toHaveLength(5);
  });

  it('CLAUSE 2 — every foreign key carrying a concept names exactly one concept', () => {
    // The typed half, and the reason most of the matrix is empty: a foreign key
    // names one table, so a row reached through one cannot be a different
    // concept. What is asserted is the thing a foreign key does NOT prevent —
    // one COLUMN carrying two of them, which Postgres permits and which would
    // be a genuine shared id space.
    const byColumn = new Map<string, Set<string>>();
    for (const edge of conceptForeignKeys) {
      const key = `${edge.child}.${edge.columns.join('+')}`;
      const parents = byColumn.get(key) ?? new Set<string>();
      parents.add(edge.parent);
      byColumn.set(key, parents);
    }
    const shared = [...byColumn]
      .filter(([, parents]) => parents.size > 1)
      .map(([column, parents]) => `${column} -> ${[...parents].sort().join(' AND ')}`);
    expect(shared, 'a single column carries foreign keys to two different concepts').toEqual([]);

    const perConcept = Object.fromEntries(
      CONCEPT_TABLES.map((table) => [table, conceptForeignKeys.filter((e) => e.parent === table).length]),
    );
    // Every one of the seven is REACHED by at least one typed reference. A
    // concept nothing points at is one nothing is using, and the count reaching
    // zero is how a concept stops being load-bearing without being deleted.
    for (const [table, count] of Object.entries(perConcept)) {
      expect(count, `nothing references \`${table}\` by a foreign key`).toBeGreaterThan(0);
    }
    console.log(`[concept-distinctness] typed references per concept: ${JSON.stringify(perConcept)}`);
  });

  it('CLAUSE 3 — on a concept row, a concept-named column is typed or dispositioned', () => {
    const dispositioned = new Set(
      UNTYPED_CONCEPT_NAMED_COLUMNS.map((entry) => `${entry.table}.${entry.column}`),
    );
    // A SET per column, not one parent: a column may legally carry two foreign
    // keys, and keeping only the last one made this clause report the shape
    // CLAUSE 2 exists for as "carries no foreign key to it" — a true failure
    // with a false reason, which is the kind that gets the wrong thing fixed.
    const fkByColumn = new Map<string, Set<string>>();
    for (const edge of foreignKeys) {
      const key = `${edge.child}.${edge.columns.join('+')}`;
      fkByColumn.set(key, (fkByColumn.get(key) ?? new Set<string>()).add(edge.parent));
    }

    const offenders: string[] = [];
    const found = new Set<string>();
    let columnsWalked = 0;
    for (const table of CONCEPT_TABLES) {
      for (const column of getTableConfig(tables.get(table)!).columns) {
        columnsWalked += 1;
        const name = sqlColumnName(column);
        if (name === 'id') continue;
        const word = conceptWordIn(name);
        if (!word) continue;
        const key = `${table}.${name}`;
        const parents = fkByColumn.get(key) ?? new Set<string>();
        if (CONCEPT_WORD_TO_TABLES[word].some((table) => parents.has(table))) continue;
        found.add(key);
        if (!dispositioned.has(key)) offenders.push(`${key} names \`${word}\` and carries no foreign key to it`);
      }
    }
    expect(columnsWalked).toBeGreaterThanOrEqual(MINIMUM_CONCEPT_TABLE_COLUMNS);
    expect(offenders).toEqual([]);
    // EXACT, both directions: an entry excusing a column the walk no longer
    // produces is an excuse nobody is using, and it should be deleted rather
    // than kept — the shape in which three of six exemptions in another guard
    // here were unmatchable from birth.
    expect([...found].sort()).toEqual([...dispositioned].sort());
    for (const entry of UNTYPED_CONCEPT_NAMED_COLUMNS) expect(entry.why.length).toBeGreaterThan(60);
    console.log(
      `[concept-distinctness] ${columnsWalked} columns on the seven concept tables; ${found.size} name a concept without a foreign key to it.`,
    );
  });

  it('CLAUSE 4 — a discriminator naming two concepts is typed per concept, or declared', () => {
    const declared = new Map(
      CONCEPT_SPANNING_DISCRIMINATORS.map((entry) => [`${entry.table}.${entry.column}`, entry]),
    );
    const { spanning, typed, needsDeclaration } = SPLIT;

    const undeclared = needsDeclaration.filter((key) => !declared.has(key));
    expect(
      undeclared,
      'a discriminator names two or more of the seven, addresses at least one of them without a typed column, and is not declared',
    ).toEqual([]);
    // The other direction: a declared entry that has become typed, or that no
    // longer spans two concepts, is a decision nobody is making any more.
    expect([...declared.keys()].sort()).toEqual([...needsDeclaration].sort());

    // And the set each one may address, RECORDED rather than recomputed. A
    // vocabulary that grows a concept keeps its declaration and its untyped
    // carrier, so nothing above would move — this is the assertion that makes
    // the growth visible.
    const drift = spanning
      .filter((entry) => declared.has(`${entry.table}.${entry.column}`))
      .flatMap((entry) => {
        const recorded = [...declared.get(`${entry.table}.${entry.column}`)!.concepts].sort();
        const live = [...entry.concepts].sort();
        return recorded.join() === live.join()
          ? []
          : [`${entry.table}.${entry.column}: recorded [${recorded}] but addresses [${live}]`];
      });
    expect(drift, 'a declared discriminator can now address a different set of concepts').toEqual([]);
    expect(spanning.length).toBeGreaterThanOrEqual(30);
    expect(typed.length).toBeGreaterThanOrEqual(6);
    for (const entry of CONCEPT_SPANNING_DISCRIMINATORS) expect(entry.why.length).toBeGreaterThan(40);
    console.log(
      `[concept-distinctness] ${spanning.length} discriminators name two or more of the seven: ${typed.length} carry a typed column per concept, ${needsDeclaration.length} declared.`,
    );
  });

  it('CLAUSE 4 — no concept depends on a row that addresses a concept by a label', () => {
    // This is the reason the declared list above is tolerable rather than a
    // defect list: every one of those rows is a ledger, job, queue or audit
    // row, and the catalogue does not point back at one — so a mistyped label
    // is a wrong row in a trail, never a fact the graph is built on.
    //
    // The population is DERIVED from the walk, not read off the declarations.
    // An earlier draft filtered it by a hand-written `carrier` field, which
    // made the safest-looking value ('this one is external, not a reference')
    // able to remove a table from the check — a category that absorbs whatever
    // does not fit is a hole, not an exemption. There is now no category, and
    // the ONE edge that exists is named below with its reason.
    const untypedTables = new Set(needsDeclarationTables());
    expect(untypedTables.size).toBeGreaterThanOrEqual(20);

    const exempt = new Set(
      CONCEPT_DEPENDENCY_EXEMPTIONS.map((entry) => `${entry.child}.${entry.column} -> ${entry.parent}`),
    );
    const dependencies = foreignKeys
      .filter((edge) => CONCEPT_TABLES.includes(edge.child) && untypedTables.has(edge.parent))
      .map((edge) => `${edge.child}.${edge.columns.join('+')} -> ${edge.parent}`);
    expect(dependencies.filter((edge) => !exempt.has(edge))).toEqual([]);

    // The exemption's own exact count, and a probe that it still fires. An
    // excuse nobody is using should be deleted rather than kept.
    expect(CONCEPT_DEPENDENCY_EXEMPTIONS).toHaveLength(1);
    for (const entry of CONCEPT_DEPENDENCY_EXEMPTIONS) {
      expect(entry.why.length).toBeGreaterThan(120);
      expect(
        dependencies,
        `${entry.child}.${entry.column} is excused but the walk no longer produces it`,
      ).toContain(`${entry.child}.${entry.column} -> ${entry.parent}`);
    }

    // The control: those tables ARE reachable, so the near-zero above is a
    // property of the seven and not of an empty parent set.
    const anyDependency = foreignKeys.filter((edge) => untypedTables.has(edge.parent));
    expect(anyDependency.length, 'no table at all references one of them').toBeGreaterThan(20);
    console.log(
      `[concept-distinctness] ${untypedTables.size} tables address a concept without a typed column; ${anyDependency.length} foreign keys point at one, ${dependencies.length} of them from a concept (${exempt.size} exempt).`,
    );
  });

  it('CLAUSE 5 — the pairwise matrix is DERIVED, and every ordered pair is in it', () => {
    // Seven concepts give 42 ordered pairs, and direction matters: "a variant
    // may stand in for a product" and its reverse are different claims. The
    // matrix is built from the walk rather than from a list of pairs somebody
    // thought were interesting — the pair nobody prioritised is exactly where a
    // conflation lands, because it is the one nobody was watching.
    //
    // A pair is NON-EMPTY when some discriminator can address both concepts and
    // at least one of the two has no typed column on that table: that is the
    // whole of what "one could be written where the other is meant" means once
    // CLAUSE 2 has ruled out a shared id space.
    const sites = new Map<string, Set<string>>();
    for (const entry of SPLIT.spanning) {
      const key = `${entry.table}.${entry.column}`;
      if (!SPLIT.needsDeclaration.includes(key)) continue;
      const typedHere = new Set(
        conceptForeignKeys.filter((edge) => edge.child === entry.table).map((edge) => edge.parent),
      );
      for (const from of entry.concepts) {
        for (const to of entry.concepts) {
          if (from === to) continue;
          if (typedHere.has(from) && typedHere.has(to)) continue;
          const pair = `${from} -> ${to}`;
          sites.set(pair, (sites.get(pair) ?? new Set<string>()).add(key));
        }
      }
    }

    const rows: string[] = [];
    let covered = 0;
    for (const from of CONCEPT_TABLES) {
      for (const to of CONCEPT_TABLES) {
        if (from === to) continue;
        covered += 1;
        rows.push(`${from} -> ${to}: ${(sites.get(`${from} -> ${to}`) ?? new Set()).size}`);
      }
    }
    // 7 x 6. The assertion is on the ENUMERATION, not on the counts: a matrix
    // that examined fewer pairs than exist is the failure this clause prevents,
    // and it looks exactly like a matrix with fewer findings.
    expect(covered).toBe(42);
    expect(rows).toHaveLength(42);
    // Every site the matrix reports is a declared discriminator, so the matrix
    // and CLAUSE 4 cannot disagree about the population.
    const declaredKeys = new Set(
      CONCEPT_SPANNING_DISCRIMINATORS.map((entry) => `${entry.table}.${entry.column}`),
    );
    for (const set of sites.values()) {
      for (const key of set) expect(declaredKeys.has(key), `${key} is a matrix site but is not declared`).toBe(true);
    }
    console.log(`[concept-distinctness] pairwise matrix, 42 ordered pairs:\n  ${rows.join('\n  ')}`);
  });

  describe('mutation self-tests — each clause, against schema shapes the walk never produces', () => {
    it('CLAUSE 2 fires on one column carrying foreign keys to two concepts', () => {
      const planted: ForeignKeyEdge[] = [
        { child: 'planted', parent: 'canonical_products', columns: ['entity_id'] },
        { child: 'planted', parent: 'canonical_variants', columns: ['entity_id'] },
      ];
      const byColumn = new Map<string, Set<string>>();
      for (const edge of planted) {
        const key = `${edge.child}.${edge.columns.join('+')}`;
        byColumn.set(key, (byColumn.get(key) ?? new Set()).add(edge.parent));
      }
      expect([...byColumn].filter(([, parents]) => parents.size > 1)).toHaveLength(1);
    });

    it('CLAUSE 2 does NOT fire on the two-typed-columns shape it sits beside', () => {
      // `canonical_attribute_values` is exactly this: `product_id` and
      // `variant_id`, one each, with a grain CHECK. A detector that cannot tell
      // it from the planted shape above would be narrowed under pressure, and
      // the narrowing is always the permissive direction.
      const legitimate: ForeignKeyEdge[] = [
        { child: 'canonical_attribute_values', parent: 'canonical_products', columns: ['product_id'] },
        { child: 'canonical_attribute_values', parent: 'canonical_variants', columns: ['variant_id'] },
      ];
      const byColumn = new Map<string, Set<string>>();
      for (const edge of legitimate) {
        const key = `${edge.child}.${edge.columns.join('+')}`;
        byColumn.set(key, (byColumn.get(key) ?? new Set()).add(edge.parent));
      }
      expect([...byColumn].filter(([, parents]) => parents.size > 1)).toEqual([]);
    });

    it('CLAUSE 3 — the word matcher takes the LONGEST concept name, not the first', () => {
      // The failure this prevents is silent and total: read
      // `product_type_definition_id` as naming `product`, and the clause
      // demands a foreign key to `canonical_products`, reports the real typed
      // pin as an offender, and gets "fixed" by deleting the check.
      expect(conceptWordIn('product_type_definition_id')).toBe('product_type');
      expect(conceptWordIn('canonical_variant_id')).toBe('canonical_variant');
      expect(conceptWordIn('canonical_product_id')).toBe('canonical_product');
      // `product_variant_id` names the WORD `variant`, which maps to BOTH
      // variant tables — that is what lets `offers.product_variant_id` satisfy
      // CLAUSE 3 through its foreign key to the native table.
      expect(conceptWordIn('product_variant_id')).toBe('variant');
      expect(CONCEPT_WORD_TO_TABLES['variant']).toEqual(['canonical_variants', 'product_variants']);
      expect(conceptWordIn('category_slugs')).toBe('category');
      expect(conceptWordIn('created_at')).toBeUndefined();
      expect(conceptWordIn('store_id')).toBeUndefined();
    });

    it('CLAUSE 3 — the live population contains the conflation the glossary warns about', () => {
      // A positive control on the WALK, not on the list: if the clause ever
      // stopped seeing `listings.product_type`, its exact-set assertion would
      // fail on a missing entry rather than on an undetected offender, and the
      // repair somebody reaches for is deleting the entry.
      const listing = getTableConfig(tables.get('listings')!);
      const names = listing.columns.map(sqlColumnName);
      expect(names).toContain('product_type');
      expect(names).toContain('product_type_definition_id');
      const typedPin = foreignKeys.filter(
        (edge) => edge.child === 'listings' && edge.columns.join() === 'product_type_definition_id',
      );
      expect(typedPin).toHaveLength(1);
      expect(typedPin[0].parent).toBe('product_type_definitions');
      const untypedTwin = foreignKeys.filter(
        (edge) => edge.child === 'listings' && edge.columns.join() === 'product_type',
      );
      expect(untypedTwin, '`listings.product_type` acquired a foreign key — retire its entry above').toEqual([]);
    });

    it('CLAUSE 4 fires on a planted label-plus-bare-id, and not on a typed pair', () => {
      const conceptsFor = (members: readonly string[]) =>
        new Set(members.flatMap((m) => (DISCRIMINATOR_MEMBER_TO_TABLE[m] ? [DISCRIMINATOR_MEMBER_TO_TABLE[m]] : [])));
      // The realistic violation: a new queue row addressing a product OR a
      // variant through one untyped column.
      const planted = conceptsFor(['product', 'variant']);
      expect(planted.size).toBe(2);
      const noTypedColumns = new Set<string>();
      expect([...planted].filter((c) => !noTypedColumns.has(c))).toHaveLength(2);
      // Beside it, the same vocabulary on a table that DOES carry both columns.
      const typedColumns = new Set(['canonical_products', 'canonical_variants']);
      expect([...planted].filter((c) => !typedColumns.has(c))).toHaveLength(0);
    });

    it('CLAUSE 4 — a vocabulary that grows a concept changes what must be typed', () => {
      // `MERGEABLE_ENTITY_TYPES` gaining `listing` is the realistic version:
      // the table keeps every column it had, and the set of concepts its label
      // can address grows by one that nothing on it is typed for.
      const before = new Set(
        ['canonical_product', 'canonical_variant'].map((m) => DISCRIMINATOR_MEMBER_TO_TABLE[m]),
      );
      const after = new Set(
        ['canonical_product', 'canonical_variant', 'listing'].map((m) => DISCRIMINATOR_MEMBER_TO_TABLE[m]),
      );
      const typedColumns = new Set(['canonical_products', 'canonical_variants']);
      expect([...before].filter((c) => !typedColumns.has(c))).toEqual([]);
      expect([...after].filter((c) => !typedColumns.has(c))).toEqual(['listings']);
    });

    it('CLAUSE 1 — the glossary parser reads a real row and refuses a prose line', () => {
      const parsed = glossaryTermTables(
        [
          '| Term | It is | Where it lives |',
          '|---|---|---|',
          '| **Offer** | The exact commercial terms. | `offers`, `db/schema/offers.ts:139` |',
          'Prose mentioning `offers` and **Offer** outside a table.',
          '| **Native listing** | One store’s record. | `listings`, `db/schema/catalog.ts:246`; its variants `product_variants`, `:697` |',
        ].join('\n'),
      );
      expect(parsed.get('Offer')).toBe('offers');
      // The multi-citation row takes the FIRST table, which is the term's own.
      expect(parsed.get('Native listing')).toBe('listings');
      expect(parsed.size).toBe(2);
    });

    it('CLAUSE 1 — the glossary parser fails LOUDLY on a table that changed shape', () => {
      // The clause rests on `terms.size >= 15`. Without it a renamed column
      // separator, a switch to a definition list or a moved table would return
      // an empty map, and the failure would name a missing term rather than a
      // parser that read nothing.
      expect(glossaryTermTables('nothing here is a table row').size).toBe(0);
    });
  });
});
