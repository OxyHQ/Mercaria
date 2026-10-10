import { Link } from "expo-router";
import type { ProductLinkRenderer } from "@mercaria/ui";

/** Give shared cards native routing and real web anchors without coupling UI to Expo. */
export const renderListingLink: ProductLinkRenderer = (id, child) => (
  <Link href={{ pathname: "/products/[id]", params: { id } }} asChild>
    {child}
  </Link>
);
