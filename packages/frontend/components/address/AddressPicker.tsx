import { useEffect, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import type { SearchResults } from '@goway.to/sdk';
import { Button } from '@oxy.so/bloom/button';
import { Collapsible } from '@oxy.so/bloom/collapsible';
import { Field } from '@oxy.so/bloom/field';
import { Search } from '@oxy.so/bloom/search';
import { MapPin } from 'lucide-react-native';
import { Text, formatRegionName, toBloomIcon } from '@mercaria/ui';
import { goWayClient } from '@/lib/goway-client';
import { hasRequiredPostalFields, postalAddressFromResult, type PostalAddress } from '@/lib/address/goway-address';
import { useTranslation } from '@/lib/i18n';

type Lookup = { query: string; locale: string; status: 'loading' | 'error' | 'ready'; response?: SearchResults };

/** Private address search is transient component state, never a persisted query or a public Place write. */
export function AddressPicker({ value, onChange, children }: {
  value: PostalAddress;
  onChange: (address: PostalAddress) => void;
  children: ReactNode;
}) {
  const { t, locale } = useTranslation();
  const [query, setQuery] = useState('');
  const [lookup, setLookup] = useState<Lookup>();
  const [retry, setRetry] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsTrigger = useRef<View>(null);
  const term = query.trim();
  const searching = term.length >= 3;
  // A response belongs to exactly one term and locale, including during debounce.
  const current = lookup?.query === term && lookup.locale === locale ? lookup : undefined;

  useEffect(() => {
    if (term.length < 3) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLookup({ query: term, locale, status: 'loading' });
      void goWayClient.geocode.forward({ query: term, locale, limit: 6 }, { signal: controller.signal })
        .then(response => {
          if (!controller.signal.aborted) setLookup({ query: term, locale, status: 'ready', response });
        })
        .catch(() => {
          if (!controller.signal.aborted) setLookup({ query: term, locale, status: 'error' });
        });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [term, locale, retry]);

  return (
    <View className="gap-3" testID="address-picker">
      <Field label={t('address.picker.search')} description={t('address.picker.help')}>
        <Search label={t('address.picker.search')} value={query} onValueChange={setQuery} onClearText={() => setQuery('')}
          placeholder={t('address.picker.placeholder')} autoComplete="off" autoCorrect={false} />
      </Field>
      {searching ? (
        <View className="gap-2">
          {!current || current.status === 'loading' ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">{t('address.picker.loading')}</Text>
          ) : current.status === 'error' ? (
            <View className="gap-2">
              <Text accessibilityRole="alert" className="text-sm text-muted-foreground">{t('address.picker.error')}</Text>
              <Button appearance="outline" tone="neutral" onPress={() => {
                setLookup(undefined);
                setRetry(n => n + 1);
              }}>{t('common.tryAgain')}</Button>
            </View>
          ) : (
            <>
              {current.response?.degradedProviders?.length ? (
                <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">{t('address.picker.partial')}</Text>
              ) : null}
              {current.response?.items.length === 0 ? (
                <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">{t('address.picker.empty')}</Text>
              ) : null}
              {current.response?.items.map(result => (
                <Button key={result.id} appearance="outline" tone="neutral" leadingIcon={toBloomIcon(MapPin)}
                  onPress={() => {
                    const address = postalAddressFromResult(result);
                    onChange(address);
                    setQuery('');
                    setLookup(undefined);
                    setDetailsOpen(!hasRequiredPostalFields(address));
                    detailsTrigger.current?.focus();
                  }}>
                  <Text className="min-w-0 flex-1 text-sm text-foreground">{result.displayName}</Text>
                </Button>
              ))}
            </>
          )}
        </View>
      ) : null}
      {value.line1 ? (
        <View className="gap-1 rounded-2xl border border-border bg-card p-4" testID="selected-postal-address">
          <Text className="font-semibold text-foreground">{value.line1}</Text>
          <Text className="text-sm text-muted-foreground">{[value.postalCode, value.city].filter(Boolean).join(' ')}</Text>
          <Text className="text-sm text-muted-foreground">{[value.region, value.country ? formatRegionName(value.country, locale) : ''].filter(Boolean).join(', ')}</Text>
        </View>
      ) : null}
      <Button ref={detailsTrigger} appearance="plain" tone="neutral" aria-expanded={detailsOpen}
        onPress={() => setDetailsOpen(open => !open)}>
        {value.line1 ? t('address.picker.review') : t('address.picker.manual')}
      </Button>
      <Collapsible testID="address-postal-details" open={detailsOpen} returnFocusRef={detailsTrigger} contentClassName="gap-3">
        {children}
      </Collapsible>
    </View>
  );
}
