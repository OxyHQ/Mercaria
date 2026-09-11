import type {
  AssetInspectionVerdict,
  AssetRightStatus,
  DigitalLicenceAttributionMode,
  DigitalLicenceAuthorship,
  DigitalLicenceRight,
  DigitalLicenceUpdatePolicy,
} from "@mercaria/shared-types";
import type { AssetPreviewRefusalReason } from "./asset-preview";

/**
 * The reader-facing copy for digital commerce (#1015, ADR 0010) — as
 * TRANSLATION KEYS, never sentences.
 *
 * Same split as `./condition`, `./offer-labels` and `./pickup-labels`, for the
 * same two reasons: a stored key is what a column, a CHECK and a wire contract
 * carry while a sentence is what a person reads, and only one of the two may
 * change without a contract change; and module-scope data evaluated at import
 * cannot call `t()`, so a sentence here would freeze into whichever language
 * loaded first (`docs/app-i18n.md` §"Rules that are load-bearing").
 *
 * Every map is an exhaustive `Record` over its `@mercaria/shared-types` union,
 * which is the property that makes this worth doing at all: a ninth
 * `DigitalLicenceRight` or a sixth `AssetRightStatus` fails THIS package's
 * typecheck rather than rendering a blank row in a buyer's library or, worse,
 * rendering the machine name — which `validate:i18n-strings` check J counts as
 * a defect precisely because the English is generated at runtime and no
 * literal-based check can find it.
 *
 * ## The two provenances are two different VOICES, and the copy says so
 *
 * ADR 0010 D12 keeps what Mercaria MEASURED (`asset_file_inspections`, with the
 * processor name and version that produced it) in a different table from what a
 * seller CLAIMED (a product-type attribute value), because one table with a
 * provenance flag lets a write path set the flag wrongly and a table boundary
 * cannot be confused. The rendering half of that decision is here: every
 * measured row is attributed to a named processor, every claimed row is
 * attributed to the seller, and neither sentence is reachable from the other's
 * map. "42,180 triangles" and "optimized for Unreal" are both true statements
 * about a model and only one of them is Mercaria's.
 *
 * ## Nothing here overclaims a measurement (#1015 W4's closing rule)
 *
 * `ASSET_INSPECTION_VERDICTS` has seven members and `unsupported` is NOT a
 * failure — a `.blend` cannot be measured and saying so is the honest result.
 * So there is a sentence per verdict rather than a present/absent branch, and
 * {@link ASSET_FACTS_NOT_MEASURED_KEY} is what a NULL geometry column renders:
 * a zero triangle count and an unmeasured one are different facts, and a
 * watertightness nobody determined is never rendered as "no".
 */

/* -------------------------------------------------------------------------- */
/* The public preview and its viewer                                           */
/* -------------------------------------------------------------------------- */

/** The accessible name of the preview surface: `Preview of %{title}`. */
export const ASSET_VIEWER_PREVIEW_A11Y_KEY = "ui.assetViewer.previewA11y";
/** Nothing public exists to show — not a refusal, an absence. */
export const ASSET_VIEWER_NO_PREVIEW_KEY = "ui.assetViewer.noPreview";
/** A still is being shown because no interactive renderer is installed. */
export const ASSET_VIEWER_STATIC_ONLY_KEY = "ui.assetViewer.staticOnly";
/** A still is being shown because the screen is too small to orbit a model. */
export const ASSET_VIEWER_STATIC_SMALL_SCREEN_KEY = "ui.assetViewer.staticOnSmallScreen";
/**
 * The honesty line #1015 W4 closes with, stated to the BUYER rather than only
 * in a docblock: what they are looking at is a generated copy, so a preview
 * that looks lower-fidelity than the product is not a defect in the product.
 */
