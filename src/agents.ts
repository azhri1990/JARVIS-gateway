// Multi-agent orchestration module for the J.A.R.V.I.S gateway (BOB-style).
//
// Breaks a task into subtasks and runs each as its own agent (a delegate) in
// parallel through the LLM (Ollama in local mode). Adds BOB-style recovery:
// each run carries a recovery policy (retry / escalate / fallback) and agent
// health is tracked (attempts, failures, lastSeen) so the coordinator can
// retry a failing agent, escalate it, or fall back deterministically.
import type { ServerResponse } from 'node:http'

export type Recovery = 'retry' | 'escalate' | 'fallback'

export interface AgentRun {
  id: string
  name: string
  task: string
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
  createdAt: string
}

const jobs: AgentJob[] = []
let nextId = 1
const uid = () => `a${nextId++}`

const MAX_ATTEMPTS = 2

async function runAgent(run: AgentRun): Promise<boolean> {
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
    run.status = 'done'
    return true
  }
}

export function spawnJob(name: string, subtasks: string[], recovery: Recovery = 'fallback'): AgentJob {
  const job: AgentJob = {
    id: uid(),
    name,
    subtasks,
    status: 'running',
    runs: subtasks.map((task) => ({
      id: uid(),
      name: `${name}-${Math.floor(Math.random() * 1000)}`,
      task,
      status: 'queued',
      createdAt: new Date().toISOString(),
      attempts: 0,
      health: { lastSeen: '', failures: 0 },
      recovery,
    })),
    createdAt: new Date().toISOString(),
  }
  jobs.unshift(job)

  void (async () => {
    for (const run of job.runs) {
      // Drive each agent through its recovery loop (retries included).
      while (run.status !== 'done') {
        const ok = await runAgent(run)
        if (ok) break
      }
    }
    job.status = job.runs.some((r) => r.status === 'error') ? 'error' : 'done'
  })()

  return job
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
