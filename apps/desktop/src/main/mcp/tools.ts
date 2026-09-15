import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { maskPhoneNumber } from '../../shared/phone-mask.js'
import type {
  Campaign,
  CampaignInput,
  CampaignPolicy,
  ContactCardInput,
  AppointmentsSaveInput,
  CrmSaveInput,
  McpScope,
  PhoneCommandResult,
  PhoneStatusSnapshot,
  RealtimeVoice
} from '../../shared/contracts.js'
import { REALTIME_VOICES } from '../../shared/contracts.js'
import type { MainModuleContext } from '../module-context.js'
import { ServiceError } from '../services/service-error.js'

export const MCP_TOOL_SCOPES = {
  phone_get_status: 'read',
  campaign_list: 'read',
  campaign_get: 'read',
  call_list: 'read',
  call_get: 'read',
  call_analysis_get: 'read',
  call_audit_list: 'read',
  appointment_list: 'read',
  transcript_get: 'read',
  recording_get: 'read',
  campaign_create: 'manage_campaigns',
  campaign_update: 'manage_campaigns',
  campaign_select: 'manage_campaigns',
  campaign_delete: 'manage_campaigns',
  call_dial: 'control_calls',
  call_hangup: 'control_calls'
  ,call_answer: 'control_calls'
  ,call_reject: 'control_calls'
  ,call_set_control_mode: 'control_calls'
  ,debug_simulate_incoming: 'control_calls'
  ,campaign_policy_update: 'manage_campaigns'
  ,call_guardrails: 'read'
  ,call_appointments: 'read'
  ,settings_webhook_get: 'read'
  ,settings_webhook_update: 'send_messages'
  ,settings_webhook_test: 'send_messages'
  ,settings_webhook_rotate_secret: 'send_messages'
  ,settings_webhook_deliveries: 'read'
  ,settings_mcp_get: 'read'
  ,settings_mcp_update: 'manage_campaigns'
  ,settings_mcp_token_rotate: 'manage_campaigns'
  ,settings_mcp_client_configs: 'read'
  ,settings_mcp_client_configs_apply: 'manage_campaigns'
  ,settings_appointments_get: 'read'
  ,settings_appointments_update: 'manage_campaigns'
  ,settings_crm_get: 'read'
  ,settings_crm_update: 'manage_campaigns'
  ,settings_crm_test: 'manage_campaigns'
  ,settings_crm_sync_log: 'read'
  ,approval_list: 'read'
  ,approval_decide: 'control_calls'
  ,task_submit: 'control_calls'
  ,task_get: 'read'
  ,task_list: 'read'
  ,task_wait: 'read'
  ,task_cancel: 'control_calls'
  ,budget_get: 'read'
  ,budget_update: 'control_calls'
  ,contact_card_set: 'manage_campaigns'
  ,contact_card_get: 'read'
  ,contact_card_list: 'read'
  ,contact_card_delete: 'manage_campaigns'
  ,settings_general_get: 'read'
  ,settings_general_update: 'manage_campaigns'
  ,settings_voice_get: 'read'
  ,settings_openai_get: 'read'
  ,settings_openai_test: 'read'
  ,settings_twilio_get: 'read'
  ,settings_twilio_test: 'read'
} as const satisfies Record<string, McpScope>

export type McpToolName = keyof typeof MCP_TOOL_SCOPES

export class McpToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'McpToolError'
  }
}

interface ToolServiceOptions {
  context: MainModuleContext
  approvals: ApprovalRequester
  getScopes(): ReadonlySet<McpScope>
  now?: () => number
}

export interface ApprovalRequester {
  request(input: {
    kind: 'call_dial'
    title: string
    summary: string
    details: Record<string, unknown>
    requestedBy: string
  }): Promise<import('../services/approval-service.js').ApprovalOutcome>
}

export class McpToolService {
  private readonly context: MainModuleContext
  private readonly approvals: ApprovalRequester
  private readonly getScopes: ToolServiceOptions['getScopes']
  private readonly now: () => number

  constructor(options: ToolServiceOptions) {
    this.context = options.context
    this.approvals = options.approvals
    this.getScopes = options.getScopes
    this.now = options.now ?? Date.now
  }

