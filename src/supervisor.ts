// J.A.R.V.I.S watchdog supervisor.
//
// Keeps the home-machine sidecars alive: every `intervalMs` seconds it checks
// each managed service and restarts any that died (health via a "last seen"
// heartbeat file). This is what makes the scheduled security audit (and the
// wake/vision/device loops) self-healing — if a process crashes, the watchdog
// brings it back without you noticing.
//
// Run on the home machine:  node dist/supervisor.js
import { spawn } from 'node:child_process'
import { stat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ManagedService {
  name: string
  command: string
  args: string[]
  cwd?: string
  // When set, the service is healthy only if this file's mtime is fresh.
  heartbeatFile?: string
  maxStaleMs?: number
}

export interface SupervisorConfig {
  intervalMs: number
  services: ManagedService[]
  stateDir: string
  log: (line: string) => void
}

const DEFAULT_STATE_DIR = '/tmp/jarvis-watchdog'
const DEFAULT_LOG = (line: string) => console.log(`[watchdog ${new Date().toISOString()}] ${line}`)

// The home sidecars the watchdog keeps alive. They touch their heartbeat file
// each loop iteration so a stale heartbeat means the process is wedged.
export const defaultServices = (stateDir: string): ManagedService[] => [
  {
    name: 'audit-loop',
    command: 'python3',
    args: [join(stateDir, 'audit-engine.py'), '--interval', '86400'],
    heartbeatFile: join(stateDir, 'hb-audit.txt'),
    maxStaleMs: 90_000,
  },
  {
    name: 'wake-engine',
    command: 'python3',
    args: [join(stateDir, 'wake-engine.py')],
    heartbeatFile: join(stateDir, 'hb-wake.txt'),
    maxStaleMs: 30_000,
  },
  {
    name: 'vision-engine',
    command: 'python3',
    args: [join(stateDir, 'vision-engine.py')],
    heartbeatFile: join(stateDir, 'hb-vision.txt'),
    maxStaleMs: 60_000,
  },
  {
    name: 'device-engine',
    command: 'python3',
    args: [join(stateDir, 'device-engine.py')],
    heartbeatFile: join(stateDir, 'hb-device.txt'),
    maxStaleMs: 30_000,
  },
]

const running = new Map<string, { pid: number }>()

async function heartbeatFresh(p: string, maxStale: number): Promise<boolean> {
  try {
    const s = await stat(p)
    return Date.now() - s.mtimeMs < maxStale
  } catch {
    return false // no heartbeat file yet — treat as stale on first pass
  }
}

function startService(cfg: SupervisorConfig, svc: ManagedService): void {
  const child = spawn(svc.command, svc.args, { cwd: svc.cwd })
  running.set(svc.name, { pid: child.pid ?? 0 })
  cfg.log(`started ${svc.name} (pid ${child.pid})`)
  child.stdout?.on('data', (d) => cfg.log(`[${svc.name}] ${String(d).trimEnd()}`))
  child.stderr?.on('data', (d) => cfg.log(`[${svc.name}] err ${String(d).trimEnd()}`))
  child.on('exit', (code) => {
    cfg.log(`${svc.name} exited (code ${code})`)
    running.delete(svc.name)
  })
  child.on('error', (e) => cfg.log(`${svc.name} spawn error: ${e.message}`))
}

async function writeWatchdogHeartbeat(cfg: SupervisorConfig): Promise<void> {
  try {
    await mkdir(cfg.stateDir, { recursive: true })
    await writeFile(join(cfg.stateDir, 'hb-watchdog.txt'), new Date().toISOString())
  } catch (e) {
    cfg.log(`heartbeat write failed: ${String(e)}`)
  }
}

export async function runSupervisor(cfg: SupervisorConfig): Promise<void> {
  cfg.log(`starting watchdog: ${cfg.services.length} managed services, interval ${cfg.intervalMs}ms`)
  for (const svc of cfg.services) startService(cfg, svc)

  const tick = async () => {
    await writeWatchdogHeartbeat(cfg)
    for (const svc of cfg.services) {
      const r = running.get(svc.name)
      if (!r) {
        startService(cfg, svc)
        continue
      }
      if (svc.heartbeatFile) {
        const fresh = await heartbeatFresh(svc.heartbeatFile, svc.maxStaleMs ?? 90_000)
        if (!fresh) {
          cfg.log(`${svc.name} heartbeat STALE — restarting`)
          try { process.kill(r.pid, 'SIGKILL') } catch { /* already gone */ }
          running.delete(svc.name)
          startService(cfg, svc)
        }
      }
    }
  }
  void tick()
  setInterval(() => void tick(), cfg.intervalMs)
}

// Called by sidecars each loop so the watchdog can tell they are alive.
export async function touchHeartbeat(file: string): Promise<void> {
  try {
    await writeFile(file, new Date().toISOString())
  } catch { /* non-fatal */ }
}
