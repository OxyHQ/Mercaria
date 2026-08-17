/**
 * The AUTOMOTIVE BRAKE-PAD reference vertical (#367 Workstream 14).
 *
 * ## What this package exists to prove
 *
 * One sentence: **a part that fits many vehicles is ONE buyable thing.**
 *
 * The failure it is written against is the one every parts catalogue that grew
 * out of a clothing catalogue commits — modelling fitment as a variant axis. It
 * looks reasonable for a week. Then a pad that fits four hundred vehicles is
 * four hundred variants; the variant selector is a vehicle picker wearing the
 * wrong control; the same physical part has four hundred SKUs, four hundred
 * stock counts and four hundred price rows; and merging two of them is
 * impossible because they were never the same row.
 *
 * So `Voltek VP-4410` declares **zero variant axes**. It has exactly one
 * canonical variant — the default one `createCanonicalProduct` mints when the
 * axis list is empty — and its applicability to thirteen vehicle configurations
 * is eleven rows in `automotive_fitments`, a table in a different domain.
 *
 * ## What stops the other modelling, structurally
 *
 * Four independent walls, none of them a convention:
 *
 * 1. `PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS` — a CHECK on
 *    `product_type_fields` and another on `native_listing_variant_axes`,
 *    rendered from one tuple that names `vehicle_make`, `vehicle_model`,
 *    `vehicle_generation`, `vehicle_configuration`, `year_range`, `fitment` and
 *    seven more.
 * 2. `product_type_fields_variant_axis_check` also requires `scope = 'variant'`
 *    — so a field at `scope: 'compatibility'` can NEVER be `variant_capable`,
 *    whatever it is called. This package declares one such field on purpose,
 *    because that wall holds for a key nobody thought to forbid, which the
 *    exact-match list does not.
 * 3. `mercaria_native_variant_axis_citation` reads the DEFINITION's own
 *    `variant_defining` flag, which defaults to false.
 * 4. `compatibility-isolation.test.ts` fails the build if any module in the
 *    compatibility domain so much as names an option table, and scans the
 *    option writers for the reverse edge.
 *
 * ## Overlapping generations, regional configurations, ambiguous engines
 *
 * All three are in the fixture rather than described in a comment:
 *
 * - **Overlapping generations.** BMW's F30 runs 2012–2019 and the G20 2018–2026;
 *   VW's Mk7 2012–2020 and the Mk8 2019–2026. A model year alone therefore
 *   cannot select a generation, which is why a year is a property of a
 *   CONFIGURATION and never a variant option.
 * - **Regional configurations.** The F30 320d exists as an EU car and a US car;
 *   the package fits the pad to the generation and then EXCLUDES the US
 *   configuration. An exclusion is not a special row — it is an ordinary
 *   fitment at a narrower scope with `applicability: 'does_not_apply'`, and
 *   `resolveFitment`'s narrowest-scope-wins rule is the whole mechanism.
 * - **Ambiguous engine names.** Two `compatibility_claims` rows carry a
 *   supplier's own words — `"fits BMW 320d"` and `"fits Golf 2019"` — and stay
 *   `unresolved` with `ambiguous_target`. Both are genuinely ambiguous against
 *   this fixture, and resolving either by picking one would be a false merge
 *   nobody could see. The raw text is frozen by
 *   `mercaria_compatibility_claims_raw_freeze`, so the evidence survives
 *   whatever a reviewer later decides.
 *
 * ## Why the positive fitments are `verified` and the exclusion is not
 *
 * `answerFitment` publishes a POSITIVE fit only from `POSITIVE_VERIFICATIONS`
 * (`verified` alone) and a NEGATIVE one from `NEGATIVE_VERIFICATIONS`
 * (`verified`, `candidate`, `disputed`). The asymmetry is deliberate and this
 * package exercises it: an unverified claim that a pad FITS is withheld, and an
 * unverified claim that it does NOT fit bites immediately.
 */

import type { VerticalPackage } from './types.js';

