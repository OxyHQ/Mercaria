/**
 * The #94 benchmark dataset — representative fixtures for the launch
 * categories, and the backbone of this domain's tests.
 *
 * The issue asks for laptops, phones, headphones, PC components and cameras,
 * covering ten properties. Each is present here and each is LABELLED, so a test
 * that stops exercising one is visible rather than merely absent:
 *
 *  1. mixed units — `6.1 in` vs `155.6 mm`, `256GB` vs `0.256 TB`;
 *  2. missing values — `laptop-no-weight` records nothing for `weight`;
 *  3. conflicting values — two sources, equal standing, different RAM;
 *  4. variant-specific specifications — storage differs per variant, chassis
 *     does not;
 *  5. enum aliases — `USB C`, `usb-c`, `Type-C` all resolve to `usb_c`;
 *  6. ranges — `5-7 business days`, `0 – 35 °C`;
 *  7. regional model differences — a EU and a US variant of one phone whose
 *     charging port genuinely differs;
 *  8. source scale errors — a phone `2400000 mm` tall (micrometres in a
 *     millimetre field) and a `0.148` kg-shaped value in a gram field;
 *  9. hard and soft constraints — a set carrying both;
 * 10. invalid category-attribute combinations — `shutter_speed` asked of a
 *     laptop.
 *
 * ## Why the definitions are declared here rather than seeded from a JSON file
 *
 * They are the INPUT to `draftAttributeDefinition`, typed, so a change to the
 * registry's shape breaks this file at compile time rather than at the first
 * realdb run. A JSON fixture would have to be validated by the very code it is
 * meant to test.
 */

import type { AttributeComponentAxis } from '@mercaria/shared-types';
import type { DraftAttributeDefinitionInput } from '../../definition-registry.service.js';
import type { ResolvedAttributeDefinition } from '../../definition-registry.service.js';

/** The launch categories, as slugs the realdb fixtures mint categories for. */
export const BENCHMARK_CATEGORY_SLUGS = [
  'laptops',
  'phones',
  'headphones',
  'pc-components',
  'cameras',
] as const;

export type BenchmarkCategorySlug = (typeof BENCHMARK_CATEGORY_SLUGS)[number];

/** One definition to draft, with the categories it is scoped to by SLUG. */
export interface BenchmarkDefinition {
  readonly categories: readonly BenchmarkCategorySlug[];
  readonly definition: Omit<DraftAttributeDefinitionInput, 'actorOxyUserId' | 'categoryScopes'>;
}

/**
 * The launch attribute set.
 *
 * Deliberately small and deliberately typed across every value type and
 * cardinality the registry has: a benchmark that only exercised measurements
 * would leave the enum, boolean, range, money, date and structured paths
 * untested while looking thorough.
 */
