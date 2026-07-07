import { type PropsWithChildren } from "react";

/**
 * Root HTML component for static rendering.
 * Don't wrap the app with Providers here — that belongs in `_layout.tsx`.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />

        <meta httpEquiv="Content-Security-Policy" content="upgrade-insecure-requests" />
        <meta name="referrer" content="origin-when-cross-origin" />

        <meta name="title" content="Mercaria Dashboard" />
        <meta
          name="description"
          content="Mercaria Dashboard — manage your store: products, orders, inventory, customers, discounts and reports."
        />

        <meta name="theme-color" content="#040711" />
        <meta name="msapplication-TileColor" content="#040711" />

        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
        <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png" />
        <link rel="shortcut icon" href="/icon-192.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/icon-192.png" />
        <meta name="apple-mobile-web-app-title" content="Mercaria Dashboard" />

        {/* NOTE: Expo Router's <ScrollViewStyleReset /> is intentionally OMITTED
            so the document scrolls (the `global.css` html/body/#root rules and
            the natural document scroll handle it). */}
      </head>
      <body>{children}</body>
    </html>
  );
}
