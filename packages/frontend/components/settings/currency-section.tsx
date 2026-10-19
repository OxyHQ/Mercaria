import { useOxy } from '@oxy.so/services/ui/client';
import { toast } from '@oxy.so/bloom/toast';
import type { SettingsPageSection } from '@oxy.so/bloom/settings-modal';
import { ALL_CURRENCY_CODES, CURRENCY_SYMBOLS, type CurrencyCode } from '@mercaria/shared-types';
import { SettingsSelect } from '@mercaria/ui/settings';
import { useTranslation } from '@/lib/i18n';
import { useCurrencyPreferenceQuery, useUpdateCurrencyPreference } from '@/lib/fx';

/** Canonical default when the shopper has not chosen a display currency. */
const DEFAULT_DISPLAY_CURRENCY: CurrencyCode = 'FAIR';

const CURRENCY_ITEMS = ALL_CURRENCY_CODES.map((code) => ({
  value: code,
  label: `${CURRENCY_SYMBOLS[code]} ${code}`,
}));

/**
 * Storefront display currency, as a Settings section. The shopper chooses the
 * PRIMARY currency prices are shown in (FAIR by default), persisted via
 * `PUT /me/currency-preference`. Selecting one primes the preference query
 * cache, so every `PriceDisplay` re-renders in the new currency live — no
 * reload, no effect. Presentation-only: the stored amounts never change.
 */
export function useCurrencySettingsSection(): SettingsPageSection {
  const { t } = useTranslation();
  const { isAuthenticated } = useOxy();
  const { data: preference } = useCurrencyPreferenceQuery();
  const updatePreference = useUpdateCurrencyPreference();

  const selected: CurrencyCode = preference?.preferredCurrency ?? DEFAULT_DISPLAY_CURRENCY;

  const onSelect = (code: CurrencyCode) => {
    if (code === selected || updatePreference.isPending) return;
    updatePreference.mutate(
      { preferredCurrency: code },
      { onError: () => toast.error(t('settings.currency.updateFailed')) },
    );
  };

  return {
    key: 'currency',
    rows: [
      {
        key: 'currency',
        label: t('settings.currency.title'),
        description: isAuthenticated
          ? t('settings.currency.description')
          : t('settings.currency.signedOut'),
        control: isAuthenticated ? (
          <SettingsSelect
            label={t('settings.currency.title')}
            value={selected}
            onChange={onSelect}
            items={CURRENCY_ITEMS}
          />
        ) : undefined,
      },
    ],
  };
}
