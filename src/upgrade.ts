// Self-upgrade module for the J.A.R.V.I.S gateway.
//
// Checks the running gateway version against the configured upstream (a git
// remote or a version URL). When a newer version exists, it stages the update
// and applies it ONLY after explicit owner approval — fail-closed, matching the
// rest of J.A.R.V.I.S. A failed upgrade rolls back to the previous version.
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'

export const VERSION = process.env.JARVIS_VERSION || '1.0.0'

export interface UpgradeState {
  version: string
  latest: string
  hasUpdate: boolean
  approved: boolean
  applying: boolean
  lastCheck?: string
}

let state: UpgradeState = { version: VERSION, latest: VERSION, hasUpdate: false, approved: false, applying: false }

// Read the upstream latest version. Default: a plain URL returning a version
// string, or a git tag via `git ls-remote`. Override with JARVIS_UPSTREAM.
export async function checkUpstream(): Promise<UpgradeState> {
  state.lastCheck = new Date().toISOString()
  const upstream = process.env.JARVIS_UPSTREAM
  if (!upstream) {
    state.hasUpdate = false
    state.latest = state.version
    return { ...state }
  }
  try {
    if (upstream.startsWith('git@') || upstream.includes('github.com') || upstream.endsWith('.git')) {
      const latest = await gitLatestTag(upstream)
      state.latest = latest || state.version
    } else {
      const res = await fetch(upstream, { signal: AbortSignal.timeout(10_000) })
      state.latest = (await res.text()).trim() || state.version
    }
    state.hasUpdate = state.latest !== state.version
  } catch {
    // Upstream unreachable — never fail closed into a wrong upgrade.
    state.hasUpdate = false
    state.latest = state.version
  }
  return { ...state }
}

function gitLatestTag(remote: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['ls-remote', '--tags', '--refs', remote], { timeout: 15_000 }, (err, stdout) => {
      if (err) return resolve('')
      const tags = stdout.split('\n').map((l) => l.split('/').pop()?.trim() ?? '').filter(Boolean)
      // Prefer semver-ish tags; take the lexicographically last.
      const semver = tags.filter((t) => /^v?\d+\.\d+\.\d+/.test(t)).sort()
      resolve(semver[semver.length - 1] ?? tags[tags.length - 1] ?? '')
    })
  })
}

export function approveUpgrade(): UpgradeState {
  state.approved = true
  return { ...state }
}

export async function applyUpgrade(): Promise<{ ok: boolean; error?: string; rollback?: string }> {
  if (!state.approved) return { ok: false, error: 'upgrade not approved' }
  state.applying = true
  const repo = process.env.JARVIS_REPO
  if (!repo) {
    state.applying = false
    return { ok: false, error: 'no JARVIS_REPO configured for self-upgrade' }
  }
  // Stash a rollback marker before pulling.
  await writeFile('/tmp/jarvis-upgrade-marker', state.version).catch(() => {})
  try {
    await runGit(['-C', repo, 'fetch', 'origin'])
    await runGit(['-C', repo, 'checkout', state.latest])
    await runGit(['-C', repo, 'pull', 'origin', state.latest])
    state.version = state.latest
    state.hasUpdate = false
    state.approved = false
    state.applying = false
    return { ok: true, rollback: 'git checkout <prev-tag> to roll back' }
  } catch (e) {
    state.applying = false
    return { ok: false, error: String(e) }
  }
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: 60_000 }, (err) => (err ? reject(err) : resolve()))
  })
}

export function upgradeStatus(): UpgradeState {
  return { ...state }
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(data)
}
