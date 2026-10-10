import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Link } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { placeDisplayName } from '@goway.to/sdk';
import type { MercariaLocation } from '@mercaria/contracts';
import { Button } from '@oxy.so/bloom/button';
import { MarketplaceSheet, ShopDetailIcon, Text } from '@mercaria/ui';
import { useGoWayPlace, useStoreLocations } from '@/lib/hooks/use-visit-us';
import { useTranslation } from '@/lib/i18n';
import { placeAddressLine } from '@/lib/visit-us';
import { placeBelongsToLocation, storeContactLinks } from '@/lib/store-contact';

export function StoreContactDialog({ storeId, storeName, open, onClose }: {
  storeId: string; storeName: string; open: boolean; onClose: () => void;
}) {
  const { t } = useTranslation();
  return <MarketplaceSheet open={open} onClose={onClose} title={t('store.contact.title', { store: storeName })} testID="store-contact-dialog">
    {open ? <StoreContacts key={storeId} storeId={storeId} /> : null}
  </MarketplaceSheet>;
}

function StoreContacts({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const locations = useStoreLocations(storeId, true);
  if (locations.isError) return <ContactUnavailable retry={() => void locations.refetch()} pending={locations.isFetching} />;
  if (!locations.data || locations.isFetching) return <Text accessibilityLiveRegion="polite" className="text-shop-bodyLarge text-text-secondary">{t('common.loading')}</Text>;
  if (locations.data.length === 0) return <Text className="text-shop-bodyLarge text-text-secondary">{t('store.contact.empty')}</Text>;
  return <View className="gap-space-32">{locations.data.map(location => <LocationContact key={location.ref.id} location={location} multiple={locations.data.length > 1} />)}</View>;
}

function ContactUnavailable({ retry, pending }: { retry: () => void; pending: boolean }) {
  const { t } = useTranslation();
  return <View className="gap-space-12">
    <Text accessibilityRole="alert" className="text-shop-bodyLarge text-text-secondary">{t('store.contact.unavailable')}</Text>
    <Button appearance="outline" onPress={retry} loading={pending}>{t('common.tryAgain')}</Button>
  </View>;
}

function LocationContact({ location, multiple }: { location: MercariaLocation; multiple: boolean }) {
  const { t, locale } = useTranslation();
  const place = useGoWayPlace(location.goWayPlaceId, locale, true);
  if (place.isError) return <ContactUnavailable retry={() => void place.refetch()} pending={place.isFetching} />;
  if (!place.data || place.isFetching) return <Text accessibilityLiveRegion="polite" className="text-shop-bodyLarge text-text-secondary">{t('common.loading')}</Text>;
  if (!placeBelongsToLocation(location, place.data)) return <Text className="text-shop-bodyLarge text-text-secondary">{t('store.contact.empty')}</Text>;
  const address = placeAddressLine(place.data);
  const contacts = storeContactLinks(place.data.contact);
  return <View className="gap-space-24" testID="store-location-contact">
    {multiple ? <Text accessibilityRole="header" className="text-shop-subtitle text-text">{placeDisplayName(place.data)}</Text> : null}
    {contacts.map(contact => <View key={contact.kind} className="min-w-0 flex-row items-center gap-space-4">
      <Link asChild href={contact.href} target="_blank" rel="noopener noreferrer">
        <Pressable accessibilityRole="link" className="min-w-0 flex-1 flex-row items-center gap-space-12">
          <View className="shrink-0"><ShopDetailIcon name={contact.kind} size={24} className="text-text" /></View>
          <Text selectable className="min-w-0 flex-1 text-shop-bodyLarge text-text">{contact.kind === 'website' ? t('store.contact.website') : contact.value}</Text>
        </Pressable>
      </Link>
      {contact.kind !== 'website' ? <CopyContact key={contact.value} value={contact.value} /> : null}
    </View>)}
    {address ? <View className="min-w-0 flex-row items-center gap-space-4">
      <Text selectable className="min-w-0 flex-1 text-shop-bodyLarge text-text-tertiary">{address}</Text>
      <CopyContact key={address} value={address} />
    </View> : null}
    {!address && contacts.length === 0 ? <Text className="text-shop-bodyLarge text-text-secondary">{t('store.contact.empty')}</Text> : null}
  </View>;
}

function CopyContact({ value }: { value: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'idle' | 'pending' | 'copied' | 'failed'>('idle');
  async function copy() {
    setStatus('pending');
    try {
      if (!await Clipboard.setStringAsync(value)) throw new Error('Clipboard unavailable');
      setStatus('copied');
    } catch { setStatus('failed'); }
  }
  return <View className="shrink-0 items-end gap-space-4">
    <Button iconOnly appearance="plain" material="flat" accessibilityLabel={t('store.contact.copy', { value })}
      loading={status === 'pending'} onPress={() => void copy()} icon={<ShopDetailIcon name="copy" size={20} className="text-text" />} />
    {status === 'copied' || status === 'failed' ? <Text accessibilityLiveRegion="polite" className="max-w-40 text-shop-caption text-text-secondary">
      {t(status === 'copied' ? 'store.contact.copied' : 'store.contact.copyFailed')}
    </Text> : null}
  </View>;
}
