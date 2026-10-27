#!/bin/sh
# First-party staging-only webroot setup. No downloads, builds or migrations.
set -eu
test "${WEBSITE_SITE_NAME:-}" = stellar-desktop-vpn-staging
test "${APP_ENV:-}" = staging
test "${STELLAR_API_MODE:-}" = fixture
test -f /home/site/wwwroot/public/index.php
test -f /home/site/wwwroot/vendor/autoload.php
mkdir -p /home/site/wwwroot/bootstrap/cache /home/site/wwwroot/storage/framework/views /home/site/wwwroot/storage/framework/cache/data
cp /home/site/wwwroot/deploy/azure/nginx.conf /etc/nginx/sites-available/default
nginx -t
service nginx reload
