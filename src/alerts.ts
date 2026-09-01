// Alerts module for the J.A.R.V.I.S gateway (proactive awareness).
import type { ServerResponse } from 'node:http'

export interface Watch {
  id: string
  name: string
  kind: 'http' | 'command'
  target: string
  everyMs: number
  lastOk: boolean
  createdAt: string
}

export interface Alert {
  id: string
  watchId: string
  message: string
  severity: 'info' | 'warn' | 'error'
  read: boolean
  createdAt: string
}

const watches: Watch[] = []
const alerts: Alert[] = []
let nextId = 1
const uid = () => `w${nextId++}`
const timers = new Map<string, NodeJS.Timeout>()

function ok(w: Watch, isOk: boolean) {
  if (isOk === w.lastOk) return
  w.lastOk = isOk
  alerts.unshift({
    id: `a${Date.now()}`,
    watchId: w.id,
    message: isOk ? `${w.name} recovered` : `${w.name} is DOWN (${w.target})`,
    severity: isOk ? 'info' : 'error',
    read: false,
    createdAt: new Date().toISOString(),
  })
}

function checkWatch(w: Watch) {
  if (w.kind !== 'http') return
  const url = w.target.startsWith('http') ? w.target : `http://${w.target}`
  void fetch(url, { signal: AbortSignal.timeout(3000) })
    .then((r) => ok(w, r.ok))
    .catch(() => ok(w, false))
}

export function addWatch(name: string, kind: Watch['kind'], target: string, everyMs = 30000): Watch {
  const w: Watch = { id: uid(), name, kind, target, everyMs, lastOk: kind === 'http', createdAt: new Date().toISOString() }
  watches.push(w)
  const t = setInterval(() => checkWatch(w), everyMs)
  timers.set(w.id, t)
  setTimeout(() => checkWatch(w), 100)
  return w
}

export function removeWatch(id: string): boolean {
  const idx = watches.findIndex((w) => w.id === id)
  if (idx === -1) return false
  const t = timers.get(id)
  if (t) clearInterval(t)
  timers.delete(id)
  watches.splice(idx, 1)
  return true
}

export function listWatches(): Watch[] { return [...watches] }
export function listAlerts(includeRead = false): Alert[] { return includeRead ? alerts : alerts.filter((a) => !a.read) }
export function markAlertsRead(): void { for (const a of alerts) a.read = true }

export function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(data)
}
