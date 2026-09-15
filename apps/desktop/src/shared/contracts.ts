import type { CampaignPolicy, CallingHours, CallingWindow, PolicyDirection } from './policy'

export type {
  CampaignPolicy,
  CallingHours,
  CallingWindow,
  PolicyDirection
}

export type ConnectionStatus = 'idle' | 'connecting' | 'ready' | 'error'

export type CallDirection = 'inbound' | 'outbound'

export type CampaignDirection = CallDirection | 'both'

export const REALTIME_VOICES = [
  'arbor',
  'breeze',
  'cove',
  'ember',
  'juniper',
  'maple',
  'sol',
  'spruce',
  'vale'
] as const

export type RealtimeVoice = (typeof REALTIME_VOICES)[number]

export type CallStatus =
  | 'idle'
  | 'ringing'
  | 'dialing'
  | 'connecting'
  | 'active'
  | 'held'
  | 'ended'
  | 'error'

export interface PhoneCall {
  id: string
  direction: CallDirection
  peer: string
  status: CallStatus
  providerCallSid?: string
  startedAt?: number
}

export interface TranscriptEntry {
  id: string
  speaker: 'caller' | 'assistant' | 'system'
  text: string
  final: boolean
  timestamp: number
}

export interface CodexConnectionState {
  status: ConnectionStatus
  threadId?: string
  sessionId?: string
  message?: string
}

export type RuntimeMode = 'mock' | 'twilio'

export const CALL_END_REASONS = [
  'hangup',
  'rejected',
  'remote',
  'error',
  'timeout',
  'max_duration',
  'unknown',
  'remote_hangup',
  'local_hangup',
  'carrier_error',
  'session_error'
] as const

export type CallEndReason = (typeof CALL_END_REASONS)[number]

export interface CallLifecycleReport {
  call: PhoneCall
  runtimeMode: RuntimeMode
  campaign?: Campaign
  threadId?: string
  sessionId?: string
  endReason?: CallEndReason
}

export interface CallSession {
  voiceProvider?: VoiceProviderName
  voiceSeconds?: number
  id: string
  direction: CallDirection
  peer: string
  status: CallStatus
  providerCallSid?: string
  startedAt?: number
  answeredAt?: number
  endedAt?: number
  durationMs?: number
  endReason?: CallEndReason
  campaignId?: string
  campaignName?: string
  campaignSystemPrompt?: string
  campaignVoice?: string
  runtimeMode: RuntimeMode
  threadId?: string
  sessionId?: string
  contactCard?: ContactCardSummary
  createdAt: number
  updatedAt: number
}

export interface CallSummary {
  voiceProvider?: VoiceProviderName
  voiceSeconds?: number
  id: string
  direction: CallDirection
  peer: string
  status: CallStatus
  startedAt?: number
  endedAt?: number
  durationMs?: number
  campaignName?: string
  runtimeMode: RuntimeMode
  createdAt: number
}

export interface ListCallsRequest {
  limit?: number
  offset?: number
}

export type CallTaskStatus =
  | 'queued'
  | 'awaiting_approval'
  | 'dialing'
  | 'in_call'
  | 'analyzing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type CallTaskOutcome =
  | 'reached'
  | 'no_answer'
  | 'voicemail'
  | 'refused'
  | 'wrong_number'
  | 'error'

export type CallTaskCreator = 'http' | 'mcp' | 'ui' | 'cli'

export interface CallTaskConstraints {
  maxDurationSec?: number
  notBefore?: string
  notAfter?: string
  maxAttempts?: number
  allowedToolIds?: string[]
}

export interface CallTaskCampaignInput {
  name?: string
  direction: 'outbound'
  systemPrompt?: string
  voice?: RealtimeVoice
  policy?: CampaignPolicy
}

export interface CallTaskSubmitInput {
  to: string
  campaignId?: string
  campaign?: CallTaskCampaignInput
  goal: string
  resultSchema?: Record<string, unknown>
  constraints?: CallTaskConstraints
  callbackUrl?: string
  idempotencyKey: string
  createdBy?: CallTaskCreator
  contact?: Omit<ContactCardInput, 'phone'> & { phone?: string }
}

export interface CallTask {
  id: string
  to: string
  campaignId: string
  goal: string
  resultSchema?: Record<string, unknown>
  constraints: CallTaskConstraints
  callbackUrl?: string
  idempotencyKey: string
  status: CallTaskStatus
  attempts: number
  callId?: string
  resultId?: string
  result?: unknown
  outcome?: CallTaskOutcome
  error?: string
  createdBy: CallTaskCreator
  createdAt: number
  updatedAt: number
  startedAt?: number
  endedAt?: number
  transcript?: TranscriptEntry[]
  analysis?: CallAnalysis
  call?: CallSession
}

