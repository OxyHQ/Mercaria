import type {
  BuyerAssetRightSummary,
  CatalogProductBrowsePage,
  DigitalLicenceAuthorship,
  DigitalLicenceUpdatePolicy,
  DigitalLicenceVersionTerms,
  DiscoveryScope,
  FacetScope,
  FacetSelection,
  Money,
} from '@mercaria/shared-types';
import type {
  AssetMeasuredFacts,
  AssetPreviewRefusalReason,
  AssetPreviewSource,
  AssetSellerClaimRow,
} from '@mercaria/ui';
import type { DigitalBrowseSurface } from './surfaces';

/**
 * Where the digital storefront's DATA comes from — and today, the fact that it
 * comes from nowhere (#1015 Workstreams 5 and 9).
 *
 * ## Read this before wiring anything to it
 *
 * Phase A of #1015 landed the backend DOMAIN and the shared DTOs. It landed **no
 * HTTP surface**, and says so in its own handoff:
 *
 * > **No creator-facing or buyer-facing HTTP routes ship in this change.** The
 * > domain is reachable from the service layer only. That is deliberate: a route
 * > is the thing that needs the storage wiring, and shipping one that 500s on the
 * > last step would be worse than not shipping it. — `HANDOFF.md` §6
 *
 * So there is no `GET /digital/...` to call, and `listBuyerLibrary` — which
 * already returns the full `BuyerAssetRightSummary` projection — is reachable
 * from the service layer and from nothing a client can reach. Every function
 * below therefore answers `unavailable`, and every screen renders a sentence
 * saying so.
 *
 * Two things were deliberately NOT done instead, and both are worse:
 *
 * 1. **Inventing the endpoints.** A client that defines its own request and
 *    response shapes for a route nobody has designed is a second contract, and
 *    the first one to land will not match it. `lib/api/discovery.ts` records the
 *    house answer for exactly this situation: it imports the DTO it needs and is
 *    *"deliberately left to fail to compile until that lands"*. This module does
 *    the same thing at a larger grain — it names what it needs, in types that
 *    exist, and refuses to fabricate the rest.
 * 2. **Rendering plausible placeholders.** A 3D grid full of nothing, or a
 *    licence panel filled from `MERCARIA_REFERENCE_LICENCES` because that data
 *    happens to be importable, would make an unbuilt surface look built. The
 *    reference licences are the terms a creator may CHOOSE; rendering them as the
 *    terms a buyer is held to would be a fabricated legal statement.
 *
 * ## The shape of the seam, and why it is a two-member union
 *
 * `lib/catalog/facet-consumption.ts` makes its union ONE member on purpose, so
 * that "this screen offers a working filter rail" is unrepresentable rather than
 * merely false. That is the right shape for a CAPABILITY CLAIM — a control that
 * pretends to work is a defect with no error.
 *
 * This is a different question: the data source exists or it does not, and the
 * composition that renders it is ordinary screen code whose only alternative is
 * to be written later by somebody who cannot see what it was meant to render. So
 * {@link DigitalSurfaceState} has a `ready` member, every screen's composition
 * for it is written and type-checked, and the PRODUCERS below are the one place
 * that has to change. Nothing claims a capability: `ready` is never constructed
 * today, and no control is rendered that could be pressed.
 *
 * ## What has to land, per surface
 *
 * | Surface | What it needs |
 * |---|---|
 * | `/3d`, `/3d/printable`, `/3d/game-assets` | a browse read scoped by `DigitalVertical` (and, for `printable`, by the deliverable configuration the ADDRESS names — ADR 0010 D2) that returns `CatalogProductBrowsePage`s and the `FacetScope` its rail is counted over, and that accepts a WHOLE `FacetSelection` |
 * | `/3d/[slug]` | an asset page read: the work, its creator, its packages with their licence options, the measured inspection facts WITH their processor provenance, the seller's claims as registry attribute values, the version history, and a PUBLIC preview descriptor whose file role is already filtered to `PUBLICLY_VIEWABLE_ASSET_FILE_ROLES` server-side |
 * | `/creators/[slug]` | a creator read: the profile, and the same browse page shape for their works |
 * | `/library` | `listBuyerLibrary` behind an authenticated route, plus a grant mint (`POST`) that returns a short-lived token — never a URL in the list response |
 *
 * **The selection must be consumable as a WHOLE.** `facet-consumption.ts`
 * measured why a partially-wired rail is worse than none: buckets that filter and
 * buckets that do not, rendered identically, is the same defect with a smaller
 * blast radius. {@link DigitalBrowseResult.selectionApplied} is how this surface
 * refuses that — the rail renders only when the read reports it applied what it
 * was given.
 *
 * ## The preview descriptor is the one field with a rule attached
 *
 * `AssetPreviewSource` is constructible only through `@mercaria/ui`'s
 * `admitAssetPreview`, which refuses any role outside
 * `PUBLICLY_VIEWABLE_ASSET_FILE_ROLES`. Whoever maps the asset read into
 * {@link DigitalAssetPageView} calls it once, and a refusal becomes
 * {@link DigitalAssetPageView.previewRefusal} — a REASON CODE. That is the whole
 * of #1015 W4's closing rule on the client: the viewer cannot be handed a `mesh`
 * or a `source` file, because there is no prop of that type anywhere on the path.
 */

