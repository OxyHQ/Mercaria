import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { Bell, Heart, Package, TrendingDown, TrendingUp } from "lucide-react-native";
import { ALL_CURRENCY_CODES, type CurrencyCode, type SavedItem } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { PriceDisplay } from "../PriceDisplay";
import { conditionGroupLabelKey } from "../../lib/condition";
import { useSharedUiTranslation } from "../../i18n/ui-translation";

/** Icon size for the row's leading and trailing affordances. */
const ICON_SIZE = 18;

export interface SavedItemCardProps {
  item: SavedItem;
  /** Resolve an Oxy file id to something `expo-image` can render. */
  resolveImage?: (fileId: string) => string;
  onPress?: (item: SavedItem) => void;
  onRemove?: (item: SavedItem) => void;
  /** Answer a split ambiguity. Only ever called for a product entry. */
  onResolveSplit?: (item: SavedItem) => void;
  /**
   * Start creating a price alert for this product (#79).
   *
   * The card NAVIGATES and never subscribes: #80's "the API offers the action
   * without creating an alert automatically" is held here by the handler being
   * the caller's, and by this component holding no alert state to report.
   */
  onCreatePriceAlert?: (item: SavedItem) => void;
}

/**
 * One row of the saved list — a canonical PRODUCT save or an exact LISTING save
 * (#80).
 *
 * The two are rendered as visibly different things, which is the UI half of the
 * whole issue: a product row says what the best current offer is and how the
 * price has moved since it was saved, while a listing row names the one item and
 * says whether it is still available. A single row shape that showed "a price"
 * for both would tell a buyer their saved handmade chair had dropped in price
 * when what actually happened is that a different chair got cheaper.
 *
 * Three states this row is careful about, each because the alternative is a
 * plausible lie:
 *
 *  - **No current offer** renders the REASON, never a blank or a zero. A saved
 *    product whose offers all expired is #80 acceptance 7's own case.
 *  - **A withheld save count** renders nothing at all rather than a rounded
 *    number: "under 10" beside a product page is a person.
 *  - **An ambiguous save** renders a prompt, not a warning. A split divided the
 *    product and only the buyer can say which half they meant.
 */
export function SavedItemCard({
  item,
  resolveImage,
  onPress,
  onRemove,
  onResolveSplit,
  onCreatePriceAlert,
}: SavedItemCardProps) {
  const imageSource =
    item.kind === "product"
      ? item.product.imageFileId
      : item.imageFileId;

  return (
    <View className="flex-row gap-space-12 rounded-radius-16 border border-border-secondary bg-bg-fill p-space-12">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          item.kind === "product" ? item.product.name : item.title
        }
        onPress={() => onPress?.(item)}
        className="size-space-64 overflow-hidden rounded-radius-12 bg-bg-fill-secondary"
      >
        {imageSource ? (
          <Image
            source={{ uri: resolveImage ? resolveImage(imageSource) : imageSource }}
            style={{ width: "100%", height: "100%" }}
            contentFit="cover"
          />
        ) : (
          <View className="size-full items-center justify-center">
            <Package size={ICON_SIZE} className="text-text-tertiary" />
          </View>
        )}
      </Pressable>

      <View className="flex-1 gap-space-4">
        {item.kind === "product" ? (
          <ProductBody
            item={item}
            onResolveSplit={onResolveSplit}
            onCreatePriceAlert={onCreatePriceAlert}
          />
        ) : (
          <ListingBody item={item} />
        )}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          item.kind === "product" ? "Remove this saved product" : "Remove this saved listing"
        }
        onPress={() => onRemove?.(item)}
        className="size-space-32 items-center justify-center rounded-radius-max"
      >
        <Heart size={ICON_SIZE} className="text-text-brand" fill="currentColor" />
      </Pressable>
    </View>
  );
}

