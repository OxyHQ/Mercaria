/**
 * What a BUYER owns after paying — the ownership half of #1015 Workstream 2
 * (ADR 0010 D5, D6, D8).
 *
 * ## The name, and why it is not "entitlement"
 *
 * #1015 W2 opens by requiring a buyer digital-rights domain *"separate from #89
 * merchant-plan entitlements"*, and its own suggested names (`DigitalEntitlement`,
 * `DigitalEntitlementGrant`) sit one adjective away from
 * `MerchantEntitlementCapability`, `EntitlementGrantReason` and
 * `entitlement_grants` — which already exist here and mean something else
 * entirely: Mercaria billing a merchant for its own software. Two domains one
 * adjective apart is how a service resolves the wrong one, so the buyer side is
 * an **asset right** throughout: `asset_rights`, `AssetRight`,
 * `assetRightRepository`. The epic's concept survives; the collision does not.
 *
 * ## A right, not a URL, is the ownership record
 *
 * #1015 boundary 3 and 4. A successful payment does not authorize a download; an
 * `asset_rights` row does, and a download grant is minted from one after
 * server-side authorization. The chain is:
 *
 * ```text
 * paid order line
 *   -> asset_rights      durable, immutable in its commercial half
 *   -> download grant    short-lived, single purpose, never logged
 *   -> download event    audit, no device fingerprint
 * ```
 *
 * ## Nothing is deleted
 *
 * ADR 0010 D6: a refund, a dispute or a policy revocation moves a right's
 * STATUS and appends an event. #1015 W2's closing rule — *"do not erase
 * entitlement history on refund/revocation"* — is held by `asset_rights` having
 * no delete path and `asset_right_events` being append-only.
 */

/* -------------------------------------------------------------------------- */
/* The right                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether a right currently authorizes a download, and why not when it does not.
 *
 * - `active` — the ordinary state; downloads are authorized.
 * - `refunded` — the money went back. Access stops, the row stays.
 * - `disputed_hold` — a chargeback is open. Access is suspended pending the
 *   outcome, which is a DIFFERENT state from `refunded` because it can be
 *   reversed and a refund cannot.
 * - `revoked_for_policy` — closed under a documented legal basis, never as a
 *   convenience. {@link AssetRightRevocationBasis} is the closed set of bases.
 * - `superseded` — replaced by another right (a bundle upgrade, a migration).
 *   Not a withdrawal: the replacement carries the access.
 *
 * {@link DOWNLOAD_AUTHORIZING_ASSET_RIGHT_STATUSES} is the one member list that
 * authorizes, stated once so the authorizer and the buyer library cannot
 * disagree about what a held right may do.
 */
export const ASSET_RIGHT_STATUSES = [
  'active',
  'refunded',
  'disputed_hold',
  'revoked_for_policy',
  'superseded',
] as const;

/** One of {@link ASSET_RIGHT_STATUSES}. */
export type AssetRightStatus = (typeof ASSET_RIGHT_STATUSES)[number];

/**
 * The statuses from which a download may be authorized.
 *
 * ONE member. Every other status is a reason a download is refused, and a set
 * with two members would need a reader to remember which second one it was.
 */
export const DOWNLOAD_AUTHORIZING_ASSET_RIGHT_STATUSES: readonly AssetRightStatus[] = ['active'];

/**
 * Why a right was closed under `revoked_for_policy`.
 *
 * A CLOSED set, because #1015 W2 requires revocation *"only under a documented
 * legal basis"* and a free-text reason is how "documented" becomes "whatever the
 * operator typed". Each member names a basis Mercaria can actually act on.
 */
export const ASSET_RIGHT_REVOCATION_BASES = [
  /** An upheld copyright claim against the asset. */
  'upheld_intellectual_property_claim',
  /** A legal order naming the asset or the buyer. */
  'legal_order',
  /** The purchase itself was fraudulent — a stolen card, a reversed payment. */
  'fraudulent_acquisition',
  /** The file was found to carry malware after publication. */
  'security_withdrawal',
] as const;

/** One of {@link ASSET_RIGHT_REVOCATION_BASES}. */
export type AssetRightRevocationBasis = (typeof ASSET_RIGHT_REVOCATION_BASES)[number];

/**
 * How a right came to exist.
 *
 * `free_claim` is a first-class source rather than a zero-priced purchase:
 * #1015 W7 requires a free asset to use *"the same licensing/version/provenance
 * architecture rather than a separate hack"*, and the way to get that without
 * fabricating a €0 order is for the right's source to admit a claim that has no
 * order line. Every other member names a real order line.
 */
