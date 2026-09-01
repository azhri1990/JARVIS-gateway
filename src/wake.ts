// Always-listening wake-word service for the J.A.R.V.I.S gateway.
//
// Runs continuously on the home machine, listening on the microphone for a
// wake word ("J.A.R.V.I.S"). On wake it arms the gateway so a follow-up spoken
// command is transcribed (via Faster-Whisper) and run. The actual audio
// capture + wake-word detection is delegated to a local engine (e.g.
// Picovoice Porcupine, or a Python sidecar using sounddevice) because Node has
// no built-in mic API; this module owns the arm/disarm state, the last-wake
// record, and the endpoints, and exposes a `reportWake` hook the engine calls.
import type { ServerResponse } from 'node:http'

export interface WakeState {
  armed: boolean
  wakeWord: string
  lastWake?: string
  listeningSince?: string
}

let state: WakeState = {
  armed: true,
  wakeWord: 'J.A.R.V.I.S',
}

// Called by the local wake-word engine when it hears the wake word.
export function reportWake(word?: string): WakeState {
  state.lastWake = new Date().toISOString()
  state.wakeWord = word ?? state.wakeWord
  // Arming stays on: J.A.R.V.I.S is always listening. A follow-up command is
  // transcribed via /transcribe and executed via /run.
  return { ...state }
}

export function setArmed(armed: boolean): WakeState {
  state.armed = armed
  if (armed) state.listeningSince = state.listeningSince ?? new Date().toISOString()
  else delete state.listeningSince
  return { ...state }
}

export function getWakeState(): WakeState {
  return { ...state }
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(data)
}
