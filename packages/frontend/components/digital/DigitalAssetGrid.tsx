import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services';
import type { CatalogProductBrowsePage } from '@mercaria/shared-types';
import { CanonicalProductCard, Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import { digitalAssetHref } from '@/lib/digital/routes';

/**
 * The product grid a digital browse surface renders (#1015 Workstream 5).
 *
 * ## Why not `components/brand/CatalogProductGrid`
 *
 * That grid is the same shape and renders the same card over the same DTO, and
 * reusing it was the first thing tried. It navigates to `/products/:id` — the
 * listing-first product page — and a digital work's page is `/3d/[slug]`, which
 * is the surface that can show a licence, a package, an interactive preview and a
 * version history. Changing where that grid points would change where a brand and
 * a family page send a shopper, which is #72's decision and not this one's. So
 * this is a second grid over one card rather than a second card.
 *
 * Everything else it does is deliberately copied rather than diverged: the same
 * `CanonicalProductCard`, the same Oxy media resolver (the ecosystem's one media
 * chokepoint), the same `offerContext` reading, and the same refusal to show a
 * price with no condition context — all of which live inside the card.
 *
 * ## Two empty states, and the third one is not this component's
 *
 * A page with no products and a page whose OFFER half was withdrawn are different
 * facts with different next actions, so they read differently here. "This
 * deployment has no digital surface at all" is the THIRD state and belongs to
 * `DigitalSurfaceNotice`, because it is a fact about the deployment rather than
 * about a result set — and collapsing it into "nothing here" is what would make a
 * dark deployment look like an empty catalogue.
 *
 * ## No facet, no filter, no ordering decision
 *
 * This component takes pages and renders them in the order they arrived. Which
 * products are in them is the server's answer, counted and ordered by the same
 * registry the rail above is generated from (#1015 acceptance criterion 18), and
 * there is no prop here a 3D-specific filter could enter through.
 */

export interface DigitalAssetGridProps {
  pages: readonly CatalogProductBrowsePage[];
  /** Whether any facet bucket is selected — what makes an empty grid explicable. */
  filtered: boolean;
}

export function DigitalAssetGrid({ pages, filtered }: DigitalAssetGridProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { oxyServices } = useOxy();

  const products = pages.flatMap((page) => page.products);
  /*
   * Taken from the FIRST page: every page of one browse is computed under the
   * same lever, so a later page cannot disagree — `CatalogProductGrid`'s own
   * reading, kept identical so the two grids cannot drift on what `withdrawn`
   * means.
   */
  const offersIncluded = pages[0]?.offerContext !== 'withdrawn';

  if (products.length === 0) {
    return (
      <Text className="text-bodySmall text-text-tertiary">
        {filtered
          ? t('digital.grid.emptyFiltered')
          : offersIncluded
            ? t('digital.grid.empty')
            : t('digital.grid.emptyPricesWithdrawn')}
      </Text>
    );
  }

  return (
    <View className="flex-row flex-wrap gap-space-16">
      {products.map((product) => (
        <View key={product.canonicalProductId} className="w-40">
          <CanonicalProductCard
            product={product}
            offersIncluded={offersIncluded}
            resolveImage={(fileId) => {
              const url = oxyServices.getFileDownloadUrl(fileId, 'thumb');
              return url && url.startsWith('http') ? url : undefined;
            }}
            /*
             * The slug when there is one, the id otherwise — `/3d/:slug` resolves
             * either, the way `/categories/:handle` does, so a link survives a
             * rename and an unslugged work is still reachable. The target is the
             * OBJECT form from `lib/digital/routes.ts`; a template literal here
             * would be absorbed by `[slug]` itself and check nothing (#456).
             */
            onPress={() =>
              router.push(
                digitalAssetHref(
                  product.slug.length > 0 ? product.slug : product.canonicalProductId,
                ),
              )
            }
          />
        </View>
      ))}
    </View>
  );
}
