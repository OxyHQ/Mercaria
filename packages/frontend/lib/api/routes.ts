/**
 * Centralized API routes configuration.
 * All Marketplace API endpoints are defined here for easy maintenance.
 */

export const API_ROUTES = {
  // Notifications
  notifications: {
    list: "/notifications",
    pushToken: "/notifications/push-token",
    vapidPublicKey: "/notifications/vapid-public-key",
    webPushSubscription: "/notifications/web-push-subscription",
  },

  // Health check
  health: "/health",
} as const;