/** The manufacturer's fitment sheet, hashed once so the digest is a constant. */
const FITMENT_SHEET_DIGEST = '4f9b2c1d7e3a5068b4c2d9f1a7e35082c6d4b8f0a2e79c135b8d0f6a4c2e18b3';
const FITMENT_SHEET_URL = 'https://example.invalid/voltek/fitment/vp-4410.pdf';

export const BRAKE_PAD_PACKAGE: VerticalPackage = {
  name: 'brake_pad',
  title: 'Automotive brake pads',
  proves:
    'That one SKU fits many vehicles without becoming many variants: a product with ZERO ' +
    'variant axes, one canonical variant, and eleven fitment statements that answer for ' +
    'thirteen vehicle configurations across overlapping generations, two markets and an ' +
    'exclusion.',
  sourceName: 'brake pad reference package',

  categories: [
    {
      key: 'automotive',
      name: 'Automotive',
      slug: 'automotive',
      parentKey: null,
      selectable: false,
      position: 0,
      localizations: [
        { locale: 'es', name: 'Automoción' },
        { locale: 'de', name: 'Kraftfahrzeuge' },
      ],
      aliases: [{ locale: 'es', alias: 'coches', kind: 'synonym' }],
    },
    {
      key: 'braking',
      name: 'Braking',
      slug: 'braking',
      parentKey: 'automotive',
      selectable: false,
      position: 0,
      localizations: [
        { locale: 'es', name: 'Frenos' },
        { locale: 'de', name: 'Bremsen' },
      ],
      aliases: [],
    },
    {
      key: 'braking.brake_pads',
      name: 'Brake pads',
      slug: 'brake-pads',
      parentKey: 'braking',
      selectable: true,
      position: 0,
      localizations: [
        { locale: 'es', name: 'Pastillas de freno' },
        { locale: 'de', name: 'Bremsbeläge' },
      ],
      aliases: [
        { locale: 'es', alias: 'pastillas de freno', kind: 'search_term' },
        { locale: 'en', alias: 'brake shoes', kind: 'misspelling' },
      ],
    },
  ],

  attributes: [
    {
      key: 'brake_pad_material',
      label: 'Friction material',
      valueType: 'enum',
      variantDefining: false,
      hardConstraintCapable: true,
      categoryScopeKeys: ['braking.brake_pads'],
      labels: [{ locale: 'es', label: 'Material de fricción' }],
      enumValues: [
        { value: 'ceramic', label: 'Ceramic', aliases: ['ceramica', 'cerámica'], localizations: [{ locale: 'es', label: 'Cerámica' }] },
        { value: 'organic', label: 'Organic (NAO)', aliases: ['nao', 'organico', 'orgánico'] },
        { value: 'semi_metallic', label: 'Semi-metallic', aliases: ['semi metallic', 'semimetalico'] },
        { value: 'low_metallic', label: 'Low-metallic', aliases: ['low metallic'] },
        { value: 'sintered', label: 'Sintered', aliases: ['sinterizado'] },
      ],
    },
    {
      // A property of the PART — which end of the car it is made for — and not
      // of any vehicle. `automotive_fitments.position` carries where a
      // particular fitment puts it, which is a different fact: the same pad may
      // be a front pad on one car and unavailable on another.
      key: 'axle_position',
      label: 'Axle',
      valueType: 'enum',
      variantDefining: false,
      hardConstraintCapable: true,
      categoryScopeKeys: ['braking.brake_pads'],
      labels: [{ locale: 'es', label: 'Eje' }],
      enumValues: [
        { value: 'front', label: 'Front axle', aliases: ['delantero', 'front axle'], localizations: [{ locale: 'es', label: 'Eje delantero' }] },
        { value: 'rear', label: 'Rear axle', aliases: ['trasero', 'rear axle'], localizations: [{ locale: 'es', label: 'Eje trasero' }] },
      ],
    },
    {
      key: 'pad_dimensions',
      label: 'Dimensions',
      valueType: 'structured',
      unitFamily: 'length',
      componentAxes: ['height', 'width', 'depth'],
      decimalPlaces: 1,
      variantDefining: false,
      categoryScopeKeys: ['braking.brake_pads'],
      labels: [{ locale: 'es', label: 'Dimensiones' }],
    },
    {
      key: 'pack_count',
      label: 'Pieces per pack',
      valueType: 'integer',
      minValue: 1,
      maxValue: 16,
      variantDefining: false,
      sortable: true,
      hardConstraintCapable: true,
      categoryScopeKeys: ['braking.brake_pads'],
      labels: [{ locale: 'es', label: 'Piezas por paquete' }],
    },
    {
      key: 'wear_indicator',
      label: 'Wear indicator',
      valueType: 'boolean',
      variantDefining: false,
      hardConstraintCapable: true,
      categoryScopeKeys: ['braking.brake_pads'],
      labels: [{ locale: 'es', label: 'Testigo de desgaste' }],
    },
    {
      key: 'homologation',
      label: 'Homologation',
      valueType: 'enum',
      variantDefining: false,
      hardConstraintCapable: true,
      categoryScopeKeys: ['braking.brake_pads'],
      labels: [{ locale: 'es', label: 'Homologación' }],
      enumValues: [
        { value: 'ece_r90', label: 'ECE R90', aliases: ['r90', 'ece-r90'] },
        { value: 'none', label: 'Not homologated', aliases: ['sin homologacion'] },
      ],
    },
    {
      // The COMPATIBILITY-scoped field. It exists to prove wall 2 in the header:
      // `product_type_fields_variant_axis_check` refuses `variant_capable` on
      // anything whose scope is not `variant`, so this can never become an axis
      // even though its key is nowhere in the forbidden list. The fitment DATA
      // lives in `automotive_fitments`; this records the manufacturer's own
      // reference for the sheet that fitment was read from.
      key: 'fitment_reference',
      label: "Manufacturer's fitment reference",
      valueType: 'string',
      variantDefining: false,
      // `filterable` is left at the registry's default of TRUE, deliberately.
      // An operator tracing a fitment sheet legitimately filters on it — and
      // more to the point, it is what makes the facet refusal MEAN something:
      // the facet domain suppresses a `compatibility`-scoped field for its
      // SCOPE, even when the registry says the attribute is filterable.
      // Marking it unfilterable would suppress it for the boring reason and
      // leave the scope wall untested.
      comparable: false,
      categoryScopeKeys: ['braking.brake_pads'],
      labels: [{ locale: 'es', label: 'Referencia de aplicación del fabricante' }],
    },
  ],

  productTypes: [
    {
      key: 'brake_pad',
      version: 1,
      name: 'Brake pad set',
      description:
        'A disc brake pad set. Nothing about a vehicle is an axis: the part is one buyable ' +
        'thing and its applicability is a relationship.',
      categoryScopeKeys: ['braking.brake_pads'],
      groups: [
        { key: 'specification', label: 'Specification', position: 0 },
        { key: 'packaging', label: 'Packaging', position: 1 },
        { key: 'fitment', label: 'Fitment', position: 2 },
      ],
      fields: [
        { attributeKey: 'brake_pad_material', groupKey: 'specification', scope: 'product', flow: 'merchant', requirement: 'required', valuePolicy: 'controlled_value', position: 0 },
        { attributeKey: 'axle_position', groupKey: 'specification', scope: 'product', flow: 'merchant', requirement: 'required', valuePolicy: 'controlled_value', position: 1 },
        { attributeKey: 'pad_dimensions', groupKey: 'specification', scope: 'product', flow: 'merchant', requirement: 'recommended', valuePolicy: 'typed_structured', position: 2 },
        { attributeKey: 'homologation', groupKey: 'specification', scope: 'product', flow: 'merchant', requirement: 'recommended', valuePolicy: 'controlled_value', position: 3 },
        { attributeKey: 'wear_indicator', groupKey: 'specification', scope: 'product', flow: 'merchant', requirement: 'optional', valuePolicy: 'typed_scalar', position: 4 },
        { attributeKey: 'pack_count', groupKey: 'packaging', scope: 'product', flow: 'merchant', requirement: 'required', valuePolicy: 'typed_scalar', position: 0 },
        // scope `compatibility`. `variantCapable` is false and the CHECK makes
        // true unreachable — see the header.
        { attributeKey: 'fitment_reference', groupKey: 'fitment', scope: 'compatibility', flow: 'merchant', requirement: 'recommended', valuePolicy: 'typed_scalar', position: 0 },
        // A CONNECTOR importing a supplier feed knows the material and the pack
        // count and rarely publishes a homologation. Scope and value policy
        // agree with the merchant flow, as the citation trigger requires; only
        // the requirement moves.
        { attributeKey: 'brake_pad_material', groupKey: 'specification', scope: 'product', flow: 'connector', requirement: 'recommended', valuePolicy: 'controlled_value', position: 0 },
        { attributeKey: 'axle_position', groupKey: 'specification', scope: 'product', flow: 'connector', requirement: 'recommended', valuePolicy: 'controlled_value', position: 1 },
        { attributeKey: 'pack_count', groupKey: 'packaging', scope: 'product', flow: 'connector', requirement: 'optional', valuePolicy: 'typed_scalar', position: 2 },
      ],
      localizations: [
        { locale: 'es', name: 'Juego de pastillas de freno', description: 'Nada del vehículo es un eje de variante.' },
        { locale: 'de', name: 'Bremsbelagsatz' },
      ],
    },
  ],

  brands: [{ key: 'voltek', name: 'Voltek', slug: 'voltek' }],

  families: [
    { key: 'voltek_precision', name: 'Precision', slug: 'voltek-precision', brandKey: 'voltek', categoryKey: 'braking.brake_pads' },
  ],

  products: [
    {
      key: 'vp_4410',
      name: 'Voltek Precision VP-4410 front brake pad set',
      slug: 'voltek-vp-4410',
      brandKey: 'voltek',
      familyKey: 'voltek_precision',
      categoryKey: 'braking.brake_pads',
      // ZERO. The whole package is about this line.
      variantAxisKeys: [],
      searchTokens: ['vp4410', 'pastillas', 'brake', 'freno'],
      aliases: [
        { alias: 'VP-4410', kind: 'name_variant', language: 'en' },
        { alias: 'pastillas de freno VP-4410', kind: 'localized_name', language: 'es' },
      ],
      facts: [
        { attributeKey: 'brake_pad_material', displayValue: 'Cerámica', sourceField: 'material' },
        { attributeKey: 'axle_position', displayValue: 'delantero', sourceField: 'eje' },
        { attributeKey: 'pad_dimensions', displayValue: '155.1 x 63.5 x 17.2 mm' },
        { attributeKey: 'pack_count', displayValue: '4' },
        { attributeKey: 'wear_indicator', displayValue: 'yes' },
        { attributeKey: 'homologation', displayValue: 'ECE-R90' },
        { attributeKey: 'fitment_reference', displayValue: 'VOLTEK-APP-2026-04 sheet 12' },
      ],
      variants: [
        {
          // ONE variant, with no options at all. `createCanonicalProduct` has
          // already minted the default variant for an axis-less product, so
          // this converges on that row rather than creating a second — a second
          // axis-less variant is refused by `UNIQUE(product_id, signature)`,
          // because `defaultTypedVariantSignature()` is a real digest.
          key: 'vp_4410_default',
          options: [],
          identifiers: [
            // An MPN is namespaced ALREADY: it is unique only within a
            // manufacturer, and each namespace mints its own brands.
            { kind: 'literal', scheme: 'mpn', rawValue: 'VP-4410' },
            { kind: 'namespaced_gtin', scheme: 'ean', seed: 1 },
          ],
        },
      ],
    },
    {
      key: 'vp_4411',
      name: 'Voltek Precision VP-4411 front brake pad set',
      slug: 'voltek-vp-4411',
      brandKey: 'voltek',
      familyKey: 'voltek_precision',
      categoryKey: 'braking.brake_pads',
      variantAxisKeys: [],
      searchTokens: ['vp4411', 'pastillas'],
      facts: [
        { attributeKey: 'brake_pad_material', displayValue: 'semi metallic', sourceField: 'material' },
        { attributeKey: 'axle_position', displayValue: 'front' },
        { attributeKey: 'pad_dimensions', displayValue: '149.0 x 61.0 x 17.0 mm' },
        { attributeKey: 'pack_count', displayValue: '4' },
        { attributeKey: 'wear_indicator', displayValue: 'no' },
        { attributeKey: 'homologation', displayValue: 'r90' },
        { attributeKey: 'fitment_reference', displayValue: 'VOLTEK-APP-2026-04 sheet 13' },
      ],
      variants: [
        {
          key: 'vp_4411_default',
          options: [],
          identifiers: [
            { kind: 'literal', scheme: 'mpn', rawValue: 'VP-4411' },
            { kind: 'namespaced_gtin', scheme: 'ean', seed: 2 },
          ],
        },
      ],
    },
  ],

  vehicleMakes: [
    {
      key: 'bmw',
      name: 'BMW',
      countryCode: 'DE',
      models: [
        {
          key: 'three_series',
          name: '3 Series',
          generations: [
            {
              key: 'f30',
              name: 'F30',
              chassisCode: 'F30',
              producedFromYear: 2012,
              // OVERLAPS the G20 below by two years. A model year alone cannot
              // select a generation, which is why a year is a configuration
              // property and never a variant option.
              producedToYear: 2019,
              configurations: [
                { key: 'f30_320i_eu', name: '320i', yearFrom: 2012, yearTo: 2019, engineCode: 'N20B20', engineDisplacementCc: 1997, powerKw: 135, fuelType: 'petrol', drivetrain: 'rwd', bodyStyle: 'saloon', doors: 4, market: 'DE' },
                { key: 'f30_320d_eu', name: '320d', yearFrom: 2012, yearTo: 2019, engineCode: 'N47D20', engineDisplacementCc: 1995, powerKw: 135, fuelType: 'diesel', drivetrain: 'rwd', bodyStyle: 'saloon', doors: 4, market: 'DE' },
                // The SAME nameplate, a different market, a different brake
                // package. This is the configuration the pad is excluded from.
                { key: 'f30_320d_us', name: '320d (US)', yearFrom: 2013, yearTo: 2018, engineCode: 'N47D20U', engineDisplacementCc: 1995, powerKw: 135, fuelType: 'diesel', drivetrain: 'rwd', bodyStyle: 'saloon', doors: 4, market: 'US' },
              ],
            },
            {
              key: 'g20',
              name: 'G20',
              chassisCode: 'G20',
              producedFromYear: 2018,
              producedToYear: 2026,
              configurations: [
                { key: 'g20_320i_eu', name: '320i', yearFrom: 2018, yearTo: 2026, engineCode: 'B48B20', engineDisplacementCc: 1998, powerKw: 135, fuelType: 'petrol', drivetrain: 'rwd', bodyStyle: 'saloon', doors: 4, market: 'DE' },
                { key: 'g20_320d_eu', name: '320d', yearFrom: 2018, yearTo: 2026, engineCode: 'B47D20', engineDisplacementCc: 1995, powerKw: 140, fuelType: 'diesel', drivetrain: 'rwd', bodyStyle: 'saloon', doors: 4, market: 'DE' },
                { key: 'g20_330e_eu', name: '330e', yearFrom: 2019, yearTo: 2026, engineCode: 'B48B20P', engineDisplacementCc: 1998, powerKw: 135, fuelType: 'plug_in_hybrid', drivetrain: 'rwd', bodyStyle: 'saloon', doors: 4, market: 'DE' },
              ],
            },
          ],
        },
        {
          key: 'four_series',
          name: '4 Series',
          generations: [
            {
              key: 'g22',
              name: 'G22',
              chassisCode: 'G22',
              producedFromYear: 2020,
              producedToYear: 2026,
              configurations: [
                { key: 'g22_420i_eu', name: '420i', yearFrom: 2020, yearTo: 2026, engineCode: 'B48B20', engineDisplacementCc: 1998, powerKw: 135, fuelType: 'petrol', drivetrain: 'rwd', bodyStyle: 'coupe', doors: 2, market: 'DE' },
                // Deliberately UNFITTED. The pad answers `unknown` here, which is
                // a different answer from `does_not_apply` and must stay one.
                { key: 'g22_430i_us', name: '430i (US)', yearFrom: 2020, yearTo: 2026, engineCode: 'B48B20U', engineDisplacementCc: 1998, powerKw: 190, fuelType: 'petrol', drivetrain: 'rwd', bodyStyle: 'coupe', doors: 2, market: 'US' },
              ],
            },
          ],
        },
      ],
    },
    {
      key: 'volkswagen',
      name: 'Volkswagen',
      countryCode: 'DE',
      models: [
        {
          key: 'golf',
          name: 'Golf',
          generations: [
            {
              key: 'golf_mk7',
              name: 'Mk7',
              chassisCode: '5G',
              producedFromYear: 2012,
              producedToYear: 2020,
              configurations: [
                { key: 'golf_mk7_gti', name: 'GTI', yearFrom: 2013, yearTo: 2020, engineCode: 'CHHB', engineDisplacementCc: 1984, powerKw: 162, fuelType: 'petrol', drivetrain: 'fwd', bodyStyle: 'hatchback', doors: 5, market: 'DE' },
                { key: 'golf_mk7_tdi', name: '2.0 TDI', yearFrom: 2012, yearTo: 2020, engineCode: 'CRBC', engineDisplacementCc: 1968, powerKw: 110, fuelType: 'diesel', drivetrain: 'fwd', bodyStyle: 'hatchback', doors: 5, market: 'DE' },
              ],
            },
            {
              key: 'golf_mk8',
              name: 'Mk8',
              chassisCode: 'CD',
              // OVERLAPS the Mk7 by two years, on a different make from the BMW
              // pair — so the overlapping-generation case is not one fixture's
              // accident.
              producedFromYear: 2019,
              producedToYear: 2026,
              configurations: [
                { key: 'golf_mk8_gti', name: 'GTI', yearFrom: 2020, yearTo: 2026, engineCode: 'DNPA', engineDisplacementCc: 1984, powerKw: 180, fuelType: 'petrol', drivetrain: 'fwd', bodyStyle: 'hatchback', doors: 5, market: 'DE' },
                { key: 'golf_mk8_tdi', name: '2.0 TDI', yearFrom: 2019, yearTo: 2026, engineCode: 'DTTA', engineDisplacementCc: 1968, powerKw: 110, fuelType: 'diesel', drivetrain: 'fwd', bodyStyle: 'hatchback', doors: 5, market: 'DE' },
              ],
            },
          ],
        },
      ],
    },
    {
      key: 'seat',
      name: 'SEAT',
      countryCode: 'ES',
      models: [
        {
          key: 'leon',
          name: 'León',
          generations: [
            {
              key: 'leon_mk3',
              name: 'Mk3',
              chassisCode: '5F',
              producedFromYear: 2012,
              producedToYear: 2020,
              configurations: [
                { key: 'leon_mk3_fr', name: 'FR 2.0 TDI', yearFrom: 2013, yearTo: 2020, engineCode: 'CRBC', engineDisplacementCc: 1968, powerKw: 110, fuelType: 'diesel', drivetrain: 'fwd', bodyStyle: 'hatchback', doors: 5, market: 'ES' },
              ],
            },
          ],
        },
      ],
    },
  ],

  fitments: [
    /* ---------------------------------------------------------- VP-4410 --- */
    {
      variantKey: 'vp_4410_default',
      scope: 'vehicle_generation',
      makeKey: 'bmw',
      modelKey: 'three_series',
      generationKey: 'f30',
      applicability: 'applies',
      position: 'front',
      quantityPerVehicle: 1,
      verification: 'verified',
      verificationMethod: 'manufacturer_publication',
      manufacturerReference: 'VOLTEK-APP-2026-04',
      manufacturerPublicationUrl: FITMENT_SHEET_URL,
      contentSha256: FITMENT_SHEET_DIGEST,
    },
    {
      // THE EXCLUSION. Narrower scope, so `resolveFitment` decides at
      // `vehicle_configuration` and the generation-wide `applies` above never
      // reaches this car. `candidate` rather than `verified` on purpose: a
      // negative statement is publishable from `candidate`, and this package
      // exercises that asymmetry rather than describing it.
      variantKey: 'vp_4410_default',
      scope: 'vehicle_configuration',
      makeKey: 'bmw',
      modelKey: 'three_series',
      generationKey: 'f30',
      configurationKey: 'f30_320d_us',
      applicability: 'does_not_apply',
      position: 'front',
      conditionNote: 'The North American car ships a different front caliper.',
      verification: 'candidate',
    },
    {
      variantKey: 'vp_4410_default',
      scope: 'vehicle_generation',
      makeKey: 'bmw',
      modelKey: 'three_series',
      generationKey: 'g20',
      applicability: 'applies',
      position: 'front',
      quantityPerVehicle: 1,
      verification: 'verified',
      verificationMethod: 'manufacturer_publication',
      manufacturerReference: 'VOLTEK-APP-2026-04',
      manufacturerPublicationUrl: FITMENT_SHEET_URL,
      contentSha256: FITMENT_SHEET_DIGEST,
    },
    {
      // The SAME vehicle at the REAR. A second row rather than a second
      // qualifier, because `position` is part of the generated `fitment_key`
      // and `qualifiers` is not — so front and rear are two statements and two
      // statements about one position would converge on one row.
      variantKey: 'vp_4410_default',
      scope: 'vehicle_generation',
      makeKey: 'bmw',
      modelKey: 'three_series',
      generationKey: 'g20',
      applicability: 'applies',
      position: 'rear',
      quantityPerVehicle: 1,
      verification: 'verified',
      verificationMethod: 'manufacturer_publication',
      manufacturerReference: 'VOLTEK-APP-2026-04',
      manufacturerPublicationUrl: FITMENT_SHEET_URL,
      contentSha256: FITMENT_SHEET_DIGEST,
    },
    {
      variantKey: 'vp_4410_default',
      scope: 'vehicle_configuration',
      makeKey: 'bmw',
      modelKey: 'four_series',
      generationKey: 'g22',
      configurationKey: 'g22_420i_eu',
      applicability: 'applies',
      position: 'front',
      verification: 'verified',
      verificationMethod: 'manufacturer_publication',
      manufacturerReference: 'VOLTEK-APP-2026-04',
      manufacturerPublicationUrl: FITMENT_SHEET_URL,
      contentSha256: FITMENT_SHEET_DIGEST,
    },
    {
      variantKey: 'vp_4410_default',
      scope: 'vehicle_generation',
      makeKey: 'volkswagen',
      modelKey: 'golf',
      generationKey: 'golf_mk7',
      applicability: 'applies',
      position: 'front',
      verification: 'verified',
      verificationMethod: 'manufacturer_publication',
      manufacturerReference: 'VOLTEK-APP-2026-04',
      manufacturerPublicationUrl: FITMENT_SHEET_URL,
      contentSha256: FITMENT_SHEET_DIGEST,
    },
    {
      // PARTIAL, with the qualifier that makes it partial. The CHECK
      // `automotive_fitments_partial_condition_check` refuses
      // `partially_applies` with nothing to explain it, so an unexplained
      // "sort of" is unrepresentable.
      variantKey: 'vp_4410_default',
      scope: 'vehicle_configuration',
      makeKey: 'volkswagen',
      modelKey: 'golf',
      generationKey: 'golf_mk7',
      configurationKey: 'golf_mk7_gti',
      applicability: 'partially_applies',
      position: 'front',
      qualifiers: ['without_sport_suspension'],
      conditionNote: 'Cars with the Performance Pack carry the larger front disc.',
      verification: 'verified',
      verificationMethod: 'manufacturer_publication',
      manufacturerReference: 'VOLTEK-APP-2026-04',
      manufacturerPublicationUrl: FITMENT_SHEET_URL,
      contentSha256: FITMENT_SHEET_DIGEST,
    },
    {
      variantKey: 'vp_4410_default',
      scope: 'vehicle_generation',
      makeKey: 'volkswagen',
      modelKey: 'golf',
      generationKey: 'golf_mk8',
      applicability: 'applies',
      position: 'front',
      verification: 'verified',
      verificationMethod: 'manufacturer_publication',
      manufacturerReference: 'VOLTEK-APP-2026-04',
      manufacturerPublicationUrl: FITMENT_SHEET_URL,
      contentSha256: FITMENT_SHEET_DIGEST,
    },
    {
      // MODEL scope — every generation of the León, because the supplier
      // publishes it that way. The scope ladder means this answers for a
      // configuration nobody enumerated, which is the point of having four
      // scopes rather than one.
      variantKey: 'vp_4410_default',
      scope: 'vehicle_model',
      makeKey: 'seat',
      modelKey: 'leon',
      applicability: 'applies',
      position: 'front',
      verification: 'verified',
      verificationMethod: 'manufacturer_publication',
      manufacturerReference: 'VOLTEK-APP-2026-04',
      manufacturerPublicationUrl: FITMENT_SHEET_URL,
      contentSha256: FITMENT_SHEET_DIGEST,
    },

    /* ---------------------------------------------------------- VP-4411 --- */
    // A SECOND part fitting a STRICT SUBSET of the first's vehicles, so the
    // reverse-fitment assertion has a discriminator: a test that only ever saw
    // one part could not tell "this vehicle's parts" from "every part".
    {
      variantKey: 'vp_4411_default',
      scope: 'vehicle_generation',
      makeKey: 'bmw',
      modelKey: 'three_series',
      generationKey: 'g20',
      applicability: 'applies',
      position: 'front',
      verification: 'verified',
      verificationMethod: 'cross_source_corroboration',
    },
    {
      variantKey: 'vp_4411_default',
      scope: 'vehicle_generation',
      makeKey: 'volkswagen',
      modelKey: 'golf',
      generationKey: 'golf_mk8',
      applicability: 'applies',
      position: 'front',
      verification: 'verified',
      verificationMethod: 'cross_source_corroboration',
    },
  ],

  compatibilityClaims: [
    {
      // AMBIGUOUS ENGINE NAME. `320d` names an F30 car and a G20 car, and this
      // fixture holds both. Picking one would be a false merge nobody could
      // see; the raw words are kept and frozen instead.
      variantKey: 'vp_4410_default',
      rawTargetText: 'fits BMW 320d',
      rawQualifierText: 'front axle',
      unresolvedReason: 'ambiguous_target',
    },
    {
      // AMBIGUOUS YEAR, from the overlapping generations. 2019 is inside the
      // Mk7's window and inside the Mk8's.
      variantKey: 'vp_4410_default',
      rawTargetText: 'fits Golf 2019',
      unresolvedReason: 'ambiguous_target',
    },
  ],

  expect: {
    categories: 3,
    attributes: 7,
    enumValues: 9,
    productTypes: 1,
    productTypeFields: 10,
    brands: 1,
    families: 1,
    products: 2,
    // TWO — one per product, and that is the headline. Eleven fitment rows
    // across thirteen vehicle configurations, and still two variants.
    variants: 2,
    identifiers: 4,
    // Seven declarations per product, of which `pad_dimensions` writes three
    // rows: (6 + 3) x 2.
    facts: 18,
    vehicleConfigurations: 13,
    fitments: 11,
    compatibilityClaims: 2,
  },
};
