import React, { useState } from 'react';
import { View, Text } from 'react-native';
import axios from 'axios';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { openAccountDialog } from '@oxyhq/services';
import { AuthContainer, AuthLogo, AuthInput, AuthButton, AuthError } from '@/components/auth';
import apiClient from '@/lib/api/client';
import { toast } from '@/components/sonner';
import { useTranslation } from '@/hooks/useTranslation';

export default function ResetPasswordScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(token ? '' : t('resetPassword.invalidToken'));

  const handleResetPassword = async () => {
    setError('');

    if (!password.trim()) {
      const errorMsg = t('resetPassword.enterNewPassword');
      setError(errorMsg);
      toast.error(errorMsg);
      return;
    }

    if (password.length < 8) {
      const errorMsg = t('errors.passwordTooShort');
      setError(errorMsg);
      toast.error(errorMsg);
      return;
    }

    if (password !== confirmPassword) {
      const errorMsg = t('errors.passwordsDoNotMatch');
      setError(errorMsg);
      toast.error(errorMsg);
      return;
    }

    setLoading(true);

    try {
      await apiClient.post('/auth/reset-password', {
        token,
        password,
      });

      toast.success(t('resetPassword.successMessage'));
      router.replace('/');
      openAccountDialog();
    } catch (error: unknown) {
      const errorMessage =
        (axios.isAxiosError(error) && typeof error.response?.data?.error === 'string'
          ? error.response.data.error
          : undefined) ?? t('resetPassword.failedToReset');
      setError(errorMessage);

      toast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthContainer>
      <AuthLogo />

      {/* Header */}
      <View className="space-y-2 mb-6">
        <Text className="text-3xl font-bold text-foreground tracking-tight">
          {t('resetPassword.title')}
        </Text>
        <Text className="text-base text-muted-foreground">
          {t('resetPassword.subtitle')}
        </Text>
      </View>

      {/* Form */}
      <View className="gap-3">
        <AuthError message={error} />

        <AuthInput
          placeholder={t('resetPassword.newPasswordPlaceholder')}
          value={password}
          onChangeText={(text) => {
            setPassword(text);
            setError('');
          }}
          secureTextEntry
          editable={!loading && !!token}
        />

        <AuthInput
          placeholder={t('resetPassword.confirmPasswordPlaceholder')}
          value={confirmPassword}
          onChangeText={(text) => {
            setConfirmPassword(text);
            setError('');
          }}
          secureTextEntry
          editable={!loading && !!token}
          onSubmitEditing={handleResetPassword}
        />

        <AuthButton
          onPress={handleResetPassword}
          disabled={loading || !password || !confirmPassword || !token}
          isLoading={loading}
          loadingText={t('resetPassword.resetting')}
          className="mt-3"
        >
          {t('resetPassword.resetButton')}
        </AuthButton>
      </View>
    </AuthContainer>
  );
}
