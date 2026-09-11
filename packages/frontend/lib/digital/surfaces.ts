import type { DigitalVertical } from '@mercaria/shared-types';
import type { DigitalBrowseRoute } from './routes';

/**
 * The three digital browse ADDRESSES the storefront publishes, and the one thing
 * each knows about itself (#1015 Workstream 5).
 *
 * ## What a surface may know, and what it may not
 *
 * #1015 W5's closing rule and acceptance criterion 18:
 *
 * > facets and filters must come from the product-profile/attribute registry,
 * > never from hard-coded 3D React components
 *
 * So a surface here carries exactly three things: its ADDRESS, its COPY KEYS,
 * and the `DigitalVertical` it is the landing page for. It carries no category
 * id, no attribute key, no facet key, no controlled value and no filter list —
 * there is nowhere in this shape to put one, which is the point. Everything a
 * shopper can narrow by arrives from `POST /facets`, generated from #94's
 * registry, and `FacetRail` composes, filters, orders and suppresses none of it.
 *
 * A `DigitalVertical` is admissible here precisely because it is NOT a catalogue
 * concept's identity: it is a closed vocabulary in `@mercaria/shared-types`, the
 * same kind of thing `validate:storefront-catalog-driven` wall 1 deliberately
 * permits a renderer to switch on (*"a renderer MUST switch on them: that is what
 * makes it schema-driven"*), and the key `DIGITAL_ENABLED_VERTICALS` allow-lists
 * a deployment by. A `categoryId` in this table would be the per-category filter
 * set #367 deleted, arriving through the back door.
 *
 * ## Why `/3d/printable` is not a vertical
 *
 * `three_d` and `game_asset` are both members of `DIGITAL_VERTICALS`, so those two
 * surfaces name one each. "Printable" is not a vertical and must not become one:
 * ADR 0010 D2 makes `printable`, `game-ready`, `rigged` and `source-files` a
 * materially different DELIVERABLE CONFIGURATION — a canonical VARIANT, and on
 * the read side a refinement of the 3D vertical that the registry expresses.
 * So `printable` carries the same vertical as `/3d` and its refinement is the
 * SERVER's to resolve from the address; this module does not invent one, because
 * a `{ attributeKey: 'printable' }` written here would be exactly the hardcoded
 * concept identity wall 3 refuses.
 *
 * That is also why the refinement is not a query parameter composed here: the
 * address is the request, and what it means is a thing an operator publishes.
 */

/** Which surface a screen is. Three members, one per published address. */
export type DigitalBrowseSurfaceKey = 'three_d' | 'printable' | 'game_assets';

/** One published address and what it knows about itself. */
export interface DigitalBrowseSurface {
  readonly key: DigitalBrowseSurfaceKey;
  readonly route: DigitalBrowseRoute;
  /**
   * The vertical this address lands in — a `DIGITAL_VERTICALS` member, which is
   * what `DIGITAL_ENABLED_VERTICALS` gates a deployment by.
   */
  readonly vertical: DigitalVertical;
  /**
   * Translation KEYS, never sentences: this is a module-scope `const` evaluated
   * at import, and the locale store has not rehydrated by then — a sentence here
   * would freeze into whichever language loaded first, with nothing to blame
   * (`docs/app-i18n.md`). Literals, so the i18n guard's referential check can
   * see them.
   */
  readonly titleKey: string;
  readonly descriptionKey: string;
}

/**
 * The table, exhaustive over {@link DigitalBrowseSurfaceKey} by its `Record`
 * type — so a fourth surface cannot be added to the union without its address
 * and its copy.
 *
 * Annotated with LOCAL type names only. A `Readonly<Record<…, DigitalVertical>>`
 * annotation over an initializer holding several string literals is what
 * `validate:storefront-catalog-driven` wall 5 reads as a client copy of a server
 * vocabulary, and it is right to: this is a table of three ADDRESSES that each
 * name a vertical, not a second spelling of `DIGITAL_VERTICALS`.
 */
export const DIGITAL_BROWSE_SURFACES: Readonly<
  Record<DigitalBrowseSurfaceKey, DigitalBrowseSurface>
> = {
  three_d: {
    key: 'three_d',
    route: '/3d',
    vertical: 'three_d',
    titleKey: 'digital.threeD.title',
    descriptionKey: 'digital.threeD.description',
  },
  printable: {
    key: 'printable',
    route: '/3d/printable',
    // The 3D vertical, refined by the address — see the module note on why
    // "printable" is a deliverable configuration and not a vertical of its own.
    vertical: 'three_d',
    titleKey: 'digital.printable.title',
    descriptionKey: 'digital.printable.description',
  },
  game_assets: {
    key: 'game_assets',
    route: '/3d/game-assets',
    vertical: 'game_asset',
    titleKey: 'digital.gameAssets.title',
    descriptionKey: 'digital.gameAssets.description',
  },
};

/**
 * The other surfaces, for the cross-links every one of these pages carries.
 *
 * Derived from the table rather than written out per screen: three screens each
 * listing the other two is three places for a fourth surface to be forgotten,
 * and the forgetting is invisible — the page still renders.
 */
export function siblingDigitalSurfaces(
  key: DigitalBrowseSurfaceKey,
): readonly DigitalBrowseSurface[] {
  return Object.values(DIGITAL_BROWSE_SURFACES).filter((surface) => surface.key !== key);
}
