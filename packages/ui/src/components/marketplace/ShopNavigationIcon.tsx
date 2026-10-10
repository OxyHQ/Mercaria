import type { BloomIconComponent } from "@oxy.so/bloom/icons";
import { SvgXml } from "react-native-svg";
import vectors from "./shop-navigation-icons.json";

/** Original 24px navigation vectors extracted from Shop's public rendered SVGs.
 * Source: https://shop.com/curations/01a0e9b7-5414-7e69-a529-85a3f6c3dc47
 * Only fixed black fills are normalized to currentColor so Bloom owns tint.
 */
const names = {
  home: "home-filled",
  explore: "grid-filled",
  cart: "cart-filled",
  deals: "tag-filled",
  orders: "order-filled",
  profile: "navigation-profile-filled",
} as const;

export type ShopNavigationIconName = keyof typeof names;

export function ShopNavigationIcon({
  name,
  fill = "currentColor",
  size = 24,
}: {
  name: ShopNavigationIconName;
  fill?: string;
  size?: number;
}) {
  return (
    <SvgXml
      xml={vectors[names[name]]}
      width={size}
      height={size}
      color={fill}
    />
  );
}

const icons = Object.fromEntries(
  Object.keys(names).map((key) => {
    const name = key as ShopNavigationIconName;
    const Icon: BloomIconComponent = ({ width, fill }) => (
      <ShopNavigationIcon name={name} size={width} fill={fill} />
    );
    return [name, Icon];
  }),
) as Record<ShopNavigationIconName, BloomIconComponent>;

export function shopNavigationIcon(
  name: ShopNavigationIconName,
): BloomIconComponent {
  return icons[name];
}
