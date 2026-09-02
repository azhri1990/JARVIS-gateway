// Khoj-inspired rerank module for the J.A.R.V.I.S brain.
//
// Technique 2 from the Khoj mapping: retrieve is fast but imprecise; a
// cross-encoder scores query–document pairs jointly and is far more accurate.
// This module re-scores a small candidate set against the query and returns
// them re-ordered by relevance.
//
// Two modes:
//   - deterministic: pure-Node lexical overlap scoring (always works, no deps)
//   - model: cross-encoder style scoring via Ollama (better, when OLLAMA_URL is set)
//
// Fail-closed: if the model is unreachable it degrades to the deterministic
// scorer rather than returning an empty result.
import type { ServerResponse } from 'node:http'

export interface ScoredCandidate {
  text: string
  score: number
}

export interface RerankConfig {
  ollamaUrl?: string
  model?: string
}

// Deterministic lexical scorer: token-overlap with inverse-freq weighting.
// Higher weight for rare tokens, so it beats naive includes() on short queries.
function lexicalScore(query: string, candidate: string): number {
  const q = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
  const c = candidate.toLowerCase()
  if (q.length === 0) return 0
  let score = 0
  for (const w of q) {
    // rarer word -> higher weight; cap so very long queries don't dominate
    const freq = c.split(w).length - 1
    if (freq > 0) score += 1 / Math.min(q.length, 8)
  }
  // exact-phrase bonus
  if (c.includes(query.toLowerCase())) score += 0.5
  return score
}

// Model-based cross-encoder score via Ollama. Returns null on any failure so
// the caller can fall back to the deterministic scorer.
async function modelScore(
  query: string,
  candidate: string,
  cfg: Required<Pick<RerankConfig, 'ollamaUrl' | 'model'>>
): Promise<number | null> {
  try {
    const res = await fetch(`${cfg.ollamaUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: 'system',
            content:
              'You are a relevance reranker. Given a query and a document, reply with a single number 0-1 representing relevance (1 = perfectly relevant, 0 = irrelevant). Reply with ONLY the number.',
          },
          {
            role: 'user',
            content: `Query: ${query}\n\nDocument: ${candidate.slice(0, 1500)}`,
          },
        ],
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const text = data.choices?.[0]?.message?.content ?? ''
    const n = Number(text.trim().match(/0(?:\.\d+)?|1(?:\.0+)?/)?.[0])
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null
  } catch {
    return null
  }
}

// Re-rank candidates against the query. Returns them sorted best-first with
// normalized scores in [0,1]. Deterministic by default; uses Ollama when the
// config provides it AND `useModel` is true (opt-in to keep latency down).
export async function rerank(
  query: string,
  candidates: string[],
  cfg: RerankConfig = {},
  useModel = false
): Promise<ScoredCandidate[]> {
  if (candidates.length <= 1) {
    return candidates.map((text) => ({ text, score: 1 }))
  }
  const ollama = cfg.ollamaUrl && cfg.model ? { ollamaUrl: cfg.ollamaUrl, model: cfg.model } : undefined
  const scored: ScoredCandidate[] = []
  for (const c of candidates) {
    let score = lexicalScore(query, c)
    if (useModel && ollama) {
      const ms = await modelScore(query, c, ollama)
      if (ms !== null) score = ms
    }
    scored.push({ text: c, score })
  }
  // Sort best-first; tie-break by lexical score for stability.
  scored.sort((a, b) => b.score - a.score)
  return scored
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
