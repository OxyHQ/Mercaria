import { useRouter, type Href } from 'expo-router';
import { Breadcrumb, BreadcrumbItem } from '@oxy.so/bloom/breadcrumb';
import type { SeoBreadcrumb } from '@mercaria/shared-types';
import { useTranslation } from '@/lib/i18n';

/**
 * The breadcrumb trail, from the SEO route registry (#75, #367 workstream 9).
 *
 * The trail arrives whole from `GET /seo/resolve` — the same registry that
 * decides the canonical URL and emits the `BreadcrumbList` structured data — so
 * what a shopper reads and what a crawler is told cannot disagree. Composing it
 * here from a category's ancestors would be a second trail with no relationship
 * to the one in the page's own JSON-LD.
 *
 * ## Bloom's `Breadcrumb` draws it
 *
 * The landmark, the direction-aware chevron (it mirrors in Arabic, #429) and
 * the link/button/label split are `@oxy.so/bloom/breadcrumb`'s. The landmark is
 * named with the translated `catalog.breadcrumbs.label`.
 *
 * ## The last crumb is the page and is not a link
 *
 * It is the `current` item — not interactive, and `aria-current="page"` on web —
 * so a screen reader announces where you are rather than offering a link to the
 * page you are on.
 *
 * ## A crumb whose path this app has no route for is TEXT
 *
 * `SeoBreadcrumb.path` is a Mercaria path, and the registry records patterns the
 * storefront has not built. Rather than pushing a path the router cannot match,
 * such a crumb renders as a plain label, not a link that goes nowhere.
 *
 * ## Typed navigation, real links on web
 *
 * A routable crumb navigates through `router.push` with the typed `Href` the
 * caller's mapper returned (the OBJECT form `typedRoutes` checks completely).
 * It also carries the registry `path` as `href`, so on web it is a real
 * `<a href>` — middle-click and "open in new tab" work — while Bloom prevents
 * the browser's navigation in favour of `onPress`.
 */

export interface CatalogBreadcrumbsProps {
  crumbs: readonly SeoBreadcrumb[];
  /** Resolve a registry path to a route this app has, or `undefined`. */
  hrefForPath: (path: string) => Href | undefined;
}

export function CatalogBreadcrumbs({ crumbs, hrefForPath }: CatalogBreadcrumbsProps) {
  const router = useRouter();
  const { t } = useTranslation();

  if (crumbs.length === 0) return null;

  return (
    <Breadcrumb accessibilityLabel={t('catalog.breadcrumbs.label')}>
      {crumbs.map((crumb, index) => {
        const key = `${crumb.path}:${String(index)}`;
        const isLast = index === crumbs.length - 1;
        if (isLast) {
          return (
            <BreadcrumbItem key={key} current>
              {crumb.name}
            </BreadcrumbItem>
          );
        }
        const href = hrefForPath(crumb.path);
        if (href === undefined) {
          return <BreadcrumbItem key={key}>{crumb.name}</BreadcrumbItem>;
        }
        return (
          <BreadcrumbItem key={key} href={crumb.path} onPress={() => router.push(href)}>
            {crumb.name}
          </BreadcrumbItem>
        );
      })}
    </Breadcrumb>
  );
}
