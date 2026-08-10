import { View } from 'react-native';
import type { ProductPageBrandChannel } from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';

/**
 * The brand's verified channels (#71 relationships 3 and 4).
 *
 * ## Two lists, never one with a kind column
 *
 * #55 makes "the brand's own channel" and "a reseller the brand authorised"
 * separate kinds carrying separate badges, and #71 asks for them separately.
 * One list sorted by kind is one refactor away from a UI that renders them the
 * same, which is precisely the conflation the evidence model exists to prevent:
 * an authorised reseller is not the manufacturer, and a shopper deciding where
 * to buy a €1,200 phone is entitled to that distinction.
 *
 * ## An ordinary merchant appears in NEITHER, and that is normal
 *
 * Most merchants hold no relationship row at all (ADR 0002 D10). Their offers
 * are on the page like everybody else's, with no official label — absence here
 * is the ordinary state and not a gap in the data, which is why there is no
 * "unverified" list and must not be one.
 */

export interface BrandChannelsProps {
  officialChannels: readonly ProductPageBrandChannel[];
  authorizedResellers: readonly ProductPageBrandChannel[];
}

export function BrandChannels({ officialChannels, authorizedResellers }: BrandChannelsProps) {
  if (officialChannels.length === 0 && authorizedResellers.length === 0) return null;

  return (
    <View className="gap-space-16">
      <ChannelList
        title="Official stores"
        explanation="Channels the brand has verified as its own."
        channels={officialChannels}
      />
      <ChannelList
        title="Authorised resellers"
        explanation="Resellers the brand has verified as authorised. They are not the brand's own store."
        channels={authorizedResellers}
      />
    </View>
  );
}

function ChannelList({
  title,
  explanation,
  channels,
}: {
  title: string;
  explanation: string;
  channels: readonly ProductPageBrandChannel[];
}) {
  if (channels.length === 0) return null;

  return (
    <View className="gap-space-8">
      <Text className="text-sectionTitle text-text" accessibilityRole="header">
        {title}
      </Text>
      <Text className="text-caption text-text-secondary">{explanation}</Text>
      {/*
        NAMED, not linked, for the reason `OfferRow` states: there is no
        `/merchants/:slug` route in this app yet (#84/#73), and a link to a
        route that does not resolve is worse than the name — `typedRoutes` is
        INERT here, so nothing would catch it before a shopper did.
      */}
      {channels.map((channel) => (
        <View
          key={`${channel.merchantId}:${channel.storefrontId ?? 'all'}`}
          className="rounded-radius-28 border border-border-secondary p-space-12"
        >
          <Text className="text-bodyTitleSmall text-text">{channel.merchantName}</Text>
          {channel.storefrontName ? (
            <Text className="text-caption text-text-secondary">{channel.storefrontName}</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}