export const CALL_TASK_INCLUDES = ['transcript', 'analysis', 'call'] as const
export type CallTaskInclude = (typeof CALL_TASK_INCLUDES)[number]

export interface CallAnalysis {
  resultId: string
  outcome: CallTaskOutcome
  summary: string
  confidence: 'high' | 'medium' | 'low'
  schemaHash: string
  result?: unknown
  analyzedAt: number
}

export interface CallAuditRecord {
  at: number
  actor: string
  action: string
  tenantId?: string
  details?: unknown
}

export interface ListCallTasksRequest {
  limit?: number
  offset?: number
  status?: CallTaskStatus
}

export interface ContactCardInput {
  phone: string
  displayName?: string
  company?: string
  tier?: string
  language?: string
  timeZone?: string
  notes?: string
  facts?: Record<string, unknown>
  source?: string
  expiresAt?: number | string
}

export interface ContactCard {
  phone: string
  displayName?: string
  company?: string
  tier?: string
  language?: string
  timeZone?: string
  notes?: string
  facts: Record<string, unknown>
  source: string
  expiresAt?: number
  createdAt: number
  updatedAt: number
}

export interface ContactCardSummary {
  displayName?: string
  company?: string
  tier?: string
  language?: string
  notes?: string
}

export interface ListContactCardsRequest {
  limit?: number
  offset?: number
}

export interface CallBudget {
  enabled: boolean
  dailyMaxCalls: number
  dailyMaxMinutes: number
  allowedPrefixes: string[]
  allowedNumbers: string[]
  allowedHours: CallingHours
  killSwitch: boolean
}

export type CallBudgetSaveInput = Partial<CallBudget>

export interface GeneralSettings {
  minimizeToTray: boolean
  launchAtLogin: boolean
  startHidden: boolean
}

export type GeneralSettingsSaveInput = Partial<GeneralSettings>

export type TwilioFieldSource = 'env' | 'settings' | 'unset'
export type TwilioSettingsMode = 'auto' | 'twilio' | 'mock'

export interface TwilioMaskedField {
  configured: boolean
  last4?: string
  masked?: string
  source: TwilioFieldSource
  readOnly: boolean
}

export interface TwilioValueField {
  configured: boolean
  value: string
  source: TwilioFieldSource
  readOnly: boolean
}

export interface TwilioSettingsPublic {
  accountSid: TwilioMaskedField
  apiKeySid: TwilioMaskedField
  apiKeySecret: Omit<TwilioMaskedField, 'masked'>
  twimlAppSid: TwilioMaskedField
  phoneNumber: TwilioValueField
  clientIdentity: TwilioValueField
  mode: TwilioSettingsMode
  effectiveMode: 'twilio' | 'mock'
  configured: boolean
  restartRequired: boolean
}

export interface TwilioSettingsSaveInput {
  accountSid?: string | null
  apiKeySid?: string | null
  apiKeySecret?: string | null
  twimlAppSid?: string | null
  phoneNumber?: string | null
  clientIdentity?: string | null
  mode?: TwilioSettingsMode
}

export interface TwilioCheckResult {
  check: 'token' | 'application' | 'phoneNumber'
  ok: boolean
  code: string
}

export interface TwilioTestResult { ok: boolean; checks: TwilioCheckResult[] }

export type AppointmentStatus = 'tentative' | 'confirmed' | 'cancelled' | 'failed'
export type AppointmentSource = 'copilot' | 'mcp' | 'manual'
export type AppointmentProvider = 'mock' | 'zoho'

export interface Appointment {
  id: string
  callId?: string
  campaignId: string
  peer: string
  contactName?: string
  startAt: string
  endAt: string
  timeZone: string
  status: AppointmentStatus
  source: AppointmentSource
  externalRef?: string
  notes?: string
  createdAt: number
  updatedAt: number
}

export interface ListAppointmentsRequest {
  limit?: number
  offset?: number
}

export interface AppointmentBusinessHours {
  days: number[]
  start: string
  end: string
}

export interface AppointmentsConfig {
  provider: AppointmentProvider
  autoConfirm: boolean
  businessHours: AppointmentBusinessHours
  timeZone: string
}

