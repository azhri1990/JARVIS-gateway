// Frontmatter-driven memory store for the J.A.R.V.I.S gateway.
//
// Pipali Pattern 1: one durable fact per file as markdown with frontmatter.
// A CATALOGUE — `id (type): description` — is derived from on-disk files and
// stays in sync with what's stored, because it's generated from the files
// themselves. Bodies are pulled in on demand via a file-view endpoint.
//
//   - catalogue capped at 25KB (past this it stops being scannable)
//   - recall bodies capped at 8KB (past this they crowd the context)
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { STATE_DIR } from './store.js'

export const MEMORY_DIR = join(STATE_DIR, 'memory')
const CATALOGUE_CAP_BYTES = 25 * 1024
const RECALL_CAP_BYTES = 8 * 1024

export interface MemoryMeta {
  id: string
  type: 'lesson' | 'mistake' | 'fact' | 'experience'
  description: string
  skill?: string
  at: string
}

export interface MemoryEntry {
  meta: MemoryMeta
  body: string
}

async function ensureMemDir(): Promise<void> {
  await mkdir(MEMORY_DIR, { recursive: true })
}

// Serialize a memory entry to markdown with frontmatter.
export function serialize(meta: MemoryMeta, body: string): string {
  const fm = [
    '---',
    `id: ${meta.id}`,
    `type: ${meta.type}`,
    `description: "${meta.description.replace(/"/g, '\\"')}"`,
    ...(meta.skill ? [`skill: ${meta.skill}`] : []),
    `at: ${meta.at}`,
    '---',
    '',
    body.trim(),
    '',
  ].join('\n')
  return fm
}

// Parse frontmatter + body from a markdown memory file.
export function parse(raw: string): MemoryEntry {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
  if (!m) throw new Error('malformed memory file')
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"|"$/g, '')
  }
  return {
    meta: {
      id: meta.id,
      type: (meta.type as MemoryMeta['type']) ?? 'fact',
      description: meta.description ?? '',
      skill: meta.skill,
      at: meta.at ?? new Date().toISOString(),
    },
    body: m[2].trim(),
  }
}

// SHA-256 of a string — memlawb-style, used for delta dedup and flat filenames.
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

// Write one memory entry to disk as <id>.md. memlawb-inspired true-delta: if the
// serialized content is byte-identical to what's already on disk (same hash), the
// write is skipped — no redundant persist, and recall/catalogue stay stable.
export async function writeMemory(meta: MemoryMeta, body: string): Promise<string> {
  await ensureMemDir()
  const file = join(MEMORY_DIR, `${meta.id}.md`)
  const content = serialize(meta, body)
  try {
    const existing = await readFile(file, 'utf8')
    if (sha256Hex(existing) === sha256Hex(content)) return file // true delta — skip
  } catch {
    /* no existing file — write fresh */
  }
  await writeFile(file, content, 'utf8')
  return file
}

// Derive the catalogue from on-disk files — id (type): description, capped.
export async function catalogue(): Promise<{ lines: string[]; bytes: number; count: number; capped: boolean }> {
  await ensureMemDir()
  const files = (await readdir(MEMORY_DIR)).filter((f) => f.endsWith('.md'))
  const lines: string[] = []
  let bytes = 0
  let capped = false
  for (const f of files) {
    try {
      const raw = await readFile(join(MEMORY_DIR, f), 'utf8')
      const { meta } = parse(raw)
      const line = `${meta.id} (${meta.type}): ${meta.description}`
      if (bytes + line.length > CATALOGUE_CAP_BYTES) {
        capped = true
        break
      }
      lines.push(line)
      bytes += line.length
    } catch {
      /* skip a corrupt memory file, don't fail the catalogue */
    }
  }
  return { lines, bytes, count: lines.length, capped }
}

// Pull one memory body on demand, capped for recall.
export async function recall(id: string): Promise<MemoryEntry | null> {
  const file = join(MEMORY_DIR, `${id}.md`)
  try {
    const raw = await readFile(file, 'utf8')
    const entry = parse(raw)
    if (entry.body.length > RECALL_CAP_BYTES) entry.body = entry.body.slice(0, RECALL_CAP_BYTES) + '…'
    return entry
  } catch {
    return null
  }
}

export async function listMemory(): Promise<MemoryEntry[]> {
  await ensureMemDir()
  const files = (await readdir(MEMORY_DIR)).filter((f) => f.endsWith('.md'))
  const out: MemoryEntry[] = []
  for (const f of files) {
    try {
      const raw = await readFile(join(MEMORY_DIR, f), 'utf8')
      out.push(parse(raw))
    } catch {
      /* skip corrupt */
    }
  }
  return out
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// --- Scoped memory (restored: the gateway's original /memory API) ---
// Kept alongside the frontmatter store so existing /memory clients keep working.
export interface ScopedMemory {
  scope: string
  content: string
  at: string
}

export async function saveMemory(scope: string, content: string): Promise<ScopedMemory> {
  await ensureMemDir()
  const file = join(MEMORY_DIR, `scope-${scope.replace(/[^a-z0-9-]/gi, '_')}.json`)
  const mem: ScopedMemory = { scope, content, at: new Date().toISOString() }
  await writeFile(file, JSON.stringify(mem, null, 2), 'utf8')
  return mem
}

export async function recallMemories(scope?: string): Promise<ScopedMemory[]> {
  await ensureMemDir()
  const files = (await readdir(MEMORY_DIR)).filter((f) => f.startsWith('scope-') && f.endsWith('.json'))
  const out: ScopedMemory[] = []
  for (const f of files) {
    try {
      const mem = JSON.parse(await readFile(join(MEMORY_DIR, f), 'utf8')) as ScopedMemory
      if (!scope || mem.scope === scope) out.push(mem)
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}

export async function listScopes(): Promise<string[]> {
  const mems = await recallMemories()
  return [...new Set(mems.map((m) => m.scope))]
}

// --- MemoryService (adk-js Pattern 3) ---
// A swappable memory backend behind one contract, so J.A.R.V.I.S can swap the
// frontmatter store, scoped store, or a future embedding backend without the
// executor caring which is active.
export interface MemoryService {
  save(meta: MemoryMeta, body: string): Promise<string>
  recall(id: string): Promise<MemoryEntry | null>
  list(): Promise<MemoryEntry[]>
  catalogueSummary(): Promise<{ count: number; bytes: number; capped: boolean }>
}

// Frontmatter-backed implementation over the existing on-disk memory store.
export const frontmatterMemoryService: MemoryService = {
  save: (meta, body) => writeMemory(meta, body),
  recall: (id) => recall(id),
  list: () => listMemory(),
  catalogueSummary: async () => {
    const c = await catalogue()
    return { count: c.count, bytes: c.bytes, capped: c.capped }
  },
}

// In-memory fallback service (used when the disk store is unavailable).
export const inMemoryService: MemoryService = {
  save: async (meta, body) => {
    const entries = new Map<string, MemoryEntry>()
    entries.set(meta.id, { meta, body })
    return meta.id
  },
  recall: async () => null,
  list: async () => [],
  catalogueSummary: async () => ({ count: 0, bytes: 0, capped: false }),
}

// Active service — swap here or via setActiveMemoryService().
let activeMemoryService: MemoryService = frontmatterMemoryService
export function setActiveMemoryService(svc: MemoryService): void {
  activeMemoryService = svc
}
export function getActiveMemoryService(): MemoryService {
  return activeMemoryService
}
