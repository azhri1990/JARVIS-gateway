# J.A.R.V.I.S — Deployment Checklist

Bring the entire private Iron Man system up on your hardware in one sitting.

**Goal:** one brain on the home machine, every device (laptop, Pi, phone, tablet) a hands-free client to it, all kept alive by the watchdog, all owner-gated by the consent gate.

## Prerequisites

- A **Tailscale** mesh already up across home machine, laptop, and Pi (the gateway pairs over it via `SHARED_SECRET`).
- **Node 22** on the home machine (the gateway was built against Node 22 — do **not** use Node 20).
- **Ollama** (local LLM) and **Faster-Whisper** (speech-to-text) installed on the home machine.

---

## Part 1 — Home machine (the brain)

### 1.1 Place the gateway

```bash
mkdir -p ~/jarvis
# copy this zip's jarvis-gateway/ contents here:
#   src/  private/  package.json  tsconfig.json
cd ~/jarvis
npm install
npx tsc          # compiles to dist/
```

### 1.2 Start the brain (Ollama + Whisper + gateway)

```bash
cd ~/jarvis
JARVIS_STATE_DIR=$HOME/jarvis/state \
JARVIS_UPSTREAM=git@github.com:azhri1990/jarvis-gateway.git \
JARVIS_REPO=$HOME/jarvis \
SHARED_SECRET='YOUR_SHARED_SECRET' \
WHISPER_URL=http://127.0.0.1:8080 \
  node dist/server.js
```

The gateway is the **one brain** — every device connects to it. Set `JARVIS_STATE_DIR` to a real directory (not `/tmp`) so learning and audit history survive reboots.

### 1.3 Keep it alive (watchdog + systemd)

```bash
sudo cp private/systemd/jarvis-watchdog.service /etc/systemd/system/
# edit CHANGE-ME lines: User, WorkingDirectory, ExecStart path
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-watchdog
systemctl status jarvis-watchdog      # should be active
journalctl -u jarvis-watchdog -f      # watch it work
```

### 1.4 Start the home sidecars

The watchdog's managed-services list (`src/watchdog-config.ts`) already includes the **audit loop, wake, vision, and device** engines:

```bash
# optional: faster security catch-up (every 6h)
AUDIT_INTERVAL_S=21600 WATCHDOG_STATE_DIR=$HOME/jarvis node dist/watchdog-config.js
```

---

## Part 2 — Every other device (hands-free J.A.R.V.I.S)

### 2.1 Laptop and Raspberry Pi — always-listening wake

On **each** laptop/Pi on the mesh, run the install script from `private/`:

```bash
sudo bash install-wake-device.sh <device-name> <kind> http://<brain-ip>:8000 YOUR_SHARED_SECRET
# e.g. laptop:   sudo bash install-wake-device.sh my-laptop laptop   http://100.101.102.103:8000 SECRET
#      pi:       sudo bash install-wake-device.sh kitchen-pi pi      http://100.101.102.103:8000 SECRET
```

This installs the wake engine, **registers the device** with the brain's mesh registry, sets a heartbeat cron, and starts the always-listening loop.

### 2.2 Phone and tablet — the mobile app

Run the Expo app (`projects/f8e698b1-0edd-431e-a57d-da517c7dd457`):

```bash
npx expo start
# scan the Expo Go QR from your phone/tablet
```

The Home screen now has the **Hands-Free** card (wake orb, speak-back, transcribe via the brain) and the **MESH · CONNECTED DEVICES** card. Point the app's gateway setting at the brain's Tailscale IP + port.

---

## Part 3 — Verify it's all up

Open the mesh view — you should see **every** machine listed as **online** and **always-listening**.

Smoke-test the whole loop once:

```bash
# from any device, against the brain:
curl -X POST http://<brain-ip>:8000/devices/heartbeat \
  -H "authorization: Bearer YOUR_SHARED_SECRET" \
  -H "content-type: application/json" -d '{"id":"my-laptop"}'
```

Then say **"J.A.R.V.I.S"** to the laptop. It should acknowledge ("Yes, sir?"), hear your command, route it to the brain, and speak the reply back.

---

## Security reminders

- Every consequential action (device power, execute, app action) still goes through the **consent gate** — approve from any device.
- `JARVIS_STATE_DIR` holds the brain's durable memory — back it up like any personal data.
- Keep `SHARED_SECRET` private; it's what lets devices pair on the mesh.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Gateway won't start | Use **Node 22**, not Node 20 |
| Mesh shows a device as **stale** | Its wake engine isn't running — rerun `install-wake-device.sh` |
| `J.A.R.V.I.S` not answered | Check the device's mic + that the wake engine process is alive |
| No STT / "whisper offline" | Ensure Faster-Whisper is up and `WHISPER_URL` is correct |
| Audit not running | Confirm the watchdog + audit-loop service are active |

**Done — J.A.R.V.I.S is live across your whole estate.**
