import type { ServiceErrorCode, ServiceErrorShape } from '../../shared/contracts.js'

export class ServiceError extends Error implements ServiceErrorShape {
  constructor(
    readonly code: ServiceErrorCode | string,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}

export function asServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error
  const value = error as { code?: unknown; message?: unknown; details?: unknown }
  return new ServiceError(
    typeof value?.code === 'string' ? value.code : 'INTERNAL_ERROR',
    typeof value?.message === 'string' ? value.message : 'Service operation failed',
    value?.details
  )
}

export function requiredId(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ServiceError('INVALID_ARGUMENT', `${label} is required`)
  }
  return value.trim()
}
