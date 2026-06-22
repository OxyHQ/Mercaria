import React from "react";
import { View } from "react-native";
import { useOxy, showSignInModal } from "@oxyhq/services";
import { Text, Button } from "@mercaria/ui";
import { Logo } from "@/components/Logo";
import { ScreenLoading } from "@/components/shell/Screen";

/**
 * Auth gate for the whole POS. The register has NO anonymous surface:
 *  - while the SDK cold boot is resolving the session, render a neutral spinner;
 *  - once resolved with no user, render a clean sign-in screen;
 *  - once authenticated, render the app.
 *
 * The root `OxyProvider` (no `disableAutoSso`) owns session restore / SSO bounce;
 * this component only renders the right surface for the resolved state.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useOxy();

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ScreenLoading />
      </View>
    );
  }

  if (!isAuthenticated) {
    return <SignInScreen />;
  }

  return <>{children}</>;
}

function SignInScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <View className="w-full max-w-sm items-center">
        <View className="mb-6 h-16 w-16 items-center justify-center rounded-3xl bg-secondary">
          <Logo size={36} />
        </View>
        <Text className="text-center text-2xl font-bold text-foreground">
          Mercaria POS
        </Text>
        <Text className="mt-2 text-center text-sm text-muted-foreground">
          Sign in with your Oxy account to open the register — ring up in-person
          sales, attach customers, and charge.
        </Text>
        <Button className="mt-8 w-full" onPress={() => showSignInModal()}>
          <Text className="font-semibold text-primary-foreground">Sign in</Text>
        </Button>
      </View>
    </View>
  );
}
