#!/bin/sh
set -e

MODE="${CONVEX_URL_MODE:-${DEPLOYMENT_MODE:-convex}}"
URL=""

if [ -n "$CONVEX_URL" ]; then
  URL="$CONVEX_URL"
else
  case "$MODE" in
    selfhosted)
      URL="$CONVEX_SELF_HOSTED_URL"
      ;;
    convex|cloud|"")
      URL="$CONVEX_DEPLOYMENT_URL"
      ;;
    *)
      echo "Unknown CONVEX_URL_MODE: $MODE" >&2
      URL=""
      ;;
  esac
fi

DEPLOYMENT_MODE="${DEPLOYMENT_MODE:-$MODE}"
ORGANIZATION_NAME="${ORGANIZATION_NAME:-Presence Tracker}"
SITE_URL="${FRONTEND_CONVEX_SITE_URL:-${CONVEX_SITE_URL:-}}"
if [ -z "$SITE_URL" ] && [ -n "$URL" ]; then
  SITE_URL="$(printf "%s" "$URL" | sed -e 's#\.convex\.cloud#\.convex\.site#' -e 's#/api/query##' -e 's#/api/mutation##')"
fi
AUTH_URL="${FRONTEND_CONVEX_AUTH_URL:-${CONVEX_AUTH_URL:-}}"
if [ -z "$AUTH_URL" ] && [ -n "$URL" ]; then
  AUTH_URL="$(printf "%s" "$URL" | sed -e 's#/api/query##' -e 's#/api/mutation##')"
fi
if [ -z "$AUTH_URL" ]; then
  AUTH_URL="$SITE_URL"
fi

mkdir -p /usr/share/nginx/html/pwa

{
  echo "window.CONVEX_URL = '$URL';"
  echo "window.CONVEX_SITE_URL = '$SITE_URL';"
  echo "window.CONVEX_AUTH_URL = '$AUTH_URL';"
  echo "window.DEPLOYMENT_MODE = '$DEPLOYMENT_MODE';"
  echo "window.ORGANIZATION_NAME = '$ORGANIZATION_NAME';"
} > /usr/share/nginx/html/config.js

cp /usr/share/nginx/html/config.js /usr/share/nginx/html/pwa/config.js
