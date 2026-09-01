#!/usr/bin/env python3
"""J.A.R.V.I.S LAN discovery sidecar (runs on the home machine).

Scans the local network and suggests device-registry entries for the gateway.
Two methods:
  * ARP/neighbour scan (fast, no deps) — lists every host on the LAN.
  * mDNS browse (optional, zeroconf) — finds smart devices that advertise
    services (Tasmota, Home Assistant, Chromecast, printers, etc.) and
    annotates each with a guess at type + control interface.

Output is printed as lines the gateway can ingest into /devices, or that you
can eyeball and paste into devices.ts. Nothing is ever controlled by this
script — discovery is read-only by design.
"""
import argparse
import socket
import subprocess

try:
    from zeroconf import Zeroconf, ServiceBrowser  # type: ignore
    HAS_MDNS = True
except ImportError:  # pragma: no cover
    HAS_MDNS = False


def local_subnet():
    """Return the /24 prefix of the primary interface, e.g. 192.168.1."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip.rsplit(".", 1)[0]
    except Exception:  # noqa: BLE001
        return "192.168.1"


def arp_scan(prefix: str):
    """Read the OS ARP/neighbour table for hosts and their MACs."""
    hosts = []
    try:
        out = subprocess.run(["ip", "neigh"], capture_output=True, text=True, timeout=5).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 3 and "." in parts[0] and parts[0].startswith(prefix):
                mac = parts[1] if len(parts) > 1 else "?"
                state = parts[-1] if len(parts) > 2 else "?"
                hosts.append({"ip": parts[0], "mac": mac, "state": state})
    except FileNotFoundError:  # fall back to ping sweep
        for i in range(1, 255):
            ip = f"{prefix}.{i}"
            subprocess.run(["ping", "-c", "1", "-W", "0.2", ip],
                           capture_output=True, timeout=1)
        out = subprocess.run(["arp", "-a"], capture_output=True, text=True, timeout=5).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 3:
                ip = parts[1].strip("()") if "(" in line else parts[0]
                mac = parts[3] if len(parts) > 3 else "?"
                if ip.startswith(prefix):
                    hosts.append({"ip": ip, "mac": mac, "state": "?"})
    return hosts


KNOWN_MAC_PREFIXES = {
    "dc:4f:22": "Raspberry Pi",
    "b8:27:eb": "Raspberry Pi",
    "e4:5f:01": "Raspberry Pi",
    "3c:52:82": "Raspberry Pi",
    "50:64:2b": "Home Assistant / Hub",
    "84:0d:8e": "Espressif (ESP smart device)",
    "24:0a:c4": "Espressif (ESP smart device)",
    "dc:4f:22": "Espressif (ESP smart device)",
}


def annotate(host):
    mac = host.get("mac", "").lower()
    vendor = next((v for k, v in KNOWN_MAC_PREFIXES.items() if mac.startswith(k)), None)
    host["type"] = vendor or "unknown"
    # Guess a control interface.
    if "Raspberry Pi" in host["type"]:
        host["interface"] = "ssh"
    elif "smart" in host["type"]:
        host["interface"] = "http (tasmota/ha)"
    else:
        host["interface"] = "unknown — probe or check device"
    return host


class MDNSListener:
    def __init__(self):
        self.services = []

    def add_service(self, zc, type_, name):
        info = zc.get_service_info(type_, name)
        if not info:
            return
        ip = socket.inet_ntoa(info.addresses[0]) if info.addresses else "?"
        self.services.append({"ip": ip, "service": type_, "name": name})


def mdns_scan():
    if not HAS_MDNS:
        return []
    zc = Zeroconf()
    listener = MDNSListener()
    types = ["_http._tcp.local.", "_hap._tcp.local.", "_googlecast._tcp.local.",
             "_printer._tcp.local.", "_tasmota._tcp.local."]
    browsers = [ServiceBrowser(zc, t, listener) for t in types]
    import time
    time.sleep(4)
    for b in browsers:
        b.cancel()
    zc.close()
    return listener.services


def main():
    p = argparse.ArgumentParser(description="J.A.R.V.I.S LAN discovery (read-only)")
    p.add_argument("--prefix", default=local_subnet(), help="subnet prefix, e.g. 192.168.1")
    p.add_argument("--mdns", action="store_true", help="also browse mDNS services (needs zeroconf)")
    args = p.parse_args()

    print(f"# LAN discovery on {args.prefix}.0/24 (read-only — nothing controlled)")
    hosts = [annotate(h) for h in arp_scan(args.prefix)]
    print(f"# {len(hosts)} hosts found")
    for h in sorted(hosts, key=lambda x: x["ip"]):
        print(f"{h['ip']:16} {h['mac']:18} {h['type']:24} {h['interface']}")

    if args.mdns:
        services = mdns_scan()
        print(f"# {len(services)} mDNS services advertised")
        for s in services:
            print(f"mDNS  {s['ip']:16} {s['service']:24} {s['name']}")

    print("\n# Suggested device-registry entries (paste into src/devices.ts):")
    for h in hosts[:20]:
        if h["interface"] != "unknown — probe or check device":
            safe_id = f"dev-{h['ip'].replace('.', '-')}"
            print(f'{{ id: "{safe_id}", name: "{h["ip"]}", type: "{h["type"]}", '
                  f'on: false, command: "device {safe_id} {{state}}" }},')


if __name__ == "__main__":
    main()
