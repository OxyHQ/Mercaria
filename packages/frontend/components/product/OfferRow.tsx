import { Linking, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import type {
  OfferComparisonPrice,
  OfferFreshnessAssessment,
  OfferMoney,
  ProductPageOfferRow,
  ProductPageSeller,
} from '@mercaria/shared-types';
import {
  OfferConditionBadge,
  OfferLabelBadge,
  Text,
  formatMoney,
  formatSourceMoney,
} from '@mercaria/ui';
import config from '../../lib/config';

/**
 * One offer, as a shopper reads it (#71 §"Offer row").
 *
 * ## Only known facts, and an unknown says so
 *
 * Every figure on this row comes from a branch of a discriminated union that
 * HAS it. An unknown delivery cost has no `cost` property to read, an
 * unconvertible price has no `amount`, and neither renders as a zero or a
 * blank. "Unknown shipping must not appear as free shipping" is therefore not a
 * rule this component follows — it is a shape it cannot express.
 *
 * ## The action comes from `outbound` and never from the offer
 *
 * `row.outbound` is a three-branch union: the native branch carries the ids the
 * cart operates on, and neither external branch carries any. So an external
 * offer cannot be added to a cart from here by reading one field somebody
 * forgot to check — there is no field. #37's redirect is what will make the
 * external action real; until then it is disabled and says why, because a raw
 * link to a stored destination would assert at render time what only a click
 * can establish (#68's outbound gate exists for exactly that).
 */

export interface OfferRowProps {
  row: ProductPageOfferRow;
  /** Called for a native, purchasable offer. Never reachable for an external one. */
  onAddToCart?: (input: { listingId: string; productVariantId: string }) => void;
  addToCartPending?: boolean;
}

export function OfferRow({ row, onAddToCart, addToCartPending = false }: OfferRowProps) {
  const router = useRouter();
  const { offer, ranked, seller, outbound } = row;

  return (
    <View
      className="gap-space-12 rounded-radius-28 border border-border-secondary p-space-16"
      // The whole row is one article to a screen reader, so the seller, the
      // price and the action are read together rather than as three unrelated
      // fragments in a list of twenty.
      accessibilityRole="none"
      accessible={false}
    >
      <View className="flex-row items-start justify-between gap-space-12">
        <View className="flex-1 gap-space-4">
          <SellerLine seller={seller} />
          {row.variantName ? (
            // On a PRODUCT-scoped page a row must say which configuration it
            // prices, or #71 acceptance 4 fails quietly: the shopper reads a
            // price for a variant they did not choose.
            <Text className="text-caption text-text-secondary">{row.variantName}</Text>
          ) : null}
        </View>
        <PriceBlock price={ranked.cost.itemPrice} sourcePrice={offer.price} />
      </View>

      <View className="flex-row flex-wrap items-center gap-space-8">
        <OfferConditionBadge condition={offer.condition} />
        <DeliveryLine row={row} />
      </View>

      <AvailabilityLine availability={offer.availability} freshness={offer.freshness} />

      {offer.returnPolicy?.windowDays !== undefined ? (
        // #71 offer row 8: a return-policy summary ONLY when the seller supplied
        // one. Mercaria states no return policy on somebody else's behalf.
        <Text className="text-caption text-text-secondary">
          {`Seller states a ${offer.returnPolicy.windowDays}-day return window.`}
        </Text>
      ) : null}

      {ranked.labels.length > 0 ? (
        <View className="gap-space-8">
          {ranked.labels.map((award) => (
            // Each award explained on its own (#74 §"Labels", #71 offer row 9):
            // one offer may carry several and none is a summary of the others.
            <OfferLabelBadge key={award.label} award={award} showExplanation />
          ))}
        </View>
      ) : null}

      {outbound.kind === 'native_checkout' ? (
        <View className="flex-row gap-space-8">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Buy on Mercaria"
            accessibilityState={{ disabled: addToCartPending }}
            disabled={addToCartPending}
            onPress={() =>
              onAddToCart?.({
                listingId: outbound.listingId,
                productVariantId: outbound.productVariantId,
              })
            }
            className="flex-1 items-center rounded-radius-max bg-bg-fill-inverse p-space-12"
          >
            <Text className="text-buttonMedium text-text-inverse">Buy on Mercaria</Text>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Open this seller's listing"
            onPress={() =>
              router.push(
                `/products/${outbound.listingId}` as Parameters<typeof router.push>[0],
              )
            }
            className="items-center rounded-radius-max border border-border-secondary px-space-16 py-space-12"
          >
            <Text className="text-buttonMedium text-text">View listing</Text>
          </Pressable>
        </View>
      ) : outbound.kind === 'outbound' ? (
        <OutboundAction outbound={outbound} />
      ) : (
        <UnavailableAction row={row} />
      )}
    </View>
  );
}

/** Who is selling, with a link to their public page when they have one. */
function SellerLine({ seller }: { seller: ProductPageSeller }) {
  const router = useRouter();

  if (seller.kind === 'merchant') {
    return (
      <View className="gap-space-2">
        {/*
          LINKED as of #252, and only the merchant NAME is the link.

          This was NAMED rather than linked for one recorded reason — the
          storefront had no `/merchants/:slug` route — and #73 shipped
          `app/(app)/merchants/[idOrSlug].tsx`, so the reason has expired. Every
          other seller kind on this row already links (`/stores/:handle`,
          `/sellers/:oxyUserId`); leaving the merchant as the one seller a
          shopper cannot navigate to would be an asymmetry with nothing behind
          it.

          The SLUG rather than the id: `merchants.slug` is `not null` and unique
          FOREVER, and a merged tombstone keeps its slug and redirects (ADR 0002
          D12), so a link taken today survives a merge tomorrow.

          The storefront line below stays TEXT. It names the channel, and a
          channel is not a merchant page — `/merchants/:idOrSlug` would resolve
          the operator, which for a marketplace offer is somebody other than the
          seller this row is about.
        */}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Visit ${seller.name}`}
          onPress={() =>
            router.push(`/merchants/${seller.slug}` as Parameters<typeof router.push>[0])
          }
        >
          <Text className="text-bodyTitleSmall text-text">{seller.name}</Text>
        </Pressable>
        {seller.storefront ? (
          <Text className="text-caption text-text-secondary">
            {seller.marketplaceSeller
              ? // ADR 0002 D8: a marketplace offer names BOTH, because the
                // seller of record is who a buyer's warranty is with and the
                // channel is where the transaction happens.
                `Sold by ${seller.name} on ${seller.storefront.name}`
              : seller.storefront.name}
          </Text>
        ) : null}
      </View>
    );
  }

  if (seller.kind === 'native_store') {
    return (
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Visit ${seller.name}`}
        onPress={() =>
          router.push(`/stores/${seller.handle}` as Parameters<typeof router.push>[0])
        }
      >
        <Text className="text-bodyTitleSmall text-text">{seller.name}</Text>
      </Pressable>
    );
  }

  if (seller.kind === 'native_person') {
    return (
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Visit ${seller.displayName}'s profile`}
        onPress={() =>
          router.push(
            `/sellers/${encodeURIComponent(seller.oxyUserId)}` as Parameters<
              typeof router.push
            >[0],
          )
        }
      >
        <Text className="text-bodyTitleSmall text-text">{seller.displayName}</Text>
      </Pressable>
    );
  }

  // An unresolvable seller names NOBODY rather than naming somebody wrong.
  return <Text className="text-bodyTitleSmall text-text-secondary">Seller not identified</Text>;
}

