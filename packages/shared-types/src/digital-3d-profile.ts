/**
 * The 3D product profiles — what a 3D deliverable SAYS about itself, and which
 * half of it Mercaria measured (#1015 Workstream 3, ADR 0010 D12).
 *
 * ## This module is a VOCABULARY, not a form
 *
 * #1015 acceptance criterion 18 is that the 3D metadata lives in #367's
 * product-type registry and **never as hard-coded frontend truth**. So what is
 * here is the closed sets a gate and a seed are derived from — profile keys,
 * claim attribute keys, the measured-fact registry and the provenance split —
 * and what is deliberately NOT here is every property of a FORM: no
 * requirement, no authoring flow, no group, no layout position, no label and no
 * visibility rule. Those live in `product_type_fields` rows, reach a client as
 * an `AuthoringSchema`, and a client that hard-codes one has reimplemented the
 * thing this epic exists to avoid. {@link THREE_D_FORBIDDEN_PROFILE_SHAPES}
 * states that prohibition as values so it is testable rather than remembered.
 *
 * The display text is absent for the same reason and one more: a profile's name
 * is `product_type_definitions.name` plus its `product_type_localizations`
 * rows, which is the only place it can be translated. A label in this module
 * would be a second, untranslatable copy — ADR 0007 D1's rule, one domain over.
 *
 * ## The provenance split is the whole point of the module
 *
 * ADR 0010 D12: facts Mercaria MEASURES live in `asset_file_inspections` with
 * the processor name and version that produced them; facts a seller CLAIMS are
 * product-type attribute values. *"42,180 triangles"* and *"optimized for
 * Unreal"* are different provenance classes and a product page renders them
 * differently — {@link AssetFactProvenance} is the vocabulary for that, and it
 * is imported rather than restated.
 *
 * An attribute the pipeline can measure must therefore NOT also be a
 * seller-editable claim field. Two records of one fact disagree eventually, and
 * when they do nothing says which is true — which is precisely the question
 * {@link DIGITAL_CONFORMITY_BASIS} ("conformity with the DESCRIBED
 * deliverable", ADR 0010 D11) has to be answerable from. So:
 *
 * - {@link THREE_D_MEASURED_FACTS} names every fact the measured side owns, and
 *   {@link THREE_D_MEASURED_FACT_ORIGINS} says which column or file census
 *   holds each one. A backend gate reads those column names off the real
 *   drizzle table, so a renamed column fails the build.
 * - {@link THREE_D_CLAIM_ATTRIBUTE_KEYS} names every seller claim, and the two
 *   sets are asserted DISJOINT.
 *
 * The line is drawn at **what `asset_file_inspections` has a column for**,
 * because that is the only measurement a product page can render with a
 * processor beside it. Drawing it at "what a geometry analyzer could in
 * principle compute" would put four fields on the measured side that nothing
 * measures, and an unmeasured measured fact reads as `0` — the exact overclaim
 * ADR 0010 D12 makes every geometry column nullable to prevent.
 * {@link THREE_D_RETIRABLE_CLAIM_ATTRIBUTE_KEYS} names the claims that become
 * WRONG the day a processor measures them, so the decision arrives with the
 * column rather than six months after it.
 *
 * ## What cannot be a variant axis here, and why none of it is an accident
 *
 * {@link THREE_D_DELIVERABLE_CONFIGURATIONS} is the ONE axis this vertical
 * declares, and it is the one ADR 0010 D2 blesses by name: *"a materially
 * different DELIVERABLE CONFIGURATION may be one: `printable`, `game-ready`,
 * `rigged`, `source-files`"*. Everything else in the vocabulary is a FACT,
 * which is also the registry's default (`variantDefining` is false unless a
 * package says otherwise), so the direction a forgotten flag falls is the safe
 * one.
 *
 * Three shapes are refused as axes and each would have been tempting:
 *
 * - **A file format.** #1015 boundary 6: several formats belong to ONE purchased
 *   package, so an axis would make a buyer choose bytes and would multiply one
 *   model into one variant per extension. There is no format attribute at all
 *   here — the formats a buyer receives are MEASURED from the files in the
 *   package, so there is nothing to misuse.
 * - **A licence tier.** #1015 boundary 5 and ADR 0010 D2: Personal €6 and
 *   Commercial €25 are two variants each BOUND to a licence option, and the
 *   rights live on the frozen licence version. A `licence_tier` enum attribute
 *   would be a second, unversioned, unsnapshotted record of the terms, which is
 *   the failure `asset_licence_versions` exists to make impossible.
 * - **A compatibility target.** `engine_compatibility`, `tested_printers` and
 *   `tested_materials` are declared at the `compatibility` SCOPE, so
 *   `product_type_fields_variant_axis_check`'s first conjunct refuses them as
 *   axes whatever anyone calls them — the brake-pad wall, one domain over. "It
 *   works in Unreal" is a relationship to somebody else's product, and a
 *   marketplace that made it an option row would ship one variant per engine
 *   for one file.
 *
 * {@link PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS}' exact-match half protects
 * none of this, and that is worth stating rather than discovering. It names none
 * of these keys — asserted — and under a namespaced run it could not fire even if
 * it did, because the stored key carries a prefix (`run4a2b_tested_printers`) that
 * matches no entry however the list grows. The walls that actually hold here are
 * the scope conjunct above and `mercaria_native_variant_axis_citation`, which
 * reads the cited definition's own `variant_defining` flag.
 *
 * ## Why the keys say `three_d` and not `3d`
 *
 * #1015 W3 names the profiles `3d_print_model`, `3d_game_asset` and so on. A
 * leading digit is not a legal key: {@link PRODUCT_TYPE_KEY_PATTERN} and
 * `product_type_definitions_key_shape_check` both anchor on `^[a-z]`, and
 * `attribute_definitions_key_shape_check` does the same for every attribute. So
 * the epic's spelling is the English and `three_d_*` is the key — which is the
 * choice {@link DigitalVertical} already made for the same reason, its member
 * being `three_d` rather than `3d`. Stated here because the alternative is a
 * reader concluding the profiles were renamed for taste.
 */

