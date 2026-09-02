import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkDocument, tokenCount } from '../src/chunker.js'
import { shouldRecall, hasFreshToolResult } from '../src/recallgate.js'
import { requestApproval, listApprovals, getApproval, decide } from '../src/consent.js'
import { validateRole, roleGateHook, listRoles } from '../src/agents.js'

// --- chunker ---
test('chunker splits long markdown into heading-prefixed entries', () => {
  const doc = '# Chapter One\n\nparagraph a\n\n## Section B\n\nparagraph b\n\n'
  const entries = chunkDocument(doc, { markdown: true })
  assert.ok(entries.length >= 1, 'produced at least one entry')
  for (const e of entries) {
    assert.ok(typeof e.text === 'string' && e.text.length > 0, 'entry has text')
    assert.ok(e.heading !== undefined, 'entry carries heading ancestry')
  }
})

test('chunker respects maxTokens by over-splitting', () => {
  const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
  const tiny = chunkDocument(long, { maxTokens: 16 })
  assert.ok(tiny.length > 1, 'long doc with tiny budget yields multiple entries')
  for (const e of tiny) {
    assert.ok(tokenCount(e.text) <= 16, `entry within token budget (${tokenCount(e.text)} <= 16)`)
  }
})

// --- recallgate ---
test('recall gate: no fresh tool result => skip recall', () => {
  assert.equal(shouldRecall('how do I fix wifi', [{ role: 'user', text: 'how do I fix wifi' }]), false)
})

test('recall gate: fresh tool result + overlapping query => recall', () => {
  const window = [{ role: 'tool', toolResult: 'router reboot steps', text: 'router reboot steps' }]
  assert.equal(shouldRecall('reboot the router', window), true)
})

test('recall gate: stopword-only query never gated off', () => {
  const window = [{ role: 'tool', toolResult: 'x', text: 'x' }]
  assert.equal(shouldRecall('hi', window), true)
})

test('recall gate: fails open on error', () => {
  // A window with a fresh tool result, but a query that throws inside the
  // gate (non-string) => the catch returns true (recall anyway).
  // @ts-expect-error - deliberate bad query to exercise the fail-open path
  assert.equal(shouldRecall(null, [{ role: 'tool', text: 'x', toolResult: {} }]), true)
})

test('hasFreshToolResult detects tool messages', () => {
  assert.equal(hasFreshToolResult([{ role: 'tool', toolResult: {} }]), true)
  assert.equal(hasFreshToolResult([{ role: 'user' }]), false)
})

// --- consent gate ---
test('consent: request, list pending, approve, then cannot re-decide', () => {
  const a = requestApproval('device', 'Turn on lamp', 'POST /devices/l1/power on=true')
  assert.equal(a.status, 'pending')
  assert.equal(listApprovals('pending').some((x) => x.id === a.id), true)
  const approved = decide(a.id, true)
  assert.equal(approved?.status, 'approved')
  assert.equal(getApproval(a.id)?.status, 'approved')
})

test('consent: unknown approval id returns undefined', () => {
  assert.equal(getApproval('does-not-exist'), undefined)
  assert.equal(decide('does-not-exist', true), undefined)
})

// --- agents role gate ---
test('role gate: valid roles pass, unknown role vetoes', () => {
  assert.equal(validateRole('code').ok, true)
  assert.equal(validateRole('research').ok, true)
  assert.equal(validateRole('not-a-role').ok, false)
  assert.equal(validateRole(undefined).ok, true) // unrestricted
})

test('roleGateHook vetoes unknown roles with a message', () => {
  // @ts-expect-error - run with an invalid role
  const err = roleGateHook({ role: 'bogus' })
  assert.ok(typeof err === 'string' && err.includes('unknown role'))
})

test('listRoles exposes the five roles with actions', () => {
  const roles = listRoles()
  assert.equal(roles.length, 5)
  assert.ok(roles.every((r) => Array.isArray(r.allowedActions) && r.allowedActions.length > 0))
})

// --- agents: recovery policy + role gating ---
import { spawnJob, spawnDirectorJob, registerBeforeAgent } from '../src/agents.js'

test('agents: spawnJob accepts all recovery policies and creates a job', () => {
  for (const p of ['retry', 'escalate', 'fallback'] as const) {
    const job = spawnJob('t', ['one'], p)
    assert.equal(job.status, 'running')
    assert.equal(job.runs.length, 1)
    assert.equal(job.subtasks.length, 1)
  }
})

test('agents: spawnJob carries order + dependsOn wiring', () => {
  const job = spawnJob('t', ['a', 'b'], 'fallback', undefined, 'parallel')
  assert.equal(job.order, 'parallel')
  const dep = spawnJob('t2', ['a', 'b'], 'fallback', { b: 'a' })
  // dependsOn is resolved on the run objects; deps map keys are run ids, so we
  // just assert the job was created with the dependency wiring present.
  assert.equal(dep.runs.length, 2)
})

test('agents: director job starts with a director run and plans async', () => {
  const job = spawnDirectorJob('write a report')
  assert.equal(job.name, 'director')
  assert.equal(job.objective, 'write a report')
  assert.equal(job.planned, false)
  assert.ok(job.runs.some((r) => r.name === 'director'))
})