export const ASSET_RIGHT_SOURCES = [
  'purchase',
  'free_claim',
  /** An operator-issued right — support remediation, a creator comp. Audited. */
  'operator_grant',
  /** Carried forward from a superseded right by a migration. */
  'migration',
] as const;

/** One of {@link ASSET_RIGHT_SOURCES}. */
export type AssetRightSource = (typeof ASSET_RIGHT_SOURCES)[number];

/**
 * What happened to a right, appended and never updated.
 *
 * The audit trail #1015 acceptance criterion 13 asks for. `download_authorized`
 * is deliberately NOT here: a download is high-frequency and belongs in
 * `asset_download_events`, and mixing the two would make the history of a right's
 * STATUS unreadable behind thousands of access rows.
 */
export const ASSET_RIGHT_EVENT_KINDS = [
  'granted',
  'refunded',
  'dispute_opened',
  'dispute_resolved_buyer',
  'dispute_resolved_seller',
  'revoked',
  'reinstated',
  'superseded',
  'version_became_available',
] as const;

/** One of {@link ASSET_RIGHT_EVENT_KINDS}. */
export type AssetRightEventKind = (typeof ASSET_RIGHT_EVENT_KINDS)[number];

/* -------------------------------------------------------------------------- */
/* The download grant                                                          */
/* -------------------------------------------------------------------------- */

/**
 * How long a minted download grant stays usable, in seconds.
 *
 * Short on purpose (#1015 W12 threats 2 and 3): a grant that leaks is a grant
 * somebody else can redeem, and the only defence that does not require
 * surveillance is for the window to be small and the use count bounded. It is a
 * constant rather than a config value because a deployment that widened it would
 * weaken every buyer's file at once, and the remedy for a slow connection is a
 * byte-range resume against a fresh grant, not a longer fuse.
 */
export const ASSET_DOWNLOAD_GRANT_TTL_SECONDS = 300;

/**
 * How many times one grant may be redeemed.
 *
 * More than one, because a resumed or retried transfer is the ordinary case and
 * a single-use grant turns a dropped connection into a support ticket. Bounded,
 * because an unbounded grant is a shareable URL with extra steps.
 */
export const ASSET_DOWNLOAD_GRANT_MAX_REDEMPTIONS = 5;

/** Why a download was refused, for the buyer's message and for the metrics. */
export const ASSET_DOWNLOAD_REFUSAL_REASONS = [
  'no_right',
  'right_not_active',
  'version_not_covered',
  'version_not_downloadable',
  'file_not_in_package',
  'file_not_downloadable',
  'grant_expired',
  'grant_exhausted',
  'downloads_disabled',
] as const;

/** One of {@link ASSET_DOWNLOAD_REFUSAL_REASONS}. */
export type AssetDownloadRefusalReason = (typeof ASSET_DOWNLOAD_REFUSAL_REASONS)[number];

/**
 * What a download attempt concluded.
 *
 * `started` and `completed` are separate rows rather than one row with a
 * nullable finish, so a transfer that never finishes is visible as an absence
 * rather than as a `NULL` that could equally mean "not recorded yet".
 */
export const ASSET_DOWNLOAD_EVENT_KINDS = ['authorized', 'started', 'completed', 'refused'] as const;

/** One of {@link ASSET_DOWNLOAD_EVENT_KINDS}. */
export type AssetDownloadEventKind = (typeof ASSET_DOWNLOAD_EVENT_KINDS)[number];

/* -------------------------------------------------------------------------- */
/* The buyer-facing projection                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One line of the buyer's digital library (#1015 W9).
 *
 * Carries the file INVENTORY — name, format, byte size — so the buyer sees what
 * they are about to fetch before fetching it (W9 requirement 4), and carries no
 * storage reference of any kind. A DTO that leaked one would make the
 * authorization step optional for anybody reading a response body.
 */
export interface BuyerAssetRightSummary {
  readonly rightId: string;
  readonly status: AssetRightStatus;
  readonly source: AssetRightSource;
  readonly grantedAt: string;
  readonly assetId: string;
  readonly assetTitle: string;
  readonly packageId: string;
  readonly packageName: string;
  /** The version the purchase PINNED — never the asset's newest. */
  readonly purchasedVersionId: string;
  readonly purchasedVersionLabel: string;
  /** The newest version this right actually covers, per its update policy. */
  readonly availableVersionId: string;
  readonly availableVersionLabel: string;
  /** True when {@link availableVersionId} is ahead of the purchased one. */
  readonly updateAvailable: boolean;
  readonly licenceName: string;
  readonly licenceVersionId: string;
  readonly files: readonly {
    readonly fileId: string;
    readonly fileName: string;
    readonly format: string;
    readonly byteSize: number;
    readonly downloadable: boolean;
  }[];
}
