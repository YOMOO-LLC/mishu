import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  REALTIME_VOICES,
  type Campaign,
  type CampaignDirection,
  type CampaignInput,
  type CampaignPolicy,
  type CampaignWorkspace,
  type RealtimeVoice
} from '../shared/contracts.js'
import {
  normalizeCampaignPolicy,
  policyFromLegacyPrompt,
  type CampaignPolicyNormalizationOptions
} from '../shared/policy.js'
import { LOCAL_TENANT_ID, normalizeTenantId } from './tenant.js'
import {
  ensureTenantColumn,
  hasUniqueOn,
  rebuildSqliteTable
} from './sqlite-tenant.js'

const SELECTED_CAMPAIGN_KEY = 'selected_campaign_id'
const DEFAULT_CAMPAIGN_NAME = 'Default Campaign'
const DEFAULT_PROMPT = 'Answer or place the call politely, learn what the other person needs, and help within your ability.'
const LEGACY_DEFAULT_CAMPAIGN_NAME = '\u9ed8\u8ba4 Campaign'
const LEGACY_DEFAULT_PROMPT = '\u793c\u8c8c\u5730\u63a5\u542c\u6765\u7535\u6216\u8054\u7cfb\u5bf9\u65b9\uff0c\u4e86\u89e3\u5bf9\u65b9\u7684\u9700\u6c42\uff0c\u5e76\u63d0\u4f9b\u529b\u6240\u80fd\u53ca\u7684\u5e2e\u52a9\u3002'
const MAX_NAME_LENGTH = 80
const MAX_PROMPT_LENGTH = 8_000
const PHONE_NUMBER_PATTERN = /^\+[1-9]\d{7,14}$/
const CAMPAIGN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/

interface CampaignRow {
  id: string
  name: string
  direction: CampaignDirection
  system_prompt: string
  voice: RealtimeVoice
  policy_json: string | null | undefined
  inbound_number: string | null
  outbound_caller_id: string | null
  ephemeral: number
  created_at: number
  updated_at: number
}

export const CAMPAIGNS_SCHEMA_VERSION = 1

export interface CampaignStoreOptions {
  logger?: (message: string) => void
  tenantId?: string
}

export interface CampaignWorkspaceOptions {
  includeEphemeral?: boolean
}

export interface CampaignSaveOptions extends CampaignWorkspaceOptions {
  ephemeral?: boolean
}

export class CampaignStore {
  readonly tenantId: string
  private readonly database: DatabaseSync
  private readonly logger: (message: string) => void
  private readonly loggedPolicyWarnings = new Set<string>()

  constructor(path: string, options: CampaignStoreOptions = {}) {
    this.database = new DatabaseSync(path)
    this.tenantId = normalizeTenantId(options.tenantId ?? LOCAL_TENANT_ID)
    this.logger = options.logger ?? ((message) => console.warn(message))
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    this.migrate()
    this.migrateUnsupportedVoices()
    this.migrateDefaultCampaignCopy()
    this.ensureDefaultCampaign()
  }

  getWorkspace(options: CampaignWorkspaceOptions = {}): CampaignWorkspace {
    const selectableCampaigns = this.listCampaigns(false)
    const campaigns = options.includeEphemeral ? this.listCampaigns(true) : selectableCampaigns
    let selectedCampaignId = this.getSetting(SELECTED_CAMPAIGN_KEY)
    if (!selectedCampaignId || !selectableCampaigns.some(({ id }) => id === selectedCampaignId)) {
      selectedCampaignId = selectableCampaigns[0]?.id
      if (!selectedCampaignId) throw new Error('Campaign store did not contain a default campaign')
      this.setSetting(SELECTED_CAMPAIGN_KEY, selectedCampaignId)
    }
    return { campaigns, selectedCampaignId }
  }

  getCampaign(id: string): Campaign | undefined {
    return this.findCampaign(id)
  }

