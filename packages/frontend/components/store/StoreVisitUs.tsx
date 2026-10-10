import { Pressable, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { Rating } from '@oxy.so/bloom/rating';
import { useOxy } from '@oxy.so/services';
import { placeDisplayName, type Place } from '@goway.to/sdk';
import type { MercariaLocation } from '@mercaria/contracts';
import {
  PICKUP_IDENTITY_REQUIREMENT_KEYS,
  PICKUP_PAYMENT_REQUIREMENT_KEYS,
  SectionHeader,
  Text,
  describeOpenState,
  formatDate,
  formatWeekday,
  useRatingDisplay,
  useSharedUiTranslation,
} from '@mercaria/ui';
import { goWayClient } from '@/lib/goway-client';
import { openGoWayLink } from '@/lib/goway';
import { useGoWayPlace, useGoWayPlacePhotos, useStoreLocations } from '@/lib/hooks/use-visit-us';
import { useTranslation } from '@/lib/i18n';
import {
  VISIT_ATTRIBUTE_GROUPS,
  calendarDate,
  orderLocations,
  placeAddressLine,
  placeOpenState,
  placeToday,
  upcomingExceptions,
  visitAttributes,
  visitPhotos,
  weeklyHours,
  type VisitAttributeGroup,
} from '@/lib/visit-us';

/** How close GoWay's map opens on a shop front: a street, not a city. */
const MAP_ZOOM = 17;

/** KEYS, resolved with `t()` at the render site. */
const ATTRIBUTE_GROUP_KEYS: Readonly<Record<VisitAttributeGroup, string>> = {
  accessibility: 'store.visit.accessibility',
  payment: 'store.visit.payment',
};

/**
 * The store page's "Visit us" section: one card per public shop front.
 *
 * ## Mercaria says WHICH shop fronts, GoWay says everything about them
 *
 * The list is the store's public locations as `/public/v1` serves them — the
 * same answer GoWay's place page reads "products at this store" from, so the
 * two cannot disagree about which shops are open to the public. Each card then
 * reads its place from GoWay with `@goway.to/sdk` (ADR 0013): name, address,
 * open-now, the week's hours and its exceptions, accessibility and payment,
 * photos and rating. Nothing here is stored by Mercaria, and nothing here is
 * worded twice: "open now" is GoWay's own evaluation in the shared wording the
 * collection surfaces use.
 *
 * ## No map provider
 *
 * GoWay's rule is that a map is drawn behind GoWay's own abstractions, and the
 * storefront holds none, so a card links OUT to GoWay — the place page for its
 * reviews and the map framed on the shop — rather than embedding one.
 *
 * Nothing renders for a store with no public location, and the section does
 * not hold up the page: the store and its products render whatever GoWay says.
 */
export function StoreVisitUs({
  storeId,
  focusLocationId,
}: {
  storeId: string;
  /** The `?location=` deep link: that shop front is listed first. */
  focusLocationId: string | undefined;
}) {
  const { t } = useTranslation();
  const { data: locations } = useStoreLocations(storeId);
  if (locations === undefined || locations.length === 0) return null;

  return (
    <View className="mb-8">
      <SectionHeader title={t('store.visit.heading')} />
      <View className="gap-4 px-4">
        {orderLocations(locations, focusLocationId).map((location) => (
          <StoreLocationCard key={location.ref.id} location={location} />
        ))}
      </View>
    </View>
  );
}

function StoreLocationCard({ location }: { location: MercariaLocation }) {
  const { t, locale } = useTranslation();
  const place = useGoWayPlace(location.goWayPlaceId, locale);
  const placeUrl = goWayClient.links.place(location.goWayPlaceId);

  if (place.data === undefined) {
    return (
      <View
        className="min-h-40 justify-center gap-2 rounded-2xl border border-border bg-muted p-4"
        accessibilityLabel={place.isError ? undefined : t('store.visit.loading')}
      >
        {place.isError ? (
          <>
            <Text className="text-sm text-muted-foreground">
              {t('store.visit.placeUnavailable')}
            </Text>
            <GoWayLink label={t('store.visit.viewOnGoWay')} url={placeUrl} />
          </>
        ) : null}
      </View>
    );
  }

  return (
    <PlaceCard
      location={location}
      place={place.data}
      // When the place was read, so "open until 20:00" is measured from the read
      // that produced it — a `Date.now()` here is a clock React Compiler may
      // never re-run (`NearbyAvailability`'s reasoning).
      now={new Date(place.dataUpdatedAt)}
      placeUrl={placeUrl}
    />
  );
}

function PlaceCard({
  location,
  place,
  now,
  placeUrl,
}: {
  location: MercariaLocation;
  place: Place;
  now: Date;
  placeUrl: string;
}) {
  const { t, locale } = useTranslation();
  const uiT = useSharedUiTranslation();
  const ratingDisplay = useRatingDisplay();
  const name = placeDisplayName(place);
  const address = placeAddressLine(place);
  const week = weeklyHours(place);
  const exceptions = upcomingExceptions(place, placeToday(place, now));
  const attributes = visitAttributes(place, locale);
  const reviews = place.rating?.count ?? 0;

  return (
    <View className="gap-3 rounded-2xl border border-border bg-muted p-4">
      <View className="gap-1">
        <Text className="text-lg font-bold text-foreground" accessibilityRole="header">
          {name}
        </Text>
        {address === '' ? null : <Text className="text-sm text-muted-foreground">{address}</Text>}
        <Text className="text-sm font-semibold text-foreground">
          {describeOpenState(uiT, placeOpenState(place, now))}
        </Text>
      </View>

      <PlacePhotos placeId={place.id} placeName={name} />

      {week === null ? null : (
        <View className="gap-1" accessibilityLabel={t('store.visit.hoursHeading')}>
          <Text className="text-sm font-semibold text-foreground">
            {t('store.visit.hoursHeading')}
          </Text>
          {week.map((row) => (
            <View key={row.day} className="flex-row justify-between gap-4">
              <Text className="text-sm text-muted-foreground">
                {formatWeekday(row.day, locale)}
              </Text>
              <Text className="text-sm text-foreground">
                {row.spans.length === 0
                  ? t('store.visit.closedAllDay')
                  : row.spans
                      .map((span) =>
                        t('store.visit.span', { opens: span.opens, closes: span.closes }),
                      )
                      .join(', ')}
              </Text>
            </View>
          ))}
        </View>
      )}

      {exceptions.length === 0 ? null : (
        <View className="gap-1">
          <Text className="text-sm font-semibold text-foreground">
            {t('store.visit.exceptionsHeading')}
          </Text>
          {exceptions.map((exception) => {
            const from = formatDate(calendarDate(exception.startsOn), locale) ?? exception.startsOn;
            const dates =
              exception.endsOn === exception.startsOn
                ? from
                : t('store.visit.dateRange', {
                    from,
                    to: formatDate(calendarDate(exception.endsOn), locale) ?? exception.endsOn,
                  });
            const hours = exception.intervals
              .map((span) => t('store.visit.span', { opens: span.opens, closes: span.closes }))
              .join(', ');
            return (
              <View key={exception.id}>
                <Text className="text-sm text-foreground">
                  {exception.closed
                    ? t('store.visit.exceptionClosed', { dates })
                    : t('store.visit.exceptionHours', { dates, hours })}
                </Text>
                {exception.note === undefined ? null : (
                  <Text className="text-xs text-muted-foreground">{exception.note}</Text>
                )}
              </View>
            );
          })}
        </View>
      )}

      {VISIT_ATTRIBUTE_GROUPS.map((group) => {
        const held = attributes.filter((attribute) => attribute.group === group);
        if (held.length === 0) return null;
        return (
          <View key={group} className="gap-2">
            <Text className="text-sm font-semibold text-foreground">
              {t(ATTRIBUTE_GROUP_KEYS[group])}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {held.map((attribute) => (
                <View key={attribute.key} className="rounded-full border border-border px-3 py-1">
                  <Text className="text-xs text-foreground">
                    {attribute.valueLabel === undefined
                      ? attribute.label
                      : t('store.visit.attributeValue', {
                          attribute: attribute.label,
                          value: attribute.valueLabel,
                        })}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        );
      })}

      {location.pickup === null || !location.discoverable ? null : (
        <View className="gap-1">
          <Text className="text-sm font-semibold text-foreground">
            {t('store.visit.collectHere')}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {uiT(PICKUP_PAYMENT_REQUIREMENT_KEYS[location.pickup.paymentRequirement])}{' '}
            {uiT(PICKUP_IDENTITY_REQUIREMENT_KEYS[location.pickup.identityRequirement])}
          </Text>
          {location.pickup.instructions === null ? null : (
            <Text className="text-xs text-muted-foreground">{location.pickup.instructions}</Text>
          )}
        </View>
      )}

      {/* The place's own reviews, which are GoWay's — not this store's seller rating. */}
      {reviews === 0 || place.rating === undefined ? null : (
        <Rating
          {...ratingDisplay({
            rating: place.rating.average,
            reviews,
            subject: t('store.visit.placeRatingSubject', { place: name }),
            variant: 'stars',
          })}
          variant="stars"
        />
      )}

      <View className="flex-row flex-wrap gap-x-4 gap-y-2">
        <GoWayLink
          label={reviews === 0 ? t('store.visit.viewOnGoWay') : t('store.visit.reviewsOnGoWay')}
          url={placeUrl}
        />
        <GoWayLink
          label={t('store.visit.openMap')}
          url={goWayClient.links.map({
            latitude: place.location.latitude,
            longitude: place.location.longitude,
            zoom: MAP_ZOOM,
          })}
        />
      </View>
    </View>
  );
}

/** A horizontal strip of the place's own photos, rendered from Oxy; nothing when it has none. */
function PlacePhotos({ placeId, placeName }: { placeId: string; placeName: string }) {
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const { data } = useGoWayPlacePhotos(placeId);
  const photos = visitPhotos(data ?? []);
  if (photos.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8 }}
    >
      {photos.map((photo) => (
        <Image
          key={photo.id}
          source={{ uri: oxyServices.assets.publicUrl(photo.fileId, 'thumb') }}
          contentFit="cover"
          accessibilityLabel={photo.caption ?? t('store.visit.photoLabel', { place: placeName })}
          className="h-24 w-32 rounded-xl bg-background"
        />
      ))}
    </ScrollView>
  );
}

/** A link out to GoWay, opened in the browser or the GoWay app. */
function GoWayLink({ label, url }: { label: string; url: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={() => openGoWayLink(url)}
      className="self-start"
    >
      <Text className="text-sm font-semibold text-foreground underline">{label}</Text>
    </Pressable>
  );
}
