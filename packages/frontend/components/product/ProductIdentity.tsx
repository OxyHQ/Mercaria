import { View } from 'react-native';
import { Image } from 'expo-image';
import type { CanonicalProduct } from '@mercaria/shared-types';
import { RatingLine, Text } from '@mercaria/ui';
import { REVIEW_SCOPE_LABELS } from '@/lib/hooks/use-reviews';

/**
 * What this product IS (#71 §"Product identity").
 *
 * ## Nothing here is invented, and a conflict is never resolved by rendering
 *
 * #71 says outright: do not display conflicting source facts as one invented
 * canonical value. Every field on this component comes from #56's projection,
 * which already selected one value per field and records the PROVENANCE of that
 * selection — so where two sources disagreed, a domain that owns the decision
 * made it and can be asked why. This component's job is to show what was
 * selected and, where freshness matters, when it was last seen.
 *
 * ## The rating says what it is about
 *
 * A product rating and a seller rating answer different questions (#76), so the
 * line carries its scope label. A bare "4.2 ★" on a page that also shows seller
 * ratings is two identical rows a reader has to guess between.
 */

export interface ProductIdentityProps {
  product: CanonicalProduct;
  /** #76's product-scope aggregate, when the product has one. */
  rating?: { rating: number; reviewCount: number };
}

export function ProductIdentity({ product, rating }: ProductIdentityProps) {
  const images = product.images.filter((image) => image.fileId || image.sourceUrl);
  const specs = product.attributes.slice(0, 8);
  // ACTIVE only: a retired or disputed identifier keeps its row (ADR 0002 D14)
  // and showing one would publish a number Mercaria no longer stands behind.
  // Every scheme in the vocabulary is a public product identifier, so there is
  // nothing further to filter — a scheme that was not would need excluding
  // HERE, and the absence of that filter is the statement that none exists.
  const identifiers = product.identifiers.filter((identifier) => identifier.status === 'active');

  return (
    <View className="gap-space-16">
      {images.length > 0 ? (
        <View className="flex-row flex-wrap gap-space-8">
          {images.slice(0, 4).map((image) => (
            <Image
              key={image.id}
              source={{ uri: image.sourceUrl ?? image.fileId }}
              contentFit="contain"
              style={{ height: 180, width: 180 }}
              // Source-aware alt text (#71 identity 4): the source's own words
              // when it published any, and a plain statement of what the image
              // is when it did not — never a caption Mercaria composed about a
              // photograph it did not take.
              accessibilityLabel={image.alt ?? `${product.name} — image from the catalogue`}
              alt={image.alt ?? `${product.name} — image from the catalogue`}
            />
          ))}
        </View>
      ) : null}

      <View className="gap-space-8">
        {/*
          The brand and the family are NAMED and not linked, because the
          storefront has no `/brands/:id` or `/product-families/:id` route yet —
          #72 and #73 own those pages. #71 asks to link an identity "to its
          public page when available", and a link to a route that does not
          resolve is worse than the text. That used to be uncatchable —
          `typedRoutes` was on but inert, so a dead `router.push` compiled and
          shipped — and #330 closed it: the route union is generated before
          `tsc`, so whoever adds those pages can turn these into links and is
          told at once if they got the path wrong.
        */}
        <Text className="text-headerBold text-text" accessibilityRole="header">
          {product.name}
        </Text>

        {rating !== undefined && rating.reviewCount > 0 ? (
          <RatingLine
            rating={rating.rating}
            count={rating.reviewCount}
            scopeLabel={REVIEW_SCOPE_LABELS.product}
          />
        ) : null}

        {product.description ? (
          <Text className="text-bodySmall text-text">{product.description}</Text>
        ) : null}

        <LifecycleLine product={product} />
      </View>

      {specs.length > 0 ? (
        <View className="gap-space-8">
          <Text className="text-sectionTitle text-text" accessibilityRole="header">
            Specifications
          </Text>
          {specs.map((attribute) => (
            <View key={attribute.key} className="flex-row justify-between gap-space-12">
              <Text className="text-caption text-text-secondary">{attribute.key}</Text>
              <Text className="text-caption text-text">{attribute.displayValue}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {identifiers.length > 0 ? (
        <View className="gap-space-4">
          <Text className="text-sectionTitle text-text" accessibilityRole="header">
            Model identifiers
          </Text>
          {identifiers.slice(0, 6).map((identifier) => (
            <Text key={identifier.id} className="text-caption text-text-secondary">
              {`${identifier.scheme.toUpperCase()} ${identifier.rawValue}`}
            </Text>
          ))}
        </View>
      ) : null}

      <ProvenanceLine product={product} />
    </View>
  );
}

/**
 * Release, discontinuation and merge status — shown only when USEFUL (#71
 * identity 8).
 *
 * A merged product is reached through a redirect the page has already applied,
 * so the status is stated rather than hidden: somebody who followed an old link
 * is looking at a different page from the one they clicked, and saying so is
 * the difference between a redirect and a substitution.
 */
function LifecycleLine({ product }: { product: CanonicalProduct }) {
  const parts: string[] = [];
  if (product.releasedAt) {
    parts.push(`Released ${new Date(product.releasedAt).getFullYear()}`);
  }
  if (product.discontinuedAt) {
    parts.push('Discontinued');
  }
  if (parts.length === 0) return null;
  return <Text className="text-caption text-text-secondary">{parts.join(' · ')}</Text>;
}

/**
 * Where these facts came from and when they were last seen (#71 identity 9).
 *
 * Only the source KIND and the observation time, which is exactly what #56's
 * public projection carries: a source RECORD id would identify which crawl saw
 * what, and that is operator material rather than something a shopper needs.
 */
function ProvenanceLine({ product }: { product: CanonicalProduct }) {
  if (product.freshness === undefined) return null;
  const observed = new Date(product.freshness.observedAt);
  return (
    <Text className="text-caption text-text-secondary">
      {`Product details last confirmed ${observed.toLocaleDateString()} from a ${product.freshness.sourceKind.replace(/_/gu, ' ')} source.`}
    </Text>
  );
}