export const ASSET_VIEWER_NEVER_SOURCE_KEY = "ui.assetViewer.neverTheSourceFile";
/** `ASSET_FILE_VISIBILITIES.preview_only`: streamed, never handed over. */
export const ASSET_VIEWER_STREAMED_ONLY_KEY = "ui.assetViewer.streamedOnly";
/** The accessible group name for the control row. */
export const ASSET_VIEWER_CONTROLS_KEY = "ui.assetViewer.controls";
/** What the pointer and touch gestures do, for a reader who cannot discover it. */
export const ASSET_VIEWER_GESTURES_KEY = "ui.assetViewer.gestures";
export const ASSET_VIEWER_RESET_KEY = "ui.assetViewer.reset";
export const ASSET_VIEWER_FULLSCREEN_OPEN_KEY = "ui.assetViewer.fullscreenOpen";
export const ASSET_VIEWER_FULLSCREEN_CLOSE_KEY = "ui.assetViewer.fullscreenClose";
export const ASSET_VIEWER_WIREFRAME_KEY = "ui.assetViewer.wireframe";
export const ASSET_VIEWER_STATISTICS_KEY = "ui.assetViewer.statistics";
export const ASSET_VIEWER_ANIMATION_KEY = "ui.assetViewer.animation";
/** The "play nothing" choice in the animation selector. */
export const ASSET_VIEWER_ANIMATION_OFF_KEY = "ui.assetViewer.animationOff";

/**
 * Why a file offered to the public viewer was refused.
 *
 * Rendered rather than swallowed: "this file is part of the purchase" is a
 * sentence a buyer should read, and an empty frame that means both "there is no
 * preview" and "we refused the file you offered" is how those get conflated.
 */
export const ASSET_PREVIEW_REFUSAL_KEYS: Readonly<
  Record<AssetPreviewRefusalReason, string>
> = {
  role_is_not_publicly_viewable: "ui.assetViewer.refused.role_is_not_publicly_viewable",
  visibility_requires_a_right: "ui.assetViewer.refused.visibility_requires_a_right",
};

/* -------------------------------------------------------------------------- */
/* Measured facts versus seller claims (ADR 0010 D12)                          */
/* -------------------------------------------------------------------------- */

/** Heading over the figures MERCARIA produced. */
export const ASSET_FACTS_MEASURED_TITLE_KEY = "ui.assetFacts.measuredTitle";
/** One sentence saying who measured them and from what. */
export const ASSET_FACTS_MEASURED_NOTE_KEY = "ui.assetFacts.measuredNote";
/** `Measured with %{processor} %{version} on %{date}` — the provenance itself. */
export const ASSET_FACTS_MEASURED_BY_KEY = "ui.assetFacts.measuredBy";
/** The per-row marker, so the provenance survives a reader who skips headings. */
export const ASSET_FACTS_MEASURED_BADGE_KEY = "ui.assetFacts.measuredBadge";
/** Heading over what the SELLER wrote. */
export const ASSET_FACTS_CLAIMED_TITLE_KEY = "ui.assetFacts.claimedTitle";
/** One sentence saying Mercaria has not checked them. */
export const ASSET_FACTS_CLAIMED_NOTE_KEY = "ui.assetFacts.claimedNote";
/** The per-row marker for a claim. */
export const ASSET_FACTS_CLAIMED_BADGE_KEY = "ui.assetFacts.claimedBadge";
/**
 * What a NULL geometry column renders.
 *
 * ADR 0010 D12: every geometry column is nullable and NULL means NOT MEASURED,
 * which is why a `0` and an absence must not share a rendering.
 */
export const ASSET_FACTS_NOT_MEASURED_KEY = "ui.assetFacts.notMeasured";

/** What the inspection pipeline concluded, in the reader's own words. */
export const ASSET_INSPECTION_VERDICT_KEYS: Readonly<
  Record<AssetInspectionVerdict, string>
> = {
  pending: "ui.assetFacts.verdict.pending",
  measured: "ui.assetFacts.verdict.measured",
  unsupported: "ui.assetFacts.verdict.unsupported",
  corrupt: "ui.assetFacts.verdict.corrupt",
  missing_resources: "ui.assetFacts.verdict.missing_resources",
  failed: "ui.assetFacts.verdict.failed",
  refused_too_large: "ui.assetFacts.verdict.refused_too_large",
};

