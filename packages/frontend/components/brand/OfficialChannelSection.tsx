import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import type { BrandChannelEntry } from "@mercaria/shared-types";
import { OfficialChannelBadge, SectionHeader, Text } from "@mercaria/ui";

/**
 * One of a brand's two channel lists (#72 official-channel rules 2 and 4).
 *
 * TWO instances of this component, never one list with a badge column. "Apple
 * Store" and "an authorized Apple reseller" are different commercial claims,
 * and a single list sorted by badge is one styling change away from erasing the
 * difference — which is the specific confusion #72 acceptance 1 names.
 *
 * ## An empty list is a STATEMENT, not a missing section
 *
 * A brand with no verified channels holds no relationship row at all (ADR 0002
 * D10), which is the normal state for most of a crawled catalogue. So the
 * section renders its own sentence rather than disappearing: a section that
 * vanished would leave a reader unable to tell "we know of none" from "this
 * page did not load that part".
 */

export interface OfficialChannelSectionProps {
  title: string;
  /** What this list MEANS, in the page's own words. */
  description: string;
  entries: readonly BrandChannelEntry[];
  /** The sentence shown when there are none. */
  emptyText: string;
}

export function OfficialChannelSection({
  title,
  description,
  entries,
  emptyText,
}: OfficialChannelSectionProps) {
  const router = useRouter();

  return (
    <View className="flex flex-col gap-3">
      <SectionHeader title={title} />
      <Text className="text-sm text-muted-foreground">{description}</Text>
      {entries.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{emptyText}</Text>
      ) : (
        <View className="flex flex-col gap-2">
          {entries.map((entry) => (
            <Pressable
              key={entry.relationshipId}
              accessibilityRole="link"
              accessibilityLabel={entry.merchantName}
              // #73 owns the merchant page. This is the ONE thing the two
              // domains share: a link. A brand page never renders a merchant's
              // catalogue, its inventory or its own channels.
              onPress={() => router.push(`/merchants/${entry.merchantSlug}`)}
              className="flex flex-col gap-1 rounded-2xl border border-border p-3"
            >
              <Text className="text-sm font-medium">{entry.merchantName}</Text>
              <OfficialChannelBadge badge={entry.badge} territories={entry.territories} />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
