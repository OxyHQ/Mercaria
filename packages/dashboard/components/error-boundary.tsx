import React from 'react';
import { View, Pressable, ScrollView, Platform } from 'react-native';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional fallback component. If not provided, the default error screen is used. */
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
export class AppErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
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
        return (
          <FallbackComponent
            error={this.state.error}
            resetError={this.resetError}
          />
        );
      }

      return (
        <ErrorFallback
          error={this.state.error}
          resetError={this.resetError}
        />
      );
    }

    return this.props.children;
  }
}

/** Default full-screen error fallback UI. */
function ErrorFallback({
  error,
  resetError,
}: {
  error: Error;
  resetError: () => void;
}) {
  // `useTranslation` reads a zustand slice and is not suspenseful, so it is safe
  // in the fallback: this component renders precisely when the tree below it
  // failed, and a hook that could throw or suspend here would replace the
  // recovery screen with a blank one.
  const { t } = useTranslation();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: '#040711',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
      }}
    >
      <View
        style={{
          maxWidth: 400,
          width: '100%',
          alignItems: 'center',
        }}
      >
        {/* Icon */}
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: 'rgba(239, 68, 68, 0.15)',
            justifyContent: 'center',
            alignItems: 'center',
            marginBottom: 20,
          }}
        >
          <Text
            style={{
              fontSize: 24,
              color: '#ef4444',
              fontWeight: '600',
            }}
          >
            !
          </Text>
        </View>

        {/* Title */}
        <Text
          style={{
            fontSize: 20,
            fontWeight: '700',
            color: '#f1f5f9',
            textAlign: 'center',
            marginBottom: 8,
          }}
        >
          {t('common.somethingWentWrong')}
        </Text>

        {/* Description */}
        <Text
          style={{
            fontSize: 15,
            color: '#94a3b8',
            textAlign: 'center',
            lineHeight: 22,
            marginBottom: 24,
          }}
        >
          {t('errors.boundaryBody')}
        </Text>

        {/* Error details (collapsible in dev) */}
        {__DEV__ && (
          <ScrollView
            style={{
              maxHeight: 120,
              width: '100%',
              backgroundColor: 'rgba(255, 255, 255, 0.05)',
              borderRadius: 8,
              padding: 12,
              marginBottom: 24,
            }}
          >
            <Text
              style={{
                fontSize: 12,
                color: '#64748b',
                fontFamily: Platform.OS === 'web' ? 'monospace' : 'SpaceMono',
              }}
              selectable
            >
              {error.message}
            </Text>
          </ScrollView>
        )}

        {/* Retry button */}
        <Pressable
          onPress={resetError}
          style={({ pressed }) => ({
            backgroundColor: pressed ? '#7c3aed' : '#8b5cf6',
            paddingHorizontal: 28,
            paddingVertical: 12,
            borderRadius: 12,
            width: '100%',
            alignItems: 'center',
          })}
          accessibilityRole="button"
          accessibilityLabel={t('common.retry')}
        >
          <Text
            style={{
              fontSize: 15,
              fontWeight: '600',
              color: '#ffffff',
            }}
          >
            {t('common.retry')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
