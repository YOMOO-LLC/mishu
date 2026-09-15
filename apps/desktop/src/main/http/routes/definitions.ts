import { z } from 'zod'
import { CALL_END_REASONS, REALTIME_VOICES } from '../../../shared/contracts.js'

export const IdParamSchema = z.object({ id: z.string().min(1).max(200) })
export const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  reveal: z.enum(['true', 'false']).optional()
})
export const TaskListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.enum(['queued', 'awaiting_approval', 'dialing', 'in_call', 'analyzing', 'completed', 'failed', 'cancelled']).optional()
})
const TaskIncludeSchema = z.string().min(1).regex(
  /^(transcript|analysis|call)(,(transcript|analysis|call))*$/,
  'include must be a comma-separated list of transcript,analysis,call'
)
export const TaskGetQuerySchema = z.object({ include: TaskIncludeSchema.optional() })
export const TaskWaitQuerySchema = TaskGetQuerySchema.extend({
  timeoutMs: z.coerce.number().int().min(0).max(300_000).optional()
})
export const RevealQuerySchema = z.object({ reveal: z.enum(['true', 'false']).optional() })
export const AuditQuerySchema = ListQuerySchema
export const CampaignListQuerySchema = RevealQuerySchema.extend({
  includeEphemeral: z.enum(['0', '1']).optional()
})

