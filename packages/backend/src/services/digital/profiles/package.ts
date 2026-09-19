/**
 * The Mercaria 3D reference vertical — seven profiles and the vocabulary they
 * ask (#1015 Workstream 3, ADR 0010 D12).
 *
 * ## What this package exists to prove
 *
 * That the 3D metadata a buyer needs is AUTHORED, not compiled in — #1015
 * acceptance criterion 18 — and that the line between what Mercaria MEASURED
 * and what a seller CLAIMED is drawn by the schema rather than by whoever
 * renders the page. Seventeen claim attributes are here; every fact a processor
 * reports is absent, deliberately, and `@mercaria/shared-types`'
 * `THREE_D_MEASURED_FACTS` is where each of those lives instead.
 *
 * The three #367 reference verticals each exist to prevent one tempting
 * modelling mistake. This one prevents two:
 *
 * - **A product page that cannot tell a measurement from a boast.** "42,180
 *   triangles" and "optimized for Unreal" look identical in a specification
 *   table, and a catalogue that stores them in one place with a provenance flag
 *   has one write path away from presenting the second as the first.
 * - **A variant explosion over formats and licences.** STL + OBJ + FBX is ONE
 *   deliverable (#1015 boundary 6) and Personal/Commercial is a licence option
 *   (boundary 5). The obvious modelling makes both axes and produces twelve
 *   variants of one model, each with its own price row and none of them a
 *   different thing.
 *
 * ## The one axis, and the walls that hold everything else down
 *
 * `deliverable_configuration` is the only `variantDefining` attribute here, and
 * it is the one ADR 0010 D2 names: `printable`, `game_ready`, `rigged`,
 * `source_files`. Three shapes are refused as axes and each is refused by a
 * DIFFERENT mechanism, which is what makes the refusal real rather than a
 * convention:
 *
 * | Tempting axis | What refuses it |
 * |---|---|
 * | A file format | there is no format attribute — it is MEASURED from the files |
 * | A licence tier | there is no licence attribute — rights live on a frozen licence version |
 * | Engine, printer, material | `scope: 'compatibility'`, so `product_type_fields_variant_axis_check`'s first conjunct refuses it |
 * | Everything else | `variantDefining` is false, so `mercaria_native_variant_axis_citation` refuses a listing axis citing it |
 *
 * ## Why the printable block is a VISIBILITY RULE and not a separate profile
 *
 * A character can be printed, rigged for a game, or both, and #1015's own
 * vocabulary splits "general" from "printable" rather than splitting the
 * catalogue. So the printable fields are declared on the profiles where printing
 * is a real route and guarded by a rule reading `intended_use` — one product
 * type, one canonical product, and a form that asks about wall thickness only
 * of a seller who said they made it to be printed.
 *
 * The alternative — `three_d_character_printable` and
 * `three_d_character_game` — would split ONE product into two classifications,
 * so a search for characters would have to know both, and a creator selling the
 * same figurine for both uses would have to pick one or list twice. That is the
 * variant explosion again, one level up.
 *
 * ## The P2P flow is real here, and shorter
 *
 * #367's flows are not decoration for a digital vertical: a studio publishing a
 * game-asset pack and somebody uploading a model they made at the weekend fill
 * in the same profile, and demanding the studio's fields from the second is how
 * a marketplace loses its long tail. Every profile declares a `p2p` flow with
 * the two or three questions a hobbyist can actually answer, and nothing else.
 */

