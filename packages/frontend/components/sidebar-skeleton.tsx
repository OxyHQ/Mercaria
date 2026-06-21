import { View } from "react-native";
import { Skeleton } from "@/components/ui/skeleton";

export function SidebarSkeleton() {
  return (
    <View className="gap-1 px-2 py-1">
      {Array.from({ length: 8 }).map((_, i) => (
        <View key={i} className="py-1.5 px-2">
          <Skeleton className="h-3.5 rounded" style={{ width: `${55 + (i % 3) * 15}%` }} />
        </View>
      ))}
    </View>
  );
}
