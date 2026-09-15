import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CrmProvider, CrmPublicConfig } from '../../shared/contracts.js'
import { normalizeZohoDataCenter } from './zoho/hosts.js'

const FILE_MODE = 0o600

interface StoredCrmConfig {
  provider: CrmProvider
  postCallSync: boolean
  dataCenter: string
  connected: boolean
  lastSyncAt?: number
  lastError?: string
}

const DEFAULT_CONFIG: StoredCrmConfig = {
  provider: 'mock',
  postCallSync: false,
  dataCenter: 'com',
  connected: true
}

export class CrmConfigStore {
  readonly filePath: string

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, 'crm', 'config.json')
  }

  load(): StoredCrmConfig {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_CONFIG }
      throw error
    }
    return normalizeStoredConfig(JSON.parse(raw) as unknown)
  }

  save(input: StoredCrmConfig): StoredCrmConfig {
    const normalized = normalizeStoredConfig(input)
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: FILE_MODE })
    chmodSync(this.filePath, FILE_MODE)
    return normalized
  }

  patch(input: Partial<StoredCrmConfig>): StoredCrmConfig {
    return this.save({ ...this.load(), ...input })
  }

  publicConfig(hasCredentials: boolean): CrmPublicConfig {
    const config = this.load()
    return {
      provider: config.provider,
      connected: config.provider === 'mock' ? true : config.connected,
      dataCenter: config.dataCenter,
      hasCredentials,
      postCallSync: config.postCallSync,
      ...(config.lastSyncAt !== undefined ? { lastSyncAt: config.lastSyncAt } : {}),
      ...(config.lastError ? { lastError: config.lastError } : {})
    }
  }
}

function normalizeStoredConfig(input: unknown): StoredCrmConfig {
  if (!input || typeof input !== 'object') throw new Error('CRM config is invalid')
  const value = input as Record<string, unknown>
  const provider = value.provider === 'zoho' ? 'zoho' : 'mock'
  const dataCenter = normalizeZohoDataCenter(value.dataCenter)
  const lastSyncAt = finiteTimestamp(value.lastSyncAt)
  const lastError = typeof value.lastError === 'string' && value.lastError.trim()
    ? value.lastError.trim().slice(0, 500)
    : undefined
  return {
    provider,
    postCallSync: value.postCallSync === true,
    dataCenter,
    connected: provider === 'mock' || value.connected === true,
    ...(lastSyncAt !== undefined ? { lastSyncAt } : {}),
    ...(lastError ? { lastError } : {})
  }
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}
