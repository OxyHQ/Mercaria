import {
  PUBLICLY_VIEWABLE_ASSET_FILE_ROLES,
  type AssetFileRole,
  type AssetFileVisibility,
} from "@mercaria/shared-types";

/**
 * What the PUBLIC 3D viewer is allowed to render, as a type a caller cannot
 * forge (#1015 Workstream 4, ADR 0010; W12 threat 15).
 *
 * ## The rule this module exists to make unrepresentable
 *
 * > the public viewer must never require the paid source file to render.
 *
 * `PUBLICLY_VIEWABLE_ASSET_FILE_ROLES` is the server-side half of that rule —
 * two members, `preview` and `web_derivative`, and `digital-asset.ts` states
 * why each omission is load-bearing: a downloadable `mesh` IS the paid product
 * and a creator's `documentation` is part of what was bought. The usual client
 * half of such a rule is a `.filter()` inside the component, and that is the
 * shape this module refuses, for three reasons measured in this repository
 * rather than imagined:
 *
 * 1. A component that filters must be HANDED the whole file list, so the paid
 *    files reach the client to be filtered — and the defect then lives in
 *    whatever composed the response, where no component-level review sees it.
 * 2. A filter is one expression, so a refactor that widens it (`includes` to a
 *    truthiness check, an added `??`) type-checks, renders, and shows a mesh.
 * 3. A second filter appears the moment a second surface renders a preview, and
 *    two filters are two answers to "what may the public see".
 *
 * So {@link AssetPreviewViewer} takes an {@link AssetPreviewSource}, and the
 * ONLY way to obtain one is {@link admitAssetPreview}, which reads the shared
 * tuple and refuses everything else. The brand is a module-private symbol, so
 * there is no object literal a caller outside this file can write that
 * satisfies the type: passing a `mesh` or a `source` is a COMPILE error at the
 * call site rather than a runtime check somebody can relax.
 *
 * ## Role and visibility are two different questions, and both are asked
 *
 * `AssetFileVisibility` answers whether a file may LEAVE the platform, which is
 * independent of whether it may be RENDERED (#1015 W1 requirement 14). A
 * `web_derivative` is `preview_only`: the viewer streams it and no grant will
 * ever hand it over as a file, because a downloadable derivative is a free copy
 * of a paid mesh at lower fidelity. {@link isAssetPreviewFile} is therefore
 * false for it, and the viewer offers no save affordance.
 *
 * `rightful_download_only` is REFUSED outright even when the role would pass.
 * Nothing should ever produce that pairing — a preview is not a rightful
 * download — and the two readings of an unexpected pairing are "harmless data
 * error" and "a paid file arrived with a preview's role". Refusing is the only
 * one of those that is safe to be wrong about.
 *
 * ## What this module deliberately does not hold
 *
 * No URL composition, no storage key, no signing and no fetch. `uri` is handed
 * in already resolved by whatever authorized it server-side; this type carries
 * it so the viewer can render it, and carries nothing that could be turned into
 * a second way to reach a file.
 */

/**
 * The brand. Module-private on purpose: an exported brand is an object literal
 * anybody can write, which is the whole guarantee gone.
 */
const ASSET_PREVIEW_SOURCE: unique symbol = Symbol("mercaria.ui.assetPreviewSource");

/**
 * A preview the public viewer may render: already filtered to a publicly
 * viewable role, already authorized, already resolved to something renderable.
 *
 * Obtain one from {@link admitAssetPreview}. There is no other constructor.
 */
export interface AssetPreviewSource {
  readonly [ASSET_PREVIEW_SOURCE]: true;
  /** The `asset_files` row this preview is, for keys and for telemetry. */
  readonly fileId: string;
  /** Always a member of `PUBLICLY_VIEWABLE_ASSET_FILE_ROLES`. */
  readonly role: AssetFileRole;
  readonly visibility: AssetFileVisibility;
  /** A resolved, already-authorized address the renderer or `Image` may read. */
  readonly uri: string;
  /**
   * A STILL the viewer can show without a renderer — the accessible fallback
   * path, and what a mobile or reduced-capability surface gets.
   *
   * Absent for a `preview` still, which IS its own poster.
   */
  readonly posterUri?: string;
  /**
   * Named animations the derivative carries, in the creator's own order. EMPTY
   * when the work has none, which is why the viewer's animation selector is
   * absent rather than disabled in that case — a disabled control claims the
   * work has animations nobody may play.
   */
  readonly animations: readonly string[];
}

