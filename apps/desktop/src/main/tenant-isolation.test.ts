import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppointmentStore } from './appointments/store.js'
import { CallStore } from './call-store.js'
import { CampaignStore } from './campaign-store.js'
import { CallService } from './services/call-service.js'
import { CampaignService } from './services/campaign-service.js'
import { ServiceError } from './services/service-error.js'
import { LOCAL_TENANT_ID } from './tenant.js'
import { hasUniqueOn, primaryKeyColumns } from './sqlite-tenant.js'
import { WebhookOutbox } from './webhook/outbox.js'

describe('tenant isolation', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'live-phone-tenant-iso-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('isolates campaigns and settings across tenants and hides existence', () => {
    const path = join(directory, 'campaigns.sqlite3')
    const local = new CampaignStore(path)
    const t2 = new CampaignStore(path, { tenantId: 't2' })
    const localId = local.getWorkspace().selectedCampaignId
    const t2Id = t2.getWorkspace().selectedCampaignId

    expect(local.getCampaign(t2Id)).toBeUndefined()
    expect(t2.getCampaign(localId)).toBeUndefined()
    expect(local.getWorkspace().campaigns.every(({ id }) => id !== t2Id)).toBe(true)

    const localService = new CampaignService(local)
    const t2Service = new CampaignService(t2)
    try {
      t2Service.get(localId, { reveal: true })
      throw new Error('expected NOT_FOUND')
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError)
      expect((error as ServiceError).code).toBe('NOT_FOUND')
      expect((error as ServiceError).message).toBe('Campaign not found')
    }
    local.close()
    t2.close()
  })

  it('isolates calls, contacts, budgets, audit, and idempotency keys', () => {
    const path = join(directory, 'calls.sqlite3')
    const local = new CallStore(path)
    const t2 = new CallStore(path, { tenantId: 't2' })
    local.report({
      call: { id: 'call-local', direction: 'inbound', peer: '+13125550198', status: 'active' },
      runtimeMode: 'mock'
    })
    t2.report({
      call: { id: 'call-t2', direction: 'inbound', peer: '+13125550199', status: 'active' },
      runtimeMode: 'mock'
    })

    expect(local.getCall('call-t2')).toBeUndefined()
    expect(t2.getCall('call-local')).toBeUndefined()
    expect(local.listCalls({}).map(({ id }) => id)).toEqual(['call-local'])
    expect(t2.listCalls({}).map(({ id }) => id)).toEqual(['call-t2'])

    const now = Date.now()
    local.createCallTask({
      id: 'task-local', to: '+13125550198', campaignId: 'c1', goal: 'Book',
      constraints: {}, idempotencyKey: 'same-key', status: 'queued', attempts: 0,
      createdBy: 'http', createdAt: now, updatedAt: now
    })
    expect(
      t2.createCallTask({
        id: 'task-t2', to: '+13125550199', campaignId: 'c2', goal: 'Book',
        constraints: {}, idempotencyKey: 'same-key', status: 'queued', attempts: 0,
        createdBy: 'http', createdAt: now, updatedAt: now
      }).id
    ).toBe('task-t2')
    expect(local.getCallTask('task-t2')).toBeUndefined()
    expect(t2.getCallTaskByIdempotencyKey('same-key')?.id).toBe('task-t2')

    local.putContactCard({
      phone: '+13125550198', facts: {}, source: 'test', createdAt: now, updatedAt: now
    })
    t2.putContactCard({
      phone: '+13125550198', facts: { note: 'other tenant' }, source: 'test', createdAt: now, updatedAt: now
    })
    expect(local.getContactCard('+13125550198')?.facts).toEqual({})
    expect(t2.getContactCard('+13125550198')?.facts).toEqual({ note: 'other tenant' })

    local.saveCallBudget({
      enabled: true, dailyMaxCalls: 3, dailyMaxMinutes: 10,
      allowedPrefixes: [], allowedNumbers: [],
      allowedHours: { timeZone: 'UTC', windows: [] }, killSwitch: false
    })
    expect(t2.getCallBudget()).toMatchObject({ enabled: false, dailyMaxCalls: 0 })

    expect(local.listAudit({ limit: 20 }).every((entry) => entry.tenantId === LOCAL_TENANT_ID)).toBe(true)
    expect(t2.listAudit({ limit: 20 }).every((entry) => entry.tenantId === 't2')).toBe(true)

    const calls = new CallService(t2, new AppointmentStore(t2), {
      initialize() {},
      close() {}
    } as never)
    try {
      calls.get('call-local')
      throw new Error('expected NOT_FOUND')
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError)
      expect((error as ServiceError).code).toBe('NOT_FOUND')
      expect((error as ServiceError).message).toBe('Call not found')
    }

    local.close()
    t2.close()
  })

  it('isolates appointments and webhook idempotency keys', () => {
    const path = join(directory, 'calls.sqlite3')
    const localCalls = new CallStore(path)
    const t2Calls = new CallStore(path, { tenantId: 't2' })
    localCalls.report({
      call: { id: 'call-local', direction: 'inbound', peer: '+13125550198', status: 'active' },
      runtimeMode: 'mock'
    })
    t2Calls.report({
      call: { id: 'call-t2', direction: 'inbound', peer: '+13125550198', status: 'active' },
      runtimeMode: 'mock'
    })
    const localAppt = new AppointmentStore(localCalls)
    const t2Appt = new AppointmentStore(t2Calls)
    const input = {
      campaignId: 'campaign-1',
      peer: '+13125550198',
      startAt: '2030-01-07T10:00:00Z',
      endAt: '2030-01-07T10:30:00Z',
      timeZone: 'UTC',
      source: 'manual' as const
    }
    const first = localAppt.create({ ...input, callId: 'call-local' })
    const second = t2Appt.create({ ...input, callId: 'call-t2' })
    expect(second.id).not.toBe(first.id)
    expect(t2Appt.get(first.id)).toBeUndefined()
    expect(localAppt.listByPeer('+13125550198')).toHaveLength(1)

    const db = localCalls.getDatabase()
    const localOutbox = new WebhookOutbox({ database: db, tenantId: 'local' })
    const t2Outbox = new WebhookOutbox({ database: db, tenantId: 't2' })
    const a = localOutbox.enqueue({ event: 'call.started', idempotencyKey: 'hook-1' })
    const b = t2Outbox.enqueue({ event: 'call.started', idempotencyKey: 'hook-1' })
    expect(a.alreadyExisted).toBe(false)
    expect(b.alreadyExisted).toBe(false)
    expect(a.id).not.toBe(b.id)
    expect(localOutbox.getStatus(b.id)).toBeUndefined()
    expect(t2Outbox.list().every((row) => row.payload.tenantId === 't2')).toBe(true)

    localCalls.close()
    t2Calls.close()
  })

  it('keeps tenant-scoped unique keys after opening a shared database twice', () => {
    const path = join(directory, 'calls.sqlite3')
    const first = new CallStore(path)
    first.close()
    const second = new CallStore(path)
    const db = second.getDatabase()
    expect(hasUniqueOn(db, 'call_tasks', ['tenant_id', 'idempotency_key'])).toBe(true)
    expect(hasUniqueOn(db, 'call_results', ['tenant_id', 'call_id', 'schema_hash'])).toBe(true)
    expect(primaryKeyColumns(db, 'contact_cards')).toEqual(['tenant_id', 'phone'])
    expect(primaryKeyColumns(db, 'call_budgets')).toEqual(['tenant_id'])
    second.close()
  })
})

