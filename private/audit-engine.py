#!/usr/bin/env python3
"""J.A.R.V.I.S security-audit sidecar (runs on the home machine).

Scans YOUR OWN LAN for open ports / risky services and posts the findings to
the gateway's /audit so J.A.R.V.I.S can report your security posture and what
to close. Defensive + read-only: it only checks ports and labels known-risky
services; it does not attempt to exploit or access anything. You own this
network — never point this at systems you don't own.

Deps: python3 (stdlib only for the TCP connect scan).
Usage:
    python3 audit-engine.py --gateway http://127.0.0.1:8000 --secret YOUR_SECRET [--prefix 192.168.1] [--ports 23,21,445,...]
"""
import argparse
import json
import socket
import subprocess
import time
import urllib.request

# Default set: the ports a private LAN host is wise to keep closed or guarded.
DEFAULT_PORTS = [23, 21, 445, 5900, 3389, 80, 9100, 22, 8080, 11211, 6379, 27017]


def parse_args():
    p = argparse.ArgumentParser(description="J.A.R.V.I.S security audit (own LAN, read-only)")
    p.add_argument("--gateway", default="http://127.0.0.1:8000")
    p.add_argument("--secret", default="")
    p.add_argument("--prefix", default="", help="subnet prefix, e.g. 192.168.1 (default: auto)")
    p.add_argument("--ports", default="", help="comma list of ports (default: known-risky set)")
    p.add_argument("--timeout", type=float, default=0.3, help="connect timeout seconds")
    p.add_argument("--interval", type=int, default=86400, help="re-scan interval in seconds (default: daily)")
    p.add_argument("--once", action="store_true", help="scan once and exit")
    p.add_argument("--heartbeat", default="", help="heartbeat file to touch each loop (watchdog health)")
    return p.parse_args()


def local_subnet():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip.rsplit(".", 1)[0]
    except Exception:  # noqa: BLE001
        return "192.168.1"


def active_hosts(prefix: str):
    """Reuse the ARP/neighbour table to find live hosts on our own LAN."""
    hosts = []
    try:
        out = subprocess.run(["ip", "neigh"], capture_output=True, text=True, timeout=5).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 2 and "." in parts[0] and parts[0].startswith(prefix):
                hosts.append(parts[0])
    except FileNotFoundError:  # pragma: no cover
        pass
    # Always include our own machine.
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(("8.8.8.8", 80))
    hosts.append(s.getsockname()[0])
    s.close()
    return sorted(set(hosts))


def port_open(host: str, port: int, timeout: float) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        try:
            return sock.connect_ex((host, port)) == 0
        except OSError:
            return False


def main():
    args = parse_args()
    prefix = args.prefix or local_subnet()
    ports = [int(x) for x in args.ports.split(",") if x.strip()] or DEFAULT_PORTS

    # Pair with the gateway.
    body = json.dumps({"deviceName": "audit-engine", "deviceType": "laptop", "secret": args.secret}).encode()
    req = urllib.request.Request(f"{args.gateway}/pair", data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        key = json.loads(r.read())["sessionKey"]

    # Scheduled re-scan: run once, then loop every `interval` seconds so new
    # risky ports are caught without you remembering to re-run the scan.
    while True:
        run_scan(args, key, prefix, ports)
        if args.once:
            break
        print(f"[audit] sleeping {args.interval}s until next scan...")
        time.sleep(args.interval)


def touch(file):
    if file:
        try:
            with open(file, "w") as fh:
                fh.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        except OSError:
            pass


def run_scan(args, key, prefix, ports):
    touch(args.heartbeat)
    hosts = active_hosts(prefix)
    print(f"[audit] scanning {len(hosts)} hosts on {prefix}.0/24 for {len(ports)} ports (read-only)")
    findings = []
    for host in hosts:
        for port in ports:
            if port_open(host, port, args.timeout):
                findings.append({"host": host, "port": port})
                print(f"[audit] {host}:{port} open")

    payload = json.dumps({"scannedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "findings": findings}).encode()
    req = urllib.request.Request(
        f"{args.gateway}/audit",
        data=payload,
        headers={"content-type": "application/json", "authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        rep = json.loads(r.read())["report"]
        print(f"[audit] reported: {rep['summary']} (score {rep['score']}/100)")


if __name__ == "__main__":
    main()
