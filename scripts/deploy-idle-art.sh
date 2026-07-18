#!/usr/bin/env bash
# Deploy idle album art + auto Now Playing changes to the Pi.
set -euo pipefail

PI="${PI_HOST:-pi@192.168.1.76}"
REMOTE="${PI_REMOTE_DIR:-/home/pi/berryaudio}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Deploying to ${PI}:${REMOTE}"

scp \
  "$ROOT/core/db.py" \
  "${PI}:${REMOTE}/core/db.py"

scp \
  "$ROOT/local/local.py" \
  "${PI}:${REMOTE}/local/local.py"

scp \
  "$ROOT/system/system.py" \
  "${PI}:${REMOTE}/system/system.py"

scp \
  "$ROOT/system/config.yaml" \
  "${PI}:${REMOTE}/system/config.yaml"

scp \
  "$ROOT/web/www/index.html" \
  "${PI}:${REMOTE}/web/www/index.html"

scp \
  "$ROOT/web/www/assets/idle-standby.js" \
  "$ROOT/web/www/assets/index.js" \
  "$ROOT/web/www/assets/index.css" \
  "${PI}:${REMOTE}/web/www/assets/"

ssh "$PI" 'sudo systemctl restart berryaudio.service && echo restarted'

echo "Done. Hard-reload Chromium on the kiosk (reboot or kill chromium so .xinitrc restarts it)."
echo "Quick checks:"
echo "  curl -sS -X POST http://192.168.1.76/rpc -H 'Content-Type: application/json' \\"
echo "    -d '{\"jsonrpc\":\"2.0\",\"method\":\"local.albums_with_art\",\"params\":{\"limit\":2},\"id\":1}'"
echo "  curl -sS -X POST http://192.168.1.76/rpc -H 'Content-Type: application/json' \\"
echo "    -d '{\"jsonrpc\":\"2.0\",\"method\":\"config.get\",\"id\":2}' | grep idle_album_art"
