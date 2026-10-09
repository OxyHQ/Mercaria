import Svg, { Path } from "react-native-svg";

/** Public SVG paths supplied with the Shop shelf reference. */
export function ShopDetailIcon({
  name,
  size = 20,
  color = "currentColor",
  filled = false,
}: {
  name: "chevron" | "thread" | "heart";
  size?: number;
  color?: string;
  filled?: boolean;
}) {
  const path =
    name === "chevron"
      ? "M10 16L14 12L10 8"
      : name === "thread"
        ? "M15 10H9M12 14H9M3 20H16C18.7614 20 21 17.7614 21 15V9C21 6.23858 18.7614 4 16 4H8C5.23858 4 3 6.23858 3 9V20Z"
        : "M10.797 4.303 12 5.537l1.203-1.234a5.35 5.35 0 0 1 7.613-.09l.089.09c2.097 2.15 2.126 5.619.087 7.806l-.087.092L12 21.333l-8.905-9.132c-2.127-2.181-2.127-5.717 0-7.898a5.35 5.35 0 0 1 7.702 0Z";
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? color : "none"}
    >
      <Path
        d={path}
        stroke={color}
        strokeWidth={name === "thread" ? 2 : 2.67}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
