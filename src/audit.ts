// Security-audit module for the J.A.R.V.I.S gateway.
//
// Defensive, read-only posture: audits YOUR OWN LAN and machines for obvious
// risks — open management ports, weak/default-service exposure, and services
// known to be risky. This is the "know and secure your own estate" capability,
// never a tool for touching systems you don't own. Scanning is performed by a
// home sidecar (audit-engine.py) that reports findings back here; this module
// stores the latest audit so the mobile/dashboard can show it.
import type { ServerResponse } from 'node:http'
import { AUDIT_FILE, load, save } from './store.js'

export type RiskLevel = 'low' | 'medium' | 'high'

export interface AuditFinding {
  host: string
  port: number
  service: string
  risk: RiskLevel
  note: string
  fix: string
}

// Exact remediation command for a host/port. Only known risky ports produce a
// real command; everything else gets a caution string. The gateway only ever
// PROPOSES this string - executing it requires explicit approval downstream.
export function remediationFor(host: string, port: number): string {
  const known = RISKY_PORTS[port]
  if (!known) return `No known remediation - confirm if ${port} must stay open.`
  return known.fix
}

export interface AuditReport {
  id: string
  scannedAt: string
  findings: AuditFinding[]
  score: number // 0 (hardened) .. 100 (very exposed)
  summary: string
  isNewRisk?: boolean // true when a risky port appeared that wasn't in the prior scan
  newHosts?: string[] // hosts with newly-appeared risky ports
}

const history: AuditReport[] = [] // most recent last

export function scanHistory(): AuditReport[] {
  return history.map((h) => ({ ...h, findings: [...h.findings] }))
}

let latest: AuditReport | undefined
let seq = 0
let loadedAudit = false

// Load persisted audit history on first use so it survives restarts.
async function ensureAuditLoaded(): Promise<void> {
  if (loadedAudit) return
  loadedAudit = true
  const data = await load<{ history: AuditReport[]; seq: number }>(AUDIT_FILE, { history: [], seq: 0 })
  history.push(...(data.history ?? []))
  seq = data.seq ?? 0
  latest = history.length ? history[history.length - 1] : undefined
}

// Ports a private LAN host is wise to keep closed or strongly guarded.
const RISKY_PORTS: Record<number, { service: string; note: string; fix: string }> = {
23: { service: 'telnet', note: 'Clear-text remote shell — disable; use SSH', fix: 'sudo systemctl disable --now telnet.socket' },
21: { service: 'ftp', note: 'Clear-text file transfer — use SFTP/SCP', fix: 'sudo systemctl disable --now vsftpd proftpd 2>/dev/null' },
445: { service: 'smb', note: 'SMB exposed on LAN — restrict to trusted hosts', fix: 'sudo ufw deny 445/tcp && sudo systemctl restart smbd' },
5900: { service: 'vnc', note: 'VNC without a VPN tunnel is risky', fix: 'sudo ufw deny 5900/tcp' },
3389: { service: 'rdp', note: 'RDP exposed — restrict by firewall + strong auth', fix: 'sudo ufw deny 3389/tcp && sudo systemctl disable --now xrdp' },
80: { service: 'http', note: 'Unencrypted HTTP — prefer HTTPS/TLS', fix: 'sudo ufw allow 443/tcp && sudo ufw deny 80/tcp' },
9100: { service: 'printer-raw', note: 'Raw printer port — close unless needed', fix: 'sudo ufw deny 9100/tcp' },
  22: { service: 'ssh', note: 'SSH open — ensure key auth only, no root/password login', fix: "grep -q 'PasswordAuthentication no' /etc/ssh/sshd_config || sudo sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && sudo systemctl reload ssh" },
8080: { service: 'http-alt', note: 'Alternate HTTP — confirm it is yours & protected', fix: 'sudo ufw deny 8080/tcp' },
11211: { service: 'memcached', note: 'Memcached open — close if not in use', fix: 'sudo systemctl disable --now memcached 2>/dev/null' },
6379: { service: 'redis', note: 'Redis open — must be password-protected and bound to localhost', fix: "sudo sed -i 's/^bind .*/bind 127.0.0.1 ::1/' /etc/redis/redis.conf && sudo systemctl restart redis" },
27017: { service: 'mongodb', note: 'MongoDB open — must not be internet/network-exposed without auth', fix: "sudo sed -i 's/^  bindIp: .*/  bindIp: 127.0.0.1/' /etc/mongod.conf && sudo systemctl restart mongod" },
}

function riskOf(port: number): RiskLevel {
  if ([23, 21, 445, 5900, 3389, 11211, 6379, 27017].includes(port)) return 'high'
  if ([80, 9100, 8080].includes(port)) return 'medium'
  if (port === 22) return 'medium' // SSH is expected; medium because misconfig is common
  return 'low'
}

// Ingest findings reported by the audit sidecar and produce a report.
export async function reportAudit(scannedAt: string, raw: { host: string; port: number; service?: string }[]): Promise<AuditReport> {
  const findings: AuditFinding[] = []
  for (const r of raw) {
    const known = RISKY_PORTS[r.port]
    const finding: AuditFinding = {
      host: r.host,
      port: r.port,
      service: r.service ?? known?.service ?? 'unknown',
      risk: known ? riskOf(r.port) : 'low',
      note: known?.note ?? 'Open port \u2014 confirm it is intentional and protected.',
      fix: remediationFor(r.host, r.port),
    }
    findings.push(finding)
  }
  // Score: weighted by risk level.
  let score = 0
  for (const f of findings) {
    score += f.risk === 'high' ? 15 : f.risk === 'medium' ? 8 : 2
  }
  score = Math.min(100, score)
  const high = findings.filter((f) => f.risk === 'high').length
  const summary = high > 0
    ? `${high} high-risk open port(s) found — review and close them.`
    : findings.length === 0
      ? 'No open risky ports detected. Looks clean.'
      : 'Some open ports detected — review the notes below.'
  // Compare with the previous scan (if any) to flag newly-appeared risky ports.
  let isNewRisk = false
  let newHosts: string[] = []
  const prev = history.length ? history[history.length - 1] : undefined
  if (prev) {
    const prior = new Set(prev.findings.map((f) => `${f.host}:${f.port}`))
    const fresh = findings.filter((f) => !prior.has(`${f.host}:${f.port}`))
    if (fresh.length > 0) {
      isNewRisk = true
      newHosts = [...new Set(fresh.map((f) => f.host))]
    }
  }
  await ensureAuditLoaded()
  latest = { id: `a${++seq}`, scannedAt, findings, score, summary, isNewRisk, newHosts }
  history.push(latest)
  await save(AUDIT_FILE, { history, seq }).catch(() => {})
  return { ...latest }
}

export function getLatestAudit(): AuditReport | undefined {
  return latest ? { ...latest, findings: [...latest.findings] } : undefined
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(data)
}
