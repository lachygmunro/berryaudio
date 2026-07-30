#!/bin/bash
# Apply QDTECH Chromium kiosk + helper packages on a BerryAudio Pi image.
# Run on the Pi as user pi:
#   cd ~/berryaudio && bash scripts/pi-kiosk-setup.sh
set -euo pipefail

echo "==> Installing kiosk packages"
sudo apt-get update
sudo apt-get install -y chromium xinput xdotool unclutter

echo "==> Allow startx from non-console sessions (optional, helps SSH recovery)"
echo "allowed_users=anybody" | sudo tee /etc/X11/Xwrapper.config >/dev/null

echo "==> Hide cursor when starting X"
PROFILE="$HOME/.bash_profile"
if [[ -f "$PROFILE" ]]; then
  if grep -q 'startx -- -nocursor' "$PROFILE"; then
    echo "    .bash_profile already uses startx -- -nocursor"
  elif grep -q 'startx' "$PROFILE"; then
    sed -i 's/startx$/startx -- -nocursor/' "$PROFILE"
    echo "    Updated .bash_profile to use startx -- -nocursor"
  else
    echo '[[ -z $DISPLAY && $XDG_VTNR -eq 1 ]] && startx -- -nocursor' >> "$PROFILE"
    echo "    Appended startx -- -nocursor to .bash_profile"
  fi
else
  echo '[[ -z $DISPLAY && $XDG_VTNR -eq 1 ]] && startx -- -nocursor' > "$PROFILE"
  echo "    Created .bash_profile with startx -- -nocursor"
fi

echo "==> Stopping competing UIs (Electron AppImage + extra Chromium)"
pkill -f 'berryaudio-.*\.AppImage' 2>/dev/null || true
pkill -f 'ba-frontend' 2>/dev/null || true
# Leave a single clean Chromium restart to reboot / startx

echo "==> Writing ~/.xinitrc for HDMI-1 QDTECH panel"
sudo chattr -i "$HOME/.xinitrc" 2>/dev/null || true
cat > "$HOME/.xinitrc" << 'EOF'
#!/bin/sh
xset s off
xset -dpms
xset s noblank
unclutter -idle 0 -root &

xrandr --output HDMI-2 --off || true
xrandr --output HDMI-1 --primary --mode 1024x600 --pos 0x0 || xrandr --output HDMI-1 --primary --auto

TID=$(xinput list | sed -n 's/.*QDTECH.*id=\([0-9]\+\).*/\1/p')
[ -n "$TID" ] && xinput map-to-output "$TID" HDMI-1

# Never let stock Electron race Chromium for the display
pkill -f 'berryaudio-.*\.AppImage' >/dev/null 2>&1 || true

exec chromium \
  --kiosk \
  --app=http://127.0.0.1/ \
  --touch-events=enabled \
  --force-device-scale-factor=1 \
  --window-position=0,0 \
  --window-size=1024,600 \
  --no-first-run \
  --noerrdialogs \
  --disable-infobars \
  > /tmp/chromium.log 2>&1
EOF
chmod +x "$HOME/.xinitrc"
sudo chattr +i "$HOME/.xinitrc"

echo "==> Current UI processes (expect only chromium after reboot):"
ps aux | egrep 'chromium|AppImage|electron' | grep -v egrep || true
echo
echo "==> Done"
echo "Reboot with: sudo reboot"
echo "If BerryAudio overwrites display settings, pick:"
echo "  Settings → Display → Generic HDMI Display / QDTECH HDMI-1 (1024x600)"
echo "Then re-run this script (or unlock .xinitrc) if needed."