describe('legacy schema tenant migrations', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'live-phone-tenant-migrate-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('migrates a pre-tenant campaigns database and can rerun', () => {
    const path = join(directory, 'campaigns.sqlite3')
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TABLE campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        direction TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        voice TEXT NOT NULL,
        policy_json TEXT,
        inbound_number TEXT,
        outbound_caller_id TEXT,
        ephemeral INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO campaigns VALUES (
        'legacy', 'Legacy Campaign', 'both', 'Answer politely', 'juniper', NULL, NULL, NULL, 0, 1, 1
      );
      INSERT INTO app_settings VALUES ('selected_campaign_id', 'legacy');
    `)
    database.close()

    const store = new CampaignStore(path)
    expect(store.getCampaign('legacy')?.name).toBe('Legacy Campaign')
    const db = new DatabaseSync(path)
    expect(db.prepare('SELECT tenant_id FROM campaigns WHERE id = ?').get('legacy')).toEqual({ tenant_id: 'local' })
    expect(primaryKeyColumns(db, 'app_settings')).toEqual(['tenant_id', 'key'])
    db.close()
    store.close()
    const again = new CampaignStore(path)
    expect(again.getCampaign('legacy')?.name).toBe('Legacy Campaign')
    again.close()
  })

  it('migrates a v6 calls database without losing rows', () => {
    const path = join(directory, 'calls.sqlite3')
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL) STRICT;
      INSERT INTO schema_version (version) VALUES (6);
      CREATE TABLE call_sessions (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        peer TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER,
        answered_at INTEGER,
        ended_at INTEGER,
        duration_ms INTEGER,
        end_reason TEXT,
        campaign_id TEXT,
        campaign_name TEXT,
        campaign_system_prompt TEXT,
        campaign_voice TEXT,
        runtime_mode TEXT NOT NULL,
        thread_id TEXT,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        contact_card_json TEXT,
        provider_call_sid TEXT,
        voice_provider TEXT NOT NULL DEFAULT 'codex',
        voice_seconds REAL
      ) STRICT;
      CREATE TABLE transcript_entries (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL,
        speaker TEXT NOT NULL,
        text TEXT NOT NULL,
        final INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        seq INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE recordings (
        call_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        bytes INTEGER,
        sha256 TEXT,
        duration_ms INTEGER,
        mime TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        call_id TEXT,
        details_json TEXT
      ) STRICT;
      CREATE TABLE call_results (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL,
        schema_hash TEXT NOT NULL,
        outcome TEXT NOT NULL,
        summary TEXT NOT NULL,
        result_json TEXT,
        confidence TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        error TEXT,
        UNIQUE(call_id, schema_hash)
      ) STRICT;
      CREATE TABLE analysis_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL,
        schema_hash TEXT NOT NULL,
        schema_json TEXT,
        goal TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(call_id, schema_hash)
      ) STRICT;
      CREATE TABLE call_tasks (
        id TEXT PRIMARY KEY,
        to_number TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        result_schema_json TEXT,
        constraints_json TEXT NOT NULL,
        callback_url TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        call_id TEXT,
        result_id TEXT,
        outcome TEXT,
        error TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER
      ) STRICT;
      CREATE TABLE call_budgets (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL,
        daily_max_calls INTEGER NOT NULL,
        daily_max_minutes INTEGER NOT NULL,
        allowed_prefixes_json TEXT NOT NULL,
        allowed_numbers_json TEXT NOT NULL,
        allowed_hours_json TEXT NOT NULL,
        kill_switch INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO call_budgets VALUES (1, 1, 4, 20, '[]', '[]', '{"timeZone":"UTC","windows":[]}', 0, 1);
      CREATE TABLE contact_cards (
        phone TEXT PRIMARY KEY,
        display_name TEXT,
        company TEXT,
        tier TEXT,
        language TEXT,
        time_zone TEXT,
        notes TEXT,
        facts_json TEXT NOT NULL,
        source TEXT NOT NULL,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO call_sessions (
        id, direction, peer, status, runtime_mode, created_at, updated_at, voice_provider
      ) VALUES ('legacy-call', 'inbound', '+13125550198', 'ended', 'mock', 1, 1, 'codex');
      INSERT INTO call_tasks (
        id, to_number, campaign_id, goal, constraints_json, idempotency_key, status,
        created_by, created_at, updated_at
      ) VALUES ('legacy-task', '+13125550198', 'c1', 'goal', '{}', 'legacy-key', 'queued', 'http', 1, 1);
      INSERT INTO contact_cards (
        phone, facts_json, source, created_at, updated_at
      ) VALUES ('+13125550198', '{}', 'legacy', 1, 1);
      INSERT INTO audit_log (at, actor, action, call_id, details_json)
      VALUES (1, 'main', 'call.created', 'legacy-call', '{"ok":true}');
    `)
    database.close()

    const store = new CallStore(path)
    expect(store.getCall('legacy-call')?.peer).toBe('+13125550198')
    expect(store.getCallTaskByIdempotencyKey('legacy-key')?.id).toBe('legacy-task')
    expect(store.getContactCard('+13125550198')?.source).toBe('legacy')
    expect(store.getCallBudget()).toMatchObject({ enabled: true, dailyMaxCalls: 4 })
    expect(store.listCallAudit('legacy-call')[0]).toMatchObject({
      action: 'call.created',
      tenantId: 'local'
    })
    const db = store.getDatabase()
    expect(hasUniqueOn(db, 'call_tasks', ['tenant_id', 'idempotency_key'])).toBe(true)
    expect(primaryKeyColumns(db, 'contact_cards')).toEqual(['tenant_id', 'phone'])
    store.close()
    const again = new CallStore(path)
    expect(again.getCall('legacy-call')?.id).toBe('legacy-call')
    again.close()
  })
})
