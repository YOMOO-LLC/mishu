import { bindVoiceUsage } from '../voice/call-usage.js'
import { OpenAiSettingsService } from './openai-settings-service.js'
import { VoiceSettingsService } from './voice-settings-service.js'
import { GptLiveApiVoiceProvider } from '../voice/gpt-live-api-provider.js'
import type { ApprovalRequest, CallLifecycleReport, GuardrailEvent, TranscriptEntry } from '../../shared/contracts.js'
import { AppointmentsConfigStore } from '../appointments/config-store.js'
import type { Clock } from '@mishu/core/clock'
import type { EngineContext } from '../engine-context.js'
import type { CodexAppServerClient } from '../codex/index.js'
import {
  asEngineTelephony
} from '../telephony/index.js'
import { AppointmentService } from './appointment-service.js'
import { ApprovalService } from './approval-service.js'
import { BudgetService } from './budget-service.js'
import { CallService } from './call-service.js'
import { CampaignService } from './campaign-service.js'
import { ContactService } from './contact-service.js'
import { CrmService } from './crm-service.js'
import { PhoneService } from './phone-service.js'
import { TaskService } from './task-service.js'
import { McpAdminService } from './mcp-admin-service.js'
import { RealtimeService } from './realtime-service.js'
import { RecordingService } from './recording-service.js'
import { RuntimeService } from './runtime-service.js'
import { SettingsService } from './settings-service.js'
import { WebhookService } from './webhook-service.js'
import type { TwilioSettingsService } from './twilio-settings-service.js'

export type EngineServiceBindings = Pick<
  EngineContext,
  | 'userDataPath'
  | 'isMock'
  | 'campaignStore'
  | 'callStore'
  | 'appointmentStore'
  | 'recordingWriter'
  | 'webhookBridge'
  | 'telephony'
>

export interface MainServicesOptions extends EngineServiceBindings {
  clock?: Clock
  codex(): CodexAppServerClient
  loadTwilioToken(): Promise<string | undefined>
  twilioSettings: TwilioSettingsService
  emitConnecting(): void
  emitVoiceSettings?(settings: import('../../shared/contracts.js').VoiceSettings): void
  approvalTimeoutMs?: number
  platform?: NodeJS.Platform
  setLoginItemSettings?(settings: { openAtLogin: boolean }): void
}

export function createMainServices(options: MainServicesOptions): MainServices {
  return new MainServices(options)
}

export class MainServices {
  private readonly unbindVoiceUsage: () => void
  readonly approvals: ApprovalService
  readonly campaigns: CampaignService
  readonly contacts: ContactService
  readonly tasks: TaskService
  readonly budget: BudgetService
  readonly calls: CallService
  readonly recordings: RecordingService
  readonly webhooks: WebhookService
  readonly appointments: AppointmentService
  readonly crm: CrmService
  readonly phone: PhoneService
  readonly runtime: RuntimeService
  readonly realtime: RealtimeService
  readonly settings: SettingsService
  readonly twilio: TwilioSettingsService
  readonly openai: OpenAiSettingsService
  readonly voice: VoiceSettingsService
  readonly mcp = new McpAdminService()

  constructor(private readonly options: MainServicesOptions) {
    const telephony = asEngineTelephony(options.telephony)
    this.approvals = new ApprovalService({
      timeoutMs: options.approvalTimeoutMs,
      onRequested: (request) => this.publishApprovalRequested(request)
    })
    this.campaigns = new CampaignService(options.campaignStore)
    this.contacts = new ContactService(options.callStore)
    this.calls = new CallService(options.callStore, options.appointmentStore, options.recordingWriter)
    this.tasks = new TaskService({
      store: options.callStore,
      campaigns: this.campaigns,
      approvals: this.approvals,
      gateway: {
        getStatus: () => telephony.getStatus(),
        send: (command: import('../../shared/contracts.js').PhoneCommand, sendOptions: { actor: string; timeoutMs?: number }) =>
          telephony.execute(command, sendOptions)
      } as never,
      contacts: this.contacts,
      calls: this.calls,
      webhookBridge: options.webhookBridge
    })
    this.budget = new BudgetService(options.callStore)
    this.recordings = new RecordingService(options.callStore, options.recordingWriter)
    this.webhooks = new WebhookService(options.webhookBridge)
    this.appointments = new AppointmentService(new AppointmentsConfigStore(options.userDataPath))
    this.crm = new CrmService(options.userDataPath, options.isMock)
    this.phone = new PhoneService(
      telephony,
      this.campaigns,
      this.approvals,
      () => options.clock?.now() ?? Date.now(),
      this.tasks
    )
    this.twilio = options.twilioSettings
    this.runtime = new RuntimeService(options.loadTwilioToken, options.isMock, this.twilio)
    const callInProgress = (): boolean => {
      let call: import('../../shared/contracts.js').PhoneCall | undefined
      try { call = telephony.getStatus()?.call } catch { /* Renderer not initialized yet. */ }
      return Boolean(this.realtime?.isActive()) || Boolean(options.callStore.getActiveCallId()) || Boolean(call && !['ended', 'error', 'idle'].includes(call.status))
    }
    this.voice = new VoiceSettingsService(options.userDataPath, callInProgress, options.emitVoiceSettings)
    this.openai = new OpenAiSettingsService({ userDataPath: options.userDataPath, callInProgress,
      ...(options.isMock && process.env.LIVE_PHONE_OPENAI_TEST_BASE_URL ? { apiBaseUrl: process.env.LIVE_PHONE_OPENAI_TEST_BASE_URL } : {}) })
    this.realtime = new RealtimeService(options.codex, options.emitConnecting,
      new GptLiveApiVoiceProvider({ settings: this.openai, voice: () => this.voice.get().apiVoice, disabled: options.isMock,
        audit: (action, details) => options.callStore.writeAudit(action, options.callStore.getActiveCallId(), details)
      }), this.voice)
    this.unbindVoiceUsage = bindVoiceUsage(this.realtime, options.callStore, () => this.voice.get().provider)
    this.settings = new SettingsService({
      userDataPath: options.userDataPath,
      platform: options.platform,
      setLoginItemSettings: options.setLoginItemSettings
    })
  }

  reportCall(report: CallLifecycleReport): void {
    const voice = this.voice.get()
    this.options.callStore.report(report, {
      provider: voice.provider,
      voice: voice.provider === 'gpt-live-api' ? voice.apiVoice : (report.campaign?.voice ?? voice.apiVoice)
    })
    this.options.callStore.setVoiceUsage(report.call.id, voice.provider)
  }
  reportTranscript(entry: TranscriptEntry, actor: 'renderer' | 'main' = 'renderer'): void {
    this.options.callStore.reportTranscriptEntry(entry, actor)
  }
  reportGuardrail(event: GuardrailEvent): void { this.options.callStore.recordGuardrailEvent(event) }

  auditHttp(route: string, statusCode: number, params: unknown): void {
    this.options.callStore.writeAudit(
      'http.request',
      this.options.callStore.getActiveCallId(),
      { route, statusCode, params },
      'http'
    )
  }

  dispose(): void { this.unbindVoiceUsage(); this.approvals.dispose() }

  private publishApprovalRequested(request: ApprovalRequest): void {
    this.options.webhookBridge.publishApprovalRequested?.(request)
  }
}

export { ServiceError, asServiceError } from './service-error.js'
