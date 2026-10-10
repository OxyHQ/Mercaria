import React, { useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Animated, StyleSheet, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import {
    APP_COLOR_PRESETS,
    ColorEngine,
    type AppColorName,
} from '@oxy.so/bloom/theme';
import { Logo } from '@/components/Logo';
import { Loading } from '@oxy.so/bloom/loading';
import { BLOOM_DEFAULT_COLOR_PRESET } from '@/lib/themePersistence';

interface AppSplashScreenProps {
    onFadeComplete?: () => void;
    startFade?: boolean;
}

const FADE_DURATION = 500;
const LOGO_SIZE = 100;
const SPINNER_SIZE = 28;

// The splash renders before theme context. Wholesale uses the same controlled
// orange Bloom preset here and in the provider; stored light/dark mode remains
// Bloom-owned. Derive the dark role set so the white spinner stays legible.

// Safe literal fallback if the recipe registry cannot resolve a preset.
const FALLBACK_GRADIENT: readonly [string, string] = ['#1A1A1A', '#1A1A1A'];

// Matches the provider's controlled colorPreset and defaultColorPreset.
const DEFAULT_PRESET = BLOOM_DEFAULT_COLOR_PRESET;

// Near-black second stop, shared across presets so the gradient always bottoms out dark.
const DARK_STOP = '#1A1A1A';

/**
 * Build a DARK two-stop gradient from a preset. Stop 1 is Bloom's own dark
 * `background` role derived from that preset's seed — a near-black tinted with the
 * seed's hue — and stop 2 is near-black, so the brand logo and white spinner always stay
 * clearly visible regardless of preset. Falls back to the safe literal for an
 * unrecognised preset name.
 */
function buildDarkGradient(presetName: AppColorName): readonly [string, string] {
    const preset = APP_COLOR_PRESETS[presetName];
    if (!preset) return FALLBACK_GRADIENT;
    const { background } = ColorEngine.generateRoleColors({
        seed: preset.hex,
        variant: preset.variant,
        isDark: true,
    });
    return [background, DARK_STOP];
}

const AppSplashScreen: React.FC<AppSplashScreenProps> = ({
    onFadeComplete,
    startFade = false
}) => {
    const fadeAnim = useRef(new Animated.Value(1)).current;
    const animationRef = useRef<Animated.CompositeAnimation | null>(null);

    const gradient = useMemo(() => buildDarkGradient(DEFAULT_PRESET), []);

    const handleFadeComplete = useCallback(
        (finished: boolean) => {
            if (finished && onFadeComplete) {
                onFadeComplete();
            }
        },
        [onFadeComplete],
    );

    useEffect(() => {
        if (startFade) {
            // Cancel any existing animation
            animationRef.current?.stop();

            // Start fade out animation
            animationRef.current = Animated.timing(fadeAnim, {
                toValue: 0,
                duration: FADE_DURATION,
                useNativeDriver: Platform.OS !== 'web',
            });

            animationRef.current.start(({ finished }) => {
                handleFadeComplete(finished);
            });
        }

        return () => {
            animationRef.current?.stop();
        };
    }, [startFade, fadeAnim, handleFadeComplete]);

    // Memoized styles
    const containerStyle = useMemo(
        () => [styles.container, { opacity: fadeAnim }],
        [fadeAnim]
    );

    return (
        <Animated.View style={containerStyle}>
            <LinearGradient
                colors={gradient}
                style={styles.gradient}
            >
                <View style={styles.logoContainer}>
                    <Logo size={LOGO_SIZE} />
                    <View style={styles.spinnerContainer}>
                        <Loading iconSize={SPINNER_SIZE} color="white" showText={false} />
                    </View>
                </View>
            </LinearGradient>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    gradient: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    logoContainer: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    spinnerContainer: {
        marginTop: 32,
    },
});

export default React.memo(AppSplashScreen);
