import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveTenantFromCredential, type TenantContext } from '../tenant.js'

const TOKEN_PATTERN = /^[a-f0-9]{64}$/

export class McpTokenStore {
  readonly tokenPath: string
  private token: string

  constructor(userDataPath: string) {
    this.tokenPath = join(userDataPath, 'mcp', 'token')
    this.token = this.loadOrCreate()
  }

  fingerprint(): string {
    return this.token.slice(0, 8)
  }

  authorize(header: string | undefined): boolean {
    if (!header?.startsWith('Bearer ')) return false
    const candidate = header.slice('Bearer '.length).trim()
    if (!TOKEN_PATTERN.test(candidate)) return false
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(this.token))
  }

  /** Loopback bearer tokens resolve to the local tenant; never to a request-claimed id. */
  authorizeTenant(header: string | undefined): TenantContext | undefined {
    if (!this.authorize(header)) return undefined
    return resolveTenantFromCredential('loopback-bearer')
  }

  rotate(): string {
    this.token = randomBytes(32).toString('hex')
    this.persist(this.token)
    return this.token
  }

  private loadOrCreate(): string {
    try {
      const stored = readFileSync(this.tokenPath, 'utf8').trim()
      if (TOKEN_PATTERN.test(stored)) {
        chmodSync(this.tokenPath, 0o600)
        return stored
      }
    } catch {
      // First run or an unreadable token: replace it with a new local secret.
    }
    const token = randomBytes(32).toString('hex')
    this.persist(token)
    return token
  }

  private persist(token: string): void {
    const directory = dirname(this.tokenPath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.token-${process.pid}-${Date.now()}`)
    writeFileSync(temporary, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.tokenPath)
    chmodSync(this.tokenPath, 0o600)
  }
}

export function isLoopbackRequest(hostHeader: string | undefined, originHeader: string | undefined): boolean {
  if (!hostHeader || !isLoopbackHost(hostHeader)) return false
  if (!originHeader) return true
  try {
    return isLoopbackHostname(new URL(originHeader).hostname)
  } catch {
    return false
  }
}

function isLoopbackHost(host: string): boolean {
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}
