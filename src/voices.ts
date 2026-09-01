// Voice module for the J.A.R.V.I.S gateway.
//
// Lets any device route voice to the brain: a device sends a short audio clip
// (base64 WAV/webm) and the gateway transcribes it via the local Faster-Whisper
// sidecar (WHISPER_URL). Devices speak back through their own TTS (mobile uses
// expo-speech), so no audio must leave the home network. Fail-closed: if the
// STT sidecar is unreachable, transcription returns an error rather than a guess.
import type { ServerResponse } from 'node:http'

export interface VoiceConfig {
  whisperUrl: string
}

export async function transcribeClip(whisperUrl: string, audioB64: string, format?: string): Promise<{ text: string }> {
  if (!whisperUrl) return { text: '' }
  const audio = Buffer.from(audioB64, 'base64')
  const form = new FormData()
  // Whisper-compatible field: `file` + `model` (tiny/base/small/large).
  const file = new Blob([new Uint8Array(audio)], { type: format || 'audio/wav' })
  form.append('file', file, `clip.${format === 'webm' ? 'webm' : 'wav'}`)
  form.append('model', 'base')
  const res = await fetch(`${whisperUrl}/transcribe`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`whisper ${res.status}`)
  const data = (await res.json()) as { text?: string }
  return { text: data.text ?? '' }
}

// Confirm the STT sidecar is reachable (used by the device to know if voice works).
export async function whisperHealth(whisperUrl: string): Promise<boolean> {
  if (!whisperUrl) return false
  try {
    const res = await fetch(`${whisperUrl}/health`, { signal: AbortSignal.timeout(3_000) })
    return res.ok
  } catch {
    return false
  }
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(data)
}
