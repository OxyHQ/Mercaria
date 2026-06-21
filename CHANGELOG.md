# Changelog

All notable changes to Mercaria are documented here.

## [Unreleased]

### Added

- Initial scaffold of the Mercaria base, derived from the Oxy Expo + Express
  monorepo shell: Express bootstrap, Socket.IO, MongoDB/Redis/logger libs,
  `@oxyhq/core/server` auth middleware, health/auth/feedback/notifications
  routes, and push/web-push notification infrastructure.
- Frontend shell: OxyProvider + BloomThemeProvider provider tree, SSO callback
  bootstrap, TanStack Query setup, NativeWind 5 + Tailwind v4 theming, sidebar
  shell, settings, i18n (en/es), and a placeholder home screen.

The marketplace domain (listings, buy/sell, shops) is intentionally not yet
implemented — see `HANDOFF.md`.
