import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { engineFilePath, normalizeBaseUrl } from './paths.js'
import type { ApiErrorBody, EngineConnection, HttpResult } from './types.js'

let cached: EngineConnection | undefined

export function loadEngine(): EngineConnection {
  if (cached) return cached
  if (process.env.CONTRACT_BASE_URL && process.env.CONTRACT_TOKEN) {
    cached = {
      baseUrl: normalizeBaseUrl(process.env.CONTRACT_BASE_URL),
      token: process.env.CONTRACT_TOKEN
    }
    return cached
  }
  const parsed = JSON.parse(readFileSync(engineFilePath(), 'utf8')) as EngineConnection
  cached = { baseUrl: normalizeBaseUrl(parsed.baseUrl), token: parsed.token }
  return cached
}

export function uniqueKey(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

let phoneSeq = 100
export function fakeE164(): string {
  phoneSeq += 1
  return `+1555555${String(phoneSeq).padStart(4, '0')}`
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit & { idempotencyKey?: string | null; token?: string | null } = {}
): Promise<HttpResult<T>> {
  const engine = loadEngine()
  const method = (init.method ?? 'GET').toUpperCase()
  const url = new URL(`${engine.baseUrl}/${path.replace(/^\//, '')}`)
  const headers = new Headers(init.headers)
  if (init.token === null) {
    headers.delete('authorization')
  } else {
    headers.set('authorization', `Bearer ${init.token ?? engine.token}`)
  }
  headers.set('accept', 'application/json')
  if (method !== 'GET' && method !== 'HEAD') {
    if (!headers.has('content-type') && init.body !== undefined) {
      headers.set('content-type', 'application/json')
    }
    if (init.idempotencyKey !== null && !headers.has('idempotency-key')) {
      headers.set('idempotency-key', init.idempotencyKey ?? uniqueKey(method.toLowerCase()))
    }
  }
  const response = await fetch(url, { ...init, method, headers })
  const raw = await response.text()
  let body: T
  try {
    body = raw ? JSON.parse(raw) as T : undefined as T
  } catch {
    throw new Error(`${method} ${path} returned non-JSON (${response.status}): ${raw.slice(0, 500)}`)
  }
  return { status: response.status, body, raw, headers: response.headers }
}

export async function apiOk<T = unknown>(
  path: string,
  init: RequestInit & { idempotencyKey?: string | null; token?: string | null } = {},
  allowed = new Set([200, 201, 202])
): Promise<HttpResult<T>> {
  const result = await api<T>(path, init)
  if (!allowed.has(result.status)) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed (${result.status}): ${result.raw}`)
  }
  return result
}

export function expectError(result: HttpResult<unknown>, code: string, status: number): asserts result is HttpResult<ApiErrorBody> {
  if (result.status !== status) {
    throw new Error(`expected ${status} ${code}, got ${result.status}: ${result.raw}`)
  }
  const body = result.body as ApiErrorBody
  if (!body || typeof body !== 'object' || !body.error || typeof body.error !== 'object') {
    throw new Error(`missing error envelope: ${result.raw}`)
  }
  if (typeof body.error.code !== 'string' || typeof body.error.message !== 'string') {
    throw new Error(`error envelope missing code/message: ${result.raw}`)
  }
  if (body.error.code !== code) {
    throw new Error(`expected code ${code}, got ${body.error.code}: ${result.raw}`)
  }
}

export async function hangupQuietly(): Promise<void> {
  try {
    await api('/calls/current/hangup', { method: 'POST', body: '{}' })
  } catch {
    // no active call
  }
}
