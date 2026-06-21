import * as React from "react";
import { View } from "react-native";
import { cn } from "@/lib/utils";
import { MarketplaceWordmark } from "@/components/ui/marketplace-wordmark";

export interface AuthLogoProps {
  className?: string;
}

export function AuthLogo({ className }: AuthLogoProps) {
  return (
    <View className={cn("items-center mb-6", className)}>
      <MarketplaceWordmark width={200} />
    </View>
  );
}
