import * as React from "react";
import { View } from "react-native";
import { cn } from "@/lib/utils";
import { MercariaWordmark } from "@/components/ui/mercaria-wordmark";

export interface AuthLogoProps {
  className?: string;
}

export function AuthLogo({ className }: AuthLogoProps) {
  return (
    <View className={cn("items-center mb-6", className)}>
      <MercariaWordmark width={200} />
    </View>
  );
}
