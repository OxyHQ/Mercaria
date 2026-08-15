import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
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
  const router = useRouter();

  if (channels.length === 0) return null;

  return (
    <View className="gap-space-8">
      <Text className="text-sectionTitle text-text" accessibilityRole="header">
        {title}
      </Text>
      <Text className="text-caption text-text-secondary">{explanation}</Text>
      {/*
        LINKED as of #252, for the reason `OfferRow` states: #73 shipped
        `/merchants/[idOrSlug]`, so the route these channels were named rather
        than linked for now exists. A verified channel is exactly the identity a
        shopper wants to look up before spending, and `merchantSlug` is the
        stable handle that survives a merge.

        The badge context does NOT travel with the link, deliberately. This card
        says "the brand verified this channel"; the merchant page says what #55
        currently holds about that merchant, re-derived on its own read. Passing
        the standing along as a parameter would let a page assert a badge from a
        caller's word rather than from the relationship (#55's public read never
        trusts `status` alone).
      */}
      {channels.map((channel) => (
        <Pressable
          key={`${channel.merchantId}:${channel.storefrontId ?? 'all'}`}
          accessibilityRole="link"
          accessibilityLabel={`Visit ${channel.merchantName}`}
          onPress={() =>
            router.push(`/merchants/${channel.merchantSlug}` as Parameters<typeof router.push>[0])
          }
          className="rounded-radius-28 border border-border-secondary p-space-12"
        >
          <Text className="text-bodyTitleSmall text-text">{channel.merchantName}</Text>
          {channel.storefrontName ? (
            <Text className="text-caption text-text-secondary">{channel.storefrontName}</Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}
