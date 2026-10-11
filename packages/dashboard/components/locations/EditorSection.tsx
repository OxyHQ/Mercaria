import React from 'react';
import { View } from 'react-native';
import { Text } from '@mercaria/ui';

/** One card of the location editor: a title, an optional explanation, its body. */
export function EditorSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      <View className="gap-1">
        <Text className="text-base font-semibold text-foreground">{title}</Text>
        {description ? <Text className="text-xs text-muted-foreground">{description}</Text> : null}
      </View>
      {children}
    </View>
  );
}
