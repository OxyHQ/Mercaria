import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { webLocalStorage, type BloomThemeStorage } from "@oxyhq/bloom/theme";

/**
 * Single source of truth for where Bloom persists the active theme
 * (`{ mode?, colorPreset? }` as JSON). `BloomThemeProvider` writes it; the key
 * lives here so writers and readers can never drift. Distinct from the
 * dashboard/storefront keys so the POS keeps its own theme preference.
 */
export const BLOOM_THEME_PERSIST_KEY = "mercaria.pos.bloom.theme";

/**
 * Platform-selected storage adapter for Bloom theme persistence.
 * - Web: `webLocalStorage` (synchronous `localStorage`) so Bloom hydrates before
 *   the first paint, avoiding a palette flash.
 * - Native: `AsyncStorage` (signature-compatible with `BloomThemeStorage`).
 */
export const BLOOM_THEME_STORAGE: BloomThemeStorage =
  Platform.OS === "web" && webLocalStorage ? webLocalStorage : AsyncStorage;
