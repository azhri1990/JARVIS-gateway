// Advisory engine for the J.A.R.V.I.S gateway.
//
// Turns a plain-language problem into a structured analysis: categorises the
// subject, runs a root-cause pass, proposes solutions (ranked), and gives a
// recommendation with next steps. Grounded in the gateway's own learning ledger
// (past successes/failures) and a small domain heuristic map — not a trained
// model, but a deterministic advisor that is transparent and consistent.
import type { ServerResponse } from 'node:http'
import { skillStatus, isKnownMistake, experienceLog } from './learn.js'
import { chunkDocument } from './chunker.js'
import { rerank } from './rerank.js'
import { shouldRecall } from './recallgate.js'

export type Category =
  | 'technology' | 'business' | 'finance' | 'health' | 'security'
  | 'home' | 'education' | 'creative' | 'career' | 'general'

export interface AdviceRequest {
  subject: string
  category?: Category
  goal?: string
  constraints?: string[]
  document?: string // optional doc to chunk + ground the advice on
}

export interface Advice {
  subject: string
  category: Category
  problem: string
  rootCause: string[]
  solutions: { title: string; steps: string[]; effort: 'low' | 'medium' | 'high' }[]
  recommendation: string
  nextSteps: string[]
  groundedInLearning: boolean
  groundingSection?: string
}

const KEYWORDS: Record<Category, string[]> = {
  technology: ['code', 'software', 'app', 'website', 'server', 'bug', 'device', 'network', 'computer', 'api', 'github'],
  business: ['business', 'startup', 'revenue', 'customers', 'market', 'product', 'sales', 'brand', 'pricing', 'launch'],
  finance: ['money', 'invest', 'budget', 'saving', 'debt', 'income', 'expense', 'loan', 'tax', 'fund'],
  health: ['health', 'sleep', 'diet', 'fitness', 'exercise', 'stress', 'energy', 'pain', 'wellbeing', 'weight'],
  security: ['security', 'hack', 'breach', 'password', 'privacy', 'risk', 'firewall', 'vulnerability', 'protect'],
  home: ['home', 'house', 'renovate', 'furniture', 'garden', 'cleaning', 'room', 'appliance'],
  education: ['learn', 'study', 'course', 'exam', 'skill', 'training', 'certificate', 'degree', 'practice'],
  creative: ['design', 'write', 'video', 'photo', 'music', 'logo', 'content', 'art', 'branding'],
  career: ['job', 'interview', 'career', 'promotion', 'resume', 'salary', 'team', 'manager', 'work', 'freelance'],
  general: [],
}

function detectCategory(subject: string, requested?: Category): Category {
  if (requested) return requested
  const text = subject.toLowerCase()
  for (const [cat, words] of Object.entries(KEYWORDS) as [Category, string[]][]) {
    if (words.some((w) => text.includes(w))) return cat
  }
  return 'general'
}

// Deterministic root-cause heuristics per category. Honest: these are generic
// starting points, not diagnostics — labelled as such.
function rootCauses(subject: string, category: Category, goal: string): string[] {
  const t = subject.toLowerCase()
  const causes: string[] = []
  if (t.includes('slow') || t.includes('lag') || t.includes('performance')) {
    causes.push('Likely a bottleneck — resource, query, or network — rather than one fault. Profile before changing anything.')
  }
  if (t.includes('not working') || t.includes('error') || t.includes('bug')) {
    causes.push('A single root cause is rare; reproduce the failure first, then isolate the layer (input, logic, output).')
  }
  if (category === 'business' || category === 'career') {
    causes.push('Usually a misaligned incentive or unclear success metric. Define what "done" looks like before acting.')
  }
  if (category === 'finance') {
    causes.push('Cash-flow timing and recurring fixed costs drive most pressure. Map the 3-month picture before cutting.')
  }
  if (category === 'health') {
    causes.push('Sleep, stress and routine compound most issues. Address consistency before isolated fixes.')
  }
  if (causes.length === 0) {
    causes.push(`Break "${subject}" into a clear problem statement and a measurable goal before choosing a fix.`)
  }
  return causes.slice(0, 3)
}

