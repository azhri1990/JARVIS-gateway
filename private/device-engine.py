#!/usr/bin/env python3
"""J.A.R.V.I.S home-automation sidecar (runs on the home machine).

Watches the gateway's device registry for power changes and applies them to
real smart devices. By default it prints the resolved command (for a plug script
or log); to control real hardware, wire `apply_state` to your device API — e.g.
Tasmota (http://<ip>/cm?cmnd=Power ON), Home Assistant REST, or an MQTT publish.

The gateway owns state and runs its own fail-closed on/off bookkeeping; this
sidecar is the "hands" that touch the devices. Deps: requests.

Usage:
    python3 device-engine.py --gateway http://127.0.0.1:8000 --secret YOUR_SECRET
"""
import argparse
import json
import time
import urllib.request


def parse_args():
    p = argparse.ArgumentParser(description="J.A.R.V.I.S device sidecar")
    p.add_argument("--gateway", default="http://127.0.0.1:8000")
    p.add_argument("--secret", default="")
    p.add_argument("--poll", type=int, default=5, help="seconds between polls")
    return p.parse_args()


def pair(gateway: str, secret: str) -> str:
    body = json.dumps({"deviceName": "device-engine", "deviceType": "laptop", "secret": secret}).encode()
    req = urllib.request.Request(f"{gateway}/pair", data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())["sessionKey"]


def get_devices(gateway: str, key: str):
    req = urllib.request.Request(f"{gateway}/devices", headers={"authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())["devices"]


def apply_state(device_id: str, name: str, on: bool):
    """Resolve and run the real device command. Replace with your hardware API."""
    state = "ON" if on else "OFF"
    print(f"[device] {name} ({device_id}) -> {state}")
    # Example (Tasmota): urllib.request.urlopen(f"http://{ip}/cm?cmnd=Power%20{state}")


def main():
    args = parse_args()
    key = pair(args.gateway, args.secret)
    print(f"[device] polling {args.gateway} every {args.poll}s")
    last = {}  # device id -> last applied on/off
    while True:
        try:
            for d in get_devices(args.gateway, key):
                if last.get(d["id"]) != d["on"]:
                    apply_state(d["id"], d["name"], d["on"])
                    last[d["id"]] = d["on"]
        except Exception as e:  # noqa: BLE001
            print(f"[device] poll failed: {e}")
        time.sleep(args.poll)


if __name__ == "__main__":
    main()
