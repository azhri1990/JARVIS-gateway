// Khoj-inspired content chunker for the J.A.R.V.I.S brain.
//
// Splits documents into embeddable entries the way Khoj does (and does well):
//   1. Token-budget recursive splitting in preference order paragraphs ->
//      sentences -> words, with a heading-ancestry prefix on every chunk.
//   2. Noise stripped first: words longer than 500 chars are dropped.
//
// Pure Node stdlib — no dependencies, matching the gateway's footprint. The
// output entries are exactly what a memory engine embeds and later retrieves,
// so chunk quality directly lifts retrieval precision.
import type { ServerResponse } from 'node:http'

export interface ChunkEntry {
  text: string // heading-prefixed chunk, ready to embed
  raw: string // the chunk without the heading prefix (for display)
  heading: string // the heading ancestry path (e.g. "Chapter 3 · Cost controls")
  tokenCount: number
}

const MAX_WORD_LEN = 500

// Cheap whitespace token count — close enough for chunk budgeting without a
// tokenizer dependency.
export function tokenCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}

function stripNoise(text: string): string {
  // Preserve line structure (markdown headings depend on it) while dropping
  // over-long "words". Operate per-line so \n is never collapsed.
  return text
    .split('\n')
    .map((line) => line.split(/\s+/).filter((w) => w.length <= MAX_WORD_LEN).join(' '))
    .join('\n')
}

// Split a body into pieces each under `budget` tokens, preferring paragraph,
// then sentence, then word boundaries (Khoj's recursive splitter order).
function splitByBudget(text: string, budget: number): string[] {
  if (tokenCount(text) <= budget) return [text]

  // Prefer paragraph breaks.
  const byParagraph = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
  if (byParagraph.length > 1) {
    const out: string[] = []
    let carry = ''
    for (const p of byParagraph) {
      const candidate = carry ? `${carry}\n\n${p}` : p
      if (tokenCount(candidate) <= budget) carry = candidate
      else {
        if (carry) out.push(carry)
        out.push(...splitByBudget(p, budget))
        carry = ''
      }
    }
    if (carry) out.push(carry)
    return out
  }

  // Then sentence boundaries.
  const bySentence = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? []
  if (bySentence.length > 1) {
    const out: string[] = []
    let carry = ''
    for (const sent of bySentence) {
      const candidate = carry ? `${carry} ${sent}` : sent
      if (tokenCount(candidate) <= budget) carry = candidate
      else {
        if (carry) out.push(carry)
        out.push(...splitByBudget(sent, budget))
        carry = ''
      }
    }
    if (carry) out.push(carry)
    return out
  }

  // Finally word boundaries.
  const words = text.split(/\s+/)
  const out: string[] = []
  let carry: string[] = []
  let count = 0
  for (const w of words) {
    if (count + 1 > budget) {
      if (carry.length) out.push(carry.join(' '))
      carry = [w]
      count = 1
    } else {
      carry.push(w)
      count += 1
    }
  }
  if (carry.length) out.push(carry.join(' '))
  return out
}

// Chunk a full document. `markdown` is optional; when set, the #-heading
// ancestry is extracted and prepended to each chunk (Khoj's key precision win).
export function chunkDocument(
  document: string,
  opts: { maxTokens?: number; markdown?: boolean } = {}
): ChunkEntry[] {
  const budget = opts.maxTokens ?? 256
  const clean = stripNoise(document)

  if (!opts.markdown) {
    return splitByBudget(clean, budget).map((text) => ({
      text,
      raw: text,
      heading: '',
      tokenCount: tokenCount(text),
    }))
  }

  // Extract heading ancestry: build a path of # headings, and chunk each
  // section's body with its ancestry prefix.
  const lines = clean.split('\n')
  const ancestry: string[] = []
  const entries: ChunkEntry[] = []

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line)
    if (m) {
      const level = m[1].length
      ancestry.splice(level - 1) // drop deeper headings
      ancestry[level - 1] = m[2].trim()
      ancestry.length = level
      continue
    }
    if (!line.trim()) continue
    const heading = ancestry.join(' · ')
    const body = splitByBudget(line, budget)
    for (const part of body) {
      const raw = part
      const text = heading ? `${heading}\n${part}` : part
      entries.push({ text, raw, heading, tokenCount: tokenCount(text) })
    }
  }
  return entries
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
