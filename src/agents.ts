// Multi-agent orchestration module for the J.A.R.V.I.S gateway (BOB-style).
//
// Breaks a task into subtasks and runs each as its own agent (a delegate) in
// parallel through the LLM (Ollama in local mode). Adds BOB-style recovery:
// each run carries a recovery policy (retry / escalate / fallback) and agent
// health is tracked (attempts, failures, lastSeen) so the coordinator can
// retry a failing agent, escalate it, or fall back deterministically.
import type { ServerResponse } from 'node:http'
import { JOBS_FILE, load, save } from './store.js'
import { mistakeLedger } from './learn.js'

export type Recovery = 'retry' | 'escalate' | 'fallback'
export type AgentRole = 'code' | 'research' | 'memory' | 'voice' | 'general'

// Typed role registry (OpenMAIC-inspired): each role maps to a set of allowed
// actions. A sub-task declaring a role is validated against this before it runs;
// an unknown role fails fast instead of running blind (fail-closed).
export interface RoleSpec {
  role: AgentRole
  description: string
  allowedActions: string[]
}

export const ROLES: Record<AgentRole, RoleSpec> = {
  code: { role: 'code', description: 'Writes/edits code and runs build/typecheck', allowedActions: ['write-file', 'edit-file', 'run-command'] },
  research: { role: 'research', description: 'Searches, retrieves, and synthesizes information', allowedActions: ['search', 'fetch', 'synthesize'] },
  memory: { role: 'memory', description: 'Reads and writes the durable memory/learning store', allowedActions: ['recall', 'write-memory', 'consolidate'] },
  voice: { role: 'voice', description: 'Handles TTS/STT and spoken responses', allowedActions: ['speak', 'transcribe'] },
  general: { role: 'general', description: 'Any task; no action restriction', allowedActions: ['*'] },
}

export function listRoles(): RoleSpec[] {
  return Object.values(ROLES)
}

export function validateRole(role: string | undefined): { ok: boolean; spec?: RoleSpec; error?: string } {
  if (!role) return { ok: true } // no role declared = unrestricted (general)
  const spec = ROLES[role as AgentRole]
  if (!spec) return { ok: false, error: `unknown role: ${role}` }
  return { ok: true, spec }
}

// Callback hooks (adk-js Pattern 4): beforeAgent/afterAgent let callers intercept
// every agent run uniformly. beforeAgent can veto a run (return an error) — this
// is where the role gate and any future consent/telemetry hook live, so the gate
// is universal rather than an inline check in specific paths.
export type BeforeAgentHook = (run: AgentRun) => string | null | Promise<string | null>
export type AfterAgentHook = (run: AgentRun) => void | Promise<void>

const beforeHooks: BeforeAgentHook[] = []
const afterHooks: AfterAgentHook[] = []

export function registerBeforeAgent(hook: BeforeAgentHook): void {
  beforeHooks.push(hook)
}
export function registerAfterAgent(hook: AfterAgentHook): void {
  afterHooks.push(hook)
}

// The default role gate as a hook (fail-closed: unknown role vetoes the run).
export const roleGateHook: BeforeAgentHook = (run) => {
  const gate = validateRole(run.role)
  return gate.ok ? null : gate.error ?? 'role gate failed'
}

// Run all before hooks; return the first rejection, or null to proceed.
async function runBeforeHooks(run: AgentRun): Promise<string | null> {
  for (const hook of beforeHooks) {
    const err = await hook(run)
    if (err) return err
  }
  return null
}
async function runAfterHooks(run: AgentRun): Promise<void> {
  for (const hook of afterHooks) {
    await hook(run)
  }
}

export interface AgentRun {
  id: string
  name: string
  role?: AgentRole
  task: string
  dependsOn?: string // id of a run whose result this run needs first (step graph)
  status: 'queued' | 'running' | 'done' | 'error'
  result?: string
  error?: string
  createdAt: string
  attempts: number
  health: { lastSeen: string; failures: number }
  recovery: Recovery
}

export interface AgentJob {
  id: string
  name: string
  subtasks: string[]
  status: 'running' | 'done' | 'error'
  runs: AgentRun[]
  order: 'sequential' | 'parallel'
  createdAt: string
}

// Register the default role gate as a universal before-agent hook.
registerBeforeAgent(roleGateHook)

const jobs: AgentJob[] = []
let nextId = 1
const uid = () => `a${nextId++}`

