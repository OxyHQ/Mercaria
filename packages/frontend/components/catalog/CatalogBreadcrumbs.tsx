import { Fragment } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import type { SeoBreadcrumb } from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';
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
 * ## The last crumb is the page and is not a link
 *
 * It is marked `header`, so a screen reader announces where you are rather than
 * offering a link to the page you are on.
 *
 * ## A crumb whose path this app has no route for is TEXT
 *
 * `SeoBreadcrumb.path` is a Mercaria path, and the registry records patterns the
 * storefront has not built. Rather than pushing a path the router cannot match,
 * such a crumb renders as plain text — the `NavigationMenu` decision, applied to
 * a trail.
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
    <View
      className="flex-row flex-wrap items-center gap-space-4"
      accessibilityRole="none"
      accessibilityLabel={t('catalog.breadcrumbs.label')}
    >
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        const href = isLast ? undefined : hrefForPath(crumb.path);
        return (
          <Fragment key={`${crumb.path}:${String(index)}`}>
            {index > 0 ? (
              // Decorative: the separator is not a word and must not be read
              // out between every crumb.
              <Text
                className="text-caption text-text-tertiary"
                accessibilityElementsHidden
                importantForAccessibility="no"
              >
                /
              </Text>
            ) : null}
            {href === undefined ? (
              <Text
                className={isLast ? 'text-caption text-text' : 'text-caption text-text-secondary'}
                {...(isLast ? { accessibilityRole: 'header' as const } : {})}
              >
                {crumb.name}
              </Text>
            ) : (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={crumb.name}
                onPress={() => router.push(href)}
              >
                <Text className="text-caption text-text-secondary">{crumb.name}</Text>
              </Pressable>
            )}
          </Fragment>
        );
      })}
    </View>
  );
}
