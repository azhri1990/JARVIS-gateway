// Always-listening wake-word service for the J.A.R.V.I.S gateway.
//
// Architecture (ported from the Priler/jarvis Rust voice assistant, adapted to
// the zero-dependency Node gateway):
//
//   mic frame ─▶ [energy VAD gate] ─▶ [wake engine] ─▶ reportWake()
//                                          │
//                                    pluggable backend:
//                                    • 'tap'  (default; client tap-to-record)
//                                    • 'rustpotter'  (offline wake word, home machine)
//                                    • 'vosk'  (grammar wake recognizer, home machine)
//
// The key design is that the wake engine only sees frames the VAD thinks may
// contain speech, so it is not churning on silence. The engine itself is a
// single pluggable entry point — swap the backend without touching the
// arm/disarm state, the endpoints, or the command path.
//
// Node has no built-in mic API, so real audio capture + wake-word detection is
// delegated to a local engine (Rustpotter via its Node/native bridge, or a
// Python sidecar using sounddevice + vosk/porcupine). This module owns:
//   • the arm/disarm state and last-wake record (unchanged contract),
//   • the energy VAD gate (RMS over an i16 frame),
//   • the pluggable engine registry + active selection,
//   • a feedFrames hook the local engine bridge calls.
import type { ServerResponse } from 'node:http'

export interface WakeState {
  armed: boolean
  wakeWord: string
  lastWake?: string
  listeningSince?: string
  /** Name of the active wake engine backend. */
  engine: WakeEngineName
  /** Whether an always-listening engine is actually attached. */
  engineActive: boolean
}

export type WakeEngineName = 'tap' | 'rustpotter' | 'vosk'

/** A pluggable wake-word detector. */
export interface WakeEngine {
  /** Process one audio frame (i16 samples, e.g. 512 or 1600). Returns a
   *  detection score, or null when the frame does not trigger. */
  processFrame(frame: Int16Array | number[]): { score: number } | null
  /** Called at registration; may lazily load models. */
  init?: () => void
}

const VAD_ENERGY_THRESHOLD = 400 // RMS over i16; tune per-mic
const RUSTPOTTER_MIN_SCORE = 0.6 // detection fires only above this

let state: WakeState = {
  armed: true,
  wakeWord: 'J.A.R.V.I.S',
  engine: 'tap',
  engineActive: false,
}

// --- energy VAD gate (RMS over an i16 frame) ------------------------------
export function detectVoice(frame: Int16Array | number[]): {
  isVoice: boolean
  confidence: number
} {
  const samples: number[] = Array.isArray(frame) ? frame : Array.from(frame)
  if (samples.length === 0) return { isVoice: false, confidence: 0 }
  let sum = 0
  for (const s of samples) sum += s * s
  const rms = Math.sqrt(sum / samples.length)
  const isVoice = rms > VAD_ENERGY_THRESHOLD
  const confidence = Math.min(rms / (VAD_ENERGY_THRESHOLD * 2), 1)
  return { isVoice, confidence }
}

// --- pluggable wake engine registry --------------------------------------
const engines = new Map<WakeEngineName, WakeEngine>()

/**
 * Register a wake-word engine backend. `tap` is always present (the mobile
 * client taps to record). A local engine bridge (Rustpotter/Vosk) registers
 * itself on startup and switches the active engine when it attaches.
 */
export function registerWakeEngine(name: WakeEngineName, engine: WakeEngine): void {
  engines.set(name, engine)
  engine.init?.()
  if (name !== 'tap' && state.engine === 'tap') {
    state.engine = name
    state.engineActive = true
  }
}

export function setWakeEngine(name: WakeEngineName): boolean {
  if (!engines.has(name)) return false
  state.engine = name
  state.engineActive = name !== 'tap'
  return true
}

// Default tap engine: no audio analysis; a wake is reported when the client
// explicitly signals it. Keeps the /wake/report path working out of the box.
registerWakeEngine('tap', {
  processFrame: () => null,
})

/**
 * Feed one raw mic frame into the pipeline. The energy VAD gates it first;
 * only likely-speech frames reach the active engine. Returns true when the
 * engine reported a wake (so the caller can arm /transcribe immediately).
 */
export function feedFrame(frame: Int16Array | number[]): boolean {
  if (!state.armed) return false
  const vad = detectVoice(frame)
  if (!vad.isVoice) return false
  const engine = engines.get(state.engine)
  if (!engine || !state.engineActive) return false
  const hit = engine.processFrame(frame)
  if (hit && hit.score >= RUSTPOTTER_MIN_SCORE) {
    reportWake()
    return true
  }
  return false
}

// --- Rustpotter / Vosk bridge (home-machine sidecar) ----------------------
//
// These register lazily and are not active by default. The actual Rustpotter
// native binding (or a Python sidecar that reads the mic and shells the
// Rustpotter library) attaches by calling registerWakeEngine('rustpotter', ...)
// with an adapter that maps the engine's detection onto processFrame. The
// gateway exposes these stubs so the home-machine integration has a defined,
// typed contract to fill — no server changes needed.

export interface RustpotterAdapterOpts {
  /** Path to .rpw wake-word files. */
  wakeWordFiles: string[]
  minScore?: number
}

/** Create a Rustpotter wake engine. The native `process_frame` call is
 *  provided by the integration layer (node-rustpotter or a sidecar subprocess
 *  speaking a tiny JSON protocol). Returns an engine wired to that callback. */
export function makeRustpotterEngine(
  processNative: (frame: number[]) => number | null,
  _opts: RustpotterAdapterOpts = { wakeWordFiles: [] },
): WakeEngine {
  return {
    init() {
      state.wakeWord = 'J.A.R.V.I.S' // Rustpotter .rpw encodes its word
    },
    processFrame(frame) {
      const samples: number[] = Array.isArray(frame) ? frame : Array.from(frame)
      const score = processNative(samples)
      if (score === null || score === undefined) return null
      return { score }
    },
  }
}

// --- existing contract (unchanged exports) --------------------------------
/** Called by the local wake-word engine when it hears the wake word. */
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
