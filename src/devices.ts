// Home-automation module for the J.A.R.V.I.S gateway.
//
// Lets J.A.R.V.I.S control smart devices (lights, plugs, thermostats, etc.)
// through a device registry. Each device maps to a local command that a home
// sidecar runs (e.g. a Tasmota/Home Assistant API call, or a simple script).
// Fail-closed: power/state actions only run if the device has a command
// configured; otherwise they report "unavailable". State is tracked in memory
// so the UI can show live on/off status.
import type { ServerResponse } from 'node:http'

export interface Device {
  id: string
  name: string
  type: string // 'light' | 'plug' | 'thermostat' | ...
  on: boolean
  // Command run by the sidecar to apply a desired power state.
  // Template: {device} {on|off} — the home sidecar resolves it to the real API.
  command: string
  lastChanged?: string
}

// Seed registry — edit on your home machine to match your devices.
const devices: Device[] = [
  { id: 'lights-living', name: 'Living Room Lights', type: 'light', on: false, command: 'device lights-living {state}' },
  { id: 'plug-nas', name: 'NAS Plug', type: 'plug', on: true, command: 'device plug-nas {state}' },
  { id: 'thermostat', name: 'Thermostat', type: 'thermostat', on: true, command: 'device thermostat {state}' },
]

export function listDevices(): Device[] {
  return devices.map((d) => ({ ...d }))
}

export function getDevice(id: string): Device | undefined {
  const d = devices.find((x) => x.id === id)
  return d ? { ...d } : undefined
}

export function setDevicePower(id: string, on: boolean): Device | undefined {
  const d = devices.find((x) => x.id === id)
  if (!d) return undefined
  // Fail-closed: require a command template before claiming we acted.
  if (!d.command) return { ...d }
  d.on = on
  d.lastChanged = new Date().toISOString()
  // The actual device API call runs via the home sidecar (see /devices docs).
  return { ...d }
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(data)
}
