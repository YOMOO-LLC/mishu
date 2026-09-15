import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeZohoDataCenter, type ZohoDataCenter } from './hosts.js'

const FILE_MODE = 0o600

export interface ZohoSecrets {
  clientId: string
  clientSecret: string
  refreshToken: string
  dataCenter: ZohoDataCenter
}

export class ZohoSecretsStore {
  readonly filePath: string

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, 'crm', 'zoho-secrets.json')
  }

  load(): ZohoSecrets | undefined {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    return normalizeSecrets(JSON.parse(raw) as unknown)
  }

  save(input: ZohoSecrets): void {
    const secrets = normalizeSecrets(input)
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: FILE_MODE })
    chmodSync(this.filePath, FILE_MODE)
  }
}

function normalizeSecrets(input: unknown): ZohoSecrets {
  if (!input || typeof input !== 'object') throw new Error('Zoho credentials are invalid')
  const value = input as Record<string, unknown>
  const clientId = required(value.clientId, 'clientId')
  const clientSecret = required(value.clientSecret, 'clientSecret')
  const refreshToken = required(value.refreshToken, 'refreshToken')
  return {
    clientId,
    clientSecret,
    refreshToken,
    dataCenter: normalizeZohoDataCenter(value.dataCenter)
  }
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Zoho ${name} cannot be empty`)
  return value.trim()
}