import type { AssetFactProvenance, DigitalVertical } from './digital-asset';

/* -------------------------------------------------------------------------- */
/* The seven profiles                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The seven reference product-type profiles of the 3D vertical.
 *
 * Seven and not one, because the attribute vocabulary a buyer needs genuinely
 * differs: a print model answers wall thickness and support questions a
 * material pack has no meaning for, and a character answers rig questions a
 * prop does not. A single `three_d_model` profile asking every question of
 * everybody is the form nobody finishes — and it would make "is this field
 * relevant" a renderer's guess instead of a schema's answer.
 *
 * They are also the measurement of #1015 acceptance criterion 20. Seven
 * profiles are rows produced by one package under one apply; if a second
 * vertical needs a second commerce stack, it will show up as these seven
 * needing seven code paths, and they do not.
 */
export const THREE_D_PROFILE_KEYS = [
  /** A model sold to be PRINTED. The printable vocabulary is required here. */
  'three_d_print_model',
  /** A game-ready asset: budgeted geometry, engine targets, LODs. */
  'three_d_game_asset',
  /** A character or creature, printable or rigged for animation. */
  'three_d_character',
  /** A scene, level or environment kit. */
  'three_d_environment',
  /** A single prop or object, the commonest thing in the vertical. */
  'three_d_prop',
  /** An architectural-visualization asset: furniture, fittings, vegetation. */
  'three_d_archviz_asset',
  /** A material or texture pack, which owns no geometry at all. */
  'three_d_material_texture_pack',
] as const;

/** One of {@link THREE_D_PROFILE_KEYS}. */
export type ThreeDProfileKey = (typeof THREE_D_PROFILE_KEYS)[number];

