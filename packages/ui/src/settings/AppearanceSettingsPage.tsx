import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { SettingsGeneralPage, type SettingsPageSection } from '@oxy.so/bloom/settings-modal';
import { toast } from '@oxy.so/bloom/toast';
import { COLOR_PRESET_REGISTRY, useBloomTheme } from '@oxy.so/bloom/theme';
import { useAccountColorSave, useOxy } from '@oxy.so/services/ui/client';
import { useSharedUiTranslation } from '../i18n/ui-translation';
import { SettingsSelect } from './SettingsSelect';

const MODES = ['system', 'light', 'dark'] as const;
type Mode = (typeof MODES)[number];

const MODE_LABEL_KEYS: Record<Mode, string> = {
  system: 'ui.settings.appearance.system',
  light: 'ui.settings.appearance.light',
  dark: 'ui.settings.appearance.dark',
};

/**
 * Light, dark or the system's (Bloom's own persisted theme state), and — for a
 * signed-in account — the Oxy account colour, which is the account's, not the
 * device's: it is saved to the account and every Oxy app wears it.
 */
export function AppearanceSettingsPage() {
  const t = useSharedUiTranslation();
  const { isAuthenticated } = useOxy();
  const { colors, value, saveColor } = useAccountColorSave();
  const { mode: bloomMode, setMode } = useBloomTheme();
  const mode: Mode = bloomMode === 'light' || bloomMode === 'dark' ? bloomMode : 'system';

  const sections: SettingsPageSection[] = [
    {
      key: 'mode',
      rows: [
        {
          key: 'mode',
          label: t('ui.settings.appearance.mode'),
          control: (
            <SegmentedControl
              label={t('ui.settings.appearance.mode')}
              type="radio"
              value={mode}
              onChange={(next) => setMode(next as Mode)}
            >
              {MODES.map((value) => (
                <SegmentedControlItem key={value} value={value}>
                  <SegmentedControlItemText>{t(MODE_LABEL_KEYS[value])}</SegmentedControlItemText>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          ),
        },
      ],
    },
  ];
  if (isAuthenticated) {
    sections.push({
      key: 'color',
      rows: [
        {
          key: 'color',
          label: t('ui.settings.appearance.color'),
          control: (
            <SettingsSelect
              label={t('ui.settings.appearance.color')}
              value={value}
              onChange={(next) => {
                saveColor(next).catch(() => toast.error(t('ui.settings.appearance.colorFailed')));
              }}
              // Bloom's preset names are its own and untranslated — palette
              // names, read like a brand name.
              items={colors.map((name) => ({
                value: name,
                label:
                  COLOR_PRESET_REGISTRY.find((preset) => preset.name === name)?.displayName ?? name,
              }))}
            />
          ),
        },
      ],
    });
  }
  return <SettingsGeneralPage sections={sections} />;
}