  async invoke(name: McpToolName, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const scope = MCP_TOOL_SCOPES[name]
    let resultCode = 'OK'
    try {
      if (!this.getScopes().has(scope)) {
        throw new McpToolError('SCOPE_DENIED', `Tool ${name} requires scope ${scope}`)
      }
      return await this.execute(name, args)
    } catch (error) {
      const normalized = normalizeError(error)
      resultCode = normalized.code
      return toolError(normalized.code, normalized.message)
    } finally {
      this.writeAudit(name, scope, maskAuditArgs(args), resultCode)
    }
  }

  phoneStatus(): PhoneStatusSnapshot {
    this.requireScope('read')
    return maskStatus(this.context.services.phone.status())
  }

  campaigns(): Campaign[] {
    this.requireScope('read')
    return this.context.services.campaigns.list()
  }

  call(id: string): ReturnType<MainModuleContext['callStore']['getCall']> {
    this.requireScope('read')
    return this.context.services.calls.get(id)
  }

  transcript(id: string): ReturnType<MainModuleContext['callStore']['getCallTranscript']> {
    this.requireScope('read')
    return this.context.services.calls.transcript(id).map((entry) => ({
      ...entry,
      text: redactPhoneNumbers(entry.text)
    }))
  }

  appointments(request: { limit?: number; offset?: number } = {}) {
    this.requireScope('read')
    return this.context.services.calls.listAppointments(request)
  }

  private requireScope(scope: McpScope): void {
    if (!this.getScopes().has(scope)) throw new McpToolError('SCOPE_DENIED', `Resource requires scope ${scope}`)
  }

