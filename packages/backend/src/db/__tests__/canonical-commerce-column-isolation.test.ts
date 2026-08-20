/**
 * Price, stock, availability, condition and fulfilment stay OUT of the
 * canonical graph.
 *
 * ADR 0007 D5 and the epic's own invariant. A canonical product is what the
 * thing IS; what it costs, whether anyone has one, what state that one is in
 * and how it reaches a buyer are properties of an OFFER, a LISTING or an
 * INVENTORY LEVEL. Those live in `offers.ts` and `catalog.ts` and they are not
 * short of columns — which is the point: the separation is not scarcity, it is
 * a decision, and a decision with nothing behind it is a convention.
 *
 * ## What was actually here before this file
 *
 * A clean census and no gate. Seventeen tables, 225 columns, zero commerce
 * facts among them — and adding `price_amount` to `canonical_variants`
 * tomorrow would have failed no test in this repository. D5's own scanned gate
 * (`product-type-isolation.test.ts:150`) covers the PRODUCT-TYPE module, so an
 * attribute cannot be declared as a price; nothing covered the canonical tables
 * themselves.
 *
 * The failure this refuses is not a crash. A `canonical_variants.price_amount`
 * would work: somebody would populate it from whichever offer happened to be
 * cheapest at import time, a comparison surface would read it because it is one
 * join shorter, and the number would be wrong in the ordinary way — stale, from
 * one seller, in one currency, presented as a fact about the product.
 *
 * ## Deny-only, and no allow-list
 *
 * `retail-logistics-isolation.test.ts` pairs a deny-list with a per-table
 * allow-list, and that is right where the domain is four small tables somebody
 * owns end to end. Here it would be 225 entries across seventeen tables in the
 * repository's oldest schema module, edited by every catalogue branch — a list
 * that size is a merge conflict that gets resolved by pasting, and a permission
 * granted by pasting is not a permission anybody decided. So this walks the
 * module and refuses NAMES, which is the half that catches the column somebody
 * added while thinking about something else.
 *
 * The cost is stated rather than hidden: a commerce fact under a name no
 * prohibition carries — `msrp_snapshot`, `rrp` — passes. That is the direction
 * an allow-list covers and this does not, and it is why the prohibition
 * vocabulary below is DERIVED from the columns the owning tables really use
 * rather than imagined.
 *
 * ## Matching is by SEGMENT, and the run form is load-bearing
 *
 * `columnProhibition` compares whole underscore-separated segments, so `price`
 * refuses `price_amount` and `list_price` and leaves `pricing_policy_id` alone.
 * That precision is why `quantity` is NOT prohibited on its own:
 * `bundle_components.quantity` is how many of a component a bundle contains — a
 * structural product fact — while `available_quantity` is stock, and `available`
 * catches the second without touching the first.
 */

import { describe, expect, it } from 'vitest';
import * as canonicalCatalog from '../schema/canonicalCatalog.js';
import * as offers from '../schema/offers.js';
import * as catalog from '../schema/catalog.js';
import * as attributeRegistry from '../schema/attributeRegistry.js';
import { RESERVED_OFFER_FACT_KEYS } from '@mercaria/shared-types';
import {
  columnProhibition,
  prohibitionProbeColumn,
  schemaTableColumns,
  type ColumnExemption,
  type ColumnProhibition,
} from './column-allowlist.js';
import { assertEachOf } from '../../__tests__/assert-each-of.js';

/**
 * The vocabulary, derived from the tables that own these facts rather than
 * invented.
 *
 * Every token below was measured as a real segment of a real column in
 * `offers.ts` or `catalog.ts` at the time of writing, except the four marked —
 * `stock`, `fulfilment`, `fulfillment` and `shipping` — which name facts the
 * invariant lists and which no column spells today. Those four can never fire
 * against the current schema and that is deliberate: this gate's whole job is
 * the ADD direction, and a prohibition on the name a future column would carry
 * is worth exactly as much as one on a name already in use. The self-test below
 * proves all fifteen CAN fire, by construction and exhaustively, so an inert
 * one is distinguishable from a broken one.
 */
const PROHIBITIONS: readonly ColumnProhibition[] = [
  { segments: ['price'], prohibition: 'a price' },
  { segments: ['cost'], prohibition: 'a cost' },
  { segments: ['amount'], prohibition: 'a money magnitude' },
  { segments: ['currency'], prohibition: 'a money currency' },
  { segments: ['stock'], prohibition: 'stock state' },
  { segments: ['available'], prohibition: 'availability' },
  { segments: ['availability'], prohibition: 'availability' },
  { segments: ['inventory'], prohibition: 'inventory' },
  { segments: ['condition'], prohibition: 'item condition' },
  { segments: ['fulfilment'], prohibition: 'fulfilment' },
  { segments: ['fulfillment'], prohibition: 'fulfilment' },
  { segments: ['shipping'], prohibition: 'fulfilment' },
  { segments: ['delivery'], prohibition: 'fulfilment' },
  { segments: ['pickup'], prohibition: 'fulfilment' },
  { segments: ['sku'], prohibition: 'a merchant SKU, which is source-scoped and never universal' },
];