export type AppointmentsSaveInput = Partial<AppointmentsConfig>

export type RecordingStatus = 'recording' | 'complete' | 'incomplete'

export interface RecordingInfo {
  callId: string
  playbackUrl: string
  bytes?: number
  sha256?: string
  durationMs?: number
  mime?: string
  status: RecordingStatus
  createdAt: number
  updatedAt: number
}

export interface RecordStartRequest {
  callId: string
  mime: string
}

export interface RecordChunkRequest {
  callId: string
  seq: number
  data: Uint8Array
}

export interface RecordFinishRequest {
  callId: string
  durationMs: number
}

export type GuardrailEventKind =
  | 'max_duration'
  | 'forbidden_claim'
  | 'dnc_blocked'
  | 'outside_calling_hours'
  | 'blocked_caller'

export interface GuardrailEvent {
  callId: string
  kind: GuardrailEventKind
  at: number
  details?: Record<string, unknown>
}

export interface WebhookPublicConfig {
  enabled: boolean
  url: string
  events: string[]
  hasSecret: boolean
}

export interface WebhookRotateResult {
  config: WebhookPublicConfig
  secret: string
}

export interface WebhookSaveInput {
  enabled?: boolean
  url?: string
  events?: string[]
  secret?: string
}

export interface WebhookDeliverySummary {
  id: string
  eventType: string
  status: string
  attempts: number
  createdAt: number
  lastStatusCode?: number
  lastError?: string
}

export interface RuntimeConfig {
  mockMode: boolean
  twilioToken?: string
  twilioPhoneNumber?: string
  guardrailTickMs?: number
  configPath?: string
  runtimeNotice?: string
  codexCommand?: string
  codexError?: string
}

export interface Campaign {
  id: string
  name: string
  direction: CampaignDirection
  systemPrompt: string
  voice: RealtimeVoice
  policy: CampaignPolicy
  inboundNumber?: string
  outboundCallerId?: string
  ephemeral?: boolean
  createdAt: number
  updatedAt: number
}

export interface CampaignInput {
  id?: string
  name: string
  direction: CampaignDirection
  systemPrompt?: string
  voice: RealtimeVoice
  policy?: CampaignPolicy
  inboundNumber?: string
  outboundCallerId?: string
}

export interface CampaignWorkspace {
  campaigns: Campaign[]
  selectedCampaignId: string
}

export type LivePhoneEvent =
  | { type: 'voice-settings'; settings: VoiceSettings }
  | { type: 'voice-session-ready'; sessionId: string }
  | { type: 'codex-state'; state: CodexConnectionState }
  | { type: 'transcript'; entry: TranscriptEntry }
  | { type: 'assistant-message'; text: string }
  | { type: 'call-end-requested'; callId: string }
  | { type: 'copilot-status'; status: CopilotStatus }
  | { type: 'copilot-injected'; text: string; callId: string }
  | { type: 'error'; source: 'codex' | 'twilio' | 'audio'; message: string }

// ─── PhoneCommandGateway (main→renderer request/response) ───────────────────
export type PhoneCommand =
  | { type: 'dial'; peer: string; campaignId?: string; goal?: string }
  | { type: 'hangup' }
  | { type: 'answer' }
  | { type: 'reject' }
  | { type: 'simulateIncoming'; peer?: string }
  | { type: 'simulateRemoteHangup' }
  | { type: 'simulateRealtimeStartFailure' }
  | { type: 'setControlMode'; mode: 'ai' | 'human' }
  | { type: 'getStatus' }

export type PhoneCommandErrorCode =
  | 'APP_NOT_READY'
  | 'CALL_IN_PROGRESS'
  | 'NO_ACTIVE_CALL'
  | 'INVALID_NUMBER'
  | 'GUARDRAIL_BLOCKED'
  | 'MOCK_ONLY'
  | 'TIMEOUT'
  | 'RENDERER_ERROR'

export type ServiceErrorCode =
  | PhoneCommandErrorCode
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE_ENTITY'
  | 'SCOPE_DENIED'
  | 'CONFIRMATION_REQUIRED'
  | 'RATE_LIMITED'
  | 'APPROVAL_DENIED'
  | 'APPROVAL_TIMEOUT'
  | 'METHOD_NOT_ALLOWED'
  | 'INTERNAL_ERROR'

export interface ServiceErrorShape {
  code: ServiceErrorCode | string
  message: string
  details?: unknown
}

export interface PhoneCommandRequest {
  requestId: string
  command: PhoneCommand
  issuedAt: number
}

