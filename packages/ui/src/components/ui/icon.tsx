import { cn } from '../../lib/cn';
import type { LucideIcon, LucideProps } from 'lucide-react-native';
import { styled } from 'nativewind';

type IconProps = LucideProps & {
  as: LucideIcon;
};

function IconImpl({ as: IconComponent, color, fill, ...props }: IconProps) {
  // Lucide consumes `color` as its stroke, rather than forwarding it to Svg.
  // Resolve a currentColor fill too so filled glyphs follow the same token.
  return (
    <IconComponent
      {...props}
      color={color}
      fill={fill === 'currentColor' && color !== undefined ? color : fill}
    />
  );
}

// SVG strokes are props on native, not inherited Text styles. NativeWind's
// public mapping resolves the CSS token and passes it to Lucide's color prop.
const StyledIcon = styled(IconImpl, {
  className: { target: 'style', nativeStyleMapping: { color: 'color' } },
});

/**
 * A wrapper component for Lucide icons with Nativewind `className` support via `styled`.
 *
 * This component allows you to render any Lucide icon while applying utility classes
 * using `nativewind`. It avoids the need to wrap or configure each icon individually.
 *
 * @component
 * @example
 * ```tsx
 * import { ArrowRight } from 'lucide-react-native';
 * import { Icon } from '@mercaria/ui';
 *
 * <Icon as={ArrowRight} className="text-red-500" size={16} />
 * ```
 *
 * @param {LucideIcon} as - The Lucide icon component to render.
 * @param {string} className - Utility classes to style the icon using Nativewind.
 * @param {number} size - Icon size (defaults to 14).
 * @param {...LucideProps} ...props - Additional Lucide icon props passed to the "as" icon.
 */
function Icon({ as: IconComponent, className, size = 14, ...props }: IconProps) {
  return (
    <StyledIcon
      as={IconComponent}
      className={cn(props.color === undefined && 'text-foreground', className)}
      size={size}
      {...props}
    />
  );
}

export { Icon };
