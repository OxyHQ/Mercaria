import React from "react";
import { View, ScrollView, ActivityIndicator } from "react-native";
import { Text, useColorScheme } from "@mercaria/ui";

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
 * Standard page chrome for a dashboard screen: a max-width content column with a
 * title/subtitle header and an optional right-aligned action, plus comfortable
 * padding. The web shell scrolls the document, so screens flow in normal flow.
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

  if (!scroll) {
    return (
      <View className="flex-1 bg-background px-4 pt-6 md:px-8">
        <View className="mx-auto w-full max-w-5xl flex-1">
          {header}
          {children}
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="px-4 pt-6 pb-24 md:px-8"
    >
      <View className="mx-auto w-full max-w-5xl">
        {header}
        {children}
      </View>
    </ScrollView>
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
