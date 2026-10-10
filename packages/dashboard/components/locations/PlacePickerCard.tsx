import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import type { SearchResult } from '@goway.to/sdk';
import { Text } from '@mercaria/ui';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { useCreateGoWayPlace, useGoWaySearch } from '@/lib/goway/hooks';
import { goWayErrorKey } from '@/lib/goway/errors';
import {
  EMPTY_PLACE_DRAFT,
  draftFromSearchResult,
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
 * A search result GoWay already holds a place for (`placeId`) is chosen as it
 * is. One it does not — an address the geocoder found — prefills the create
 * form, POSITION INCLUDED, so a merchant never has to type a coordinate; the
 * latitude and longitude fields are there for a shop no geocoder knows, and
 * there is no map pin on this screen because the dashboard carries no map.
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

  const field = (key: keyof PlaceDraft) => ({
    value: draft?.[key] ?? '',
    onValueChange: (value: string) =>
      setDraft((current) => ({ ...(current ?? EMPTY_PLACE_DRAFT), [key]: value })),
  });

  const submit = () => {
    if (draft === null) return;
    const built = placeCreateInputOf(draft);
    if (!built.ok) {
      toast.error(t(built.errorKey));
      return;
    }
    create.mutate(built.input, {
      onSuccess: (place) => {
        toast.success(t('settings.locations.editor.create.created'));
        setDraft(null);
        onChoose(place.id);
      },
      onError: (error) => toast.error(t(goWayErrorKey(error))),
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
          onValueChange={setQuery}
          placeholder={t('settings.locations.editor.picker.searchPlaceholder')}
        />
      </Field>
      {search.isError ? (
        <Text className="text-sm text-muted-foreground">{t(goWayErrorKey(search.error))}</Text>
      ) : null}
      {search.data?.length === 0 ? (
        <Text className="text-sm text-muted-foreground">
          {t('settings.locations.editor.picker.noResults')}
        </Text>
      ) : null}
      {search.data?.map((result) => (
        <SearchResultRow
          key={result.id}
          result={result}
          onUse={(placeId) => onChoose(placeId)}
          onCreateHere={() => setDraft(draftFromSearchResult(result, defaultName))}
        />
      ))}

      {draft === null ? (
        <Button
          appearance="outline"
          tone="neutral"
          onPress={() => setDraft({ ...EMPTY_PLACE_DRAFT, name: defaultName })}
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
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Field label={t('settings.locations.editor.create.latitude')}>
                <TextFieldInput
                  label={t('settings.locations.editor.create.latitude')}
                  keyboardType="numbers-and-punctuation"
                  {...field('latitude')}
                />
              </Field>
            </View>
            <View className="flex-1">
              <Field label={t('settings.locations.editor.create.longitude')}>
                <TextFieldInput
                  label={t('settings.locations.editor.create.longitude')}
                  keyboardType="numbers-and-punctuation"
                  {...field('longitude')}
                />
              </Field>
            </View>
          </View>
          <Text className="text-xs text-muted-foreground">
            {t('settings.locations.editor.create.positionHint')}
          </Text>
          <View className="flex-row gap-2">
            <Button tone="accent" loading={create.isPending} onPress={submit}>
              {t('settings.locations.editor.create.submit')}
            </Button>
            <Button appearance="outline" tone="neutral" onPress={() => setDraft(null)}>
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
}: {
  result: SearchResult;
  onUse: (placeId: string) => void;
  onCreateHere: () => void;
}) {
  const { t } = useTranslation();
  const placeId = result.placeId;
  return (
    <Pressable
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