/** Why a digital surface has nothing to show. */
export type DigitalSurfaceUnavailableReason =
  /**
   * There is no client-reachable read for this surface.
   *
   * ONE member, and it is deliberately not split into "the flag is off" and "the
   * route does not exist": a client cannot tell those apart and must not guess.
   * `DIGITAL_PAID_CHECKOUT_ENABLED` and friends are server-side levers a client
   * never sees — the `useFacets` posture, where a 404 means "no rail" and never
   * "an empty rail".
   */
  'no_digital_read_surface';

/**
 * What a digital screen has to render with.
 *
 * `ready` carries the view model; `unavailable` carries the reason. A screen
 * switches on the discriminant, which is why no screen has an `undefined` branch
 * that could mean either.
 */
export type DigitalSurfaceState<T> =
  | { readonly kind: 'unavailable'; readonly reason: DigitalSurfaceUnavailableReason }
  | { readonly kind: 'ready'; readonly value: T };

/* -------------------------------------------------------------------------- */
/* The browse surfaces                                                         */
/* -------------------------------------------------------------------------- */

/** One digital browse surface's answer. */
export interface DigitalBrowseResult {
  /**
   * The scope the facet rail is counted over, as the SERVER resolved it for this
   * address.
   *
   * Handed over rather than composed here: a `FacetScope` names a category id or
   * a set of canonical product ids, and a client that built one for "3D" would be
   * holding catalogue identity it has no way to keep true (ADR 0007 D1, and
   * `validate:storefront-catalog-driven` wall 3).
   */
  readonly facetScope: FacetScope;
  readonly pages: readonly CatalogProductBrowsePage[];
  /**
   * True when the read applied the WHOLE selection it was given.
   *
   * The rail is rendered only on `true`. `facet-consumption.ts` measured the
   * alternative: a rail whose attribute buckets filter and whose market buckets
   * do not, rendered identically, leaves a shopper unable to tell which half is
   * which — so a read that can act on only part of a selection must report
   * `false` and get no rail at all.
   */
  readonly selectionApplied: boolean;
}

/* -------------------------------------------------------------------------- */
/* One work's page                                                             */
/* -------------------------------------------------------------------------- */

/** Who made the work, and where their page is. */
export interface DigitalCreatorRef {
  /** Id or current slug — whichever `/creators/:slug` should be linked with. */
  readonly slug: string;
  readonly name: string;
}

/**
 * One named DELIVERABLE an offer sells, with the licence option bound to it.
 *
 * ADR 0010 D2: a buyer choosing between Personal and Commercial is choosing
 * between two VARIANTS, each bound to its own licence option — so a package
 * carries its own price and its own terms, and selecting one changes both. A
 * FORMAT is deliberately not a choice here: several formats belong to one
 * purchased package (#1015 boundary 6), which is why `formats` is a list the
 * package STATES rather than a picker.
 */
export interface DigitalPackageOffer {
  readonly packageId: string;
  readonly name: string;
  /**
   * The `ASSET_FORMAT_REGISTRY` keys this package contains, in the creator's own
   * order. Machine keys (`stl`, `glb`), rendered verbatim: a format key is an
   * extension-shaped identifier with no localized form, for the reason an ISO
   * currency code is.
   */
  readonly formats: readonly string[];
  /** The offer price in its NATIVE currency. Absent when nothing is on sale. */
  readonly price?: Money;
  readonly licenceName: string;
  readonly licenceAuthorship: DigitalLicenceAuthorship;
  /** The FROZEN terms of the licence version this option names (ADR 0010 D3). */
  readonly licenceTerms: DigitalLicenceVersionTerms;
  readonly licenceSummary?: string;
  /** Whether later versions are included — the OPTION's answer (ADR 0010 D4). */
  readonly updatePolicy: DigitalLicenceUpdatePolicy;
}

/** One release, for the version and changelog section. */
export interface DigitalVersionEntry {
  readonly versionId: string;
  /** The creator's own label (`1.2`, `spring-2026`). Shown verbatim. */
  readonly label: string;
  /** ISO 8601; spelled with the app's locale, never the device's (#488). */
  readonly releasedAt: string;
  /** What changed, in the creator's words. */
  readonly notes?: string;
  /** Whether this is the version a new purchase would acquire. */
  readonly current: boolean;
}

