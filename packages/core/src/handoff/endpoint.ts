import type { OwnerEndpoint, OwnerEndpointKind } from './types.js'

const CLIENT_OWNER = /^client:[A-Za-z0-9_-]{1,121}$/
const PSTN_OWNER = /^\+[1-9]\d{6,14}$/

export function parseOwnerEndpoint(value: string): OwnerEndpoint | undefined {
  if (value === 'local_takeover') return { kind: 'local_takeover' }
  if (CLIENT_OWNER.test(value)) {
    return { kind: 'client', identity: value.slice('client:'.length) }
  }
  if (PSTN_OWNER.test(value)) return { kind: 'pstn', number: value }
  return undefined
}

export function ownerEndpointTo(value: OwnerEndpoint): string {
  if (value.kind === 'client') return `client:${value.identity}`
  if (value.kind === 'pstn') return value.number
  return 'local_takeover'
}

/** PSTN must confirm with Gather digit 1. Client and local takeover accept on answer. */
export function ownerRequiresGatherConfirm(kind: OwnerEndpointKind): boolean {
  return kind === 'pstn'
}

export function ownerAcceptsOnAnswered(kind: OwnerEndpointKind): boolean {
  return kind === 'client' || kind === 'local_takeover'
}

export function ownerAcceptsOnJoined(kind: OwnerEndpointKind): boolean {
  return kind === 'client' || kind === 'local_takeover'
}

/** PSTN join is ignored until accept (or a CAS-winning connect) is already in flight. */
export function canApplyOwnerJoined(kind: OwnerEndpointKind, state: string): boolean {
  if (kind === 'pstn') return state === 'accepted' || state === 'connecting'
  return true
}