/* -------------------------------------------------------------------------- */
/* The licence (#1015 W2, ADR 0010 D3/D4)                                      */
/* -------------------------------------------------------------------------- */

export const ASSET_LICENCE_TITLE_KEY = "ui.assetLicence.title";
/** Heading over the rights the version GRANTS. */
export const ASSET_LICENCE_GRANTED_TITLE_KEY = "ui.assetLicence.grantedTitle";
/**
 * Heading over the rights it does not.
 *
 * Rendered because `DIGITAL_LICENCE_RIGHTS` is a default-DENY vocabulary (#1015
 * W2 requirement 6): a right is forbidden by being ABSENT, and a page that
 * listed only the grants would leave "may I redistribute the files?" answered by
 * silence. The complement is derived from the shared tuple, never listed here.
 */
export const ASSET_LICENCE_NOT_GRANTED_TITLE_KEY = "ui.assetLicence.notGrantedTitle";
export const ASSET_LICENCE_ATTRIBUTION_TITLE_KEY = "ui.assetLicence.attributionTitle";
export const ASSET_LICENCE_UPDATES_TITLE_KEY = "ui.assetLicence.updatesTitle";
export const ASSET_LICENCE_LIMITS_TITLE_KEY = "ui.assetLicence.limitsTitle";
/** Heading over `DigitalLicenceVersionTerms.additionalTerms`, shown verbatim. */
export const ASSET_LICENCE_ADDITIONAL_TERMS_TITLE_KEY = "ui.assetLicence.additionalTermsTitle";
/** `Up to %{seats} people` — the bounded case. */
export const ASSET_LICENCE_SEATS_KEY = "ui.assetLicence.seats";
/** The `null` case, which ADR 0010 notes is the ORDINARY one. */
export const ASSET_LICENCE_SEATS_UNLIMITED_KEY = "ui.assetLicence.seatsUnlimited";
export const ASSET_LICENCE_PROJECTS_KEY = "ui.assetLicence.projects";
export const ASSET_LICENCE_PROJECTS_UNLIMITED_KEY = "ui.assetLicence.projectsUnlimited";
export const ASSET_LICENCE_REVENUE_KEY = "ui.assetLicence.revenue";
export const ASSET_LICENCE_REVENUE_UNLIMITED_KEY = "ui.assetLicence.revenueUnlimited";

/** Every right a licence version may grant, as a buyer would say it. */
export const DIGITAL_LICENCE_RIGHT_KEYS: Readonly<Record<DigitalLicenceRight, string>> = {
  personal_use: "ui.assetLicence.right.personal_use",
  commercial_project_use: "ui.assetLicence.right.commercial_project_use",
  commercial_physical_production: "ui.assetLicence.right.commercial_physical_production",
  modification: "ui.assetLicence.right.modification",
  derivative_redistribution: "ui.assetLicence.right.derivative_redistribution",
  source_redistribution: "ui.assetLicence.right.source_redistribution",
  sublicensing: "ui.assetLicence.right.sublicensing",
  extended_enterprise_use: "ui.assetLicence.right.extended_enterprise_use",
};

/**
 * Whether credit is required, welcome or waived.
 *
 * Three sentences rather than two, because `not_required` and
 * `must_not_be_required` are different statements — see
 * `DIGITAL_LICENCE_ATTRIBUTION_MODES`. The tuple ships three members today and
 * this `Record` is what makes a fourth a compile error here.
 */
export const DIGITAL_LICENCE_ATTRIBUTION_KEYS: Readonly<
  Record<DigitalLicenceAttributionMode, string>
> = {
  required: "ui.assetLicence.attribution.required",
  optional: "ui.assetLicence.attribution.optional",
  not_required: "ui.assetLicence.attribution.not_required",
};

