import { View } from "react-native";
import { Badge } from "@oxy.so/bloom/badge";
import { RiShieldCheckLine } from "@oxy.so/bloom/icons/RiShieldCheckLine";
import { RiVerifiedBadgeLine } from "@oxy.so/bloom/icons/RiVerifiedBadgeLine";
import type { PublicRelationshipBadge } from "@mercaria/shared-types";
import { cn } from "../../lib/cn";

/**
 * The label for one VERIFIED brand relationship (#72 official-channel rule 2,
 * #55 product behaviour 3).
 *
 * `official_store` and `authorized_reseller` are different claims about
 * different commercial arrangements and they get different words, different
 * icons and different colours. One component with a variant rather than two
 * components, so the two can never drift into looking alike — but the COPY for
 * each is stated separately below, because "Apple Store" and "an authorized
 * Apple reseller" mean different things to a shopper and a shared string would
 * flatten them.
 *
 * There is deliberately no `unverified` or `claimed` variant. A merchant with
 * no verified relationship has no badge at all — it holds no relationship row
 * (ADR 0002 D10), which is the NORMAL state and not a missing one.
 */

/** What each badge SAYS. Separate strings on purpose — see the module doc. */
const BADGE_TEXT: Readonly<Record<PublicRelationshipBadge, string>> = Object.freeze({
  official_store: "Official store",
  authorized_reseller: "Authorized reseller",
});

/**
 * What each badge MEANS, in one sentence a shopper can act on.
 *
 * Rendered as the accessible label rather than as a tooltip, because a
 * relationship claim a sighted user can hover and a screen-reader user cannot
 * is exactly the disclosure #72's accessibility rule is about.
 */
const BADGE_EXPLANATION: Readonly<Record<PublicRelationshipBadge, string>> = Object.freeze({
  official_store: "Verified as this brand's own sales channel",
  authorized_reseller: "Verified by this brand as an authorized reseller",
});

export interface OfficialChannelBadgeProps {
  badge: PublicRelationshipBadge;
  /**
   * The markets the claim covers. EMPTY means unrestricted, which is a
   * DIFFERENT fact from "no markets" and is rendered as such (#72
   * official-channel rule 4): a claim covering one country must never read as a
   * global endorsement.
   */
  territories?: readonly string[];
  className?: string;
}

export function OfficialChannelBadge({
  badge,
  territories = [],
  className,
}: OfficialChannelBadgeProps) {
  const scope =
    territories.length === 0 ? "Worldwide" : `In ${[...territories].sort().join(", ")}`;

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${BADGE_TEXT[badge]}. ${BADGE_EXPLANATION[badge]}. ${scope}.`}
      className={cn("self-start", className)}
    >
      <Badge
        size="label-medium"
        variant="subtle"
        color={badge === "official_store" ? "primary" : "default"}
        icon={badge === "official_store" ? RiVerifiedBadgeLine : RiShieldCheckLine}
        content={`${BADGE_TEXT[badge]} · ${scope}`}
      />
    </View>
  );
}
