#!/usr/bin/env bash
# install-wake-device.sh — deploy the always-listening J.A.R.V.I.S wake engine
# to a laptop or Raspberry Pi so it listens continuously, like the home box.
#
# This installs wake-engine.py, registers the device with the brain's mesh
# registry (/devices/register), heartbeats every 30s (/devices/heartbeat),
# and starts the always-listening wake loop. The wake engine reports a wake to
# the brain via /wake/report; a follow-up command is transcribed via
# /voices/transcribe and run via /run.
#
# Usage:
#   sudo bash install-wake-device.sh <device-name> <kind> <brain-url> <secret>
#   e.g. sudo bash install-wake-device.sh living-room-laptop laptop \
#          http://100.101.102.103:8000 MY_SHARED_SECRET
#
# Requires: python3, pip, sounddevice, numpy. For real keyword accuracy install
# Picovoice Porcupine and swap the detect() in wake-engine.py.

set -euo pipefail

NAME="${1:?device-name required (e.g. kitchen-pi)}"
KIND="${2:?kind required (laptop|pi|home|phone|tablet)}"
BRAIN="${3:?brain-url required (http://<tailscale-ip>:8000)}"
SECRET="${4:?shared secret required}"
DIR="/opt/jarvis"

echo "[wake] installing to $DIR"
mkdir -p "$DIR/private"
cp -f private/wake-engine.py "$DIR/private/wake-engine.py" 2>/dev/null || true

echo "[wake] installing python deps (sounddevice, numpy)"
python3 -m pip install --quiet --upgrade sounddevice numpy 2>/dev/null || apt-get install -y python3-sounddevice python3-numpy

# Register the device with the brain's mesh registry.
echo "[wake] registering '$NAME' with brain at $BRAIN"
curl -sf -X POST "$BRAIN/devices/register" \
  -H "authorization: Bearer $SECRET" \
  -H "content-type: application/json" \
  -d "{\"id\":\"$NAME\",\"name\":\"$NAME\",\"kind\":\"$KIND\",\"wake\":true}" \
  && echo "  -> registered" || echo "  -> warning: could not reach brain"

# Write a small heartbeat cron so the mesh sees this device online.
cat > "$DIR/private/heartbeat.sh" <<EOF
#!/usr/bin/env bash
curl -sf -X POST "$BRAIN/devices/heartbeat" \\
  -H "authorization: Bearer $SECRET" \\
  -H "content-type: application/json" \\
  -d '{"id":"$NAME"}' >/dev/null 2>&1
EOF
chmod +x "$DIR/private/heartbeat.sh"
(crontab -l 2>/dev/null | grep -v "jarvis/heartbeat" ; echo "*/2 * * * * $DIR/private/heartbeat.sh") | crontab -

echo "[wake] starting always-listening wake engine (Ctrl-C to stop)"
echo "  python3 $DIR/private/wake-engine.py --gateway $BRAIN --secret <secret> --id $NAME"
# Start under the watchdog if present, else run in foreground.
if command -v systemctl >/dev/null 2>&1 && [ -f /etc/systemd/system/jarvis-watchdog.service ]; then
  echo "  -> watchdog present: add this device to the managed-services list, or run:"
  echo "     nohup python3 $DIR/private/wake-engine.py --gateway $BRAIN --secret $SECRET --id $NAME &"
else
  nohup python3 "$DIR/private/wake-engine.py" --gateway "$BRAIN" --secret "$SECRET" --id "$NAME" >/var/log/jarvis-wake.log 2>&1 &
  echo "  -> wake engine started (pid $!)"
fi

echo "[wake] done. '$NAME' is now an always-listening J.A.R.V.I.S device."
