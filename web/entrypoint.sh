#!/bin/sh
# The web image's entrypoint: checks APP_URL, then runs Caddy (the CMD).
#
# APP_URL (optional, e.g. https://map.868.no) is the site's own address. Set,
# a request for any other host is redirected there, path and query kept
# (web/Caddyfile, D-211). It must be an origin: a scheme and a host, an
# optional port, nothing after it but an optional trailing slash, which is
# dropped here. A malformed value stops the container instead of sending
# visitors somewhere broken.
set -eu
url="${APP_URL:-}"
if [ -n "$url" ]; then
	url="${url%/}"
	case "$url" in
	http://*|https://*) host="${url#*://}" ;;
	*) host="" ;;
	esac
	case "$host" in
	""|*/*|*\?*|*#*|*@*|*" "*)
		echo "web: APP_URL must be an origin such as https://map.example.org, not \"${APP_URL}\"" >&2
		exit 1
		;;
	esac
	APP_HOST="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
	APP_URL="${url%%://*}://${APP_HOST}"
	export APP_URL APP_HOST
	echo "web: redirecting hosts other than ${APP_HOST} to ${APP_URL}" >&2
else
	unset APP_URL APP_HOST 2>/dev/null || true
fi
exec "$@"
