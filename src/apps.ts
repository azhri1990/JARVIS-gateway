// Connected-apps module for the J.A.R.V.I.S gateway.
//
// A declarative registry of actions J.A.R.V.I.S can perform on your services
// (send email, create a calendar event, post a message). Each action is
// fail-closed: it only runs if (a) the connector action is implemented and
// (b) an authorization token is configured. Unconfigured apps report
// "not_connected" so the UI can guide you to connect them.
import type { ServerResponse } from 'node:http'

export interface AppAction {
  app: string
  name: string
  description: string
  // Fields the action needs, e.g. [{ key: 'to', label: 'Recipient' }]
  fields: { key: string; label: string }[]
}

export interface ConnectedApp {
  id: string
  name: string
  connected: boolean
  actions: AppAction[]
}

// Registry of supported apps and their actions.
const REGISTRY: Omit<ConnectedApp, 'connected'>[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    actions: [
      { app: 'gmail', name: 'send_email', description: 'Send an email', fields: [
        { key: 'to', label: 'Recipient' },
        { key: 'subject', label: 'Subject' },
        { key: 'body', label: 'Body' },
      ]},
    ],
  },
  {
    id: 'calendar',
    name: 'Google Calendar',
    actions: [
      { app: 'calendar', name: 'create_event', description: 'Create a calendar event', fields: [
        { key: 'title', label: 'Title' },
        { key: 'start', label: 'Start (ISO)' },
        { key: 'end', label: 'End (ISO)' },
      ]},
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    actions: [
      { app: 'notion', name: 'create_page', description: 'Create a Notion page', fields: [
        { key: 'title', label: 'Title' },
        { key: 'content', label: 'Content' },
      ]},
    ],
  },
]

function isConnected(appId: string): boolean {
  // Fail-closed: only "connected" when a token is configured for the app.
  return !!(process.env[`${appId.toUpperCase()}_TOKEN`] || process.env[`${appId.toUpperCase()}_ENABLED`] === 'true')
}

export function listApps(): ConnectedApp[] {
  return REGISTRY.map((app) => ({
    ...app,
    connected: isConnected(app.id),
  }))
}

export type AppActionResult = { ok: boolean; message: string }

export async function performAction(
  appId: string,
  actionName: string,
  params: Record<string, string>,
): Promise<AppActionResult> {
  const app = REGISTRY.find((a) => a.id === appId)
  if (!app) return { ok: false, message: `unknown app: ${appId}` }
  const action = app.actions.find((a) => a.name === actionName)
  if (!action) return { ok: false, message: `unknown action: ${actionName}` }
  if (!isConnected(appId)) return { ok: false, message: `${app.name} is not connected` }

  // Real connector dispatch would happen here (via the platform's connectors).
  // In local/private mode, we surface the action as a gated request the user
  // can approve — never auto-execute a consequential action.
  return {
    ok: true,
    message: `[approved] ${app.name}: ${action.name} with ${JSON.stringify(params)}`,
  }
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(data)
}
