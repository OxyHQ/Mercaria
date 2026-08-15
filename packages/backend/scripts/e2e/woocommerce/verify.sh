#!/usr/bin/env bash
# Prove the site is reachable the way the connector will reach it, and that the
# catalogue is actually the size §4.2 asks for.
#
# Every number below is MEASURED over real HTTPS with the real credential. The
# failure this guards against is a seed that ran without error and created three
# products: a short catalogue exits non-zero and says which requirement it missed.
#
# Prints no credential — only the last four characters of the consumer key.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

fail() {
  echo "verify.sh: $*" >&2
  exit 1
}

[[ -n "$WP_PUBLIC_URL" ]] || fail 'no public URL recorded — run up.sh first'
[[ -f "$TOKEN_FILE" ]] || fail "no credential at $TOKEN_FILE — run issue-key.sh first"
command -v jq >/dev/null || fail 'jq is not on PATH'

SITE="$(jq -r '.siteUrl' "$TOKEN_FILE")"
CK="$(jq -r '.consumerKey' "$TOKEN_FILE")"
CS="$(jq -r '.consumerSecret' "$TOKEN_FILE")"
REST="${SITE}/wp-json/wc/v3"
HOST="$(printf '%s' "$SITE" | sed -E 's#^https?://##; s#/.*$##')"

[[ "$SITE" == https://* ]] || fail "the recorded site URL is not https: ${SITE}"
[[ "$SITE" == "$WP_PUBLIC_URL" ]] || fail "the credential names ${SITE} but the live tunnel is ${WP_PUBLIC_URL}"

echo "=== 1. DNS: the host must resolve to a PUBLIC address ==============="
# safeFetch resolves the host and refuses private, loopback, link-local and
# metadata addresses, so a tunnel that resolved to anything private would be
# rejected before a single request left the process.
addresses="$(getent ahosts "$HOST" | awk '{print $1}' | sort -u)"
[[ -n "$addresses" ]] || fail "the host ${HOST} does not resolve"
private_found=''
while read -r ip; do
  [[ -z "$ip" ]] && continue
  case "$ip" in
    10.*|127.*|169.254.*|192.168.*|0.*|::1|fe80:*|fc*|fd*) private_found="$private_found $ip" ;;
    172.*)
      second="$(printf '%s' "$ip" | cut -d. -f2)"
      if ((second >= 16 && second <= 31)); then private_found="$private_found $ip"; fi
      ;;
  esac
  echo "    ${HOST} -> ${ip}"
done <<<"$addresses"
[[ -z "$private_found" ]] || fail "resolves to a PRIVATE address:${private_found} — safeFetch would refuse it"
echo "    all addresses are public — safeFetch's denylist does not apply"

echo
echo "=== 2. the products endpoint, with the Read/Write key =============="
headers_file="$(mktemp)"
trap 'rm -f "$headers_file"' EXIT
code="$("${CURL_DIRECT[@]}" -sS -o /dev/null -D "$headers_file" -w '%{http_code}' --max-time 60 \
  -u "${CK}:${CS}" "${REST}/products?per_page=1")"
[[ "$code" == '200' ]] || {
  echo "--- response headers ---" >&2
  cat "$headers_file" >&2
  fail "GET ${REST}/products?per_page=1 answered ${code}, expected 200"
}
echo "    GET /wp-json/wc/v3/products?per_page=1 -> 200"

total_products="$(grep -i '^x-wp-total:' "$headers_file" | tr -d '\r' | awk '{print $2}' | head -1 || true)"
total_pages="$(grep -i '^x-wp-totalpages:' "$headers_file" | tr -d '\r' | awk '{print $2}' | head -1 || true)"
if [[ -n "$total_pages" ]]; then
  echo "    X-WP-TotalPages: PRESENT (${total_pages} at per_page=1)"
  TOTALPAGES_PRESENT='yes'
else
  # Scenario W9's premise. Mercaria pages on until an EMPTY page rather than
  # trusting the header, so its absence is survivable — but it must be RECORDED,
  # not assumed either way.
  echo "    X-WP-TotalPages: ABSENT — this host strips it (runbook W9 applies)"
  TOTALPAGES_PRESENT='no'
fi
[[ -n "$total_products" ]] || fail 'X-WP-Total is absent; the product count cannot be measured over REST'

