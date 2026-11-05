import { RiStore2Line } from '@oxy.so/bloom/icons/RiStore2Line';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { useEffect, useState } from 'react';
import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { Calculator, Check, ChevronLeft, MapPin, Store as StoreIcon } from 'lucide-react-native';
import type { Location, Store } from '@mercaria/shared-types';
import { Text, toBloomIcon, useColorScheme } from '@mercaria/ui';
import { Button } from '@oxy.so/bloom/button';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { useMyStores } from '@/lib/hooks/use-stores';
import { useLocations } from '@/lib/hooks/use-locations';
import { usePosRegisters } from '@/lib/hooks/use-pos-registers';
import { registerChoices } from '@/lib/register-choice';
import { useActiveStore } from '@/lib/stores/active-store';
import { useTranslation } from '@/lib/i18n';
import { LOCATION_TYPE_LABEL_KEYS } from '@/lib/order-labels';

/**
 * Store + register picker. The operator first picks the store they're working
 * for, then the register location stock commits at. Selecting a location starts
 * the register (`/`) — unless the store has NAMED registers at that location (a
 * paid plan's `expanded_pos_registers`), when the device also picks which one it
 * is, or the location's default register. A store without named registers, which
 * is every free store, never sees that step. This screen sets the active
 * store/location, so it must NOT be guarded by `RequirePos`/`RequireStore`.
 */
export default function StoreSetupScreen() {
  const { activeStoreId } = useActiveStore();
  const { t } = useTranslation();

  return (
    <>
      <Head>
        <title>{t('storeSetup.documentTitle')}</title>
      </Head>
      {activeStoreId ? <LocationStep storeId={activeStoreId} /> : <StoreStep />}
    </>
  );
}

