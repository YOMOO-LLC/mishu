import type { CrmPublicConfig, CrmSaveInput } from '../../shared/contracts.js'
import type { CrmClient } from '../crm/client.js'
import { CrmConfigStore } from '../crm/config-store.js'
import { MockCrmAdapter } from '../crm/mock-adapter.js'
import { exchangeGrantCode } from '../crm/zoho/auth.js'
import { ZohoCrmClient } from '../crm/zoho/client.js'
import { normalizeZohoDataCenter } from '../crm/zoho/hosts.js'
import { ZohoSecretsStore, type ZohoSecrets } from '../crm/zoho/secrets.js'

const mockZohoFetch: typeof fetch = async () => new Response(
  JSON.stringify({ error: 'network disabled in mock mode' }),
  { status: 503, headers: { 'content-type': 'application/json' } }
)

export class CrmService {
  private readonly configStore: CrmConfigStore
  private readonly secretsStore: ZohoSecretsStore
  private readonly fetchImpl: typeof fetch
  private clientValue: CrmClient
  private syncLogProvider?: (limit?: number) => unknown[]

  constructor(userDataPath: string, isMock: boolean) {
    this.configStore = new CrmConfigStore(userDataPath)
    this.secretsStore = new ZohoSecretsStore(userDataPath)
    this.fetchImpl = isMock ? mockZohoFetch : globalThis.fetch
    this.clientValue = createClient(this.configStore.load().provider, this.secretsStore.load(), this.fetchImpl)
  }

  get(): CrmPublicConfig {
    return this.configStore.publicConfig(Boolean(this.secretsStore.load()))
  }

  async save(input: CrmSaveInput): Promise<CrmPublicConfig> {
    const saved = await persistCrmConfig(input, this.configStore, this.secretsStore, this.fetchImpl)
    this.clientValue = createClient(saved.config.provider, saved.secrets, this.fetchImpl)
    return this.configStore.publicConfig(Boolean(saved.secrets))
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.clientValue.testConnection()
      this.configStore.patch({ connected: true, lastError: undefined })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.configStore.patch({ connected: false, lastError: message })
      return { ok: false, error: message }
    }
  }

  client(): CrmClient { return this.clientValue }
  isPostCallSyncEnabled(): boolean { return this.configStore.load().postCallSync }
  markSyncSuccess(lastSyncAt: number): void { this.configStore.patch({ lastSyncAt, lastError: undefined }) }
  markSyncError(lastError: string): void { this.configStore.patch({ lastError }) }
  setSyncLogProvider(provider: ((limit?: number) => unknown[]) | undefined): void { this.syncLogProvider = provider }
  syncLog(limit?: number): unknown[] { return this.syncLogProvider?.(limit) ?? [] }
}

export async function persistCrmConfig(
  input: CrmSaveInput,
  configStore: CrmConfigStore,
  secretsStore: ZohoSecretsStore,
  fetchImpl: typeof fetch
): Promise<{ config: CrmPublicConfig; secrets?: ZohoSecrets }> {
  const value = normalizeSaveInput(input)
  const existingSecrets = secretsStore.load()
  const dataCenter = normalizeZohoDataCenter(value.dataCenter ?? existingSecrets?.dataCenter)
  let secrets = existingSecrets
  try {
    if (value.provider === 'zoho' && value.grantCode) {
      secrets = await exchangeGrantCode({
        clientId: value.clientId ?? existingSecrets?.clientId ?? '',
        clientSecret: value.clientSecret ?? existingSecrets?.clientSecret ?? '',
        grantCode: value.grantCode,
        dataCenter
      }, fetchImpl)
      secretsStore.save(secrets)
    } else if (value.provider === 'zoho' && value.refreshToken) {
      secrets = {
        clientId: requiredCredential(value.clientId ?? existingSecrets?.clientId, 'clientId'),
        clientSecret: requiredCredential(value.clientSecret ?? existingSecrets?.clientSecret, 'clientSecret'),
        refreshToken: value.refreshToken,
        dataCenter
      }
      secretsStore.save(secrets)
    }
  } catch (error) {
    configStore.patch({
      provider: value.provider,
      dataCenter,
      postCallSync: value.postCallSync ?? configStore.load().postCallSync,
      connected: false,
      lastError: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
  configStore.patch({
    provider: value.provider,
    dataCenter,
    postCallSync: value.postCallSync ?? configStore.load().postCallSync,
    connected: value.provider === 'mock',
    lastError: undefined
  })
  return {
    config: configStore.publicConfig(Boolean(secrets)),
    ...(secrets ? { secrets } : {})
  }
}

function createClient(provider: 'mock' | 'zoho', secrets: ZohoSecrets | undefined, fetchImpl: typeof fetch): CrmClient {
  if (provider === 'mock') return new MockCrmAdapter()
  if (!secrets) return new MissingZohoCredentialsClient()
  return new ZohoCrmClient(secrets, { fetch: fetchImpl })
}

class MissingZohoCredentialsClient implements CrmClient {
  private fail(): never { throw new Error('Configure Zoho Self Client credentials first') }
  async lookupByPhone(): Promise<undefined> { return this.fail() }
  async createLead(): Promise<{ id: string }> { return this.fail() }
  async addNote(): Promise<void> { return this.fail() }
  async createEvent(): Promise<void> { return this.fail() }
  async testConnection(): Promise<void> { return this.fail() }
}

function normalizeSaveInput(input: CrmSaveInput): CrmSaveInput {
  if (!input || typeof input !== 'object') throw new Error('CRM config is invalid')
  if (input.provider !== 'mock' && input.provider !== 'zoho') throw new Error('CRM provider is invalid')
  return {
    provider: input.provider,
    ...(typeof input.dataCenter === 'string' ? { dataCenter: input.dataCenter.trim() } : {}),
    ...(typeof input.clientId === 'string' && input.clientId.trim() ? { clientId: input.clientId.trim() } : {}),
    ...(typeof input.clientSecret === 'string' && input.clientSecret.trim() ? { clientSecret: input.clientSecret.trim() } : {}),
    ...(typeof input.grantCode === 'string' && input.grantCode.trim() ? { grantCode: input.grantCode.trim() } : {}),
    ...(typeof input.refreshToken === 'string' && input.refreshToken.trim() ? { refreshToken: input.refreshToken.trim() } : {}),
    ...(typeof input.postCallSync === 'boolean' ? { postCallSync: input.postCallSync } : {})
  }
}

function requiredCredential(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Zoho ${name} cannot be empty`)
  return value.trim()
}
