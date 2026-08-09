import { Button } from "@oxyhq/bloom/button";
import { FollowTargetButton, openAccountDialog, useOxy } from "@oxyhq/services";
import { useSellerFollowTarget } from "@/lib/hooks/use-seller-follow";

/**
 * Follow a P2P SELLER — a person — backed by Oxy's user-owned follow graph
 * (#92, #26).
 *
 * ## Why this is not `StoreFollowButton` with a different prop
 *
 * A store is a Mercaria-local row followed under `mercaria.store` at a
 * `mercaria.co` URI. A seller is an OXY ACCOUNT followed under the platform
 * kind `oxy.user` at Oxy's canonical user URI, so that the follow taken here is
 * literally the same relationship every other Oxy application sees. Two
 * different kinds, two different URI spaces, and a target row's kind is fixed
 * forever by whoever registers its URI first — so generalising one component
 * over both would be one edit away from registering a human being under a
 * marketplace's namespace.
 *
 * The product page compounds the risk: `products/[id].tsx` resolves a SINGLE
 * `identity` store-first-then-seller and feeds it to `MerchantHeader`. Putting
 * a follow control there would push a shop and a person through one code path
 * and get the person's kind wrong. Both follow buttons stay out of that header;
 * each renders beside the entity it actually names.
 *
 * ## Follow state, counts and optimistic UI are NOT Mercaria's
 *
 * `FollowTargetButton` owns all of it — including the distinction between "not
 * followed" and "followed but switched off here", the pending state of a
 * request to a private account, and the idempotence of a repeated tap. Nothing
 * in this file reads or stores a follow state of its own, and Mercaria's API
 * has no endpoint that could. That is what makes the profile page and the
 * product-page seller card show the same state (#26 follow rule 5): there is
 * one source and both read it.
 *
 * Timed follows are off (`durations={false}`), as for shops: you follow a
 * seller to hear when they list something, which is open-ended. "Follow this
 * person for 24 hours" is not a thing anyone means.
 */
export function SellerFollowButton({
  oxyUserId,
  displayName,
  size = "medium",
}: {
  oxyUserId: string;
  displayName: string;
  size?: "small" | "medium" | "large";
}) {
  const { canUsePrivateApi } = useOxy();
  const { data: followTargetId } = useSellerFollowTarget(oxyUserId);

  if (followTargetId) {
    return (
      <FollowTargetButton
        targetId={followTargetId}
        verb="follow"
        applicationName="Mercaria"
        durations={false}
        size={size}
      />
    );
  }

  // Signed in, but the target is still resolving. Render nothing rather than a
  // button that cannot act yet — the alternative invites a press that fails.
  if (canUsePrivateApi) return null;

  // Signed out. Resolving a target and following are both user-delegated, so
  // there is nothing to press until there is a session; the honest affordance
  // is the one that gets them one.
  return (
    <Button
      variant="primary"
      size={size}
      onPress={() => openAccountDialog()}
      accessibilityLabel={`Follow ${displayName}`}
    >
      Follow
    </Button>
  );
}