  private async execute(name: McpToolName, args: Record<string, unknown>): Promise<CallToolResult> {
    switch (name) {
      case 'phone_get_status':
        return toolSuccess(this.phoneStatus())
      case 'campaign_list': {
        const workspace = this.context.services.campaigns.workspace({
          includeEphemeral: args.include_ephemeral === true
        })
        return toolSuccess({
          selectedCampaignId: workspace.selectedCampaignId,
          campaigns: workspace.campaigns.map(maskCampaign)
        })
      }
      case 'campaign_get': {
        const id = requiredString(args.id, 'id')
        return toolSuccess(this.context.services.campaigns.get(id))
      }
      case 'call_list': {
        const calls = this.context.services.calls.list({
          limit: optionalInteger(args.limit),
          offset: optionalInteger(args.offset)
        })
        return toolSuccess({ calls })
      }
      case 'call_get': {
        const id = requiredString(args.id, 'id')
        const reveal = args.reveal_phone === true
        return toolSuccess(this.context.services.calls.get(id, { reveal }))
      }
      case 'call_analysis_get':
        return toolSuccess(this.context.services.calls.analysis(requiredString(args.id, 'id')))
      case 'call_audit_list':
        return toolSuccess({ audit: this.context.services.calls.audit(
          requiredString(args.id, 'id'),
          { limit: optionalInteger(args.limit), offset: optionalInteger(args.offset) },
          { reveal: args.reveal_phone === true }
        ) })
      case 'appointment_list':
        return toolSuccess({
          appointments: this.appointments({
            limit: optionalInteger(args.limit),
            offset: optionalInteger(args.offset)
          })
        })
      case 'transcript_get':
        return toolSuccess({ transcript: this.transcript(requiredString(args.id, 'id')) })
      case 'recording_get': {
        const id = requiredString(args.id, 'id')
        return toolSuccess(this.context.services.calls.recording(id))
      }
      case 'call_guardrails':
        return toolSuccess({ guardrails: this.context.services.calls.guardrails(requiredString(args.id, 'id')) })
      case 'call_appointments':
        return toolSuccess({ appointments: this.context.services.calls.callAppointments(requiredString(args.id, 'id')) })
      case 'campaign_create':
        return toolSuccess(this.context.services.campaigns.create(campaignInput(args)))
      case 'campaign_update': {
        const id = requiredString(args.id, 'id')
        return toolSuccess(this.context.services.campaigns.update(id, campaignInput({
          ...this.context.services.campaigns.get(id, { reveal: true }),
          ...args,
          id
        })))
      }
      case 'campaign_select':
        return toolSuccess(this.context.services.campaigns.select(requiredString(args.id, 'id')))
      case 'campaign_delete':
        if (args.confirm !== true) throw new McpToolError('CONFIRMATION_REQUIRED', 'campaign_delete requires confirm: true')
        return toolSuccess(this.context.services.campaigns.delete(requiredString(args.id, 'id')))
      case 'campaign_policy_update': {
        const id = requiredString(args.id, 'id')
        if (!isRecord(args.policy)) throw new McpToolError('INVALID_ARGUMENT', 'policy is required')
        return toolSuccess(this.context.services.campaigns.update(id, { policy: args.policy as unknown as CampaignPolicy }))
      }
      case 'call_dial':
        return this.dial(args)
      case 'task_submit': {
        const constraints = isRecord(args.constraints) ? args.constraints : undefined
        const resultSchema = isRecord(args.result_schema) ? args.result_schema : undefined
        const campaign = isRecord(args.campaign) ? args.campaign : undefined
        return toolSuccess(this.context.services.tasks.submit({
          to: requiredString(args.to, 'to'),
          ...(optionalString(args.campaign_id) ? { campaignId: optionalString(args.campaign_id) } : {}),
          ...(campaign ? { campaign: campaign as never } : {}),
          goal: requiredString(args.goal, 'goal'),
          ...(resultSchema ? { resultSchema } : {}),
          ...(constraints ? { constraints } : {}),
          ...(optionalString(args.callback_url) ? { callbackUrl: optionalString(args.callback_url) } : {}),
          ...(isRecord(args.contact) ? { contact: args.contact } : {}),
          idempotencyKey: requiredString(args.idempotency_key, 'idempotency_key')
        }, 'mcp'))
      }
      case 'contact_card_set':
        return toolSuccess(this.context.services.contacts.upsert(contactInput(args)))
      case 'contact_card_get':
        return toolSuccess(this.context.services.contacts.get(requiredString(args.phone, 'phone')))
      case 'contact_card_list':
        return toolSuccess({ contacts: this.context.services.contacts.list({
          limit: optionalInteger(args.limit),
          offset: optionalInteger(args.offset)
        }) })
      case 'contact_card_delete':
        return toolSuccess(this.context.services.contacts.delete(requiredString(args.phone, 'phone')))
      case 'task_get':
        return toolSuccess(this.context.services.tasks.get(requiredString(args.id, 'id'), {
          include: parseTaskIncludes(args.include)
        }))
      case 'task_list':
        return toolSuccess({ tasks: this.context.services.tasks.list({
          limit: optionalInteger(args.limit),
          offset: optionalInteger(args.offset),
          ...(optionalString(args.status) ? { status: optionalString(args.status) as import('../../shared/contracts.js').CallTaskStatus } : {})
        }) })
      case 'task_wait':
        return toolSuccess(await this.context.services.tasks.wait(
          requiredString(args.id, 'id'), optionalInteger(args.timeout_ms) ?? 30_000,
          { include: parseTaskIncludes(args.include) }
        ))
      case 'task_cancel':
        return toolSuccess(this.context.services.tasks.cancel(requiredString(args.id, 'id')))
      case 'budget_get':
        return toolSuccess(this.context.services.budget.get())
      case 'budget_update':
        return toolSuccess(this.context.services.budget.save(args))
      case 'settings_general_get':
        return toolSuccess(this.context.services.settings.general.get())
      case 'settings_general_update':
        return toolSuccess(this.context.services.settings.general.save(args))
      case 'settings_voice_get': return toolSuccess(this.context.services.voice.get())
      case 'settings_openai_get': return toolSuccess(this.context.services.openai.get())
      case 'settings_openai_test': return toolSuccess(await this.context.services.openai.test())
      case 'settings_twilio_get':
        return toolSuccess(this.context.services.twilio.get())
      case 'settings_twilio_test':
        return toolSuccess(await this.context.services.twilio.test())
      case 'call_hangup':
        return toolSuccess({ status: maskStatus(await this.context.services.phone.hangup('mcp')) })
      case 'call_answer':
        return toolSuccess({ status: maskStatus(await this.context.services.phone.answer('mcp')) })
      case 'call_reject':
        return toolSuccess({ status: maskStatus(await this.context.services.phone.reject('mcp')) })
      case 'call_set_control_mode':
        if (args.mode !== 'ai' && args.mode !== 'human') throw new McpToolError('INVALID_ARGUMENT', 'mode must be ai or human')
        return toolSuccess({ status: maskStatus(await this.context.services.phone.setControlMode(args.mode, 'mcp')) })
      case 'debug_simulate_incoming':
        if (!this.context.isMock) throw new McpToolError('MOCK_ONLY', 'Simulation is only available in mock mode')
        return toolSuccess({ status: maskStatus(await this.context.services.phone.simulateIncoming(optionalString(args.peer), 'mcp')) })
      case 'settings_webhook_get':
        return toolSuccess(this.context.services.webhooks.get())
      case 'settings_webhook_update':
        return toolSuccess(this.context.services.webhooks.save(args))
      case 'settings_webhook_test':
        return toolSuccess(await this.context.services.webhooks.test())
      case 'settings_webhook_rotate_secret':
        return toolSuccess(this.context.services.webhooks.rotate())
      case 'settings_webhook_deliveries':
        return toolSuccess({ deliveries: this.context.services.webhooks.deliveries(optionalInteger(args.limit)) })
      case 'settings_mcp_get':
        return toolSuccess(this.context.services.mcp.status())
      case 'settings_mcp_update': {
        const scopes = Array.isArray(args.scopes) ? args.scopes.filter((value): value is McpScope => typeof value === 'string') : undefined
        if (scopes) this.context.services.mcp.setScopes(scopes)
        return toolSuccess(typeof args.enabled === 'boolean'
          ? await this.context.services.mcp.setEnabled(args.enabled)
          : this.context.services.mcp.status())
      }
      case 'settings_mcp_token_rotate':
        return toolSuccess(this.context.services.mcp.rotateToken())
      case 'settings_mcp_client_configs':
        return toolSuccess(this.context.services.mcp.clientConfigs())
      case 'settings_mcp_client_configs_apply':
        return toolSuccess(this.context.services.mcp.applyClientConfigs())
      case 'settings_appointments_get':
        return toolSuccess(this.context.services.appointments.get())
      case 'settings_appointments_update':
        return toolSuccess(this.context.services.appointments.save(args as AppointmentsSaveInput))
      case 'settings_crm_get':
        return toolSuccess(this.context.services.crm.get())
      case 'settings_crm_update':
        return toolSuccess(await this.context.services.crm.save(args as unknown as CrmSaveInput))
      case 'settings_crm_test':
        return toolSuccess(await this.context.services.crm.test())
      case 'settings_crm_sync_log':
        return toolSuccess({ entries: this.context.services.crm.syncLog(optionalInteger(args.limit)) })
      case 'approval_list':
        return toolSuccess({ approvals: this.context.services.approvals.listPending().map(maskApproval) })
      case 'approval_decide': {
        const id = requiredString(args.id, 'id')
        if (typeof args.approved !== 'boolean') throw new McpToolError('INVALID_ARGUMENT', 'approved is required')
        if (!this.context.services.approvals.decide({ id, approved: args.approved, decidedAt: Date.now() })) {
          throw new McpToolError('CONFLICT', 'Approval is no longer pending')
        }
        return toolSuccess({ id, approved: args.approved })
      }
    }
  }

