// J.A.R.V.I.S watchdog config — the managed-services list for the home machine.
// The supervisor keeps each of these alive and auto-restarts any that die or
// go silent. This is what makes the daily security audit (and wake/vision/
// device loops) self-healing.
//
// Run with:  WATCHDOG_STATE_DIR=/home/<you>/jarvis node dist/supervisor.js
import { SupervisorConfig, defaultServices } from './supervisor.js'

const STATE_DIR = process.env.WATCHDOG_STATE_DIR || '/home/jarvis/jarvis'

export const config: SupervisorConfig = {
  intervalMs: Number(process.env.WATCHDOG_INTERVAL_MS) || 10_000,
  stateDir: STATE_DIR,
  services: defaultServices(STATE_DIR),
  log: (line: string) => console.log(`[watchdog ${new Date().toISOString()}] ${line}`),
}

// Allow overriding the audit interval via env (e.g. every 6h for faster catch).
const AUDIT_INTERVAL = process.env.AUDIT_INTERVAL_S ? String(Number(process.env.AUDIT_INTERVAL_S)) : '86400'
for (const svc of config.services) {
  if (svc.name === 'audit-loop') {
    svc.args = [svc.args[0], '--interval', AUDIT_INTERVAL, '--heartbeat', `${STATE_DIR}/hb-audit.txt`]
  }
}
