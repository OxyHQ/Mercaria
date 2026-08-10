/**
 * The in-memory attribute registry the benchmark runs against (#95
 * "Evaluation").
 *
 * #58's benchmark runs "against an in-memory catalogue so the whole set runs in
 * CI on every push, sharing scoring and the policy with production byte for
 * byte and simplifying only RETRIEVAL", and this is the same decision one layer
 * over: the interpreter under test is the PRODUCTION one, reading production
 * `ResolvedAttributeDefinition` objects through the production unit table. What
 * is simplified is where the definitions come from — this file rather than
 * `attribute_definitions` — because a benchmark that needs a database is a
 * benchmark that does not run on every push, and one that does not run on every
 * push is one that goes stale between the times somebody remembers it.
 *
 * The definitions are the launch categories #94's own fixture catalogue covers,
 * so a case written here means the same thing a case written there does. They
 * are deliberately NOT imported from that file: #94's fixtures exist to
 * exercise NORMALIZATION (mixed units, scale errors, conflicting sources) and
 * these exist to exercise INTERPRETATION, and coupling them would make a change
 * to one silently move the other's thresholds.
 */

import type { AttributeValueType, UnitFamily } from '@mercaria/shared-types';
import type { ResolvedAttributeDefinition } from '../../attributes/definition-registry.service.js';

/** The fields a benchmark definition actually varies. Everything else is fixed. */
interface DefinitionSpec {
  readonly key: string;
  readonly label: string;
  readonly valueType: AttributeValueType;
  readonly unitFamily?: UnitFamily;
  readonly baseUnit?: string;
  readonly hardConstraintCapable?: boolean;
  readonly enumValues?: readonly { readonly value: string; readonly label: string; readonly aliases?: readonly string[] }[];
  /** Localized labels, so the label-matching pass is exercised in more than one language. */
  readonly labels?: readonly { readonly locale: string; readonly label: string }[];
}

const EPOCH = new Date('2026-01-01T00:00:00.000Z');

/**
 * One resolved definition, with every column a row carries.
 *
 * Written out rather than spread from a partial, because a missing column here
 * would be `undefined` at a place production has a value — and the failure would
 * be a benchmark measuring an interpreter reading a definition that cannot
 * exist, which is the shape of a measurement that proves nothing.
 */
function definition(spec: DefinitionSpec): ResolvedAttributeDefinition {
  return {
    row: {
      id: `def-${spec.key}`,
      key: spec.key,
      version: 1,
      lifecycleState: 'active',
      label: spec.label,
      description: null,
      valueType: spec.valueType,
      cardinality: 'single',
      objectivity: 'objective',
      unitFamily: spec.unitFamily ?? null,
      baseUnit: spec.baseUnit ?? null,
      ratingScaleMax: null,
      currency: null,
      componentAxes: [],
      minValue: null,
      maxValue: null,
      decimalPlaces: null,
      maxLength: null,
      implausibleAbove: null,
      implausibleBelow: null,
      variantDefining: false,
      filterable: true,
      sortable: false,
      comparable: true,
      hardConstraintCapable: spec.hardConstraintCapable ?? true,
      displayPolicy: 'public',
      evidencePolicy: 'source_required',
      createdByOxyUserId: 'benchmark',
      publishedByOxyUserId: 'benchmark',
      publishedAt: EPOCH,
      deprecatedAt: null,
      createdAt: EPOCH,
      updatedAt: EPOCH,
    },
    enumValues: (spec.enumValues ?? []).map((value, index) => ({
      id: `enum-${spec.key}-${index}`,
      attributeDefinitionId: `def-${spec.key}`,
      value: value.value,
      label: value.label,
      position: index,
      createdAt: EPOCH,
      updatedAt: EPOCH,
    })),
    aliases: new Map(
      (spec.enumValues ?? []).flatMap((value) =>
        (value.aliases ?? []).map((alias) => [alias.toLowerCase(), value.value] as const),
      ),
    ),
    categoryScopes: [],
    labels: (spec.labels ?? []).map((label) => ({ locale: label.locale, label: label.label })),
  };
}

/**
 * The LAPTOPS registry — three length attributes on purpose.
 *
 * `screen_size`, `width` and `depth` all live in the `length` family, which is
 * what makes `14 inches` genuinely ambiguous when nothing names one of them.
 * That ambiguity is the case `attribute_disambiguation` exists for, and a
 * registry with one length attribute could not exercise it — the benchmark
 * would report a clarification precision of 1 against a question that never
 * needed asking.
 */
