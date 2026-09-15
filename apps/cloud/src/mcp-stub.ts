import { ServiceError } from '../../desktop/src/main/services/service-error.js'
import type { McpAdminBackend } from '../../desktop/src/main/services/mcp-admin-service.js'
import { CAPABILITY_UNAVAILABLE } from './unavailable.js'

const UNCONFIGURED = {
  enabled: false,
  running: false,
  scopes: [] as const,
  clients: { codex: false, claudeDesktop: false }
}

function unavailable(message: string): never {
  throw new ServiceError(CAPABILITY_UNAVAILABLE, message)
}

/**
 * GET /v1/settings/mcp must return 200 with an unconfigured object (secrets
 * contract). Mutating MCP admin stays capability-unavailable and never returns
 * a bearer token.
 */
export function createHeadlessMcpAdmin(): McpAdminBackend {
  return {
    status: () => ({ ...UNCONFIGURED, scopes: [], clients: { ...UNCONFIGURED.clients } }),
    setEnabled: async () => unavailable('MCP enablement is unavailable on the headless host'),
    setScopes: () => unavailable('MCP scope changes are unavailable on the headless host'),
    rotateToken: () => unavailable('MCP token rotation is unavailable on the headless host'),
    clientConfigs: () => unavailable('Desktop MCP client-config files are unavailable on the headless host')
  }
}
