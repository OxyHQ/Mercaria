import { type ReactElement } from 'react';
import { View, type ViewStyle } from 'react-native';
import { Image } from '@mercaria/ui';

export interface LogoProps {
  size?: number;
  style?: ViewStyle;
  className?: string;
}

/** Exact raster export of assets/wholesale.svg, copied from Website's Platform
 * menu (public/images/apps/wholesale.svg). Preserve its original brand colors. */
export function Logo({ size = 28, style, className }: LogoProps): ReactElement {
  return (
    <View style={[{ width: size, height: size }, style]} className={className}>
      <Image
        testID="wholesale-logo"
        source={require('../assets/icon-512.png')}
        style={{ width: size, height: size }}
        contentFit="contain"
      />
    </View>
  );
}