export type PhoneCommandResult =
  | { requestId: string; ok: true; status: PhoneStatusSnapshot }
  | { requestId: string; ok: false; code: PhoneCommandErrorCode; message: string }

export interface PhoneStatusSnapshot {
  runtimeMode: RuntimeMode
  phoneConnection: ConnectionStatus
  codexConnection: CodexConnectionState
  call?: PhoneCall
  controlMode: 'ai' | 'human'
  selectedCampaignId?: string
  configPath?: string
  runtimeNotice?: string
  codexCommand?: string
  codexError?: string
  updatedAt: number
}

// ─── Approval channel (call_dial + copilot external-write tools) ────────────
export type ApprovalKind = 'call_dial' | 'tool_execute' | 'sms_send'

export interface ApprovalRequest {
  id: string
  kind: ApprovalKind
  title: string
  summary: string
  details: Record<string, unknown>
  requestedBy: string
  expiresAt: number
}

export interface ApprovalDecision {
  id: string
  approved: boolean
  decidedAt: number
}

// ─── Copilot ─────────────────────────────────────────────────────────────────
export interface CopilotStatus {
  enabled: boolean
  threadId?: string
  state: 'idle' | 'thinking' | 'tool' | 'interrupted' | 'error'
  generation?: number
  pendingToolId?: string
  lastToolCall?: { toolId: string; at: number; ok: boolean }
}

// ─── MCP ─────────────────────────────────────────────────────────────────────
export type McpScope = 'read' | 'manage_campaigns' | 'control_calls' | 'send_messages'

export interface McpServerStatus {
  enabled: boolean
  running: boolean
  endpoint?: string
  tokenFingerprint?: string
  scopes: McpScope[]
  clients: { codex: boolean; claudeDesktop: boolean }
}

export interface McpClientConfigs {
  codexToml: string
  claudeDesktopJson: string
}

export interface McpClientConfigTargetResult {
  client: 'codex' | 'claudeDesktop'
  path: string
  action: 'created' | 'updated' | 'unchanged'
  backupPath?: string
}

export interface McpClientConfigApplyResult {
  results: McpClientConfigTargetResult[]
  claudeDesktopInstalled: boolean
  claudeDesktopMcpVisible: 'unverified' | 'not-installed'
}

// ─── CRM ─────────────────────────────────────────────────────────────────────
export type CrmProvider = 'mock' | 'zoho'

export interface CrmPublicConfig {
  provider: CrmProvider
  connected: boolean
  dataCenter?: string
  hasCredentials: boolean
  postCallSync: boolean
  lastSyncAt?: number
  lastError?: string
}

export interface CrmSaveInput {
  provider: CrmProvider
  dataCenter?: string
  clientId?: string
  clientSecret?: string
  grantCode?: string
  refreshToken?: string
  postCallSync?: boolean
}

export interface StartRealtimeRequest {
  callId?: string
  sdp: string
  threadId?: string
  voice?: RealtimeVoice
  instructions?: string
}

export interface StartRealtimeResponse {
  provider?: VoiceProviderName
  sdp: string
  threadId: string
  sessionId?: string
}

