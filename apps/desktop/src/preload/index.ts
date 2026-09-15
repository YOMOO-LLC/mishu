import { contextBridge, ipcRenderer } from 'electron'
import type {
  ApprovalDecision,
  ApprovalRequest,
  AppointmentsSaveInput,
  CallBudgetSaveInput,
  CallLifecycleReport,
  CallTaskSubmitInput,
  CampaignInput,
  GuardrailEvent,
  GeneralSettingsSaveInput,
  ListCallsRequest,
  ListAppointmentsRequest,
  ListCallTasksRequest,
  LivePhoneApi,
  LivePhoneEvent,
  McpScope,
  PhoneCommand,
  PhoneCommandRequest,
  PhoneCommandResult,
  PhoneStatusSnapshot,
  RecordChunkRequest,
  RecordFinishRequest,
  RecordStartRequest,
  StartRealtimeRequest,
  TranscriptEntry,
  TwilioSettingsSaveInput,
  WebhookSaveInput
} from '../shared/contracts'
import { IPC } from '../shared/contracts'

const api: LivePhoneApi = {
  reportRealtimeStarted: (sessionId) => ipcRenderer.invoke(IPC.realtimeStarted, sessionId),
  getVoiceSettings: () => ipcRenderer.invoke(IPC.voiceSettingsGet),
  saveVoiceSettings: (input) => ipcRenderer.invoke(IPC.voiceSettingsSave, input),
  getOpenAiSettings: () => ipcRenderer.invoke(IPC.openAiSettingsGet),
  saveOpenAiSettings: (input) => ipcRenderer.invoke(IPC.openAiSettingsSave, input),
  testOpenAiConnection: () => ipcRenderer.invoke(IPC.openAiSettingsTest),
  getRuntimeConfig: () => ipcRenderer.invoke(IPC.getRuntimeConfig),
  getCampaignWorkspace: () => ipcRenderer.invoke(IPC.getCampaignWorkspace),
  getCampaign: (id: string) => ipcRenderer.invoke(IPC.getCampaign, id),
  saveCampaign: (campaign: CampaignInput) => ipcRenderer.invoke(IPC.saveCampaign, campaign),
  deleteCampaign: (id: string) => ipcRenderer.invoke(IPC.deleteCampaign, id),
  selectCampaign: (id: string) => ipcRenderer.invoke(IPC.selectCampaign, id),
  startRealtime: (request: StartRealtimeRequest) =>
    ipcRenderer.invoke(IPC.startRealtime, request),
  appendSpeech: (text: string) => ipcRenderer.invoke(IPC.appendSpeech, text),
  appendText: (text: string) => ipcRenderer.invoke(IPC.appendText, text),
  stopRealtime: () => ipcRenderer.invoke(IPC.stopRealtime),
  reportCallLifecycle: (report: CallLifecycleReport) =>
    ipcRenderer.invoke(IPC.reportCallLifecycle, report),
  reportTranscriptEntry: (entry: TranscriptEntry) =>
    ipcRenderer.invoke(IPC.reportTranscriptEntry, entry),
  listCalls: (request: ListCallsRequest) => ipcRenderer.invoke(IPC.listCalls, request),
  getCall: (id: string) => ipcRenderer.invoke(IPC.getCall, id),
  getCallTranscript: (id: string) => ipcRenderer.invoke(IPC.getCallTranscript, id),
  submitTask: (input: CallTaskSubmitInput) => ipcRenderer.invoke(IPC.submitTask, input),
  listTasks: (request: ListCallTasksRequest) => ipcRenderer.invoke(IPC.listTasks, request),
  getTask: (id: string) => ipcRenderer.invoke(IPC.getTask, id),
  waitTask: (id: string, timeoutMs: number) => ipcRenderer.invoke(IPC.waitTask, id, timeoutMs),
  cancelTask: (id: string) => ipcRenderer.invoke(IPC.cancelTask, id),
  getBudget: () => ipcRenderer.invoke(IPC.budgetGet),
  saveBudget: (input: CallBudgetSaveInput) => ipcRenderer.invoke(IPC.budgetSave, input),
  getGeneralSettings: () => ipcRenderer.invoke(IPC.generalSettingsGet),
  saveGeneralSettings: (input: GeneralSettingsSaveInput) =>
    ipcRenderer.invoke(IPC.generalSettingsSave, input),
  getTwilioSettings: () => ipcRenderer.invoke(IPC.twilioSettingsGet),
  saveTwilioSettings: (input: TwilioSettingsSaveInput) =>
    ipcRenderer.invoke(IPC.twilioSettingsSave, input),
  importTwilioEnv: () => ipcRenderer.invoke(IPC.twilioSettingsImport),
  testTwilioConnection: () => ipcRenderer.invoke(IPC.twilioSettingsTest),
  relaunchApp: () => ipcRenderer.invoke(IPC.appRelaunch),
  listAppointments: (request: ListAppointmentsRequest) =>
    ipcRenderer.invoke(IPC.listAppointments, request),
  getCallAppointments: (callId: string) =>
    ipcRenderer.invoke(IPC.getCallAppointments, callId),
  recordStart: (request: RecordStartRequest) => ipcRenderer.invoke(IPC.recordStart, request),
  recordChunk: (request: RecordChunkRequest) => ipcRenderer.invoke(IPC.recordChunk, request),
  recordFinish: (request: RecordFinishRequest) => ipcRenderer.invoke(IPC.recordFinish, request),
  getRecording: (callId: string) => ipcRenderer.invoke(IPC.getRecording, callId),
  reportGuardrailEvent: (event: GuardrailEvent) =>
    ipcRenderer.invoke(IPC.reportGuardrailEvent, event),
  listGuardrailEvents: (callId: string) =>
    ipcRenderer.invoke(IPC.listGuardrailEvents, callId),
  getWebhookConfig: () => ipcRenderer.invoke(IPC.webhookGetConfig),
  saveWebhookConfig: (input: WebhookSaveInput) =>
    ipcRenderer.invoke(IPC.webhookSaveConfig, input),
  rotateWebhookSecret: () => ipcRenderer.invoke(IPC.webhookRotateSecret),
  sendWebhookTest: () => ipcRenderer.invoke(IPC.webhookSendTest),
  listWebhookDeliveries: (request: { limit?: number }) =>
    ipcRenderer.invoke(IPC.webhookListDeliveries, request),
  onEvent: (listener: (event: LivePhoneEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: LivePhoneEvent): void => {
      listener(payload)
    }
    ipcRenderer.on(IPC.event, handler)
    return () => ipcRenderer.removeListener(IPC.event, handler)
  },
  onPhoneCommand: (listener: (request: PhoneCommandRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: PhoneCommandRequest): void => {
      listener(request)
    }
    ipcRenderer.on(IPC.phoneCommand, handler)
    return () => ipcRenderer.removeListener(IPC.phoneCommand, handler)
  },
  respondPhoneCommand: (result: PhoneCommandResult) => {
    ipcRenderer.send(IPC.respondPhoneCommand, result)
  },
  publishPhoneStatus: (snapshot: PhoneStatusSnapshot) => {
    ipcRenderer.send(IPC.publishPhoneStatus, snapshot)
  },
  onApprovalRequested: (listener: (request: ApprovalRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: ApprovalRequest): void => {
      listener(request)
    }
    ipcRenderer.on(IPC.approvalRequested, handler)
    return () => ipcRenderer.removeListener(IPC.approvalRequested, handler)
  },
  respondApproval: (decision: ApprovalDecision) => {
    ipcRenderer.send(IPC.respondApproval, decision)
  },
  getMcpStatus: () => ipcRenderer.invoke(IPC.mcpGetStatus),
  setMcpEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC.mcpSetEnabled, enabled),
  rotateMcpToken: () => ipcRenderer.invoke(IPC.mcpRotateToken),
  setMcpScopes: (scopes: McpScope[]) => ipcRenderer.invoke(IPC.mcpSetScopes, scopes),
  getMcpClientConfigs: () => ipcRenderer.invoke(IPC.mcpGetClientConfigs),
  applyMcpClientConfigs: () => ipcRenderer.invoke(IPC.mcpApplyClientConfigs),
  getCrmConfig: () => ipcRenderer.invoke(IPC.crmGetConfig),
  saveCrmConfig: (input) => ipcRenderer.invoke(IPC.crmSaveConfig, input),
  testCrmConnection: () => ipcRenderer.invoke(IPC.crmTestConnection),
  listCrmSyncLog: (request: { limit?: number }) =>
    ipcRenderer.invoke(IPC.crmListSyncLog, request),
  getAppointmentsConfig: () => ipcRenderer.invoke(IPC.appointmentsGetConfig),
  saveAppointmentsConfig: (input: AppointmentsSaveInput) =>
    ipcRenderer.invoke(IPC.appointmentsSaveConfig, input),
  ...(process.argv.includes('--live-phone-runtime-mode=mock') && process.env.NODE_ENV !== 'production'
    ? {
        debugPhoneCommand: (command: PhoneCommand) =>
          ipcRenderer.invoke(IPC.debugPhoneCommand, command),
        debugApprovalRequest: (request: ApprovalRequest) =>
          ipcRenderer.invoke(IPC.debugApprovalRequest, request)
      }
    : {})
}

contextBridge.exposeInMainWorld('livePhone', api)
