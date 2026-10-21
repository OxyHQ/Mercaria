import { Link } from "expo-router";
import type { ProductLinkRenderer, MerchantLinkRenderer } from "@mercaria/ui";

/** Give shared cards native routing and real web anchors without coupling UI to Expo. */
export const renderListingLink: ProductLinkRenderer = (id, child) => (
  <Link href={{ pathname: "/products/[id]", params: { id } }} asChild>
    {child}
  </Link>
);

/** Store-card links share the same platform routing contract as product cards. */
export const renderMerchantLink: MerchantLinkRenderer = (handle, child) => (
  <Link href={{ pathname: "/stores/[handle]", params: { handle } }} asChild>
    {child}
  </Link>
);
