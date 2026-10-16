import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from "@oxy.so/bloom/segmented-control";
import { SettingsGeneralPage, type SettingsPageSection } from "@oxy.so/bloom/settings-modal";
import { COLOR_PRESET_REGISTRY, FREE_COLOR_NAMES, useBloomTheme, type AppColorName } from "@oxy.so/bloom/theme";
import { useSharedUiTranslation } from "../i18n/ui-translation";
import { SettingsSelect } from "./SettingsSelect";

const MODES = ["system", "light", "dark"] as const;
type Mode = (typeof MODES)[number];

const MODE_LABEL_KEYS: Record<Mode, string> = {
  system: "ui.settings.appearance.system",
  light: "ui.settings.appearance.light",
  dark: "ui.settings.appearance.dark",
};

const FREE = new Set<AppColorName>(FREE_COLOR_NAMES);
const PRESETS = COLOR_PRESET_REGISTRY.filter((preset) => FREE.has(preset.name));

export interface AppearanceSettingsPageProps {
  /**
   * Offer the colour preset. Off where the app pins its colour (the dashboard
   * passes a controlled `colorPreset` to `BloomProvider`, so a choice here
   * would do nothing).
   */
  accent?: boolean;
}

/**
 * Light, dark or the system's, and the colour preset. Both are Bloom's own
 * persisted theme state (each app's `persistKey`), so a choice re-themes the
 * app at once and stays on this device.
 */
export function AppearanceSettingsPage({ accent = false }: AppearanceSettingsPageProps) {
  const t = useSharedUiTranslation();
  const { mode: bloomMode, setMode, colorPreset, setColorPreset } = useBloomTheme();
  const mode: Mode = bloomMode === "light" || bloomMode === "dark" ? bloomMode : "system";

  const sections: SettingsPageSection[] = [
    {
      key: "mode",
      rows: [
        {
          key: "mode",
          label: t("ui.settings.appearance.mode"),
          control: (
            <SegmentedControl
              label={t("ui.settings.appearance.mode")}
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
  if (accent) {
    sections.push({
      key: "color",
      rows: [
        {
          key: "color",
          label: t("ui.settings.appearance.color"),
          control: (
            <SettingsSelect
              label={t("ui.settings.appearance.color")}
              value={colorPreset}
              onChange={(next) => setColorPreset(next)}
              // Bloom's preset names are its own and untranslated — palette
              // names, read like a brand name — exactly as Allo shows them.
              items={PRESETS.map((preset) => ({ value: preset.name, label: preset.displayName }))}
            />
          ),
        },
      ],
    });
  }
  return <SettingsGeneralPage sections={sections} />;
}