echo
echo "=== 3. catalogue counts, measured over REST ========================"
# The variations endpoint is what scenario W8 turns on, so the largest variation
# set is measured by ASKING that endpoint rather than by trusting the parent's
# declared id list.
variable_ids="$("${CURL_DIRECT[@]}" -sS --max-time 120 -u "${CK}:${CS}" \
  "${REST}/products?type=variable&per_page=100&_fields=id,name" | jq -r '.[].id')"
[[ -n "$variable_ids" ]] || fail 'no variable products found over REST'

max_variations=0
max_variations_id=''
variable_count=0
while read -r pid; do
  [[ -z "$pid" ]] && continue
  ((variable_count += 1))
  vheaders="$(mktemp)"
  "${CURL_DIRECT[@]}" -sS -o /dev/null -D "$vheaders" --max-time 60 -u "${CK}:${CS}" \
    "${REST}/products/${pid}/variations?per_page=1" >/dev/null
  n="$(grep -i '^x-wp-total:' "$vheaders" | tr -d '\r' | awk '{print $2}' | head -1 || true)"
  rm -f "$vheaders"
  n="${n:-0}"
  echo "    product ${pid}: ${n} variations"
  if ((n > max_variations)); then
    max_variations="$n"
    max_variations_id="$pid"
  fi
done <<<"$variable_ids"

order_headers="$(mktemp)"
"${CURL_DIRECT[@]}" -sS -o /dev/null -D "$order_headers" --max-time 60 -u "${CK}:${CS}" \
  "${REST}/orders?per_page=1&status=any" >/dev/null
total_orders="$(grep -i '^x-wp-total:' "$order_headers" | tr -d '\r' | awk '{print $2}' | head -1 || true)"
rm -f "$order_headers"
total_orders="${total_orders:-0}"

currency="$("${CURL_DIRECT[@]}" -sS --max-time 60 -u "${CK}:${CS}" "${REST}/data/currencies/current" | jq -r '.code')"

echo
echo "=== 4. versions ===================================================="
wp_version="$(wp_cli core version | tr -d '\r')"
wc_version="$(wp_cli plugin get woocommerce --field=version | tr -d '\r')"
php_version="$(wp_cli eval 'echo PHP_VERSION;' | tr -d '\r')"
db_version="$(compose exec -T db mariadb --version 2>/dev/null | tr -d '\r' || echo 'unavailable')"

echo
echo "=================== MEASURED ======================================="
printf 'site URL                : %s\n' "$SITE"
printf 'REST base               : %s\n' "$REST"
printf 'consumer key            : …%s (%s)\n' "$(printf '%s' "$CK" | tail -c 4)" "$(jq -r '.permissions' "$TOKEN_FILE")"
printf 'products (X-WP-Total)   : %s\n' "$total_products"
printf 'variable products       : %s\n' "$variable_count"
printf 'max variations on one   : %s (product %s)\n' "$max_variations" "$max_variations_id"
printf 'orders                  : %s\n' "$total_orders"
printf 'store currency          : %s\n' "$currency"
printf 'X-WP-TotalPages present : %s\n' "$TOTALPAGES_PRESENT"
printf 'WordPress               : %s\n' "$wp_version"
printf 'WooCommerce             : %s\n' "$wc_version"
printf 'PHP                     : %s\n' "$php_version"
printf 'WC REST API version     : wc/v3\n'
printf 'database                : %s\n' "$db_version"
echo "===================================================================="

echo
short=()
((total_products > 100)) || short+=("products is ${total_products}; §4.2 needs more than 100")
((max_variations > 100)) || short+=("largest variation set is ${max_variations}; scenario W8 needs more than 100")
((variable_count >= 2)) || short+=("only ${variable_count} variable products")
((total_orders >= 2)) || short+=("only ${total_orders} orders; §4.2 needs at least 2")
[[ "$currency" == "$WP_STORE_CURRENCY" ]] || short+=("store currency is ${currency}, expected ${WP_STORE_CURRENCY}")
if ((${#short[@]} > 0)); then
  printf 'verify.sh: the site is SHORT of the runbook requirements:\n' >&2
  printf '  - %s\n' "${short[@]}" >&2
  exit 1
fi
echo "OK — the site satisfies every §4.2 requirement that can be measured over REST."
