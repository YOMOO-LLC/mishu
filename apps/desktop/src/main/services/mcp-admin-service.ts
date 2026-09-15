import type {
  McpClientConfigApplyResult,
  McpClientConfigs,
  McpScope,
  McpServerStatus
} from '../../shared/contracts.js'
import { applyLocalClientConfigs } from '../mcp/client-configs.js'
import { ServiceError } from './service-error.js'

export interface McpAdminBackend {
  status(): McpServerStatus
  setEnabled(enabled: boolean): Promise<McpServerStatus>
  setScopes(scopes: McpScope[]): McpServerStatus
  rotateToken(): { status: McpServerStatus; token: string }
  clientConfigs(): McpClientConfigs
}

export class McpAdminService {
  private backend?: McpAdminBackend

  attach(backend: McpAdminBackend): () => void {
    this.backend = backend
    return () => { if (this.backend === backend) this.backend = undefined }
  }

  status(): McpServerStatus { return this.requireBackend().status() }
  setEnabled(enabled: boolean): Promise<McpServerStatus> { return this.requireBackend().setEnabled(enabled) }
  setScopes(scopes: McpScope[]): McpServerStatus { return this.requireBackend().setScopes(scopes) }
  rotateToken(): { status: McpServerStatus; token: string } { return this.requireBackend().rotateToken() }
  clientConfigs(): McpClientConfigs { return this.requireBackend().clientConfigs() }
  applyClientConfigs(): McpClientConfigApplyResult {
    return applyLocalClientConfigs(this.requireBackend().clientConfigs())
  }

  private requireBackend(): McpAdminBackend {
    if (!this.backend) throw new ServiceError('APP_NOT_READY', 'MCP admin service is not initialized')
    return this.backend
  }
}
