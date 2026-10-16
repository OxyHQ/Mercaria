import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Button } from '@oxy.so/bloom/button';
import { useImageResolver } from '@oxy.so/bloom/image-resolver';
import {
  ReviewMediaStrip,
  ReviewMediaViewer,
  Text,
  resolveCatalogImage,
  useSharedUiTranslation,
} from '@mercaria/ui';
import type { ReviewMedia } from '@mercaria/shared-types';
import { useInfiniteReviewMedia, useReviewHelpfulness } from '@/lib/hooks/use-reviews';
import { reviewMediaEntries, reviewMediaIndex } from '@/lib/reviews/media-gallery';
import { ReviewHelpfulButton } from '@/components/reviews/ReviewHelpfulButton';
import { ReviewActionsMenu } from '@/components/reports/ReviewActionsMenu';

/** A target change gets its own selection lifetime. Text searches use a
 * different query and cannot replace the viewer's review or media pages. */
export function ProductReviewMedia(props: {
  scope: 'product' | 'p2p_listing';
  id: string;
  scopeLabel: string;
}) {
  return <TargetReviewMedia key={`${props.scope}:${props.id}`} {...props} />;
}

function TargetReviewMedia({
  scope,
  id,
  scopeLabel,
}: {
  scope: 'product' | 'p2p_listing';
  id: string;
  scopeLabel: string;
}) {
  const query = useInfiniteReviewMedia(scope, id);
  const items = reviewMediaEntries(query.data?.pages.flatMap((page) => page.data) ?? []);
  const [selectedId, setSelectedId] = useState<string>();
  const index = selectedId ? reviewMediaIndex(items, selectedId) : -1;
  const helpfulness = useReviewHelpfulness(
    selectedId && items[index] ? [items[index].review.id] : [],
  );
  const uiT = useSharedUiTranslation();
  const { isFetching, fetchNextPage, hasNextPage, isFetchNextPageError } = query;
  const loadMore = () => {
    if (!isFetching) void fetchNextPage({ cancelRefetch: false });
  };
  useEffect(() => {
    if (
      index >= 0 &&
      index >= items.length - 2 &&
      hasNextPage &&
      !isFetching &&
      !isFetchNextPageError
    ) {
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [index, items.length, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);
  // Keep the strip absent for products without buyer attachments. A failed
  // read remains retryable; it must not look like a successful empty gallery.
  if (!items.length && !query.isError) return null;
  return (
    <View className="gap-space-8">
      <ReviewMediaStrip items={items} onSelect={setSelectedId} />
      {query.isError && !query.isFetchNextPageError ? (
        <Button material="flat" onPress={() => void query.refetch()}>
          {uiT('ui.reviewMedia.retry')}
        </Button>
      ) : null}
      {selectedId ? (
        <ReviewMediaViewer
          items={items}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onClose={() => setSelectedId(undefined)}
          scopeLabel={scopeLabel}
          hasMore={query.hasNextPage}
          loadingMore={query.isFetchingNextPage}
          loadError={query.isFetchNextPageError}
          onLoadMore={loadMore}
          renderVideo={(media, active) => <ReviewVideo media={media} active={active} />}
          renderReviewActions={(review) => (
            <View className="flex-row items-center gap-space-20">
              <ReviewHelpfulButton
                review={review}
                vote={helpfulness.data?.find((vote) => vote.reviewId === review.id)}
              />
              <ReviewActionsMenu review={review} />
            </View>
          )}
        />
      ) : null}
    </View>
  );
}

/** Only the selected clip owns a player. Closing/paging disposes it, so an
 * offscreen video cannot keep playing or prefetch the entire review history. */
function ReviewVideo({ media, active }: { media: ReviewMedia; active: boolean }) {
  const resolveImage = useImageResolver();
  const uri = resolveCatalogImage(media.fileId, undefined, resolveImage);
  return active && uri ? <ActiveReviewVideo key={media.id} uri={uri} /> : null;
}

function ActiveReviewVideo({ uri }: { uri: string }) {
  const [attempt, setAttempt] = useState(0);
  const uiT = useSharedUiTranslation();
  return (
    <VideoPlayback
      key={attempt}
      uri={uri}
      retry={() => setAttempt((value) => value + 1)}
      label={uiT('ui.reviewMedia.title')}
    />
  );
}
function VideoPlayback({ uri, retry, label }: { uri: string; retry: () => void; label: string }) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.muted = true;
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const uiT = useSharedUiTranslation();
  return (
    <View style={StyleSheet.absoluteFill}>
      {status === 'error' ? (
        <View className="flex-1 items-center justify-center gap-space-8">
          <Text accessibilityRole="alert" className="text-shop-bodySmall text-text-tertiary">
            {uiT('ui.reviewMedia.unavailable')}
          </Text>
          <Button material="flat" onPress={retry}>
            {uiT('ui.reviewMedia.retry')}
          </Button>
        </View>
      ) : (
        <VideoView
          player={player}
          nativeControls
          contentFit="contain"
          accessibilityLabel={label}
          style={StyleSheet.absoluteFill}
          surfaceType="textureView"
          fullscreenOptions={{ enable: true }}
        />
      )}
    </View>
  );
}
