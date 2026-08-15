#!/usr/bin/env bash
# Install WordPress, activate WooCommerce, set the store to EUR, and seed the
# catalogue the #69 runbook §4.2 requires.
#
# Run AFTER up.sh: WordPress is installed against the tunnel's public HTTPS
# origin, because `wp core install --url` fixes the origin every generated link
# and every REST `_links` entry is built from.
#
# Idempotent: an installed WordPress, an active WooCommerce and an
# already-seeded catalogue are all left alone. Every step fails loudly.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

fail() {
  echo "seed.sh: $*" >&2
  exit 1
}

[[ -n "$WP_PUBLIC_URL" ]] || fail 'no public URL recorded — run up.sh first'

WP_ADMIN_PASSWORD="$(grep -E '^WP_ADMIN_PASSWORD=' "$STACK_ENV" | cut -d= -f2-)"
[[ -n "$WP_ADMIN_PASSWORD" ]] || fail "WP_ADMIN_PASSWORD missing from $STACK_ENV"

# --- WordPress core --------------------------------------------------------
if wp_cli core is-installed >/dev/null 2>&1; then
  echo "==> WordPress is already installed"
  wp_cli option update home "$WP_PUBLIC_URL" >/dev/null
  wp_cli option update siteurl "$WP_PUBLIC_URL" >/dev/null
else
  echo "==> installing WordPress at ${WP_PUBLIC_URL}"
  wp_cli core install \
    --url="$WP_PUBLIC_URL" \
    --title='Mercaria WooCommerce E2E' \
    --admin_user="$WP_ADMIN_USER" \
    --admin_password="$WP_ADMIN_PASSWORD" \
    --admin_email="$WP_ADMIN_EMAIL" \
    --skip-email
fi

# --- permalinks ------------------------------------------------------------
# `/wp-json/…` only exists with pretty permalinks; with the default structure
# WordPress serves the REST API at `?rest_route=` only, and the connector builds
# `{site}/wp-json/wc/v3` — so this is load-bearing, not cosmetic.
echo "==> setting pretty permalinks"
wp_cli rewrite structure '/%postname%/' >/dev/null
# `wp rewrite flush --hard` writes NOTHING from a PHP-CLI container (it asks
# Apache for its module list and there is no Apache there), so the rules are
# written by WordPress's own generator instead — see php/write-htaccess.php.
wp_cli eval-file /mercaria-scripts/write-htaccess.php

# --- WooCommerce -----------------------------------------------------------
if wp_cli plugin is-active woocommerce >/dev/null 2>&1; then
  echo "==> WooCommerce is already active"
else
  echo "==> installing and activating WooCommerce from wordpress.org"
  wp_cli plugin install woocommerce --activate
fi

wp_cli option update woocommerce_currency "$WP_STORE_CURRENCY" >/dev/null
actual_currency="$(wp_cli option get woocommerce_currency | tr -d '\r')"
[[ "$actual_currency" == "$WP_STORE_CURRENCY" ]] ||
  fail "store currency is '${actual_currency}', expected '${WP_STORE_CURRENCY}'"
echo "==> store currency is ${actual_currency}"

# Prove `/wp-json/…` is actually routed. WooCommerce answers a credential-less
# request to a protected route with 401, which is exactly the discriminator
# wanted here: a 404 means the permalink rewrite did not take and the connector
# — which builds `{site}/wp-json/wc/v3` — could never reach this site.
echo "==> checking the REST route is reachable at /wp-json"
rest_code="$("${CURL_DIRECT[@]}" -sS -o /dev/null -w '%{http_code}' --max-time 60 \
  "${WP_PUBLIC_URL}/wp-json/wc/v3/products?per_page=1")"
[[ "$rest_code" == '401' ]] || fail "$(
  printf '%s\n' \
    "GET /wp-json/wc/v3/products answered ${rest_code} without a key; expected 401." \
    "A 404 means pretty permalinks are not routing and /wp-json does not exist," \
    "which is the one thing the connector cannot work around."
)"
echo "    /wp-json routes (401 without a key, as expected)"

# --- the catalogue ---------------------------------------------------------
echo "==> seeding the catalogue (this creates ~124 products and ~116 variations)"
wp_cli eval-file /mercaria-scripts/seed-catalogue.php

echo
echo "site      : ${WP_PUBLIC_URL}"
echo "admin     : ${WP_PUBLIC_URL}/wp-admin  (user ${WP_ADMIN_USER}; password in ${STACK_ENV})"
echo "next      : ./issue-key.sh   then   ./verify.sh"
