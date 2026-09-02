// Loads the J.A.R.V.I.S gateway configuration from the environment.
export interface Config {
  PORT: number
  HOST: string
  SESSION_TTL: number
  BRAIN_MODE: 'local' | 'remote' | 'ollama'
  BRAIN_URL: string
  OLLAMA_URL: string
  OLLAMA_MODEL: string
  RERANK_MODEL: string
  WHISPER_URL: string
  SHARED_SECRET?: string
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  SUPABASE_ACCESS_TOKEN?: string
  SUPABASE_SCHEMA?: string
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function mode(): Config['BRAIN_MODE'] {
  const m = process.env.BRAIN_MODE
  if (m === 'remote' || m === 'ollama') return m
  return 'local'
}

export const env: Config = {
  PORT: num('PORT', 8000),
  HOST: process.env.HOST ?? '127.0.0.1',
  SESSION_TTL: num('SESSION_TTL', 2_592_000),
  BRAIN_MODE: mode(),
  BRAIN_URL: process.env.BRAIN_URL ?? 'http://127.0.0.1:9000',
  OLLAMA_URL: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL ?? 'qwen2.5:7b',
  RERANK_MODEL: process.env.RERANK_MODEL ?? 'qwen2.5:3b',
  WHISPER_URL: process.env.WHISPER_URL ?? 'http://127.0.0.1:9001',
  SHARED_SECRET: process.env.SHARED_SECRET,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN,
  SUPABASE_SCHEMA: process.env.SUPABASE_SCHEMA,
}
