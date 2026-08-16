/**
 * useNotificationSetup — Push notification registration, foreground handling,
 * and real-time Socket.IO notification subscription. It deliberately does NOT
 * deep-link from a payload; see the note beside the web-push registration.
 *
 * Call once in the authenticated app layout.
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { io as socketIO } from 'socket.io-client';
import config from '@/lib/config';
import apiClient from '@/lib/api/client';

// ── Constants ──────────────────────────────────────────────────────
const PROJECT_ID = Constants.expoConfig?.extra?.eas?.projectId;

export function useNotificationSetup() {
  const { user, oxyServices, isAuthenticated } = useOxy();
  const queryClient = useQueryClient();
  // Re-establish the notification socket when the access token changes so the
  // handshake always carries a valid token.
  const accessToken = oxyServices.getAccessToken();
  const tokenRef = useRef<string | null>(null);
  const webPushRegisteredRef = useRef(false);

  // ── Foreground notification display (once, native only) ────────
  useEffect(() => {
    if (Platform.OS === 'web') return;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });
  }, []);

  // ── Push token registration ────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated || !user?.id || Platform.OS === 'web') return;

    let cancelled = false;

    (async () => {
      try {
        // Android: create notification channel
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('default', {
            name: 'Default',
            importance: Notifications.AndroidImportance.HIGH,
          });
        }

        // Check / request permission
        const { status: existing } = await Notifications.getPermissionsAsync();
        let finalStatus = existing;
        if (existing !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }
        if (finalStatus !== 'granted' || cancelled) return;

        // A configured EAS projectId is required to mint an Expo push token.
        // Until the app is registered with EAS, skip native push registration.
        if (!PROJECT_ID) return;

        // Get Expo push token
        const { data: token } = await Notifications.getExpoPushTokenAsync({
          projectId: PROJECT_ID,
        });
        if (cancelled || !token || token === tokenRef.current) return;

        tokenRef.current = token;

        // Register with backend
        await apiClient.post('/notifications/push-token', {
          token,
          platform: Platform.OS,
        });
      } catch {
        // Non-critical — expected to fail in dev without FCM credentials
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.id]);

  // A tapped push notification opens the app and NOTHING ELSE navigates from
  // its payload.
  //
  // This used to read a `route` string out of the payload and hand it straight
  // to `router.push`, cast past the type (#330). Nothing in Mercaria has ever
  // put one there — `NotificationDTO` carries no `route` and no writer sets one
  // in the push `data` — so the branch had no producer, and the only thing that
  // could exercise it was a payload composed somewhere else. That matters
  // because `Href` admits `ExternalPathString`, so an arbitrary string is not
  // merely a wrong screen: on web it is a navigation off the site entirely.
  //
  // It is also the rule this codebase already settled for its newest
  // notification domain. #79 price alerts: the notification carries no URL of
  // any kind — the product, variant and offer IDS travel and the client decides
  // where they lead. A destination composed elsewhere and followed here is a
  // now-unvalidated link by the time it is tapped.
  //
  // Deep-linking arrives with the producer that needs it: a typed `RoutePath`
  // on the payload contract plus an allow-list of the destinations a
  // notification may open, decided against the real ones rather than invented
  // for a feature nobody has built.

  // ── Web push registration (browser only) ──────────────────────
  useEffect(() => {
    if (Platform.OS !== 'web' || !isAuthenticated || !user?.id) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (webPushRegisteredRef.current) return;

    let cancelled = false;

    (async () => {
      try {
        // Fetch VAPID public key from backend
        const { data: vapidData } = await apiClient.get('/notifications/vapid-public-key');
        if (cancelled || !vapidData?.publicKey) return;

        // Register service worker
        const registration = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;

        // Check for existing subscription
        let subscription = await registration.pushManager.getSubscription();

        if (!subscription) {
          // Request permission
          const permission = await Notification.requestPermission();
          if (cancelled || permission !== 'granted') return;

          // Convert VAPID key from base64url to Uint8Array
          const vapidKey = urlBase64ToUint8Array(vapidData.publicKey);

          // Subscribe
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: vapidKey,
          });
        }

        if (cancelled || !subscription) return;

        // Send subscription to backend
        const subJson = subscription.toJSON();
        await apiClient.post('/notifications/web-push-subscription', {
          endpoint: subJson.endpoint,
          keys: subJson.keys,
        });

        if (!cancelled) webPushRegisteredRef.current = true;
      } catch {
        // Non-critical — web push not available in all browsers/contexts
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.id]);

  // ── Socket.IO real-time notification subscription ──────────────
  useEffect(() => {
    if (!isAuthenticated || !accessToken) return;

    const socket = socketIO(config.apiUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      // Callback form so each (re)connect reads a FRESH token; the server
      // verifies it (io.use(authSocket())) and auto-joins the user's room.
      auth: (cb) => cb({ token: oxyServices.getAccessToken() ?? '' }),
    });

    socket.on('notification', () => {
      // Invalidate React Query caches so notification list + unread count refresh
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    });

    return () => {
      socket.disconnect();
    };
  }, [isAuthenticated, accessToken, oxyServices, queryClient]);
}

// ── Helpers ──────────────────────────────────────────────────────

/** Convert a base64url-encoded VAPID key to a Uint8Array for PushManager.subscribe */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; ++i) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}
