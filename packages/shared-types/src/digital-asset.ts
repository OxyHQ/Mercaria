/**
 * The digital DELIVERABLE — an asset, its immutable versions, the files inside
 * one and the packages an offer actually sells (#1015 Workstream 1, ADR 0010).
 *
 * This module is vocabulary only: every tuple here is a machine name a Postgres
 * CHECK is rendered from, the `ALL_CURRENCY_CODES` device. Display copy lives in
 * `@mercaria/ui` and may change at any time.
 *
 * ## The four nouns, and why none of them collapses into another
 *
 * - **Asset** — the creative work as a commercial identity. It is what a buyer
 *   thinks they bought and what a creator publishes updates to. It owns no
 *   bytes.
 * - **Version** — one IMMUTABLE release of that work. Bytes belong to a version,
 *   never to the asset, which is the whole of ADR 0010 D4: publishing v2 cannot
 *   change what v1 was, because v1's rows are not the rows v2 writes.
 * - **File** — one stored binary belonging to one version, with its measured
 *   size, media type and content hash. A file is reached through a PRIVATE
 *   storage reference; see {@link AssetFileVisibility}.
 * - **Package** — the named deliverable an offer sells: a SUBSET of one
 *   version's files, assembled by the creator. `printable`, `game-ready` and
 *   `source-files` are packages, and they are why #1015 boundary 6 holds —
 *   several formats belong to one purchased thing, so a format is not a variant.
 *
 * ## What is deliberately NOT here
 *
 * **No public URL, and no column that could become one.** #1015 boundary 3: a
 * file URL is never the buyer's ownership record. The storage reference is
 * opaque and server-side; what a client receives is a short-lived grant minted
 * after authorization (`digital-right.ts`). `digital-commerce-walls.test.ts`
 * fails the build on a `*_url` column in the digital schema.
 *
 * **No price and no currency.** An asset is not an offer. What something costs
 * is the catalogue's answer (offers, listings, the pricing engine), and a price
 * on an asset would be a second one that can disagree.
 *
 * **No stock.** #1015 boundary 1: a digital product is not represented by fake
 * stock. A digital variant is `inventoryTracked = false` and ADR 0010 D12 states
 * what that means here — not "the count is unknown" but "counting is the wrong
 * question" — which is the distinction `docs/commerce-types.md` warned would be
 * waved past.
 *
 * **No training-use flag.** ADR 0010 D14: the default is no training use, and it
 * is not a per-asset column a UI could flip. A column would imply the other
 * value exists; it does not, and it cannot until a separate explicit contract
 * does.
 */

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Where an asset version is in its life.
 *
 * Ordered as it is travelled, and NOT a superset of the listing lifecycle: a
 * version is `published` when its bytes are complete, inspected and sellable,
 * which is a different question from whether a listing referencing it is
 * `active`. Two lifecycles that look similar are the reason this tuple is its
 * own rather than a reuse of `LISTING_STATUSES`.
 *
 * - `draft` — the creator is still assembling it; no file is required yet.
 * - `processing` — files are uploaded and the inspection pipeline is running.
 *   A version may not be published from here, because the measured metadata a
 *   product page renders does not exist yet (#1015 W4).
 * - `review` — held for human or automated review before publication.
 * - `published` — sellable and downloadable by a right that covers it.
 * - `superseded` — a later version is current. STILL DOWNLOADABLE: a buyer who
 *   bought this version keeps it (ADR 0010 D7), so this is not a withdrawal.
 * - `restricted` — moderation has closed it. Not downloadable, not deleted.
 * - `withdrawn` — the creator has taken it off sale. Prior buyers keep access
 *   (ADR 0010 D7); what stops is new acquisition.
 */
export const ASSET_VERSION_STATES = [
  'draft',
  'processing',
  'review',
  'published',
  'superseded',
  'restricted',
  'withdrawn',
] as const;

/** One of {@link ASSET_VERSION_STATES}. */
export type AssetVersionState = (typeof ASSET_VERSION_STATES)[number];

/**
 * The version states from which a download may be authorized.
 *
 * Derived, never retyped: `superseded` and `withdrawn` are IN the set and that
 * is the load-bearing half — a buyer's right survives both (ADR 0010 D7), and a
 * set that listed only `published` would revoke every historical purchase the
 * moment a creator shipped an update.
 */
export const DOWNLOADABLE_ASSET_VERSION_STATES: readonly AssetVersionState[] = [
  'published',
  'superseded',
  'withdrawn',
];

/**
 * The version states a NEW acquisition may name.
 *
 * The complement of the set above minus `superseded` and `withdrawn` — one
 * member, deliberately. Nothing may be sold out of `draft`, `processing`,
 * `review` or `restricted`, and nothing may be sold out of a version the
 * creator has retired.
 */
export const ACQUIRABLE_ASSET_VERSION_STATES: readonly AssetVersionState[] = ['published'];

/**
 * Whether an asset itself is available for new acquisition.
 *
 * Separate from the version lifecycle because the two answer different
 * questions and #402's laundering bug is what happens when one column is asked
 * to answer both: an asset may be `listed` while its newest version is still
 * `processing`, and an asset may be `restricted` while every version it owns is
 * `published`.
 */
export const DIGITAL_ASSET_STATES = [
  'draft',
  'listed',
  'unlisted',
  'restricted',
  'withdrawn',
] as const;

/** One of {@link DIGITAL_ASSET_STATES}. */
export type DigitalAssetState = (typeof DIGITAL_ASSET_STATES)[number];

/* -------------------------------------------------------------------------- */
/* Files                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What one file IS within its version.
 *
 * A semantic role, not a format: a `.png` is a `texture` in one version and a
 * `preview` in another, and the format alone cannot tell them apart. This is
 * what lets the download authorizer answer "may this caller see this file"
 * without parsing anything (#1015 W12 threat 15).
 *
 * `preview` and `web_derivative` are the only roles a caller with NO right may
 * be shown, and {@link PUBLICLY_VIEWABLE_ASSET_FILE_ROLES} is that set stated
 * once so two code paths cannot disagree.
 */
export const ASSET_FILE_ROLES = [
  /** The creator's editable original — the thing a licence most restricts. */
  'source',
  /** Geometry a buyer uses directly: STL, 3MF, OBJ, FBX, GLB. */
  'mesh',
  /** A texture, material or map accompanying a mesh. */
  'texture',
  /** A still image or turntable shown on the product page. */
  'preview',
  /** A generated, deliberately lower-fidelity model the public viewer renders. */
  'web_derivative',
  /** A readme, licence text, printing notes, changelog. */
  'documentation',
  /** A slicer or engine profile the creator supplies. */
  'profile',
  /** A companion archive whose contents are the creator's own arrangement. */
  'archive',
] as const;

/** One of {@link ASSET_FILE_ROLES}. */
export type AssetFileRole = (typeof ASSET_FILE_ROLES)[number];

/**
 * The file roles a caller holding NO right may be served.
 *
 * Two members, and the omissions are the point: `mesh` is absent because a
 * downloadable mesh IS the paid product, and `documentation` is absent because
 * a creator's printing notes are part of what was bought. #1015 acceptance
 * criterion 7 is this tuple plus the authorizer that reads it.
 */
export const PUBLICLY_VIEWABLE_ASSET_FILE_ROLES: readonly AssetFileRole[] = [
  'preview',
  'web_derivative',
];

/**
 * Whether a file may leave the platform at all, independently of whether it may
 * be RENDERED.
 *
 * Two separate questions, per #1015 W1 requirement 14. A `web_derivative` is
 * `preview_only`: the public viewer streams it and no grant will ever hand it
 * over as a file, because a downloadable derivative is a free copy of a paid
 * mesh at lower fidelity. A `source` is `rightful_download_only`.
 */
export const ASSET_FILE_VISIBILITIES = [
  'preview_only',
  'rightful_download_only',
  'public_download',
] as const;

/** One of {@link ASSET_FILE_VISIBILITIES}. */
export type AssetFileVisibility = (typeof ASSET_FILE_VISIBILITIES)[number];

/* -------------------------------------------------------------------------- */
/* The format registry                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every asset format Mercaria knows, as a CAPABILITY row rather than a bare
 * name (#1015 W1: *"use a typed format registry/capability model"*).
 *
 * The registry is what stops the digital marketplace being hard-coded to 3D.
 * A format declares what can be DERIVED from it; a vertical that adds fonts or
 * audio adds rows, and neither the inspection pipeline nor the product page
 * learns a new branch.
 */
export interface AssetFormatCapability {
  /** Stable machine key; the CHECK on `asset_files.format` reads these. */
  readonly key: string;
  /** The IANA media type to store, or `application/octet-stream` when none is registered. */
  readonly mediaType: string;
  /** Conventional extensions, lowercased and without the dot. */
  readonly extensions: readonly string[];
  /** Which vertical this belongs to, so a feature flag can disable one. */
  readonly vertical: DigitalVertical;
  /** Whether a geometry inspector can measure counts and a bounding box. */
  readonly geometryMeasurable: boolean;
  /** Whether a `web_derivative` can be generated from it. */
  readonly webDerivable: boolean;
  /**
   * Whether the format is a CONTAINER whose members are not known until it is
   * opened — the zip-bomb and path-traversal surface (#1015 W12 threats 5, 6).
   * A container is always inspected in the sandbox with a file-count and
   * expansion ceiling, never trusted.
   */
  readonly container: boolean;
}

/**
 * The digital verticals this foundation is built to carry.
 *
 * `three_d` is the launch vertical and the rest are declared rather than built,
 * which is #1015 acceptance criterion 20 made checkable: a second profile
 * package must not need a second commerce stack, and the way to prove the seam
 * exists is for the enum to already admit one.
 */
export const DIGITAL_VERTICALS = [
  'three_d',
  'game_asset',
  'font',
  'icon_pack',
  'design_template',
  'audio',
  'document',
  'software',
] as const;

/** One of {@link DIGITAL_VERTICALS}. */
export type DigitalVertical = (typeof DIGITAL_VERTICALS)[number];

/**
 * The launch registry.
 *
 * 3D only, and every row is a format #1015 W1 names. `blend` is
 * `geometryMeasurable: false` deliberately: measuring it needs Blender itself in
 * the worker, which is a whole-application parser on hostile input (#1015 W12
 * threat 7), and a registry that claimed otherwise would have the pipeline
 * reporting zero triangles as a measurement rather than as an absence.
 */
export const ASSET_FORMAT_REGISTRY: readonly AssetFormatCapability[] = [
  {
    key: 'stl',
    mediaType: 'model/stl',
    extensions: ['stl'],
    vertical: 'three_d',
    geometryMeasurable: true,
    webDerivable: true,
    container: false,
  },
  {
    key: '3mf',
    mediaType: 'model/3mf',
    extensions: ['3mf'],
    vertical: 'three_d',
    geometryMeasurable: true,
    webDerivable: true,
    container: true,
  },
  {
    key: 'obj',
    mediaType: 'model/obj',
    extensions: ['obj'],
    vertical: 'three_d',
    geometryMeasurable: true,
    webDerivable: true,
    container: false,
  },
  {
    key: 'gltf',
    mediaType: 'model/gltf+json',
    extensions: ['gltf'],
    vertical: 'three_d',
    geometryMeasurable: true,
    webDerivable: true,
    container: false,
  },
  {
    key: 'glb',
    mediaType: 'model/gltf-binary',
    extensions: ['glb'],
    vertical: 'three_d',
    geometryMeasurable: true,
    webDerivable: true,
    container: false,
  },
  {
    key: 'fbx',
    mediaType: 'application/octet-stream',
    extensions: ['fbx'],
    vertical: 'three_d',
    geometryMeasurable: true,
    webDerivable: true,
    container: false,
  },
  {
    key: 'blend',
    mediaType: 'application/x-blender',
    extensions: ['blend'],
    vertical: 'three_d',
    geometryMeasurable: false,
    webDerivable: false,
    container: true,
  },
  {
    key: 'png',
    mediaType: 'image/png',
    extensions: ['png'],
    vertical: 'three_d',
    geometryMeasurable: false,
    webDerivable: false,
    container: false,
  },
  {
    key: 'jpeg',
    mediaType: 'image/jpeg',
    extensions: ['jpg', 'jpeg'],
    vertical: 'three_d',
    geometryMeasurable: false,
    webDerivable: false,
    container: false,
  },
  {
    key: 'zip',
    mediaType: 'application/zip',
    extensions: ['zip'],
    vertical: 'three_d',
    geometryMeasurable: false,
    webDerivable: false,
    container: true,
  },
  {
    key: 'pdf',
    mediaType: 'application/pdf',
    extensions: ['pdf'],
    vertical: 'three_d',
    geometryMeasurable: false,
    webDerivable: false,
    container: false,
  },
];

/** The format keys the CHECK on `asset_files.format` is rendered from. */
export const ASSET_FORMAT_KEYS: readonly string[] = ASSET_FORMAT_REGISTRY.map(
  (format) => format.key,
);

/** The one registry lookup, so no call site builds its own map. */
export function assetFormatCapability(key: string): AssetFormatCapability | undefined {
  return ASSET_FORMAT_REGISTRY.find((format) => format.key === key);
}

/* -------------------------------------------------------------------------- */
/* Inspection and scanning                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the asynchronous inspection pipeline concluded about one file (#1015 W4).
 *
 * `unsupported` is NOT a failure: a `.blend` cannot be measured and saying so
 * is the honest result. It exists so the product page can distinguish "we did
 * not measure this" from "we measured it and it is empty", which #1015 W4's
 * closing rule — *"do not overclaim machine-generated validation"* — turns on.
 */
export const ASSET_INSPECTION_VERDICTS = [
  'pending',
  'measured',
  'unsupported',
  'corrupt',
  'missing_resources',
  'failed',
  'refused_too_large',
] as const;

/** One of {@link ASSET_INSPECTION_VERDICTS}. */
export type AssetInspectionVerdict = (typeof ASSET_INSPECTION_VERDICTS)[number];

/**
 * What the malware scanner concluded (#1015 W1 requirement 12, W12 threat 5).
 *
 * A version may not be published while any of its files is `pending` or
 * `error`: an unscanned file reaching a buyer is the one failure no later fix
 * repairs.
 */
export const ASSET_SCAN_VERDICTS = ['pending', 'clean', 'infected', 'error'] as const;

/** One of {@link ASSET_SCAN_VERDICTS}. */
export type AssetScanVerdict = (typeof ASSET_SCAN_VERDICTS)[number];

/** The only scan verdict a publishable file may carry. */
export const PUBLISHABLE_ASSET_SCAN_VERDICTS: readonly AssetScanVerdict[] = ['clean'];

/**
 * The inspection verdicts a publishable file may carry.
 *
 * The scan gate's sibling, and it was missing: `PUBLISHABLE_ASSET_SCAN_VERDICTS`
 * only asks whether a file is MALICIOUS, so a `corrupt` one — an `.stl` whose
 * header declares more triangles than the file holds, a `.3mf` part with no
 * `<model>` root — was publishable the moment a scanner called it clean. Nothing
 * else stood between that file and a buyer.
 *
 * Each membership is a decision rather than a default:
 *
 * - `measured` — inspected and understood. The ordinary case.
 * - `unsupported` — PUBLISHABLE, and this is the important one. `blend`, `fbx`,
 *   `pdf` and every raster are legitimate deliverables that this processor
 *   version cannot measure (`ASSET_FORMAT_REGISTRY.geometryMeasurable` says so for
 *   most of them). Blocking on it would make half the registry unsellable in order
 *   to express "we did not look".
 * - `missing_resources` — PUBLISHABLE, and the one genuine judgement call. An OBJ
 *   naming an absent `.mtl`, a 3MF naming an absent texture part: the platform
 *   cannot tell a forgotten upload from a reference the creator means to satisfy
 *   externally, and blocking on a guess makes legitimate packs unpublishable with
 *   no override. It is DISCLOSED instead — it is a measured fact the technical
 *   panel renders before a purchase — which is what makes withholding the block
 *   honest rather than lenient.
 * - `pending` — blocked. Nothing has looked at the file yet.
 * - `corrupt` — blocked. The file is not what it says it is.
 * - `failed` — blocked. Inspection itself could not run, so there is no evidence
 *   either way, and "we could not look" must not read like "we looked and it was
 *   fine".
 * - `refused_too_large` — blocked. Above the inspection ceiling, so also above
 *   what any later measurement will manage.
 *
 * A blocked verdict is not permanent: re-inspection writes a new row, so a
 * creator's remedy is to fix the file and let the pipeline run again.
 */
export const PUBLISHABLE_ASSET_INSPECTION_VERDICTS: readonly AssetInspectionVerdict[] = [
  'measured',
  'unsupported',
  'missing_resources',
];

/**
 * Whether a stated fact was MEASURED by Mercaria or CLAIMED by the seller.
 *
 * #1015 W4: *"store measured metadata separately from seller claims"*. The two
 * provenances are separate columns on separate tables rather than one field
 * with a flag, because a flag is a thing a write path can get wrong and a table
 * boundary is not. `@mercaria/ui` renders them differently and must be able to.
 */
export const ASSET_FACT_PROVENANCES = ['measured', 'seller_claimed'] as const;

/** One of {@link ASSET_FACT_PROVENANCES}. */
export type AssetFactProvenance = (typeof ASSET_FACT_PROVENANCES)[number];

/* -------------------------------------------------------------------------- */
/* Provenance and re-upload evidence                                           */
/* -------------------------------------------------------------------------- */

/**
 * The privacy-safe provenance signals retained at upload (#1015 W8).
 *
 * Each is EVIDENCE and none is proof of ownership — W8's own first requirement,
 * and the reason this tuple carries a `kind` rather than a `match` boolean. A
 * geometry fingerprint that matches tells a reviewer where to look; it does not
 * decide a copyright question, and nothing in this domain may act on one
 * automatically.
 */
export const ASSET_PROVENANCE_SIGNAL_KINDS = [
  /** SHA-256 of the stored bytes. An exact-duplicate detector and nothing more. */
  'content_hash',
  /** A normalized geometry fingerprint, for re-exports that change the bytes. */
  'geometry_fingerprint',
  /** A perceptual hash of a generated preview. */
  'preview_phash',
  /** The creator's own assertion about where the work came from. */
  'creator_declaration',
  /** A prior publication the creator supplied, so a true original can say so. */
  'prior_publication',
] as const;

/** One of {@link ASSET_PROVENANCE_SIGNAL_KINDS}. */
export type AssetProvenanceSignalKind = (typeof ASSET_PROVENANCE_SIGNAL_KINDS)[number];