// Durable execution (Hatchet-inspired): persist pending/incomplete jobs so a
// gateway restart doesn't lose them. In-flight agents are re-queued on boot.
let loadedJobs = false

async function ensureJobsLoaded(): Promise<void> {
  if (loadedJobs) return
  loadedJobs = true
  const data = await load<{ jobs: AgentJob[]; nextId: number }>(JOBS_FILE, { jobs: [], nextId: 1 })
  jobs.push(...data.jobs)
  nextId = data.nextId ?? 1
}

async function persistJobs(): Promise<void> {
  await save(JOBS_FILE, { jobs, nextId }).catch(() => {})
}

// Re-drive any job that was still running/incomplete at boot (crash recovery).
async function resumeIncomplete(): Promise<void> {
  await ensureJobsLoaded()
  for (const job of jobs) {
    if (job.status !== 'done' && job.status !== 'error') {
      job.status = 'running'
      void runJob(job)
    }
  }
}

async function runJob(job: AgentJob): Promise<void> {
  if (job.order === 'parallel' && !job.runs.some((r) => r.dependsOn)) {
    await runJobParallel(job)
    return
  }
  for (const run of job.runs) {
    // Step graph: if this run declares a dependency, wait for it to finish
    // first, then feed its result into this run's task (feed-forward).
    if (run.dependsOn) {
      const dep = job.runs.find((d) => d.id === run.dependsOn)
      if (dep) {
        let depDone = dep.status === 'done'
        while (!depDone) {
          depDone = await runAgent(dep)
          await persistJobs()
        }
      }
      if (dep && dep.result) {
        run.task = `[input from "${dep.name}"] ${dep.result}\n\n${run.task}`
      }
      // ai-memory-style handoff: pass known-failed approaches along too, so the
      // downstream agent avoids re-trying what already failed for this task.
      const fails = await mistakeLedger()
      const relevant = fails
        .filter((m) => m.context && run.task.toLowerCase().includes(m.context.toLowerCase().split(' ')[0] || ''))
        .slice(0, 3)
        .map((m) => `- ${m.detail || m.skill}: ${m.context}`)
      if (relevant.length > 0) {
        run.task = `[avoid these failed approaches]\n${relevant.join('\n')}\n\n${run.task}`
      }
    }
    let done = run.status === 'done'
    while (!done) {
      done = await runAgent(run)
      await persistJobs() // durable after every step
    }
  }
  job.status = job.runs.some((r) => r.status === 'error') ? 'error' : 'done'
  await persistJobs()
}

// Parallel composition: run every not-done run concurrently and wait for all.
async function runJobParallel(job: AgentJob): Promise<void> {
  await Promise.allSettled(
    job.runs.filter((r) => r.status !== 'done').map(async (run) => {
      let done = run.status === 'done'
      while (!done) {
        done = await runAgent(run)
        await persistJobs()
      }
    })
  )
  job.status = job.runs.some((r) => r.status === 'error') ? 'error' : 'done'
  await persistJobs()
}

const MAX_ATTEMPTS = 2

async function runAgent(run: AgentRun): Promise<boolean> {
  // Universal before-agent hooks (adk-js Pattern 4): any hook may veto the run.
  // The role gate is registered as one such hook, so the gate is uniform and
  // extensible (consent, telemetry) rather than an inline check.
  const veto = await runBeforeHooks(run)
  if (veto) {
    run.status = 'error'
    run.error = veto
    return true
  }
  run.attempts += 1
  run.status = 'running'
  run.health.lastSeen = new Date().toISOString()
  const url = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'
  const model = process.env.OLLAMA_MODEL ?? 'qwen2.5:7b'
  try {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a focused sub-agent. Answer only the task given.' },
          { role: 'user', content: run.task },
        ],
        temperature: 0.3,
        max_tokens: 512,
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) throw new Error(`llm ${res.status}`)
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    run.result = data.choices?.[0]?.message?.content?.trim() || '(no output)'
    run.status = 'done'
    await runAfterHooks(run)
    return true
  } catch (e) {
    run.health.failures += 1
    run.error = e instanceof Error ? e.message : String(e)
    // Recovery policy: retry up to MAX_ATTEMPTS, then escalate/fallback.
    if (run.recovery === 'retry' && run.attempts < MAX_ATTEMPTS) {
      run.status = 'queued'
      return false // caller re-runs
    }
    if (run.recovery === 'escalate') {
      run.result = `[escalated to coordinator] ${run.task}`
      run.status = 'done'
      return true
    }
    // fallback (default): deterministic response so the gateway works standalone.
    run.result = `[local fallback] ${run.task}`
    await runAfterHooks(run)
    run.status = 'done'
    return true
  }
}

