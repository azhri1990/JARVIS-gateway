// Consent gate for the J.A.R.V.I.S gateway.
//
// Enforces "J.A.R.V.I.S takes control only with your approval." Any
// consequential action (changing a device's power, performing an app action,
// or running an arbitrary /execute command) must first create a pending
// approval. The action only runs after the owner approves it; until then it is
// held. Denied or expired approvals never run (fail-closed). Approval requests
// surface on any connected surface (mobile Capabilities panel, dashboard) via
// GET /consent.
import type { ServerResponse } from 'node:http'

export type ActionKind = 'device' | 'app' | 'execute'

export interface Approval {
  id: string
  kind: ActionKind
  label: string // human-readable, e.g. "Turn on Living Room Lights"
  details: string // what will happen, e.g. "POST /devices/lights-living/power on=true"
  status: 'pending' | 'approved' | 'denied' | 'expired'
  createdAt: string
  decidedAt?: string
}

const approvals: Approval[] = []
const TTL_MS = 10 * 60 * 1000 // approvals auto-expire after 10 minutes
let seq = 0

export function requestApproval(kind: ActionKind, label: string, details: string): Approval {
  const a: Approval = {
    id: `c${++seq}`,
    kind,
    label,
    details,
    status: 'pending',
    createdAt: new Date().toISOString(),
  }
  approvals.unshift(a)
  return a
}

// Expire anything older than TTL that is still pending (fail-closed: stale
// approvals never auto-run).
function expire(): void {
  const now = Date.now()
  for (const a of approvals) {
    if (a.status === 'pending' && now - new Date(a.createdAt).getTime() > TTL_MS) {
      a.status = 'expired'
    }
  }
}

export function listApprovals(status?: string): Approval[] {
  expire()
  return status
    ? approvals.filter((a) => a.status === status).map((a) => ({ ...a }))
    : approvals.map((a) => ({ ...a }))
}

export function getApproval(id: string): Approval | undefined {
  expire()
  const a = approvals.find((x) => x.id === id)
  return a ? { ...a } : undefined
}

export function decide(id: string, approve: boolean): Approval | undefined {
  const a = approvals.find((x) => x.id === id)
  if (!a) return undefined
  if (a.status !== 'pending') return { ...a } // already decided — no re-run
  a.status = approve ? 'approved' : 'denied'
  a.decidedAt = new Date().toISOString()
  return { ...a }
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(data)
}
