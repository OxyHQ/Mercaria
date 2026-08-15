#!/usr/bin/env bash
# Mint a Read/Write WooCommerce REST key and write it to the tokens directory.
#
# The plaintext key and secret pass through exactly one pipe and land in
# $TOKEN_FILE at mode 600. They are never echoed, never written into the repo,
# and never put in a log — only the last four characters of the key are printed,
# so this script's output is safe to paste into a report.
#
# Re-runnable: an existing token file that still authenticates against the
# CURRENT site URL is kept. Otherwise the previous key is revoked (a consumer
# key is stored hashed and can never be recovered) and a fresh one is minted.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

fail() {
  echo "issue-key.sh: $*" >&2
  exit 1
}

[[ -n "$WP_PUBLIC_URL" ]] || fail 'no public URL recorded — run up.sh first'
command -v jq >/dev/null || fail 'jq is not on PATH'

FORCE="${1:-}"

authenticates() {
  local file="$1" key secret url code
  url="$(jq -r '.siteUrl' "$file")"
  key="$(jq -r '.consumerKey' "$file")"
  secret="$(jq -r '.consumerSecret' "$file")"
  [[ "$url" == "$WP_PUBLIC_URL" ]] || return 1
  code="$("${CURL_DIRECT[@]}" -fsS -o /dev/null -w '%{http_code}' --max-time 30 \
    -u "${key}:${secret}" "${url}/wp-json/wc/v3/system_status" 2>/dev/null || true)"
  [[ "$code" == '200' ]]
}

if [[ "$FORCE" != '--force' ]] && [[ -f "$TOKEN_FILE" ]] && authenticates "$TOKEN_FILE"; then
  echo "==> the recorded key still authenticates against ${WP_PUBLIC_URL}; keeping it"
else
  echo "==> minting a Read/Write REST key"
  mkdir -p "$(dirname "$TOKEN_FILE")"
  chmod 700 "$(dirname "$TOKEN_FILE")" 2>/dev/null || true

  tmp="$(mktemp)"
  chmod 600 "$tmp"
  # `wp eval-file` writes exactly one JSON line to stdout; WP_CLI::log/error go
  # to stderr, so a failure cannot be mistaken for a credential.
  if ! wp_cli eval-file /mercaria-scripts/issue-api-key.php 'Mercaria e2e (#69)' >"$tmp"; then
    rm -f "$tmp"
    fail 'the key could not be minted (see the WP-CLI error above)'
  fi
  jq -e '.consumerKey and .consumerSecret and (.permissions == "read_write")' "$tmp" >/dev/null ||
    { rm -f "$tmp"; fail 'the minted key did not come back read_write'; }

  # Overwrite siteUrl with the URL we actually reached, so a stale WordPress
  # option can never put a wrong origin into the credential file.
  jq --arg url "$WP_PUBLIC_URL" '.siteUrl = $url | .issuedAt = (now | todate)' "$tmp" >"${tmp}.out"
  install -m 600 "${tmp}.out" "$TOKEN_FILE"
  rm -f "$tmp" "${tmp}.out"

  authenticates "$TOKEN_FILE" || fail 'the freshly minted key does NOT authenticate — refusing to report success'
fi

key_tail="$(jq -r '.consumerKey' "$TOKEN_FILE" | tail -c 5)"
perms="$(jq -r '.permissions' "$TOKEN_FILE")"
echo
echo "credential file : ${TOKEN_FILE}  (mode $(stat -c '%a' "$TOKEN_FILE"))"
echo "consumer key    : …${key_tail}"
echo "permissions     : ${perms}"
echo "site            : $(jq -r '.siteUrl' "$TOKEN_FILE")"
