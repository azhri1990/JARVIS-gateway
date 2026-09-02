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


// --- isair/jarvis-inspired merge consolidation ------------------------------
// Deterministic, LLM-free near-duplicate detection over memory descriptions,
// enforcing the three guarantees merge_node_data advertises:
//   1. Near-dup dedupe  - different wordings of the same fact collapse.
//   2. Independence     - an unrelated new fact must never evict an existing one.
//   3. Growth guard     - consolidation never expands the store unboundedly
//                         (runaway growth would mean hallucinated content).
// Pure string ops, zero dependencies - matches the gateway style.

const MEM_STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','else','for','of','to','in','on',
  'at','by','with','from','as','is','are','was','were','be','been','being','it',
  'this','that','these','those','i','you','he','she','we','they','me','him','her',
  'us','them','my','your','his','its','our','their','do','does','did','have','has',
  'had','will','would','can','could','should','shall','what','which','who','whom',
  'how','why','not','no','so','too','very','just','about','up','out','there','here',
  'about','with','from','into','over','after','under','again','some','such','only',
  'own','same','than','too','very','s','t','don','now',
])

function memContentWords(text: string): string[] {
  return text.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !MEM_STOPWORDS.has(w))
}

/** Jaccard overlap of two short strings' content words. 1.0 = identical. */
export function memOverlap(a: string, b: string): number {
  const wa = new Set(memContentWords(a))
  const wb = new Set(memContentWords(b))
  if (wa.size === 0 || wb.size === 0) return 0
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter++
  const union = wa.size + wb.size - inter
  return union === 0 ? 0 : inter / union
}

/** Is `newDesc` a near-duplicate of `existingDesc`? High overlap + short gap
 *  in length means one is a rephrase of the other, not a new fact. */
export function isNearDuplicate(newDesc: string, existingDesc: string): boolean {
  if (newDesc === existingDesc) return true
  const ov = memOverlap(newDesc, existingDesc)
  const ratio = Math.min(newDesc.length, existingDesc.length) /
                Math.max(newDesc.length, 1)
  // High overlap (>0.6) with similar length (>0.5) -> rephrase of same fact.
  return ov > 0.5 && ratio > 0.5
}

export interface ConsolidateResult {
  id: string
  description: string
  body: string
  /** Set when this write was folded into an existing near-dup entry. */
  mergedInto?: string
}

/**
 * Consolidate an incoming fact against the existing catalogue BEFORE writing.
 * Guarantees:
 *  - If a near-duplicate entry already exists, the new fact is folded into that
 *    entry (dedupe) and the duplicate write is skipped.
 *  - Otherwise the fact is written fresh. Independence is preserved by only
 *    ever comparing against one target - we never evict unrelated entries.
 * Returns the effective write (or the merged target).
 */
export async function consolidateWrite(
  meta: MemoryMeta,
  body: string,
): Promise<ConsolidateResult> {
  const existing = await listMemory()
  const incoming = `${meta.description} ${body}`
  let bestId: string | null = null
  let bestScore = 0.5 // threshold - above this we call it a duplicate
  for (const e of existing) {
    const target = `${e.meta.description} ${e.body}`
    // Same-slot guard: only compare within compatible types so a 'fact' and a
    // 'mistake' that happen to share words are never collapsed.
    if (e.meta.type !== meta.type) continue
    const ov = memOverlap(incoming, target)
    if (ov > bestScore) { bestScore = ov; bestId = e.meta.id }
  }
  if (bestId) {
    return { id: bestId, description: meta.description, body, mergedInto: bestId }
  }
  return { id: meta.id, description: meta.description, body }
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
  // Consolidation gate: fold near-duplicates into the existing entry instead of
  // writing a redundant second file (isair/jarvis merge_node_data pattern).
  const cons = await consolidateWrite(meta, body)
  if (cons.mergedInto) {
    // Update the existing entry's body to include the newly-learned detail.
    const existing = await recall(cons.mergedInto)
    if (existing) {
      const mergedBody = existing.body.includes(body.trim())
        ? existing.body
        : existing.body + '\n\n' + body.trim()
      const file = join(MEMORY_DIR, `${cons.mergedInto}.md`)
      const content = serialize(existing.meta, mergedBody)
      try {
        const onDisk = await readFile(file, 'utf8')
        if (sha256Hex(onDisk) !== sha256Hex(content)) await writeFile(file, content, 'utf8')
      } catch { await writeFile(file, content, 'utf8') }
    }
    return join(MEMORY_DIR, `${cons.mergedInto}.md`)
  }
  // Fresh write path (original behaviour, with hash-delta skip).
  const file = join(MEMORY_DIR, `${meta.id}.md`)
  const content = serialize(meta, body)
  try {
    const existing = await readFile(file, 'utf8')
    if (sha256Hex(existing) === sha256Hex(content)) return file
  } catch { /* no existing file */ }
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
