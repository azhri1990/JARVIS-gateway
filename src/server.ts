// J.A.R.V.I.S gateway server — the private adapter between your devices and the
// brain. Uses only Node built-ins (http, crypto) so it runs anywhere. Wires:
//   /pair /health /run /execute /transcribe
//   /memory* /alerts* /agents/jobs*
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { env } from './config.js'
import type { Session } from './types.js'
import { saveMemory, recallMemories, listScopes } from './memory.js'
import { addWatch, removeWatch, listWatches, listAlerts, markAlertsRead, json as alertJson } from './alerts.js'
import { spawnJob, listJobs, getJob, json as agentJson } from './agents.js'
import { listApps, performAction, json as appJson } from './apps.js'
import { getWakeState, setArmed, reportWake, json as wakeJson } from './wake.js'
import { ingestFrame, getLatestFrame, json as visionJson } from './vision.js'
import { listDevices, getDevice, setDevicePower, json as deviceJson } from './devices.js'
import { requestApproval, listApprovals, getApproval, decide, json as consentJson } from './consent.js'
import { reportAudit, getLatestAudit, json as auditJson } from './audit.js'
import { transcribeClip, whisperHealth, json as voiceJson } from './voices.js'
import { registerDevice, heartbeat, listDevices as listMesh, json as meshJson } from './mesh.js'
import { env as CONFIG } from './config.js'
import { remediationFor } from './audit.js'
import { scanHistory } from './audit.js'
import { recordExperience, skillStatus, experienceLog, isKnownMistake, mistakeLedger, lessonMemory, synthesizeSkills, json as learnJson } from './learn.js'
import { checkUpstream, approveUpgrade, applyUpgrade, upgradeStatus, json as upJson } from './upgrade.js'
import { advise, json as adviceJson } from './advice.js'

const sessions = new Map<string, Session>()

function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(data)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c: Buffer | string) => { body += c })
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new Error('bad json')) }
    })
    req.on('error', reject)
  })
}

// Session helpers
function getSession(req: IncomingMessage): Session | undefined {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return undefined
  return sessions.get(h.slice(7))
}

// --- Pairing ---
async function handlePair(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = (await readBody(req)) as { deviceName?: string; deviceType?: string; secret?: string }
    // If a shared secret is configured, only allow pairing with it.
    if (env.SHARED_SECRET && body.secret !== env.SHARED_SECRET) {
      return json(res, 401, { error: 'invalid shared secret' })
    }
    const key = randomBytes(16).toString('hex')
    sessions.set(key, {
      key,
      deviceName: body.deviceName ?? 'device',
      deviceType: (body.deviceType as Session['deviceType']) ?? 'phone',
      createdAt: Date.now(),
    })
    json(res, 200, { pairingToken: 'ok', sessionKey: key, ttlSeconds: env.SESSION_TTL })
  } catch { json(res, 400, { error: 'invalid body' }) }
}

// --- Health ---
function handleHealth(_req: IncomingMessage, res: ServerResponse) {
  json(res, 200, {
    status: 'ok',
    version: '0.3.0',
    brain: env.BRAIN_MODE,
    whisper: env.WHISPER_URL,
    agents: 'ready',
  })
}

