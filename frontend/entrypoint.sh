#!/bin/sh
# Inject selected Convex URL into config.js
set -e

MODE="${CONVEX_URL_MODE:-convex}"
URL=""

case "$MODE" in
  selfhosted)
    URL="$CONVEX_SELF_HOSTED_URL"
    ;;
  convex|cloud)
    URL="$CONVEX_DEPLOYMENT_URL"
    ;;
  *)
    echo "Unknown CONVEX_URL_MODE: $MODE (expected selfhosted or convex)" >&2
    exit 1
    ;;
esac

if [ -z "$URL" ]; then
  echo "Selected Convex URL is empty. Check CONVEX_URL_MODE and related env vars." >&2
  exit 1
fi

echo "window.CONVEX_URL = '$URL';" > /usr/share/nginx/html/config.js