/**
 * What a later version costs, which is the OPTION's answer and not the
 * platform's (ADR 0010 D4).
 *
 * `same_major_version` deliberately does not promise a number: a creator
 * numbering releases `spring-2026` gets major 0 for all of them, so the policy
 * behaves as `purchased_version_only` for them. The sentence describes the rule
 * rather than predicting which releases will satisfy it.
 */
export const DIGITAL_LICENCE_UPDATE_POLICY_KEYS: Readonly<
  Record<DigitalLicenceUpdatePolicy, string>
> = {
  purchased_version_only: "ui.assetLicence.updatePolicy.purchased_version_only",
  same_major_version: "ui.assetLicence.updatePolicy.same_major_version",
  all_future_versions: "ui.assetLicence.updatePolicy.all_future_versions",
};

/** Whose text this is — Mercaria's reference licence or the creator's own. */
export const DIGITAL_LICENCE_AUTHORSHIP_KEYS: Readonly<
  Record<DigitalLicenceAuthorship, string>
> = {
  mercaria_reference: "ui.assetLicence.authorship.mercaria_reference",
  creator: "ui.assetLicence.authorship.creator",
};

/* -------------------------------------------------------------------------- */
/* The buyer's library (#1015 W9)                                              */
/* -------------------------------------------------------------------------- */

export const ASSET_LIBRARY_FILES_TITLE_KEY = "ui.assetLibrary.filesTitle";
export const ASSET_LIBRARY_DOWNLOAD_ACTION_KEY = "ui.assetLibrary.downloadAction";
/** `Download %{file}` — the announced label, which names the file. */
export const ASSET_LIBRARY_DOWNLOAD_A11Y_KEY = "ui.assetLibrary.downloadA11y";
/** A `preview_only` file: rendered, never handed over. */
export const ASSET_LIBRARY_NOT_DOWNLOADABLE_KEY = "ui.assetLibrary.notDownloadable";
/**
 * Why the download controls are absent.
 *
 * Interpolates the STATUS LABEL, which check F permits and is measured about: a
 * badge is a term and reads correctly in an appositive frame, unlike an action
 * control's label (`docs/app-i18n.md` §F). `DOWNLOAD_AUTHORIZING_ASSET_RIGHT_STATUSES`
 * is the one member list this branch reads, so the library and the authorizer
 * cannot disagree about what a held right may do.
 */
export const ASSET_LIBRARY_DOWNLOADS_PAUSED_KEY = "ui.assetLibrary.downloadsPaused";
export const ASSET_LIBRARY_GRANTED_ON_KEY = "ui.assetLibrary.grantedOn";
export const ASSET_LIBRARY_LICENCE_KEY = "ui.assetLibrary.licence";
/** The version the purchase PINNED — never the asset's newest. */
export const ASSET_LIBRARY_PURCHASED_VERSION_KEY = "ui.assetLibrary.purchasedVersion";
/** The newest version this right actually covers, per its update policy. */
export const ASSET_LIBRARY_AVAILABLE_VERSION_KEY = "ui.assetLibrary.availableVersion";
export const ASSET_LIBRARY_UPDATE_AVAILABLE_KEY = "ui.assetLibrary.updateAvailable";

/**
 * Whether a right authorizes a download, and what it means when it does not.
 *
 * Every member is a state a buyer can be in and none of them is a deletion:
 * ADR 0010 D6 gives `asset_rights` no delete path, so a refunded or disputed
 * purchase is still ON this screen with its status stated. A library that
 * dropped the row would leave a buyer unable to tell a reversed purchase from
 * one that never happened.
 */
export const ASSET_RIGHT_STATUS_KEYS: Readonly<Record<AssetRightStatus, string>> = {
  active: "ui.assetLibrary.status.active",
  refunded: "ui.assetLibrary.status.refunded",
  disputed_hold: "ui.assetLibrary.status.disputed_hold",
  revoked_for_policy: "ui.assetLibrary.status.revoked_for_policy",
  superseded: "ui.assetLibrary.status.superseded",
};