export const BENCHMARK_DEFINITIONS: readonly BenchmarkDefinition[] = [
  {
    categories: ['laptops', 'phones', 'cameras'],
    definition: {
      key: 'screen_size',
      label: 'Screen size',
      valueType: 'measurement',
      unitFamily: 'length',
      cardinality: 'single',
      decimalPlaces: 1,
      minValue: 10,
      // No definitional maximum: a screen can be any size. 1.5 m is the
      // plausibility ceiling, so a micrometre-in-a-millimetre-field reading is
      // recorded as the SCALE ERROR it is rather than as an impossible value.
      implausibleAbove: 1_500,
      filterable: true,
      sortable: true,
      hardConstraintCapable: true,
    },
  },
  {
    categories: ['laptops', 'phones', 'pc-components'],
    definition: {
      key: 'ram_capacity',
      label: 'Memory',
      valueType: 'measurement',
      unitFamily: 'digital_storage',
      cardinality: 'single',
      filterable: true,
      sortable: true,
      hardConstraintCapable: true,
    },
  },
  {
    categories: ['laptops', 'phones'],
    definition: {
      key: 'storage_capacity',
      label: 'Storage',
      valueType: 'measurement',
      unitFamily: 'digital_storage',
      cardinality: 'single',
      variantDefining: true,
      filterable: true,
      sortable: true,
      hardConstraintCapable: true,
    },
  },
  {
    categories: ['laptops', 'phones', 'headphones', 'cameras'],
    definition: {
      key: 'weight',
      label: 'Weight',
      valueType: 'measurement',
      unitFamily: 'mass',
      cardinality: 'single',
      decimalPlaces: 0,
      // A 0.148 g phone is a kilogram value in a gram field, and a 50 kg one is
      // a milligram value. Both are recorded and neither is shown (#94 coverage
      // rule 5).
      implausibleBelow: 1,
      implausibleAbove: 50_000,
      filterable: true,
      sortable: true,
      hardConstraintCapable: true,
    },
  },
  {
    categories: ['laptops', 'phones'],
    definition: {
      key: 'charging_port',
      label: 'Charging port',
      valueType: 'enum',
      cardinality: 'single',
      filterable: true,
      hardConstraintCapable: true,
      enumValues: [
        { value: 'usb_c', label: 'USB-C', aliases: ['USB C', 'usb-c', 'Type-C', 'USB Type C'] },
        { value: 'lightning', label: 'Lightning', aliases: ['Apple Lightning'] },
        { value: 'micro_usb', label: 'Micro-USB', aliases: ['micro usb', 'microUSB'] },
      ],
    },
  },
  {
    categories: ['laptops'],
    definition: {
      key: 'ports',
      label: 'Ports',
      valueType: 'enum',
      // A SET: a laptop has several, and membership is the only question.
      cardinality: 'set',
      filterable: true,
      hardConstraintCapable: true,
      enumValues: [
        { value: 'usb_c', label: 'USB-C', aliases: ['USB C', 'usb-c', 'Type-C'] },
        { value: 'usb_a', label: 'USB-A', aliases: ['USB A', 'usb-a'] },
        { value: 'hdmi', label: 'HDMI', aliases: ['hdmi 2.1'] },
        { value: 'headphone_jack', label: '3.5 mm jack', aliases: ['3.5mm', 'audio jack'] },
      ],
    },
  },
  {
    categories: ['laptops', 'phones', 'headphones', 'cameras'],
    definition: {
      key: 'water_resistant',
      label: 'Water resistant',
      valueType: 'boolean',
      cardinality: 'single',
      filterable: true,
      hardConstraintCapable: true,
    },
  },
  {
    categories: ['laptops', 'phones', 'cameras'],
    definition: {
      key: 'dimensions',
      label: 'Dimensions',
      valueType: 'structured',
      // Each component is a LENGTH, so the definition carries the family every
      // axis normalizes into — the same declaration a `measurement` makes.
      unitFamily: 'length',
      // The axis ORDER is declared, so "155.6 x 71.5 x 8.25 mm" is three named
      // facts rather than three numbers a reader has to guess about.
      componentAxes: ['height', 'width', 'depth'] as AttributeComponentAxis[],
      cardinality: 'ordered_list',
      filterable: true,
      hardConstraintCapable: true,
    },
  },
  {
    categories: ['laptops', 'phones', 'headphones'],
    definition: {
      key: 'battery_capacity',
      label: 'Battery capacity',
      valueType: 'measurement',
      unitFamily: 'electric_charge',
      cardinality: 'single',
      filterable: true,
      sortable: true,
    },
  },
  {
    categories: ['pc-components'],
    definition: {
      key: 'clock_speed',
      label: 'Clock speed',
      valueType: 'measurement',
      unitFamily: 'frequency',
      cardinality: 'single',
      filterable: true,
      sortable: true,
      hardConstraintCapable: true,
    },
  },
  {
    categories: ['cameras'],
    definition: {
      key: 'sensor_resolution',
      label: 'Sensor resolution',
      valueType: 'measurement',
      unitFamily: 'pixel_count',
      cardinality: 'single',
      filterable: true,
      sortable: true,
      hardConstraintCapable: true,
    },
  },
  {
    categories: ['cameras'],
    definition: {
      key: 'shutter_speed',
      label: 'Shutter speed',
      valueType: 'measurement',
      unitFamily: 'duration',
      cardinality: 'range',
      filterable: true,
    },
  },
  {
    categories: ['laptops', 'phones', 'headphones', 'pc-components', 'cameras'],
    definition: {
      key: 'warranty_period',
      label: 'Warranty',
      valueType: 'measurement',
      unitFamily: 'duration',
      cardinality: 'range',
      filterable: true,
    },
  },
  {
    categories: ['headphones'],
    definition: {
      key: 'noise_cancelling',
      label: 'Active noise cancelling',
      valueType: 'boolean',
      cardinality: 'single',
      filterable: true,
      hardConstraintCapable: true,
    },
  },
  {
    categories: ['laptops', 'phones', 'headphones', 'pc-components', 'cameras'],
    definition: {
      key: 'msrp',
      label: 'Manufacturer suggested price',
      // A MONEY attribute, and a legitimate one: an MSRP is a fact about the
      // product. It is NOT the offer price — that key is reserved and the
      // registry refuses to define it (#94 hard-constraint rule 6).
      valueType: 'money',
      currency: 'EUR',
      cardinality: 'single',
      filterable: true,
      sortable: true,
    },
  },
  {
    categories: ['laptops', 'phones', 'headphones', 'pc-components', 'cameras'],
    definition: {
      key: 'release_date',
      label: 'Release date',
      valueType: 'date',
      cardinality: 'single',
      filterable: true,
      sortable: true,
    },
  },
  {
    categories: ['laptops', 'phones', 'headphones', 'cameras'],
    definition: {
      key: 'build_material',
      label: 'Build material',
      valueType: 'string',
      cardinality: 'single',
      maxLength: 120,
      // OBJECTIVE, so the marketing-claim refusal applies: "premium quality
      // aluminium" is not a material (#94 coverage rule 6).
      objectivity: 'objective',
      filterable: true,
    },
  },
  {
    categories: ['laptops', 'phones', 'headphones', 'cameras'],
    definition: {
      key: 'editorial_style',
      label: 'Editorial style note',
      valueType: 'string',
      cardinality: 'single',
      // SUBJECTIVE, so adjectives are allowed — that is what the field is for,
      // and it may never be a hard constraint.
      objectivity: 'subjective',
      filterable: false,
      hardConstraintCapable: false,
      comparable: false,
    },
  },
  {
    categories: ['laptops', 'pc-components'],
    definition: {
      key: 'core_count',
      label: 'CPU cores',
      valueType: 'integer',
      cardinality: 'single',
      minValue: 1,
      maxValue: 512,
      filterable: true,
      sortable: true,
      hardConstraintCapable: true,
    },
  },
  {
    categories: ['laptops', 'phones'],
    definition: {
      key: 'screen_to_body',
      label: 'Screen-to-body ratio',
      valueType: 'measurement',
      // A PERCENTAGE, which is its own unit family: it can never be compared
      // against a rating or a plain ratio (#94 normalization rule 8).
      unitFamily: 'percentage',
      cardinality: 'single',
      decimalPlaces: 1,
      filterable: true,
    },
  },
];

