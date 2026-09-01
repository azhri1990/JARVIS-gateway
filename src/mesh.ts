// Connected-device registry for the J.A.R.V.I.S gateway.
//
// Each device that runs a wake-engine sidecar (home, laptop, pi) registers
// itself here and heartbeats periodically. This gives one view of the whole
// mesh: which devices are listening, which are stale/offline, and their last
// seen time. Fail-closed: a device that stops heartbeating goes "stale" rather
// than being assumed present.
import type { ServerResponse } from 'node:http'

export interface MeshDevice {
  id: string
  name: string
  kind: 'home' | 'laptop' | 'pi' | 'phone' | 'tablet' | 'other'
  wake: boolean // is this device running an always-listening wake engine
  lastSeen: string
  ip?: string
  status: 'online' | 'stale'
}

const STALE_MS = 70_000 // a device is stale if it hasn't heartbeated in ~70s
const devices = new Map<string, MeshDevice>()

export function registerDevice(d: Omit<MeshDevice, 'lastSeen' | 'status'>): MeshDevice {
  const now = new Date().toISOString()
  const dev: MeshDevice = { ...d, lastSeen: now, status: 'online' }
  devices.set(d.id, dev)
  return dev
}

export function heartbeat(id: string): MeshDevice | undefined {
  const dev = devices.get(id)
  if (!dev) return undefined
  dev.lastSeen = new Date().toISOString()
  dev.status = 'online'
  return dev
}

export function listDevices(): MeshDevice[] {
  const now = Date.now()
  return [...devices.values()].map((d) => {
    const age = now - new Date(d.lastSeen).getTime()
    return { ...d, status: age > STALE_MS ? 'stale' : 'online' }
  })
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
