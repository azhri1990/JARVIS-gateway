// Vision module for the J.A.R.V.I.S gateway.
//
// Lets J.A.R.V.I.S "see": a home-machine camera sidecar posts a captured frame
// (as base64) to the gateway, which stores the latest frame and — when an
// Ollama vision model is configured — asks the LLM to describe what it shows.
// Fail-closed: descriptions only run when a vision model is set; otherwise the
// frame is stored and returned so the UI can display it.
import type { ServerResponse } from 'node:http'

export interface VisionFrame {
  id: string
  capturedAt: string
  // Base64 image (small, downscaled by the sidecar). Stored in memory only —
  // private by default; the gateway runs on your home machine.
  imageB64: string
  description?: string
}

let latest: VisionFrame | undefined
let seq = 0

export async function ingestFrame(imageB64: string, prompt = 'Describe what is in this image.'): Promise<VisionFrame> {
  const frame: VisionFrame = {
    id: `v${++seq}`,
    capturedAt: new Date().toISOString(),
    imageB64,
  }
  latest = frame

  const model = process.env.VISION_MODEL
  const url = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'
  if (!model) {
    // No vision model configured — store only (fail-closed: don't guess).
    return frame
  }
  try {
    // Ollama vision: send the image as base64 in the message content.
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } },
            ],
          },
        ],
        temperature: 0.3,
        max_tokens: 256,
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) throw new Error(`vision ${res.status}`)
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    frame.description = data.choices?.[0]?.message?.content?.trim() || '(no description)'
  } catch (e) {
    frame.description = `(vision unavailable: ${e instanceof Error ? e.message : String(e)})`
  }
  return frame
}

export function getLatestFrame(): VisionFrame | undefined {
  return latest ? { ...latest } : undefined
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(data)
}
