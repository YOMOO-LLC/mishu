import { MockTelephony, MockTextModel, MockVoiceSession } from '@mishu/adapters-mock'
import { systemClock, systemIdGen } from '@mishu/core/clock'
import { join } from 'node:path'
import type { AnalysisBackend } from '../../desktop/src/main/analysis/types.js'
import { AnalysisService } from '../../desktop/src/main/analysis/service.js'
import { AppointmentStore } from '../../desktop/src/main/appointments/store.js'
import { CallStore } from '../../desktop/src/main/call-store.js'
import { CampaignStore } from '../../desktop/src/main/campaign-store.js'
import { ToolRegistry } from '../../desktop/src/main/copilot/registry.js'
import type { EngineContext } from '../../desktop/src/main/engine-context.js'
import { RecordingWriter } from '../../desktop/src/main/recording-writer.js'
import { createMainServices } from '../../desktop/src/main/services/index.js'
import { TwilioSettingsService } from '../../desktop/src/main/services/twilio-settings-service.js'
import { McpTokenStore } from '../../desktop/src/main/mcp/auth.js'
import { TaskRunner } from '../../desktop/src/main/tasks/runner.js'
import { localTenantContext } from '../../desktop/src/main/tenant.js'
import { WebhookBridge } from '../../desktop/src/main/webhook/bridge.js'
import { WebhookConfigStore } from '../../desktop/src/main/webhook/config-store.js'
import { createHeadlessMcpAdmin } from './mcp-stub.js'
import { CloudEngineTelephony } from './mock-engine-telephony.js'

const CONTRACT_BUDGET = {
  enabled: true,
  dailyMaxCalls: 100,
  dailyMaxMinutes: 1_000,
  allowedPrefixes: ['+1555'],
  allowedNumbers: [] as string[],
  allowedHours: { timeZone: 'UTC', windows: [] as Array<{ days: number[]; start: string; end: string }> },
  killSwitch: false
}

const MOCK_EXTRACTION = JSON.stringify({
  outcome: 'reached',
  summary: 'Mock extraction completed.',
  confidence: 'high'
})

export interface AssembledCloudEngine {
  context: EngineContext
  tokenStore: McpTokenStore
  telephony: CloudEngineTelephony
  voice: MockVoiceSession
  textModel: MockTextModel
  dispose(): void
}

/**
 * Assemble the same EngineContext the headless unit test builds, with
 * `@mishu/adapters-mock` ports as the P2 defaults.
 *
 * WAVE 6 / P4 extension point: replace MockTelephony, MockVoiceSession, and
 * MockTextModel with `@mishu/adapters-cloud` (Twilio Media Streams, GPT-Live
 * WebSocket, Responses). Do not wire real Twilio, OpenAI, or Media Streams in P2.
 */
export function assembleCloudEngine(dataDir: string): AssembledCloudEngine {
  const tenant = localTenantContext()
  const clock = systemClock
  const idGen = systemIdGen
  const campaignStore = new CampaignStore(join(dataDir, 'campaigns.sqlite3'), {
    tenantId: tenant.tenantId,
    logger: () => undefined
  })
  const callStore = new CallStore(join(dataDir, 'calls.sqlite3'), { tenantId: tenant.tenantId })
  const appointmentStore = new AppointmentStore(callStore)
  const recordingWriter = new RecordingWriter(callStore, join(dataDir, 'recordings'))
  recordingWriter.initialize()
  const webhookBridge = new WebhookBridge({
    store: callStore,
    configStore: new WebhookConfigStore(join(dataDir, 'webhooks'))
  })
  const mockTelephony = new MockTelephony({ clock, idGen, connectDelayMs: 0 })
  const voice = new MockVoiceSession({ clock, idGen })
  const textModel = new MockTextModel({ defaultOutputText: MOCK_EXTRACTION })
  const telephony = new CloudEngineTelephony({
    mock: mockTelephony,
    tenantId: tenant.tenantId,
    callStore,
    campaignStore,
    clock,
    idGen
  })
  const services = createMainServices({
    userDataPath: dataDir,
    isMock: true,
    campaignStore,
    callStore,
    appointmentStore,
    recordingWriter,
    webhookBridge,
    telephony,
    clock,
    loadTwilioToken: async () => undefined,
    twilioSettings: new TwilioSettingsService({ userDataPath: dataDir, env: {} }),
    emitConnecting: () => undefined,
    approvalTimeoutMs: 10_000,
    codex: () => {
      throw new Error('codex is unavailable in the headless engine')
    }
  })
  services.mcp.attach(createHeadlessMcpAdmin())
  services.budget.save(CONTRACT_BUDGET)
  webhookBridge.startScheduler(200)
  const analysis = new AnalysisService({
    callStore,
    backend: textModelAnalysisBackend(textModel, tenant.tenantId)
  })
  const runner = new TaskRunner({
    tasks: services.tasks,
    budget: services.budget,
    analysis,
    store: callStore,
    gateway: {
      getStatus: () => telephony.getStatus(),
      send: (command, options) => telephony.execute(command, options)
    } as never,
    isMock: true,
    schedulerIntervalMs: 50,
    mockCallDurationMs: 250
  })
  runner.start()
  const context: EngineContext = {
    callStore,
    appointmentStore,
    campaignStore,
    recordingWriter,
    webhookBridge,
    toolRegistry: new ToolRegistry(),
    telephony,
    approvals: services.approvals,
    clock,
    idGen,
    tenant,
    userDataPath: dataDir,
    isMock: true,
    services,
    textModel
  }
  return {
    context,
    tokenStore: new McpTokenStore(dataDir),
    telephony,
    voice,
    textModel,
    dispose() {
      runner.dispose()
      analysis.dispose()
      webhookBridge.outbox.close()
      services.dispose()
      telephony.dispose()
      recordingWriter.close()
      callStore.close()
      campaignStore.close()
    }
  }
}

function textModelAnalysisBackend(model: MockTextModel, tenantId: string): AnalysisBackend {
  return {
    async runExtraction(prompt, schema) {
      const result = await model.complete({
        tenantId,
        input: prompt,
        ...(schema
          ? { text: { format: { type: 'json_schema', name: 'extraction', strict: true, schema } } }
          : {})
      })
      return { text: result.outputText, model: 'mock-text-model' }
    }
  }
}
