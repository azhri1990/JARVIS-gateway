// Memory module for the J.A.R.V.I.S gateway (deep persistent memory).
import { env } from './config.js'

export interface MemoryEntry {
  id?: string
  scope: string
  content: string
  createdAt?: string
}

const memStore: MemoryEntry[] = []

function dbReady(): boolean {
  return !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_ACCESS_TOKEN && env.SUPABASE_SCHEMA)
}

async function supabaseTable() {
  // @ts-ignore - optional runtime dependency
  const mod = (await import('@supabase/supabase-js')) as any
  const createClient = mod.createClient as (url: string, key: string, opts?: any) => any
  return createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, {
    db: { schema: env.SUPABASE_SCHEMA },
    global: { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } },
  })
}

export async function saveMemory(scope: string, content: string): Promise<MemoryEntry> {
  const entry: MemoryEntry = { scope, content, createdAt: new Date().toISOString() }
  if (dbReady()) {
    try {
      const sb = await supabaseTable()
      const { data, error } = await sb.from('memories').insert({ scope, content, created_at: entry.createdAt }).select().single()
      if (!error && data) { entry.id = String(data.id); return entry }
    } catch { /* fall through */ }
  }
  memStore.push(entry)
  entry.id = `local-${memStore.length}`
  return entry
}

export async function recallMemories(scope?: string): Promise<MemoryEntry[]> {
  if (dbReady()) {
    try {
      const sb = await supabaseTable()
      let q = sb.from('memories').select('*').order('created_at', { ascending: false })
      if (scope) q = q.eq('scope', scope)
      const { data } = await q.limit(50)
      if (data) return data.map((r: any) => ({ id: String(r.id), scope: r.scope, content: r.content, createdAt: r.created_at }))
    } catch { /* fall through */ }
  }
  return scope ? memStore.filter((m) => m.scope === scope) : [...memStore]
}

export async function listScopes(): Promise<string[]> {
  const all = await recallMemories()
  return [...new Set(all.map((m) => m.scope))]
}