/**
 * The vertical every profile here belongs to.
 *
 * Stated once as a value rather than written into seven rows, so
 * `DIGITAL_ENABLED_VERTICALS` disabling `three_d` and this registry can never
 * be talking about different things (ADR 0010 D13's fifth lever).
 */
export const THREE_D_PROFILE_VERTICAL: DigitalVertical = 'three_d';

/* -------------------------------------------------------------------------- */
/* The one legitimate variant axis                                             */
/* -------------------------------------------------------------------------- */

/**
 * The controlled values of the ONE variant axis this vertical declares —
 * `deliverable_configuration` (ADR 0010 D2, #1015 boundary 7).
 *
 * Four members, taken verbatim from the ADR's own sentence rather than invented
 * here, because the list is the boundary: a configuration is a materially
 * different deliverable a buyer chooses between and pays a different price for,
 * and anything NOT on this list that somebody wants as an axis is almost
 * certainly a format, a licence or a compatibility target in disguise.
 *
 * `source_files` is a CONFIGURATION and not a licence right, and the two are
 * easy to confuse: whether the source files are in the box is this axis, while
 * whether the buyer may REDISTRIBUTE them is `source_redistribution` on a
 * licence version — which {@link MERCARIA_REFERENCE_LICENCES} grants in none of
 * its three, by construction (#1015 W2 requirement 6).
 */
export const THREE_D_DELIVERABLE_CONFIGURATIONS = [
  'printable',
  'game_ready',
  'rigged',
  'source_files',
] as const;

/** One of {@link THREE_D_DELIVERABLE_CONFIGURATIONS}. */
export type ThreeDDeliverableConfiguration = (typeof THREE_D_DELIVERABLE_CONFIGURATIONS)[number];

/* -------------------------------------------------------------------------- */
/* The MEASURED side                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every fact about a 3D deliverable that the MEASURED side owns (ADR 0010 D12).
 *
 * A fact here may never also be a seller claim, and
 * {@link THREE_D_CLAIM_ATTRIBUTE_KEYS} is asserted disjoint from it. The names
 * are this registry's own rather than the column's, because four of them are
 * answered by a census over the files in a package instead of by a column — see
 * {@link ThreeDMeasuredFactOrigin}.
 *
 * Note what this list does NOT contain: any judgement. `watertight` is a
 * measurement whose NULL means *not determined*; "suitable for resin printing"
 * is a seller's opinion about a printer they own, and putting it here would
 * make Mercaria the author of a printability promise it cannot keep (#1015 W4's
 * closing rule, and the reason `ASSET_INSPECTION_VERDICTS` carries
 * `unsupported` as a first-class answer).
 */
export const THREE_D_MEASURED_FACTS = [
  /** Triangle/polygon count, as the mesh inspector counted it. */
  'triangle_count',
  'vertex_count',
  /**
   * Separate mesh count — which is also the honest answer to "how many PARTS is
   * this print", because a part is a separate body and that is what a mesh
   * census counts.
   */
  'mesh_count',
  /**
   * The bounding box, in MILLIMETRES. Three columns, all present or all absent
   * by CHECK, because `42 × 17 × —` is a measurement nothing can render.
   */
  'bounding_box_mm',
  /**
   * The unit the geometry above is expressed in.
   *
   * Not a measurement and not a claim: the columns are NAMED `_mm`, so the
   * inspector resolving a file authored in metres is what produced the number.
   * A seller-claimed unit beside it would be a second answer to the question
   * "how big is this when printed", and the answer a slicer obeys is the file's.
   */
  'geometry_unit',
  /** Watertight / manifold. NULL is *not determined* and is never *no*. */
  'watertight',
  'uv_mapped',
  'rigged',
  /** `animated` is this count being positive — derived, never a second column. */
  'animation_count',
  /** Textures the asset REFERENCES and does not contain. */
  'missing_resource_count',
  /**
   * The inspection verdict itself.
   *
   * In the registry rather than treated as plumbing, because it is what makes
   * every nullable fact above readable: `pending`, `unsupported` and `measured`
   * are three different reasons for a NULL triangle count and a product page
   * must say which.
   */
  'inspection_verdict',
  /**
   * The processor name and version that produced the row.
   *
   * A measured fact a buyer sees carries its attribution (#1015 W4 requirement
   * 13), which is also what makes a recomputation distinguishable from the
   * original measurement rather than an overwrite of it.
   */
  'processor_identity',
  /** Which formats are in the package — `asset_files.format`, per file. */
  'formats_delivered',
  /** Whether the creator's editable original is in the box (`role = 'source'`). */
  'source_format_delivered',
  /** Whether texture files are in the box (`role = 'texture'`). */
  'textures_delivered',
  /**
   * Whether a slicer or engine profile is in the box (`role = 'profile'`).
   *
   * #1015 W3 lists "pre-sliced profile presence" under the PRINTABLE
   * vocabulary, and it looks like a seller claim until you notice
   * `ASSET_FILE_ROLES` already has `profile` for exactly this file. A claim
   * field beside that membership would be a checkbox that can disagree with the
   * contents of the download.
   */
  'presliced_profile_delivered',
  /** Total download size — the sum of `asset_files.byte_size` over the package. */
  'download_byte_size',
] as const;