export const CampaignInputSchema = z.object({
  name: z.string().min(1).max(80),
  direction: z.enum(['inbound', 'outbound', 'both']),
  systemPrompt: z.string().max(8_000).optional(),
  voice: z.enum(REALTIME_VOICES),
  policy: z.record(z.string(), z.unknown()).optional(),
  inboundNumber: z.string().optional(),
  outboundCallerId: z.string().optional()
})
export const CampaignUpdateSchema = CampaignInputSchema.partial()
export const DialBodySchema = z.object({
  peer: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
  goal: z.string().min(1).max(8_000).optional(),
  idempotencyKey: z.string().min(1).max(200).optional()
}).refine((input) => Boolean(input.peer ?? input.to), { message: 'peer or to is required' })
export const DialSchema = DialBodySchema.transform((input) => ({
  peer: (input.peer ?? input.to) as string,
  ...(input.campaignId ? { campaignId: input.campaignId } : {}),
  ...(input.goal ? { goal: input.goal } : {}),
  ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
}))
const TaskConstraintsSchema = z.object({
  maxDurationSec: z.number().int().min(30).max(3_600).optional(),
  notBefore: z.string().datetime().optional(),
  notAfter: z.string().datetime().optional(),
  maxAttempts: z.number().int().min(1).max(4).optional(),
  allowedToolIds: z.array(z.string().min(1).max(200)).max(100).optional()
})
const ContactFieldsSchema = z.object({
  displayName: z.string().max(200).optional(),
  company: z.string().max(200).optional(),
  tier: z.string().max(100).optional(),
  language: z.string().max(80).optional(),
  timeZone: z.string().max(100).optional(),
  notes: z.string().max(2_000).optional(),
  facts: z.record(z.string(), z.unknown()).optional(),
  source: z.string().min(1).max(120).optional(),
  expiresAt: z.union([z.number().nonnegative(), z.string().datetime()]).optional()
})
const TaskCampaignSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  direction: z.literal('outbound'),
  systemPrompt: z.string().max(8_000).optional(),
  voice: z.enum(REALTIME_VOICES).optional(),
  policy: z.record(z.string(), z.unknown()).optional()
})
export const ContactCardInputSchema = ContactFieldsSchema.extend({ phone: z.string().min(1) })
export const ContactCardUpdateSchema = ContactFieldsSchema.extend({ phone: z.string().min(1).optional() })
export const ContactBatchSchema = z.union([
  z.array(ContactCardInputSchema).min(1).max(100),
  z.object({ contacts: z.array(ContactCardInputSchema).min(1).max(100) })
])
export const TaskSubmitBodySchema = z.object({
  to: z.string().min(1),
  campaignId: z.string().min(1).optional(),
  campaign_id: z.string().min(1).optional(),
  campaign: TaskCampaignSchema.optional(),
  goal: z.string().min(1).max(8_000),
  resultSchema: z.record(z.string(), z.unknown()).optional(),
  result_schema: z.record(z.string(), z.unknown()).optional(),
  constraints: TaskConstraintsSchema.optional(),
  callbackUrl: z.string().optional(),
  callback_url: z.string().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
  createdBy: z.enum(['http', 'cli']).optional(),
  contact: ContactCardUpdateSchema.optional()
})
export const TaskSubmitSchema = TaskSubmitBodySchema.transform((input) => ({
  to: input.to,
  ...((input.campaignId ?? input.campaign_id) ? { campaignId: input.campaignId ?? input.campaign_id } : {}),
  ...(input.campaign ? { campaign: input.campaign } : {}),
  goal: input.goal,
  ...((input.resultSchema ?? input.result_schema) ? { resultSchema: input.resultSchema ?? input.result_schema } : {}),
  ...(input.constraints ? { constraints: input.constraints } : {}),
  ...((input.callbackUrl ?? input.callback_url) ? { callbackUrl: input.callbackUrl ?? input.callback_url } : {}),
  ...((input.idempotencyKey ?? input.idempotency_key) ? { idempotencyKey: input.idempotencyKey ?? input.idempotency_key } : {}),
  ...(input.createdBy ? { createdBy: input.createdBy } : {}),
  ...(input.contact ? { contact: input.contact } : {})
}))
export const BudgetSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  dailyMaxCalls: z.number().int().min(0).max(10_000).optional(),
  dailyMaxMinutes: z.number().min(0).max(100_000).optional(),
  allowedPrefixes: z.array(z.string()).optional(),
  allowedNumbers: z.array(z.string()).optional(),
  allowedHours: z.object({
    timeZone: z.string(),
    windows: z.array(z.object({
      days: z.array(z.number().int().min(0).max(6)),
      start: z.string(),
      end: z.string()
    }))
  }).optional(),
  killSwitch: z.boolean().optional()
})
export const GeneralSettingsSchema = z.object({
  minimizeToTray: z.boolean().optional(),
  launchAtLogin: z.boolean().optional(),
  startHidden: z.boolean().optional()
})
export const TwilioSettingsSchema = z.object({
  accountSid: z.string().nullable().optional(),
  apiKeySid: z.string().nullable().optional(),
  apiKeySecret: z.string().nullable().optional(),
  twimlAppSid: z.string().nullable().optional(),
  phoneNumber: z.string().nullable().optional(),
  clientIdentity: z.string().nullable().optional(),
  mode: z.enum(['auto', 'twilio', 'mock']).optional()
})
export const TwilioImportSchema = z.object({ path: z.string().min(1) })
export const ApprovalDecisionSchema = z.object({ approved: z.boolean() })
export const SimulateIncomingSchema = z.object({ peer: z.string().optional() })
export const ControlModeSchema = z.object({ mode: z.enum(['ai', 'human']) })
export const WebhookSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  url: z.string().optional(),
  events: z.array(z.string()).optional(),
  secret: z.string().optional()
})
export const McpSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  scopes: z.array(z.enum(['read', 'manage_campaigns', 'control_calls', 'send_messages'])).optional()
})
export const AppointmentSettingsSchema = z.object({
  provider: z.enum(['mock', 'zoho']).optional(),
  autoConfirm: z.boolean().optional(),
  businessHours: z.object({
    days: z.array(z.number().int().min(0).max(6)),
    start: z.string(),
    end: z.string()
  }).optional(),
  timeZone: z.string().optional()
})
export const CrmSettingsSchema = z.object({
  provider: z.enum(['mock', 'zoho']),
  dataCenter: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  grantCode: z.string().optional(),
  refreshToken: z.string().optional(),
  postCallSync: z.boolean().optional()
})
export const RealtimeStartSchema = z.object({
  sdp: z.string().min(1), threadId: z.string().optional(), voice: z.enum(REALTIME_VOICES).optional(),
  instructions: z.string().optional()
})
export const TextSchema = z.object({ text: z.string() })
export const CallLifecycleSchema = z.object({
  call: z.object({
    id: z.string(), direction: z.enum(['inbound', 'outbound']), peer: z.string(),
    status: z.enum(['idle', 'ringing', 'dialing', 'connecting', 'active', 'held', 'ended', 'error']),
    startedAt: z.number().optional()
  }),
  runtimeMode: z.enum(['mock', 'twilio']),
  campaign: z.unknown().optional(), threadId: z.string().optional(), sessionId: z.string().optional(),
  endReason: z.enum(CALL_END_REASONS).optional()
})
export const TranscriptEntrySchema = z.object({
  id: z.string(), speaker: z.enum(['caller', 'assistant', 'system']), text: z.string(),
  final: z.boolean(), timestamp: z.number()
})
export const GuardrailEventSchema = z.object({
  callId: z.string(), kind: z.enum(['max_duration', 'forbidden_claim', 'dnc_blocked', 'outside_calling_hours', 'blocked_caller']),
  at: z.number(), details: z.record(z.string(), z.unknown()).optional()
})
export const RecordingStartSchema = z.object({ callId: z.string(), mime: z.string() })
export const RecordingChunkSchema = z.object({ callId: z.string(), seq: z.number().int().min(0), dataBase64: z.string() })
export const RecordingFinishSchema = z.object({ callId: z.string(), durationMs: z.number().min(0) })