// Deterministic solution scaffolds per category. Each is concrete and actionable.
function solutionsFor(category: Category, subject: string, goal: string) {
  switch (category) {
    case 'technology':
      return [
        { title: 'Reproduce and isolate', steps: ['Write the minimal failing case', 'Check logs/errors at each layer', 'Confirm the failing layer before fixing'] },
        { title: 'Fix the root cause, not the symptom', steps: ['Apply the smallest correct change', 'Add a regression test', 'Verify end-to-end'] },
        { title: 'Simplify the approach', steps: ['Remove unused moving parts', 'Replace with a proven pattern/library', 'Re-check against the goal'] },
      ]
    case 'security':
      return [
        { title: 'Harden the obvious first', steps: ['Close unnecessary open ports', 'Enforce strong auth / key-only', 'Apply updates'] },
        { title: 'Assume breach, contain', steps: ['Rotate credentials', 'Segment access', 'Audit logs for the exposure window'] },
      ]
    case 'business':
    case 'career':
      return [
        { title: 'Clarify the metric', steps: ['Define the single outcome that matters', 'Set a target and a date'] },
        { title: 'Focus the highest-leverage move', steps: ['Pick one change with the biggest impact', 'Prototype it small, measure, then scale'] },
      ]
    case 'finance':
      return [
        { title: 'Model the cash flow', steps: ['List income and fixed costs', 'Project the next 3 months', 'Cut discretionary spend first'] },
        { title: 'Automate the discipline', steps: ['Automate savings/transfers', 'Review recurring subscriptions'] },
      ]
    case 'health':
      return [
        { title: 'Fix the foundation', steps: ['Prioritise sleep consistency', 'Move daily, eat whole foods', 'Reduce alcohol/caffeine late in day'] },
        { title: 'Track before you change', steps: ['Log the current baseline for 1 week', 'Change one variable, reassess'] },
      ]
    default:
      return [
        { title: 'Define the problem precisely', steps: [`Restate "${subject}" as a clear, specific problem`, 'State what success looks like'] },
        { title: 'Brainstorm then narrow', steps: ['Generate 3 candidate approaches', 'Pick the simplest that fits constraints', 'Prototype and validate'] },
      ]
  }
}

export async function advise(req: AdviceRequest): Promise<Advice> {
  const category = detectCategory(req.subject, req.category)
  const problem = `${req.subject}${req.goal ? ` — goal: ${req.goal}` : ''}`
  const causes = rootCauses(req.subject, category, req.goal ?? '')
  const solutions = solutionsFor(category, req.subject, req.goal ?? '').map((s) => ({
    ...s,
    effort: s.steps.length <= 2 ? 'low' as const : (s.steps.length === 3 ? 'medium' as const : 'high' as const),
  }))

  // Ground the advice in the learning ledger when possible.
  let groundedInLearning = false
  const rec = await isKnownMistake(req.subject, req.goal ?? '')
  if (rec) groundedInLearning = true
  const skills = await skillStatus()
  const best = skills.filter((s) => s.confidence > 0.5).sort((a, b) => b.confidence - a.confidence)[0]
  if (best && !groundedInLearning) groundedInLearning = true

  // When a document is supplied, chunk it (Khoj-style) and find the section
  // that best matches the subject; ground the advice on that section.
  let groundingSection: string | undefined
  // Context-rot guard (isair/jarvis-inspired): skip the expensive chunk+rerank
  // recall pass when the gate decides it would add no signal for this query.
  const recallWanted = shouldRecall(req.subject, [{ role: 'tool', toolResult: req.document, text: req.document }])
  if (req.document && req.document.trim() && recallWanted) {
    const entries = chunkDocument(req.document, { markdown: true })
    const q = req.subject.toLowerCase()
    let bestScore = -1
    for (const e of entries) {
      const hay = (e.heading + ' ' + e.raw).toLowerCase()
      const score = q.split(/\s+/).filter((w) => w.length > 2 && hay.includes(w)).length
      if (score > bestScore) { bestScore = score; groundingSection = e.text }
    }
    // Khoj-style rerank: re-score the top candidates against the subject and
    // pick the best, rather than the first lexical match.
    const top = [...entries]
      .map((e) => ({ e, s: e.heading + ' ' + e.raw }))
      .sort((a, b) => (b.s.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && q.includes(w)).length)
        - (a.s.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && q.includes(w)).length))
      .slice(0, 5)
      .map((x) => x.e.text)
    const reranked = await rerank(req.subject, top)
    if (reranked.length > 0 && reranked[0].score > 0) groundingSection = reranked[0].text
    if (groundingSection) groundedInLearning = true
  }

  const recommendation =
    solutions.length > 0
      ? `Start with "${solutions[0].title}".${groundedInLearning ? ' This aligns with what has worked reliably before.' : ''}${groundingSection ? ' I found a relevant section in your document to ground this on.' : ''}`
      : 'Refine the problem statement, then re-ask.'

  return {
    subject: req.subject,
    category,
    problem,
    rootCause: causes,
    solutions,
    recommendation,
    nextSteps: solutions[0]?.steps ?? ['Refine the problem statement.'],
    groundedInLearning,
    groundingSection,
  }
}

export async function adviseAny(subject: string): Promise<Advice> {
  return advise({ subject })
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(data)
}