/** One of {@link THREE_D_MEASURED_FACTS}. */
export type ThreeDMeasuredFact = (typeof THREE_D_MEASURED_FACTS)[number];

/**
 * Where a measured fact actually comes from.
 *
 * Three kinds, and the distinction is not bookkeeping: an `inspection_column`
 * fact can be NULL because nothing measured it, a `file_census` fact is always
 * answerable because the files either are in the package or are not, and a
 * `column_contract` fact is a property of the schema rather than of a
 * measurement. A product page that treated the second as nullable would print
 * "unknown" where the answer is "no", which is the failure mode a single
 * provenance flag invites.
 */
export type ThreeDMeasuredFactOrigin =
  | {
      readonly kind: 'inspection_column';
      /** Drizzle property names on `asset_file_inspections`. Never SQL names. */
      readonly columns: readonly string[];
    }
  | {
      readonly kind: 'file_census';
      /** What is counted or summed over the package's files. */
      readonly census: string;
    }
  | {
      readonly kind: 'column_contract';
      /** The columns whose own definition carries the answer. */
      readonly columns: readonly string[];
    };

/**
 * Every measured fact's origin. TOTAL over the tuple, so a fact added without a
 * home fails `tsc` here rather than rendering as a blank on a product page.
 *
 * The column names are the DRIZZLE property names, and
 * `three-d-profile-provenance.test.ts` resolves each one against the real
 * `assetFileInspections` table — so this registry cannot quietly describe a
 * column that was renamed, and a NEW geometry column on that table fails the
 * build until somebody classifies it.
 */
export const THREE_D_MEASURED_FACT_ORIGINS: Readonly<
  Record<ThreeDMeasuredFact, ThreeDMeasuredFactOrigin>
> = {
  triangle_count: { kind: 'inspection_column', columns: ['triangleCount'] },
  vertex_count: { kind: 'inspection_column', columns: ['vertexCount'] },
  mesh_count: { kind: 'inspection_column', columns: ['meshCount'] },
  bounding_box_mm: {
    kind: 'inspection_column',
    columns: ['boundingBoxXMm', 'boundingBoxYMm', 'boundingBoxZMm'],
  },
  geometry_unit: {
    kind: 'column_contract',
    columns: ['boundingBoxXMm', 'boundingBoxYMm', 'boundingBoxZMm'],
  },
  watertight: { kind: 'inspection_column', columns: ['watertight'] },
  uv_mapped: { kind: 'inspection_column', columns: ['hasUvMapping'] },
  rigged: { kind: 'inspection_column', columns: ['hasRig'] },
  animation_count: { kind: 'inspection_column', columns: ['animationCount'] },
  missing_resource_count: { kind: 'inspection_column', columns: ['missingResourceCount'] },
  inspection_verdict: { kind: 'inspection_column', columns: ['verdict'] },
  processor_identity: {
    kind: 'inspection_column',
    columns: ['processorName', 'processorVersion'],
  },
  formats_delivered: {
    kind: 'file_census',
    census: "asset_files.format over the package's asset_package_files at one version",
  },
  source_format_delivered: {
    kind: 'file_census',
    census: "asset_files.format where role = 'source'",
  },
  textures_delivered: { kind: 'file_census', census: "asset_files where role = 'texture'" },
  presliced_profile_delivered: {
    kind: 'file_census',
    census: "asset_files where role = 'profile'",
  },
  download_byte_size: { kind: 'file_census', census: 'sum(asset_files.byte_size)' },
};

