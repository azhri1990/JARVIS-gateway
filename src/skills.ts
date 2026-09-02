// SKILL.md loader for the J.A.R.V.I.S gateway (pipali Pattern 3).
//
// Scans a skills directory for `SKILL.md` files, parses frontmatter
// (name/description/triggers), validates each, and loads them. One bad skill
// never breaks the load — errors are collected per-skill. This is the loader
// that lets J.A.R.V.I.S clone agent skills from GitHub: drop a skills dir,
// scan, validate, load.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { STATE_DIR } from './store.js'

export const SKILLS_DIR = process.env.JARVIS_SKILLS_DIR || join(STATE_DIR, 'skills')

export interface SkillFrontmatter {
  name: string
  description: string
  triggers?: string[]
  requires?: string[]
}

export interface Skill {
  id: string
  name: string
  description: string
  triggers: string[]
  requires: string[]
  path: string
  body: string
}

export interface SkillLoadError {
  id: string
  reason: string
}

export interface SkillLoadResult {
  skills: Skill[]
  errors: SkillLoadError[]
}

let cache: SkillLoadResult = { skills: [], errors: [] }
let scanned = false

// Parse frontmatter from a SKILL.md file.
export function parseSkillFrontmatter(raw: string): { fm: Partial<SkillFrontmatter>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
  if (!m) return { fm: {}, body: raw }
  const fm: Record<string, unknown> = {}
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let val: unknown = line.slice(idx + 1).trim().replace(/^"|"$/g, '')
    if (key === 'triggers' || key === 'requires') {
      // support `triggers: a, b, c` and YAML-ish list `- a`
      val = String(val)
        .split(/[,\n]/)
        .map((s) => s.replace(/^-\s*/, '').trim())
        .filter(Boolean)
    }
    fm[key] = val
  }
  return { fm: fm as Partial<SkillFrontmatter>, body: m[2].trim() }
}

// Validate + load a single SKILL.md file. Returns skill or an error.
export async function loadSkillFile(filePath: string): Promise<Skill | SkillLoadError> {
  const id = join(filePath).replace(/[\\/]/g, '/').split('/').slice(-2, -1)[0] || filePath
  try {
    const raw = await readFile(filePath, 'utf8')
    const { fm, body } = parseSkillFrontmatter(raw)
    if (!fm.name) return { id, reason: 'missing frontmatter name' }
    if (!fm.description) return { id, reason: 'missing frontmatter description' }
    return {
      id,
      name: fm.name,
      description: fm.description,
      triggers: fm.triggers ?? [],
      requires: fm.requires ?? [],
      path: filePath,
      body,
    }
  } catch (e) {
    return { id, reason: String(e) }
  }
}

// Scan the skills dir for SKILL.md files and load them, collecting errors.
export async function scanSkills(): Promise<SkillLoadResult> {
  const result: SkillLoadResult = { skills: [], errors: [] }
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(SKILLS_DIR, { withFileTypes: true })
  } catch {
    // No skills dir yet — that's fine, not an error.
    cache = result
    scanned = true
    return result
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const skillFile = join(SKILLS_DIR, ent.name, 'SKILL.md')
    const loaded = await loadSkillFile(skillFile)
    if ('name' in loaded) result.skills.push(loaded)
    else result.errors.push(loaded)
  }
  cache = result
  scanned = true
  return result
}

// Get loaded skills, scanning on first use (cached thereafter).
export async function getSkills(): Promise<SkillLoadResult> {
  if (!scanned) return scanSkills()
  return cache
}

// Match a query against skill names + triggers.
export function matchSkills(query: string): Skill[] {
  const q = query.toLowerCase()
  return cache.skills.filter(
    (s) => s.name.toLowerCase().includes(q) || s.triggers.some((t) => q.includes(t.toLowerCase()))
  )
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
