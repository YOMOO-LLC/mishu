/** Local engine tenant. Same value as src/shared/contracts.ts LOCAL_TENANT_ID. */
export const LOCAL_TENANT_ID = 'local' as const

export type TenantId = string

export interface TenantContext {
  readonly tenantId: TenantId
}

export type LocalCredentialKind = 'loopback-bearer' | 'ipc' | 'mcp'

export function localTenantContext(): TenantContext {
  return { tenantId: LOCAL_TENANT_ID }
}

/**
 * Local loopback bearer tokens, Electron IPC, and MCP credentials always
 * resolve to `local`. Request body and path must never select a tenant.
 */
export function resolveTenantFromCredential(_kind: LocalCredentialKind): TenantContext {
  return localTenantContext()
}

export function normalizeTenantId(tenantId: string): TenantId {
  if (typeof tenantId !== 'string' || !tenantId.trim() || tenantId.length > 128) {
    throw new Error('tenantId is invalid')
  }
  return tenantId.trim()
}
