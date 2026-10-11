import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import type { SearchResult, StructuredGeocodeQuery } from '@goway.to/sdk';
import { Text } from '@mercaria/ui';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Loading } from '@oxy.so/bloom/loading';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { useCreateGoWayPlace, useGoWaySearch, useGoWayAddress } from '@/lib/goway/hooks';
import { goWayErrorKey } from '@/lib/goway/errors';
import {
  EMPTY_PLACE_DRAFT,
  draftFromSearchResult,
  editPlaceDraft,
  placeAddressQuery,
  placeCreateInputOf,
  type PlaceDraft,
} from '@/lib/goway/place-form';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { useTranslation } from '@/lib/i18n';
import { EditorSection } from './EditorSection';

/**
 * Choose the GoWay place this location trades from — find it, or create it
 * (ADR 0013).
 *
 * Search results come from GoWay's SDK. An address prefills a public business
 * draft; editing it invalidates the position and requires a fresh structured
 * lookup and explicit result selection. The SDK owns geocoding and validation.
 * Creating a public business is distinct from selecting its Mercaria location.
 *
 * Choosing only picks: nothing is linked until the publication is saved below.
 */
export function PlacePickerCard({
  defaultName,
  onChoose,
}: {
  defaultName: string;
  onChoose: (placeId: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 350);
  const search = useGoWaySearch(debounced);
  const create = useCreateGoWayPlace();
  const [draft, setDraft] = useState<PlaceDraft | null>(null);
  const [addressQuery, setAddressQuery] = useState<StructuredGeocodeQuery | null>(null);
  const address = useGoWayAddress(addressQuery);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const waitingForSearch = query.trim() !== debounced.trim();
  const showSearch = query.trim().length >= 2 && !waitingForSearch;
  const hasPosition = Boolean(draft?.latitude && draft.longitude);

  const chooseAddress = (result: SearchResult, reviewedAddress?: PlaceDraft) => {
    if (create.isPending) return;
    setDraft(draftFromSearchResult(result, draft?.name ?? defaultName, reviewedAddress));
    setAddressQuery(null);
    setErrorKey(null);
  };
  const field = (key: Exclude<keyof PlaceDraft, 'latitude' | 'longitude'>) => ({
    value: draft?.[key] ?? '',
    disabled: create.isPending,
    onValueChange: (value: string) => {
      if (create.isPending) return;
      setDraft((current) => editPlaceDraft(current ?? EMPTY_PLACE_DRAFT, key, value));
      if (key !== 'name') {
        setAddressQuery(null);
      }
      setErrorKey(null);
    },
  });

  const submit = () => {
    if (draft === null || create.isPending) return;
    const built = placeCreateInputOf(draft);
    if (!built.ok) {
      setErrorKey(built.errorKey);
      return;
    }
    setErrorKey(null);
    create.mutate(built.input, {
      onSuccess: (place) => {
        toast.success(t('settings.locations.editor.create.created'));
        setDraft(null);
        onChoose(place.id);
      },
      onError: (error) => setErrorKey(goWayErrorKey(error)),
    });
  };

  return (
    <EditorSection
      title={t('settings.locations.editor.picker.title')}
      description={t('settings.locations.editor.picker.description')}
    >
      <Field label={t('settings.locations.editor.picker.searchLabel')}>
        <TextFieldInput
          label={t('settings.locations.editor.picker.searchLabel')}
          value={query}
          disabled={create.isPending}
          onValueChange={setQuery}
          placeholder={t('settings.locations.editor.picker.searchPlaceholder')}
        />
      </Field>
      <View className="min-h-8 justify-center" accessibilityLiveRegion="polite">
        {waitingForSearch || (showSearch && search.isFetching) ? (
          <Loading variant="inline" size="sm" accessibilityLabel={t('common.loading')} />
        ) : null}
        {showSearch && search.isError ? (
          <View className="gap-2">
            <Text className="text-sm text-muted-foreground">{t(goWayErrorKey(search.error))}</Text>
            <Button
              appearance="outline"
              disabled={search.isFetching || create.isPending}
              onPress={() => {
                void search.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </View>
        ) : null}
        {showSearch && !search.isError && search.data?.length === 0 ? (
          <Text className="text-sm text-muted-foreground">
            {t('settings.locations.editor.picker.noResults')}
          </Text>
        ) : null}
      </View>
      {showSearch && !search.isError
        ? search.data?.map((result) => (
            <SearchResultRow
              key={result.id}
              result={result}
              disabled={create.isPending}
              onUse={onChoose}
              onCreateHere={() => chooseAddress(result)}
            />
          ))
        : null}

      {draft === null ? (
        <Button
          appearance="outline"
          tone="neutral"
          onPress={() => {
            setDraft({ ...EMPTY_PLACE_DRAFT, name: defaultName });
            setErrorKey(null);
          }}
        >
          {t('settings.locations.editor.create.open')}
        </Button>
      ) : (
        <View className="gap-3 rounded-xl border border-border p-3">
          <Text className="text-sm font-semibold text-foreground">
            {t('settings.locations.editor.create.title')}
          </Text>
          <Field label={t('common.name')}>
            <TextFieldInput label={t('common.name')} {...field('name')} />
          </Field>
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Field label={t('settings.locations.editor.create.street')}>
                <TextFieldInput
                  label={t('settings.locations.editor.create.street')}
                  {...field('street')}
                />
              </Field>
            </View>
            <View className="w-24">
              <Field label={t('settings.locations.editor.create.houseNumber')}>
                <TextFieldInput
                  label={t('settings.locations.editor.create.houseNumber')}
                  {...field('houseNumber')}
                />
              </Field>
            </View>
          </View>
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Field label={t('settings.locations.editor.create.city')}>
                <TextFieldInput
                  label={t('settings.locations.editor.create.city')}
                  {...field('city')}
                />
              </Field>
            </View>
            <View className="w-32">
              <Field label={t('settings.locations.editor.create.postalCode')}>
                <TextFieldInput
                  label={t('settings.locations.editor.create.postalCode')}
                  {...field('postalCode')}
                />
              </Field>
            </View>
          </View>
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Field label={t('settings.locations.editor.create.region')}>
                <TextFieldInput
                  label={t('settings.locations.editor.create.region')}
                  {...field('region')}
                />
              </Field>
            </View>
            <View className="w-32">
              <Field label={t('settings.locations.editor.create.country')}>
                <TextFieldInput
                  label={t('settings.locations.editor.create.country')}
                  autoCapitalize="characters"
                  maxLength={2}
                  placeholder={t('settings.locations.editor.create.countryPlaceholder')}
                  {...field('countryCode')}
                />
              </Field>
            </View>
          </View>
          <Text className="text-xs text-muted-foreground">
            {t('settings.locations.editor.create.positionHint')}
          </Text>
          {hasPosition ? (
            <Text className="text-sm text-foreground">
              {t('settings.locations.editor.create.positionSelected')}
            </Text>
          ) : (
            <View className="gap-2">
              <Button
                appearance="outline"
                loading={address.isFetching}
                disabled={create.isPending || address.isFetching}
                onPress={() => {
                  const next = placeAddressQuery(draft);
                  setAddressQuery(next);
                  if (JSON.stringify(next) === JSON.stringify(addressQuery)) void address.refetch();
                }}
              >
                {t('settings.locations.editor.create.findAddress')}
              </Button>
              {addressQuery && address.isError ? (
                <Text accessibilityLiveRegion="polite" className="text-sm text-destructive">
                  {t(goWayErrorKey(address.error))}
                </Text>
              ) : null}
              {addressQuery && !address.isError && address.data?.length === 0 ? (
                <Text className="text-sm text-muted-foreground">
                  {t('settings.locations.editor.picker.noResults')}
                </Text>
              ) : null}
              {addressQuery && !address.isError
                ? address.data?.map((result) => (
                    <SearchResultRow
                      key={result.id}
                      result={result}
                      disabled={create.isPending}
                      onUse={onChoose}
                      onCreateHere={() => chooseAddress(result, draft)}
                    />
                  ))
                : null}
            </View>
          )}
          <Text className="text-sm text-muted-foreground">
            {t('settings.locations.editor.create.publicNotice')}
          </Text>
          {errorKey ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-destructive">
              {t(errorKey)}
            </Text>
          ) : null}
          <View className="flex-row gap-2">
            <Button
              tone="accent"
              loading={create.isPending}
              disabled={!hasPosition}
              onPress={submit}
            >
              {t('settings.locations.editor.create.submit')}
            </Button>
            <Button
              appearance="outline"
              tone="neutral"
              disabled={create.isPending}
              onPress={() => {
                setDraft(null);
                setAddressQuery(null);
                setErrorKey(null);
              }}
            >
              {t('common.cancel')}
            </Button>
          </View>
        </View>
      )}
    </EditorSection>
  );
}

function SearchResultRow({
  result,
  onUse,
  onCreateHere,
  disabled,
}: {
  result: SearchResult;
  disabled: boolean;
  onUse: (placeId: string) => void;
  onCreateHere: () => void;
}) {
  const { t } = useTranslation();
  const placeId = result.placeId;
  return (
    <Pressable
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={result.displayName}
      onPress={() => (placeId === undefined ? onCreateHere() : onUse(placeId))}
      className="flex-row items-center gap-3 rounded-xl border border-border p-3 active:opacity-70"
    >
      <View className="flex-1">
        <Text className="text-sm text-foreground">{result.displayName}</Text>
        <Text className="text-xs text-muted-foreground">
          {t(
            placeId === undefined
              ? 'settings.locations.editor.picker.notAPlace'
              : 'settings.locations.editor.picker.isAPlace',
          )}
        </Text>
      </View>
      <Text className="text-sm font-medium text-foreground">
        {t(
          placeId === undefined
            ? 'settings.locations.editor.picker.createHere'
            : 'settings.locations.editor.picker.use',
        )}
      </Text>
    </Pressable>
  );
}
