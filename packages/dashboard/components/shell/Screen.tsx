import React from "react";
import { View, ActivityIndicator } from "react-native";
import { ScreenShell, Text, useColorScheme } from "@mercaria/ui";

interface ScreenProps {
  title: string;
  subtitle?: string;
  /** Optional action node rendered on the right of the header (e.g. a button). */
  action?: React.ReactNode;
  children: React.ReactNode;
  /** When false, children are NOT wrapped in a ScrollView (e.g. for FlashList). */
  scroll?: boolean;
}

/**
 * Standard page chrome for a dashboard screen: the shared {@link ScreenShell}
 * mask surface (Bloom's `ContentPanel` — rounded panel, web sticky bleed-mask +
 * border frame, platform scroll split) wrapping a max-width content column with a
 * title/subtitle header and an optional right-aligned action. The dashboard keeps
 * its `bg-background` surface (so `bg-surface` cards still contrast) while gaining
 * the storefront's framed panel.
 */
export function Screen({ title, subtitle, action, children, scroll = true }: ScreenProps) {
  const header = (
    <View className="mb-6 flex-row items-start justify-between gap-4">
      <View className="flex-1">
        <Text className="text-2xl font-bold text-foreground">{title}</Text>
        {subtitle ? (
          <Text className="mt-1 text-sm text-muted-foreground">{subtitle}</Text>
        ) : null}
      </View>
      {action ? <View>{action}</View> : null}
    </View>
  );

  return (
    <ScreenShell surfaceClassName="bg-background" scroll={scroll}>
      <View className="mx-auto w-full max-w-5xl px-4 pt-6 md:px-8">
        {header}
        {children}
      </View>
    </ScreenShell>
  );
}

/** Centered loading spinner for a screen-level pending state. */
export function ScreenLoading() {
  const { colors } = useColorScheme();
  return (
    <View className="items-center justify-center py-20">
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

/** Centered empty/error state for a screen body. */
export function ScreenMessage({ title, body }: { title: string; body?: string }) {
  return (
    <View className="items-center justify-center py-20">
      <Text className="text-base font-semibold text-foreground">{title}</Text>
      {body ? (
        <Text className="mt-1 max-w-md text-center text-sm text-muted-foreground">{body}</Text>
      ) : null}
    </View>
  );
}