const JsonObjectSchema = z.object({}).loose()
const AcceptedResponseSchema = z.object({ accepted: z.literal(true) })
const PhoneCommandResponseSchema = z.object({ status: JsonObjectSchema })
const CampaignSchema = z.object({
  id: z.string(), name: z.string(), direction: z.enum(['inbound', 'outbound', 'both']),
  systemPrompt: z.string(), voice: z.enum(REALTIME_VOICES), policy: JsonObjectSchema,
  inboundNumber: z.string().optional(), outboundCallerId: z.string().optional(),
  ephemeral: z.boolean(),
  createdAt: z.number(), updatedAt: z.number()
})
const CampaignWorkspaceSchema = z.object({ campaigns: z.array(CampaignSchema), selectedCampaignId: z.string() })
const CallSchema = z.object({
  voiceProvider: z.enum(['codex', 'gpt-live-api']).optional(),
  voiceSeconds: z.number().nonnegative().optional(),
  id: z.string(), direction: z.enum(['inbound', 'outbound']), peer: z.string(),
  status: z.enum(['idle', 'ringing', 'dialing', 'connecting', 'active', 'held', 'ended', 'error'])
}).loose()
const TranscriptResponseSchema = z.object({ transcript: z.array(TranscriptEntrySchema) })
const RecordingSchema = z.object({
  callId: z.string(), playbackUrl: z.string(), bytes: z.number().optional(), sha256: z.string().optional(),
  durationMs: z.number().optional(), mime: z.string().optional(),
  status: z.enum(['recording', 'complete', 'incomplete']), createdAt: z.number(), updatedAt: z.number()
}).nullable()
const AppointmentSchema = z.object({
  id: z.string(), callId: z.string().optional(), campaignId: z.string(), peer: z.string(),
  startAt: z.string(), endAt: z.string(), timeZone: z.string(),
  status: z.enum(['tentative', 'confirmed', 'cancelled', 'failed']),
  source: z.enum(['copilot', 'mcp', 'manual']), createdAt: z.number(), updatedAt: z.number()
}).loose()
const WebhookConfigSchema = z.object({ enabled: z.boolean(), url: z.string(), events: z.array(z.string()), hasSecret: z.boolean() })
const WebhookDeliverySchema = z.object({ id: z.string(), eventType: z.string(), status: z.string(), attempts: z.number(), createdAt: z.number() }).loose()
const McpStatusSchema = z.object({
  enabled: z.boolean(), running: z.boolean(), endpoint: z.string().optional(), tokenFingerprint: z.string().optional(),
  scopes: z.array(z.enum(['read', 'manage_campaigns', 'control_calls', 'send_messages'])),
  clients: z.object({ codex: z.boolean(), claudeDesktop: z.boolean() })
})
const McpClientConfigApplyResponseSchema = z.object({
  results: z.array(z.object({
    client: z.enum(['codex', 'claudeDesktop']),
    path: z.string(),
    action: z.enum(['created', 'updated', 'unchanged']),
    backupPath: z.string().optional()
  })),
  claudeDesktopInstalled: z.boolean(),
  claudeDesktopMcpVisible: z.enum(['unverified', 'not-installed'])
})
const AppointmentSettingsResponseSchema = z.object({
  provider: z.enum(['mock', 'zoho']), autoConfirm: z.boolean(),
  businessHours: z.object({ days: z.array(z.number()), start: z.string(), end: z.string() }), timeZone: z.string()
})
const CrmConfigSchema = z.object({ provider: z.enum(['mock', 'zoho']), connected: z.boolean(), hasCredentials: z.boolean(), postCallSync: z.boolean() }).loose()
const ApprovalSchema = z.object({
  id: z.string(), kind: z.enum(['call_dial', 'tool_execute', 'sms_send']), title: z.string(), summary: z.string(),
  details: JsonObjectSchema, requestedBy: z.string(), expiresAt: z.number()
})
const TaskStatusSchema = z.enum(['queued', 'awaiting_approval', 'dialing', 'in_call', 'analyzing', 'completed', 'failed', 'cancelled'])
const TaskSchema = z.object({
  id: z.string(), to: z.string(), campaignId: z.string(), goal: z.string(),
  resultSchema: JsonObjectSchema.optional(), constraints: JsonObjectSchema,
  callbackUrl: z.string().optional(), idempotencyKey: z.string(), status: TaskStatusSchema,
  attempts: z.number(), callId: z.string().optional(), resultId: z.string().optional(),
  result: z.unknown().optional(), outcome: z.enum(['reached', 'no_answer', 'voicemail', 'refused', 'wrong_number', 'error']).optional(),
  error: z.string().optional(), createdBy: z.enum(['http', 'mcp', 'ui', 'cli']),
  createdAt: z.number(), updatedAt: z.number(), startedAt: z.number().optional(), endedAt: z.number().optional(),
  transcript: z.array(TranscriptEntrySchema).optional(),
  analysis: z.object({
    resultId: z.string(), outcome: z.enum(['reached', 'no_answer', 'voicemail', 'refused', 'wrong_number', 'error']),
    summary: z.string(), confidence: z.enum(['high', 'medium', 'low']), schemaHash: z.string(),
    result: z.unknown().optional(), analyzedAt: z.number()
  }).optional(),
  call: CallSchema.optional()
})
const CallAnalysisSchema = z.object({
  resultId: z.string(), outcome: z.enum(['reached', 'no_answer', 'voicemail', 'refused', 'wrong_number', 'error']),
  summary: z.string(), confidence: z.enum(['high', 'medium', 'low']), schemaHash: z.string(),
  result: z.unknown().optional(), analyzedAt: z.number()
})
const CallAuditSchema = z.object({
  at: z.number(), actor: z.string(), action: z.string(), tenantId: z.string().optional(), details: z.unknown().optional()
})
const BudgetResponseSchema = z.object({
  enabled: z.boolean(), dailyMaxCalls: z.number(), dailyMaxMinutes: z.number(),
  allowedPrefixes: z.array(z.string()), allowedNumbers: z.array(z.string()),
  allowedHours: z.object({ timeZone: z.string(), windows: z.array(z.object({ days: z.array(z.number()), start: z.string(), end: z.string() })) }),
  killSwitch: z.boolean()
})
const ContactCardSchema = z.object({
  phone: z.string(),
  displayName: z.string().optional(), company: z.string().optional(), tier: z.string().optional(),
  language: z.string().optional(), timeZone: z.string().optional(), notes: z.string().optional(),
  facts: JsonObjectSchema, source: z.string(), expiresAt: z.number().optional(),
  createdAt: z.number(), updatedAt: z.number()
})
const GeneralSettingsResponseSchema = z.object({
  minimizeToTray: z.boolean(), launchAtLogin: z.boolean(), startHidden: z.boolean()
})

