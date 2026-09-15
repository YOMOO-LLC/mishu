import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { policyFromLegacyPrompt } from '../shared/policy'
import { CampaignStore, normalizeCampaignInput } from './campaign-store'

describe('CampaignStore', () => {
  let directory: string
  let databasePath: string
  let store: CampaignStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mishu-campaigns-'))
    databasePath = join(directory, 'campaigns.sqlite3')
    store = new CampaignStore(databasePath)
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('creates and selects a safe default campaign', () => {
    const workspace = store.getWorkspace()

    expect(workspace.campaigns).toHaveLength(1)
    expect(workspace.campaigns[0]).toMatchObject({
      name: 'Default Campaign',
      direction: 'both',
      voice: 'juniper',
      ephemeral: false
    })
    expect(workspace.selectedCampaignId).toBe(workspace.campaigns[0]?.id)
  })

  it('persists campaign settings and the selection in SQLite', () => {
    const workspace = store.save({
      name: 'Spring campaign',
      direction: 'outbound',
      systemPrompt: 'Introduce the spring package to opted-in customers and confirm a demo.',
      voice: 'maple',
      outboundCallerId: '+1 (312) 555-0198'
    })
    const selected = workspace.campaigns.find(({ id }) => id === workspace.selectedCampaignId)

    expect(selected).toMatchObject({
      name: 'Spring campaign',
      direction: 'outbound',
      voice: 'maple',
      outboundCallerId: '+13125550198'
    })

    store.close()
    store = new CampaignStore(databasePath)
    expect(store.getWorkspace().selectedCampaignId).toBe(selected?.id)
  })

  it('keeps at least one campaign', () => {
    const workspace = store.getWorkspace()

    expect(() => store.delete(workspace.selectedCampaignId)).toThrow('At least one Campaign must be kept')
  })

  it('migrates voices that GPT Live v3 does not support', () => {
    const campaignId = store.getWorkspace().selectedCampaignId
    store.close()
    const database = new DatabaseSync(databasePath)
    database.prepare('UPDATE campaigns SET voice = ? WHERE id = ?').run('marin', campaignId)
    database.close()

    store = new CampaignStore(databasePath)

    expect(store.getWorkspace().campaigns[0]?.voice).toBe('juniper')
  })

  it('migrates the ephemeral column onto an existing campaign database', () => {
    store.close()
    const database = new DatabaseSync(databasePath)
    database.exec('ALTER TABLE campaigns DROP COLUMN ephemeral')
    database.close()

    store = new CampaignStore(databasePath)

    const migrated = new DatabaseSync(databasePath)
    const columns = migrated.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>
    migrated.close()
    expect(columns.some(({ name }) => name === 'ephemeral')).toBe(true)
    expect(store.getWorkspace().campaigns[0]?.ephemeral).toBe(false)
  })

  it('filters ephemeral campaigns by default and never selects them', () => {
    const selectedCampaignId = store.getWorkspace().selectedCampaignId
    const workspace = store.save({
      name: 'One-time task',
      direction: 'outbound',
      systemPrompt: 'Confirm attendance.',
      voice: 'maple'
    }, { ephemeral: true, includeEphemeral: true })
    const ephemeral = workspace.campaigns.find(({ ephemeral }) => ephemeral)

    expect(ephemeral).toBeTruthy()
    expect(workspace.selectedCampaignId).toBe(selectedCampaignId)
    expect(store.getWorkspace().campaigns.some(({ id }) => id === ephemeral?.id)).toBe(false)
    expect(store.getWorkspace({ includeEphemeral: true }).campaigns).toContainEqual(ephemeral)
    expect(store.getCampaign(ephemeral!.id)).toEqual(ephemeral)
    expect(() => store.select(ephemeral!.id)).toThrow('cannot be selected')
    expect(() => store.delete(selectedCampaignId)).toThrow('At least one Campaign must be kept')
  })

  it('derives a policy from the legacy prompt when the policy_json column is absent', () => {
    const campaignId = store.getWorkspace().selectedCampaignId
    const prompt = 'Introduce the spring package to opted-in customers and confirm a demo.'
    store.close()
    const database = new DatabaseSync(databasePath)
    database.prepare('UPDATE campaigns SET system_prompt = ? WHERE id = ?').run(prompt, campaignId)
    database.exec('ALTER TABLE campaigns DROP COLUMN policy_json')
    database.close()

    store = new CampaignStore(databasePath)

    const campaign = store.getWorkspace().campaigns[0]
    expect(campaign?.systemPrompt).toBe(prompt)
    expect(campaign?.policy.persona).toBe(prompt)
  })

  it('logs a warning and falls back to the legacy prompt when policy_json is invalid', () => {
    const campaignId = store.getWorkspace().selectedCampaignId
    const prompt = 'Introduce the spring package to opted-in customers and confirm a demo.'
    store.close()
    const database = new DatabaseSync(databasePath)
    database.prepare('UPDATE campaigns SET system_prompt = ? WHERE id = ?').run(prompt, campaignId)
    database.prepare('UPDATE campaigns SET policy_json = ? WHERE id = ?').run('{invalid json', campaignId)
    database.close()

    const warnings: string[] = []
    store = new CampaignStore(databasePath, { logger: (message) => warnings.push(message) })

    const campaign = store.getWorkspace().campaigns[0]
    expect(campaign?.systemPrompt).toBe(prompt)
    expect(campaign?.policy.persona).toBe(prompt)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('policy_json')
  })

  it('persists the full systemPrompt independently from the policy persona', () => {
    const workspace = store.save({
      name: 'Promo Campaign',
      direction: 'outbound',
      systemPrompt: 'Old prompt',
      voice: 'maple',
      policy: {
        persona: 'Introduce the spring package to opted-in customers.',
        allowedTopics: ['package', 'booking'],
        forbiddenTopics: ['competitors'],
        forbiddenClaims: [],
        negativePrompt: '',
        recordingDisclosure: true,
        maxCallDurationSec: 300,
        callingHours: { timeZone: 'Asia/Shanghai', windows: [{ days: [1, 2, 3], start: '09:00', end: '18:00' }] },
        doNotCall: [],
        blockedCallers: []
      }
    })
    const saved = workspace.campaigns.find(({ id }) => id === workspace.selectedCampaignId)

    expect(saved?.systemPrompt).toBe('Old prompt')
    expect(saved?.policy.persona).toBe('Introduce the spring package to opted-in customers.')
    expect(saved?.policy.maxCallDurationSec).toBe(300)
    expect(saved?.policy.allowedTopics).toEqual(['package', 'booking'])

    store.close()
    store = new CampaignStore(databasePath)
    const reloaded = store.getWorkspace().campaigns.find(({ id }) => id === workspace.selectedCampaignId)
    expect(reloaded?.systemPrompt).toBe('Old prompt')
    expect(reloaded?.policy.persona).toBe('Introduce the spring package to opted-in customers.')
    expect(reloaded?.policy.callingHours.timeZone).toBe('Asia/Shanghai')
  })

  it('accepts a systemPrompt with a policy that has no persona', () => {
    const workspace = store.save({
      name: 'Script only',
      direction: 'outbound',
      systemPrompt: 'Follow the complete appointment reminder script.',
      voice: 'sol',
      policy: policyFromLegacyPrompt('')
    })
    const saved = workspace.campaigns.find(({ name }) => name === 'Script only')

    expect(saved?.systemPrompt).toBe('Follow the complete appointment reminder script.')
    expect(saved?.policy.persona).toBe('')
  })

  it('uses policy.persona as the legacy prompt fallback when systemPrompt is empty', () => {
    const workspace = store.save({
      name: 'Persona only',
      direction: 'outbound',
      systemPrompt: '',
      voice: 'sol',
      policy: { ...policyFromLegacyPrompt(''), persona: 'You are the appointment coordinator.' }
    })
    const saved = workspace.campaigns.find(({ name }) => name === 'Persona only')

    expect(saved?.systemPrompt).toBe('You are the appointment coordinator.')
    expect(saved?.policy.persona).toBe('You are the appointment coordinator.')
  })

  it('rejects a campaign only when both systemPrompt and policy.persona are empty', () => {
    expect(() => store.save({
      name: 'Missing instructions',
      direction: 'outbound',
      systemPrompt: '',
      voice: 'sol',
      policy: policyFromLegacyPrompt('')
    })).toThrow('System prompt cannot be empty')
  })

  it('clamps an invalid policy field and reports a warning at the boundary', () => {
    const warnings: string[] = []
    store.close()
    store = new CampaignStore(databasePath, { logger: (message) => warnings.push(message) })

    const workspace = store.save({
      name: 'Invalid policy',
      direction: 'both',
      systemPrompt: 'Prompt',
      voice: 'juniper',
      policy: {
        persona: 'p',
        allowedTopics: [],
        forbiddenTopics: [],
        forbiddenClaims: [],
        negativePrompt: '',
        recordingDisclosure: true,
        maxCallDurationSec: 5,
        callingHours: { timeZone: 'UTC', windows: [] },
        doNotCall: [],
        blockedCallers: []
      }
    })

    expect(workspace.campaigns.find(({ name }) => name === 'Invalid policy')?.policy.maxCallDurationSec).toBe(30)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('maxCallDurationSec')
  })

  it('logs each invalid stored policy field only once per campaign across reads', () => {
    const campaignId = store.getWorkspace().selectedCampaignId
    store.close()
    const database = new DatabaseSync(databasePath)
    const policy = JSON.parse(database.prepare(
      'SELECT policy_json FROM campaigns WHERE id = ?'
    ).get(campaignId)?.policy_json as string) as Record<string, unknown>
    database.prepare('UPDATE campaigns SET policy_json = ? WHERE id = ?').run(
      JSON.stringify({
        ...policy,
        copilot: {
          ...(policy.copilot as Record<string, unknown>),
          maxToolCallsPerTurn: 99
        }
      }),
      campaignId
    )
    database.close()

    const warnings: string[] = []
    store = new CampaignStore(databasePath, { logger: (message) => warnings.push(message) })
    store.getWorkspace()
    store.getWorkspace()
    store.getCampaign(campaignId)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('copilot.maxToolCallsPerTurn')
  })
})

