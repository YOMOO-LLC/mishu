/**
 * Host-only routes with no counterpart on the headless reference host.
 * Contract cases never branch on engine name; these answers stay outside
 * `tests/contract/*.contract.ts`.
 */
export const CAPABILITY_UNAVAILABLE = 'CAPABILITY_UNAVAILABLE' as const

export const CAPABILITY_UNAVAILABLE_STATUS = 501

export interface UnavailableRoute {
  method: string
  /** Exact path, or a function for parameterized routes. */
  match: string | ((pathname: string) => boolean)
  message: string
}

export const UNAVAILABLE_ROUTES: readonly UnavailableRoute[] = [
  {
    method: 'POST',
    match: '/v1/realtime/sessions',
    message: 'Codex-local and WebRTC SDP realtime sessions are unavailable on the headless host'
  },
  {
    method: 'POST',
    match: '/v1/realtime/sessions/current/speech',
    message: 'Codex-local realtime sessions are unavailable on the headless host'
  },
  {
    method: 'POST',
    match: '/v1/realtime/sessions/current/text',
    message: 'Codex-local realtime sessions are unavailable on the headless host'
  },
  {
    method: 'POST',
    match: '/v1/realtime/sessions/current/stop',
    message: 'Codex-local realtime sessions are unavailable on the headless host'
  },
  {
    method: 'POST',
    match: '/v1/recordings/start',
    message: 'Call recordings are unavailable on the headless host'
  },
  {
    method: 'POST',
    match: '/v1/recordings/chunk',
    message: 'Call recordings are unavailable on the headless host'
  },
  {
    method: 'POST',
    match: '/v1/recordings/finish',
    message: 'Call recordings are unavailable on the headless host'
  },
  {
    method: 'GET',
    match: (pathname) => /^\/v1\/calls\/[^/]+\/recording\/audio$/.test(pathname),
    message: 'Call recordings are unavailable on the headless host'
  },
  {
    method: 'POST',
    match: '/v1/app/relaunch',
    message: 'Desktop app relaunch is unavailable on the headless host'
  },
  {
    method: 'POST',
    match: '/v1/settings/twilio/import',
    message: 'Importing a process-external Twilio .env file is unavailable on the headless host'
  },
  {
    method: 'PUT',
    match: '/v1/settings/mcp',
    message: 'Enabling the desktop MCP server is unavailable on the headless host'
  },
  {
    method: 'POST',
    match: '/v1/settings/mcp/token/rotate',
    message: 'MCP token rotation is unavailable on the headless host'
  },
  {
    method: 'GET',
    match: '/v1/settings/mcp/client-configs',
    message: 'Desktop MCP client-config files are unavailable on the headless host'
  },
  {
    method: 'POST',
    match: '/v1/settings/mcp/client-configs/apply',
    message: 'Writing OS MCP client configs is unavailable on the headless host'
  }
]

export function unavailableFor(method: string, pathname: string): UnavailableRoute | undefined {
  const verb = method.toUpperCase()
  return UNAVAILABLE_ROUTES.find((route) => {
    if (route.method !== verb) return false
    return typeof route.match === 'string' ? route.match === pathname : route.match(pathname)
  })
}

export function unavailableBody(message: string): { error: { code: typeof CAPABILITY_UNAVAILABLE; message: string } } {
  return { error: { code: CAPABILITY_UNAVAILABLE, message } }
}