  private async dial(args: Record<string, unknown>): Promise<CallToolResult> {
    const status = await this.context.services.phone.dial({
      peer: requiredString(args.peer, 'peer'),
      ...(optionalString(args.campaignId) ? { campaignId: optionalString(args.campaignId) } : {}),
      ...(optionalString(args.goal) ? { goal: optionalString(args.goal) } : {}),
      idempotencyKey: requiredString(args.idempotency_key, 'idempotency_key'),
      actor: 'mcp'
    })
    return toolSuccess({ status: maskStatus(status) })
  }

  private writeAudit(tool: string, scope: McpScope, args: unknown, resultCode: string): void {
    const callId = this.context.callStore.getActiveCallId()
    this.context.callStore.writeAudit('mcp.tool', callId, { tool, scope, args, resultCode }, 'mcp')
  }
}

export const TOOL_SCHEMAS = {
  phone_get_status: {},
  campaign_list: { include_ephemeral: z.boolean().optional() },
  campaign_get: { id: z.string() },
  call_list: { limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() },
  call_get: { id: z.string(), reveal_phone: z.boolean().optional() },
  call_analysis_get: { id: z.string() },
  call_audit_list: {
    id: z.string(), limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(), reveal_phone: z.boolean().optional()
  },
  appointment_list: { limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() },
  transcript_get: { id: z.string() },
  recording_get: { id: z.string() },
  campaign_create: campaignSchema(),
  campaign_update: { id: z.string(), ...partialCampaignSchema() },
  campaign_select: { id: z.string() },
  campaign_delete: { id: z.string(), confirm: z.boolean() },
  call_dial: { peer: z.string(), campaignId: z.string().optional(), goal: z.string().optional(), idempotency_key: z.string().min(1).max(200) },
  task_submit: {
    to: z.string(), campaign_id: z.string().optional(), goal: z.string(),
    campaign: z.object({
      name: z.string().min(1).max(80).optional(),
      direction: z.literal('outbound'),
      systemPrompt: z.string().max(8_000).optional(),
      voice: z.enum(REALTIME_VOICES).optional(),
      policy: z.record(z.string(), z.unknown()).optional()
    }).optional(),
    result_schema: z.record(z.string(), z.unknown()).optional(),
    constraints: z.record(z.string(), z.unknown()).optional(), callback_url: z.string().optional(),
    contact: z.record(z.string(), z.unknown()).optional(),
    idempotency_key: z.string().min(1).max(200)
  }
  ,task_get: { id: z.string(), include: z.string().optional() }
  ,task_list: { limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), status: z.enum(['queued', 'awaiting_approval', 'dialing', 'in_call', 'analyzing', 'completed', 'failed', 'cancelled']).optional() }
  ,task_wait: { id: z.string(), timeout_ms: z.number().int().min(0).max(300_000).optional(), include: z.string().optional() }
  ,task_cancel: { id: z.string() }
  ,budget_get: {}
  ,budget_update: {
    enabled: z.boolean().optional(), dailyMaxCalls: z.number().int().min(0).optional(),
    dailyMaxMinutes: z.number().min(0).optional(), allowedPrefixes: z.array(z.string()).optional(),
    allowedNumbers: z.array(z.string()).optional(), allowedHours: z.record(z.string(), z.unknown()).optional(),
    killSwitch: z.boolean().optional()
  }
  ,settings_general_get: {}
  ,settings_general_update: {
    minimizeToTray: z.boolean().optional(), launchAtLogin: z.boolean().optional(),
    startHidden: z.boolean().optional()
  }
  ,settings_voice_get: {}
  ,settings_openai_get: {}
  ,settings_openai_test: {}
  ,settings_twilio_get: {}
  ,settings_twilio_test: {}
  ,call_hangup: {}
  ,call_answer: {}
  ,call_reject: {}
  ,call_set_control_mode: { mode: z.enum(['ai', 'human']) }
  ,debug_simulate_incoming: { peer: z.string().optional() }
  ,campaign_policy_update: { id: z.string(), policy: z.record(z.string(), z.unknown()) }
  ,call_guardrails: { id: z.string() }
  ,call_appointments: { id: z.string() }
  ,settings_webhook_get: {}
  ,settings_webhook_update: { enabled: z.boolean().optional(), url: z.string().optional(), events: z.array(z.string()).optional(), secret: z.string().optional() }
  ,settings_webhook_test: {}
  ,settings_webhook_rotate_secret: {}
  ,settings_webhook_deliveries: { limit: z.number().int().min(1).max(100).optional() }
  ,settings_mcp_get: {}
  ,settings_mcp_update: { enabled: z.boolean().optional(), scopes: z.array(z.enum(['read', 'manage_campaigns', 'control_calls', 'send_messages'])).optional() }
  ,settings_mcp_token_rotate: {}
  ,settings_mcp_client_configs: {}
  ,settings_mcp_client_configs_apply: {}
  ,settings_appointments_get: {}
  ,settings_appointments_update: { provider: z.enum(['mock', 'zoho']).optional(), autoConfirm: z.boolean().optional(), timeZone: z.string().optional(), businessHours: z.record(z.string(), z.unknown()).optional() }
  ,settings_crm_get: {}
  ,settings_crm_update: { provider: z.enum(['mock', 'zoho']), dataCenter: z.string().optional(), clientId: z.string().optional(), clientSecret: z.string().optional(), grantCode: z.string().optional(), refreshToken: z.string().optional(), postCallSync: z.boolean().optional() }
  ,settings_crm_test: {}
  ,settings_crm_sync_log: { limit: z.number().int().min(1).max(100).optional() }
  ,approval_list: {}
  ,approval_decide: { id: z.string(), approved: z.boolean() }
  ,contact_card_set: {
    phone: z.string(), displayName: z.string().max(200).optional(), company: z.string().max(200).optional(),
    tier: z.string().max(100).optional(), language: z.string().max(80).optional(),
    timeZone: z.string().max(100).optional(), notes: z.string().max(2_000).optional(),
    facts: z.record(z.string(), z.unknown()).optional(), source: z.string().max(120).optional(),
    expiresAt: z.union([z.number().nonnegative(), z.string().datetime()]).optional()
  }
  ,contact_card_get: { phone: z.string() }
  ,contact_card_list: { limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() }
  ,contact_card_delete: { phone: z.string() }
} as const