import { MERCARIA_REFERENCE_LICENCES } from '@mercaria/shared-types';
import type { ProductTypeVisibilityRule } from '@mercaria/shared-types';
import type {
  ThreeDAttribute,
  ThreeDCategory,
  ThreeDProfile,
  ThreeDProfileField,
  ThreeDProfilePackage,
  ThreeDReferenceLicenceSeed,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* The printable guard                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The rule every printable field is guarded by.
 *
 * `includes_any` and not `eq`, because `intended_use` is a SET: a figurine sold
 * for printing AND for a game answers both, and an equality test against a
 * multi-value answer is the branch that silently hides the block for exactly the
 * seller with the most to say.
 *
 * The field name is the UNPREFIXED claim key; `apply.ts` namespaces it with the
 * same function it namespaces the attribute with. Writing the prefixed spelling
 * here would be a second place the namespace is applied, and the failure mode is
 * a rule that reads a key nothing declares — which publication refuses, loudly,
 * but only after the operator has run the seed.
 */
const PRINTABLE_WHEN_INTENDED_FOR_PRINTING: ProductTypeVisibilityRule = {
  node: 'membership',
  field: 'intended_use',
  op: 'includes_any',
  values: ['physical_printing'],
};

/* -------------------------------------------------------------------------- */
/* The claim vocabulary                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every category the vocabulary is scoped to.
 *
 * The 3D SUBTREE rather than each leaf: an attribute scope NARROWS something
 * general (`attribute_definition_categories` empty means everywhere), so scoping
 * to `digital.three_d` with descendants is what keeps `minimum_wall_thickness`
 * out of a footwear authoring schema while leaving all seven profiles able to
 * cite it. Scoping per leaf would be seven rows saying the same thing and one
 * more place for a new profile to be forgotten.
 */
const SCOPE: readonly string[] = ['three_d'];

const ATTRIBUTES: readonly ThreeDAttribute[] = [
  /* ------------------------------- the axis ------------------------------ */
  {
    // The ONE variant axis (ADR 0010 D2, #1015 boundary 7). `hardConstraintCapable`
    // is true here and nowhere else in this package: a configuration is carried
    // by every variant that exists, so a shopper requiring `printable` excludes
    // things that genuinely are not, rather than excluding everything whose
    // seller left a field blank.
    key: 'deliverable_configuration',
    label: 'Deliverable',
    description:
      'What this configuration of the asset IS: files prepared for printing, for a game engine, rigged for animation, or the editable source.',
    valueType: 'enum',
    variantDefining: true,
    hardConstraintCapable: true,
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Entregable' },
      { locale: 'fr', label: 'Livrable' },
    ],
    enumValues: [
      {
        value: 'printable',
        label: 'Print-ready files',
        aliases: ['printable', 'print ready', 'print-ready', 'imprimible'],
        localizations: [
          { locale: 'es', label: 'Archivos para imprimir' },
          { locale: 'fr', label: 'Fichiers prêts à imprimer' },
        ],
      },
      {
        value: 'game_ready',
        label: 'Game-ready files',
        aliases: ['game ready', 'game-ready', 'gameready', 'real-time'],
        localizations: [
          { locale: 'es', label: 'Archivos para videojuegos' },
          { locale: 'fr', label: 'Fichiers prêts pour le jeu' },
        ],
      },
      {
        value: 'rigged',
        label: 'Rigged files',
        aliases: ['rigged', 'riggeado', 'with rig'],
        localizations: [
          { locale: 'es', label: 'Archivos con esqueleto' },
          { locale: 'fr', label: 'Fichiers avec squelette' },
        ],
      },
      {
        value: 'source_files',
        label: 'Editable source files',
        // NOT an alias of a licence right. Whether the source is in the box is
        // this value; whether it may be redistributed is
        // `source_redistribution` on a licence version, which none of the three
        // reference licences grants.
        aliases: ['source', 'source files', 'project files', 'archivos fuente'],
        localizations: [
          { locale: 'es', label: 'Archivos fuente editables' },
          { locale: 'fr', label: 'Fichiers sources modifiables' },
        ],
      },
    ],
  },

  /* ------------------------------- general ------------------------------- */
  {
    // Free text and UNFILTERED, the `footwear_colorway` ruling: a facet over
    // studio names is unbounded, and worse than unusable — an unverified studio
    // name rendered as a filter pill reads exactly like a verified brand, which
    // is the one thing a credit line must not become.
    //
    // `subjective`, so the marketing-claim refusal does not run on it. That is
    // not a licence to boast: it is that "Made by the Foundry" is a NAME, and a
    // detector built for specification values would be adjudicating one.
    key: 'creator_credit',
    label: 'Creator or studio credit',
    description:
      'Who made the work, as the seller credits them. A claim: Mercaria verifies no part of it, and the seller of record is the store.',
    valueType: 'string',
    objectivity: 'subjective',
    filterable: false,
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Autor o estudio' },
      { locale: 'fr', label: 'Créateur ou studio' },
    ],
  },
  {
    // A SET, because "printable and game-ready" is one honest answer to one
    // question. Contrast the smartphone package's refusal to bag connectivity:
    // there, three answer types were being collapsed into one field; here it is
    // one answer type with several members, which is what `set` cardinality is.
    key: 'intended_use',
    label: 'Intended use',
    description: 'What the creator made it for. The printing questions are asked only when this includes printing.',
    valueType: 'enum',
    cardinality: 'set',
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Uso previsto' },
      { locale: 'fr', label: 'Usage prévu' },
    ],
    enumValues: [
      {
        // `physical_printing`, not `3d_printing`: a controlled value is free to
        // start with a digit, but a value spelled `3d_printing` beside a key
        // spelled `three_d_*` is two conventions in one vocabulary, and the
        // next person picks the wrong one.
        value: 'physical_printing',
        label: '3D printing',
        aliases: ['3d printing', '3d print', 'printing', 'impresion 3d', 'impresión 3d'],
        localizations: [
          { locale: 'es', label: 'Impresión 3D' },
          { locale: 'fr', label: 'Impression 3D' },
        ],
      },
      {
        value: 'real_time_engine',
        label: 'Games and real-time engines',
        aliases: ['game', 'games', 'real time', 'real-time', 'videojuegos'],
        localizations: [
          { locale: 'es', label: 'Videojuegos y motores en tiempo real' },
          { locale: 'fr', label: 'Jeux et moteurs temps réel' },
        ],
      },
      {
        value: 'animation_and_film',
        label: 'Animation and film',
        aliases: ['animation', 'film', 'vfx', 'animacion'],
        localizations: [
          { locale: 'es', label: 'Animación y cine' },
          { locale: 'fr', label: 'Animation et cinéma' },
        ],
      },
      {
        value: 'architectural_visualization',
        label: 'Architectural visualization',
        aliases: ['archviz', 'arch viz', 'visualizacion arquitectonica'],
        localizations: [
          { locale: 'es', label: 'Visualización arquitectónica' },
          { locale: 'fr', label: 'Visualisation architecturale' },
        ],
      },
      {
        value: 'product_rendering',
        label: 'Product rendering',
        aliases: ['rendering', 'product viz', 'renderizado'],
        localizations: [
          { locale: 'es', label: 'Renderizado de producto' },
          { locale: 'fr', label: 'Rendu produit' },
        ],
      },
      {
        value: 'education_and_prototyping',
        label: 'Education and prototyping',
        aliases: ['education', 'prototyping', 'prototipado'],
        localizations: [
          { locale: 'es', label: 'Educación y prototipado' },
          { locale: 'fr', label: 'Éducation et prototypage' },
        ],
      },
    ],
  },
  {
    // A CONTROLLED value and not a pixel count, because the honest thing a
    // seller knows is which tier they exported at. A `2048 x 2048` free text
    // would be a number nobody measured wearing a measurement's clothes — and
    // the day an image inspector lands, this attribute is the first entry in
    // `THREE_D_RETIRABLE_CLAIM_ATTRIBUTE_KEYS`.
    key: 'texture_resolution',
    label: 'Texture resolution',
    description: 'The largest texture map size supplied, as the creator exported it.',
    valueType: 'enum',
    sortable: false,
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Resolución de texturas' },
      { locale: 'fr', label: 'Résolution des textures' },
    ],
    enumValues: [
      { value: 'px_512', label: '512 px', aliases: ['512', '512px', '0.5k'] },
      { value: 'px_1k', label: '1K', aliases: ['1k', '1024', '1024px'] },
      { value: 'px_2k', label: '2K', aliases: ['2k', '2048', '2048px'] },
      { value: 'px_4k', label: '4K', aliases: ['4k', '4096', '4096px'] },
      { value: 'px_8k', label: '8K', aliases: ['8k', '8192', '8192px'] },
    ],
  },
  {
    key: 'pbr_workflow',
    label: 'PBR workflow',
    description: 'Which physically-based-rendering convention the supplied maps follow.',
    valueType: 'enum',
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Flujo PBR' },
      { locale: 'fr', label: 'Flux PBR' },
    ],
    enumValues: [
      {
        value: 'metallic_roughness',
        label: 'Metallic / roughness',
        aliases: ['metallic roughness', 'metalness roughness', 'metal rough'],
      },
      {
        value: 'specular_glossiness',
        label: 'Specular / glossiness',
        aliases: ['specular glossiness', 'spec gloss'],
      },
      {
        // The honest third member. Without it a creator shipping a single
        // diffuse map has to pick one of the two conventions they did not use,
        // and a shopper filtering on `metallic_roughness` then finds a model
        // with no roughness map in it.
        value: 'no_pbr_maps',
        label: 'No PBR maps',
        aliases: ['none', 'diffuse only', 'unlit'],
      },
    ],
  },
  {
    // An integer CLAIM, and deliberately not `mesh_count`. An LOD chain is an
    // authoring convention (`_LOD0`, `_LOD1`) the shipped inspector does not
    // read, so a measured mesh count of four says nothing about whether those
    // four are detail levels or four separate objects — and reporting "4 LODs"
    // for a four-part kit is the overclaim ADR 0010 D12 refuses.
    key: 'lod_count',
    label: 'LOD levels',
    description: 'How many levels of detail the asset ships, as the creator authored them.',
    valueType: 'integer',
    minValue: 0,
    maxValue: 16,
    sortable: true,
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Niveles de detalle' },
      { locale: 'fr', label: 'Niveaux de détail' },
    ],
  },
  {
    // ADR 0010 D12's own example of a claim, at `compatibility` SCOPE so the
    // variant-axis CHECK's first conjunct refuses it as an axis whatever it is
    // called. `hardConstraintCapable` is deliberately FALSE: a hard requirement
    // excludes on absence, so "must work in Unreal" would drop every asset
    // whose seller never filled the field in — which punishes silence rather
    // than unsuitability.
    key: 'engine_compatibility',
    label: 'Engine and tool compatibility',
    description: 'The engines and tools the creator says the files work in. A claim, not a Mercaria verification.',
    valueType: 'enum',
    cardinality: 'set',
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Compatibilidad con motores y programas' },
      { locale: 'fr', label: 'Compatibilité moteurs et logiciels' },
    ],
    enumValues: [
      { value: 'unreal_engine', label: 'Unreal Engine', aliases: ['unreal', 'ue5', 'ue4'] },
      { value: 'unity', label: 'Unity', aliases: ['unity3d', 'unity 3d'] },
      { value: 'godot', label: 'Godot', aliases: ['godot engine'] },
      { value: 'blender', label: 'Blender', aliases: ['blender 3d'] },
      { value: 'maya', label: 'Autodesk Maya', aliases: ['maya'] },
      { value: 'three_ds_max', label: 'Autodesk 3ds Max', aliases: ['3ds max', '3dsmax', 'max'] },
      { value: 'cinema_4d', label: 'Cinema 4D', aliases: ['c4d', 'cinema4d'] },
      { value: 'houdini', label: 'Houdini', aliases: ['sidefx houdini'] },
      { value: 'substance_painter', label: 'Substance Painter', aliases: ['substance', 'painter'] },
      { value: 'zbrush', label: 'ZBrush', aliases: ['z brush'] },
      { value: 'sketchup', label: 'SketchUp', aliases: ['sketch up'] },
      { value: 'revit', label: 'Autodesk Revit', aliases: ['revit'] },
    ],
  },
  {
    // Free text beside the controlled engine list, because a version RANGE is
    // not a closed vocabulary: `4.2+`, `2022 LTS and later` and `2021.3–2023.1`
    // are all legitimate and a facet over them is the unbounded filter
    // `footwear_colorway` exists to warn about. Unfiltered, and `subjective`
    // for the same reason `creator_credit` is.
    key: 'software_version_compatibility',
    label: 'Software versions',
    description: 'Which versions of those tools the creator has used the files with.',
    valueType: 'string',
    objectivity: 'subjective',
    filterable: false,
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Versiones de software' },
      { locale: 'fr', label: 'Versions logicielles' },
    ],
  },

  /* ------------------------------ printable ------------------------------ */
  {
    // A JUDGEMENT, and the reason the whole printable vocabulary is claims:
    // suitability depends on wall thicknesses, overhangs and a material the
    // platform never sees, and an analyzer answering it would be presenting an
    // uncertain model as guaranteed printable.
    key: 'print_process_suitability',
    label: 'Suitable print processes',
    description: 'The print processes the creator considers this suitable for.',
    valueType: 'enum',
    cardinality: 'set',
    objectivity: 'subjective',
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Procesos de impresión adecuados' },
      { locale: 'fr', label: "Procédés d'impression adaptés" },
    ],
    enumValues: [
      { value: 'fdm', label: 'FDM / FFF', aliases: ['fdm', 'fff', 'filament'] },
      { value: 'resin_sla', label: 'Resin (SLA / DLP / MSLA)', aliases: ['resin', 'sla', 'dlp', 'msla', 'resina'] },
      { value: 'sls', label: 'SLS / MJF powder', aliases: ['sls', 'mjf', 'powder'] },
    ],
  },
  {
    // A `measurement` in the LENGTH family, so `0.8 mm` and `0.08 cm` land on
    // one number — the collapse that makes two creators' claims comparable at
    // all. Still a CLAIM: nothing in `asset_file_inspections` measures a wall,
    // and this is the strongest candidate in
    // `THREE_D_RETIRABLE_CLAIM_ATTRIBUTE_KEYS` for the day one does.
    key: 'minimum_wall_thickness',
    label: 'Minimum wall thickness',
    description: 'The thinnest wall in the model, as the creator measured it.',
    valueType: 'measurement',
    unitFamily: 'length',
    decimalPlaces: 2,
    objectivity: 'subjective',
    sortable: true,
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Espesor mínimo de pared' },
      { locale: 'fr', label: 'Épaisseur de paroi minimale' },
    ],
  },
  {
    key: 'support_requirement',
    label: 'Supports',
    description: 'Whether printing this needs support structures.',
    valueType: 'enum',
    objectivity: 'subjective',
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Soportes' },
      { locale: 'fr', label: 'Supports' },
    ],
    enumValues: [
      { value: 'not_required', label: 'Not required', aliases: ['none', 'no supports', 'sin soportes'] },
      { value: 'optional', label: 'Optional', aliases: ['recommended', 'opcional'] },
      { value: 'required', label: 'Required', aliases: ['needed', 'necesarios'] },
    ],
  },
  {
    // Its OWN question rather than a fourth member of `support_requirement`: a
    // model can both require supports and ship a pre-supported variant, and one
    // enum cannot say both. Unmeasurable, unlike a pre-sliced PROFILE — support
    // structures are geometry, indistinguishable from the model that needs them,
    // while a slicer profile has its own `ASSET_FILE_ROLES` member and is
    // therefore a measured file census.
    key: 'presupported_files_included',
    label: 'Pre-supported files included',
    description: 'Whether a version of the model with supports already attached is in the download.',
    valueType: 'boolean',
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Incluye archivos con soportes' },
      { locale: 'fr', label: 'Fichiers pré-supportés inclus' },
    ],
  },
  {
    key: 'print_in_place',
    label: 'Prints in place',
    description: 'Prints as one piece with no assembly step.',
    valueType: 'boolean',
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Se imprime de una pieza' },
      { locale: 'fr', label: "S'imprime d'une seule pièce" },
    ],
  },
  {
    key: 'articulated',
    label: 'Articulated',
    description: 'Has joints that move once printed.',
    valueType: 'boolean',
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Articulado' },
      { locale: 'fr', label: 'Articulé' },
    ],
  },
  {
    key: 'print_recommendation_notes',
    label: 'Printing notes',
    description: 'Recommended layer height, material and slicer settings, in the creator’s own words.',
    valueType: 'string',
    objectivity: 'subjective',
    filterable: false,
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Notas de impresión' },
      { locale: 'fr', label: "Notes d'impression" },
    ],
  },
  {
    // #1015 W3's *"as claims, not global truth"*, held by two independent
    // decisions. `compatibility` SCOPE, so it can never be a variant axis; and
    // free text rather than a resolved relation, because `automotive_fitments`
    // is what a Mercaria-RESOLVED compatibility claim looks like — a
    // verification state, narrowest-scope-wins, and an `unresolved` answer for
    // an ambiguous target — and routing one seller's successful print through
    // that machinery would publish their anecdote as a platform verdict for
    // every owner of that printer.
    key: 'tested_printers',
    label: 'Printers tested on',
    description: 'The printers the creator has actually printed this on. Their experience, not a compatibility guarantee.',
    valueType: 'string',
    objectivity: 'subjective',
    filterable: false,
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Impresoras probadas' },
      { locale: 'fr', label: 'Imprimantes testées' },
    ],
  },
  {
    key: 'tested_materials',
    label: 'Materials tested',
    description: 'The materials the creator has printed this in. Their experience, not a compatibility guarantee.',
    valueType: 'string',
    objectivity: 'subjective',
    filterable: false,
    categoryScopeKeys: SCOPE,
    labels: [
      { locale: 'es', label: 'Materiales probados' },
      { locale: 'fr', label: 'Matériaux testés' },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* The field blocks every profile is composed from                             */
/* -------------------------------------------------------------------------- */

/**
 * The groups every profile lays its fields out in.
 *
 * Identical across the seven on purpose: the public specification layout
 * (`PublicProductTypeSpecificationLayout`) is derived across every flow and
 * names none, so two profiles grouping `texture_resolution` differently would
 * put it in `conflictingAttributeKeys` and place it nowhere. One layout, seven
 * profiles, and a shopper comparing a prop against a character reads the same
 * headings.
 */
const GROUPS = [
  { key: 'provenance', label: 'Creator and use', position: 0 },
  { key: 'deliverable', label: 'What you get', position: 1 },
  { key: 'surfacing', label: 'Textures and materials', position: 2 },
  { key: 'engine_fit', label: 'Engines and tools', position: 3 },
  { key: 'printing', label: 'Printing', position: 4 },
] as const;

/** The merchant-flow general block: what every profile asks of every seller. */
function generalMerchantFields(): ThreeDProfileField[] {
  return [
    {
      attributeKey: 'deliverable_configuration',
      groupKey: 'deliverable',
      scope: 'variant',
      flow: 'merchant',
      requirement: 'required',
      valuePolicy: 'controlled_value',
      variantCapable: true,
      position: 0,
    },
    {
      attributeKey: 'intended_use',
      groupKey: 'provenance',
      scope: 'product',
      flow: 'merchant',
      requirement: 'required',
      valuePolicy: 'controlled_value',
      position: 1,
    },
    {
      attributeKey: 'creator_credit',
      groupKey: 'provenance',
      scope: 'product',
      flow: 'merchant',
      requirement: 'recommended',
      valuePolicy: 'typed_scalar',
      position: 2,
    },
  ];
}

/** The surfacing block — every profile that has a surface at all. */
function surfacingMerchantFields(startAt: number): ThreeDProfileField[] {
  return [
    {
      attributeKey: 'texture_resolution',
      groupKey: 'surfacing',
      scope: 'product',
      flow: 'merchant',
      requirement: 'recommended',
      valuePolicy: 'controlled_value',
      position: startAt,
    },
    {
      attributeKey: 'pbr_workflow',
      groupKey: 'surfacing',
      scope: 'product',
      flow: 'merchant',
      requirement: 'recommended',
      valuePolicy: 'controlled_value',
      position: startAt + 1,
    },
  ];
}

/** The engine block — a compatibility SCOPE, so none of it can become an axis. */
function engineMerchantFields(startAt: number, lod: boolean): ThreeDProfileField[] {
  const fields: ThreeDProfileField[] = [
    {
      attributeKey: 'engine_compatibility',
      groupKey: 'engine_fit',
      scope: 'compatibility',
      flow: 'merchant',
      requirement: 'recommended',
      valuePolicy: 'controlled_value',
      position: startAt,
    },
    {
      attributeKey: 'software_version_compatibility',
      groupKey: 'engine_fit',
      scope: 'compatibility',
      flow: 'merchant',
      requirement: 'optional',
      valuePolicy: 'typed_scalar',
      position: startAt + 1,
    },
  ];
  if (lod) {
    fields.push({
      attributeKey: 'lod_count',
      groupKey: 'engine_fit',
      scope: 'product',
      flow: 'merchant',
      requirement: 'optional',
      valuePolicy: 'typed_scalar',
      position: startAt + 2,
    });
  }
  return fields;
}

/**
 * The printable block, guarded by the `intended_use` rule.
 *
 * `requirement` is `recommended` and never `required`, even on the print-model
 * profile, and that is not timidity: a `required` field behind a visibility rule
 * is required only when the rule is satisfied, and the seller who has NOT said
 * this is for printing would be blocked by a field they cannot see if the rule
 * were ever removed. Recommended survives that edit; required does not.
 */
function printableMerchantFields(startAt: number): ThreeDProfileField[] {
  const block: readonly {
    readonly key: ThreeDProfileField['attributeKey'];
    readonly policy: ThreeDProfileField['valuePolicy'];
    readonly scope: ThreeDProfileField['scope'];
  }[] = [
    { key: 'print_process_suitability', policy: 'controlled_value', scope: 'product' },
    { key: 'support_requirement', policy: 'controlled_value', scope: 'product' },
    { key: 'minimum_wall_thickness', policy: 'typed_scalar', scope: 'product' },
    { key: 'presupported_files_included', policy: 'typed_scalar', scope: 'product' },
    { key: 'print_in_place', policy: 'typed_scalar', scope: 'product' },
    { key: 'articulated', policy: 'typed_scalar', scope: 'product' },
    { key: 'print_recommendation_notes', policy: 'typed_scalar', scope: 'product' },
    { key: 'tested_printers', policy: 'typed_scalar', scope: 'compatibility' },
    { key: 'tested_materials', policy: 'typed_scalar', scope: 'compatibility' },
  ];
  return block.map((entry, index) => ({
    attributeKey: entry.key,
    groupKey: 'printing',
    scope: entry.scope,
    flow: 'merchant',
    requirement: 'recommended',
    valuePolicy: entry.policy,
    position: startAt + index,
    visibilityRule: PRINTABLE_WHEN_INTENDED_FOR_PRINTING,
  }));
}

/**
 * The P2P flow: three questions, and the third is what the guard reads.
 *
 * `intended_use` is present in EVERY flow that carries a guarded field, and
 * that is mechanical rather than stylistic: `publishProductTypeVersion` refuses
 * a version whose visibility rule reads a field the SAME FLOW does not declare,
 * because a merchant-only guard over a P2P field would leave that field hidden
 * forever with every surface reporting success.
 */
function p2pFields(printable: boolean): ThreeDProfileField[] {
  const fields: ThreeDProfileField[] = [
    {
      attributeKey: 'deliverable_configuration',
      groupKey: 'deliverable',
      scope: 'variant',
      flow: 'p2p',
      requirement: 'required',
      valuePolicy: 'controlled_value',
      variantCapable: true,
      position: 0,
    },
    {
      attributeKey: 'intended_use',
      groupKey: 'provenance',
      scope: 'product',
      flow: 'p2p',
      requirement: 'required',
      valuePolicy: 'controlled_value',
      position: 1,
    },
  ];
  if (printable) {
    fields.push({
      attributeKey: 'support_requirement',
      groupKey: 'printing',
      scope: 'product',
      flow: 'p2p',
      requirement: 'optional',
      valuePolicy: 'controlled_value',
      position: 2,
      visibilityRule: PRINTABLE_WHEN_INTENDED_FOR_PRINTING,
    });
  }
  return fields;
}

/* -------------------------------------------------------------------------- */
/* The seven profiles                                                          */
/* -------------------------------------------------------------------------- */

interface ProfileShape {
  readonly key: ThreeDProfile['key'];
  readonly categoryKey: string;
  readonly name: string;
  readonly description: string;
  /** Does this profile ask the printing questions at all? */
  readonly printable: boolean;
  /** Does it ask about detail levels — a real-time concern? */
  readonly lod: boolean;
  /** Does it have a SURFACE? A print model in one material does not. */
  readonly surfacing: boolean;
  readonly localizations: ThreeDProfile['localizations'];
}

const PROFILE_SHAPES: readonly ProfileShape[] = [
  {
    key: 'three_d_print_model',
    categoryKey: 'three_d.print_models',
    name: '3D print model',
    description:
      'A model sold to be printed. The printing questions are the point of this profile; textures usually are not.',
    printable: true,
    lod: false,
    // A print model is geometry; a colour comes from the filament. Asking a
    // texture resolution here would be a field almost every seller leaves blank,
    // and a form full of blanks is how a schema stops being read.
    surfacing: false,
    localizations: [
      { locale: 'es', name: 'Modelo para impresión 3D' },
      { locale: 'fr', name: "Modèle pour impression 3D" },
    ],
  },
  {
    key: 'three_d_game_asset',
    categoryKey: 'three_d.game_assets',
    name: '3D game asset',
    description:
      'An asset built for a real-time engine: budgeted geometry, engine targets and levels of detail.',
    printable: false,
    lod: true,
    surfacing: true,
    localizations: [
      { locale: 'es', name: 'Recurso 3D para videojuegos' },
      { locale: 'fr', name: 'Ressource 3D pour jeu vidéo' },
    ],
  },
  {
    key: 'three_d_character',
    categoryKey: 'three_d.characters',
    name: '3D character',
    description:
      'A character or creature. Printed as a figurine, rigged for animation, or both — which is why this profile asks both sets of questions.',
    printable: true,
    lod: true,
    surfacing: true,
    localizations: [
      { locale: 'es', name: 'Personaje 3D' },
      { locale: 'fr', name: 'Personnage 3D' },
    ],
  },
  {
    key: 'three_d_environment',
    categoryKey: 'three_d.environments',
    name: '3D environment',
    description: 'A scene, level or environment kit.',
    printable: false,
    lod: true,
    surfacing: true,
    localizations: [
      { locale: 'es', name: 'Entorno 3D' },
      { locale: 'fr', name: 'Environnement 3D' },
    ],
  },
  {
    key: 'three_d_prop',
    categoryKey: 'three_d.props',
    name: '3D prop',
    description: 'A single object or prop — the commonest thing in the vertical, and printable as often as not.',
    printable: true,
    lod: true,
    surfacing: true,
    localizations: [
      { locale: 'es', name: 'Objeto 3D' },
      { locale: 'fr', name: 'Accessoire 3D' },
    ],
  },
  {
    key: 'three_d_archviz_asset',
    categoryKey: 'three_d.archviz',
    name: '3D architectural asset',
    description: 'Furniture, fittings or vegetation for architectural visualization.',
    printable: false,
    lod: true,
    surfacing: true,
    localizations: [
      { locale: 'es', name: 'Recurso 3D de arquitectura' },
      { locale: 'fr', name: 'Ressource 3D architecturale' },
    ],
  },
  {
    key: 'three_d_material_texture_pack',
    categoryKey: 'three_d.materials_textures',
    name: 'Material and texture pack',
    description:
      'Materials and texture maps, which own no geometry at all — the profile that proves the vocabulary is not one shape with optional halves.',
    printable: false,
    // No geometry, so no detail levels. The absence is the measurement: a
    // profile that declared `lod_count` anyway would be asking a question with
    // no answer, and every pack would carry a blank.
    lod: false,
    surfacing: true,
    localizations: [
      { locale: 'es', name: 'Pack de materiales y texturas' },
      { locale: 'fr', name: 'Pack de matériaux et textures' },
    ],
  },
];

function buildProfile(shape: ProfileShape): ThreeDProfile {
  const merchant: ThreeDProfileField[] = [...generalMerchantFields()];
  if (shape.surfacing) merchant.push(...surfacingMerchantFields(merchant.length));
  merchant.push(...engineMerchantFields(merchant.length, shape.lod));
  if (shape.printable) merchant.push(...printableMerchantFields(merchant.length));

  return {
    key: shape.key,
    version: 1,
    name: shape.name,
    description: shape.description,
    categoryScopeKeys: [shape.categoryKey],
    groups: GROUPS.map((group) => ({ ...group })),
    fields: [...merchant, ...p2pFields(shape.printable)],
    localizations: shape.localizations,
  };
}

const PROFILES: readonly ThreeDProfile[] = PROFILE_SHAPES.map(buildProfile);

/* -------------------------------------------------------------------------- */
/* The reference licences                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The three reference licences, derived from the published tuple rather than
 * retyped.
 *
 * `MERCARIA_REFERENCE_LICENCES` is the terms; this is the SEED's decisions about
 * them — version 1, and the update policy that ordinarily goes with each. The
 * slugs come from the tuple itself, so a fourth reference licence appears here
 * with no edit and a renamed one cannot be silently left behind.
 *
 * The update policies are not uniform and the asymmetry is the interesting part.
 * A print licence buys a SHAPE, and a creator's v2 fixing a wall thickness is
 * the same shape — `all_future_versions`. A commercial project licence is
 * embedded in somebody's shipped game, where a surprise v2 with a different
 * topology is a problem rather than a gift, so `same_major_version` bounds what
 * arrives. A personal licence at the cheapest price gets what was bought. None
 * of these is enforced here: an option is per asset and this seed creates none.
 */
const SUGGESTED_UPDATE_POLICY: Readonly<Record<string, ThreeDReferenceLicenceSeed['suggestedUpdatePolicy']>> =
  {
    'mercaria-personal': 'purchased_version_only',
    'mercaria-commercial-project': 'same_major_version',
    'mercaria-commercial-print': 'all_future_versions',
  };

const LICENCES: readonly ThreeDReferenceLicenceSeed[] = MERCARIA_REFERENCE_LICENCES.map(
  (licence) => ({
    slug: licence.slug,
    version: 1,
    // A slug the map does not know is a NEW reference licence, and the seed must
    // not guess a policy for it: `purchased_version_only` is the narrowest
    // answer, so an unclassified licence gives a buyer the least and a reviewer
    // the loudest signal. Widening is a decision; narrowing later is a breach.
    suggestedUpdatePolicy: SUGGESTED_UPDATE_POLICY[licence.slug] ?? 'purchased_version_only',
  }),
);

/* -------------------------------------------------------------------------- */
/* The package                                                                 */
/* -------------------------------------------------------------------------- */

export const THREE_D_PROFILE_PACKAGE: ThreeDProfilePackage = {
  name: 'three_d',
  title: 'Mercaria 3D profiles',
  proves:
    'That the 3D metadata a buyer reads is authored through #367 product types rather than compiled ' +
    'into a client (#1015 acceptance criterion 18); that every fact the inspection pipeline measures ' +
    'is ABSENT from the seller-editable vocabulary, so the two can never disagree (ADR 0010 D12); and ' +
    'that a format, a licence tier and an engine target are each refused as variant axes by a ' +
    'different mechanism.',
  sourceName: 'Mercaria 3D reference profiles',

  categories: [
    {
      key: 'digital',
      name: 'Digital goods',
      slug: 'digital-goods',
      parentKey: null,
      selectable: false,
      position: 0,
      localizations: [
        { locale: 'es', name: 'Productos digitales' },
        { locale: 'fr', name: 'Produits numériques' },
      ],
      aliases: [],
    },
    {
      key: 'three_d',
      name: '3D models',
      slug: '3d-models',
      parentKey: 'digital',
      selectable: false,
      position: 0,
      localizations: [
        { locale: 'es', name: 'Modelos 3D' },
        { locale: 'fr', name: 'Modèles 3D' },
      ],
      // Regional and colloquial vocabulary, read by the deterministic
      // search-intent interpreter since #732. `stl` and `obj` are here as
      // SEARCH TERMS and not as a format attribute: people search by extension,
      // and that is a query-side fact, not a variant axis (#1015 boundary 6).
      aliases: [
        { locale: 'en', alias: '3d model', kind: 'synonym' },
        { locale: 'en', alias: '3d models', kind: 'synonym' },
        { locale: 'en', alias: '3d print', kind: 'search_term' },
        { locale: 'en', alias: '3d printing', kind: 'search_term' },
        { locale: 'en', alias: 'stl', kind: 'search_term' },
        { locale: 'en', alias: 'obj', kind: 'search_term' },
        { locale: 'es', alias: 'modelo 3d', kind: 'synonym' },
        { locale: 'es', alias: 'modelos 3d', kind: 'synonym' },
        { locale: 'es', alias: 'impresión 3d', kind: 'search_term' },
        { locale: 'fr', alias: 'modèle 3d', kind: 'synonym' },
        { locale: 'fr', alias: 'modèles 3d', kind: 'synonym' },
        { locale: 'fr', alias: 'impression 3d', kind: 'search_term' },
      ],
    },
    // One selectable leaf per profile, derived from the profile shapes so a
    // profile can never arrive without somewhere to be classified — which
    // `publishProductTypeVersion` refuses outright (`no_category_scope`), but
    // only after an operator has run the seed.
    ...PROFILE_SHAPES.map(
      (shape, index): ThreeDCategory => ({
        key: shape.categoryKey,
        name: shape.name,
        slug: shape.categoryKey.replace(/^three_d\./u, '3d-').replace(/_/gu, '-'),
        parentKey: 'three_d',
        selectable: true,
        position: index,
        localizations: shape.localizations.map((localization) => ({ ...localization })),
        aliases: [],
      }),
    ),
  ],

  attributes: ATTRIBUTES,
  profiles: PROFILES,
  licences: LICENCES,

  /**
   * Written by hand, and NEVER computed from the arrays above.
   *
   * `deriveExpectation` in `census.ts` computes exactly these numbers FROM the
   * package data and `scripts/seed-digital-3d.ts` refuses to run if the two
   * disagree — which is only a check because the two are produced differently.
   * A declaration spelled `ATTRIBUTES.length` would agree with the derivation by
   * construction, for any package, including a broken one.
   *
   * The field total is the interesting figure: 96 across seven profiles, from
   * 17 attributes. That asymmetry IS the per-flow, per-profile model — a print
   * model asks 17 questions and a material pack asks 9, and a single
   * `three_d_model` type would have had to ask all 26 of everybody.
   */
  expect: {
    categories: 9,
    attributes: 17,
    enumValues: 36,
    profiles: 7,
    profileFields: 96,
    licences: 3,
    licenceVersions: 3,
  },
};