export interface ApiRouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  summary: string
  body?: z.ZodType
  response: z.ZodType
  query?: z.ZodType
  responseContentType?: string
  status?: number
}

type ApiRouteSpec = Omit<ApiRouteDefinition, 'response'> & { response?: z.ZodType }

const API_ROUTE_SPECS: ApiRouteSpec[] = [
  { method: 'GET', path: '/v1/settings/voice', summary: 'Get voice source, voice and start policy', response: JsonObjectSchema },
  { method: 'PUT', path: '/v1/settings/voice', summary: 'Update voice settings between calls', body: z.object({ provider: z.enum(['codex', 'gpt-live-api']).optional(), apiVoice: z.string().optional(), startPolicy: z.enum(['on_dial', 'on_answer']).optional() }).strict(), response: JsonObjectSchema },
  { method: 'GET', path: '/v1/settings/openai', summary: 'Get masked OpenAI key status', response: JsonObjectSchema },
  { method: 'PUT', path: '/v1/settings/openai', summary: 'Save a local OpenAI key; never return the key', body: z.object({ apiKey: z.string().nullable().optional() }).strict(), response: JsonObjectSchema },
  { method: 'POST', path: '/v1/settings/openai/test', summary: 'Test model access without creating a paid session', response: JsonObjectSchema },
  { method: 'GET', path: '/v1/health', summary: 'Get API health', response: z.object({ status: z.literal('ok') }) },
  { method: 'GET', path: '/v1/status', summary: 'Get phone and service status', response: z.object({ phone: JsonObjectSchema, mcp: McpStatusSchema }) },
  { method: 'GET', path: '/v1/runtime', summary: 'Get non-secret runtime configuration', response: JsonObjectSchema },
  { method: 'POST', path: '/v1/realtime/sessions', summary: 'Start a realtime session', body: RealtimeStartSchema, response: z.object({ sdp: z.string(), threadId: z.string(), sessionId: z.string().optional() }), status: 202 },
  { method: 'POST', path: '/v1/realtime/sessions/current/speech', summary: 'Append speech text', body: TextSchema, response: AcceptedResponseSchema, status: 202 },
  { method: 'POST', path: '/v1/realtime/sessions/current/text', summary: 'Append context text', body: TextSchema, response: AcceptedResponseSchema, status: 202 },
  { method: 'POST', path: '/v1/realtime/sessions/current/stop', summary: 'Stop the realtime session', response: AcceptedResponseSchema, status: 202 },
  { method: 'POST', path: '/v1/events/call-lifecycle', summary: 'Report a call lifecycle event', body: CallLifecycleSchema, response: AcceptedResponseSchema, status: 202 },
  { method: 'POST', path: '/v1/events/transcript', summary: 'Report a transcript entry', body: TranscriptEntrySchema, response: AcceptedResponseSchema, status: 202 },
  { method: 'POST', path: '/v1/events/guardrail', summary: 'Report a guardrail event', body: GuardrailEventSchema, response: AcceptedResponseSchema, status: 202 },
  { method: 'POST', path: '/v1/recordings/start', summary: 'Start recording ingestion', body: RecordingStartSchema, response: AcceptedResponseSchema, status: 202 },
  { method: 'POST', path: '/v1/recordings/chunk', summary: 'Append a base64 recording chunk', body: RecordingChunkSchema, response: AcceptedResponseSchema, status: 202 },
  { method: 'POST', path: '/v1/recordings/finish', summary: 'Finish recording ingestion', body: RecordingFinishSchema, response: AcceptedResponseSchema, status: 202 },
  { method: 'GET', path: '/v1/campaigns', summary: 'List campaigns', query: CampaignListQuerySchema, response: CampaignWorkspaceSchema },
  { method: 'POST', path: '/v1/campaigns', summary: 'Create a campaign', body: CampaignInputSchema, query: RevealQuerySchema, response: CampaignWorkspaceSchema, status: 201 },
  { method: 'GET', path: '/v1/campaigns/{id}', summary: 'Get a campaign', query: RevealQuerySchema, response: CampaignSchema },
  { method: 'PUT', path: '/v1/campaigns/{id}', summary: 'Update a campaign', body: CampaignUpdateSchema, query: RevealQuerySchema, response: CampaignWorkspaceSchema },
  { method: 'DELETE', path: '/v1/campaigns/{id}', summary: 'Delete a campaign', query: RevealQuerySchema, response: CampaignWorkspaceSchema },
  { method: 'POST', path: '/v1/campaigns/{id}/select', summary: 'Select a campaign', query: RevealQuerySchema, response: CampaignWorkspaceSchema },
  { method: 'POST', path: '/v1/calls', summary: 'Request an outbound call', body: DialBodySchema, response: z.object({ approvalId: z.string() }), status: 202 },
  { method: 'POST', path: '/v1/tasks', summary: 'Submit a queued call task', body: TaskSubmitBodySchema, response: z.object({ taskId: z.string(), status: TaskStatusSchema }), status: 202 },
  { method: 'GET', path: '/v1/tasks', summary: 'List call tasks', query: TaskListQuerySchema, response: z.object({ tasks: z.array(TaskSchema) }) },
  { method: 'GET', path: '/v1/tasks/{id}', summary: 'Get a call task', query: TaskGetQuerySchema, response: TaskSchema },
  { method: 'GET', path: '/v1/tasks/{id}/wait', summary: 'Wait for a terminal task state or timeout', query: TaskWaitQuerySchema, response: TaskSchema },
  { method: 'POST', path: '/v1/tasks/{id}/cancel', summary: 'Cancel a call task', response: TaskSchema, status: 202 },
  { method: 'GET', path: '/v1/contacts', summary: 'List non-expired contact cards with masked phone numbers', query: ListQuerySchema, response: z.object({ contacts: z.array(ContactCardSchema) }) },
  { method: 'POST', path: '/v1/contacts:batch', summary: 'Upsert up to 100 contact cards', body: ContactBatchSchema, response: z.object({ contacts: z.array(ContactCardSchema) }) },
  { method: 'GET', path: '/v1/contacts/{phone}', summary: 'Get one non-expired contact card', response: ContactCardSchema },
  { method: 'PUT', path: '/v1/contacts/{phone}', summary: 'Upsert one contact card', body: ContactCardUpdateSchema, response: ContactCardSchema },
  { method: 'DELETE', path: '/v1/contacts/{phone}', summary: 'Delete one contact card', response: z.object({ deleted: z.literal(true), phone: z.string() }) },
  { method: 'POST', path: '/v1/calls/current/hangup', summary: 'Hang up the current call', response: PhoneCommandResponseSchema, status: 202 },
  { method: 'POST', path: '/v1/calls/current/answer', summary: 'Answer the current call', response: PhoneCommandResponseSchema, status: 202 },
  { method: 'POST', path: '/v1/calls/current/reject', summary: 'Reject the current call', response: PhoneCommandResponseSchema, status: 202 },
  { method: 'POST', path: '/v1/calls/current/control-mode', summary: 'Set AI or human control mode', body: ControlModeSchema, response: PhoneCommandResponseSchema, status: 202 },
  { method: 'GET', path: '/v1/calls', summary: 'List calls', query: ListQuerySchema, response: z.object({ calls: z.array(CallSchema) }) },
  { method: 'GET', path: '/v1/calls/{id}', summary: 'Get a call', query: RevealQuerySchema, response: CallSchema },
  { method: 'GET', path: '/v1/calls/{id}/transcript', summary: 'Get call transcript', query: RevealQuerySchema, response: TranscriptResponseSchema },
  { method: 'GET', path: '/v1/calls/{id}/analysis', summary: 'Get the latest call analysis', response: CallAnalysisSchema },
  { method: 'GET', path: '/v1/calls/{id}/audit', summary: 'List sanitized call audit entries', query: AuditQuerySchema, response: z.object({ audit: z.array(CallAuditSchema) }) },
  { method: 'GET', path: '/v1/calls/{id}/recording', summary: 'Get recording metadata', response: RecordingSchema },
  { method: 'GET', path: '/v1/calls/{id}/recording/audio', summary: 'Download recording audio', response: z.string(), responseContentType: 'application/octet-stream' },
  { method: 'GET', path: '/v1/calls/{id}/guardrails', summary: 'Get call guardrail events', response: z.object({ guardrails: z.array(GuardrailEventSchema) }) },
  { method: 'GET', path: '/v1/calls/{id}/appointments', summary: 'Get call appointments', query: RevealQuerySchema, response: z.object({ appointments: z.array(AppointmentSchema) }) },
  { method: 'GET', path: '/v1/appointments', summary: 'List appointments', query: ListQuerySchema, response: z.object({ appointments: z.array(AppointmentSchema) }) },
  { method: 'GET', path: '/v1/settings/webhook', summary: 'Get webhook settings', response: WebhookConfigSchema },
  { method: 'GET', path: '/v1/settings/budget', summary: 'Get autonomous calling budget', response: BudgetResponseSchema },
  { method: 'PUT', path: '/v1/settings/budget', summary: 'Update autonomous calling budget', body: BudgetSettingsSchema, response: BudgetResponseSchema },
  { method: 'GET', path: '/v1/settings/general', summary: 'Get general application settings', response: GeneralSettingsResponseSchema },
  { method: 'PUT', path: '/v1/settings/general', summary: 'Update general application settings', body: GeneralSettingsSchema, response: GeneralSettingsResponseSchema },
  { method: 'GET', path: '/v1/settings/twilio', summary: 'Get masked effective Twilio settings', response: JsonObjectSchema },
  { method: 'PUT', path: '/v1/settings/twilio', summary: 'Update local Twilio settings', body: TwilioSettingsSchema, response: JsonObjectSchema },
  { method: 'POST', path: '/v1/settings/twilio/test', summary: 'Test Twilio credentials and resources', response: JsonObjectSchema },
  { method: 'POST', path: '/v1/settings/twilio/import', summary: 'Import allowed Twilio fields from a local .env file', body: TwilioImportSchema, response: JsonObjectSchema },
  { method: 'POST', path: '/v1/app/relaunch', summary: 'Relaunch the desktop app when no call is active', response: AcceptedResponseSchema },
  { method: 'PUT', path: '/v1/settings/webhook', summary: 'Update webhook settings', body: WebhookSettingsSchema, response: WebhookConfigSchema },
  { method: 'POST', path: '/v1/settings/webhook/test', summary: 'Send a test webhook', response: WebhookDeliverySchema, status: 202 },
  { method: 'POST', path: '/v1/settings/webhook/secret/rotate', summary: 'Rotate the webhook signing secret', response: z.object({ config: WebhookConfigSchema, secret: z.string() }) },
  { method: 'GET', path: '/v1/settings/webhook/deliveries', summary: 'List webhook deliveries', query: ListQuerySchema, response: z.object({ deliveries: z.array(WebhookDeliverySchema) }) },
  { method: 'GET', path: '/v1/settings/mcp', summary: 'Get MCP settings', response: McpStatusSchema },
  { method: 'PUT', path: '/v1/settings/mcp', summary: 'Update MCP settings', body: McpSettingsSchema, response: McpStatusSchema },
  { method: 'POST', path: '/v1/settings/mcp/token/rotate', summary: 'Rotate the MCP bearer token', response: z.object({ status: McpStatusSchema, token: z.string() }) },
  { method: 'GET', path: '/v1/settings/mcp/client-configs', summary: 'Get local MCP client configuration templates', response: z.object({ codexToml: z.string(), claudeDesktopJson: z.string() }) },
  { method: 'POST', path: '/v1/settings/mcp/client-configs/apply', summary: 'Back up and merge local MCP client configurations', response: McpClientConfigApplyResponseSchema },
  { method: 'GET', path: '/v1/settings/appointments', summary: 'Get appointment settings', response: AppointmentSettingsResponseSchema },
  { method: 'PUT', path: '/v1/settings/appointments', summary: 'Update appointment settings', body: AppointmentSettingsSchema, response: AppointmentSettingsResponseSchema },
  { method: 'GET', path: '/v1/settings/crm', summary: 'Get CRM settings', response: CrmConfigSchema },
  { method: 'PUT', path: '/v1/settings/crm', summary: 'Update CRM settings', body: CrmSettingsSchema, response: CrmConfigSchema },
  { method: 'POST', path: '/v1/settings/crm/test', summary: 'Test the CRM connection', response: z.object({ ok: z.boolean(), error: z.string().optional() }) },
  { method: 'GET', path: '/v1/settings/crm/sync-log', summary: 'List CRM synchronization attempts', query: ListQuerySchema, response: z.object({ entries: z.array(JsonObjectSchema) }) },
  { method: 'GET', path: '/v1/approvals', summary: 'List pending approvals', response: z.object({ approvals: z.array(ApprovalSchema) }) },
  { method: 'POST', path: '/v1/approvals/{id}/decide', summary: 'Decide a pending approval', body: ApprovalDecisionSchema, response: z.object({ id: z.string(), approved: z.boolean() }) },
  { method: 'POST', path: '/v1/debug/simulate-incoming', summary: 'Simulate an incoming call in mock mode', body: SimulateIncomingSchema, response: PhoneCommandResponseSchema, status: 202 },
  { method: 'GET', path: '/v1/openapi.json', summary: 'Get the OpenAPI document', response: JsonObjectSchema }
]

export const API_ROUTES: ApiRouteDefinition[] = API_ROUTE_SPECS.map((route) => ({
  ...route,
  response: route.response ?? JsonObjectSchema
}))

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional()
  })
})