/* -------------------------------------------------------------------------- */
/* The CLAIMED side                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Which half of the vocabulary a claim belongs to.
 *
 * `printable` claims are the ones that mean nothing for an asset nobody will
 * print, and the profiles that declare them guard them behind a visibility rule
 * on `intended_use` rather than asking a game-asset seller about wall
 * thickness. It is a property of the ATTRIBUTE rather than of the form so that
 * "is this a printing question" has one answer across seven profiles.
 */
export const THREE_D_CLAIM_KINDS = ['general', 'printable'] as const;

/** One of {@link THREE_D_CLAIM_KINDS}. */
export type ThreeDClaimKind = (typeof THREE_D_CLAIM_KINDS)[number];

/**
 * Every attribute key a SELLER answers in the 3D vertical (ADR 0010 D12).
 *
 * Unnamespaced: a seeded definition carries the package prefix
 * (`d3d_intended_use`), which is what keeps two applications of one package from
 * racing on `attribute_definitions.key` — see the seed's own namespace note. The
 * keys here are the vocabulary, and the prefix is the deployment's.
 *
 * Every one of these is something a buyer needs and **no processor reports**.
 * Where the pipeline does report it, there is no key here at all: the formats in
 * the box, the triangle count, the bounding box, watertightness, UV mapping, the
 * rig, the animations, the textures, the pre-sliced profile and the download size
 * are all MEASURED, and a claim field for any of them would be the second record
 * of one fact that ADR 0010 D12 exists to refuse.
 */
