/**
 * The SMARTPHONE reference vertical (#367 Workstream 14).
 *
 * ## What this package exists to prove
 *
 * That the line between a VARIANT AXIS and a TYPED FACT is drawn by the model
 * and not by whoever fills the form. A phone has about thirty published
 * properties and exactly three of them are things a buyer chooses between:
 * storage, colour and the regional model. The other twenty-seven are facts
 * about the product, identical across every configuration, and a catalogue that
 * lets a merchant declare "chipset" an option produces one variant per spec
 * sheet line and a variant selector nobody can use.
 *
 * The package therefore declares three axes and ten facts, and
 * `verticals-smartphone.realdb.test.ts` asserts that a typed fact is REFUSED as
 * an axis — by `assessVariantAxis`, by `product_type_fields_variant_axis_check`
 * and by `mercaria_native_variant_axis_citation`, which reads the definition's
 * own `variant_defining` flag.
 *
 * ## The brand → family → product → variant chain
 *
 * Four levels, four tables, and each edge is a real foreign key rather than a
 * naming convention: `brands.id` ← `canonical_product_families.brand_id` ←
 * `canonical_products.family_id` ← `canonical_variants.product_id`. `Lumira`
 * is the brand, `Axon` the family, `Axon 9 Pro` the product, and
 * `256 GB / Black / EU` the variant. The family is what makes "show me every
 * Axon" answerable without matching on a name prefix.
 *
 * ## Localized search aliases
 *
 * `mobile`, `móvil` and `celular` are three words for one thing and a Spanish
 * shopper types the middle one. THREE mechanisms carry them and they are read
 * by DIFFERENT retrieval stages against DIFFERENTLY FOLDED queries, which is
 * the detail that makes a naive fixture fail:
 *
 * - **`category_aliases`** is matched by the deterministic search-intent
 *   interpreter on an ACCENT-FOLDED word-boundary comparison, so `móvil` is
 *   stored folded (`normalizeCatalogAlias`, applied by `apply.ts`) and a query
 *   with or without the accent finds it. Unlike the two below it names a
 *   CATEGORY rather than a product, which is what #367's
 *   "resolve translated category terms to stable IDs" asks for.
 *
 * - **`canonical_product_aliases`** is matched by the exact-alias stage on
 *   `normalizeAliasLookup(query)` — trim and lowercase, and **no accent
 *   folding**. So `móvil` must be stored WITH its accent or the query `móvil`
 *   will not find it. It is also a WHOLE-QUERY match: `móvil lumira` reaches no
 *   alias.
 * - **`canonical_products.search_tokens`** is matched by the discriminating-token
 *   stage on `normalizeEntityName(query)`, which DOES fold accents. So the same
 *   word is stored there accent-FOLDED (`movil`), and must be five characters
 *   or carry a digit to count as discriminating.
 *
 * Both are seeded, and the test asserts each independently with the alias
 * removed as its control — because a query that matches the canonical NAME
 * would pass either way and prove nothing about the alias.
 *
 * ## What is deliberately not modelled
 *
 * `connectivity` as one bag. The epic names connectivity among the typed facts,
 * and the tempting shape is a `set`-cardinality enum holding
 * `{5g, wifi_6e, nfc}`. It is refused here: those are three questions with
 * three different answer types (a cellular generation, a wifi standard, a
 * boolean), and a bag cannot be filtered, compared or constrained on any one of
 * them. Three definitions is more rows and strictly more answerable.
 */

import type { VerticalPackage } from './types.js';

const AXON_MATRIX: readonly {
  readonly storage: string;
  readonly color: string;
  readonly region: string;
  readonly gtin: number;
}[] = [
  { storage: '256 GB', color: 'black', region: 'eu', gtin: 1 },
  { storage: '256 GB', color: 'black', region: 'us', gtin: 2 },
  { storage: '256 GB', color: 'blue', region: 'eu', gtin: 3 },
  { storage: '256 GB', color: 'blue', region: 'us', gtin: 4 },
  { storage: '512 GB', color: 'black', region: 'eu', gtin: 5 },
  { storage: '512 GB', color: 'black', region: 'us', gtin: 6 },
  { storage: '512 GB', color: 'blue', region: 'eu', gtin: 7 },
  { storage: '512 GB', color: 'blue', region: 'us', gtin: 8 },
];

