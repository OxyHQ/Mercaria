import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import * as WebBrowser from 'expo-web-browser';
import { ChevronLeft } from 'lucide-react-native';
import type { Place } from '@goway.to/sdk';
import { Text, useColorScheme } from '@mercaria/ui';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import { EditorSection } from '@/components/locations/EditorSection';
import { HoursExceptionsCard } from '@/components/locations/HoursExceptionsCard';
import { PlaceAccessibilityCard } from '@/components/locations/PlaceAccessibilityCard';
import { PlaceClaimCard } from '@/components/locations/PlaceClaimCard';
import { PlaceContactCard } from '@/components/locations/PlaceContactCard';
import { PlaceHoursCard } from '@/components/locations/PlaceHoursCard';
import { PlaceLinkStatusCard } from '@/components/locations/PlaceLinkStatusCard';
import { PlacePickerCard } from '@/components/locations/PlacePickerCard';
import { PublicationCard } from '@/components/locations/PublicationCard';
import { StoreLinkCard } from '@/components/locations/StoreLinkCard';
import { useGoWayPlace, useGoWayPlaceUrl, usePlaceClaims } from '@/lib/goway/hooks';
import { goWayErrorKey } from '@/lib/goway/errors';
import { claimOnPlace } from '@/lib/goway/place-link';
import { useLocationPublication } from '@/lib/hooks/use-location-publication';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import { useLocations } from '@/lib/hooks/use-tax-and-locations';
import { useTranslation } from '@/lib/i18n';

/** What a place's status reads as, as KEYS. */
const PLACE_STATUS_KEYS: Record<Place['status'], string> = {
  active: 'settings.locations.editor.place.status.active',
  closed: 'settings.locations.editor.place.status.closed',
  proposed: 'settings.locations.editor.place.status.proposed',
};

/**
 * One location's editor (ADR 0013): its GoWay place, and Mercaria's commerce
 * terms for it.
 *
 * The place — name, address, position, hours, exceptions, contact,
 * accessibility — is GoWay's, and every edit on it goes straight to GoWay with
 * the merchant's own Oxy session. Mercaria stores which place, and whether and
 * how the location offers collection. The order on screen is the order the
 * work happens in: find or create the place, claim it for the store's Oxy
 * account, say on it which location it is, describe it, then save and publish
 * the Mercaria side — with the status card at the top answering "will shoppers
 * find it" at every step.
 */
export default function LocationEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('settings.locations.editor.documentTitle')}</title>
      </Head>
      <RequireStore permission="locations:write">
        {(storeId) => <LocationEditorBody storeId={storeId} locationId={String(id)} />}
      </RequireStore>
    </>
  );
}

function LocationEditorBody({ storeId, locationId }: { storeId: string; locationId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { store } = useActiveStoreContext();
  const locations = useLocations(storeId);
  const publication = useLocationPublication(storeId, locationId);
  const location = locations.data?.find((candidate) => candidate.id === locationId);

  // The place the merchant has CHOSEN on this screen, ahead of saving it to
  // Mercaria; until they choose, the one the location already names.
  const [chosenPlaceId, setChosenPlaceId] = useState<string | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const placeId = chosenPlaceId ?? location?.goWayPlaceId;
  const place = useGoWayPlace(placeId);
  const placeUrl = useGoWayPlaceUrl(placeId);
  const claims = usePlaceClaims(store?.oxyAccountId, placeId);
  const claim = placeId === undefined ? undefined : claimOnPlace(claims.data ?? [], placeId);

  const back = (
    <Pressable
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">{t('common.back')}</Text>
    </Pressable>
  );

  if (locations.isPending || publication.isPending || !store) {
    return (
      <Screen title={t('settings.locations.editor.title')} action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (locations.isError || publication.isError || location === undefined) {
    return (
      <Screen title={t('settings.locations.editor.title')} action={back}>
        <ScreenMessage
          title={t('settings.locations.editor.loadFailed')}
          body={t('common.pleaseTryAgain')}
        />
      </Screen>
    );
  }

  return (
    <Screen title={location.name} subtitle={t('settings.locations.editor.subtitle')} action={back}>
      <View className="gap-4 pb-10">
        <PlaceLinkStatusCard
          storeId={storeId}
          locationId={location.id}
          hasPlace={location.goWayPlaceId !== undefined}
          claim={claim}
        />

        {placeId === undefined || picking ? (
          <PlacePickerCard
            defaultName={location.name}
            onChoose={(chosen) => {
              setChosenPlaceId(chosen);
              setPicking(false);
            }}
          />
        ) : (
          <EditorSection title={t('settings.locations.editor.place.title')}>
            {place.isPending ? (
              <ScreenLoading />
            ) : place.isError ? (
              <Text className="text-sm text-muted-foreground">{t(goWayErrorKey(place.error))}</Text>
            ) : (
              <View className="gap-1">
                <View className="flex-row items-center gap-2">
                  <Text className="text-sm font-semibold text-foreground">{place.data.name}</Text>
                  <Badge
                    size="label-small"
                    variant="subtle"
                    color={place.data.status === 'active' ? 'success' : 'warning'}
                    content={t(PLACE_STATUS_KEYS[place.data.status])}
                  />
                </View>
                {place.data.address?.formatted ? (
                  <Text className="text-xs text-muted-foreground">
                    {place.data.address.formatted}
                  </Text>
                ) : null}
                {chosenPlaceId !== undefined && chosenPlaceId !== location.goWayPlaceId ? (
                  <Text className="text-xs text-muted-foreground">
                    {t('settings.locations.editor.place.chosenNotSaved')}
                  </Text>
                ) : null}
              </View>
            )}
            <View className="flex-row flex-wrap gap-2">
              <Button
                size="sm"
                tone="neutral"
                appearance="outline"
                onPress={() => setPicking(true)}
              >
                {t('settings.locations.editor.place.change')}
              </Button>
              {placeUrl ? (
                <Button
                  size="sm"
                  tone="neutral"
                  appearance="outline"
                  onPress={() => void WebBrowser.openBrowserAsync(placeUrl)}
                >
                  {t('settings.locations.editor.openOnGoWay')}
                </Button>
              ) : null}
            </View>
          </EditorSection>
        )}

        {place.data && !picking ? (
          <>
            <PlaceClaimCard
              placeId={place.data.id}
              oxyAccountId={store.oxyAccountId}
              claim={claim}
              claimsUnreadable={claims.isError}
            />
            <StoreLinkCard place={place.data} locationId={location.id} />
            <PlaceHoursCard key={`hours-${place.data.id}`} place={place.data} />
            <HoursExceptionsCard placeId={place.data.id} />
            <PlaceContactCard key={`contact-${place.data.id}`} place={place.data} />
            <PlaceAccessibilityCard key={`accessibility-${place.data.id}`} place={place.data} />
          </>
        ) : null}

        <PublicationCard
          key={publication.data?.id ?? 'new'}
          storeId={storeId}
          locationId={location.id}
          publication={publication.data}
          goWayPlaceId={placeId}
        />
      </View>
    </Screen>
  );
}