export const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  phone_get_status: 'Get the current local phone status.',
  campaign_list: 'List local campaigns with phone numbers masked; ephemeral task campaigns are opt-in.',
  campaign_get: 'Get one local campaign with phone numbers masked.',
  call_list: 'List persisted calls with phone numbers masked.',
  call_get: 'Get one persisted call. Phone number reveal is explicitly opt-in and audited.',
  call_analysis_get: 'Get the latest persisted post-call analysis for one call.',
  call_audit_list: 'List sanitized audit entries for one call in chronological order.',
  appointment_list: 'List persisted appointments with phone numbers masked.',
  transcript_get: 'Get the persisted transcript for one call.',
  recording_get: 'Get recording metadata and its app playback URL, never a local path.',
  campaign_create: 'Create a local campaign.',
  campaign_update: 'Update a local campaign.',
  campaign_select: 'Select the active campaign.',
  campaign_delete: 'Delete a campaign after explicit confirmation.',
  call_dial: 'Request one locally approved outbound call.',
  task_submit: 'Submit an idempotent queued call task with a saved or inline one-time campaign.',
  task_get: 'Get one call task and its structured result.',
  task_list: 'List call tasks with phone numbers masked.',
  task_wait: 'Wait for a task terminal state or timeout.',
  task_cancel: 'Cancel a queued or active call task.',
  budget_get: 'Get the autonomous calling budget.',
  budget_update: 'Update the autonomous calling budget.',
  settings_general_get: 'Get general application and background-mode settings.',
  settings_general_update: 'Update general application and background-mode settings.',
  settings_voice_get: 'Get voice settings.',
  settings_openai_get: 'Get masked OpenAI key configuration.',
  settings_openai_test: 'Test model access without a paid session.',
  settings_twilio_get: 'Get masked effective Twilio settings. Secrets are never returned.',
  settings_twilio_test: 'Test the effective Twilio configuration without returning credentials.',
  call_hangup: 'Hang up the current call.'
  ,call_answer: 'Answer the current ringing call.'
  ,call_reject: 'Reject the current ringing call.'
  ,call_set_control_mode: 'Switch the current call between AI and human control.'
  ,debug_simulate_incoming: 'Simulate an incoming call when the app is in mock mode.'
  ,campaign_policy_update: 'Update the complete policy and copilot configuration for a campaign.'
  ,call_guardrails: 'Get persisted guardrail events for one call.'
  ,call_appointments: 'Get persisted appointments for one call.'
  ,settings_webhook_get: 'Get webhook settings.'
  ,settings_webhook_update: 'Update webhook settings.'
  ,settings_webhook_test: 'Send a test webhook.'
  ,settings_webhook_rotate_secret: 'Rotate the webhook signing secret and return it once.'
  ,settings_webhook_deliveries: 'List recent webhook deliveries.'
  ,settings_mcp_get: 'Get MCP server settings.'
  ,settings_mcp_update: 'Update MCP server settings.'
  ,settings_mcp_token_rotate: 'Rotate the local MCP and HTTP bearer token.'
  ,settings_mcp_client_configs: 'Get local MCP client configuration templates.'
  ,settings_mcp_client_configs_apply: 'Back up and merge local MCP client configuration files.'
  ,settings_appointments_get: 'Get appointment settings.'
  ,settings_appointments_update: 'Update appointment settings.'
  ,settings_crm_get: 'Get CRM settings.'
  ,settings_crm_update: 'Update CRM settings.'
  ,settings_crm_test: 'Test the configured CRM connection.'
  ,settings_crm_sync_log: 'List recent CRM synchronization attempts.'
  ,approval_list: 'List pending local approvals.'
  ,approval_decide: 'Decide a pending local approval.'
  ,contact_card_set: 'Create or update a local contact card.'
  ,contact_card_get: 'Get one non-expired local contact card.'
  ,contact_card_list: 'List non-expired local contact cards with masked phone numbers.'
  ,contact_card_delete: 'Delete one local contact card.'
}

