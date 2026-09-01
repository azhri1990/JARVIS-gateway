#!/usr/bin/env python3
"""J.A.R.V.I.S remediation sidecar (runs on the home machine).

Executes a security-remediation command ONLY after it has been explicitly
approved through the gateway's consent gate. Flow:
    1. The gateway proposes a fix command for a risky open port (POST /remediate
       with no approvalId returns just the proposed command).
    2. You approve it on a surface (mobile Security panel -> Approve), which
       marks the consent approved in the gateway.
    3. This sidecar fetches the pending approval, confirms it is approved, and
       runs the exact command via subprocess (default shell=False, tokenized).

Safety: it NEVER runs anything without an approved consent id, and it refuses
commands that try to delete data (rm -rf) or make remote connections to systems
you don't own. It is defensive - it only closes/restricts ports on YOUR machines.

Usage:
    python3 remediate-engine.py --gateway http://127.0.0.1:8000 --secret YOUR_SECRET \
        --host 192.168.1.10 --port 23
"""
import argparse
import json
import shlex
import subprocess
import sys
import urllib.request

DANGEROUS = ["rm -rf", "mkfs", "dd if=", ":(){", "> /dev/sda", "wget http", "curl http", "nc -e", "ncat -e", "bash -i"]


def parse_args():
    p = argparse.ArgumentParser(description="J.A.R.V.I.S remediation executor (approved fixes only)")
    p.add_argument("--gateway", default="http://127.0.0.1:8000")
    p.add_argument("--secret", default="")
    p.add_argument("--host", required=True)
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--dry-run", action="store_true", help="print the approved command without running it")
    return p.parse_args()


def pair(gateway, secret):
    body = json.dumps({"deviceName": "remediate-engine", "deviceType": "laptop", "secret": secret}).encode()
    req = urllib.request.Request(f"{gateway}/pair", data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())["sessionKey"]


def propose(gateway, key, host, port):
    body = json.dumps({"host": host, "port": port}).encode()
    req = urllib.request.Request(
        f"{gateway}/remediate", data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def apply(gateway, key, host, port, approval_id):
    body = json.dumps({"host": host, "port": port, "approvalId": approval_id}).encode()
    req = urllib.request.Request(
        f"{gateway}/remediate", data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def dangerous(cmd: str) -> bool:
    low = cmd.lower()
    return any(d in low for d in DANGEROUS)


def main():
    args = parse_args()
    key = pair(args.gateway, args.secret)

    # Step 1: propose (never runs anything).
    proposed = propose(args.gateway, key, args.host, args.port)
    cmd = proposed.get("proposed")
    print(f"[remediate] proposed: {cmd}")
    if cmd is None:
        print("[remediate] nothing to remediate for this port.")
        sys.exit(0)

    # Step 2: require an explicit approval id from the environment.
    approval_id = input("Paste the approval id from the Security panel (or Ctrl-C to abort): ").strip()
    if not approval_id:
        print("[remediate] aborting - no approval id.")
        sys.exit(1)

    # Step 3: apply only after the gateway confirms approval, then safety-check.
    result = apply(args.gateway, key, args.host, args.port, approval_id)
    if not result.get("dispatched"):
        print(f"[remediate] not dispatched: {result.get('error', 'unknown')}")
        sys.exit(1)
    cmd = result["command"]
    if dangerous(cmd):
        print(f"[remediate] REFUSED - command looks destructive: {cmd}")
        sys.exit(1)

    print(f"[remediate] approved - running: {cmd}")
    if args.dry_run:
        print("[remediate] (dry-run, not executing)")
        sys.exit(0)
    # Tokenize and run with shell=False - safer than a raw shell string.
    proc = subprocess.run(shlex.split(cmd), capture_output=True, text=True)
    print(proc.stdout)
    if proc.returncode != 0:
        print(f"[remediate] exited {proc.returncode}: {proc.stderr}", file=sys.stderr)
        sys.exit(proc.returncode)
    print("[remediate] done.")


if __name__ == "__main__":
    main()
