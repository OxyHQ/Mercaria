/**
 * The FOOTWEAR reference vertical (#367 Workstream 14).
 *
 * ## What this package exists to prove
 *
 * Sizes. Everything else here — a category path, a product type, a colour
 * family — footwear shares with every other vertical. What footwear has that
 * nothing else does is a fact that is FIVE different facts wearing one word, and
 * a marketplace that collapses them sells somebody the wrong shoe.
 *
 * ## The one architectural decision worth reading before the data
 *
 * **A size system IS an attribute definition.** `shoe_size_eu` and
 * `shoe_size_uk` are two keys, so no bucket of one can reach a bucket of the
 * other: `FACET_FORBIDDEN_EQUIVALENCES` names `size_system_conversion` as a
 * prohibition, and `facet-isolation.test.ts` fails the build on any function
 * shaped like one. There is no size-system table, no audience column and no
 * conversion table in this repository, and this package does not invent one —
 * a package cannot add DDL, and inventing a per-deployment convention where the
 * schema has a deliberate hole is how two answers to one question start.
 *
 * So the epic's "EU/US/UK/CM size systems with audience/department context" is
 * modelled with the three mechanisms that DO exist:
 *
 * 1. **The system is the KEY.** `shoe_size_eu`, `shoe_size_us_mens`,
 *    `shoe_size_us_womens`, `shoe_size_uk` are four definitions. `9` under one
 *    of them cannot be read as `9` under another because a filter names a key.
 * 2. **The audience is the CATEGORY SCOPE.** `shoe_size_us_mens` is scoped to
 *    the men's node and `shoe_size_us_womens` to the women's, so the women's
 *    authoring schema and the women's facet list cannot even OFFER a men's
 *    size. That is the "with audience/department context" half, and it is why
 *    the two departments are separate selectable categories rather than one.
 * 3. **The measurement basis is a MEASUREMENT.** `shoe_size_cm` is a
 *    `length` measurement in mm, so `26.5 cm` and `265 mm` collide and are
 *    comparable across brands — the one size fact that is a physical quantity
 *    rather than a label.
 *
 * ## Brand size charts, and why they are per-product facts
 *
 * The epic asks for "brand/product-specific size charts where supplied" and for
 * conversions modelled "as sourced mappings/ranges with confidence, not
 * universal exact truth". There is no size-chart table to put one in. What
 * there IS turns out to say the same thing more strongly: each canonical
 * variant records its OWN size in every system, as an observation with
 * provenance. The chart is then the set of facts that brand's variants carry,
 * and it is per-brand by construction rather than by policy.
 *
 * This package makes that visible on purpose. Kestrel's EU 42 records
 * **US Men's 9**; Nordvik's EU 42 records **US Men's 8.5**. Both are true. A
 * universal conversion table would have to be wrong about one of them, and
 * `verticals-footwear.realdb.test.ts` asserts exactly that pair — which is the
 * positive form of the epic's "EU 42, US Men's 9 and UK 8 are not collapsed".
 *
 * ## The sparse matrix
 *
 * `Trailwind 3` declares three axes (EU size × colour × width). The full cross
 * product is 3 × 2 × 2 = 12 and the package seeds 8, so four combinations are
 * genuinely unavailable. The four are chosen so that every individual axis
 * VALUE still appears somewhere — `41`, `black` and `wide` each exist — which is
 * what makes `41/black/wide` absent as a COMBINATION rather than absent because
 * one of its components is unknown. A sparse-matrix test that could not tell
 * those apart would pass against a fixture that simply forgot a colour.
 */

import type { VerticalPackage } from './types.js';

/** Kestrel's own chart. EU size → (US Men's, UK, foot length). */
const KESTREL_MENS_CHART = {
  '41': { us: '8.5', uk: '7.5', cm: '26.0 cm' },
  '42': { us: '9', uk: '8', cm: '26.5 cm' },
  '43': { us: '9.5', uk: '8.5', cm: '27.0 cm' },
} as const;

/** Nordvik's own chart, which DISAGREES with Kestrel's at EU 42. */
const NORDVIK_MENS_CHART = {
  '41': { us: '8', uk: '7', cm: '26.3 cm' },
  '42': { us: '8.5', uk: '7.5', cm: '26.8 cm' },
} as const;

