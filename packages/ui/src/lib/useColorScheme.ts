import { useCallback, useMemo } from 'react';
import { useBloomTheme, useTheme, type ThemeMode } from '@oxy.so/bloom/theme';

/**
 * App-wide color-scheme hook.
 *
 * Resolved colors come from Bloom's `useTheme()` (`ThemeColors`), whose values
 * are already full `rgb(...)` strings — no manual HSL conversion. Light/dark
 * resolution and the active preset come from Bloom; `mode` /
 * `setColorScheme` proxy Bloom's `useBloomTheme()`.
 */
export function useColorScheme() {
  const { mode, setMode } = useBloomTheme();
  const theme = useTheme();

  const setColorScheme = useCallback(
    (newMode: ThemeMode) => {
      setMode(newMode);
    },
    [setMode],
  );

  const colors = useMemo(() => {
    const c = theme.colors;
    return {
      background: c.background,
      // shadcn "foreground" is the primary text color.
      foreground: c.text,
      text: c.text,
      card: c.card,
      // Legacy shared-UI surface consumers use Bloom's card token.
      surface: c.card,
      // Sidebar / muted are secondary surfaces.
      sidebar: c.backgroundSecondary,
      muted: c.backgroundSecondary,
      mutedForeground: c.textSecondary,
      border: c.border,
      primary: c.primary,
      primaryForeground: c.primaryForeground,
    };
  }, [theme]);

  return {
    colorScheme: theme.mode,
    isDarkColorScheme: theme.isDark,
    setColorScheme,
    mode,
    colors,
  };
}
