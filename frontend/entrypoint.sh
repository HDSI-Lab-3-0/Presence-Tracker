#!/bin/sh
# Inject CONVEX_DEPLOYMENT_URL into config.js
echo "window.CONVEX_URL = '$CONVEX_DEPLOYMENT_URL';" > /usr/share/nginx/html/config.js
