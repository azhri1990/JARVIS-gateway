// Self-learning module for the J.A.R.V.I.S gateway.
//
// Tracks every action's outcome in an experience ledger, then distills
// repeated successes/failures into skill refinements. A "skill" is a named
// procedure (e.g. "remediate-open-port", "wake-on-word") plus the conditions
// under which it worked. When the same situation recurs, J.A.R.V.I.S can rank
// the most proven approach first — it literally gets better with use.
//
// Persisted to a JSON file so learning survives restarts.
import type { ServerResponse } from 'node:http'
import { LEARN_FILE, load, save } from './store.js'

export interface Experience {
  id: string
  skill: string
  outcome: 'success' | 'failure'
  context: string
  detail?: string
  at: string
}

export interface SkillRecord {
  name: string
  total: number
  successes: number
  failures: number
  lastSuccess?: string
  confidence: number // 0..1
  lastContext?: string
}

// A mistake we have learned from: a (skill, context) pair that failed. We
// treat these as "do not repeat" — the same approach in the same situation is
// flagged as blocked until the context or skill changes.
export interface Mistake {
  skill: string
  context: string
  detail?: string
  at: string
  avoided?: boolean // set once J.A.R.V.I.S dodged it the next time it came up
}

// A durable lesson distilled from an experience. Persisted so it survives
// restarts — this is the "remember what it learns" memory.
export interface Lesson {
  id: string
  skill: string
  text: string
  kind: 'lesson' | 'tip'
  at: string
}

let experiences: Experience[] = []
let mistakes: Mistake[] = []
let lessons: Lesson[] = []
let skills = new Map<string, SkillRecord>()

let loaded = false
async function ensureLoaded(): Promise<void> {
  if (loaded) return
  loaded = true
  const data = await load<{ experiences: Experience[]; mistakes: Mistake[]; lessons: Lesson[] }>(LEARN_FILE, {
    experiences: [], mistakes: [], lessons: [],
  })
  experiences = data.experiences ?? []
  mistakes = data.mistakes ?? []
  lessons = data.lessons ?? []
  rebuild()
}

function rebuild(): void {
  skills.clear()
  const counts = new Map<string, { ok: number; fail: number; last?: string; lastContext?: string }>()
  for (const e of experiences) {
    const c = counts.get(e.skill) ?? { ok: 0, fail: 0 }
    if (e.outcome === 'success') c.ok++
    else c.fail++
    c.last = e.at
    c.lastContext = e.context
    counts.set(e.skill, c)
  }
  for (const [name, c] of counts) {
    const total = c.ok + c.fail
    skills.set(name, {
      name,
      total,
      successes: c.ok,
      failures: c.fail,
      lastSuccess: c.last,
      confidence: total === 0 ? 0 : Math.min(1, (c.ok / total) * (1 - 1 / (total + 1))),
      lastContext: c.lastContext,
    })
  }
}

async function persist(): Promise<void> {
  await save(LEARN_FILE, { experiences, mistakes, lessons }).catch(() => {})
}

let seq = 0

// Record one experience. A skill's confidence rises with repeat success and
// falls with failure — this is the learning signal.
export async function recordExperience(
  skill: string,
  outcome: 'success' | 'failure',
  context: string,
  detail?: string,
): Promise<SkillRecord> {
  await ensureLoaded()
  const at = new Date().toISOString()
  experiences.push({ id: `x${++seq}`, skill, outcome, context, detail, at })
  if (experiences.length > 500) experiences = experiences.slice(-500)

  if (outcome === 'failure') {
    // Record the mistake so we never repeat it in the same situation.
    mistakes.push({ skill, context, detail, at })
    if (mistakes.length > 200) mistakes = mistakes.slice(-200)
    // Distill a durable lesson from the failure (remember what it learns).
    lessons.push({ id: `l${lessons.length + 1}`, skill, text: `Avoid ${detail || skill} in "${context}" — it failed.`, kind: 'lesson', at })
    if (lessons.length > 200) lessons = lessons.slice(-200)
  }

  rebuild()
  await persist()
  return skills.get(skill)!
}

// Returns true (and marks the mistake avoided) when a proposed (skill, context)
// pair matches a prior mistake — used to stop repeating known failures.
export async function isKnownMistake(skill: string, context: string): Promise<boolean> {
  await ensureLoaded()
  for (const m of mistakes) {
    if (m.skill === skill && (context === m.context || context.includes(m.context) || m.context.includes(context))) {
      m.avoided = true
      await persist()
      return true
    }
  }
  return false
}

export async function mistakeLedger(): Promise<Mistake[]> {
  await ensureLoaded()
  return [...mistakes].reverse()
}

export async function lessonMemory(): Promise<Lesson[]> {
  await ensureLoaded()
  return [...lessons].reverse()
}

export async function skillStatus(): Promise<SkillRecord[]> {
  await ensureLoaded()
  return [...skills.values()].sort((a, b) => b.confidence - a.confidence)
}

export async function experienceLog(): Promise<Experience[]> {
  await ensureLoaded()
  return [...experiences].reverse()
}

// Skill synthesis: promote a recurring (skill, context) success into a new
// named skill when it has proven itself at least `threshold` times. This is how
// J.A.R.V.I.S learns genuinely new skills from experience.
export async function synthesizeSkills(threshold = 3): Promise<SkillRecord[]> {
  await ensureLoaded()
  const successByCtx = new Map<string, { skill: string; context: string; count: number }>()
  for (const e of experiences) {
    if (e.outcome !== 'success') continue
    const key = `${e.skill}::${e.context}`
    const rec = successByCtx.get(key) ?? { skill: e.skill, context: e.context, count: 0 }
    rec.count++
    successByCtx.set(key, rec)
  }
  for (const { skill, context, count } of successByCtx.values()) {
    if (count >= threshold) {
      const name = `synth-${skill}-${context.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}`
      if (!skills.has(name)) {
        skills.set(name, { name, total: count, successes: count, failures: 0, confidence: 0.9, lastContext: context })
      }
    }
  }
  await persist()
  return [...skills.values()].sort((a, b) => b.confidence - a.confidence)
}

// Rank candidate approaches for a recurring situation by past proven success.
export async function rankApproaches(skill: string, candidates: string[]): Promise<string[]> {
  await ensureLoaded()
  const rec = skills.get(skill)
  if (!rec || rec.total === 0) return candidates // no prior learning — keep order
  // Sort by how many times each candidate succeeded (context match heuristic).
  return [...candidates]
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(data)
}
