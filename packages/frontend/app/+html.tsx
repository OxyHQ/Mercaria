import { type PropsWithChildren } from 'react';

/**
 * Root HTML component for static rendering
 * This file runs during static rendering in Node.js for SEO optimization
 * Don't wrap your app with Providers here - that should be in _layout.tsx
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    // This shell is rendered ONCE at export time, in Node, before anyone has
    // chosen a language — so `lang`/`dir` here are the pre-hydration default and
    // not the answer. `@mercaria/ui`'s `syncLayoutDirection`, driven from
    // `lib/i18n`'s store, rewrites both on the document as soon as the client
    // knows the locale. Stating `dir` explicitly rather than leaving it to the
    // browser is what makes that a correction rather than a surprise.
    <html lang="en" dir="ltr">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />

        {/* Viewport and mobile optimization */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />

        {/* Security and Performance */}
        <meta httpEquiv="Content-Security-Policy" content="upgrade-insecure-requests" />
        <meta name="referrer" content="origin-when-cross-origin" />
        <meta httpEquiv="Permissions-Policy" content="camera=(), microphone=(), geolocation=()" />

        {/* Primary Meta Tags */}
        <meta name="title" content="Mercaria" />
        <meta
          name="description"
          content="Mercaria by Oxy — buy and sell new and secondhand items from shops and people near you."
        />
        <meta
          name="keywords"
          content="marketplace, buy, sell, secondhand, shops, ecommerce, classifieds, Oxy"
        />

        {/* Open Graph / Facebook Meta Tags for social sharing */}
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://mercaria.co/" />
        <meta property="og:title" content="Mercaria" />
        <meta
          property="og:description"
          content="Mercaria by Oxy — buy and sell new and secondhand items from shops and people near you."
        />
        <meta property="og:image" content="/og-image.png" />

        {/* Twitter Card Meta Tags */}
        <meta property="twitter:card" content="summary_large_image" />
        <meta property="twitter:url" content="https://mercaria.co/" />
        <meta property="twitter:title" content="Mercaria" />
        <meta
          property="twitter:description"
          content="Mercaria by Oxy — buy and sell new and secondhand items from shops and people near you."
        />
        <meta property="twitter:image" content="/og-image.png" />

        {/* Theme color for mobile browsers */}
        <meta name="theme-color" content="#040711" />
        <meta name="msapplication-TileColor" content="#040711" />

        {/* PWA Manifest */}
        <link rel="manifest" href="/manifest.json" />

        {/* Favicons */}
        <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
        <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png" />
        <link rel="shortcut icon" href="/icon-192.png" />

        {/* Apple Touch Icons for iOS home screen */}
        <link rel="apple-touch-icon" sizes="180x180" href="/icon-192.png" />
        <link rel="apple-touch-icon" sizes="167x167" href="/icon-192.png" />
        <link rel="apple-touch-icon" sizes="152x152" href="/icon-192.png" />
        <link rel="apple-touch-icon" sizes="120x120" href="/icon-192.png" />

        {/* Apple Mobile Web App */}
        <meta name="apple-mobile-web-app-title" content="Mercaria" />

        {/* NOTE: Expo Router's <ScrollViewStyleReset /> is intentionally OMITTED.
            It locks `html, body { overflow: hidden; height: 100% }` for a
            native-like fixed viewport, which prevents document-level scrolling.
            Mercaria scrolls the DOCUMENT (Shop-style) so scrolling works from
            anywhere — over the sticky rail and gutter included. The natural
            document scroll + the `html, body, #root` rules in `global.css` are
            all that's needed; no runtime JS. */}

        {/* Preconnect to important domains for performance */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />

        {/* JSON-LD Structured Data for SEO */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'WebApplication',
              name: 'Mercaria',
              url: 'https://mercaria.co',
              description:
                'Mercaria by Oxy — buy and sell new and secondhand items from shops and people near you.',
              applicationCategory: 'ShoppingApplication',
              operatingSystem: 'Web, iOS, Android',
              offers: {
                '@type': 'Offer',
                price: '0',
                priceCurrency: 'USD',
              },
            }),
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
