import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpTokenStore } from './mcp/auth.js'
import {
  LOCAL_TENANT_ID,
  localTenantContext,
  resolveTenantFromCredential
} from './tenant.js'

describe('TenantContext', () => {
  it('resolves loopback bearer, IPC, and MCP credentials to local', () => {
    expect(resolveTenantFromCredential('loopback-bearer')).toEqual({ tenantId: LOCAL_TENANT_ID })
    expect(resolveTenantFromCredential('ipc')).toEqual({ tenantId: 'local' })
    expect(resolveTenantFromCredential('mcp')).toEqual(localTenantContext())
  })

  it('does not take a tenant id from a request body or path claim', () => {
    const claimed = { tenantId: 't2', path: '/v1/tenants/t2/calls' }
    expect(resolveTenantFromCredential('loopback-bearer').tenantId).not.toBe(claimed.tenantId)
    expect(resolveTenantFromCredential('ipc').tenantId).toBe('local')
  })

  it('maps an authorized local bearer token to the local tenant', () => {
    const directory = mkdtempSync(join(tmpdir(), 'live-phone-tenant-auth-'))
    const store = new McpTokenStore(directory)
    const token = readFileSync(store.tokenPath, 'utf8').trim()
    expect(store.authorizeTenant(`Bearer ${token}`)).toEqual({ tenantId: 'local' })
    expect(store.authorizeTenant('Bearer deadbeef')).toBeUndefined()
  })
})