export interface LivePhoneApi {
  reportRealtimeStarted(sessionId: string): Promise<boolean>
  getVoiceSettings(): Promise<VoiceSettings>
  saveVoiceSettings(input: Partial<VoiceSettings>): Promise<VoiceSettings>
  getOpenAiSettings(): Promise<OpenAiSettingsPublic>
  saveOpenAiSettings(input: OpenAiSettingsSaveInput): Promise<OpenAiSettingsPublic>
  testOpenAiConnection(): Promise<OpenAiTestResult>
  getRuntimeConfig(): Promise<RuntimeConfig>
  getCampaignWorkspace(): Promise<CampaignWorkspace>
  getCampaign(id: string): Promise<Campaign>
  saveCampaign(campaign: CampaignInput): Promise<CampaignWorkspace>
  deleteCampaign(id: string): Promise<CampaignWorkspace>
  selectCampaign(id: string): Promise<CampaignWorkspace>
  startRealtime(request: StartRealtimeRequest): Promise<StartRealtimeResponse>
  appendSpeech(text: string): Promise<void>
  appendText(text: string): Promise<void>
  stopRealtime(): Promise<void>
  reportCallLifecycle(report: CallLifecycleReport): Promise<void>
  reportTranscriptEntry(entry: TranscriptEntry): Promise<void>
  listCalls(request: ListCallsRequest): Promise<CallSummary[]>
  getCall(id: string): Promise<CallSession | undefined>
  getCallTranscript(id: string): Promise<TranscriptEntry[]>
  submitTask(input: CallTaskSubmitInput): Promise<CallTask>
  listTasks(request: ListCallTasksRequest): Promise<CallTask[]>
  getTask(id: string): Promise<CallTask>
  waitTask(id: string, timeoutMs: number): Promise<CallTask>
  cancelTask(id: string): Promise<CallTask>
  getBudget(): Promise<CallBudget>
  saveBudget(input: CallBudgetSaveInput): Promise<CallBudget>
  getGeneralSettings(): Promise<GeneralSettings>
  saveGeneralSettings(input: GeneralSettingsSaveInput): Promise<GeneralSettings>
  getTwilioSettings(): Promise<TwilioSettingsPublic>
  saveTwilioSettings(input: TwilioSettingsSaveInput): Promise<TwilioSettingsPublic>
  importTwilioEnv(): Promise<{ imported: string[]; settings: TwilioSettingsPublic } | { cancelled: true }>
  testTwilioConnection(): Promise<TwilioTestResult>
  relaunchApp(): Promise<{ accepted: true }>
  listAppointments(request: ListAppointmentsRequest): Promise<Appointment[]>
  getCallAppointments(callId: string): Promise<Appointment[]>
  recordStart(request: RecordStartRequest): Promise<void>
  recordChunk(request: RecordChunkRequest): Promise<void>
  recordFinish(request: RecordFinishRequest): Promise<void>
  getRecording(callId: string): Promise<RecordingInfo | undefined>
  reportGuardrailEvent(event: GuardrailEvent): Promise<void>
  listGuardrailEvents(callId: string): Promise<GuardrailEvent[]>
  getWebhookConfig(): Promise<WebhookPublicConfig>
  saveWebhookConfig(input: WebhookSaveInput): Promise<WebhookPublicConfig>
  rotateWebhookSecret(): Promise<WebhookRotateResult>
  sendWebhookTest(): Promise<WebhookDeliverySummary>
  listWebhookDeliveries(request: { limit?: number }): Promise<WebhookDeliverySummary[]>
  onEvent(listener: (event: LivePhoneEvent) => void): () => void
  onPhoneCommand(listener: (request: PhoneCommandRequest) => void): () => void
  respondPhoneCommand(result: PhoneCommandResult): void
  publishPhoneStatus(snapshot: PhoneStatusSnapshot): void
  onApprovalRequested(listener: (request: ApprovalRequest) => void): () => void
  respondApproval(decision: ApprovalDecision): void
  getMcpStatus(): Promise<McpServerStatus>
  setMcpEnabled(enabled: boolean): Promise<McpServerStatus>
  rotateMcpToken(): Promise<{ status: McpServerStatus; token: string }>
  setMcpScopes(scopes: McpScope[]): Promise<McpServerStatus>
  getMcpClientConfigs(): Promise<McpClientConfigs>
  applyMcpClientConfigs(): Promise<McpClientConfigApplyResult>
  getCrmConfig(): Promise<CrmPublicConfig>
  saveCrmConfig(input: CrmSaveInput): Promise<CrmPublicConfig>
  testCrmConnection(): Promise<{ ok: boolean; error?: string }>
  listCrmSyncLog(request: { limit?: number }): Promise<unknown[]>
  getAppointmentsConfig(): Promise<AppointmentsConfig>
  saveAppointmentsConfig(input: AppointmentsSaveInput): Promise<AppointmentsConfig>
  debugPhoneCommand?(command: PhoneCommand): Promise<PhoneCommandResult>
  debugApprovalRequest?(request: ApprovalRequest): Promise<ApprovalDecision>
}

