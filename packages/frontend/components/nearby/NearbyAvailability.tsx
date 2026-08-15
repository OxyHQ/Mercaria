import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import type { NearbyLocationResult } from "@mercaria/shared-types";
import { NearbyLocationCard, Text } from "@mercaria/ui";
import { NearbyOriginControl } from "@/components/nearby/NearbyOriginControl";
import { useNearbyAvailability, useNearbyOrigin } from "@/lib/hooks/use-nearby";

/**
 * "Available nearby" — the ONE nearby component every surface reuses
 * (#93 client rule 7).
 *
 * It takes a canonical subject and nothing else about the page it is on, so the
 * product page, a search result detail and a watchlist row all mount the same
 * component rather than three renderings of one idea that drift on the day the
 * freshness copy changes. It holds its OWN origin state, because an origin is a
 * thing a person grants to a question they asked — carrying one screen's origin
 * into another would be the ambient tracking #93 privacy rule 3 rules out.
 *
 * ## The list is the whole feature — there is no map (#93 client rule 8)
 *
 * No map provider, no map component, no tile URL, no marker. Accessibility does
 * not depend on a map here because a map does not exist: every result is a card
 * in a list with a heading, an address, a distance and an action.
 *
 * ## What "no results" means is never guessed at
 *
 * Three states are kept apart. No ORIGIN yet is not an answer about stock at
 * all. An origin with an EMPTY page means nothing published nearby currently
 * holds it — and that sentence names the reasons a location is withheld
 * (unpublished, stale, closed, out of stock) rather than saying "none", because
 * the server OMITS what it will not serve and the shopper otherwise reads the
 * silence as "this does not exist anywhere". An ERROR is a third thing again.
 *
 * ## Ordering
 *
 * The server answers nearest-first and that is the default, unsorted — the
 * array is rendered in the order it arrived. The one alternative is lowest
 * price, which is a FACT about the offers rather than a policy. There is
 * deliberately no "best overall": that would be a weighted blend of distance
 * and price composed on the client, which is a second, unversioned ranking
 * authority of exactly the kind #74's policy versions exist to be the only home
 * for. See `docs/pickup.md` §16.
 */

export interface NearbyAvailabilityProps {
  canonicalProductId?: string;
  canonicalVariantId?: string;
  /**
   * Ask the server for the actor-specific checkout verdict beside each place.
   *
   * OFF while browsing (#93 nearby rule 12): a shopper reading a product page
   * wants to know what is on a shelf, and "may I check out here" costs the
   * server per-location work a browse should not spend. A surface that is about
   * to offer a "collect here" control turns it on.
   */
  withCheckoutEligibility?: boolean;
  /** What choosing a place does. Absent means this surface only informs. */
  onSelectLocation?: (result: NearbyLocationResult) => void;
  selectLabel?: string;
  /** Where a guest is sent when a guest-only refusal is what is blocking them. */
  onSignIn?: () => void;
  /**
   * Offer a way through to the screen that can actually take a collection.
   *
   * Set by BROWSE surfaces, which deliberately did not ask for an actor verdict
   * and therefore must not render a "Collect here" control they cannot honour.
   * Absent on the collection screen itself, which is already that destination.
   */
  onSeeCollectionOptions?: () => void;
}

/** How the loaded results are ordered. Both are facts; neither is a policy. */
type NearbyOrder = "nearest" | "lowest_price";

