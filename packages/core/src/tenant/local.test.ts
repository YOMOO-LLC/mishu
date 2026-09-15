import { describe, expect, it } from 'vitest'
import {
  LOCAL_TENANT_ID,
  localTenantContext,
  normalizeTenantId,
  resolveTenantFromCredential
} from '@mishu/core/tenant'

describe('core tenant', () => {
  it('LOCAL_TENANT_ID matches src/shared/contracts.ts', () => {
    expect(LOCAL_TENANT_ID).toBe('local')
  })

  it('localTenantContext is the local engine tenant', () => {
    expect(localTenantContext()).toEqual({ tenantId: LOCAL_TENANT_ID })
  })

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

  it('normalizes a trimmed tenant id', () => {
    expect(normalizeTenantId('abc')).toBe('abc')
    expect(normalizeTenantId('  local  ')).toBe('local')
    expect(normalizeTenantId('a'.repeat(128))).toBe('a'.repeat(128))
  })

  it('rejects an invalid tenant id', () => {
    expect(() => normalizeTenantId('')).toThrowError('tenantId is invalid')
    expect(() => normalizeTenantId('   ')).toThrowError('tenantId is invalid')
    expect(() => normalizeTenantId('a'.repeat(129))).toThrowError('tenantId is invalid')
    expect(() => normalizeTenantId(undefined as unknown as string)).toThrowError('tenantId is invalid')
  })
})
