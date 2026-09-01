// Durable brain store for the J.A.R.V.I.S gateway.
//
// A small, reliable JSON persistence layer that makes learning, mistakes,
// lessons, and audit history SURVIVE restarts. The gateway's /tmp files reset
// on reboot — this store writes atomically to a configurable directory so the
// brain keeps accumulating across process restarts and reboots.
//
//   JARVIS_STATE_DIR=/home/jarvis/jarvis/state  node dist/server.js
//
// Atomic: writes go to a temp file, fsync, then rename — so a crash mid-write
// never corrupts the brain.
import { mkdir, readFile, rename, writeFile, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const STATE_DIR = process.env.JARVIS_STATE_DIR || '/tmp/jarvis-state'
export const LEARN_FILE = join(STATE_DIR, 'learn.json')
export const AUDIT_FILE = join(STATE_DIR, 'audit.json')

export async function ensureDir(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
}

async function atomicWrite(file: string, data: unknown): Promise<void> {
  await ensureDir()
  const tmp = `${file}.tmp`
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(JSON.stringify(data, null, 2))
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmp, file) // atomic on POSIX — never a partial file
}

export async function load<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function save(file: string, data: unknown): Promise<void> {
  await atomicWrite(file, data)
}