describe('normalizeCampaignInput', () => {
  it('rejects invalid voice and phone-number input at the main-process boundary', () => {
    expect(() => normalizeCampaignInput({
      name: 'Test',
      direction: 'both',
      systemPrompt: 'Help the caller',
      voice: 'invalid' as never
    })).toThrow('voice is invalid')

    expect(() => normalizeCampaignInput({
      name: 'Test',
      direction: 'both',
      systemPrompt: 'Help the caller',
      voice: 'juniper',
      inboundNumber: '312-555-0198'
    })).toThrow('E.164')
  })

  it('rejects a known voice that GPT Live v3 does not support', () => {
    expect(() => normalizeCampaignInput({
      name: 'Test',
      direction: 'both',
      systemPrompt: 'Help the caller',
      voice: 'marin' as never
    })).toThrow('voice is invalid')
  })
})

describe('CampaignStore default English seed migration', () => {
  const legacyName = '\u9ed8\u8ba4 Campaign'
  const legacyPrompt = '\u793c\u8c8c\u5730\u63a5\u542c\u6765\u7535\u6216\u8054\u7cfb\u5bf9\u65b9\uff0c\u4e86\u89e3\u5bf9\u65b9\u7684\u9700\u6c42\uff0c\u5e76\u63d0\u4f9b\u529b\u6240\u80fd\u53ca\u7684\u5e2e\u52a9\u3002'
  const englishName = 'Default Campaign'
  const englishPrompt = 'Answer or place the call politely, learn what the other person needs, and help within your ability.'

  let directory: string
  let databasePath: string
  let store: CampaignStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mishu-campaign-seed-'))
    databasePath = join(directory, 'campaigns.sqlite3')
    store = new CampaignStore(databasePath)
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('replaces unmodified Chinese default name and prompt', () => {
    const campaignId = store.getWorkspace().selectedCampaignId
    store.close()
    const database = new DatabaseSync(databasePath)
    const policy = JSON.parse((
      database.prepare('SELECT policy_json FROM campaigns WHERE id = ?').get(campaignId) as { policy_json: string }
    ).policy_json) as Record<string, unknown>
    database.prepare('UPDATE campaigns SET name = ?, system_prompt = ?, policy_json = ? WHERE id = ?').run(
      legacyName,
      legacyPrompt,
      JSON.stringify({ ...policy, persona: legacyPrompt }),
      campaignId
    )
    database.close()

    store = new CampaignStore(databasePath)
    const campaign = store.getWorkspace().campaigns[0]
    expect(campaign).toMatchObject({
      name: englishName,
      systemPrompt: englishPrompt
    })
    expect(campaign?.policy.persona).toBe(englishPrompt)
  })

  it('leaves user-edited campaign copy unchanged', () => {
    const current = store.getWorkspace().campaigns[0]!
    store.save({
      id: current.id,
      name: 'Spring campaign',
      direction: current.direction,
      systemPrompt: 'Introduce the spring package to opted-in customers and confirm a demo.',
      voice: current.voice,
      policy: current.policy
    })
    store.close()
    store = new CampaignStore(databasePath)
    expect(store.getWorkspace().campaigns[0]).toMatchObject({
      name: 'Spring campaign',
      systemPrompt: 'Introduce the spring package to opted-in customers and confirm a demo.'
    })
  })

  it('is a no-op when the English defaults are already stored', () => {
    const first = store.getWorkspace().campaigns[0]!
    store.close()
    store = new CampaignStore(databasePath)
    expect(store.getWorkspace().campaigns[0]).toMatchObject({
      id: first.id,
      name: first.name,
      systemPrompt: first.systemPrompt,
      updatedAt: first.updatedAt
    })
  })
})
