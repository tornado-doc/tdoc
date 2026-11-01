#!/usr/bin/env bash
# The preview Worker uses one shared landing slug. Another PR may have left it
# in Trash after an earlier seed; recover only that known state.
set -euo pipefail

base="${1:?preview base URL required}"
payload="${2:?landing payload path required}"
: "${TDOC_PREVIEW_UPLOAD_TOKEN:?preview upload token required}"
response="${TDOC_PREVIEW_LANDING_RESPONSE:-/tmp/tdoc-preview-landing-resp.json}"

for attempt in 1 2 3; do
  status="$(curl -sS --connect-timeout 10 --max-time 90 -X POST "$base/api/upload" \
    -H "Authorization: Bearer $TDOC_PREVIEW_UPLOAD_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary "@$payload" -o "$response" -w '%{http_code}')"
  if [ "$status" = 200 ] && jq -e '.ok == true' "$response" >/dev/null; then
    echo 'seeded landing'
    exit 0
  fi
  if [ "$status" != 409 ] || ! jq -e '.error == "doc_in_trash" and .slug == "tornado-doc"' "$response" >/dev/null; then
    cat "$response" >&2
    echo "could not publish preview landing (HTTP $status)" >&2
    exit 1
  fi

  echo "preview landing in Trash; restoring before publish (attempt $attempt)" >&2
  status="$(curl -sS --connect-timeout 10 --max-time 60 -X POST "$base/api/trash/restore" \
    -H "Authorization: Bearer $TDOC_PREVIEW_UPLOAD_TOKEN" \
    -H 'Content-Type: application/json' \
    --data '{"slug":"tornado-doc"}' -o "$response" -w '%{http_code}')"
  # A concurrent preview may have purged it after our upload; retry then too.
  if { [ "$status" = 200 ] && jq -e '.ok == true and (.restored | index("tornado-doc")) != null' "$response" >/dev/null; } \
    || { [ "$status" = 404 ] && jq -e '.error == "not_in_trash"' "$response" >/dev/null; }; then
    sleep "$attempt"
    continue
  fi
  cat "$response" >&2
  echo "could not restore preview landing (HTTP $status)" >&2
  exit 1
done

echo 'preview landing remained in Trash after three restore-and-publish attempts' >&2
exit 1