export const THREE_D_CLAIM_ATTRIBUTE_KEYS = [
  /* ------------------------------- general ------------------------------- */
  /**
   * The studio or artist credited for the work.
   *
   * NOT the seller. The seller is the `stores` row that owns the asset (#1015
   * W6: creators are first-class sellers through the store record every seller
   * already has), and this is a credit line the seller ASSERTS — which is
   * exactly why it is a claim and why it is unfiltered free text: a studio name
   * nobody verified must not become a facet that reads like a verified brand.
   */
  'creator_credit',
  /**
   * What the creator made it FOR. The field the printable block keys off.
   *
   * A `set`, because "a printable figurine that also works in a game" is one
   * honest answer to one question rather than two — the opposite of
   * `connectivity`, which the smartphone package refuses to bag because a
   * cellular generation, a Wi-Fi standard and an NFC boolean are three
   * questions with three answer types.
   */
  'intended_use',
  /**
   * Texture map resolution, as a controlled value rather than a pixel count.
   *
   * A claim TODAY, and the clearest entry in
   * {@link THREE_D_RETIRABLE_CLAIM_ATTRIBUTE_KEYS}: a PNG's pixel dimensions
   * are trivially measurable, but `ASSET_FORMAT_REGISTRY` marks `png` and
   * `jpeg` `geometryMeasurable: false` and `asset_file_inspections` has no
   * dimension column, so nothing measures it and a "measured" 4K would be a
   * number nobody produced.
   */
  'texture_resolution',
  /**
   * Which PBR convention the maps follow.
   *
   * Unmeasurable in the only sense that matters: the inspector sees a texture
   * file, not which slot a creator INTENDED it for, and a roughness map and a
   * glossiness map are the same bytes with opposite meanings.
   */
  'pbr_workflow',
  /**
   * How many levels of detail the asset ships.
   *
   * A claim, and not `mesh_count`: an LOD chain is an authoring CONVENTION
   * (`_LOD0`, `_LOD1`) that the shipped inspector does not read, so a mesh count
   * of four says nothing about whether those four are detail levels or four
   * separate objects. Conflating them would report "4 LODs" for a four-part kit.
   */
  'lod_count',
  /**
   * The engines and tools the creator says it works in — ADR 0010 D12's own
   * example of a claim ("optimized for Unreal").
   *
   * Declared at `compatibility` SCOPE, so it can never become a variant axis
   * (see the module header).
   */
  'engine_compatibility',
  /**
   * The versions of those tools — "Blender 4.2+, Unity 2022 LTS+".
   *
   * Free text and unfiltered, because a version range is not a closed
   * vocabulary and a facet over one is the unbounded filter
   * `footwear_colorway` exists to warn about. The ENGINES are the controlled
   * half beside it; this is the precision a controlled value cannot carry.
   */
  'software_version_compatibility',
  /**
   * The deliverable configuration — the ONE variant axis (ADR 0010 D2).
   *
   * A claim rather than a measurement, and the difference is real: the files in
   * the box are measured, but which CONFIGURATION they constitute is the
   * creator's commercial decision about what they are selling.
   */
  'deliverable_configuration',

  /* ------------------------------ printable ------------------------------ */
  /**
   * Which print processes it suits — FDM, resin, SLS.
   *
   * A judgement, and the reason this vocabulary is claims at all: suitability
   * depends on wall thicknesses, overhangs and a material the platform never
   * sees, and a geometric analyzer that answered it would be presenting an
   * uncertain model as guaranteed printable (`docs/digital-commerce.md`
   * §"Where the 3D metadata lives").
   */
  'print_process_suitability',
  /**
   * The thinnest wall in the model, as the creator measured it.
   *
   * Listed in {@link THREE_D_RETIRABLE_CLAIM_ATTRIBUTE_KEYS}: it is the one
   * printable claim a future inspector could genuinely compute, and the day a
   * `minimum_wall_thickness_um` column lands this field must move sides in the
   * same change.
   */
  'minimum_wall_thickness',
  /** Whether supports are needed: not required, optional, required. */
  'support_requirement',
  /**
   * Whether a PRE-SUPPORTED file is included.
   *
   * Its own question rather than a fourth member of `support_requirement`,
   * because a model can both require supports and ship a pre-supported
   * variant, and one enum cannot say both. Unmeasurable: support structures are
   * geometry, indistinguishable from the model that needs them — unlike a
   * pre-sliced PROFILE, which has its own `ASSET_FILE_ROLES` member and is
   * therefore measured.
   */
  'presupported_files_included',
  /** Prints fully assembled, with no assembly step. */
  'print_in_place',
  /** Has moving joints when printed. */
  'articulated',
  /**
   * Recommended layer height, material and slicer notes, in the creator's own
   * words. Free text, unfiltered.
   */
  'print_recommendation_notes',
  /**
   * The printers the creator has actually printed it on — #1015 W3's *"as
   * claims, not global truth"*.
   *
   * `compatibility` scope and free text, and BOTH halves are deliberate. It is
   * not a resolved fitment relation: `automotive_fitments` is what a
   * Mercaria-resolved compatibility claim looks like, with a verification
   * state, a narrowest-scope-wins rule and an `unresolved` answer for an
   * ambiguous target — and routing a seller's anecdote through that machinery
   * would publish one person's successful print as a platform verdict for every
   * owner of that printer.
   */
  'tested_printers',
  /** The materials printed, on the same reasoning as `tested_printers`. */
  'tested_materials',
] as const;