function contactInput(args: Record<string, unknown>): ContactCardInput {
  return {
    phone: requiredString(args.phone, 'phone'),
    ...(optionalString(args.displayName) ? { displayName: optionalString(args.displayName) } : {}),
    ...(optionalString(args.company) ? { company: optionalString(args.company) } : {}),
    ...(optionalString(args.tier) ? { tier: optionalString(args.tier) } : {}),
    ...(optionalString(args.language) ? { language: optionalString(args.language) } : {}),
    ...(optionalString(args.timeZone) ? { timeZone: optionalString(args.timeZone) } : {}),
    ...(typeof args.notes === 'string' ? { notes: args.notes } : {}),
    ...(isRecord(args.facts) ? { facts: args.facts } : {}),
    ...(optionalString(args.source) ? { source: optionalString(args.source) } : {}),
    ...((typeof args.expiresAt === 'string' || typeof args.expiresAt === 'number') ? { expiresAt: args.expiresAt } : {})
  }
}

function campaignSchema() {
  return {
    name: z.string(),
    direction: z.enum(['inbound', 'outbound', 'both']),
    systemPrompt: z.string().max(8_000).optional(),
    voice: z.enum(REALTIME_VOICES),
    policy: z.record(z.string(), z.unknown()).optional(),
    inboundNumber: z.string().optional(),
    outboundCallerId: z.string().optional()
  }
}

