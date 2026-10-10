import { useEffect, type PropsWithChildren, type Ref } from "react";
import { Platform, View, useWindowDimensions, type ScrollView, type ScrollViewProps } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Dialog, useDialogControl } from "@oxy.so/bloom/dialog";
import { Button } from "@oxy.so/bloom/button";
import { surfaceStyle } from "@oxy.so/bloom/shapes";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import { useColorScheme } from "../../lib/useColorScheme";
import { Text } from "../ui/text";
import { ViewportScrollView } from "../shell/ViewportScrollView";
import { ShopDetailIcon } from "./ShopDetailIcon";

export interface MarketplaceSheetProps extends PropsWithChildren {
  open: boolean;
  onClose: () => void;
  title: string;
  testID?: string;
  headingGap?: 12 | 16;
  scrollRef?: Ref<ScrollView>;
  scrollViewProps?: Omit<ScrollViewProps, "children" | "contentContainerStyle">;
}

/** Shop's product side-sheet geometry, composed through Bloom's public API.
 * The dialog owns dismissal/focus; the single scroller owns viewport tracking. */
export function MarketplaceSheet({ open, onClose, title, testID, headingGap = 16, scrollRef, scrollViewProps, children }: MarketplaceSheetProps) {
  const control = useDialogControl();
  const reducedMotion = useReducedMotion();
  const { width } = useWindowDimensions();
  const wide = width >= 976;
  const safeArea = useSafeAreaInsets();
  // A full-height native drawer must clear the notch and system gesture bar.
  const safeTop = Platform.OS === "web" ? 0 : Math.max(0, safeArea.top - (wide ? 16 : 0));
  const safeBottom = Platform.OS === "web" ? 0 : Math.max(0, safeArea.bottom - (wide ? 16 : 0));
  const t = useSharedUiTranslation();
  const { isDarkColorScheme } = useColorScheme();
  useEffect(() => {
    if (open) control.open();
    else control.close();
  }, [open, control]);
  return (
    <Dialog
      control={control}
      onClose={onClose}
      label={title}
      placement="end"
      width={wide ? 500 : width}
      minSideGutter={0}
      backdrop={{
        blurIntensity: 0,
        dimOpacity: 1,
        dimGradient: {
          direction: "start-to-end",
          stops: [
            { offset: 0, color: "rgba(0,0,0,0)" },
            { offset: 0.6975, color: "rgba(0,0,0,0.36)" },
            { offset: 1, color: "rgba(0,0,0,0.36)" },
          ],
        },
      }}
      transition={{ duration: 300, easing: [0, 0, 0.58, 1] }}
      inset={wide ? { top: 16, bottom: 16, left: 16, right: 16 } : { top: 0, bottom: 0, left: 0, right: 0 }}
      material="flat"
      panelStyle={[surfaceStyle({ curve: "round", radius: wide ? 24 : 0 }), {
        backgroundColor: Platform.OS === "web"
          ? (isDarkColorScheme ? "rgba(18,18,18,0.9)" : "rgba(255,255,255,0.9)")
          : (isDarkColorScheme ? "#121212" : "#ffffff"),
      }]}
      panelClassName="web:backdrop-blur-[9px]"
      scrollable={false}
      contentPadding={0}
      testID={testID}
    >
      <View className="min-h-0 flex-1" style={{ marginTop: safeTop, marginBottom: safeBottom }}>
        <ViewportScrollView
          {...scrollViewProps}
          viewportRoot
          showsVerticalScrollIndicator={false}
          ref={scrollRef}
          className={`my-space-24 min-h-0 flex-1 ${Platform.OS === "web" ? "shop-sheet-scroll" : ""}`}
          contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 40, paddingBottom: 40 }}
        >
          <Text accessibilityRole="header" style={{ marginBottom: headingGap }} className="mt-space-20 text-shop-heroBold text-text">{title}</Text>
          {children}
        </ViewportScrollView>
        <View className="absolute start-space-24 top-space-24">
          <Button
            iconOnly size="lg" appearance="outline" material="flat"
            className={`shop-sheet-close group/sheet-close ${isDarkColorScheme ? "shop-sheet-close-dark" : ""} ${reducedMotion ? "" : "shop-sheet-close-motion"}`}
            accessibilityLabel={t("ui.sheet.close")}
            onPress={() => control.close()}
            icon={<ShopDetailIcon name="cross" size={20} className={`text-text ${reducedMotion ? "" : "web:transition-transform web:duration-150 group-hover/sheet-close:scale-110 group-active/sheet-close:scale-95"}`} />}
          />
        </View>
      </View>
    </Dialog>
  );
}