export function NearbyAvailability({
  canonicalProductId,
  canonicalVariantId,
  withCheckoutEligibility = false,
  onSelectLocation,
  selectLabel,
  onSignIn,
  onSeeCollectionOptions,
}: NearbyAvailabilityProps) {
  const router = useRouter();
  const originState = useNearbyOrigin();
  const [order, setOrder] = useState<NearbyOrder>("nearest");

  const nearby = useNearbyAvailability({
    ...(canonicalProductId === undefined ? {} : { canonicalProductId }),
    ...(canonicalVariantId === undefined ? {} : { canonicalVariantId }),
    origin: originState.origin,
    withCheckoutEligibility,
  });

  const results = nearby.data?.results ?? [];

  /**
   * The relative-time baseline.
   *
   * `dataUpdatedAt` is React Query's own reactive state and is when this page
   * was actually fetched, so "stock confirmed 4 minutes ago" is measured from
   * the read that produced the figure. A `Date.now()` here would be an external
   * mutable read in a memoized position, which React Compiler is free to keep
   * from ever re-running — the freshness line would then freeze at whatever it
   * first rendered, which is the one thing this surface must not do.
   */
  const now = nearby.dataUpdatedAt === 0 ? 0 : nearby.dataUpdatedAt;

  const ordered = useMemo(() => {
    // `nearest` returns the array UNTOUCHED: the server ordered it, and
    // re-sorting by a distance we coarsened would reshuffle equal-looking
    // neighbours for no reason.
    if (order === "nearest") return results;
    return [...results].sort((a, b) => {
      // Only comparable within one currency. A page can legitimately mix them
      // (a border city, an external seller), and comparing raw minor units
      // across currencies is arithmetic on two different things — so anything
      // not in the first row's currency keeps its server position at the end
      // rather than being interleaved on a meaningless number.
      const base = results[0]?.price.currency;
      const aOk = a.price.currency === base;
      const bOk = b.price.currency === base;
      if (aOk !== bOk) return aOk ? -1 : 1;
      if (!aOk) return 0;
      return a.price.amount - b.price.amount;
    });
  }, [results, order]);

  const hasMore = nearby.data?.nextCursor !== undefined;

  return (
    <View className="gap-space-12">
      <Text className="text-sectionTitle text-text" accessibilityRole="header">
        Available nearby
      </Text>
      <Text className="text-caption text-text-secondary">
        Shops that have confirmed this on a shelf and offer collection. Paid online, collected in
        person.
      </Text>

      <NearbyOriginControl
        originState={originState}
        {...(canonicalProductId === undefined ? {} : { canonicalProductId })}
        {...(canonicalVariantId === undefined ? {} : { canonicalVariantId })}
      />

      {originState.origin === null ? (
        <Text className="text-caption text-text-tertiary">
          Choose a location to see which shops near you have this for collection. We use it for this
          search only — it is not saved.
        </Text>
      ) : nearby.isLoading ? (
        <Text className="text-caption text-text-tertiary">Looking for shops near you…</Text>
      ) : nearby.isError ? (
        <Text className="text-caption text-text-tertiary" accessibilityRole="alert">
          We could not check nearby availability just now. Delivery is unaffected.
        </Text>
      ) : results.length === 0 ? (
        <Text className="text-caption text-text-tertiary">
          No shop near this location currently has this for collection. Shops are left out when they
          are out of stock, closed for the period, not published for collection, or have not
          confirmed their stock recently enough.
        </Text>
      ) : (
        <View className="gap-space-12">
          {/*
            Two orders and no third. Rendered as a radiogroup because they are
            mutually exclusive views of one list, and labelled with what they
            actually order by rather than with a quality word.
          */}
          <View className="flex-row flex-wrap gap-space-8" accessibilityRole="radiogroup">
            {(
              [
                ["nearest", "Nearest first"],
                ["lowest_price", "Lowest price first"],
              ] as const
            ).map(([value, label]) => (
              <Pressable
                key={value}
                accessibilityRole="radio"
                accessibilityLabel={label}
                accessibilityState={{ selected: order === value }}
                onPress={() => setOrder(value)}
                className={
                  order === value
                    ? "rounded-radius-max bg-bg-fill-inverse px-space-12 py-space-6"
                    : "rounded-radius-max border border-border-secondary px-space-12 py-space-6"
                }
              >
                <Text
                  className={
                    order === value
                      ? "text-captionBold text-text-inverse"
                      : "text-captionBold text-text"
                  }
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>

          {ordered.map((result) => (
            <NearbyLocationCard
              key={`${result.location.locationId}:${result.variantId}`}
              result={result}
              now={now}
              onPressMerchant={(slug) =>
                router.push(`/merchants/${slug}` as Parameters<typeof router.push>[0])
              }
              {...(onSelectLocation === undefined ? {} : { onSelect: onSelectLocation })}
              {...(selectLabel === undefined ? {} : { selectLabel })}
              {...(onSignIn === undefined ? {} : { onSignIn })}
            />
          ))}

          {/*
            Said out loud rather than hidden, because the re-order above applies
            to what is LOADED. A page that silently sorted a keyset slice and
            called it "lowest price" would be claiming a comparison it did not
            make.
          */}
          {hasMore ? (
            <Text className="text-caption text-text-tertiary">
              These are the nearest {results.length}. There are more shops further out, and the
              ordering above applies to the ones shown.
            </Text>
          ) : null}

          {/*
            A browse surface hands over to the screen that can take a
            collection rather than growing a control it cannot honour: it never
            asked whether THIS shopper may check out here, so a "collect here"
            button on it would be a promise made without the answer.
          */}
          {onSeeCollectionOptions === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose a shop to collect from"
              onPress={onSeeCollectionOptions}
              className="self-start rounded-radius-max bg-bg-fill-inverse px-space-16 py-space-8"
            >
              <Text className="text-buttonSmall text-text-inverse">Collect in person</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}