/**
 * The price, in the comparison currency, with the source currency beside it.
 *
 * Both, because #71 offer row 3 asks for both: the figure a shopper compares on
 * and the amount the seller actually published. An unconvertible price shows
 * the source amount alone and says so — never a converted figure Mercaria could
 * not compute.
 */
function PriceBlock({
  price,
  sourcePrice,
}: {
  price: OfferComparisonPrice;
  sourcePrice?: OfferMoney;
}) {
  const source = sourcePrice === undefined ? null : formatSourceMoney(sourcePrice);

  if (price.known === true) {
    return (
      <View className="items-end gap-space-2">
        <Text className="text-bodyTitleLarge text-text">{formatMoney(price.amount)}</Text>
        {source !== null && sourcePrice !== undefined && sourcePrice.currency !== price.amount.currency ? (
          <Text className="text-caption text-text-secondary">{`Listed at ${source}`}</Text>
        ) : null}
      </View>
    );
  }

  return (
    <View className="items-end gap-space-2">
      {source === null ? (
        <Text className="text-bodyTitleSmall text-text-secondary">Price not available</Text>
      ) : (
        <Text className="text-bodyTitleSmall text-text">{source}</Text>
      )}
      <Text className="text-caption text-text-secondary">
        {price.reason === 'not_convertible'
          ? "We can't convert this price to your currency."
          : 'This seller has not published a price.'}
      </Text>
    </View>
  );
}

/** Delivery, or the honest statement that nobody published it. */
function DeliveryLine({ row }: { row: ProductPageOfferRow }) {
  const delivery = row.offer.delivery;

  if (delivery.known === false) {
    return (
      <Text className="text-caption text-text-secondary">
        {delivery.pickup === 'available'
          ? 'Delivery cost unknown · collection offered'
          : 'Delivery cost unknown'}
      </Text>
    );
  }

  const cost = formatSourceMoney(delivery.cost);
  const window =
    delivery.minDays !== undefined && delivery.maxDays !== undefined
      ? ` · ${delivery.minDays}–${delivery.maxDays} days`
      : '';

  return (
    <Text className="text-caption text-text-secondary">
      {`${delivery.cost.amount === 0 ? 'Free delivery' : `Delivery ${cost ?? delivery.cost.currency}`}${window}`}
    </Text>
  );
}

