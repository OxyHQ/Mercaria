import { useCallback, useState, type ComponentType, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { Image } from "expo-image";
import { Activity, Grid3x3, Maximize2, Minimize2, RotateCcw } from "lucide-react-native";
import { Text } from "../ui/text";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import { useColorScheme } from "../../lib/useColorScheme";
import {
  assetPreviewKind,
  isAssetPreviewFile,
  type AssetPreviewRefusalReason,
  type AssetPreviewSource,
} from "../../lib/asset-preview";
import {
  ASSET_PREVIEW_REFUSAL_KEYS,
  ASSET_VIEWER_ANIMATION_KEY,
  ASSET_VIEWER_ANIMATION_OFF_KEY,
  ASSET_VIEWER_CONTROLS_KEY,
  ASSET_VIEWER_FULLSCREEN_CLOSE_KEY,
  ASSET_VIEWER_FULLSCREEN_OPEN_KEY,
  ASSET_VIEWER_GESTURES_KEY,
  ASSET_VIEWER_NEVER_SOURCE_KEY,
  ASSET_VIEWER_NO_PREVIEW_KEY,
  ASSET_VIEWER_PREVIEW_A11Y_KEY,
  ASSET_VIEWER_RESET_KEY,
  ASSET_VIEWER_STATIC_ONLY_KEY,
  ASSET_VIEWER_STATIC_SMALL_SCREEN_KEY,
  ASSET_VIEWER_STATISTICS_KEY,
  ASSET_VIEWER_STREAMED_ONLY_KEY,
  ASSET_VIEWER_WIREFRAME_KEY,
} from "../../lib/digital-asset-labels";

/**
 * The public 3D preview (#1015 Workstream 4).
 *
 * Orbit / pan / zoom, full screen, reset, an animation selector when the work
 * has animations, optional wireframe and render statistics, a MOBILE fallback
 * and an accessible STATIC fallback — and the rule every one of those is
 * subordinate to:
 *
 * > **the public viewer must never require the paid source file to render**
 *
 * (#1015 W4's closing line, acceptance criterion 10, W12 threat 15.)
 *
 * ## How that rule is held here, and where it is NOT held
 *
 * It is not held here. It is held by the TYPE of the `source` prop:
 * `AssetPreviewSource` is branded with a symbol private to
 * `../../lib/asset-preview`, so the only way to obtain one is
 * `admitAssetPreview`, which reads `PUBLICLY_VIEWABLE_ASSET_FILE_ROLES` and
 * refuses everything else. There is no file list in this component's props,
 * nothing here filters, and a caller holding a `mesh` or a `source` file has
 * nothing it could pass — the failure is a compile error at the call site.
 *
 * That is deliberate and it is the whole design. A component that took
 * `files: AssetFile[]` and filtered them would (a) require the paid files to
 * reach the client to be filtered, (b) put the guarantee in one expression a
 * refactor can widen, and (c) grow a second copy the moment a second surface
 * renders a preview. See that module's note for the measurement.
 *
 * ## The interactive path is a SEAM, and today nothing is plugged into it
 *
 * Mercaria installs no WebGL/three.js-shaped dependency in any of the three
 * Expo apps, and #1015 W4 does not authorize adding one: a renderer is a native
 * dependency in three apps with `expo.install.exclude` and native-version
 * alignment consequences (`docs/dependencies.md`), which is a decision for a
 * human rather than a side effect of a viewer component.
 *
 * So the interactive path is the {@link AssetModelRenderer} prop. With no
 * renderer the component takes the STATIC path — which is not a degraded mode
 * bolted on afterwards but the path #1015 W4 requires exist anyway ("accessible
 * static preview fallback"), and therefore the one that is complete here. When a
 * renderer is chosen, it is injected at the call site and every control below
 * starts driving it; nothing in this file changes.
 *
 * ## Mobile is a fallback by DECISION, not by capability
 *
 * `Platform.OS` alone is the wrong question — mobile WEB is a browser and a
 * tablet is not a phone — so the rule is one measurement: a viewport narrower
 * than {@link INTERACTIVE_MINIMUM_WIDTH} gets the still. An orbit gesture in a
 * 390px column competes with the page scroll, and a model rendered at that size
 * shows less than the poster does.
 *
 * ## What a reader is told, in words
 *
 * Three sentences, and each is a fact a buyer would otherwise have to guess:
 * the preview is a GENERATED copy and not the files being sold
 * (`neverTheSourceFile`), a `preview_only` derivative is streamed and never
 * handed over (`streamedOnly`), and the still is a still BECAUSE of the
 * renderer or the screen rather than because the work has nothing more
 * (`staticOnly` / `staticOnSmallScreen`). None of them claims the preview is
 * accurate: a derivative is deliberately lower-fidelity, and #1015 W4's "do not
 * overclaim machine-generated validation" applies to a rendering as much as to a
 * measurement.
 */

/** Icon edge length (px) for the control row. */
const CONTROL_ICON_SIZE = 16;

/**
 * The viewport width (dp) at which the interactive path becomes available.
 *
 * 600 is the `md` shoulder this package's components already lay out against, so
 * the viewer turns interactive at the same width the page stops being a single
 * column — one breakpoint rather than a second one only this component knows.
 */
const INTERACTIVE_MINIMUM_WIDTH = 600;

/** What the controls ask the renderer to do. */
export interface AssetViewerViewState {
  /**
   * Incremented by the reset control.
   *
   * A NONCE rather than a boolean: "reset" is an event, and a boolean would have
   * to be set and then cleared by whoever consumed it, which is a second piece
   * of state that can disagree with the first. A renderer re-centres whenever
   * this changes and needs no acknowledgement.
   */
  readonly resetNonce: number;
  readonly wireframe: boolean;
  readonly statistics: boolean;
  /** The animation to play, or `null` for none. Always one of `source.animations`. */
  readonly animation: string | null;
  /** True while the viewer is in its full-screen presentation. */
  readonly fullscreen: boolean;
}

/**
 * The interactive renderer contract.
 *
 * A COMPONENT TYPE rather than an imperative handle, so whatever implements it
 * owns its own lifecycle and this component owns only the controls. It receives
 * the admitted source and the view state and renders into the frame it is given
 * — it is never handed a file list, a storage key or an asset id.
 */
export type AssetModelRenderer = ComponentType<{
  readonly source: AssetPreviewSource;
  readonly view: AssetViewerViewState;
}>;

export interface AssetPreviewViewerProps {
  /**
   * The admitted public preview, or `undefined` when the work publishes none.
   *
   * Construct it with `admitAssetPreview`. There is deliberately no prop that
   * takes a file, a role, a list or a URL.
   */
  source?: AssetPreviewSource;
  /**
   * Why the offered file was refused, when one was.
   *
   * A REASON CODE, never a descriptor — passing this cannot put a paid file on
   * screen. It exists so "this file is part of the purchase" can be said out
   * loud instead of rendering the same empty frame as "there is no preview".
   */
  unavailable?: AssetPreviewRefusalReason;
  /** The work's title, for the frame's accessible name. */
  title: string;
  /** The interactive renderer, when a deployment has one. See the module note. */
  renderer?: AssetModelRenderer;
}

export function AssetPreviewViewer({
  source,
  unavailable,
  title,
  renderer: Renderer,
}: AssetPreviewViewerProps) {
  const t = useSharedUiTranslation();
  const { colors } = useColorScheme();
  const { width } = useWindowDimensions();

  const [resetNonce, setResetNonce] = useState(0);
  const [wireframe, setWireframe] = useState(false);
  const [statistics, setStatistics] = useState(false);
  const [animation, setAnimation] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const screenIsWideEnough = width >= INTERACTIVE_MINIMUM_WIDTH;
  const isModel = source !== undefined && assetPreviewKind(source) === "streamed_model";
  const interactive = isModel && Renderer !== undefined && screenIsWideEnough;

  const view: AssetViewerViewState = {
    resetNonce,
    wireframe,
    statistics,
    animation,
    fullscreen,
  };

  const closeFullscreen = useCallback(() => setFullscreen(false), []);

  /**
   * The still, and ONLY a still.
   *
   * A `streamed_model` has no still of its own, so its poster is the whole of
   * the static path — handing its `uri` to `Image` would put a broken image
   * where the fallback should be. `undefined` here is a real state and renders
   * the frame's own empty text rather than a failed load.
   */
  const stillUri =
    source === undefined ? undefined : isModel ? source.posterUri : source.uri;

  /*
   * The renderer is mounted in exactly ONE place at a time — inline, or in the
   * full-screen modal, never both. A second mount is a second GPU context and a
   * second copy of the model for the same preview, which is the kind of cost a
   * component that does not own its renderer must not impose on one.
   */
  const frame = (
    <View
      className="relative aspect-[4/3] w-full overflow-hidden rounded-radius-20 bg-bg-fill-hover"
      accessibilityLabel={t(ASSET_VIEWER_PREVIEW_A11Y_KEY, { title })}
    >
      {interactive && !fullscreen && source !== undefined && Renderer !== undefined ? (
        <Renderer source={source} view={view} />
      ) : stillUri === undefined ? (
        <View className="flex-1 items-center justify-center px-space-16">
          <Text className="text-bodySmall text-text-tertiary">
            {unavailable === undefined
              ? t(ASSET_VIEWER_NO_PREVIEW_KEY)
              : t(ASSET_PREVIEW_REFUSAL_KEYS[unavailable])}
          </Text>
        </View>
      ) : (
        <Image
          source={{ uri: stillUri }}
          contentFit="contain"
          style={StyleSheet.absoluteFill}
          accessibilityLabel={t(ASSET_VIEWER_PREVIEW_A11Y_KEY, { title })}
        />
      )}
    </View>
  );

  const controls =
    source === undefined ? null : (
      <View
        className="flex-row flex-wrap items-center gap-space-8"
        accessibilityRole="toolbar"
        accessibilityLabel={t(ASSET_VIEWER_CONTROLS_KEY)}
      >
        {interactive ? (
          <>
            <ControlButton
              label={t(ASSET_VIEWER_RESET_KEY)}
              onPress={() => setResetNonce((nonce) => nonce + 1)}
            >
              <RotateCcw size={CONTROL_ICON_SIZE} color={colors.foreground} />
            </ControlButton>
            <ToggleButton
              label={t(ASSET_VIEWER_WIREFRAME_KEY)}
              checked={wireframe}
              onPress={() => setWireframe((on) => !on)}
            >
              <Grid3x3 size={CONTROL_ICON_SIZE} color={colors.foreground} />
            </ToggleButton>
            <ToggleButton
              label={t(ASSET_VIEWER_STATISTICS_KEY)}
              checked={statistics}
              onPress={() => setStatistics((on) => !on)}
            >
              <Activity size={CONTROL_ICON_SIZE} color={colors.foreground} />
            </ToggleButton>
          </>
        ) : null}

        <ControlButton
          label={fullscreen ? t(ASSET_VIEWER_FULLSCREEN_CLOSE_KEY) : t(ASSET_VIEWER_FULLSCREEN_OPEN_KEY)}
          onPress={() => setFullscreen((open) => !open)}
        >
          {fullscreen ? (
            <Minimize2 size={CONTROL_ICON_SIZE} color={colors.foreground} />
          ) : (
            <Maximize2 size={CONTROL_ICON_SIZE} color={colors.foreground} />
          )}
        </ControlButton>
      </View>
    );

  /*
   * The animation selector exists only when the work HAS animations, and is
   * absent rather than disabled when it does not: a disabled selector says the
   * work is animated and the viewer will not play it, which is a different and
   * false statement. It is also absent on the static path — there is nothing to
   * animate in a still, and offering the control there would be the same lie.
   */
  const animations = source?.animations ?? [];
  const animationPicker =
    interactive && animations.length > 0 ? (
      <View className="gap-space-8">
        <Text className="text-captionBold text-text">{t(ASSET_VIEWER_ANIMATION_KEY)}</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={ANIMATION_ROW_STYLE}
          accessibilityRole="radiogroup"
          accessibilityLabel={t(ASSET_VIEWER_ANIMATION_KEY)}
        >
          <AnimationChip
            label={t(ASSET_VIEWER_ANIMATION_OFF_KEY)}
            selected={animation === null}
            onPress={() => setAnimation(null)}
          />
          {animations.map((name) => (
            <AnimationChip
              key={name}
              /* The creator's own animation name: an identifier they chose, shown
                 verbatim for the reason an ISO currency code is — there is no
                 localized form of somebody's clip name, and inventing one would
                 stop matching what their file contains. */
              label={name}
              selected={animation === name}
              onPress={() => setAnimation(name)}
            />
          ))}
        </ScrollView>
      </View>
    ) : null;

  const notes =
    source === undefined ? null : (
      <View className="gap-space-4">
        {/* Why this is a still, when it is one — never left to be inferred. */}
        {isModel && !interactive ? (
          <Text className="text-caption text-text-tertiary">
            {Renderer === undefined || screenIsWideEnough
              ? t(ASSET_VIEWER_STATIC_ONLY_KEY)
              : t(ASSET_VIEWER_STATIC_SMALL_SCREEN_KEY)}
          </Text>
        ) : null}
        {interactive ? (
          <Text className="text-caption text-text-tertiary">{t(ASSET_VIEWER_GESTURES_KEY)}</Text>
        ) : null}
        <Text className="text-caption text-text-tertiary">
          {t(ASSET_VIEWER_NEVER_SOURCE_KEY)}
        </Text>
        {/* `preview_only`: streamed, and no grant will ever hand it over. */}
        {isAssetPreviewFile(source) ? null : (
          <Text className="text-caption text-text-tertiary">
            {t(ASSET_VIEWER_STREAMED_ONLY_KEY)}
          </Text>
        )}
      </View>
    );

  return (
    <View className="gap-space-12">
      {frame}
      {animationPicker}
      {controls}
      {notes}

      {/*
        Full screen is a MODAL rather than an absolutely positioned overlay: this
        component renders inside a page column, and `inset-0` on a child of that
        column covers the column, not the screen. `onRequestClose` is what makes
        the Android back button and the browser's Escape close it, so the
        fullscreen control is not the only way out.
      */}
      <Modal
        visible={fullscreen}
        animationType="fade"
        onRequestClose={closeFullscreen}
        accessibilityViewIsModal
      >
        <View className="flex-1 bg-bg-fill p-space-16">
          <View className="flex-row justify-end">
            <ControlButton label={t(ASSET_VIEWER_FULLSCREEN_CLOSE_KEY)} onPress={closeFullscreen}>
              <Minimize2 size={CONTROL_ICON_SIZE} color={colors.foreground} />
            </ControlButton>
          </View>
          <View className="flex-1 justify-center">
            {interactive && source !== undefined && Renderer !== undefined ? (
              <View className="flex-1">
                <Renderer source={source} view={view} />
              </View>
            ) : stillUri === undefined ? (
              <Text className="text-bodySmall text-text-tertiary">
                {t(ASSET_VIEWER_NO_PREVIEW_KEY)}
              </Text>
            ) : (
              <Image
                source={{ uri: stillUri }}
                contentFit="contain"
                style={FULLSCREEN_IMAGE_STYLE}
                accessibilityLabel={t(ASSET_VIEWER_PREVIEW_A11Y_KEY, { title })}
              />
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

/** `contentContainerStyle` takes a style object, not a class name. */
const ANIMATION_ROW_STYLE = { gap: 8 } as const;

/** The full-screen still fills the modal body rather than the frame's ratio. */
const FULLSCREEN_IMAGE_STYLE = { flex: 1, width: "100%" } as const;

/**
 * One control.
 *
 * The label is ANNOUNCED and not drawn: the row is a compact icon toolbar beside
 * a preview, and a visible caption per control would be wider than the frame on
 * a phone. Every control therefore carries `accessibilityLabel`, which is also
 * the web `aria-label` under react-native-web, so a pointer user gets the
 * tooltip and a screen-reader user gets the same words.
 */
function ControlButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="items-center justify-center rounded-radius-max border border-border-secondary p-space-8"
    >
      {children}
    </Pressable>
  );
}

/**
 * A control with an on/off state.
 *
 * `accessibilityRole="switch"` plus `accessibilityState.checked`, so the state is
 * announced rather than only drawn — the border change alone would make "is the
 * wireframe on" a colour question, which #147's accessibility rule 2 and the
 * house convention both refuse.
 */
function ToggleButton({
  label,
  checked,
  onPress,
  children,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      onPress={onPress}
      className={
        checked
          ? "items-center justify-center rounded-radius-max bg-bg-fill-secondary p-space-8"
          : "items-center justify-center rounded-radius-max border border-border-secondary p-space-8"
      }
    >
      {children}
    </Pressable>
  );
}

/** One animation choice. Radio semantics: exactly one plays at a time. */
function AnimationChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      onPress={onPress}
      className={
        selected
          ? "rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-6"
          : "rounded-radius-max border border-border-secondary px-space-12 py-space-6"
      }
    >
      {/* Spelled as well as announced — the selected chip is never colour alone. */}
      <Text className="text-caption text-text">{selected ? `${label} ✓` : label}</Text>
    </Pressable>
  );
}