function ProductBody({
  item,
  onResolveSplit,
  onCreatePriceAlert,
}: {
  item: Extract<SavedItem, { kind: "product" }>;
  onResolveSplit?: (item: SavedItem) => void;
  onCreatePriceAlert?: (item: SavedItem) => void;
}) {
  const t = useSharedUiTranslation();

  return (
    <>
      <Text className="text-bodyTitleSmall text-text" numberOfLines={2}>
        {item.product.name}
      </Text>
      <Text className="text-caption text-text-tertiary">Saved product</Text>

      {item.offer.state === "available" ? (
        <View className="flex-row items-center gap-space-8">
          <OfferPrice price={item.offer.price} />
          {item.offer.conditionGroup ? (
            <Text className="text-caption text-text-tertiary">
              {t(conditionGroupLabelKey(item.offer.conditionGroup))}
            </Text>
          ) : null}
        </View>
      ) : (
        // #80 acceptance 7: the absence carries its reason, so the row still
        // tells the buyer what to do next.
        <Text className="text-caption text-text-tertiary">{noOfferCopy(item.offer.reason)}</Text>
      )}

      {item.priceChange.known && item.priceChange.direction !== "unchanged" ? (
        <View className="flex-row items-center gap-space-4">
          {item.priceChange.direction === "down" ? (
            <TrendingDown size={ICON_SIZE} className="text-text-brand" />
          ) : (
            <TrendingUp size={ICON_SIZE} className="text-text-tertiary" />
          )}
          <Text className="text-caption text-text-tertiary">
            {item.priceChange.direction === "down"
              ? "Cheaper than when you saved it"
              : "More than when you saved it"}
          </Text>
        </View>
      ) : null}

      {item.product.saveCount.disclosed ? (
        <Text className="text-caption text-text-tertiary">
          {item.product.saveCount.count} people saved this
        </Text>
      ) : null}

      {item.save.resolution.state === "ambiguous_after_split" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose which product you meant"
          onPress={() => onResolveSplit?.(item)}
          className="mt-space-4 self-start rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-4"
        >
          <Text className="text-caption text-text">
            This product was split — choose which one you meant
          </Text>
        </Pressable>
      ) : null}

      {/*
        #79 closed the seam #80 opened, so the affordance is real — and it is
        still rendered ONLY on the supported branch. A deployment with
        `PRICE_ALERTS_ENABLED` off gets nothing rather than a greyed-out bell,
        because a control that claims an unbuilt feature exists is exactly what
        the one-branch seam was avoiding.

        It says "Set" and never "Alert set": this card carries no alert state at
        all (the DTO has none — the saved-list domain may not read #79's), so
        anything about what the buyer has already set would be a guess.
      */}
      {item.priceAlert.supported && onCreatePriceAlert ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Set a price alert for this product"
          onPress={() => onCreatePriceAlert(item)}
          className="mt-space-4 flex-row items-center gap-space-4 self-start rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-4"
        >
          <Bell size={ICON_SIZE - 4} className="text-text-secondary" />
          <Text className="text-caption text-text">Set a price alert</Text>
        </Pressable>
      ) : null}
    </>
  );
}

function ListingBody({ item }: { item: Extract<SavedItem, { kind: "listing" }> }) {
  return (
    <>
      <Text className="text-bodyTitleSmall text-text" numberOfLines={2}>
        {item.title}
      </Text>
      <Text className="text-caption text-text-tertiary">
        {item.intent === "listing_pin" ? "Pinned listing" : "Saved listing"}
      </Text>
      <PriceDisplay price={item.price} primaryClassName="text-bodyTitleSmall text-text" />
      {item.available ? null : (
        <Text className="text-caption text-text-tertiary">No longer available</Text>
      )}
    </>
  );
}

/**
 * An offer's price, rendered through `PriceDisplay` only when its currency is
 * one Mercaria can present.
 *
 * `OfferMoney.currency` is a plain string on purpose (ADR 0002 D18: an external
 * platform trades in whatever it trades in), while `PriceDisplay` converts a
 * `Money` whose currency is Mercaria's presentment union. Narrowing by
 * MEMBERSHIP rather than casting is the difference between a currency the FX
 * layer can actually convert and one it will silently fail to.
 *
 * The unpresentable branch shows the CODE AND NO NUMBER (#441). It used to print
 * `price.amount` raw, which is integer MINOR units — `129900 RON` for a price of
 * 1299.00. Membership in `ALL_CURRENCY_CODES` is the SAME question as a known
 * `CURRENCY_PRECISION` entry (the former is literally `Object.keys` of the
 * latter), so this branch is exactly where `formatSourceMoney` returns `null`,
 * and this is that documented contract honoured rather than a second rendering
 * of it: with no precision there is no divisor, so any number printed here is a
 * guess. `OfferRow`'s delivery line already resolves its own `null` the same way.
 */
function OfferPrice({ price }: { price?: { amount: number; currency: string } }) {
  if (!price) {
    return <Text className="text-caption text-text-tertiary">Price not published</Text>;
  }
  const presentable: CurrencyCode | undefined = ALL_CURRENCY_CODES.find(
    (code) => code === price.currency,
  );
  if (!presentable) {
    return (
      <Text className="text-caption text-text-tertiary">
        Price published in {price.currency}
      </Text>
    );
  }
  return (
    <PriceDisplay
      price={{ amount: price.amount, currency: presentable }}
      primaryClassName="text-bodyTitleSmall text-text"
    />
  );
}

/** Plain-language copy for each reason a saved product has nothing to buy. */
function noOfferCopy(reason: string): string {
  switch (reason) {
    case "no_offers_recorded":
      return "No seller has listed this yet";
    case "all_offers_retired":
      return "No one is selling this right now";
    case "no_eligible_offer":
      return "No offer matches your filters";
    default:
      return "No current offer";
  }
}