/** Kestrel's women's chart — a different SYSTEM, not a different row of one. */
const KESTREL_WOMENS_CHART = {
  '38': { us: '7', uk: '5', cm: '24.0 cm' },
  '39': { us: '8', uk: '6', cm: '24.5 cm' },
} as const;

/**
 * Where the colour of a shoe is recorded, and why it is THREE places.
 *
 * A measured property of `createVariant` shapes this, and it is worth stating
 * because the obvious fixture gets it backwards: **the canonical-variant axis
 * path does NOT resolve enum aliases.** `normalizeOption` folds case and
 * whitespace (`normalizeOptionValue`) and stores the result; it never consults
 * `attribute_value_aliases`. So an axis carrying the commercial name `Jet
 * Black` would store the axis value `jet black`, and `Midnight` on another
 * product would store `midnight` — two colours where the catalogue has one, in
 * the exact column a facet buckets. That is the `Color`/`Colour`/`Tono`
 * duplication this epic exists to end, arriving through the door marked
 * "preserve the seller's words".
 *
 * So:
 *
 * - the **axis** carries the FAMILY (`black`), because the axis is the buyable
 *   identity and the thing a filter matches;
 * - a variant-grain **observation** of `footwear_color` carries the commercial
 *   name (`Jet Black`), which DOES go through `normalizeEnum` and the alias
 *   table — so `canonical_attribute_values` ends up holding
 *   `source_display_value = 'Jet Black'` beside `normalized_text = 'black'`.
 *   That is "preserve source display values even when they normalize to one
 *   controlled value", proved on the path that has the mechanism;
 * - `footwear_colorway` carries the full marketing treatment
 *   (`Jet Black / Ember`), which is neither a family nor a filter.
 */
const TRAILWIND_MATRIX: readonly {
  readonly size: keyof typeof KESTREL_MENS_CHART;
  /** The FAMILY, and the axis value. */
  readonly color: string;
  /** What the manufacturer calls it — an alias of the family. */
  readonly commercialColor: string;
  readonly colorway: string;
  readonly width: string;
  /** The per-package GTIN ordinal. See `VerticalIdentifier` for why not a number. */
  readonly gtin: number;
}[] = [
  { size: '41', color: 'black', commercialColor: 'Jet Black', colorway: 'Jet Black / Ember', width: 'standard', gtin: 1 },
  { size: '41', color: 'blue', commercialColor: 'Cobalt', colorway: 'Cobalt Rush', width: 'standard', gtin: 2 },
  { size: '42', color: 'black', commercialColor: 'Jet Black', colorway: 'Jet Black / Ember', width: 'standard', gtin: 3 },
  { size: '42', color: 'black', commercialColor: 'Jet Black', colorway: 'Jet Black / Ember', width: 'wide', gtin: 4 },
  { size: '42', color: 'blue', commercialColor: 'Cobalt', colorway: 'Cobalt Rush', width: 'standard', gtin: 5 },
  { size: '43', color: 'black', commercialColor: 'Jet Black', colorway: 'Jet Black / Ember', width: 'standard', gtin: 6 },
  { size: '43', color: 'black', commercialColor: 'Jet Black', colorway: 'Jet Black / Ember', width: 'wide', gtin: 7 },
  { size: '43', color: 'blue', commercialColor: 'Cobalt', colorway: 'Cobalt Rush', width: 'standard', gtin: 8 },
];

/**
 * The four `Trailwind 3` combinations the axes describe and the package does
 * NOT seed — stated as a value so the sparse-matrix test asserts against a list
 * rather than against arithmetic it does itself.
 */
export const TRAILWIND_ABSENT_COMBINATIONS: readonly {
  readonly size: string;
  readonly color: string;
  readonly width: string;
}[] = [
  { size: '41', color: 'black', width: 'wide' },
  { size: '41', color: 'blue', width: 'wide' },
  { size: '42', color: 'blue', width: 'wide' },
  { size: '43', color: 'blue', width: 'wide' },
];

/** The axes `Trailwind 3` varies along, in declaration order. */
export const TRAILWIND_AXES = ['shoe_size_eu', 'footwear_color', 'shoe_width'] as const;

