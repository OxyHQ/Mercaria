import React, { useState } from 'react';
import type { Place } from '@goway.to/sdk';
import { Text } from '@mercaria/ui';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { useUpdateGoWayPlace } from '@/lib/goway/hooks';
import { goWayErrorKey } from '@/lib/goway/errors';
import { contactDraftOf, contactInputOf, type ContactDraft } from '@/lib/goway/place-form';
import { useTranslation } from '@/lib/i18n';
import { EditorSection } from './EditorSection';

/** The place's public phone, email and website, written to GoWay. */
export function PlaceContactCard({ place }: { place: Place }) {
  const { t } = useTranslation();
  const update = useUpdateGoWayPlace(place.id);
  const [draft, setDraft] = useState<ContactDraft>(() => contactDraftOf(place.contact));

  const save = () => {
    const built = contactInputOf(draft, place.contact);
    if (!built.ok) {
      toast.error(t(built.errorKey));
      return;
    }
    if (Object.keys(built.contact).length === 0) return;
    update.mutate(
      { contact: built.contact },
      {
        onSuccess: () => toast.success(t('settings.locations.editor.contact.saved')),
        onError: (error) => toast.error(t(goWayErrorKey(error))),
      },
    );
  };

  const field = (key: keyof ContactDraft) => ({
    value: draft[key],
    onValueChange: (value: string) => setDraft((current) => ({ ...current, [key]: value })),
  });

  return (
    <EditorSection
      title={t('settings.locations.editor.contact.title')}
      description={t('settings.locations.editor.contact.description')}
    >
      <Field label={t('settings.locations.editor.contact.phone')}>
        <TextFieldInput
          label={t('settings.locations.editor.contact.phone')}
          keyboardType="phone-pad"
          {...field('phone')}
        />
      </Field>
      <Field label={t('settings.locations.editor.contact.email')}>
        <TextFieldInput
          label={t('settings.locations.editor.contact.email')}
          keyboardType="email-address"
          autoCapitalize="none"
          {...field('email')}
        />
      </Field>
      <Field label={t('settings.locations.editor.contact.website')}>
        <TextFieldInput
          label={t('settings.locations.editor.contact.website')}
          keyboardType="url"
          autoCapitalize="none"
          {...field('website')}
        />
      </Field>
      <Text className="text-xs text-muted-foreground">
        {t('settings.locations.editor.contact.hint')}
      </Text>
      <Button tone="accent" loading={update.isPending} onPress={save}>
        {t('settings.locations.editor.contact.save')}
      </Button>
    </EditorSection>
  );
}