/**
 * A hydrated definition, built without a database.
 *
 * The pure normalization and evaluation tests take
 * {@link ResolvedAttributeDefinition} rather than a row id, so they need a way
 * to construct one. Everything not named falls back to the registry's own
 * defaults, so a fixture states only what it is exercising.
 */
export function fixtureDefinition(
  input: BenchmarkDefinition['definition'],
  overrides: { version?: number; lifecycleState?: 'draft' | 'active' | 'deprecated' | 'retired' } = {},
): ResolvedAttributeDefinition {
  const enumValues = (input.enumValues ?? []).map((value, position) => ({
    id: `enum-${input.key}-${value.value}`,
    attributeDefinitionId: `def-${input.key}`,
    value: value.value,
    label: value.label,
    position,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }));

  const aliases = new Map<string, string>();
  for (const value of input.enumValues ?? []) {
    aliases.set(value.value, value.value);
    for (const alias of value.aliases ?? []) {
      aliases.set(alias.trim().replace(/\s+/gu, ' ').toLowerCase(), value.value);
    }
  }

  return {
    row: {
      id: `def-${input.key}`,
      key: input.key,
      version: overrides.version ?? 1,
      lifecycleState: overrides.lifecycleState ?? 'active',
      label: input.label,
      description: input.description ?? null,
      valueType: input.valueType,
      cardinality: input.cardinality ?? 'single',
      objectivity: input.objectivity ?? 'objective',
      unitFamily: input.unitFamily ?? null,
      baseUnit: input.unitFamily === undefined ? null : BASE_UNIT_BY_FAMILY[input.unitFamily],
      ratingScaleMax: input.ratingScaleMax ?? null,
      currency: input.currency ?? null,
      componentAxes: input.componentAxes ?? [],
      minValue: input.minValue ?? null,
      maxValue: input.maxValue ?? null,
      decimalPlaces: input.decimalPlaces ?? null,
      maxLength: input.maxLength ?? null,
      implausibleAbove: input.implausibleAbove ?? null,
      implausibleBelow: input.implausibleBelow ?? null,
      variantDefining: input.variantDefining ?? false,
      filterable: input.filterable ?? true,
      sortable: input.sortable ?? false,
      comparable: input.comparable ?? true,
      hardConstraintCapable: input.hardConstraintCapable ?? false,
      displayPolicy: input.displayPolicy ?? 'public',
      evidencePolicy: input.evidencePolicy ?? 'source_required',
      createdByOxyUserId: null,
      publishedByOxyUserId: null,
      publishedAt: overrides.lifecycleState === 'draft' ? null : new Date(0),
      deprecatedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    enumValues,
    aliases,
    categoryScopes: [],
    labels: [],
  };
}

/** The one place a fixture learns a family's base unit, mirroring `units.ts`. */
const BASE_UNIT_BY_FAMILY: Readonly<Record<string, string>> = {
  length: 'mm',
  mass: 'g',
  volume: 'ml',
  digital_storage: 'B',
  duration: 's',
  power: 'W',
  energy: 'Wh',
  frequency: 'Hz',
  data_rate: 'bit_s',
  pixel_count: 'px',
  luminance: 'cd_m2',
  electric_charge: 'mAh',
  count: 'count',
  percentage: 'pct',
  ratio: 'ratio',
  rating: 'rating_point',
};

/** Look one benchmark definition up by key, for a test that needs exactly one. */
export function benchmarkDefinition(key: string): BenchmarkDefinition['definition'] {
  const found = BENCHMARK_DEFINITIONS.find((entry) => entry.definition.key === key);
  if (!found) throw new Error(`No benchmark definition for '${key}'.`);
  return found.definition;
}

/** A hydrated benchmark definition, by key. The common case in a pure test. */
export function benchmarkResolved(key: string): ResolvedAttributeDefinition {
  return fixtureDefinition(benchmarkDefinition(key));
}

/**
 * The source observations the benchmark exercises, each labelled with the issue
 * property it covers.
 *
 * `expected` is the NORMALIZATION STATE the pipeline must reach, not a value:
 * asserting the state is what pins "a refusal is a first-class outcome", and a
 * fixture list that only carried happy-path values would pass against a
 * pipeline that guessed.
 */
export interface BenchmarkObservation {
  readonly property: string;
  readonly attributeKey: string;
  readonly displayValue: string;
  readonly expected:
    | 'normalized'
    | 'unknown_unit'
    | 'unparsed'
    | 'out_of_range'
    | 'implausible'
    | 'marketing_claim';
  /** The base-unit magnitude expected, when the fixture normalizes to one. */
  readonly baseMagnitude?: number;
  /** The canonical text expected, for an enum or string. */
  readonly normalizedText?: string;
  /** For a range: both bounds. */
  readonly range?: readonly [number, number];
  /** A per-source mapping's declared unit, where the fixture needs one. */
  readonly assumedUnit?: string;
}

export const BENCHMARK_OBSERVATIONS: readonly BenchmarkObservation[] = [
  // 1. Mixed units — two spellings of one fact, and they must agree.
  { property: 'mixed units', attributeKey: 'screen_size', displayValue: '6.1 in', expected: 'normalized', baseMagnitude: 154.94 },
  { property: 'mixed units', attributeKey: 'screen_size', displayValue: '154.94 mm', expected: 'normalized', baseMagnitude: 154.94 },
  { property: 'mixed units', attributeKey: 'storage_capacity', displayValue: '256GB', expected: 'normalized', baseMagnitude: 256_000_000_000 },
  { property: 'mixed units', attributeKey: 'storage_capacity', displayValue: '0.256 TB', expected: 'normalized', baseMagnitude: 256_000_000_000 },
  // Decimal and binary storage prefixes are NOT the same unit.
  { property: 'mixed units', attributeKey: 'storage_capacity', displayValue: '256 GiB', expected: 'normalized', baseMagnitude: 274_877_906_944 },

  // 5. Enum aliases — every spelling resolves, and the source text survives.
  { property: 'enum aliases', attributeKey: 'charging_port', displayValue: 'USB C', expected: 'normalized', normalizedText: 'usb_c' },
  { property: 'enum aliases', attributeKey: 'charging_port', displayValue: 'Type-C', expected: 'normalized', normalizedText: 'usb_c' },
  { property: 'enum aliases', attributeKey: 'charging_port', displayValue: 'usb-c', expected: 'normalized', normalizedText: 'usb_c' },
  { property: 'enum aliases', attributeKey: 'charging_port', displayValue: 'Barrel jack', expected: 'unparsed' },

  // 6. Ranges — inclusive bounds, both ends kept.
  { property: 'ranges', attributeKey: 'warranty_period', displayValue: '1-3 years', expected: 'unknown_unit' },
  { property: 'ranges', attributeKey: 'warranty_period', displayValue: '365-1095 d', expected: 'normalized', range: [31_536_000, 94_608_000] },
  { property: 'ranges', attributeKey: 'warranty_period', displayValue: '7 to 30 d', expected: 'normalized', range: [604_800, 2_592_000] },
  // An inverted interval is refused, never reordered.
  { property: 'ranges', attributeKey: 'warranty_period', displayValue: '30-7 d', expected: 'unknown_unit' },

  // 8. Source scale errors — recorded, never shown.
  { property: 'scale errors', attributeKey: 'screen_size', displayValue: '2400000 mm', expected: 'implausible' },
  { property: 'scale errors', attributeKey: 'weight', displayValue: '0.148 g', expected: 'implausible' },
  { property: 'scale errors', attributeKey: 'weight', displayValue: '148 g', expected: 'normalized', baseMagnitude: 148 },

  // 2. Ambiguity: a bare number is NEVER given a unit by inference…
  { property: 'no inferred unit', attributeKey: 'weight', displayValue: '148', expected: 'unparsed' },
  // …but a RECORDED per-source mapping supplies one.
  { property: 'no inferred unit', attributeKey: 'weight', displayValue: '148', expected: 'normalized', baseMagnitude: 148, assumedUnit: 'g' },

  // Cross-family refusal: a mass is not a screen size.
  { property: 'cross-family refusal', attributeKey: 'screen_size', displayValue: '6 kg', expected: 'unknown_unit' },
  // An unknown token is a taxonomy gap, not a guess.
  { property: 'unknown unit', attributeKey: 'screen_size', displayValue: '12 parsecs', expected: 'unknown_unit' },

  // 10. Marketing claims never become objective attributes.
  { property: 'marketing claim', attributeKey: 'build_material', displayValue: 'Premium quality aluminium', expected: 'marketing_claim' },
  { property: 'marketing claim', attributeKey: 'build_material', displayValue: 'Aluminium', expected: 'normalized', normalizedText: 'aluminium' },
  // The same words on a SUBJECTIVE attribute are the point of the field.
  { property: 'marketing claim', attributeKey: 'editorial_style', displayValue: 'Premium quality finish', expected: 'normalized', normalizedText: 'premium quality finish' },

  // Typed refusals that a looser parser would coerce.
  { property: 'typed refusal', attributeKey: 'core_count', displayValue: '8.5', expected: 'unparsed' },
  { property: 'typed refusal', attributeKey: 'core_count', displayValue: '8', expected: 'normalized', baseMagnitude: 8 },
  { property: 'typed refusal', attributeKey: 'core_count', displayValue: '9000', expected: 'out_of_range' },
  { property: 'typed refusal', attributeKey: 'release_date', displayValue: '03/04/2026', expected: 'unparsed' },
  { property: 'typed refusal', attributeKey: 'release_date', displayValue: '2026-04-03', expected: 'normalized' },
  { property: 'typed refusal', attributeKey: 'msrp', displayValue: '1199.00 USD', expected: 'unparsed' },
  { property: 'typed refusal', attributeKey: 'msrp', displayValue: '1199.00 EUR', expected: 'normalized' },
  { property: 'typed refusal', attributeKey: 'water_resistant', displayValue: 'yes', expected: 'normalized' },
  // The truthy NON-boolean fixture: a loose `Boolean(value)` reading makes the
  // string "false" TRUE, and every fixture written as a real boolean would pass
  // against that bug (AGENTS.md rule E).
  { property: 'typed refusal', attributeKey: 'water_resistant', displayValue: 'false', expected: 'normalized' },
  { property: 'typed refusal', attributeKey: 'water_resistant', displayValue: 'maybe', expected: 'unparsed' },
  { property: 'typed refusal', attributeKey: 'water_resistant', displayValue: 'IPX7', expected: 'unparsed' },

  // Dimensionless families never convert into one another.
  { property: 'dimensionless', attributeKey: 'screen_to_body', displayValue: '87.5 %', expected: 'normalized', baseMagnitude: 87.5 },
  { property: 'dimensionless', attributeKey: 'screen_to_body', displayValue: '87.5 mm', expected: 'unknown_unit' },
];
