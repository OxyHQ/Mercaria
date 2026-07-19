import { View } from "react-native";
import { RefreshCw } from "lucide-react-native";
import type { ConnectorProviderId } from "@mercaria/shared-types";
import { cn } from "../../lib/cn";
import { Text } from "./text";
import { Icon } from "./icon";

/** Human-friendly labels for each connector platform (exhaustive over the union). */
const PROVIDER_LABELS: Record<ConnectorProviderId, string> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  etsy: "Etsy",
  prestashop: "PrestaShop",
  magento: "Magento",
};

export interface SourceBadgeProps {
  /** External platform this listing was imported/synced from. */
  provider: ConnectorProviderId;
  /** Extra classes for the chip container. */
  className?: string;
}

/**
 * Provenance chip shown on listings imported from an external commerce platform
 * (`Listing.source`). Subtle by design — a small muted pill with a sync glyph —
 * so it reads as metadata next to the title/status without competing with them.
 * Admin/dashboard surfaces only; the storefront never receives `source`.
 */
export function SourceBadge({ provider, className }: SourceBadgeProps) {
  return (
    <View
      className={cn(
        "flex-row items-center gap-1 self-start rounded-full bg-muted px-2 py-1",
        className,
      )}
    >
      <Icon as={RefreshCw} size={10} className="text-muted-foreground" />
      <Text className="text-[10px] font-semibold text-muted-foreground">
        Synced from {PROVIDER_LABELS[provider]}
      </Text>
    </View>
  );
}
