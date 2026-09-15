import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CallLifecycleReport, PhoneCall } from '../../shared/contracts'
import { CallStore } from '../call-store'
import { WebhookBridge } from '../webhook/bridge'
import { WebhookConfigStore } from '../webhook/config-store'
import type { CrmClient } from './client'
import { MockCrmAdapter } from './mock-adapter'
import { PostCallSync } from './post-call-sync'

function call(status: PhoneCall['status'], peer = '+1 415 555 0142'): PhoneCall {
  return { id: 'call-1', direction: 'inbound', peer, status }
}

function report(phoneCall: PhoneCall): CallLifecycleReport {
  return {
    call: phoneCall,
    runtimeMode: 'mock',
    endReason: phoneCall.status === 'ended' ? 'hangup' : undefined,
    campaign: {
      id: 'campaign-1',
      name: 'CRM Demo',
      direction: 'both',
      systemPrompt: 'Help the caller',
      voice: 'juniper',
      policy: {
        persona: 'Help the caller',
        allowedTopics: [],
        forbiddenTopics: [],
        forbiddenClaims: [],
        negativePrompt: '',
        recordingDisclosure: true,
        maxCallDurationSec: 600,
        callingHours: { timeZone: 'UTC', windows: [] },
        doNotCall: [],
        blockedCallers: []
      },
      createdAt: 1,
      updatedAt: 1
    }
  }
}

describe('PostCallSync', () => {
  let directory: string
  let callStore: CallStore
  let webhookBridge: WebhookBridge
  let sync: PostCallSync

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'crm-post-call-'))
    callStore = new CallStore(join(directory, 'calls.sqlite3'))
    webhookBridge = new WebhookBridge({
      store: callStore,
      configStore: new WebhookConfigStore(join(directory, 'webhooks'))
    })
  })

  afterEach(() => {
    sync?.dispose()
    webhookBridge.close()
    callStore.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('adds a Note when the phone already belongs to a customer', async () => {
    const adapter = new MockCrmAdapter()
    sync = createSync(adapter)

    callStore.report(report(call('ringing')))
    callStore.reportTranscriptEntry({
      id: 'transcript-1',
      speaker: 'caller',
      text: 'I would like a product demo',
      final: true,
      timestamp: 1
    })
    callStore.report(report(call('ended')))
    await waitForStatus('succeeded')

    expect(adapter.listNotes()).toHaveLength(1)
    expect(adapter.listNotes()[0]?.recordRef).toEqual({ module: 'Contacts', id: 'mock-contact-1' })
    expect(adapter.listNotes()[0]?.text).toContain('CRM Demo')
    expect(callStore.listAudit({ limit: 30 }).some(({ action }) => action === 'crm.note.created')).toBe(true)
  })

  it('creates a Lead before adding a Note when no customer matches', async () => {
    const adapter = new MockCrmAdapter()
    sync = createSync(adapter)

    callStore.report(report(call('ended', '+1 202 555 0123')))
    await waitForStatus('succeeded')

    expect(await adapter.lookupByPhone('+12025550123')).toMatchObject({
      recordRef: { module: 'Leads' }
    })
    expect(adapter.listNotes()).toHaveLength(1)
    const actions = callStore.listAudit({ limit: 30 }).map(({ action }) => action)
    expect(actions).toContain('crm.lead.created')
    expect(actions).toContain('crm.note.created')
  })

  it('records a failed job for retry and writes an audit entry', async () => {
    const failing: CrmClient = {
      async lookupByPhone() { throw new Error('temporary outage') },
      async createLead() { throw new Error('unexpected') },
      async addNote() { throw new Error('unexpected') },
      async createEvent() { throw new Error('unexpected') },
      async testConnection() { throw new Error('temporary outage') }
    }
    sync = createSync(failing)

    callStore.report(report(call('ended')))
    await waitForStatus('failed')

    expect(sync.list()[0]).toMatchObject({
      callId: 'call-1',
      status: 'failed',
      attempts: 1,
      lastError: 'temporary outage'
    })
    const row = callStore.getDatabase().prepare(
      'SELECT next_attempt_at FROM crm_sync_jobs WHERE call_id = ?'
    ).get('call-1') as { next_attempt_at: number | null }
    expect(row.next_attempt_at).not.toBeNull()
    expect(callStore.listAudit({ limit: 30 }).some(({ action }) => action === 'crm.sync.failed')).toBe(true)
  })

  function createSync(client: CrmClient): PostCallSync {
    return new PostCallSync({
      callStore,
      getClient: () => client,
      isEnabled: () => true,
      webhookBridge
    })
  }

  async function waitForStatus(status: string): Promise<void> {
    const started = Date.now()
    while (sync.list()[0]?.status !== status) {
      if (Date.now() - started > 2_000) throw new Error(`Timed out waiting for ${status}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
})
