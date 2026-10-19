import { type ComponentRef, forwardRef, useMemo, useRef, type ForwardedRef } from 'react';
import { ScrollView, type ScrollViewProps } from 'react-native';
import { mergeRefs } from '@oxy.so/bloom/hooks';
import { ViewportProvider, useViewportBinding } from '@oxy.so/bloom/viewport';

export interface ViewportScrollViewProps extends ScrollViewProps {
  /** A portaled dialog starts a viewport independent of its underlying page. */
  viewportRoot?: boolean;
}

function BoundScrollView({
  forwardedRef,
  onScroll,
  onLayout,
  onContentSizeChange,
  ...props
}: ScrollViewProps & {
  forwardedRef: ForwardedRef<ComponentRef<typeof ScrollView>>;
}) {
  const viewportRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const ref = useMemo(() => mergeRefs([viewportRef, forwardedRef]), [forwardedRef]);
  const viewport = useViewportBinding({ viewportRef, onScroll, onLayout, onContentSizeChange });
  return <ScrollView {...props} ref={ref} {...viewport} />;
}

/** Preserve the native scroller API while Bloom owns descendant visibility. */
export const ViewportScrollView = forwardRef<
  ComponentRef<typeof ScrollView>,
  ViewportScrollViewProps
>(function ViewportScrollView({ viewportRoot = false, ...props }, ref) {
  return (
    <ViewportProvider root={viewportRoot}>
      <BoundScrollView {...props} forwardedRef={ref} />
    </ViewportProvider>
  );
});