function trailwindVariant(entry: (typeof TRAILWIND_MATRIX)[number]) {
  const chart = KESTREL_MENS_CHART[entry.size];
  return {
    key: `trailwind-${entry.size}-${entry.color}-${entry.width}`,
    options: [
      { key: 'shoe_size_eu', value: entry.size },
      { key: 'footwear_color', value: entry.color },
      { key: 'shoe_width', value: entry.width },
    ],
    identifiers: [{ kind: 'namespaced_gtin' as const, scheme: 'ean' as const, seed: entry.gtin }],
    facts: [
      { attributeKey: 'shoe_size_us_mens', displayValue: chart.us },
      { attributeKey: 'shoe_size_uk', displayValue: chart.uk },
      { attributeKey: 'shoe_size_cm', displayValue: chart.cm },
      { attributeKey: 'footwear_color', displayValue: entry.commercialColor, sourceField: 'colour' },
      { attributeKey: 'footwear_colorway', displayValue: entry.colorway },
    ],
  };
}

const FJORD_MATRIX: readonly {
  readonly size: keyof typeof NORDVIK_MENS_CHART;
  readonly color: string;
  readonly commercialColor: string;
  readonly colorway: string;
}[] = [
  { size: '41', color: 'black', commercialColor: 'Midnight', colorway: 'Midnight Onyx' },
  { size: '41', color: 'white', commercialColor: 'Glacier', colorway: 'Glacier White' },
  { size: '42', color: 'black', commercialColor: 'Midnight', colorway: 'Midnight Onyx' },
  { size: '42', color: 'white', commercialColor: 'Glacier', colorway: 'Glacier White' },
];

const AURORA_MATRIX: readonly {
  readonly size: keyof typeof KESTREL_WOMENS_CHART;
  readonly color: string;
  readonly commercialColor: string;
  readonly colorway: string;
}[] = [
  { size: '38', color: 'black', commercialColor: 'Jet Black', colorway: 'Jet Black / Rose' },
  { size: '38', color: 'red', commercialColor: 'Coral', colorway: 'Coral Dawn' },
  { size: '39', color: 'black', commercialColor: 'Jet Black', colorway: 'Jet Black / Rose' },
  { size: '39', color: 'red', commercialColor: 'Coral', colorway: 'Coral Dawn' },
];

