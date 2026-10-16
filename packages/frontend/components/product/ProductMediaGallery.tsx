import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useEvent } from 'expo';
import { createVideoPlayer, type VideoPlayer } from 'expo-video';
import { Button } from '@oxy.so/bloom/button';
import { useImageResolver } from '@oxy.so/bloom/image-resolver';
import type { GalleryMedia } from '@oxy.so/bloom/zoomable-media-gallery';
import {
  ProductGallery,
  Text,
  useSharedUiTranslation,
  type ProductGalleryHandle,
} from '@mercaria/ui';
import type { ListingMedia } from '@mercaria/shared-types';

type Session = { id: string; fileId: string; attempt: number; player: VideoPlayer; uri: string };

/** The app owns Expo players; Bloom owns their surfaces and viewer transitions.
 * Inactive web surfaces stay detached. A variant change retains common sessions;
 * page changes, backgrounding and closing the viewer pause them. No supplier
 * URL or MP4 is passed to an image renderer. */
export function ProductMediaGallery({
  media,
  title,
  className,
  ref,
}: {
  media: readonly ListingMedia[];
  title: string;
  className?: string;
  ref?: Ref<ProductGalleryHandle>;
}) {
  const resolveImage = useImageResolver();
  const sources = useMemo(
    () =>
      media.flatMap((item) => {
        const uri = resolveImage?.(item.fileId);
        return uri ? [{ ...item, uri }] : [];
      }),
    [media, resolveImage],
  );
  const sessions = useRef(new Map<string, Session>());
  const retired = useRef<VideoPlayer[]>([]);
  const [players, setPlayers] = useState<ReadonlyMap<string, Session>>(new Map());
  const [activeId, setActiveId] = useState<string>();
  const [focused, setFocused] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const videos = useMemo(() => sources.filter((item) => item.kind === 'video'), [sources]);
  useEffect(() => {
    const wanted = new Map(videos.map((item) => [item.fileId, item.uri]));
    let changed = false;
    for (const [id, session] of sessions.current) {
      if (wanted.get(id) !== session.uri) {
        changed = true;
        retired.current.push(session.player);
        sessions.current.delete(id);
      }
    }
    for (const [id, uri] of wanted) {
      if (!sessions.current.has(id)) {
        changed = true;
        const player = createVideoPlayer(uri);
        player.muted = true;
        sessions.current.set(id, { id: `${id}:0`, fileId: id, attempt: 0, player, uri });
      }
    }
    if (changed) setPlayers(new Map(sessions.current));
  }, [videos]);
  useEffect(() => {
    // The view has committed its new player before the previous native resource
    // is released. Failed retries are explicit new sessions, never autoplay.
    for (const player of retired.current.splice(0)) player.release();
  }, [players]);
  useEffect(
    () => () => {
      for (const player of retired.current.splice(0)) player.release();
      for (const session of sessions.current.values()) session.player.release();
      sessions.current.clear();
    },
    [],
  );
  useEffect(() => {
    const appStateListener = AppState.addEventListener('change', (state) =>
      setAppActive(state === 'active'),
    );
    return () => appStateListener.remove();
  }, []);
  const items = useMemo(
    () =>
      sources.flatMap((item): GalleryMedia[] => {
        if (item.kind === 'image') return [{ uri: item.uri, alt: item.alt }];
        const session = players.get(item.fileId);
        return session?.uri === item.uri
          ? [
              {
                kind: 'video',
                id: session.id,
                player: session.player,
                alt: item.alt,
                shareUrl: item.uri,
              },
            ]
          : [];
      }),
    [sources, players],
  );
  const select = useCallback(
    (index: number) => {
      const item = items[index];
      setActiveId(item?.kind === 'video' ? item.id : undefined);
    },
    [items],
  );
  const pauseAll = useCallback(() => {
    for (const session of sessions.current.values()) session.player.pause();
  }, []);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => {
        setFocused(false);
        pauseAll();
      };
    }, [pauseAll]),
  );
  useEffect(() => {
    for (const session of players.values()) {
      if (session.id !== activeId || !focused || !appActive) session.player.pause();
    }
  }, [activeId, focused, appActive, players]);
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) pauseAll();
    },
    [pauseAll],
  );
  const retry = useCallback((id: string) => {
    const previous = sessions.current.get(id);
    if (!previous) return;
    const player = createVideoPlayer(previous.uri);
    player.muted = true;
    retired.current.push(previous.player);
    sessions.current.set(id, {
      id: `${id}:${previous.attempt + 1}`,
      fileId: id,
      attempt: previous.attempt + 1,
      player,
      uri: previous.uri,
    });
    setPlayers(new Map(sessions.current));
  }, []);
  const byMediaId = useMemo(
    () => new Map([...players.values()].map((session) => [session.id, session])),
    [players],
  );
  return (
    <>
      <ProductGallery
        ref={ref}
        media={items}
        title={title}
        className={className}
        loading={videos.some((item) => players.get(item.fileId)?.uri !== item.uri)}
        onIndexChange={select}
        onOpenChange={onOpenChange}
        renderVideoStatus={(item) => {
          const session = byMediaId.get(item.id);
          return session ? (
            <VideoStatus key={session.id} session={session} retry={() => retry(session.fileId)} />
          ) : null;
        }}
      />
    </>
  );
}

function VideoStatus({ session, retry }: { session: Session; retry: () => void }) {
  const { player } = session;
  const t = useSharedUiTranslation();
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  if (status !== 'error') return null;
  return (
    <View
      style={StyleSheet.absoluteFill}
      className="items-center justify-center gap-space-8 bg-background"
    >
      <Text accessibilityRole="alert" className="text-shop-bodySmall text-text-tertiary">
        {t('ui.reviewMedia.unavailable')}
      </Text>
      <Button material="flat" onPress={retry}>
        {t('ui.reviewMedia.retry')}
      </Button>
    </View>
  );
}