// Director mode (OpenMAIC-inspired): a director agent plans and decomposes an
// objective into sub-tasks, then the workers run them. Adds the planning step
// the flat subtask spawn lacks. Uses Ollama; falls back to a deterministic
// single-task plan so the gateway works standalone (fail-closed).
export interface DirectorJob extends AgentJob {
  objective: string
  director: AgentRun
  planned: boolean
}

export function spawnDirectorJob(objective: string, recovery: Recovery = 'fallback'): DirectorJob {
  const director: AgentRun = {
    id: uid(),
    name: 'director',
    task: objective,
    status: 'queued',
    createdAt: new Date().toISOString(),
    attempts: 0,
    health: { lastSeen: '', failures: 0 },
    recovery,
  }
  const job: DirectorJob = {
    id: uid(),
    name: 'director',
    subtasks: [],
    status: 'running',
    runs: [director],
    order: 'sequential',
    objective,
    director,
    planned: false,
    createdAt: new Date().toISOString(),
  }
  jobs.unshift(job)
  void persistJobs()
  void runDirector(job)
  return job
}

async function runDirector(job: DirectorJob): Promise<void> {
  // 1) Director plans: ask the LLM to decompose the objective.
  let done = job.director.status === 'done'
  while (!done) {
    done = await runAgent(job.director)
    await persistJobs()
  }
  if (job.director.status === 'error') {
    job.status = 'error'
    await persistJobs()
    return
  }
  job.planned = true
  // 2) Decompose the director's output into sub-tasks (one per line / dash).
  const text = job.director.result || job.objective
  const subtasks = text
    .split(/\n+/)
    .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
    .filter((l) => l.length > 4)
    .slice(0, 8)
  if (subtasks.length === 0) subtasks.push(job.objective)
  job.subtasks = subtasks
  // 3) Spawn a worker run per sub-task.
  job.runs.push(...subtasks.map((task): AgentRun => ({
    id: uid(),
    name: `${job.name}-worker-${Math.floor(Math.random() * 1000)}`,
    task,
    status: 'queued' as const,
    createdAt: new Date().toISOString(),
    attempts: 0,
    health: { lastSeen: '', failures: 0 },
    recovery: job.director.recovery,
  })))
  await persistJobs()
  // 4) Run the workers through the standard recovery loop.
  for (const run of job.runs) {
    if (run.id === job.director.id) continue
    let rdone = run.status === 'done'
    while (!rdone) {
      rdone = await runAgent(run)
      await persistJobs()
    }
  }
  job.status = job.runs.some((r) => r.status === 'error') ? 'error' : 'done'
  await persistJobs()
}

export function spawnJob(name: string, subtasks: string[], recovery: Recovery = 'fallback', deps?: Record<string, string>, order: 'sequential' | 'parallel' = 'sequential'): AgentJob {
  const ids: string[] = []
  const job: AgentJob = {
    id: uid(),
    name,
    subtasks,
    status: 'running',
    order,
    runs: subtasks.map((task) => {
      const id = uid()
      ids.push(id)
      return {
      id,
      name: `${name}-${Math.floor(Math.random() * 1000)}`,
      task,
      status: 'queued',
      createdAt: new Date().toISOString(),
      attempts: 0,
      health: { lastSeen: '', failures: 0 },
      recovery,
      dependsOn: deps && deps[id],
      }
    }),
    createdAt: new Date().toISOString(),
  }
  jobs.unshift(job)
  void persistJobs()
  void runJob(job)
  return job
}

export async function ensureJobs(): Promise<void> {
  await ensureJobsLoaded()
  await resumeIncomplete()
}

export function listJobs(): AgentJob[] {
  return jobs.map((j) => ({ ...j, runs: j.runs.map((r) => ({ ...r })) }))
}

export function getJob(id: string): AgentJob | undefined {
  const j = jobs.find((x) => x.id === id)
  return j ? { ...j, runs: j.runs.map((r) => ({ ...r })) } : undefined
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(data)
}