export const FOOTWEAR_PACKAGE: VerticalPackage = {
  name: 'footwear',
  title: 'Athletic footwear',
  proves:
    'That four size systems and two audiences coexist without a conversion table, that a ' +
    'commercial colorway and a colour family are different facts, and that a three-axis ' +
    'variant matrix can be genuinely sparse.',
  sourceName: 'footwear reference package',

  categories: [
    {
      // `shoes` and not `footwear`: the namespace already leads every key, so a
      // root named for its own package produces `footwear.footwear`.
      key: 'shoes',
      name: 'Footwear',
      slug: 'footwear',
      parentKey: null,
      // STRUCTURAL. A shopper browses through it and no product may be filed
      // under it — `mercaria_category_assignment_selectable` refuses that at the
      // row, so "a department is not a shelf" is enforced rather than agreed.
      selectable: false,
      position: 0,
      localizations: [
        { locale: 'es', name: 'Calzado' },
        { locale: 'de', name: 'Schuhe' },
      ],
      aliases: [
        { locale: 'en', alias: 'shoes', kind: 'synonym' },
        { locale: 'es', alias: 'zapatos', kind: 'synonym' },
      ],
    },
    {
      key: 'athletic',
      name: 'Athletic footwear',
      slug: 'athletic-footwear',
      parentKey: 'shoes',
      selectable: false,
      position: 0,
      localizations: [
        { locale: 'es', name: 'Calzado deportivo' },
        { locale: 'de', name: 'Sportschuhe' },
      ],
      aliases: [{ locale: 'es', alias: 'zapatillas', kind: 'synonym' }],
    },
    {
      key: 'athletic.mens_running_shoes',
      name: "Men's running shoes",
      slug: 'mens-running-shoes',
      parentKey: 'athletic',
      selectable: true,
      position: 0,
      localizations: [
        { locale: 'es', name: 'Zapatillas de running de hombre' },
        { locale: 'de', name: 'Herren-Laufschuhe' },
      ],
      aliases: [
        { locale: 'es', alias: 'zapatillas de correr hombre', kind: 'search_term' },
        { locale: 'en', alias: 'mens trainers', kind: 'synonym' },
      ],
    },
    {
      key: 'athletic.womens_running_shoes',
      name: "Women's running shoes",
      slug: 'womens-running-shoes',
      parentKey: 'athletic',
      selectable: true,
      position: 1,
      localizations: [
        { locale: 'es', name: 'Zapatillas de running de mujer' },
        { locale: 'de', name: 'Damen-Laufschuhe' },
      ],
      aliases: [{ locale: 'es', alias: 'zapatillas de correr mujer', kind: 'search_term' }],
    },
  ],

  attributes: [
    {
      key: 'shoe_size_eu',
      label: 'EU size',
      description: 'Continental European shoe size, as printed on the box.',
      valueType: 'enum',
      variantDefining: true,
      hardConstraintCapable: true,
      categoryScopeKeys: ['shoes'],
      labels: [
        { locale: 'es', label: 'Talla EU' },
        { locale: 'de', label: 'EU-Größe' },
      ],
      enumValues: [
        { value: '38', label: '38' },
        { value: '39', label: '39' },
        { value: '40', label: '40' },
        { value: '41', label: '41' },
        { value: '42', label: '42' },
        { value: '43', label: '43' },
      ],
    },
    {
      // Scoped to the MEN'S category alone. That scope is the whole of "with
      // audience/department context": a women's listing's authoring schema and
      // a women's facet list cannot offer this key at all, so `9` here can
      // never be read beside `9` under the women's definition.
      key: 'shoe_size_us_mens',
      label: "US size (men's)",
      valueType: 'enum',
      variantDefining: false,
      hardConstraintCapable: true,
      categoryScopeKeys: ['athletic.mens_running_shoes'],
      labels: [{ locale: 'es', label: 'Talla US (hombre)' }],
      enumValues: [
        { value: '7', label: '7' },
        { value: '7.5', label: '7.5' },
        { value: '8', label: '8' },
        { value: '8.5', label: '8.5' },
        { value: '9', label: '9' },
        { value: '9.5', label: '9.5' },
      ],
    },
    {
      key: 'shoe_size_us_womens',
      label: "US size (women's)",
      valueType: 'enum',
      variantDefining: false,
      hardConstraintCapable: true,
      categoryScopeKeys: ['athletic.womens_running_shoes'],
      labels: [{ locale: 'es', label: 'Talla US (mujer)' }],
      enumValues: [
        { value: '6.5', label: '6.5' },
        { value: '7', label: '7' },
        { value: '7.5', label: '7.5' },
        { value: '8', label: '8' },
        { value: '8.5', label: '8.5' },
      ],
    },
    {
      key: 'shoe_size_uk',
      label: 'UK size',
      valueType: 'enum',
      variantDefining: false,
      hardConstraintCapable: true,
      categoryScopeKeys: ['shoes'],
      labels: [{ locale: 'es', label: 'Talla UK' }],
      enumValues: [
        { value: '5', label: '5' },
        { value: '5.5', label: '5.5' },
        { value: '6', label: '6' },
        { value: '6.5', label: '6.5' },
        { value: '7', label: '7' },
        { value: '7.5', label: '7.5' },
        { value: '8', label: '8' },
        { value: '8.5', label: '8.5' },
      ],
    },
    {
      // The MEASUREMENT BASIS, and the only size fact that is a physical
      // quantity. Stored in the family's base unit (mm) with the source's own
      // unit kept beside it, so `26.5 cm` and `265 mm` are one value and a
      // shopper who knows their foot length can compare across brands.
      key: 'shoe_size_cm',
      label: 'Foot length',
      valueType: 'measurement',
      unitFamily: 'length',
      decimalPlaces: 1,
      variantDefining: false,
      sortable: true,
      hardConstraintCapable: true,
      categoryScopeKeys: ['shoes'],
      labels: [{ locale: 'es', label: 'Longitud del pie' }],
    },
    {
      key: 'shoe_width',
      label: 'Width',
      valueType: 'enum',
      variantDefining: true,
      hardConstraintCapable: true,
      categoryScopeKeys: ['shoes'],
      labels: [{ locale: 'es', label: 'Ancho' }],
      enumValues: [
        { value: 'narrow', label: 'Narrow', aliases: ['b', 'slim'], localizations: [{ locale: 'es', label: 'Estrecho' }] },
        { value: 'standard', label: 'Standard', aliases: ['d', 'regular', 'medium'], localizations: [{ locale: 'es', label: 'Estándar' }] },
        { value: 'wide', label: 'Wide', aliases: ['2e', 'ee'], localizations: [{ locale: 'es', label: 'Ancho' }] },
        { value: 'extra_wide', label: 'Extra wide', aliases: ['4e', 'eeee'], localizations: [{ locale: 'es', label: 'Extra ancho' }] },
      ],
    },
    {
      // The normalized COLOUR FAMILY. Its aliases carry the commercial names,
      // so a feed writing `Jet Black` lands on `black` while
      // `canonical_attribute_values.source_display_value` keeps the words the
      // source used. The commercial name itself is `footwear_colorway`, a
      // separate unfiltered fact — because a filter over marketing strings is
      // an unbounded facet, which is the failure this pair exists to prevent.
      key: 'footwear_color',
      label: 'Colour',
      valueType: 'enum',
      variantDefining: true,
      hardConstraintCapable: true,
      categoryScopeKeys: ['shoes'],
      labels: [
        { locale: 'es', label: 'Color' },
        { locale: 'de', label: 'Farbe' },
      ],
      enumValues: [
        {
          value: 'black',
          label: 'Black',
          aliases: ['jet black', 'midnight', 'onyx', 'negro', 'schwarz'],
          localizations: [
            { locale: 'es', label: 'Negro' },
            { locale: 'de', label: 'Schwarz' },
          ],
        },
        {
          value: 'blue',
          label: 'Blue',
          aliases: ['cobalt', 'navy', 'azul'],
          localizations: [
            { locale: 'es', label: 'Azul' },
            { locale: 'de', label: 'Blau' },
          ],
        },
        {
          value: 'white',
          label: 'White',
          aliases: ['glacier', 'blanco'],
          localizations: [{ locale: 'es', label: 'Blanco' }],
        },
        {
          value: 'red',
          label: 'Red',
          aliases: ['coral', 'rojo'],
          localizations: [{ locale: 'es', label: 'Rojo' }],
        },
        {
          value: 'grey',
          label: 'Grey',
          aliases: ['gray', 'gris'],
          localizations: [{ locale: 'es', label: 'Gris' }],
        },
      ],
    },
    {
      key: 'footwear_colorway',
      label: 'Colourway',
      description: "The manufacturer's own name for this exact colour treatment.",
      valueType: 'string',
      variantDefining: false,
      // NOT filterable, deliberately. A colourway is a marketing string with
      // unbounded cardinality; offering it as a facet produces one bucket per
      // product and reads as a filter that does not work.
      filterable: false,
      comparable: false,
      categoryScopeKeys: ['shoes'],
      labels: [{ locale: 'es', label: 'Combinación de color' }],
    },
    {
      key: 'upper_material',
      label: 'Upper material',
      valueType: 'enum',
      variantDefining: false,
      hardConstraintCapable: true,
      categoryScopeKeys: ['shoes'],
      labels: [{ locale: 'es', label: 'Material del empeine' }],
      enumValues: [
        { value: 'mesh', label: 'Engineered mesh', aliases: ['malla'], localizations: [{ locale: 'es', label: 'Malla' }] },
        { value: 'knit', label: 'Knit', aliases: ['punto'] },
        { value: 'leather', label: 'Leather', aliases: ['piel', 'cuero'] },
        { value: 'synthetic', label: 'Synthetic', aliases: ['sintetico', 'sintético'] },
      ],
    },
    {
      key: 'shoe_weight',
      label: 'Weight',
      valueType: 'measurement',
      unitFamily: 'mass',
      variantDefining: false,
      sortable: true,
      categoryScopeKeys: ['shoes'],
      labels: [{ locale: 'es', label: 'Peso' }],
    },
  ],

  productTypes: [
    {
      key: 'athletic_footwear',
      version: 1,
      name: 'Athletic footwear',
      description:
        'A running or training shoe: a size axis, a colour axis, a width axis, and the ' +
        'other size systems recorded as facts about each configuration.',
      categoryScopeKeys: ['shoes'],
      groups: [
        { key: 'configuration', label: 'Configuration', position: 0 },
        { key: 'sizing', label: 'Sizing', position: 1 },
        { key: 'specification', label: 'Specification', position: 2 },
      ],
      fields: [
        // The three AXES. `variantCapable: true` requires `scope: 'variant'`
        // and an attribute outside `PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS`,
        // both by CHECK.
        { attributeKey: 'shoe_size_eu', groupKey: 'configuration', scope: 'variant', flow: 'merchant', requirement: 'required', valuePolicy: 'controlled_value', variantCapable: true, position: 0 },
        { attributeKey: 'footwear_color', groupKey: 'configuration', scope: 'variant', flow: 'merchant', requirement: 'required', valuePolicy: 'controlled_value', variantCapable: true, position: 1 },
        { attributeKey: 'shoe_width', groupKey: 'configuration', scope: 'variant', flow: 'merchant', requirement: 'recommended', valuePolicy: 'controlled_value', variantCapable: true, position: 2 },
        { attributeKey: 'footwear_colorway', groupKey: 'configuration', scope: 'variant', flow: 'merchant', requirement: 'optional', valuePolicy: 'typed_scalar', position: 3 },
        // The other size systems: variant-scoped FACTS, never axes.
        { attributeKey: 'shoe_size_us_mens', groupKey: 'sizing', scope: 'variant', flow: 'merchant', requirement: 'optional', valuePolicy: 'controlled_value', position: 0 },
        { attributeKey: 'shoe_size_us_womens', groupKey: 'sizing', scope: 'variant', flow: 'merchant', requirement: 'optional', valuePolicy: 'controlled_value', position: 1 },
        { attributeKey: 'shoe_size_uk', groupKey: 'sizing', scope: 'variant', flow: 'merchant', requirement: 'optional', valuePolicy: 'controlled_value', position: 2 },
        { attributeKey: 'shoe_size_cm', groupKey: 'sizing', scope: 'variant', flow: 'merchant', requirement: 'recommended', valuePolicy: 'typed_scalar', position: 3 },
        { attributeKey: 'upper_material', groupKey: 'specification', scope: 'product', flow: 'merchant', requirement: 'recommended', valuePolicy: 'controlled_value', position: 0 },
        { attributeKey: 'shoe_weight', groupKey: 'specification', scope: 'product', flow: 'merchant', requirement: 'optional', valuePolicy: 'typed_scalar', position: 1 },
        // The P2P flow asks for LESS. Scope, `variantCapable` and value policy
        // must agree with the merchant flow — `mercaria_product_type_field_citation`
        // refuses a disagreement — so only the REQUIREMENT differs, which is
        // exactly the axis a flow is allowed to vary.
        { attributeKey: 'shoe_size_eu', groupKey: 'configuration', scope: 'variant', flow: 'p2p', requirement: 'required', valuePolicy: 'controlled_value', variantCapable: true, position: 0 },
        { attributeKey: 'footwear_color', groupKey: 'configuration', scope: 'variant', flow: 'p2p', requirement: 'required', valuePolicy: 'controlled_value', variantCapable: true, position: 1 },
        { attributeKey: 'shoe_width', groupKey: 'configuration', scope: 'variant', flow: 'p2p', requirement: 'optional', valuePolicy: 'controlled_value', variantCapable: true, position: 2 },
      ],
      localizations: [
        { locale: 'es', name: 'Calzado deportivo', description: 'Zapatilla de running o de entrenamiento.' },
        { locale: 'de', name: 'Sportschuhe' },
      ],
    },
  ],

  brands: [
    {
      key: 'kestrel',
      name: 'Kestrel',
      slug: 'kestrel',
      aliases: [{ alias: 'Kestrel Running', kind: 'name_variant', language: 'en' }],
    },
    { key: 'nordvik', name: 'Nordvik', slug: 'nordvik' },
  ],

  families: [
    { key: 'trailwind', name: 'Trailwind', slug: 'trailwind', brandKey: 'kestrel', categoryKey: 'athletic.mens_running_shoes' },
    { key: 'fjord', name: 'Fjord', slug: 'fjord', brandKey: 'nordvik', categoryKey: 'athletic.mens_running_shoes' },
  ],

  products: [
    {
      key: 'trailwind_3',
      name: 'Kestrel Trailwind 3',
      slug: 'kestrel-trailwind-3',
      brandKey: 'kestrel',
      familyKey: 'trailwind',
      categoryKey: 'athletic.mens_running_shoes',
      variantAxisKeys: ['shoe_size_eu', 'footwear_color', 'shoe_width'],
      searchTokens: ['trailwind', 'zapatillas', 'running'],
      aliases: [
        { alias: 'Trailwind 3', kind: 'name_variant', language: 'en' },
        { alias: 'Zapatillas Trailwind 3', kind: 'localized_name', language: 'es' },
      ],
      modelYear: 2026,
      facts: [
        // `Malla` and not `Engineered mesh`: the alias map is keyed on the
        // canonical VALUE plus the declared aliases, never on the label, so an
        // observation of the label would be `unparsed` and store no typed
        // value. Observing the Spanish alias proves the path a feed in another
        // language actually takes.
        { attributeKey: 'upper_material', displayValue: 'Malla', sourceField: 'material' },
        { attributeKey: 'shoe_weight', displayValue: '268 g' },
      ],
      variants: TRAILWIND_MATRIX.map(trailwindVariant),
    },
    {
      key: 'fjord_runner',
      name: 'Nordvik Fjord Runner',
      slug: 'nordvik-fjord-runner',
      brandKey: 'nordvik',
      familyKey: 'fjord',
      categoryKey: 'athletic.mens_running_shoes',
      variantAxisKeys: ['shoe_size_eu', 'footwear_color'],
      searchTokens: ['fjord', 'runner'],
      modelYear: 2026,
      facts: [
        { attributeKey: 'upper_material', displayValue: 'knit' },
        { attributeKey: 'shoe_weight', displayValue: '285 g' },
      ],
      variants: FJORD_MATRIX.map((entry) => {
        const chart = NORDVIK_MENS_CHART[entry.size];
        return {
          key: `fjord-${entry.size}-${entry.color}`,
          options: [
            { key: 'shoe_size_eu', value: entry.size },
            { key: 'footwear_color', value: entry.color },
          ],
          facts: [
            { attributeKey: 'shoe_size_us_mens', displayValue: chart.us },
            { attributeKey: 'shoe_size_uk', displayValue: chart.uk },
            { attributeKey: 'shoe_size_cm', displayValue: chart.cm },
            { attributeKey: 'footwear_color', displayValue: entry.commercialColor, sourceField: 'colour' },
            { attributeKey: 'footwear_colorway', displayValue: entry.colorway },
          ],
        };
      }),
    },
    {
      key: 'aurora_glide',
      name: 'Kestrel Aurora Glide',
      slug: 'kestrel-aurora-glide',
      brandKey: 'kestrel',
      categoryKey: 'athletic.womens_running_shoes',
      variantAxisKeys: ['shoe_size_eu', 'footwear_color'],
      searchTokens: ['aurora', 'glide'],
      modelYear: 2026,
      facts: [
        { attributeKey: 'upper_material', displayValue: 'mesh' },
        { attributeKey: 'shoe_weight', displayValue: '221 g' },
      ],
      variants: AURORA_MATRIX.map((entry) => {
        const chart = KESTREL_WOMENS_CHART[entry.size];
        return {
          key: `aurora-${entry.size}-${entry.color}`,
          options: [
            { key: 'shoe_size_eu', value: entry.size },
            { key: 'footwear_color', value: entry.color },
          ],
          facts: [
            // The WOMEN'S system. This product's category is not in
            // `shoe_size_us_mens`'s scope, so a men's size is not merely absent
            // here — it is not offerable.
            { attributeKey: 'shoe_size_us_womens', displayValue: chart.us },
            { attributeKey: 'shoe_size_uk', displayValue: chart.uk },
            { attributeKey: 'shoe_size_cm', displayValue: chart.cm },
            { attributeKey: 'footwear_color', displayValue: entry.commercialColor, sourceField: 'colour' },
            { attributeKey: 'footwear_colorway', displayValue: entry.colorway },
          ],
        };
      }),
    },
  ],

  vehicleMakes: [],
  fitments: [],
  compatibilityClaims: [],

  expect: {
    categories: 4,
    attributes: 10,
    enumValues: 38,
    productTypes: 1,
    productTypeFields: 13,
    brands: 2,
    families: 2,
    products: 3,
    variants: 16,
    identifiers: 8,
    facts: 86,
    vehicleConfigurations: 0,
    fitments: 0,
    compatibilityClaims: 0,
  },
};
