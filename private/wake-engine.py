#!/usr/bin/env python3
"""J.A.R.V.I.S always-listening wake engine (runs on the home machine).

Continuously captures the microphone, detects the wake word, and reports it to
the gateway's /wake/report so J.A.R.V.I.S is always ready to hear you. Uses a
simple energy-based trigger + optional keyword detection; for real wake-word
accuracy install Picovoice Porcupine and swap `detect_wake` for its API.

Deps (on the home machine):
    pip install sounddevice numpy requests

Usage:
    python3 wake-engine.py --gateway http://127.0.0.1:8000 --secret YOUR_SECRET
"""
import argparse
import time
import urllib.request
import json

import numpy as np
import sounddevice as sd

RATE = 16000
BLOCK = 1600  # 100ms blocks
ENERGY_THRESHOLD = 0.02  # adjust for your mic / room


def parse_args():
    p = argparse.ArgumentParser(description="J.A.R.V.I.S always-listening wake engine")
    p.add_argument("--gateway", default="http://127.0.0.1:8000", help="gateway base URL")
    p.add_argument("--secret", default="", help="shared secret for pairing")
    p.add_argument("--wake-word", default="J.A.R.V.I.S", help="wake word (used in logs)")
    p.add_argument("--id", default="", help="device id for the mesh registry (registers + heartbeats)")
    return p.parse_args()


def pair(gateway: str, secret: str) -> str:
    body = json.dumps({"deviceName": "wake-engine", "deviceType": "laptop", "secret": secret}).encode()
    req = urllib.request.Request(f"{gateway}/pair", data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())["sessionKey"]


def report_wake(gateway: str, key: str, word: str):
    body = json.dumps({"word": word}).encode()
    req = urllib.request.Request(
        f"{gateway}/wake/report",
        data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def detect_wake(block: np.ndarray) -> bool:
    """Energy-based trigger placeholder. Swap for Picovoice Porcupine for real
    wake-word detection: porcupine.process(block.tobytes()) == keyword_index."""
    return float(np.mean(np.abs(block))) > ENERGY_THRESHOLD


def main():
    args = parse_args()
    key = pair(args.gateway, args.secret)
    mesh_register(args.gateway, args.secret, args.id)
    print(f"[wake] listening for '{args.wake_word}' on {args.gateway} (armed)")
    last_wake = 0.0
    cooldown = 5.0  # seconds between wake reports

    def callback(indata, _frames, _time, _status):
        nonlocal last_wake
        block = indata[:, 0]
        if detect_wake(block):
            now = time.time()
            if now - last_wake > cooldown:
                last_wake = now
                try:
                    report_wake(args.gateway, key, args.wake_word)
                    print(f"[wake] HEARD '{args.wake_word}' -> reported")
                except Exception as e:  # noqa: BLE001
                    print(f"[wake] report failed: {e}")

    with sd.InputStream(samplerate=RATE, channels=1, blocksize=BLOCK, callback=callback):
        print("[wake] streaming (Ctrl+C to stop)")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\n[wake] stopped")


if __name__ == "__main__":
    main()