export const IPC = {
  realtimeStarted: 'live-phone:realtime-started',
  voiceSettingsGet: 'live-phone:voice-settings-get',
  voiceSettingsSave: 'live-phone:voice-settings-save',
  openAiSettingsGet: 'live-phone:openai-settings-get',
  openAiSettingsSave: 'live-phone:openai-settings-save',
  openAiSettingsTest: 'live-phone:openai-settings-test',
  getRuntimeConfig: 'live-phone:get-runtime-config',
  getCampaignWorkspace: 'live-phone:get-campaign-workspace',
  getCampaign: 'live-phone:get-campaign',
  saveCampaign: 'live-phone:save-campaign',
  deleteCampaign: 'live-phone:delete-campaign',
  selectCampaign: 'live-phone:select-campaign',
  startRealtime: 'live-phone:start-realtime',
  appendSpeech: 'live-phone:append-speech',
  appendText: 'live-phone:append-text',
  stopRealtime: 'live-phone:stop-realtime',
  reportCallLifecycle: 'live-phone:report-call-lifecycle',
  reportTranscriptEntry: 'live-phone:report-transcript-entry',
  listCalls: 'live-phone:list-calls',
  getCall: 'live-phone:get-call',
  getCallTranscript: 'live-phone:get-call-transcript',
  submitTask: 'live-phone:submit-task',
  listTasks: 'live-phone:list-tasks',
  getTask: 'live-phone:get-task',
  waitTask: 'live-phone:wait-task',
  cancelTask: 'live-phone:cancel-task',
  budgetGet: 'live-phone:budget-get',
  budgetSave: 'live-phone:budget-save',
  generalSettingsGet: 'live-phone:general-settings-get',
  generalSettingsSave: 'live-phone:general-settings-save',
  twilioSettingsGet: 'live-phone:twilio-settings-get',
  twilioSettingsSave: 'live-phone:twilio-settings-save',
  twilioSettingsImport: 'live-phone:twilio-settings-import',
  twilioSettingsTest: 'live-phone:twilio-settings-test',
  appRelaunch: 'live-phone:app-relaunch',
  listAppointments: 'live-phone:list-appointments',
  getCallAppointments: 'live-phone:get-call-appointments',
  recordStart: 'live-phone:record-start',
  recordChunk: 'live-phone:record-chunk',
  recordFinish: 'live-phone:record-finish',
  getRecording: 'live-phone:get-recording',
  reportGuardrailEvent: 'live-phone:report-guardrail-event',
  listGuardrailEvents: 'live-phone:list-guardrail-events',
  webhookGetConfig: 'live-phone:webhook-get-config',
  webhookSaveConfig: 'live-phone:webhook-save-config',
  webhookRotateSecret: 'live-phone:webhook-rotate-secret',
  webhookSendTest: 'live-phone:webhook-send-test',
  webhookListDeliveries: 'live-phone:webhook-list-deliveries',
  event: 'live-phone:event',
  phoneCommand: 'live-phone:phone-command',
  respondPhoneCommand: 'live-phone:respond-phone-command',
  publishPhoneStatus: 'live-phone:publish-phone-status',
  debugPhoneCommand: 'live-phone:debug-phone-command',
  debugApprovalRequest: 'live-phone:debug-approval-request',
  approvalRequested: 'live-phone:approval-requested',
  respondApproval: 'live-phone:respond-approval',
  mcpGetStatus: 'live-phone:mcp-get-status',
  mcpSetEnabled: 'live-phone:mcp-set-enabled',
  mcpRotateToken: 'live-phone:mcp-rotate-token',
  mcpSetScopes: 'live-phone:mcp-set-scopes',
  mcpGetClientConfigs: 'live-phone:mcp-get-client-configs',
  mcpApplyClientConfigs: 'live-phone:mcp-apply-client-configs',
  crmGetConfig: 'live-phone:crm-get-config',
  crmSaveConfig: 'live-phone:crm-save-config',
  crmTestConnection: 'live-phone:crm-test-connection',
  crmListSyncLog: 'live-phone:crm-list-sync-log',
  appointmentsGetConfig: 'live-phone:appointments-get-config',
  appointmentsSaveConfig: 'live-phone:appointments-save-config'
} as const

export const LIVE_API_VOICES = ['marin', 'quartz', 'ripple', 'vesper', 'willow', 'stone', 'gleam', 'meridian', 'bossa', 'tempo', 'beacon', 'delta', 'cinder'] as const
export type VoiceProviderName = 'codex' | 'gpt-live-api'
export interface VoiceSettings {
  provider: VoiceProviderName
  apiVoice: (typeof LIVE_API_VOICES)[number]
  startPolicy: 'on_dial' | 'on_answer'
}
export interface OpenAiSettingsPublic {
  apiKey: { configured: boolean; last4?: string; source: 'env' | 'settings' | 'unset'; readOnly: boolean }
}
export interface OpenAiSettingsSaveInput { apiKey?: string | null }
export interface OpenAiTestResult { ok: boolean; code: string }

/** Local engine tenant. Credentials resolve here; body/path cannot switch tenant. */
export const LOCAL_TENANT_ID = 'local' as const
export type TenantId = string