function partialCampaignSchema() {
  const schema = campaignSchema()
  return {
    name: schema.name.optional(),
    direction: schema.direction.optional(),
    systemPrompt: schema.systemPrompt.optional(),
    voice: schema.voice.optional(),
    policy: schema.policy.optional(),
    inboundNumber: schema.inboundNumber.optional(),
    outboundCallerId: schema.outboundCallerId.optional()
  }
}

function campaignInput(args: Record<string, unknown>): CampaignInput {
  return {
    ...(optionalString(args.id) ? { id: optionalString(args.id) } : {}),
    name: requiredString(args.name, 'name'),
    direction: args.direction as CampaignInput['direction'],
    systemPrompt: optionalString(args.systemPrompt) ?? '',
    voice: args.voice as RealtimeVoice,
    ...(isRecord(args.policy) ? { policy: args.policy as unknown as CampaignPolicy } : {}),
    ...(optionalString(args.inboundNumber) ? { inboundNumber: optionalString(args.inboundNumber) } : {}),
    ...(optionalString(args.outboundCallerId) ? { outboundCallerId: optionalString(args.outboundCallerId) } : {})
  }
}

function maskCampaign(campaign: Campaign): Campaign {
  return {
    ...campaign,
    ...(campaign.inboundNumber ? { inboundNumber: maskPhoneNumber(campaign.inboundNumber) } : {}),
    ...(campaign.outboundCallerId ? { outboundCallerId: maskPhoneNumber(campaign.outboundCallerId) } : {}),
    policy: {
      ...campaign.policy,
      doNotCall: campaign.policy.doNotCall.map(maskPhoneNumber),
      blockedCallers: campaign.policy.blockedCallers.map(maskPhoneNumber)
    }
  }
}

