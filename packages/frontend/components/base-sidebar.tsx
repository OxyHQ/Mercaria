import React from "react";
import { View, ScrollView, NativeSyntheticEvent, NativeScrollEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface BaseSidebarProps {
  /** Fixed header at top (toggle area) */
  header: React.ReactNode;
  /** Scrollable middle content (nav items + history) */
  children: React.ReactNode;
  /** Fixed footer at bottom (user menu / sign-in) */
  footer: React.ReactNode;
  /** Optional callback for scroll events */
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}

export const BaseSidebar = React.memo(function BaseSidebar({
  header,
  children,
  footer,
  onScroll,
}: BaseSidebarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View className="relative w-full overflow-hidden flex-1 flex-col bg-background">
      {/* Fixed header */}
      <View className="flex flex-none flex-col" style={{ paddingTop: insets.top }}>
        {header}
      </View>

      {/* Scrollable middle — history + nav */}
      <ScrollView
        className="flex min-h-0 w-full flex-1 flex-col overflow-x-hidden overflow-y-auto"
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>

      {/* Fixed footer */}
      <View className="mt-auto w-full min-w-0 border-t border-border/50 flex-col items-center justify-center" style={{ paddingBottom: insets.bottom }}>
        {footer}
      </View>
    </View>
  );
});
