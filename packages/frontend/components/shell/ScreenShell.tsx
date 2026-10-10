import type { ReactElement } from "react";
import { Platform, View } from "react-native";
import { usePathname } from "expo-router";
import {
  PageFooterProvider,
  usePageFooterInset,
} from "@oxy.so/bloom/page-footer";
import { useBottomEdgeInset } from "@oxy.so/bloom/layout";
import {
  ScreenShell as SharedScreenShell,
  type ScreenShellProps,
} from "@mercaria/ui";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { ShoppingComposer, ShoppingComposerProvider } from "./ShoppingComposer";

const PAGE_ARRIVAL = FadeIn.duration(150).reduceMotion(ReduceMotion.System);
export type { ScreenShellProps } from "@mercaria/ui";

function ComposerClearance() {
  const footer = usePageFooterInset();
  const navigation = useBottomEdgeInset();
  return <View style={{ height: Math.max(0, footer - navigation) }} />;
}

/** Bloom owns the document footer's geometry and its measured clearance. */
export function ScreenShell({
  children,
  composer,
  hideComposer = false,
  ...props
}: ScreenShellProps & {
  composer?: ReactElement<Parameters<typeof ShoppingComposer>[0]>;
  hideComposer?: boolean;
}) {
  const pathname = usePathname();
  const shopping =
    !hideComposer &&
    (Boolean(composer) ||
      pathname === "/" ||
      pathname === "/explore" ||
      pathname === "/search" ||
      pathname === "/deals" ||
      /^\/(categories|curations|brands|families|merchants|stores|products|p|3d)(\/|$)/.test(
        pathname,
      ));

  return (
    <ShoppingComposerProvider>
      <PageFooterProvider>
        <View className="grow native:flex-1">
          <SharedScreenShell {...props}>
            <Animated.View
              entering={Platform.OS === "web" ? PAGE_ARRIVAL : undefined}
              style={props.scroll === false ? { flex: 1 } : undefined}
            >
              {children}
            </Animated.View>
            {shopping ? <ComposerClearance /> : null}
          </SharedScreenShell>
          {shopping ? (composer ?? <ShoppingComposer />) : null}
        </View>
      </PageFooterProvider>
    </ShoppingComposerProvider>
  );
}
