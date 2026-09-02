// Recall gate (isair/jarvis-inspired) — a deterministic, LLM-free decision on
// whether an expensive memory/retrieval pass is worth running for a query.
//
// Purpose: prevent "context rot" — skipping recall when it would add cost and
// context bloat for no new information. Fail-open: if the gate itself errors,
// recall runs anyway ("if in doubt, recall"). Stopword-only queries can never
// be gated off. Pure string ops — zero dependencies, fits the gateway's style.

const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','else','for','of','to','in','on',
  'at','by','with','from','as','is','are','was','were','be','been','being','it',
  'this','that','these','those','i','you','he','she','we','they','me','him','her',
  'us','them','my','your','his','its','our','their','do','does','did','have','has',
  'had','will','would','can','could','should','shall','what','which','who','whom',
  'how','why','not','no','so','too','very','just','about','up','out','there','here',
  'please','tell','me','give','show','find','help','want','need','like','get','say',
])

// Extract meaningful content words from text, lowercased, length-filtered.
function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
}

// True when the recent window contains at least one tool-result message.
export function hasFreshToolResult(recentMessages: Array<{ role?: string; toolResult?: unknown }>): boolean {
  return recentMessages.some((m) => m.role === 'tool' || m.toolResult !== undefined)
}

// Jaccard overlap between two word sets: |A ∩ B| / |A ∪ B|.
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  return inter / (a.size + b.size - inter)
}

// Decide whether recall should run for this query.
//   query          — the user's question / advice subject
//   recentWindow   — the recent message/tool window (hot window)
//   minCoverage    — required Jaccard overlap of query words vs window words (default 0.1)
// Returns true to run recall, false to skip it (context-rot guard).
export function shouldRecall(
  query: string,
  recentWindow: Array<{ role?: string; text?: string; toolResult?: unknown }>,
  minCoverage = 0.1,
): boolean {
  try {
    // 1) Fresh tool result in the hot window is a precondition.
    if (!hasFreshToolResult(recentWindow)) return false
    // 2) Build the window word bag (concatenate message text).
    const windowWords = new Set(contentWords(recentWindow.map((m) => m.text ?? '').join(' ')))
    const qWords = contentWords(query)
    // 3) Stopword-only query can never skip recall (fail toward remembering).
    if (qWords.length === 0) return true
    // 4) Fail open: window has no content words → recall anyway.
    if (windowWords.size === 0) return true
    // 5) Require minimum coverage of the query's words in the window.
    return jaccard(new Set(qWords), windowWords) >= minCoverage
  } catch {
    return true // fail open: if in doubt, recall
  }
}