/** Everything `/3d/[slug]` renders. */
export interface DigitalAssetPageView {
  readonly assetId: string;
  readonly title: string;
  readonly summary?: string;
  readonly creator: DigitalCreatorRef;
  /**
   * The canonical product this work IS, for the review surfaces.
   *
   * A digital product is an ordinary canonical product (ADR 0002, inherited
   * unchanged), so verified-purchase reviews are #76's existing domain rather
   * than a second review system — absent only while a work has no canonical
   * product behind it.
   */
  readonly canonicalProductId?: string;
  /** The admitted public preview. See the module note on how it is admitted. */
  readonly preview?: AssetPreviewSource;
  /** Why no preview, when a file was offered and refused. */
  readonly previewRefusal?: AssetPreviewRefusalReason;
  /** At least one; the first is the default selection. */
  readonly packages: readonly DigitalPackageOffer[];
  /** What Mercaria MEASURED, with the processor that did it (ADR 0010 D12). */
  readonly measured?: AssetMeasuredFacts;
  /** What the SELLER claims — registry attribute values, a different table. */
  readonly claims: readonly AssetSellerClaimRow[];
  readonly versions: readonly DigitalVersionEntry[];
  /** Printing notes, engine guidance — the seller's own prose, verbatim. */
  readonly sellerGuidance?: string;
}

/** Everything `/creators/[slug]` renders. */
export interface DigitalCreatorPageView {
  readonly creator: DigitalCreatorRef;
  readonly biography?: string;
  readonly pages: readonly CatalogProductBrowsePage[];
}

/** Everything `/library` renders. */
export interface DigitalLibraryView {
  readonly rights: readonly BuyerAssetRightSummary[];
}

/* -------------------------------------------------------------------------- */
/* The producers — the ONE place that changes when the read lands              */
/* -------------------------------------------------------------------------- */

/**
 * Whether the discovery feed has gained a scope a digital surface could use.
 *
 * A HINT rather than a proof, and the limit is worth stating: it matches scope
 * kinds by NAME, so a digital scope called something else lands without turning
 * this red. What it does buy is that the likeliest spelling fails HERE, at the
 * decision that depends on it, rather than leaving the producers below answering
 * `unavailable` for months after the read they needed arrived —
 * `facet-consumption.ts`'s `LISTING_GRID_CARRIES_ATTRIBUTE_FILTER` is the same
 * device with a stronger premise available to it.
 *
 * Deliberately narrow: it is `Extract`, not `Exclude`, so an unrelated feed scope
 * (a campaign, a saved query) does not fail somebody else's build in this file.
 */
type DigitalDiscoveryScopeKinds = Extract<
  DiscoveryScope['kind'],
  'digital' | 'digital_vertical' | 'vertical'
>;

/** `false` until the feed admits a digital scope. Checked by the compiler. */
export const DISCOVERY_FEED_OFFERS_A_DIGITAL_SCOPE: [DigitalDiscoveryScopeKinds] extends [never]
  ? false
  : true = false;

/** The one reason, stated once so four producers cannot drift apart. */
const UNAVAILABLE: DigitalSurfaceState<never> = {
  kind: 'unavailable',
  reason: 'no_digital_read_surface',
};

/**
 * One browse surface's data.
 *
 * Takes the surface and the selection it would narrow by, so that the call site
 * reads as the real one and the signature does not change when the read lands.
 * Both arguments are accepted and neither is used yet — named with a leading
 * underscore so that is visible rather than implied.
 */
export function digitalBrowseSource(
  _surface: DigitalBrowseSurface,
  _selection: FacetSelection,
): DigitalSurfaceState<DigitalBrowseResult> {
  return UNAVAILABLE;
}

/** One work's page, by id or slug. */
export function digitalAssetPageSource(
  _handle: string,
): DigitalSurfaceState<DigitalAssetPageView> {
  return UNAVAILABLE;
}

/** One creator's page, by id or slug. */
export function digitalCreatorPageSource(
  _slug: string,
): DigitalSurfaceState<DigitalCreatorPageView> {
  return UNAVAILABLE;
}

/**
 * The signed-in buyer's library.
 *
 * `listBuyerLibrary` already composes exactly {@link DigitalLibraryView}'s
 * contents, including the file inventory and the `updateAvailable` flag
 * (`HANDOFF.md` §4). What is missing is an authenticated route in front of it.
 */
export function digitalLibrarySource(): DigitalSurfaceState<DigitalLibraryView> {
  return UNAVAILABLE;
}