/** Why a candidate file may not be shown to the public. */
export type AssetPreviewRefusalReason =
  /** Its role is not in `PUBLICLY_VIEWABLE_ASSET_FILE_ROLES` — a paid file. */
  | "role_is_not_publicly_viewable"
  /** Its visibility says only a right holder may have it. */
  | "visibility_requires_a_right";

/** What a caller offers the viewer, before anything has been decided about it. */
export interface AssetPreviewCandidate {
  readonly fileId: string;
  readonly role: AssetFileRole;
  readonly visibility: AssetFileVisibility;
  readonly uri: string;
  readonly posterUri?: string;
  readonly animations?: readonly string[];
}

/**
 * The outcome of offering one file to the public viewer.
 *
 * A two-state union rather than `AssetPreviewSource | undefined`, because the
 * REASON is the thing a product page says out loud: "this file is part of the
 * purchase" is a sentence a buyer should read, and an `undefined` that means
 * both "there is no preview" and "we refused the one you offered" is how those
 * two get rendered as the same empty box.
 */
export type AssetPreviewAdmission =
  | { readonly kind: "admitted"; readonly source: AssetPreviewSource }
  | { readonly kind: "refused"; readonly reason: AssetPreviewRefusalReason };

/**
 * Whether a role may be shown to a caller holding no right.
 *
 * Reads the shared tuple; it does not restate it. A third member added to
 * `PUBLICLY_VIEWABLE_ASSET_FILE_ROLES` is admitted here the day it lands, and a
 * member removed from it is refused here the same day — which is the property a
 * local copy of the two names would not have.
 */
export function isPubliclyViewableAssetRole(role: AssetFileRole): boolean {
  return PUBLICLY_VIEWABLE_ASSET_FILE_ROLES.includes(role);
}

/**
 * Admit a file to the public viewer, or refuse it and say why.
 *
 * Pure, so `scripts/` can run it: this package has no test runner and the
 * property it holds is the one #1015 acceptance criterion 10 is about.
 */
export function admitAssetPreview(candidate: AssetPreviewCandidate): AssetPreviewAdmission {
  if (!isPubliclyViewableAssetRole(candidate.role)) {
    return { kind: "refused", reason: "role_is_not_publicly_viewable" };
  }
  if (candidate.visibility === "rightful_download_only") {
    return { kind: "refused", reason: "visibility_requires_a_right" };
  }
  return {
    kind: "admitted",
    source: {
      [ASSET_PREVIEW_SOURCE]: true,
      fileId: candidate.fileId,
      role: candidate.role,
      visibility: candidate.visibility,
      uri: candidate.uri,
      ...(candidate.posterUri === undefined ? {} : { posterUri: candidate.posterUri }),
      animations: candidate.animations ?? [],
    },
  };
}

/**
 * What KIND of preview this is, so the viewer can choose a path without reading
 * a role name in a render branch.
 *
 * `still` is an image and needs no renderer. `streamed_model` needs one, which
 * is the seam {@link AssetPreviewViewer} documents — and in its absence the
 * still fallback is what renders, never the model.
 */
export function assetPreviewKind(source: AssetPreviewSource): "still" | "streamed_model" {
  return source.role === "web_derivative" ? "streamed_model" : "still";
}

/**
 * Whether this preview may be handed over as a FILE.
 *
 * True only for `public_download`. A `preview_only` derivative is streamed and
 * never saved (ADR 0010; `ASSET_FILE_VISIBILITIES`), so a viewer that offered a
 * save affordance for one would be publishing a free, lower-fidelity copy of
 * the paid mesh.
 */
export function isAssetPreviewFile(source: AssetPreviewSource): boolean {
  return source.visibility === "public_download";
}