/**
 * Kaido's storage is spelled WITHOUT a space, on purpose.
 *
 * `storage_capacity` is a `measurement`, so `normalizeOption` runs it through
 * `normalizeQuantity` and stores the base-unit magnitude: `256GB` and
 * `256 GB` become the same axis value, on two different products, with no
 * mapping table between them. That is the `Color`/`Colour`/`color ` duplication
 * this epic exists to end, in the one place a merchant is most likely to
 * introduce it — and it is why storage is a measurement rather than an enum.
 */
const VERO_MATRIX: readonly {
  readonly storage: string;
  readonly color: string;
  readonly mpn: string;
}[] = [
  { storage: '128GB', color: 'black', mpn: 'KV5-128-BLK' },
  { storage: '128GB', color: 'white', mpn: 'KV5-128-WHT' },
  { storage: '256GB', color: 'black', mpn: 'KV5-256-BLK' },
  { storage: '256GB', color: 'white', mpn: 'KV5-256-WHT' },
];

/** The ten facts every phone in this package publishes. Values differ; the shape does not. */
function phoneFacts(values: {
  readonly screen: string;
  readonly refresh: string;
  readonly chipset: string;
  readonly ram: string;
  readonly battery: string;
  readonly port: string;
  readonly dimensions: string;
  readonly cellular: string;
  readonly wifi: string;
  readonly nfc: string;
}) {
  return [
    { attributeKey: 'screen_size', displayValue: values.screen },
    { attributeKey: 'screen_refresh_rate', displayValue: values.refresh },
    { attributeKey: 'chipset', displayValue: values.chipset, sourceField: 'processor' },
    { attributeKey: 'ram_capacity', displayValue: values.ram },
    { attributeKey: 'battery_capacity', displayValue: values.battery },
    { attributeKey: 'charging_port', displayValue: values.port },
    // ONE declaration, THREE rows: a structured value writes one
    // `canonical_attribute_values` row per declared component axis, each with
    // its own `component_axis` and `position`. `deriveExpectation` counts it
    // that way rather than as one, so the census stays exact.
    { attributeKey: 'device_dimensions', displayValue: values.dimensions },
    { attributeKey: 'cellular_generation', displayValue: values.cellular },
    { attributeKey: 'wifi_standard', displayValue: values.wifi },
    { attributeKey: 'nfc', displayValue: values.nfc },
  ];
}