  save(input: CampaignInput, options: CampaignSaveOptions = {}): CampaignWorkspace {
    const campaign = normalizeCampaignInput(input, { onWarning: this.logger })
    const policy = campaign.policy ?? policyFromLegacyPrompt(campaign.systemPrompt)
    const policyJson = JSON.stringify(policy)
    const systemPrompt = campaign.systemPrompt.trim()
    if (!systemPrompt) throw new Error('System prompt cannot be empty')
    if (systemPrompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`System prompt cannot exceed ${MAX_PROMPT_LENGTH} characters`)
    }
    const now = Date.now()
    let ephemeral = options.ephemeral === true
    if (campaign.id) {
      const existing = this.findCampaign(campaign.id)
      if (!existing) throw new Error('Campaign does not exist')
      ephemeral = existing.ephemeral === true
      this.database.prepare(`
        UPDATE campaigns
        SET name = ?, direction = ?, system_prompt = ?, policy_json = ?, voice = ?,
            inbound_number = ?, outbound_caller_id = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?
      `).run(
        campaign.name,
        campaign.direction,
        systemPrompt,
        policyJson,
        campaign.voice,
        campaign.inboundNumber ?? null,
        campaign.outboundCallerId ?? null,
        now,
        this.tenantId,
        campaign.id
      )
      if (!ephemeral) this.setSetting(SELECTED_CAMPAIGN_KEY, campaign.id)
    } else {
      const id = randomUUID()
      this.database.prepare(`
        INSERT INTO campaigns (
          id, tenant_id, name, direction, system_prompt, policy_json, voice, inbound_number,
          outbound_caller_id, ephemeral, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        this.tenantId,
        campaign.name,
        campaign.direction,
        systemPrompt,
        policyJson,
        campaign.voice,
        campaign.inboundNumber ?? null,
        campaign.outboundCallerId ?? null,
        ephemeral ? 1 : 0,
        now,
        now
      )
      if (!ephemeral) this.setSetting(SELECTED_CAMPAIGN_KEY, id)
    }
    return this.getWorkspace({ includeEphemeral: options.includeEphemeral ?? ephemeral })
  }

  delete(id: string): CampaignWorkspace {
    const campaignId = normalizeCampaignId(id)
    const campaign = this.findCampaign(campaignId)
    if (!campaign) throw new Error('Campaign does not exist')
    if (!campaign.ephemeral) {
      const count = this.database.prepare(
        'SELECT COUNT(*) AS count FROM campaigns WHERE tenant_id = ? AND ephemeral = 0'
      ).get(this.tenantId) as { count: number }
      if (count.count <= 1) throw new Error('At least one Campaign must be kept')
    }
    this.database.prepare('DELETE FROM campaigns WHERE tenant_id = ? AND id = ?').run(this.tenantId, campaignId)
    if (this.getSetting(SELECTED_CAMPAIGN_KEY) === campaignId) {
      const next = this.listCampaigns(false)[0]
      if (next) this.setSetting(SELECTED_CAMPAIGN_KEY, next.id)
    }
    return this.getWorkspace()
  }

  select(id: string): CampaignWorkspace {
    const campaignId = normalizeCampaignId(id)
    const campaign = this.findCampaign(campaignId)
    if (!campaign) throw new Error('Campaign does not exist')
    if (campaign.ephemeral) throw new Error('Ephemeral campaigns cannot be selected')
    this.setSetting(SELECTED_CAMPAIGN_KEY, campaignId)
    return this.getWorkspace()
  }

  close(): void {
    this.database.close()
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
        name TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'both')),
        system_prompt TEXT NOT NULL,
        voice TEXT NOT NULL,
        inbound_number TEXT,
        outbound_caller_id TEXT,
        ephemeral INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS app_settings (
        tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (tenant_id, key)
      ) STRICT;
    `)
    this.migratePolicyColumn()
    this.migrateEphemeralColumn()
    ensureTenantColumn(this.database, 'campaigns')
    ensureTenantColumn(this.database, 'app_settings')
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaigns_tenant_id
        ON campaigns (tenant_id, id);
    `)
    if (!hasUniqueOn(this.database, 'app_settings', ['tenant_id', 'key'])) {
      this.database.exec('PRAGMA foreign_keys = OFF;')
      try {
        rebuildSqliteTable(
          this.database,
          'app_settings',
          `CREATE TABLE app_settings (
            tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (tenant_id, key)
          ) STRICT;`,
          ['tenant_id', 'key', 'value']
        )
      } finally {
        this.database.exec('PRAGMA foreign_keys = ON;')
      }
    }
    const row = this.database.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
      | { version: number | null }
      | undefined
    if ((row?.version ?? 0) < CAMPAIGNS_SCHEMA_VERSION) {
      this.database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CAMPAIGNS_SCHEMA_VERSION)
    }
  }

  private migratePolicyColumn(): void {
    const columns = this.database.prepare('PRAGMA table_info(campaigns)').all() as Array<{
      name: string
    }>
    if (columns.some(({ name }) => name === 'policy_json')) return
    this.database.exec('ALTER TABLE campaigns ADD COLUMN policy_json TEXT')
  }

  private migrateEphemeralColumn(): void {
    const columns = this.database.prepare('PRAGMA table_info(campaigns)').all() as Array<{
      name: string
    }>
    if (columns.some(({ name }) => name === 'ephemeral')) return
    this.database.exec('ALTER TABLE campaigns ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0')
  }

  private ensureDefaultCampaign(): void {
    const row = this.database.prepare(
      'SELECT id FROM campaigns WHERE tenant_id = ? AND ephemeral = 0 LIMIT 1'
    ).get(this.tenantId) as { id: string } | undefined
    if (row) return
    const id = randomUUID()
    const now = Date.now()
    const policy = policyFromLegacyPrompt(DEFAULT_PROMPT)
    this.database.prepare(`
      INSERT INTO campaigns (
        id, tenant_id, name, direction, system_prompt, policy_json, voice, created_at, updated_at
      ) VALUES (?, ?, ?, 'both', ?, ?, 'juniper', ?, ?)
    `).run(id, this.tenantId, DEFAULT_CAMPAIGN_NAME, DEFAULT_PROMPT, JSON.stringify(policy), now, now)
    this.setSetting(SELECTED_CAMPAIGN_KEY, id)
  }

  private migrateDefaultCampaignCopy(): void {
    const now = Date.now()
    this.database.prepare(`
      UPDATE campaigns
      SET name = ?, updated_at = ?
      WHERE tenant_id = ? AND name = ?
    `).run(DEFAULT_CAMPAIGN_NAME, now, this.tenantId, LEGACY_DEFAULT_CAMPAIGN_NAME)

    const rows = this.database.prepare(
      'SELECT id, policy_json FROM campaigns WHERE tenant_id = ? AND system_prompt = ?'
    ).all(this.tenantId, LEGACY_DEFAULT_PROMPT) as Array<{ id: string; policy_json: string | null }>
    for (const row of rows) {
      let policyJson = row.policy_json
      if (policyJson) {
        try {
          const policy = JSON.parse(policyJson) as CampaignPolicy
          if (policy.persona === LEGACY_DEFAULT_PROMPT) policy.persona = DEFAULT_PROMPT
          policyJson = JSON.stringify(policy)
        } catch {
          policyJson = JSON.stringify(policyFromLegacyPrompt(DEFAULT_PROMPT))
        }
      } else {
        policyJson = JSON.stringify(policyFromLegacyPrompt(DEFAULT_PROMPT))
      }
      this.database.prepare(`
        UPDATE campaigns
        SET system_prompt = ?, policy_json = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?
      `).run(DEFAULT_PROMPT, policyJson, now, this.tenantId, row.id)
    }
  }

  private migrateUnsupportedVoices(): void {
    const placeholders = REALTIME_VOICES.map(() => '?').join(', ')
    this.database.prepare(`
      UPDATE campaigns
      SET voice = 'juniper', updated_at = ?
      WHERE tenant_id = ? AND voice NOT IN (${placeholders})
    `).run(Date.now(), this.tenantId, ...REALTIME_VOICES)
  }

  private listCampaigns(includeEphemeral: boolean): Campaign[] {
    const rows = this.database.prepare(
      `SELECT * FROM campaigns
       WHERE tenant_id = ? ${includeEphemeral ? '' : 'AND ephemeral = 0'}
       ORDER BY updated_at DESC, name COLLATE NOCASE ASC`
    ).all(this.tenantId) as unknown as CampaignRow[]
    return rows.map((row) => this.toCampaign(row))
  }

  private findCampaign(id: string): Campaign | undefined {
    const row = this.database.prepare('SELECT * FROM campaigns WHERE tenant_id = ? AND id = ?').get(this.tenantId, id) as
      | CampaignRow
      | undefined
    return row ? this.toCampaign(row) : undefined
  }

  private getSetting(key: string): string | undefined {
    const row = this.database.prepare(
      'SELECT value FROM app_settings WHERE tenant_id = ? AND key = ?'
    ).get(this.tenantId, key) as { value: string } | undefined
    return row?.value
  }

  private setSetting(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO app_settings (tenant_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
    `).run(this.tenantId, key, value)
  }

  private toCampaign(row: CampaignRow): Campaign {
    const policy = this.parsePolicy(row)
    return {
      id: row.id,
      name: row.name,
      direction: row.direction,
      systemPrompt: row.system_prompt,
      policy,
      voice: row.voice,
      ...(row.inbound_number ? { inboundNumber: row.inbound_number } : {}),
      ...(row.outbound_caller_id ? { outboundCallerId: row.outbound_caller_id } : {}),
      ephemeral: row.ephemeral === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private parsePolicy(row: CampaignRow): CampaignPolicy {
    if (row.policy_json) {
      try {
        return normalizeCampaignPolicy(JSON.parse(row.policy_json), {
          onWarning: (message) => this.logPolicyWarningOnce(row.id, message)
        })
      } catch (error) {
        this.logPolicyWarningOnce(
          row.id,
          `Campaign ${row.id} policy_json failed to parse or validate; falling back to the legacy prompt: ${error instanceof Error ? error.message : String(error)}`
        )
        return policyFromLegacyPrompt(row.system_prompt)
      }
    }
    return policyFromLegacyPrompt(row.system_prompt)
  }

  private logPolicyWarningOnce(campaignId: string, message: string): void {
    const field = /^Campaign policy field (.+?) is invalid: /.exec(message)?.[1] ?? 'policy_json'
    const key = `${campaignId}:${field}`
    if (this.loggedPolicyWarnings.has(key)) return
    this.loggedPolicyWarnings.add(key)
    this.logger(message)
  }
}

export function normalizeCampaignInput(
  input: CampaignInput,
  options: CampaignPolicyNormalizationOptions = {}
): CampaignInput & { systemPrompt: string } {
  if (!input || typeof input !== 'object') throw new Error('Campaign config is invalid')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw new Error('Campaign name cannot be empty')
  if (name.length > MAX_NAME_LENGTH) throw new Error(`Campaign name cannot exceed ${MAX_NAME_LENGTH} characters`)
  const rawPrompt = typeof input.systemPrompt === 'string' ? input.systemPrompt.trim() : ''
  const policy = input.policy === undefined
    ? policyFromLegacyPrompt(rawPrompt)
    : normalizeCampaignPolicy(input.policy, options)
  const systemPrompt = rawPrompt || policy.persona.trim()
  if (!systemPrompt) throw new Error('System prompt cannot be empty')
  if (systemPrompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`System prompt cannot exceed ${MAX_PROMPT_LENGTH} characters`)
  }
  if (!['inbound', 'outbound', 'both'].includes(input.direction)) {
    throw new Error('Campaign call direction is invalid')
  }
  if (!REALTIME_VOICES.includes(input.voice)) throw new Error('Campaign voice is invalid')
  const inboundNumber = normalizeOptionalPhoneNumber(input.inboundNumber, 'inbound number')
  const outboundCallerId = normalizeOptionalPhoneNumber(input.outboundCallerId, 'outbound number')
  return {
    ...(input.id ? { id: normalizeCampaignId(input.id) } : {}),
    name,
    direction: input.direction,
    systemPrompt,
    policy,
    voice: input.voice,
    ...(inboundNumber ? { inboundNumber } : {}),
    ...(outboundCallerId ? { outboundCallerId } : {})
  }
}

function normalizeCampaignId(id: unknown): string {
  if (typeof id !== 'string' || !CAMPAIGN_ID_PATTERN.test(id)) throw new Error('Campaign ID is invalid')
  return id
}

function normalizeOptionalPhoneNumber(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${label} is invalid`)
  const normalized = value.replace(/[\s()-]/g, '')
  if (!PHONE_NUMBER_PATTERN.test(normalized)) throw new Error(`${label} must use E.164 format, for example +13125550198`)
  return normalized
}