function maskWorkspace(workspace: ReturnType<MainModuleContext['campaignStore']['getWorkspace']>) {
  return { ...workspace, campaigns: workspace.campaigns.map(maskCampaign) }
}

function maskStatus(status: PhoneStatusSnapshot): PhoneStatusSnapshot {
  return status.call ? { ...status, call: { ...status.call, peer: maskPhoneNumber(status.call.peer) } } : status
}

function redactPhoneNumbers(text: string): string {
  return text.replace(/\+[1-9]\d{6,14}/g, (phone) => maskPhoneNumber(phone))
}

function maskAuditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const output = { ...args }
  if (typeof output.peer === 'string') output.peer = maskPhoneNumber(output.peer)
  if (typeof output.phone === 'string') output.phone = maskPhoneNumber(output.phone)
  if (typeof output.inboundNumber === 'string') output.inboundNumber = maskPhoneNumber(output.inboundNumber)
  if (typeof output.outboundCallerId === 'string') output.outboundCallerId = maskPhoneNumber(output.outboundCallerId)
  if (typeof output.systemPrompt === 'string') output.systemPrompt = '[redacted]'
  for (const key of ['displayName', 'company', 'tier', 'language', 'timeZone', 'notes', 'facts']) {
    if (key in output) output[key] = '[redacted]'
  }
  if (isRecord(output.contact)) {
    const contact = { ...output.contact }
    if (typeof contact.phone === 'string') contact.phone = maskPhoneNumber(contact.phone)
    for (const key of ['displayName', 'company', 'tier', 'language', 'timeZone', 'notes', 'facts']) {
      if (key in contact) contact[key] = '[redacted]'
    }
    output.contact = contact
  }
  if (isRecord(output.campaign)) {
    output.campaign = {
      ...output.campaign,
      ...(typeof output.campaign.systemPrompt === 'string'
        ? { systemPrompt: '[redacted]' }
        : {}),
      ...(output.campaign.policy !== undefined ? { policy: '[redacted]' } : {})
    }
  }
  for (const key of ['apiKey', 'OPENAI_API_KEY', 'apiKeySecret', 'secret', 'clientSecret', 'refreshToken', 'grantCode', 'token']) {
    if (key in output) output[key] = '[redacted]'
  }
  return output
}

function maskApproval(request: import('../../shared/contracts.js').ApprovalRequest) {
  const details = { ...request.details }
  if (typeof details.peer === 'string') details.peer = maskPhoneNumber(details.peer)
  return { ...request, details }
}

function toolSuccess(value: unknown): CallToolResult {
  const structuredContent = isRecord(value) ? value : { value }
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent }
}

function toolError(code: string, message: string): CallToolResult {
  const value = { error: { code, message } }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (error instanceof McpToolError || error instanceof ServiceError) return error
  const withCode = error as { code?: unknown; message?: unknown }
  return {
    code: typeof withCode?.code === 'string' ? withCode.code : 'INTERNAL_ERROR',
    message: typeof withCode?.message === 'string' ? withCode.message : 'MCP tool failed'
  }
}

function commandError(result: Extract<PhoneCommandResult, { ok: false }>): McpToolError {
  return new McpToolError(result.code, result.message)
}

function normalizeE164(value: string): string {
  const normalized = value.replace(/[\s().-]/g, '')
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new McpToolError('INVALID_NUMBER', 'peer must be an E.164 phone number')
  return normalized
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new McpToolError('INVALID_ARGUMENT', `${field} is required`)
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function parseTaskIncludes(value: unknown): import('../../shared/contracts.js').CallTaskInclude[] | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new McpToolError('INVALID_ARGUMENT', 'include must be a comma-separated string')
  }
  const includes = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
  const invalid = includes.filter((item) => !['transcript', 'analysis', 'call'].includes(item))
  if (invalid.length) throw new McpToolError('INVALID_ARGUMENT', `Unsupported include value: ${invalid.join(', ')}`)
  return includes as import('../../shared/contracts.js').CallTaskInclude[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