export const SMARTPHONE_PACKAGE: VerticalPackage = {
  name: 'smartphone',
  title: 'Smartphones',
  proves:
    'That storage, colour and regional model are variant axes while screen, chipset, RAM, ' +
    'battery, ports, dimensions and connectivity are typed facts that cannot become axes; ' +
    'and that a Spanish shopper typing "móvil" finds the same product an English shopper ' +
    'finds typing "mobile".',
  sourceName: 'smartphone reference package',

  categories: [
    {
      key: 'electronics',
      name: 'Electronics',
      slug: 'electronics',
      parentKey: null,
      selectable: false,
      position: 0,
      localizations: [
        { locale: 'es', name: 'Electrónica' },
        { locale: 'de', name: 'Elektronik' },
      ],
      aliases: [],
    },
    {
      key: 'phones',
      name: 'Phones',
      slug: 'phones',
      parentKey: 'electronics',
      selectable: false,
      position: 0,
      localizations: [
        { locale: 'es', name: 'Teléfonos' },
        { locale: 'de', name: 'Telefone' },
      ],
      aliases: [],
    },
    {
      // ADR 0007's own worked example: `electronics.phones.smartphones`.
      key: 'phones.smartphones',
      name: 'Smartphones',
      slug: 'smartphones',
      parentKey: 'phones',
      selectable: true,
      position: 0,
      localizations: [
        { locale: 'es', name: 'Teléfonos móviles' },
        { locale: 'de', name: 'Smartphones' },
        { locale: 'fr', name: 'Téléphones mobiles' },
      ],
      // Regional vocabulary as CATEGORY aliases, READ by the deterministic
      // interpreter since #732: `plan.service.ts` looks the query's own word
      // runs up in `category_aliases` and hands the hits to
      // `interpretDeterministically`, which prefers them over the shipped
      // colloquialism dictionary.
      //
      // This list is where epic #367's "support aliases `mobile`, `móvil`,
      // `celular`, `smartphone`" actually holds, and it is deliberately here
      // rather than in `CATEGORY_COLLOQUIALISMS`. That dictionary's own
      // population is "the words no product name contains" — `smartphone` is
      // in half the product names in this package and IS the category's slug,
      // so adding it there would contradict the table's stated purpose. More
      // importantly a colloquialism entry names a SLUG, which is a
      // per-deployment fact: recording the word beside the category that
      // creates the slug means the two are written in one place and cannot
      // disagree.
      //
      // SINGULARS as well as plurals, because `mobile` and `smartphone` are
      // what #367 names by hand and the match is on a whole word — the plural
      // does not cover the singular. `benchmark/registry.ts` mirrors these and
      // `benchmark.test.ts` fails the build if the two stop agreeing.
      aliases: [
        { locale: 'en', alias: 'mobile', kind: 'synonym' },
        { locale: 'en', alias: 'mobiles', kind: 'synonym' },
        { locale: 'en', alias: 'mobile phone', kind: 'synonym' },
        { locale: 'en', alias: 'mobile phones', kind: 'synonym' },
        { locale: 'en', alias: 'cell phone', kind: 'synonym' },
        { locale: 'en', alias: 'cell phones', kind: 'synonym' },
        { locale: 'en', alias: 'smartphone', kind: 'search_term' },
        { locale: 'en', alias: 'smartphones', kind: 'search_term' },
        { locale: 'es', alias: 'móvil', kind: 'synonym' },
        { locale: 'es', alias: 'móviles', kind: 'synonym' },
        { locale: 'es', alias: 'celular', kind: 'synonym' },
        { locale: 'es', alias: 'celulares', kind: 'synonym' },
        { locale: 'es-mx', alias: 'celular', kind: 'synonym' },
        { locale: 'es-mx', alias: 'celulares', kind: 'synonym' },
      ],
    },
  ],

  attributes: [
    {
      // A MEASUREMENT axis, not an enum. See `VERO_MATRIX` for why.
      key: 'storage_capacity',
      label: 'Storage',
      valueType: 'measurement',
      unitFamily: 'digital_storage',
      variantDefining: true,
      sortable: true,
      hardConstraintCapable: true,
      categoryScopeKeys: ['phones.smartphones'],
      labels: [
        { locale: 'es', label: 'Almacenamiento' },
        { locale: 'de', label: 'Speicher' },
      ],
    },
    {
      key: 'phone_color',
      label: 'Colour',
      valueType: 'enum',
      variantDefining: true,
      hardConstraintCapable: true,
      categoryScopeKeys: ['phones.smartphones'],
      labels: [{ locale: 'es', label: 'Color' }],
      enumValues: [
        { value: 'black', label: 'Black', aliases: ['negro', 'midnight'], localizations: [{ locale: 'es', label: 'Negro' }] },
        { value: 'blue', label: 'Blue', aliases: ['azul'], localizations: [{ locale: 'es', label: 'Azul' }] },
        { value: 'white', label: 'White', aliases: ['blanco'], localizations: [{ locale: 'es', label: 'Blanco' }] },
        { value: 'titanium_grey', label: 'Titanium grey', aliases: ['gris titanio'], localizations: [{ locale: 'es', label: 'Gris titanio' }] },
      ],
    },
    {
      // A REAL axis: the EU and US models carry different cellular bands and are
      // not interchangeable, so they are different buyable things. It is here
      // because it is genuinely variation, not because "region" sounds like a
      // dimension — a market a product is merely SOLD in belongs to the offer.
      key: 'device_region',
      label: 'Regional model',
      valueType: 'enum',
      variantDefining: true,
      hardConstraintCapable: true,
      categoryScopeKeys: ['phones.smartphones'],
      labels: [{ locale: 'es', label: 'Modelo regional' }],
      enumValues: [
        { value: 'eu', label: 'European model', aliases: ['europe', 'europa'] },
        { value: 'us', label: 'North American model', aliases: ['usa', 'north america'] },
        { value: 'apac', label: 'Asia-Pacific model', aliases: ['asia'] },
      ],
    },

    /* ------------------------------- typed facts ------------------------- */
    {
      key: 'screen_size',
      label: 'Screen size',
      valueType: 'measurement',
      unitFamily: 'length',
      decimalPlaces: 2,
      variantDefining: false,
      sortable: true,
      hardConstraintCapable: true,
      categoryScopeKeys: ['phones.smartphones'],
      labels: [{ locale: 'es', label: 'Tamaño de pantalla' }],
    },
    {
      key: 'screen_refresh_rate',
      label: 'Refresh rate',
      valueType: 'measurement',
      unitFamily: 'frequency',
      variantDefining: false,
      sortable: true,
      hardConstraintCapable: true,
      categoryScopeKeys: ['phones.smartphones'],
      labels: [{ locale: 'es', label: 'Frecuencia de refresco' }],
    },
    {
      key: 'chipset',
      label: 'Chipset',
      valueType: 'enum',
      variantDefining: false,
      hardConstraintCapable: true,
      categoryScopeKeys: ['phones.smartphones'],
      labels: [{ locale: 'es', label: 'Procesador' }],
      enumValues: [
        { value: 'snapdragon_8_gen_4', label: 'Snapdragon 8 Gen 4', aliases: ['snapdragon 8 gen 4', 'sd 8 gen 4'] },
        { value: 'dimensity_9400', label: 'Dimensity 9400', aliases: ['dimensity 9400', 'mediatek dimensity 9400'] },
        { value: 'exynos_2500', label: 'Exynos 2500', aliases: ['exynos 2500'] },
      ],
    },
    {
      key: 'ram_capacity',
      label: 'RAM',
      valueType: 'measurement',
      unitFamily: 'digital_storage',
      variantDefining: false,
      sortable: true,
      hardConstraintCapable: true,
      categoryScopeKeys: ['phones.smartphones'],
      labels: [{ locale: 'es', label: 'Memoria RAM' }],
    },
    {
      key: 'battery_capacity',
      label: 'Battery',
      valueType: 'measurement',
      unitFamily: 'electric_charge',
      variantDefining: false,
      sortable: true,
      hardConstraintCapable: true,
      categoryScopeKeys: ['phones.smartphones'],
      labels: [{ locale: 'es', label: 'Batería' }],
    },
    {
      key: 'charging_port',
      label: 'Charging port',
      valueType: 'enum',
      variantDefining: false,
      hardConstraintCapable: true,
      categoryScopeKeys: ['phones.smartphones'],
      labels: [{ locale: 'es', label: 'Puerto de carga' }],
      enumValues: [
        { value: 'usb_c', label: 'USB-C', aliases: ['usb-c', 'usb c', 'type-c'] },
        { value: 'lightning', label: 'Lightning', aliases: ['lightning'] },
      ],
    },
    {
      // The dimensions, with their axes named and ORDERED. `height x width x
      // depth` is the order a spec sheet writes and the order the components are
      // read back in; a structured value whose component count disagrees with
      // the declaration is `unparsed` in every axis rather than partially read.
      key: 'device_dimensions',
      label: 'Dimensions',
      valueType: 'structured',
      unitFamily: 'length',
      componentAxes: ['height', 'width', 'depth'],
      decimalPlaces: 1,
      variantDefining: false,
      categoryScopeKeys: ['phones.smartphones'],
      labels: [{ locale: 'es', label: 'Dimensiones' }],
    },
    {
      key: 'cellular_generation',
      label: 'Cellular',
      valueType: 'enum',
      variantDefining: false,
      hardConstraintCapable: true,
      categoryScopeKeys: ['phones.smartphones'],
      labels: [{ locale: 'es', label: 'Red móvil' }],
      enumValues: [
        { value: '4g', label: '4G LTE', aliases: ['lte', '4g lte'] },
        { value: '5g', label: '5G', aliases: ['5 g'] },
      ],
    },
    {
      key: 'wifi_standard',
      label: 'Wi-Fi',
      valueType: 'enum',
      variantDefining: false,
      hardConstraintCapable: true,
      categoryScopeKeys: ['phones.smartphones'],
      labels: [{ locale: 'es', label: 'Wi-Fi' }],
      enumValues: [
        // Both spellings, because both are what a spec sheet writes and the
        // alias map is an EXACT lookup on the folded string — `wi-fi 7` and
        // `wifi 7` are two keys and neither implies the other.
        { value: 'wifi_5', label: 'Wi-Fi 5', aliases: ['wifi 5', 'wi-fi 5', '802.11ac'] },
        { value: 'wifi_6', label: 'Wi-Fi 6', aliases: ['wifi 6', 'wi-fi 6', '802.11ax'] },
        { value: 'wifi_6e', label: 'Wi-Fi 6E', aliases: ['wifi 6e', 'wi-fi 6e'] },
        { value: 'wifi_7', label: 'Wi-Fi 7', aliases: ['wifi 7', 'wi-fi 7', '802.11be'] },
      ],
    },
    {
      key: 'nfc',
      label: 'NFC',
      valueType: 'boolean',
      variantDefining: false,
      hardConstraintCapable: true,
      categoryScopeKeys: ['phones.smartphones'],
      labels: [{ locale: 'es', label: 'NFC' }],
    },
  ],

  productTypes: [
    {
      key: 'smartphone',
      version: 1,
      name: 'Smartphone',
      description:
        'A mobile handset: storage, colour and regional model vary; everything else is a ' +
        'fact about the model.',
      categoryScopeKeys: ['phones.smartphones'],
      groups: [
        { key: 'configuration', label: 'Configuration', position: 0 },
        { key: 'display', label: 'Display', position: 1 },
        { key: 'performance', label: 'Performance', position: 2 },
        { key: 'connectivity', label: 'Connectivity', position: 3 },
        { key: 'physical', label: 'Physical', position: 4 },
      ],
      fields: [
        { attributeKey: 'storage_capacity', groupKey: 'configuration', scope: 'variant', flow: 'merchant', requirement: 'required', valuePolicy: 'typed_scalar', variantCapable: true, position: 0 },
        { attributeKey: 'phone_color', groupKey: 'configuration', scope: 'variant', flow: 'merchant', requirement: 'required', valuePolicy: 'controlled_value', variantCapable: true, position: 1 },
        { attributeKey: 'device_region', groupKey: 'configuration', scope: 'variant', flow: 'merchant', requirement: 'recommended', valuePolicy: 'controlled_value', variantCapable: true, position: 2 },
        { attributeKey: 'screen_size', groupKey: 'display', scope: 'product', flow: 'merchant', requirement: 'required', valuePolicy: 'typed_scalar', position: 0 },
        { attributeKey: 'screen_refresh_rate', groupKey: 'display', scope: 'product', flow: 'merchant', requirement: 'recommended', valuePolicy: 'typed_scalar', position: 1 },
        { attributeKey: 'chipset', groupKey: 'performance', scope: 'product', flow: 'merchant', requirement: 'recommended', valuePolicy: 'controlled_value', position: 0 },
        { attributeKey: 'ram_capacity', groupKey: 'performance', scope: 'product', flow: 'merchant', requirement: 'recommended', valuePolicy: 'typed_scalar', position: 1 },
        { attributeKey: 'battery_capacity', groupKey: 'performance', scope: 'product', flow: 'merchant', requirement: 'optional', valuePolicy: 'typed_scalar', position: 2 },
        { attributeKey: 'charging_port', groupKey: 'connectivity', scope: 'product', flow: 'merchant', requirement: 'recommended', valuePolicy: 'controlled_value', position: 0 },
        { attributeKey: 'cellular_generation', groupKey: 'connectivity', scope: 'product', flow: 'merchant', requirement: 'recommended', valuePolicy: 'controlled_value', position: 1 },
        { attributeKey: 'wifi_standard', groupKey: 'connectivity', scope: 'product', flow: 'merchant', requirement: 'optional', valuePolicy: 'controlled_value', position: 2 },
        { attributeKey: 'nfc', groupKey: 'connectivity', scope: 'product', flow: 'merchant', requirement: 'optional', valuePolicy: 'typed_scalar', position: 3 },
        { attributeKey: 'device_dimensions', groupKey: 'physical', scope: 'product', flow: 'merchant', requirement: 'optional', valuePolicy: 'typed_structured', position: 0 },
        // The P2P flow: somebody selling their own phone knows its storage and
        // colour and will not know its refresh rate. `forbidden` is not
        // `hidden` — a forbidden field may carry no visibility rule and no
        // variant capability at all, by CHECK, so it cannot be re-enabled by a
        // condition somebody adds later.
        { attributeKey: 'storage_capacity', groupKey: 'configuration', scope: 'variant', flow: 'p2p', requirement: 'required', valuePolicy: 'typed_scalar', variantCapable: true, position: 0 },
        { attributeKey: 'phone_color', groupKey: 'configuration', scope: 'variant', flow: 'p2p', requirement: 'required', valuePolicy: 'controlled_value', variantCapable: true, position: 1 },
        { attributeKey: 'screen_refresh_rate', groupKey: 'display', scope: 'product', flow: 'p2p', requirement: 'forbidden', valuePolicy: 'typed_scalar', position: 0 },
      ],
      localizations: [
        { locale: 'es', name: 'Teléfono móvil', description: 'Un teléfono móvil: el almacenamiento, el color y el modelo regional varían.' },
        { locale: 'de', name: 'Smartphone' },
        { locale: 'fr', name: 'Téléphone mobile' },
      ],
    },
  ],

  brands: [
    {
      key: 'lumira',
      name: 'Lumira',
      slug: 'lumira',
      aliases: [{ alias: 'Lumira Mobile', kind: 'name_variant', language: 'en' }],
    },
    { key: 'kaido', name: 'Kaido', slug: 'kaido' },
  ],

  families: [
    { key: 'axon', name: 'Axon', slug: 'axon', brandKey: 'lumira', categoryKey: 'phones.smartphones' },
    { key: 'vero', name: 'Vero', slug: 'vero', brandKey: 'kaido', categoryKey: 'phones.smartphones' },
  ],

  products: [
    {
      key: 'axon_9_pro',
      name: 'Lumira Axon 9 Pro',
      slug: 'lumira-axon-9-pro',
      brandKey: 'lumira',
      familyKey: 'axon',
      categoryKey: 'phones.smartphones',
      variantAxisKeys: ['storage_capacity', 'phone_color', 'device_region'],
      // Accent-FOLDED, five characters or more. The lexical stage folds the
      // query the same way, so `movil` here answers a query for `móvil`.
      searchTokens: ['movil', 'celular', 'mobile', 'smartphone', 'telefono'],
      // Stored WITH accents. The alias stage does NOT fold them, so `móvil`
      // spelled without one would never answer the query a Spanish keyboard
      // produces.
      aliases: [
        { alias: 'Axon 9 Pro', kind: 'name_variant', language: 'en' },
        { alias: 'móvil Lumira Axon 9 Pro', kind: 'localized_name', language: 'es' },
        { alias: 'celular Lumira Axon 9 Pro', kind: 'localized_name', language: 'es-MX' },
        { alias: 'Lumira Axon 9 Pro mobile', kind: 'localized_name', language: 'en' },
      ],
      modelYear: 2026,
      facts: phoneFacts({
        screen: '6.7 in',
        refresh: '120 Hz',
        chipset: 'Snapdragon 8 Gen 4',
        ram: '12 GB',
        battery: '5000 mAh',
        port: 'USB-C',
        dimensions: '160.5 x 75.2 x 8.3 mm',
        cellular: '5G',
        wifi: 'Wi-Fi 7',
        nfc: 'yes',
      }),
      variants: AXON_MATRIX.map((entry) => ({
        key: `axon-${entry.storage.replace(/\s+/gu, '')}-${entry.color}-${entry.region}`,
        options: [
          { key: 'storage_capacity', value: entry.storage },
          { key: 'phone_color', value: entry.color },
          { key: 'device_region', value: entry.region },
        ],
        identifiers: [{ kind: 'namespaced_gtin' as const, scheme: 'ean' as const, seed: entry.gtin }],
      })),
    },
    {
      key: 'vero_5',
      name: 'Kaido Vero 5',
      slug: 'kaido-vero-5',
      brandKey: 'kaido',
      familyKey: 'vero',
      categoryKey: 'phones.smartphones',
      variantAxisKeys: ['storage_capacity', 'phone_color'],
      searchTokens: ['movil', 'celular', 'mobile', 'smartphone'],
      aliases: [{ alias: 'Vero 5', kind: 'name_variant', language: 'en' }],
      modelYear: 2026,
      facts: phoneFacts({
        screen: '6.4 in',
        refresh: '90 Hz',
        chipset: 'MediaTek Dimensity 9400',
        ram: '8 GB',
        battery: '4700 mAh',
        port: 'usb-c',
        dimensions: '155.1 x 72.0 x 7.9 mm',
        cellular: '5G',
        wifi: 'Wi-Fi 6E',
        nfc: 'yes',
      }),
      variants: VERO_MATRIX.map((entry) => ({
        key: `vero-${entry.storage}-${entry.color}`,
        options: [
          { key: 'storage_capacity', value: entry.storage },
          { key: 'phone_color', value: entry.color },
        ],
        identifiers: [{ kind: 'literal' as const, scheme: 'mpn' as const, rawValue: entry.mpn }],
      })),
    },
  ],

  vehicleMakes: [],
  fitments: [],
  compatibilityClaims: [],

  expect: {
    categories: 3,
    attributes: 13,
    enumValues: 18,
    productTypes: 1,
    productTypeFields: 16,
    brands: 2,
    families: 2,
    products: 2,
    variants: 12,
    identifiers: 12,
    // Ten declarations per product, of which `device_dimensions` writes three
    // rows: (9 + 3) x 2.
    facts: 24,
    vehicleConfigurations: 0,
    fitments: 0,
    compatibilityClaims: 0,
  },
};
