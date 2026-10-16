import React from 'react';
import { View, Pressable, ScrollView, Platform, Text, useColorScheme } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { buildTheme, useTheme, type ThemeColors } from '@oxy.so/bloom/theme';
import { BLOOM_DEFAULT_COLOR_PRESET } from '@/lib/themePersistence';
import { useTranslation } from '@/lib/i18n';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional fallback component. If not provided, the provider-independent recovery screen is used. */
  fallback?: React.ComponentType<{ error: Error; resetError: () => void }>;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * A reusable error boundary that catches JavaScript errors in its child
 * component tree, reports them to Sentry, and displays a user-friendly
 * recovery screen.
 */
export class AppErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // If Sentry is configured, report the error
    try {
      const Sentry = require('@sentry/react-native');
      Sentry.captureException(error, {
        contexts: {
          react: {
            componentStack: errorInfo.componentStack ?? undefined,
          },
        },
      });
    } catch {
      // Sentry not installed — skip
    }

    if (__DEV__) {
      console.error('AppErrorBoundary caught an error:', error, errorInfo);
    }
  }

  resetError = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        const FallbackComponent = this.props.fallback;
        return <FallbackComponent error={this.state.error} resetError={this.resetError} />;
      }

      return <ProviderErrorFallback error={this.state.error} resetError={this.resetError} />;
    }

    return this.props.children;
  }
}

interface ErrorFallbackProps {
  error: Error;
  resetError: () => void;
}

/**
 * Recovery when the provider itself failed: no theme context, shared UI context,
 * storage reads or extra provider. Bloom's public recipe builder supplies the
 * brand palette; the system mode is the safe fallback without a working provider.
 */
function ProviderErrorFallback(props: ErrorFallbackProps) {
  const mode = useColorScheme() === 'dark' ? 'dark' : 'light';
  const { colors } = buildTheme(BLOOM_DEFAULT_COLOR_PRESET, mode);
  const { t } = useTranslation();
  return (
    <ErrorPresentation {...props} colors={colors}>
      <Pressable
        onPress={props.resetError}
        style={({ pressed }) => ({
          backgroundColor: colors.primary,
          opacity: pressed ? 0.8 : 1,
          paddingHorizontal: 28,
          paddingVertical: 12,
          borderRadius: 12,
          width: '100%',
          alignItems: 'center',
        })}
        accessibilityRole="button"
        accessibilityLabel={t('common.retry')}
      >
        <Text style={{ fontSize: 15, fontWeight: '600', color: colors.primaryForeground }}>
          {t('common.retry')}
        </Text>
      </Pressable>
    </ErrorPresentation>
  );
}

/** A screen failed while Bloom is healthy: preserve the active theme and mode. */
export function ThemedErrorFallback(props: ErrorFallbackProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <ErrorPresentation {...props} colors={colors}>
      <Button tone="accent" onPress={props.resetError}>
        {t('common.retry')}
      </Button>
    </ErrorPresentation>
  );
}

/** Native primitives keep the outer recovery usable without any UI provider. */
function ErrorPresentation({
  error,
  colors,
  children,
}: ErrorFallbackProps & {
  colors: ThemeColors;
  children: React.ReactNode;
}) {
  // This zustand reader neither requires context nor suspends.
  const { t } = useTranslation();
  return (
    <View
      testID="app-error-fallback"
      style={{
        flex: 1,
        minHeight: 400,
        backgroundColor: colors.background,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
      }}
    >
      <View style={{ maxWidth: 400, width: '100%', alignItems: 'stretch' }}>
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: colors.errorSubtle,
            justifyContent: 'center',
            alignItems: 'center',
            alignSelf: 'center',
            marginBottom: 20,
          }}
        >
          <Text style={{ fontSize: 24, color: colors.errorSubtleForeground, fontWeight: '600' }}>
            !
          </Text>
        </View>
        <Text
          style={{
            fontSize: 20,
            fontWeight: '700',
            color: colors.text,
            textAlign: 'center',
            marginBottom: 8,
          }}
        >
          {t('common.somethingWentWrong')}
        </Text>
        <Text
          style={{
            fontSize: 15,
            color: colors.textSecondary,
            textAlign: 'center',
            lineHeight: 22,
            marginBottom: 24,
          }}
        >
          {t('errors.boundaryBody')}
        </Text>
        {__DEV__ && (
          <ScrollView
            style={{
              maxHeight: 120,
              width: '100%',
              backgroundColor: colors.backgroundSecondary,
              borderRadius: 8,
              padding: 12,
              marginBottom: 24,
            }}
          >
            <Text
              style={{
                fontSize: 12,
                color: colors.textSecondary,
                fontFamily: Platform.OS === 'web' ? 'monospace' : 'SpaceMono',
              }}
              selectable
            >
              {error.message}
            </Text>
          </ScrollView>
        )}
        {children}
      </View>
    </View>
  );
}