export const BENCHMARK_LAPTOP_DEFINITIONS: readonly ResolvedAttributeDefinition[] = [
  definition({
    key: 'ram',
    label: 'Memory',
    valueType: 'measurement',
    unitFamily: 'digital_storage',
    baseUnit: 'B',
    labels: [
      { locale: 'es', label: 'memoria' },
      { locale: 'de', label: 'Arbeitsspeicher' },
    ],
  }),
  definition({
    key: 'storage',
    label: 'Storage',
    valueType: 'measurement',
    unitFamily: 'digital_storage',
    baseUnit: 'B',
    labels: [
      { locale: 'es', label: 'almacenamiento' },
      { locale: 'de', label: 'Speicher' },
    ],
  }),
  definition({
    key: 'screen_size',
    label: 'Screen size',
    valueType: 'measurement',
    unitFamily: 'length',
    baseUnit: 'mm',
    labels: [
      { locale: 'es', label: 'pantalla' },
      { locale: 'de', label: 'Bildschirm' },
    ],
  }),
  definition({
    key: 'width',
    label: 'Width',
    valueType: 'measurement',
    unitFamily: 'length',
    baseUnit: 'mm',
  }),
  definition({
    key: 'depth',
    label: 'Depth',
    valueType: 'measurement',
    unitFamily: 'length',
    baseUnit: 'mm',
  }),
  definition({
    key: 'weight',
    label: 'Weight',
    valueType: 'measurement',
    unitFamily: 'mass',
    baseUnit: 'g',
    labels: [{ locale: 'es', label: 'peso' }],
  }),
  definition({
    key: 'port_type',
    label: 'Port',
    valueType: 'enum',
    enumValues: [
      { value: 'usb_c', label: 'USB-C', aliases: ['usb c', 'usbc', 'type c'] },
      { value: 'thunderbolt', label: 'Thunderbolt', aliases: ['tb4'] },
      { value: 'hdmi', label: 'HDMI' },
    ],
  }),
  definition({
    key: 'backlit_keyboard',
    label: 'Backlit keyboard',
    valueType: 'boolean',
    hardConstraintCapable: false,
  }),
];

/**
 * The PHONES registry — a battery capacity nobody may hard-constrain.
 *
 * `battery_capacity` is `hardConstraintCapable: false`, and that is the case
 * the "unsupported attribute" class exercises: a shopper CAN ask for it, the
 * interpreter DOES understand it, and #94 refuses to let it exclude anything —
 * so the correct behaviour is a preference plus a visible report, and the
 * benchmark measures that rather than a silent hard constraint.
 */
export const BENCHMARK_PHONE_DEFINITIONS: readonly ResolvedAttributeDefinition[] = [
  definition({
    key: 'storage',
    label: 'Storage',
    valueType: 'measurement',
    unitFamily: 'digital_storage',
    baseUnit: 'B',
    labels: [{ locale: 'es', label: 'almacenamiento' }],
  }),
  definition({
    key: 'screen_size',
    label: 'Screen size',
    valueType: 'measurement',
    unitFamily: 'length',
    baseUnit: 'mm',
    labels: [{ locale: 'es', label: 'pantalla' }],
  }),
  definition({
    key: 'battery_capacity',
    label: 'Battery capacity',
    valueType: 'measurement',
    unitFamily: 'electric_charge',
    baseUnit: 'mAh',
    hardConstraintCapable: false,
    labels: [{ locale: 'es', label: 'bateria' }],
  }),
];

/** Every registry the dataset addresses, by the key a case names. */
export const BENCHMARK_REGISTRIES: Readonly<
  Record<string, readonly ResolvedAttributeDefinition[]>
> = Object.freeze({
  laptops: BENCHMARK_LAPTOP_DEFINITIONS,
  smartphones: BENCHMARK_PHONE_DEFINITIONS,
  // The unscoped registry is the UNION, which is what a query with no category
  // context actually reads against — and it is what makes `14 inches` ambiguous
  // in the unscoped cases and unambiguous in the laptop-scoped ones, from the
  // same query text. That contrast is the point of having it.
  none: [...BENCHMARK_LAPTOP_DEFINITIONS, ...BENCHMARK_PHONE_DEFINITIONS],
});