/** Step A — pick the store to ring up against. */
function StoreStep() {
  const { t } = useTranslation();
  const { data: stores, isPending, isError } = useMyStores();
  const { setActiveStoreId } = useActiveStore();

  const onSelect = (store: Store) => {
    // Setting a (new) store clears any previously-picked register location.
    setActiveStoreId(store.id);
  };

  return (
    <Screen title={t('storeSetup.chooseStoreTitle')} subtitle={t('storeSetup.chooseStoreSubtitle')}>
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title={t('storeSetup.storesLoadFailed')} body={t('common.pleaseTryAgain')} />
      ) : stores && stores.length > 0 ? (
        <View className="gap-3">
          {stores.map((store) => (
            <Pressable
              key={store.id}
              onPress={() => onSelect(store)}
              className="min-h-[72px] flex-row items-center gap-4 rounded-2xl border border-border bg-surface p-4 active:opacity-80 web:hover:border-primary"
            >
              <View
                className="h-12 w-12 items-center justify-center rounded-xl"
                style={{ backgroundColor: store.brandColor }}
              >
                <StoreIcon size={22} color="#fff" />
              </View>
              <View className="flex-1">
                <Text className="text-base font-semibold text-foreground">{store.name}</Text>
                <Text className="text-sm text-muted-foreground">
                  {t('storeSetup.storeMeta', {
                    handle: store.handle,
                    count: store.productCount,
                  })}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : (
        <View className="rounded-2xl border border-dashed border-border">
          <EmptyState
            icon={RiStore2Line}
            title={t('storeSetup.noStoresTitle')}
            description={t('storeSetup.noStoresBody')}
          />
        </View>
      )}
    </Screen>
  );
}

/** Step B — pick the register location for the active store. */
function LocationStep({ storeId }: { storeId: string }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { data: locations, isPending, isError } = useLocations(storeId);
  const { activeLocationId, setActiveLocationId, setActiveStoreId } = useActiveStore();
  const [pickedLocation, setPickedLocation] = useState<Location | null>(null);

  const onSelect = (location: Location) => {
    setActiveLocationId(location.id);
    setPickedLocation(location);
  };

  const changeStore = () => {
    // Going back to step A clears the store (and its location).
    setActiveStoreId(null);
  };

  const action = (
    <Button
      appearance="outline"
      tone="neutral"
      leadingIcon={toBloomIcon(ChevronLeft)}
      onPress={changeStore}
    >
      {t('storeSetup.changeStore')}
    </Button>
  );

  if (pickedLocation) {
    return (
      <RegisterStep
        storeId={storeId}
        location={pickedLocation}
        onBack={() => setPickedLocation(null)}
      />
    );
  }

  return (
    <Screen
      title={t('storeSetup.chooseRegisterTitle')}
      subtitle={t('storeSetup.chooseRegisterSubtitle')}
      action={action}
    >
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage
          title={t('storeSetup.locationsLoadFailed')}
          body={t('common.pleaseTryAgain')}
        />
      ) : locations && locations.length > 0 ? (
        <View className="gap-3">
          {locations.map((location) => (
            <Pressable
              key={location.id}
              onPress={() => onSelect(location)}
              className="min-h-[72px] flex-row items-center gap-4 rounded-2xl border border-border bg-surface p-4 active:opacity-80 web:hover:border-primary"
            >
              <View className="h-12 w-12 items-center justify-center rounded-xl bg-muted">
                <MapPin size={22} color={colors.primary} />
              </View>
              <View className="flex-1">
                <View className="flex-row items-center gap-2">
                  <Text className="text-base font-semibold text-foreground">{location.name}</Text>
                  {location.isDefault ? (
                    <View className="rounded-full bg-muted px-2 py-0.5">
                      <Text className="text-xs font-medium text-muted-foreground">
                        {t('storeSetup.defaultLocation')}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text className="text-sm text-muted-foreground">
                  {t(LOCATION_TYPE_LABEL_KEYS[location.type])}
                </Text>
              </View>
              {activeLocationId === location.id ? <Check size={20} color={colors.primary} /> : null}
            </Pressable>
          ))}
        </View>
      ) : (
        <ScreenMessage
          title={t('storeSetup.noLocationsTitle')}
          body={t('storeSetup.noLocationsBody')}
        />
      )}
    </Screen>
  );
}

/**
 * Step C — which register this device is, when the location has named ones.
 *
 * Shown only when the store's plan currently honours named registers and the
 * location has at least one; otherwise (and if the list cannot be read) the
 * device uses the location's default register and goes straight to the
 * register screen, exactly as before named registers existed.
 */
function RegisterStep({
  storeId,
  location,
  onBack,
}: {
  storeId: string;
  location: Location;
  onBack: () => void;
}) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { data, isPending, isError } = usePosRegisters(storeId, location.id);
  const { activeRegisterId, setActiveRegisterId } = useActiveStore();
  const choices = registerChoices(data, location.id);
  const skip = !isPending && (isError || choices.length === 0);

  useEffect(() => {
    if (!skip) return;
    setActiveRegisterId(null);
    router.replace('/');
  }, [skip, setActiveRegisterId, router]);

  const pick = (registerId: string | null) => {
    setActiveRegisterId(registerId);
    router.replace('/');
  };

  const action = (
    <Button
      appearance="outline"
      tone="neutral"
      leadingIcon={toBloomIcon(ChevronLeft)}
      onPress={onBack}
    >
      {t('storeSetup.changeLocation')}
    </Button>
  );

  if (isPending || skip) {
    return (
      <Screen title={t('storeSetup.chooseTillTitle')} action={action}>
        <ScreenLoading />
      </Screen>
    );
  }

  const rows: { id: string | null; name: string; meta: string }[] = [
    { id: null, name: t('storeSetup.defaultRegister'), meta: t('storeSetup.defaultRegisterMeta') },
    ...choices.map((register) => ({ id: register.id, name: register.name, meta: location.name })),
  ];

  return (
    <Screen
      title={t('storeSetup.chooseTillTitle')}
      subtitle={t('storeSetup.chooseTillSubtitle', { location: location.name })}
      action={action}
    >
      <View className="gap-3">
        {rows.map((row) => (
          <Pressable
            key={row.id ?? 'default'}
            onPress={() => pick(row.id)}
            className="min-h-[72px] flex-row items-center gap-4 rounded-2xl border border-border bg-surface p-4 active:opacity-80 web:hover:border-primary"
          >
            <View className="h-12 w-12 items-center justify-center rounded-xl bg-muted">
              <Calculator size={22} color={colors.primary} />
            </View>
            <View className="flex-1">
              <Text className="text-base font-semibold text-foreground">{row.name}</Text>
              <Text className="text-sm text-muted-foreground">{row.meta}</Text>
            </View>
            {activeRegisterId === row.id ? <Check size={20} color={colors.primary} /> : null}
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}
