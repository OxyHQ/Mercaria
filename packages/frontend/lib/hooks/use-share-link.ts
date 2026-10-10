import { useState } from 'react';
import { Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';

/** Share public routes without copying private query parameters from the page.
 * Desktop browsers without a share sheet copy the same explicit URL. */
export function useShareLink(title: string, path: string) {
  const [copiedPath, setCopiedPath] = useState<string>();
  const [failed, setFailed] = useState(false);
  const share = async () => {
    const origin =
      Platform.OS === 'web' && typeof window !== 'undefined'
        ? window.location.origin
        : 'https://mercaria.co';
    const url = new URL(path, origin).href;
    setFailed(false);
    try {
      if (Platform.OS === 'web') {
        if (typeof navigator.share === 'function') {
          await navigator.share({ title, url });
        } else {
          const copied = await Clipboard.setStringAsync(url);
          if (!copied) throw new Error('Clipboard unavailable');
          setCopiedPath(path);
        }
      } else {
        await Share.share(Platform.OS === 'ios' ? { title, url } : { title, message: url });
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) setFailed(true);
    }
  };
  return { share, copied: copiedPath === path, failed };
}
