import { normalizeTenantId } from '@mishu/core/tenant'
import { TelephonyError } from '@mishu/core/ports'

export function requireTenantId(tenantId: unknown): string {
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new Error('tenantId is required')
  }
  return normalizeTenantId(tenantId)
}

export function requireTelephonyTenant(tenantId: unknown): string {
  try {
    return requireTenantId(tenantId)
  } catch {
    throw new TelephonyError('INVALID_ARGUMENT', 'tenantId is required')
  }
}