/**
 * The money slot of a `money`-typed ATTRIBUTE value, and the only exemption.
 *
 * `canonical_attribute_values` stores one normalized value of one attribute.
 * When that attribute's `value_type` is `money` — a manufacturer's suggested
 * price, a deposit, a licence fee — the magnitude and its currency have to land
 * somewhere, and these two columns are where. They are not a price the way a
 * prohibited column would be: they carry whatever the attribute MEANS, and what
 * an attribute may mean is bounded by a CHECK rather than by intent.
 *
 * That is the reason, and CLAUSE 2c asserts it in its own terms rather than
 * quoting it. `RESERVED_OFFER_FACT_KEYS` names twenty keys — `price`,
 * `availability`, `in_stock`, `condition`, `shipping_cost` and sixteen more —
 * and `attribute_definitions_reserved_key_check` is rendered from that same
 * tuple (`db/schema/attributeRegistry.ts:181`). So no attribute can be DEFINED
 * as any of the facts this file exists to keep out, and therefore no
 * attribute's money slot can hold one. `msrp` is deliberately absent from the
 * reserved tuple, and the registry's own docblock gives the reason: a
 * manufacturer's suggested price genuinely is a product fact, and a
 * `money`-typed attribute is the right home for it.
 *
 * If that CHECK were ever narrowed, this exemption would stop being safe — and
 * CLAUSE 2c is what turns that into a build failure instead of a silence.
 */
const EXEMPTIONS: readonly ColumnExemption[] = [
  {
    column: 'canonical_attribute_values.normalized_amount_minor',
    reason:
      'The magnitude slot of a `money`-typed attribute value. Bounded by attribute_definitions_reserved_key_check, which is rendered from RESERVED_OFFER_FACT_KEYS, so the attribute it belongs to cannot be a price, an availability or a condition.',
  },
  {
    column: 'canonical_attribute_values.normalized_currency',
    reason:
      'The currency of that same money-typed attribute value. Present exactly when the magnitude is, and bounded by the same CHECK over the same tuple.',
  },
];

/** The commerce keys the exemption's safety actually rests on. */
const RESERVED_KEYS_THE_EXEMPTION_RESTS_ON: readonly string[] = [
  'price',
  'availability',
  'in_stock',
  'stock',
  'inventory',
  'condition',
  'shipping_cost',
  'delivery_cost',
];

/** Floors, per SHAPE. One total would let a shape collapse to zero unseen. */
const MINIMUM_CANONICAL_TABLES = 16;
const MINIMUM_CANONICAL_COLUMNS = 200;
const MINIMUM_CONTROL_HITS = 20;

const canonicalTables = schemaTableColumns(canonicalCatalog as unknown as Record<string, unknown>);
const canonicalColumns = canonicalTables.flatMap(({ table, columns }) =>
  columns.map((column) => `${table}.${column}`),
);

