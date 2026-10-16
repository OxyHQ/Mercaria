import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { useSettingsDialog } from '@mercaria/ui';
import type { StorefrontSettingsPage } from './settings-routes';

/**
 * The web address of a settings page. Settings content belongs to the dialog;
 * this route opens it and steps back off itself, so an old link or a bookmark
 * still lands on the right page. On native a settings link never reaches this
 * screen — `app/+native-intent.tsx` intercepts it.
 */
export function createSettingsRoute(page?: StorefrontSettingsPage) {
  return function SettingsRoute() {
    const { open } = useSettingsDialog();
    const router = useRouter();
    const handled = useRef(false);
    useEffect(() => {
      if (handled.current) return;
      handled.current = true;
      open(page);
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }, [open, router]);
    return null;
  };
}
