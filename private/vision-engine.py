#!/usr/bin/env python3
"""J.A.R.V.I.S camera sidecar (runs on the home machine).

Captures a frame from the webcam, downscales + JPEG-encodes it, and posts it to
the gateway's /vision so J.A.R.V.I.S can "see". Designed to run on demand
(one shot) or continuously (--interval). Uses OpenCV for capture.

Deps (on the home machine):
    pip install opencv-python-headless requests

Usage:
    python3 vision-engine.py --gateway http://127.0.0.1:8000 --secret YOUR_SECRET [--interval 30]
"""
import argparse
import base64
import json
import time
import urllib.request

import cv2


def parse_args():
    p = argparse.ArgumentParser(description="J.A.R.V.I.S camera sidecar")
    p.add_argument("--gateway", default="http://127.0.0.1:8000")
    p.add_argument("--secret", default="")
    p.add_argument("--camera", type=int, default=0, help="OpenCV camera index")
    p.add_argument("--interval", type=int, default=0, help="seconds between captures (0 = one shot)")
    p.add_argument("--width", type=int, default=640)
    return p.parse_args()


def pair(gateway: str, secret: str) -> str:
    body = json.dumps({"deviceName": "vision-engine", "deviceType": "laptop", "secret": secret}).encode()
    req = urllib.request.Request(f"{gateway}/pair", data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())["sessionKey"]


def post_frame(gateway: str, key: str, image_b64: str, prompt: str):
    body = json.dumps({"image": image_b64, "prompt": prompt}).encode()
    req = urllib.request.Request(
        f"{gateway}/vision",
        data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def capture(gateway: str, key: str, camera_index: int, width: int, prompt: str):
    cap = cv2.VideoCapture(camera_index)
    try:
        ok, frame = cap.read()
        if not ok:
            print("[vision] no frame from camera")
            return
        # Downscale to keep the payload small.
        h, w = frame.shape[:2]
        if w > width:
            scale = width / w
            frame = cv2.resize(frame, (width, int(h * scale)))
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if not ok:
            print("[vision] encode failed")
            return
        image_b64 = base64.b64encode(buf.tobytes()).decode()
        res = post_frame(gateway, key, image_b64, prompt)
        desc = (res.get("frame") or {}).get("description", "")
        print(f"[vision] posted {len(image_b64)//1024}KB; description: {desc}")
    finally:
        cap.release()


def main():
    args = parse_args()
    key = pair(args.gateway, args.secret)
    prompt = "Describe what is in this image."
    if args.interval > 0:
        print(f"[vision] capturing every {args.interval}s")
        while True:
            capture(args.gateway, key, args.camera, args.width, prompt)
            time.sleep(args.interval)
    else:
        capture(args.gateway, key, args.camera, args.width, prompt)


if __name__ == "__main__":
    main()
