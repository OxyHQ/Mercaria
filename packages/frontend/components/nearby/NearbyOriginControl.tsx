import { useState } from "react";
import { Pressable, View } from "react-native";
import type { NearbyPlaceSuggestion } from "@mercaria/shared-types";
import { Input, Text } from "@mercaria/ui";
import { useNearbyPlaces, type NearbyOriginState } from "@/lib/hooks/use-nearby";

/**
 * How a shopper says where they are (#93 client rules 1 and 2, acceptance 5).
 *
 * ## Nothing is asked for until somebody asks for it
 *
 * There is no permission request on mount, no `watchPosition`, no subscription
 * and no background read — #93 location-input rules 1 and 3 are the ABSENCE of
 * those calls rather than a setting somebody could flip. `requestDeviceOrigin`
 * is reached from a control a person presses and from nowhere else.
 *
 * ## The manual path is offered FIRST, beside the device one, not after a refusal
 *
 * This is the anti-dark-pattern decision and it is the reason the two controls
 * are siblings of equal weight rather than a primary button with a "no thanks"
 * link under it. A shopper who never wants to share a position must not have to
 * refuse a prompt to discover that typing a city works — and a refusal must not
 * be answered by asking again, which is why a denial swaps the device control
 * for a sentence rather than leaving a button that re-prompts.
 *
 * ## The city list can never be a dead end
 *
 * `GET /nearby/places` is composed from the published locations that actually
 * hold this item, so a city is offered exactly when something is collectable in
 * it (`docs/pickup.md` §7). Picking one yields a CELL CENTRE — so the manual
 * path never handles a precise coordinate at all, and a shopper who declines
 * the prompt gives up nothing except precision they chose not to give.
 *
 * ## No coordinate reaches a URL, a store or an analytics call
 *
 * #93 client rule 14 and privacy rules 4-6. The origin lives in the state
 * `useNearbyOrigin` holds for as long as the screen is open. This component
 * imports no router-param setter, no storage and no analytics client, and the
 * search TERM a shopper types is a city name rather than a position.
 */

export interface NearbyOriginControlProps {
  originState: NearbyOriginState;
  /** Which canonical entity the city suggestions must actually stock. */
  canonicalProductId?: string;
  canonicalVariantId?: string;
}

/** What a shopper is told when a device position could not be obtained. */
const REFUSAL_COPY = {
  permission_denied:
    "No problem — location stays off. Type a city or postcode below and we will look there instead.",
  unsupported:
    "This app cannot read a device location. Type a city or postcode below and we will look there.",
  unavailable:
    "Your device could not fix a position just now. Type a city or postcode below, or try again.",
} as const;

export function NearbyOriginControl({
  originState,
  canonicalProductId,
  canonicalVariantId,
}: NearbyOriginControlProps) {
  const { origin, refusal, requesting, requestDeviceOrigin, selectPlace, clearOrigin } = originState;
  const [term, setTerm] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const places = useNearbyPlaces({
    ...(canonicalProductId === undefined ? {} : { canonicalProductId }),
    ...(canonicalVariantId === undefined ? {} : { canonicalVariantId }),
    ...(term.trim().length > 0 ? { term: term.trim() } : {}),
    // The list is fetched when the picker is open OR when a refusal has made it
    // the only path forward, so the fallback is already populated at the moment
    // it becomes the answer rather than after another tap.
    enabled: pickerOpen || refusal !== null,
  });

  // An origin is set: say so, and offer to take it back. A shopper who shared a
  // position must be able to withdraw it in one press (#93 privacy rule 4 in
  // spirit — nothing here persists, so clearing genuinely forgets it).
  if (origin !== null) {
    return (
      <View className="flex-row flex-wrap items-center gap-space-8">
        <Text className="text-caption text-text-secondary">
          {origin.source === "device"
            ? "Showing shops near your device location."
            : "Showing shops near the place you chose."}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Change the place these results are measured from"
          onPress={() => {
            clearOrigin();
            setPickerOpen(true);
          }}
        >
          <Text className="text-captionBold text-text">Change</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop using a location for these results"
          onPress={() => {
            clearOrigin();
            setPickerOpen(false);
          }}
        >
          <Text className="text-captionBold text-text">Clear</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="gap-space-8">
      <View className="flex-row flex-wrap items-center gap-space-8">
        {/*
          The device control DISAPPEARS after a refusal rather than staying to
          be pressed again. Re-prompting somebody who just said no is the dark
          pattern this rule exists to prevent, and the sentence that replaces it
          points at the path that works.
        */}
        {refusal === null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Use my device location to find nearby shops"
            accessibilityState={{ busy: requesting }}
            disabled={requesting}
            onPress={requestDeviceOrigin}
            className="rounded-radius-max border border-border-secondary px-space-16 py-space-8"
          >
            <Text className="text-buttonSmall text-text">
              {requesting ? "Checking…" : "Use my location"}
            </Text>
          </Pressable>
        ) : null}

        {/*
          Always present, and never secondary. Typing a city is a first-class
          way to use this feature, not a consolation for declining.
        */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose a city or postcode instead"
          onPress={() => setPickerOpen((open) => !open)}
          className="rounded-radius-max border border-border-secondary px-space-16 py-space-8"
        >
          <Text className="text-buttonSmall text-text">
            {pickerOpen ? "Hide city list" : "Choose a city"}
          </Text>
        </Pressable>
      </View>

      {refusal === null ? null : (
        <Text className="text-caption text-text-secondary" accessibilityRole="alert">
          {REFUSAL_COPY[refusal]}
        </Text>
      )}

      {pickerOpen || refusal !== null ? (
        <View className="gap-space-8">
          <Input
            accessibilityLabel="City or postcode"
            value={term}
            onChangeText={setTerm}
            placeholder="City or postcode"
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="search"
          />
          {/*
            Four states, each its own sentence. "We are still loading" and "no
            city stocks this" are different facts and rendering the second while
            the first is true is how an empty list becomes a wrong answer.
          */}
          {places.isLoading ? (
            <Text className="text-caption text-text-tertiary">Looking for cities…</Text>
          ) : places.isError ? (
            <Text className="text-caption text-text-tertiary">
              We could not load the city list just now.
            </Text>
          ) : (places.data ?? []).length === 0 ? (
            <Text className="text-caption text-text-tertiary">
              {term.trim().length > 0
                ? "No city matching that has this in stock for collection."
                : "No shop is currently stocking this for collection."}
            </Text>
          ) : (
            (places.data ?? []).map((place: NearbyPlaceSuggestion) => (
              <Pressable
                key={`${place.country}:${place.city}:${place.cell.latIndex}:${place.cell.lonIndex}`}
                accessibilityRole="button"
                accessibilityLabel={`Search near ${place.label}`}
                onPress={() => {
                  selectPlace(place);
                  setPickerOpen(false);
                }}
                className="rounded-radius-12 border border-border-secondary px-space-12 py-space-8"
              >
                <Text className="text-bodySmall text-text">{place.label}</Text>
                <Text className="text-caption text-text-tertiary">
                  {place.locationCount === 1
                    ? "1 shop with stock"
                    : `${place.locationCount} shops with stock`}
                </Text>
              </Pressable>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}