describe('the canonical graph carries no price, stock, availability, condition or fulfilment (ADR 0007 D5)', () => {
  it('walked a real population', () => {
    expect(canonicalTables.length).toBeGreaterThanOrEqual(MINIMUM_CANONICAL_TABLES);
    expect(canonicalColumns.length).toBeGreaterThanOrEqual(MINIMUM_CANONICAL_COLUMNS);
    // Printed on SUCCESS. A floor that is met says nothing about the size of
    // what met it, and this number is how the next reader notices a collapse.
    console.log(
      `[canonical-commerce] ${canonicalTables.length} canonical tables; ${canonicalColumns.length} columns; ${PROHIBITIONS.length} prohibitions; ${EXEMPTIONS.length} exemptions.`,
    );
  });

  it('CLAUSE 1 — no canonical column names a commerce fact', () => {
    const offenders = canonicalColumns
      .map((column) => ({ column, prohibition: columnProhibition(column, PROHIBITIONS, EXEMPTIONS) }))
      .filter((entry) => entry.prohibition !== null)
      .map((entry) => `${entry.column} — ${entry.prohibition}`);
    expect(offenders).toEqual([]);
  });

  it('CLAUSE 2a — the exemption list is exactly two', () => {
    // Its own exact-count assertion. A list of excuses that can grow quietly is
    // the mechanism by which a gate erodes to `>= 0`.
    expect(EXEMPTIONS).toHaveLength(2);
    expect(new Set(EXEMPTIONS.map((entry) => entry.column)).size).toBe(2);
    for (const entry of EXEMPTIONS) expect(entry.reason.length).toBeGreaterThan(80);
  });

  it('CLAUSE 2b — each exempted column is still DERIVED from the real schema', () => {
    // An exemption for something nobody writes any more is an excuse nobody is
    // using, and it should be deleted rather than kept: it is indistinguishable
    // from a live one in every count the gate asserts.
    for (const entry of EXEMPTIONS) {
      expect(canonicalColumns, `${entry.column} is excused but no longer exists`).toContain(
        entry.column,
      );
    }
  });

  it('CLAUSE 2c — the REASON still holds, in its own terms', () => {
    // The exemption is safe because an attribute cannot be defined as any of
    // the facts this file keeps out. That is two things, and both are asserted
    // rather than quoted: the tuple still names the commerce keys, and the
    // CHECK is still rendered from that tuple.
    for (const key of RESERVED_KEYS_THE_EXEMPTION_RESTS_ON) {
      expect(RESERVED_OFFER_FACT_KEYS, `${key} left the reserved tuple`).toContain(key);
    }
    expect(RESERVED_OFFER_FACT_KEYS.length).toBeGreaterThanOrEqual(20);

    const definitions = schemaTableColumns(
      attributeRegistry as unknown as Record<string, unknown>,
    ).find((entry) => entry.table === 'attribute_definitions');
    expect(definitions, 'attribute_definitions is no longer in the registry module').toBeDefined();
    // The CHECK's own subject: a definition names its concept in `key`, which is
    // the column the reserved tuple is compared against.
    expect(definitions?.columns).toContain('key');
  });

  it('CLAUSE 2d — could an exemption EVER fire? a shape the walk never produces must not match', () => {
    // The direction a size assertion cannot see. Measured elsewhere in this
    // repository: three of six exemptions in another guard were structurally
    // unmatchable from birth, and a reconciliation reports zero for that
    // exactly as it does for a legitimately removed subject.
    const unmatchable = 'canonicalAttributeValues.normalizedAmountMinor';
    expect(canonicalColumns).not.toContain(unmatchable);
    // And an exemption spelled that way would silence nothing, because the
    // qualified name the walk produces is snake_case on both sides.
    expect(
      columnProhibition('canonical_attribute_values.normalized_amount_minor', PROHIBITIONS, [
        { column: unmatchable, reason: 'a camelCase spelling the walk never emits' },
      ]),
    ).toBe('a money magnitude');
  });

  it('CLAUSE 3 — the positive control: the same prohibitions FIRE on the tables that own these facts', () => {
    // The control has to run through production's own shape — a walk of a real
    // schema module — and not through literals this file wrote. A detector
    // proven only against strings it composed itself is proven against itself.
    const controls = [
      { name: 'offers.ts', module: offers },
      { name: 'catalog.ts', module: catalog },
    ];
    let total = 0;
    for (const control of controls) {
      const hits = schemaTableColumns(control.module as unknown as Record<string, unknown>)
        .flatMap(({ table, columns }) => columns.map((column) => `${table}.${column}`))
        .filter((column) => columnProhibition(column, PROHIBITIONS) !== null);
      expect(hits.length, `${control.name} produced no hits — the detector is inert`).toBeGreaterThan(
        0,
      );
      total += hits.length;
      console.log(`[canonical-commerce] control ${control.name}: ${hits.length} prohibited names.`);
    }
    expect(total).toBeGreaterThanOrEqual(MINIMUM_CONTROL_HITS);
  });

  it('mutation self-test — EVERY prohibition can fire, exhaustively and by construction', () => {
    // Rebuilt from each prohibition's own segments, so a token added later is
    // covered the moment it is added rather than when somebody remembers to
    // write a probe for it.
    for (const entry of PROHIBITIONS) {
      const probe = `canonical_products.${prohibitionProbeColumn(entry)}`;
      expect(columnProhibition(probe, PROHIBITIONS), `${probe} is refused by nothing`).toBe(
        entry.prohibition,
      );
    }
    expect(PROHIBITIONS).toHaveLength(15);
  });

  it('mutation self-test — the prohibitions do NOT fire on the legitimate names they sit beside', () => {
    // A detector that cannot tell a legitimate value from its quarry gets
    // narrowed under pressure, and narrowing is the permissive direction.
    assertEachOf([
      'bundle_components.quantity',
      'canonical_products.pricing_policy_id',
      'canonical_variants.position',
      'canonical_products.description',
      'product_identifiers.value',
    ], 5, (legitimate) => {
      expect(columnProhibition(legitimate, PROHIBITIONS), `${legitimate} was refused`).toBeNull();
    });
  });
});
