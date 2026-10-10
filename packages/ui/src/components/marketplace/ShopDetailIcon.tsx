import Svg, { Path, Rect } from 'react-native-svg';
import { styled } from 'nativewind';

const StyledSvg = styled(Svg, {
  className: { target: 'style', nativeStyleMapping: { color: 'color' } },
});

const PATHS = {
  about:
    'M11 11H12V16M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z',
  cross: 'M6 6L18 18M18 6L6 18',
  chevron: 'M10 16L14 12L10 8',
  thread:
    'M15 10H9M12 14H9M3 20H16C18.7614 20 21 17.7614 21 15V9C21 6.23858 18.7614 4 16 4H8C5.23858 4 3 6.23858 3 9V20Z',
  heart:
    'M10.797 4.303 12 5.537l1.203-1.234a5.35 5.35 0 0 1 7.613-.09l.089.09c2.097 2.15 2.126 5.619.087 7.806l-.087.092L12 21.333l-8.905-9.132c-2.127-2.181-2.127-5.717 0-7.898a5.35 5.35 0 0 1 7.702 0Z',
  share:
    'M20 12.75V16C20 18.2091 18.2091 20 16 20H8C5.79086 20 4 18.2091 4 16V12.75M12 4V15.25M12 4L16.5 8.5M12 4L7.5 8.5',
} as const;

/** Public SVG paths from Shop's shelves and product Save/Share buttons. */
export function ShopDetailIcon({
  name,
  size = 20,
  color,
  className,
  filled = false,
}: {
  name: keyof typeof PATHS;
  size?: number;
  color?: string;
  className?: string;
  filled?: boolean;
}) {
  return (
    <StyledSvg
      className={className}
      color={color}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? (color ?? 'currentColor') : 'none'}
    >
      <Path
        d={PATHS[name]}
        stroke={color ?? 'currentColor'}
        strokeWidth={name === 'thread' || name === 'share' || name === 'about' ? 2 : 2.67}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {name === 'about' ? (
        <Rect
          x={11.25}
          y={7.25}
          width={1.5}
          height={1.5}
          rx={0.75}
          fill={color ?? 'currentColor'}
          stroke={color ?? 'currentColor'}
          strokeWidth={0.5}
        />
      ) : null}
    </StyledSvg>
  );
}