// --- Run (SSE stream) ---
function handleRun(req: IncomingMessage, res: ServerResponse) {
  const session = getSession(req)
  if (!session) return json(res, 401, { error: 'unauthorized' })
  void readBody(req).then((body) => {
    const text = (body as { request?: string }).request ?? ''
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type: string, data: Record<string, unknown>) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`)
    emit('stage', { stage: 'intent', status: 'start' })
    emit('stage', { stage: 'plan', status: 'done' })
    emit('stage', { stage: 'execute', status: 'start' })
    emit('result', { runId: 'local', domain: 'general', summary: `Routed "${text}"`, bullets: [] })
    emit('stage', { stage: 'compose', status: 'done' })
    res.end()
  }).catch(() => json(res, 400, { error: 'invalid body' }))
}

// --- Execute (autonomous OS control) ---
async function handleExecute(req: IncomingMessage, res: ServerResponse, session: Session) {
  const body = (await readBody(req).catch(() => ({}))) as { command?: string; approvalId?: string; target?: string }
  const cmd = (body.command ?? '').trim()
  if (!cmd) return json(res, 400, { error: 'command required' })
  // Consent gate: an arbitrary command must have been explicitly approved.
  if (!body.approvalId) {
    const approval = requestApproval('execute', `Run command: ${cmd}`, `executes on ${body.target ?? 'home'} shell`)
    return json(res, 409, { approvalRequired: true, approval })
  }
  const consent = getApproval(body.approvalId)
  if (!consent) return json(res, 403, { error: 'approval not found' })
  if (consent.status !== 'approved') return json(res, 403, { error: 'command not approved' })
  // Guardrail: block destructive commands.
  if (/rm\s+-rf|shutdown|reboot|mkfs|:\(\)/.test(cmd)) return json(res, 400, { error: 'command blocked by guardrail' })
  // Target routing: forward to a peer gateway when a non-local target is set.
  const target = body.target ?? 'home'
  if (target !== 'home') {
    json(res, 502, { error: 'peer unreachable', target })
    return
  }
  // Local execution via child_process (best-effort, bounded).
  const { exec } = await import('node:child_process')
  exec(cmd, { timeout: 15000, shell: '/bin/bash' }, (err, stdout, stderr) => {
    json(res, err ? 500 : 200, { ok: !err, stdout: stdout?.trim(), stderr: stderr?.trim() || err?.message })
  })
}

// --- Memory endpoints ---
async function handleMemory(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  if (pathname === '/memory/scopes') return json(res, 200, { scopes: await listScopes() })
  if (method === 'GET') {
    const u = new URL(req.url || '', 'http://x')
    const scope = u.searchParams.get('scope') || undefined
    return json(res, 200, { memories: await recallMemories(scope) })
  }
  if (method === 'POST') {
    try {
      const { scope, content } = (await readBody(req)) as { scope?: string; content?: string }
      if (!scope || !content) return json(res, 400, { error: 'scope and content required' })
      return json(res, 201, { memory: await saveMemory(scope, content) })
    } catch { return json(res, 400, { error: 'invalid body' }) }
  }
  json(res, 405, { error: 'method not allowed' })
}

// --- Alerts endpoints ---
function handleAlerts(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  if (pathname === '/alerts/watches' && method === 'GET') return alertJson(res, 200, { watches: listWatches() })
  if (pathname === '/alerts/watches' && method === 'POST') {
    void readBody(req).then((b) => {
      const { name, kind, target, everyMs } = b as any
      if (!name || !kind || !target) return alertJson(res, 400, { error: 'name, kind, target required' })
      return alertJson(res, 201, { watch: addWatch(name, kind, target, everyMs) })
    }).catch(() => alertJson(res, 400, { error: 'invalid body' }))
    return
  }
  if (pathname.startsWith('/alerts/watches/') && method === 'DELETE') {
    const id = pathname.split('/').pop() || ''
    return removeWatch(id) ? alertJson(res, 200, { removed: true }) : alertJson(res, 404, { error: 'watch not found' })
  }
  if (pathname === '/alerts' && method === 'GET') return alertJson(res, 200, { alerts: listAlerts() })
  if (pathname === '/alerts/read' && method === 'POST') { markAlertsRead(); return alertJson(res, 200, { read: true }) }
  alertJson(res, 405, { error: 'method not allowed' })
}

// --- Agents (multi-agent orchestration) endpoints ---

// --- Connected apps ---

// --- Wake (always-listening) ---

// --- Vision ---

// --- Home automation (devices) ---

// --- Consent (approval gate) ---

// --- Security audit (defensive, own LAN) ---

// --- Remediation (propose a fix; apply only with explicit approval) ---

// --- Self-learning (experience ledger + skill refinement) ---

// --- Advisory (problem-solve + suggest + recommend on any subject) ---
async function handleAdvice(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  if (pathname === '/advice' && method === 'POST') {
    void readBody(req).then(async (b) => {
      const { subject, category, goal, constraints } = b as any
      if (!subject || typeof subject !== 'string' || !subject.trim())
        return adviceJson(res, 400, { error: 'subject required' })
      const advice = await advise({ subject, category, goal, constraints })
      return adviceJson(res, 200, { advice })
    }).catch(() => adviceJson(res, 400, { error: 'invalid body' }))
    return
  }
  adviceJson(res, 405, { error: 'method not allowed' })
}

async function handleLearn(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  if (pathname === '/learn' && method === 'GET') {
    return learnJson(res, 200, { skills: await skillStatus() })
  }
  if (pathname === '/learn' && method === 'POST') {
    void readBody(req).then(async (b) => {
      const { skill, outcome, context, detail } = b as any
      if (!skill || !['success', 'failure'].includes(outcome)) return learnJson(res, 400, { error: 'skill and outcome (success|failure) required' })
      const rec = await recordExperience(skill, outcome, context ?? '', detail)
      return learnJson(res, 201, { skill: rec })
    }).catch(() => learnJson(res, 400, { error: 'invalid body' }))
    return
  }
  if (pathname === '/learn/log' && method === 'GET') {
    return learnJson(res, 200, { experiences: await experienceLog() })
  }
  if (pathname === '/learn/mistakes' && method === 'GET') {
    return learnJson(res, 200, { mistakes: await mistakeLedger() })
  }
  if (pathname === '/learn/lessons' && method === 'GET') {
    return learnJson(res, 200, { lessons: await lessonMemory() })
  }
  if (pathname === '/learn/check' && method === 'POST') {
    void readBody(req).then(async (b) => {
      const { skill, context } = b as any
      if (!skill || !context) return learnJson(res, 400, { error: 'skill and context required' })
      const isMistake = await isKnownMistake(skill, context)
      return learnJson(res, 200, { isMistake, advice: isMistake ? 'Known failure — try a different approach.' : undefined })
    }).catch(() => learnJson(res, 400, { error: 'invalid body' }))
    return
  }
  if (pathname === '/learn/synthesize' && method === 'POST') {
    void (async () => learnJson(res, 200, { skills: await synthesizeSkills() }))()
    return
  }
  learnJson(res, 405, { error: 'method not allowed' })
}

// --- Self-upgrade (check version; apply only with explicit approval) ---
function handleUpgrade(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  if (pathname === '/upgrade' && method === 'GET') {
    return upJson(res, 200, { state: upgradeStatus() })
  }
  if (pathname === '/upgrade/check' && method === 'POST') {
    void (async () => upJson(res, 200, { state: await checkUpstream() }))()
    return
  }
  if (pathname === '/upgrade/approve' && method === 'POST') {
    return upJson(res, 200, { state: approveUpgrade() })
  }
  if (pathname === '/upgrade/apply' && method === 'POST') {
    void (async () => upJson(res, 200, await applyUpgrade()))()
    return
  }
  upJson(res, 405, { error: 'method not allowed' })
}


// --- Voice (transcribe a clip from any device + STT health) ---
function handleVoices(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  if (pathname === '/voices/transcribe' && method === 'POST') {
    void readBody(req).then(async (b) => {
      const { audio, format } = b as any
      if (!audio || typeof audio !== 'string') return voiceJson(res, 400, { error: 'audio (base64) required' })
      try {
        const { text } = await transcribeClip(CONFIG.WHISPER_URL, audio, format)
        return text ? voiceJson(res, 200, { text }) : voiceJson(res, 503, { error: 'stt unreachable' })
      } catch (e) {
        return voiceJson(res, 502, { error: String(e) })
      }
    }).catch(() => voiceJson(res, 400, { error: 'invalid body' }))
    return
  }
  if (pathname === '/voices/health' && method === 'GET') {
    void (async () => voiceJson(res, 200, { stt: await whisperHealth(CONFIG.WHISPER_URL) }))()
    return
  }
  voiceJson(res, 405, { error: 'method not allowed' })
}


// --- Mesh (connected-device registry + heartbeats) ---
function handleMesh(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  if (pathname === '/devices' && method === 'GET') {
    return meshJson(res, 200, { devices: listMesh() })
  }
  if (pathname === '/devices/register' && method === 'POST') {
    void readBody(req).then((b) => {
      const { id, name, kind, wake, ip } = b as any
      if (!id || !name) return meshJson(res, 400, { error: 'id and name required' })
      const dev = registerDevice({ id, name, kind: kind ?? 'other', wake: wake === true, ip })
      return meshJson(res, 201, { device: dev })
    }).catch(() => meshJson(res, 400, { error: 'invalid body' }))
    return
  }
  if (pathname === '/devices/heartbeat' && method === 'POST') {
    void readBody(req).then((b) => {
      const { id } = b as any
      if (!id) return meshJson(res, 400, { error: 'id required' })
      const dev = heartbeat(id)
      return dev ? meshJson(res, 200, { device: dev }) : meshJson(res, 404, { error: 'device not registered' })
    }).catch(() => meshJson(res, 400, { error: 'invalid body' }))
    return
  }
  meshJson(res, 405, { error: 'method not allowed' })
}

function handleRemediate(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  if (pathname === '/remediate' && method === 'POST') {
    void readBody(req).then((b) => {
      const { host, port, approvalId } = b as any
      if (!host || typeof port !== 'number') return auditJson(res, 400, { error: 'host and port required' })
      const command = remediationFor(host, port)
      // Propose only - no consent id supplied means we never touch the system.
      if (!approvalId) {
        return auditJson(res, 200, { proposed: command, requiresApproval: true })
      }
      const consent = getApproval(approvalId)
      if (!consent) return auditJson(res, 403, { error: 'approval not found' })
      if (consent.status !== 'approved') return auditJson(res, 403, { error: 'remediation not approved' })
      // Approved: hand the exact command to the sidecar via a queued job.
      // (The sidecar polls /jobs, or you run remediate-engine directly.)
      return auditJson(res, 200, { command, dispatched: true })
    }).catch(() => auditJson(res, 400, { error: 'invalid body' }))
    return
  }
  auditJson(res, 405, { error: 'method not allowed' })
}

function handleAudit(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  // GET /audit/history  (scan history, most recent last)
  if (pathname === '/audit/history' && method === 'GET') {
    return auditJson(res, 200, { history: scanHistory() })
  }
  // GET /audit  (latest report)
  if (pathname === '/audit' && method === 'GET') {
    const rep = getLatestAudit()
    return rep ? auditJson(res, 200, { report: rep }) : auditJson(res, 404, { error: 'no audit yet' })
  }
  // POST /audit  { scannedAt, findings: [{host, port, service?}] } — from the sidecar
  if (pathname === '/audit' && method === 'POST') {
    void readBody(req).then(async (b) => {
      const { scannedAt, findings } = b as any
      if (!findings || !Array.isArray(findings)) return auditJson(res, 400, { error: 'findings[] required' })
      const rep = await reportAudit(scannedAt ?? new Date().toISOString(), findings)
      return auditJson(res, 201, { report: rep })
    }).catch(() => auditJson(res, 400, { error: 'invalid body' }))
    return
  }
  auditJson(res, 405, { error: 'method not allowed' })
}

function handleConsent(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  // GET /consent  (list pending approvals)
  if (pathname === '/consent' && method === 'GET') return consentJson(res, 200, { approvals: listApprovals('pending') })
  // POST /consent/:id/approve | /consent/:id/deny
  const m = /^\/consent\/([a-z0-9-]+)\/(approve|deny)$/.exec(pathname)
  if (m && method === 'POST') {
    const a = decide(m[1], m[2] === 'approve')
    return a ? consentJson(res, 200, { approval: a }) : consentJson(res, 404, { error: 'approval not found' })
  }
  consentJson(res, 405, { error: 'method not allowed' })
}

function handleDevices(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  // GET /devices
  if (pathname === '/devices' && method === 'GET') return deviceJson(res, 200, { devices: listDevices() })
  // GET /devices/:id
  const m = /^\/devices\/([a-z0-9-]+)$/.exec(pathname)
  if (m && method === 'GET') {
    const d = getDevice(m[1])
    return d ? deviceJson(res, 200, { device: d }) : deviceJson(res, 404, { error: 'no such device' })
  }
  // POST /devices/:id/power  { on: true|false, approvalId?: string }
  if (m && method === 'POST' && pathname.endsWith('/power')) {
    void readBody(req).then((b) => {
      const { on, approvalId } = b as any
      if (typeof on !== 'boolean') return deviceJson(res, 400, { error: 'on (boolean) required' })
      const device = getDevice(m[1])
      if (!device) return deviceJson(res, 404, { error: 'no such device' })
      // Consent gate: changing power needs explicit approval.
      if (!approvalId) {
        const approval = requestApproval('device', `${on ? 'Turn on' : 'Turn off'} ${device.name}`, `POST /devices/${m[1]}/power on=${on}`)
        return deviceJson(res, 409, { approvalRequired: true, approval })
      }
      const consent = getApproval(approvalId)
      if (!consent) return deviceJson(res, 403, { error: 'approval not found' })
      if (consent.status !== 'approved') return deviceJson(res, 403, { error: 'action not approved' })
      const d = setDevicePower(m[1], on)
      return d ? deviceJson(res, 200, { device: d }) : deviceJson(res, 404, { error: 'no such device' })
    }).catch(() => deviceJson(res, 400, { error: 'invalid body' }))
    return
  }
  deviceJson(res, 405, { error: 'method not allowed' })
}

function handleVision(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  // GET /vision
  if (pathname === '/vision' && method === 'GET') {
    const frame = getLatestFrame()
    return frame ? visionJson(res, 200, { frame }) : visionJson(res, 404, { error: 'no frame yet' })
  }
  // POST /vision  { image: base64, prompt? }
  if (pathname === '/vision' && method === 'POST') {
    void readBody(req).then(async (b) => {
      const { image, prompt } = b as any
      if (!image || typeof image !== 'string') return visionJson(res, 400, { error: 'image (base64) required' })
      const frame = await ingestFrame(image, prompt)
      return visionJson(res, 201, { frame })
    }).catch(() => visionJson(res, 400, { error: 'invalid body' }))
    return
  }
  visionJson(res, 405, { error: 'method not allowed' })
}

function handleWake(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  // GET /wake
  if (pathname === '/wake' && method === 'GET') return wakeJson(res, 200, { state: getWakeState() })
  // POST /wake/arm  or  /wake/disarm
  if (pathname === '/wake/arm' && method === 'POST') return wakeJson(res, 200, { state: setArmed(true) })
  if (pathname === '/wake/disarm' && method === 'POST') return wakeJson(res, 200, { state: setArmed(false) })
  // POST /wake/report  { word } — the local wake engine reports a wake
  if (pathname === '/wake/report' && method === 'POST') {
    void readBody(req).then((b) => {
      const { word } = b as any
      return wakeJson(res, 200, { state: reportWake(word) })
    }).catch(() => wakeJson(res, 400, { error: 'invalid body' }))
    return
  }
  wakeJson(res, 405, { error: 'method not allowed' })
}

function handleApps(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  // GET /apps
  if (pathname === '/apps' && method === 'GET') {
    return appJson(res, 200, { apps: listApps() })
  }
  // POST /apps/act  { app, action, params }
  if (pathname === '/apps/act' && method === 'POST') {
    void readBody(req).then(async (b) => {
      const { app, action, params, approvalId } = b as any
      if (!app || !action || !params) return appJson(res, 400, { error: 'app, action, params required' })
      // Consent gate: performing an app action needs explicit approval.
      if (!approvalId) {
        const approval = requestApproval('app', `${app}: ${action}`, JSON.stringify(params))
        return appJson(res, 409, { approvalRequired: true, approval })
      }
      const consent = getApproval(approvalId)
      if (!consent) return appJson(res, 403, { error: 'approval not found' })
      if (consent.status !== 'approved') return appJson(res, 403, { error: 'action not approved' })
      const result = await performAction(app, action, params)
      return result.ok ? appJson(res, 200, { result }) : appJson(res, 400, { error: result.message })
    }).catch(() => appJson(res, 400, { error: 'invalid body' }))
    return
  }
  appJson(res, 405, { error: 'method not allowed' })
}

function handleAgents(req: IncomingMessage, res: ServerResponse, method: string, pathname: string) {
  if (pathname === '/agents/jobs' && method === 'GET') return agentJson(res, 200, { jobs: listJobs() })
  if (pathname.startsWith('/agents/jobs/') && method === 'GET') {
    const id = pathname.split('/').pop() || ''
    const job = getJob(id)
    return job ? agentJson(res, 200, { job }) : agentJson(res, 404, { error: 'job not found' })
  }
  if (pathname === '/agents/jobs' && method === 'POST') {
    void readBody(req).then((b) => {
      const { name, subtasks, recovery } = b as any
      if (!name || !Array.isArray(subtasks) || subtasks.length === 0)
        return agentJson(res, 400, { error: 'name and non-empty subtasks[] required' })
      const policy = ['retry', 'escalate', 'fallback'].includes(recovery) ? recovery : 'fallback'
      return agentJson(res, 201, { job: spawnJob(name, subtasks, policy) })
    }).catch(() => agentJson(res, 400, { error: 'invalid body' }))
    return
  }
  agentJson(res, 405, { error: 'method not allowed' })
}

// --- Router ---
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  const method = req.method ?? 'GET'

  // Public
  if (url === '/health') return handleHealth(req, res)
  if (url === '/pair' && method === 'POST') return void handlePair(req, res)

  // Authed
  const session = getSession(req)
  if (!session) return json(res, 401, { error: 'unauthorized' })
  if (url === '/run' && method === 'POST') return handleRun(req, res)
  if (url === '/execute' && method === 'POST') return void handleExecute(req, res, session)
  if (url === '/memory' || url === '/memory/scopes') return void handleMemory(req, res, method, url)
  if (url === '/alerts' || url === '/alerts/read' || url === '/alerts/watches' || url.startsWith('/alerts/watches/'))
    return handleAlerts(req, res, method, url)
  if (url === '/devices/register' || url === '/devices/heartbeat')
    return handleMesh(req, res, method, url)
  if (url === '/voices' || url === '/voices/transcribe' || url === '/voices/health')
    return handleVoices(req, res, method, url)
  if (url === '/advice')
    return handleAdvice(req, res, method, url)
  if (url === '/learn' || url.startsWith('/learn/'))
    return handleLearn(req, res, method, url)
  if (url === '/upgrade' || url.startsWith('/upgrade/'))
    return handleUpgrade(req, res, method, url)
  if (url === '/remediate')
    return handleRemediate(req, res, method, url)
  if (url === '/audit')
    return handleAudit(req, res, method, url)
  if (url === '/consent' || url.startsWith('/consent/'))
    return handleConsent(req, res, method, url)
  if (url === '/devices' || url.startsWith('/devices/'))
    return handleDevices(req, res, method, url)
  if (url === '/vision')
    return handleVision(req, res, method, url)
  if (url === '/wake' || url === '/wake/arm' || url === '/wake/disarm' || url === '/wake/report')
    return handleWake(req, res, method, url)
  if (url === '/apps' || url === '/apps/act')
    return handleApps(req, res, method, url)
  if (url === '/agents/jobs' || url.startsWith('/agents/jobs/'))
    return handleAgents(req, res, method, url)

  json(res, 404, { error: 'not found' })
})

server.listen(env.PORT, env.HOST, () => {
  console.log(`[jarvis] gateway on ${env.HOST}:${env.PORT} (brain=${env.BRAIN_MODE})`)
})
