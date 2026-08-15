#!/usr/bin/env bash
# Seed the plugin-push fixture: 8 products in their own SKU and barcode
# namespace, so a push scenario measures the ingest rather than a unique index.
#
# Mercaria's `product_variants_sku_key` and `product_variants_barcode_key` are
# UNIQUE with NO store scope (#296), so the pull connection already owns every
# `MERC-E2E-*` SKU in that database and pushing the main catalogue fails every
# product — in a different store, which makes no difference.
#
# SIDE EFFECT, stated because it is not obvious: these products are PUBLISHED,
# so any live pull connection will import them on its next sync AND its
# `product.created` webhook fires once per product. Tell whoever owns that
# connection before running this.
#
# Idempotent: a second run reports the existing fixture and creates nothing.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

fail() {
  echo "seed-push-fixture.sh: $*" >&2
  exit 1
}

[[ -n "$WP_PUBLIC_URL" ]] || fail 'no public URL recorded — run up.sh first'
[[ -f "$TOKEN_FILE" ]] || fail "no credential at $TOKEN_FILE — run issue-key.sh first"

wp_cli core is-installed >/dev/null 2>&1 || fail 'WordPress is not installed — run seed.sh first'

echo "==> seeding the push fixture (MERCPUSH- SKUs, 029-prefix EAN-13 barcodes)"
wp_cli eval-file /mercaria-scripts/seed-push-fixture.php

# --- verify over REST, which is what a consumer actually reads --------------
CK="$(jq -r '.consumerKey' "$TOKEN_FILE")"
CS="$(jq -r '.consumerSecret' "$TOKEN_FILE")"
REST="${WP_PUBLIC_URL}/wp-json/wc/v3"

echo
echo "==> verifying over REST"
fixture="$("${CURL_DIRECT[@]}" -sS --max-time 60 -u "${CK}:${CS}" \
  "${REST}/products?per_page=100&search=Mercaria%20Push&_fields=id,name,sku,type,status,global_unique_id,images")"

count="$(printf '%s' "$fixture" | jq '[.[] | select(.sku | startswith("MERCPUSH-"))] | length')"
with_gtin="$(printf '%s' "$fixture" | jq '[.[] | select(.sku | startswith("MERCPUSH-")) | select(.global_unique_id != "" and .global_unique_id != null)] | length')"
variable="$(printf '%s' "$fixture" | jq -r '[.[] | select(.sku | startswith("MERCPUSH-")) | select(.type == "variable")] | length')"
no_images="$(printf '%s' "$fixture" | jq '[.[] | select(.sku | startswith("MERCPUSH-")) | select((.images | length) == 0)] | length')"
many_images="$(printf '%s' "$fixture" | jq '[.[] | select(.sku | startswith("MERCPUSH-")) | select((.images | length) > 1)] | length')"

printf '  products in namespace : %s\n' "$count"
printf '  carrying a GTIN       : %s\n' "$with_gtin"
printf '  variable products     : %s\n' "$variable"
printf '  with NO images        : %s\n' "$no_images"
printf '  with SEVERAL images   : %s\n' "$many_images"

short=()
((count >= 6 && count <= 10)) || short+=("products in namespace is ${count}; the request is 6-10")
((with_gtin == count)) || short+=("only ${with_gtin} of ${count} carry a GTIN — the barcode path would be untested")
((variable >= 1)) || short+=('no variable product — the variant path would not run')
((no_images >= 1)) || short+=('no product without images')
((many_images >= 1)) || short+=('no product with several images')
if ((${#short[@]} > 0)); then
  printf 'seed-push-fixture.sh: the fixture is SHORT:\n' >&2
  printf '  - %s\n' "${short[@]}" >&2
  exit 1
fi

# The whole point is namespace disjointness — assert it rather than assume it.
overlap="$("${CURL_DIRECT[@]}" -sS --max-time 60 -u "${CK}:${CS}" \
  "${REST}/products?per_page=100&_fields=sku" \
  | jq '[.[].sku | select(startswith("MERCPUSH-") and startswith("MERC-E2E-"))] | length')"
((overlap == 0)) || fail "a SKU is in both namespaces — disjointness is the entire point"

echo
echo "OK — the push fixture is present, disjoint, and every product carries a barcode."
echo "   Any live PULL connection will import these on its next sync."