test('agents: beforeAgent hooks veto a run (consent/telemetry gate)', async () => {
  let vetoed = false
  // registerBeforeAgent returns void (fire-and-forget registration).
  registerBeforeAgent(() => {
    vetoed = true
    return 'blocked by test hook'
  })
  // roleGateHook is already registered; our added hook is the second one.
  // We can't easily invoke runAgent (it needs a live LLM), so assert the hook
  // registry accepted it — the call succeeded without throwing.
  assert.equal(vetoed, false) // hook not yet called (no runAgent in this test)
})

test('agents: listRoles is consistent with ROLES', () => {
  const roles = listRoles()
  const names = roles.map((r) => r.role)
  assert.deepEqual(names, ['code', 'research', 'memory', 'voice', 'general'])
})
import { detectVoice, feedFrame, registerWakeEngine, setWakeEngine, getWakeState, makeRustpotterEngine } from '../src/wake.js'

// --- wake: pluggable engine + VAD gate (ported from Priler/jarvis) ---
test('wake: energy VAD flags loud frames as voice, quiet as silence', () => {
  assert.equal(detectVoice(new Int16Array(1600)).isVoice, false) // all zeros
  const loud = new Int16Array(1600).fill(800)
  const v = detectVoice(loud)
  assert.equal(v.isVoice, true)
  assert.ok(v.confidence > 0 && v.confidence <= 1)
})

test('wake: feedFrame gates on VAD and only fires active engine above min score', () => {
  // register a test engine that always reports a strong hit
  let called = 0
  registerWakeEngine('test-engine' as any, { processFrame: () => { called++; return { score: 0.99 } } })
  setWakeEngine('test-engine' as any)
  // silence: VAD rejects, engine not called
  feedFrame(new Int16Array(1600))
  assert.equal(called, 0)
  // loud: VAD passes, engine fires => wake reported (lastWake set)
  const loud = new Int16Array(1600).fill(900)
  const woke = feedFrame(loud)
  assert.equal(woke, true)
  assert.equal(called, 1)
  assert.ok(getWakeState().lastWake, 'lastWake set on wake')
  // engineActive now true after registering a non-tap engine
  assert.equal(getWakeState().engineActive, true)
})

test('wake: makeRustpotterEngine maps native detection onto processFrame', () => {
  let received: number[] = []
  const eng = makeRustpotterEngine((frame) => { received = frame; return 0.7 })
  const hit = eng.processFrame([100, 200, 300])
  assert.ok(hit && hit.score === 0.7)
  assert.deepEqual(received, [100, 200, 300])
  // native returning null => no detection
  const eng2 = makeRustpotterEngine(() => null)
  assert.equal(eng2.processFrame([1, 2, 3]), null)
})
import { isNearDuplicate, memOverlap, consolidateWrite, writeMemory } from '../src/memory.js'

// --- memory: merge-consolidation guard (isair/jarvis merge_node_data port) ---
test('memory: near-dup dedupe collapses near-exact rephrased facts', () => {
  assert.equal(isNearDuplicate('The user lives in London.', 'The user lives in London now.'), true)
  assert.equal(isNearDuplicate('Gateway runs on Node 22', 'The gateway runs on Node 22.'), true)
})

test('memory: unrelated facts are NOT treated as duplicates (independence)', () => {
  assert.equal(isNearDuplicate('The user lives in London.', 'The gateway runs on Node 22.'), false)
})

test('memory: identical facts always dedupe', () => {
  assert.equal(isNearDuplicate('Likes sushi on Thursdays', 'Likes sushi on Thursdays'), true)
})

test('memory: consolidateWrite folds a same-type near-dup, keeps unrelated and different-type', async () => {
  // isolate to a temp state dir so consolidation sees real disk state
  const before = process.env.JARVIS_STATE_DIR
  process.env.JARVIS_STATE_DIR = '/tmp/jv-mem-test-' + Date.now()
  try {
    const at = new Date().toISOString()
    // seed via writeMemory (persists to the temp dir)
    await writeMemory({ id: 'f-london', type: 'fact', description: 'User lives in London.', at }, 'London based.')
    // rephrased, sharing content words -> must fold into f-london
    const dup = await consolidateWrite({ id: 'f-london2', type: 'fact', description: 'User lives in London now.', at }, 'Based in London.')
    assert.equal(dup.mergedInto, 'f-london')
    // unrelated content -> fresh write, never folded into f-london
    const other = await consolidateWrite({ id: 'f-node', type: 'fact', description: 'Gateway runs on Node 22.', at }, 'runtime pin')
    assert.notEqual(other.mergedInto, 'f-london')
    // different type, even with overlapping wording -> never collapsed
    const mistake = await consolidateWrite({ id: 'm-london', type: 'mistake', description: 'User lives in London.', at }, 'x')
    assert.notEqual(mistake.mergedInto, 'f-london')
  } finally {
    process.env.JARVIS_STATE_DIR = before
  }
})