/**
 * Availability and how recently Mercaria checked (#71 offer row 6).
 *
 * `unknown` availability is stated as unknown. Most feeds publish none, and
 * reading silence as "in stock" is what sends a buyer to a page that cannot
 * sell them anything.
 */
function AvailabilityLine({
  availability,
  freshness,
}: {
  availability: string;
  freshness: OfferFreshnessAssessment;
}) {
  const checked = new Date(freshness.lastSeenAt);
  const stale = freshness.level === 'warning';

  return (
    <Text className="text-caption text-text-secondary">
      {`${availabilityText(availability)} · Checked ${checked.toLocaleDateString()}${
        stale ? ' · we have not been able to re-check this recently' : ''
      }`}
    </Text>
  );
}

function availabilityText(availability: string): string {
  switch (availability) {
    case 'in_stock':
      return 'In stock';
    case 'out_of_stock':
      return 'Out of stock';
    case 'preorder':
      return 'Pre-order';
    case 'unavailable':
      return 'Unavailable';
    default:
      return 'Availability not published';
  }
}

/**
 * "Go to <merchant>" — the handoff to #67's redirect.
 *
 * The button opens a MERCARIA path (`/out/<token>`) on the API host and never a
 * merchant URL: the server revalidates the offer, re-checks the source's rights,
 * admits the destination host and records the click, all at the moment of the
 * press. That is why the client is handed a path rather than a link — a URL
 * rendered into this page an hour ago cannot re-check anything.
 *
 * The HOST beside it is the merchant the server disclosed, so a shopper reads
 * where they are going before they press. It is deliberately the retailer and
 * not the affiliate network the redirect may route through.
 *
 * `outbound.rel` (`sponsored nofollow noopener`) is carried as DATA and is NOT
 * applied here, because a `Pressable` is a `div` rather than an anchor and
 * there is no `rel` to set. The crawler-facing guarantee that exists today is
 * the redirect's own `X-Robots-Tag: noindex, nofollow`; the anchor-level
 * relationship is owed by whatever renders real HTML (#75's public routes), and
 * the value is on the DTO so that surface does not have to re-derive it.
 */
function OutboundAction({
  outbound,
}: {
  outbound: Extract<ProductPageOfferRow['outbound'], { kind: 'outbound' }>;
}) {
  return (
    <View className="gap-space-4">
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Go to ${outbound.destinationHost}`}
        onPress={() => {
          void Linking.openURL(`${config.apiUrl}${outbound.redirectPath}`);
        }}
        className="items-center rounded-radius-max border border-border-secondary p-space-12"
      >
        <Text className="text-buttonMedium text-text">{`Go to ${outbound.destinationHost}`}</Text>
      </Pressable>
      <Text className="text-caption text-text-secondary">
        {`You will continue on ${outbound.destinationHost}. Mercaria may earn a commission.`}
      </Text>
    </View>
  );
}

/**
 * What an unpurchasable row offers instead of an action.
 *
 * The destination HOST is disclosed — #67 rule 5's "preserve the real
 * destination merchant for user disclosure before the click" — and it is
 * deliberately not a link: a hostname cannot be followed by accident and
 * carries no tracking parameters, because it is not a URL.
 */
function UnavailableAction({ row }: { row: ProductPageOfferRow }) {
  const { outbound, offer } = row;
  if (outbound.kind !== 'unavailable') return null;

  if (outbound.reason === 'native_not_purchasable') {
    return (
      <Text className="text-caption text-text-secondary" accessibilityRole="text">
        {nativeBlockText(offer.checkout.eligible === true ? [] : offer.checkout.reasons)}
      </Text>
    );
  }

  return (
    <View className="gap-space-4">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          outbound.destinationHost === undefined
            ? 'This offer cannot be opened yet'
            : `Opening ${outbound.destinationHost} is not available yet`
        }
        accessibilityState={{ disabled: true }}
        disabled
        className="items-center rounded-radius-max border border-border-secondary p-space-12 opacity-60"
      >
        <Text className="text-buttonMedium text-text-secondary">
          {outbound.destinationHost === undefined
            ? 'No link published'
            : `Go to ${outbound.destinationHost}`}
        </Text>
      </Pressable>
      <Text className="text-caption text-text-secondary">
        {outbound.reason === 'no_destination'
          ? 'This seller published a price but no link.'
          : "Opening offers on other sites isn't available yet."}
      </Text>
    </View>
  );
}

/** Why a native offer cannot be bought, in the buyer's terms. */
function nativeBlockText(reasons: readonly string[]): string {
  if (reasons.includes('out_of_stock')) return 'This seller is out of stock.';
  if (reasons.includes('seller_not_payment_ready')) return 'This seller cannot take payment yet.';
  return 'This offer is not available to buy right now.';
}