/** One of {@link THREE_D_CLAIM_ATTRIBUTE_KEYS}. */
export type ThreeDClaimAttributeKey = (typeof THREE_D_CLAIM_ATTRIBUTE_KEYS)[number];

/**
 * Which half each claim belongs to. TOTAL, so a new claim cannot arrive without
 * somebody deciding whether it is a printing question.
 */
export const THREE_D_CLAIM_KIND_BY_KEY: Readonly<Record<ThreeDClaimAttributeKey, ThreeDClaimKind>> =
  {
    creator_credit: 'general',
    intended_use: 'general',
    texture_resolution: 'general',
    pbr_workflow: 'general',
    lod_count: 'general',
    engine_compatibility: 'general',
    software_version_compatibility: 'general',
    deliverable_configuration: 'general',
    print_process_suitability: 'printable',
    minimum_wall_thickness: 'printable',
    support_requirement: 'printable',
    presupported_files_included: 'printable',
    print_in_place: 'printable',
    articulated: 'printable',
    print_recommendation_notes: 'printable',
    tested_printers: 'printable',
    tested_materials: 'printable',
  };

/**
 * The claims that a future measurement would make WRONG, named now.
 *
 * Not a to-do list and not a defect: each is a fact no shipped processor
 * reports, so today a claim is the only honest home for it. What the list
 * records is the DECISION that has to be made when that changes — a claim
 * surviving beside a column measuring the same thing is the disagreement ADR
 * 0010 D12 is about, and the repository's own experience is that such a pair is
 * noticed years later by whoever is reading a contradictory product page.
 *
 * `three-d-profile-provenance.test.ts` holds the other half: every entry must
 * be a real claim key, and none may already be measured.
 */
export const THREE_D_RETIRABLE_CLAIM_ATTRIBUTE_KEYS: readonly ThreeDClaimAttributeKey[] = [
  'texture_resolution',
  'minimum_wall_thickness',
  'lod_count',
];

/**
 * The provenance of one fact name, or `undefined` for a name neither side owns.
 *
 * One function rather than two membership tests at every call site, and it
 * returns {@link AssetFactProvenance} — the tuple the digital domain already
 * has — so a renderer branches on the same two words the database does.
 * `undefined` is a real answer: an unknown key is not a claim, and answering
 * `seller_claimed` by default would make a typo render as something a seller
 * said.
 */
export function threeDFactProvenance(key: string): AssetFactProvenance | undefined {
  if ((THREE_D_MEASURED_FACTS as readonly string[]).includes(key)) return 'measured';
  if ((THREE_D_CLAIM_ATTRIBUTE_KEYS as readonly string[]).includes(key)) return 'seller_claimed';
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* What this module may never grow                                             */
/* -------------------------------------------------------------------------- */

/**
 * The SEVEN property names no shape in this module may declare, as VALUES so the
 * prohibition is testable (#1015 acceptance criterion 18).
 *
 * Every one of them is a property of a FORM rather than of a vocabulary. A
 * client holding `requirement` has the authoring rule; holding `flow` has the
 * audience; holding `groupKey` or `position` has the layout; holding `label` or
 * `helpText` has untranslated copy; holding `visibilityRule` has the form's
 * branching. All seven reach a client as an `AuthoringSchema` composed from the
 * database per locale, per market and per flow, and a copy in a published
 * package is the hard-coded product form this epic is arranged against.
 *
 * `PUBLIC_PRODUCT_TYPE_FORBIDDEN_LAYOUT_FIELDS` is the same device one layer
 * down, over an emitted specification layout. This list is deliberately its own
 * rather than a reuse: that one guards what a SERIALIZER may emit and carries a
 * row `id` among its five, while this guards what a STATIC REGISTRY may declare
 * and carries `groupKey`, `label` and `helpText`, which a layout legitimately
 * does.
 */
export const THREE_D_FORBIDDEN_PROFILE_SHAPES: readonly string[] = [
  'requirement',
  'flow',
  'groupKey',
  'position',
  'label',
  'helpText',
  'visibilityRule',
];
