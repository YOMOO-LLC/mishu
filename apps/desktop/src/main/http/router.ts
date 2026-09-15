import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { maskPhoneNumber } from '../../shared/phone-mask.js'
import type { EngineContext } from '../engine-context.js'
import { asServiceError, ServiceError } from '../services/service-error.js'
import { buildOpenApiDocument } from './openapi.js'
import {
  ApprovalDecisionSchema,
  AuditQuerySchema,
  AppointmentSettingsSchema,
  BudgetSettingsSchema,
  CampaignListQuerySchema,
  CampaignInputSchema,
  CampaignUpdateSchema,
  ContactBatchSchema,
  ContactCardUpdateSchema,
  CrmSettingsSchema,
  ControlModeSchema,
  CallLifecycleSchema,
  DialSchema,
  GuardrailEventSchema,
  GeneralSettingsSchema,
  ListQuerySchema,
  McpSettingsSchema,
  RealtimeStartSchema,
  RecordingChunkSchema,
  RecordingFinishSchema,
  RecordingStartSchema,
  RevealQuerySchema,
  SimulateIncomingSchema,
  TextSchema,
  TaskListQuerySchema,
  TaskGetQuerySchema,
  TaskSubmitSchema,
  TaskWaitQuerySchema,
  TranscriptEntrySchema,
  TwilioImportSchema,
  TwilioSettingsSchema,
  WebhookSettingsSchema,
  API_ROUTES
} from './routes/definitions.js'

const MAX_BODY_BYTES = 1_048_576
const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE'])

interface CachedResponse {
  status: number
  body: unknown
}

export class HttpApiRouter {
  private readonly idempotency = new Map<string, Promise<CachedResponse>>()

  constructor(private readonly context: EngineContext) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/v1/')) return false
    const method = request.method ?? 'GET'
    const route = auditRoute(method, url.pathname)
    let statusCode = 500
    let auditParams: unknown = url.pathname.startsWith('/v1/settings/openai') ? {} : maskSensitive(queryObject(url))
    try {
      let body: unknown = undefined
      if (WRITE_METHODS.has(method)) {
        body = await readOptionalJson(request)
        auditParams = url.pathname.startsWith('/v1/settings/openai') ? {} : maskSensitive(body)
      }
      const idempotencyKey = stringHeader(request.headers['idempotency-key'])
        ?? (isRecord(body) && typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined)
      if (idempotencyKey && isRecord(body) && ['/v1/tasks', '/v1/calls'].includes(url.pathname)) body = { ...body, idempotencyKey }
      if (WRITE_METHODS.has(method) && idempotencyKey) {
        const cacheKey = `${method}:${url.pathname}:${idempotencyKey}`
        const existing = this.idempotency.get(cacheKey)
        if (existing) {
          const cached = await existing
          statusCode = cached.status
          sendJson(response, cached.status, cached.body)
          return true
        }
        const pending = this.dispatch(method, url, body)
        this.idempotency.set(cacheKey, pending)
        const result = await pending
        statusCode = result.status
        sendJson(response, result.status, result.body)
        return true
      }
      const result = await this.dispatch(method, url, body)
      statusCode = result.status
      if (isAudioResponse(result.body)) {
        response.statusCode = result.status
        response.setHeader('content-type', result.body.mime)
        response.setHeader('content-length', String(result.body.bytes))
        result.body.stream.pipe(response)
      } else {
        sendJson(response, result.status, result.body)
      }
      return true
    } catch (error) {
      const result = errorResponse(error)
      statusCode = result.status
      sendJson(response, result.status, result.body)
      return true
    } finally {
      this.context.services.auditHttp(route, statusCode, auditParams)
    }
  }

  private async dispatch(method: string, url: URL, rawBody: unknown): Promise<CachedResponse> {
    const { pathname } = url
    const reveal = url.searchParams.get('reveal') === 'true'
    if (method === 'GET' && pathname === '/v1/health') return ok({ status: 'ok' })
    if (method === 'GET' && pathname === '/v1/status') {
      return ok({ phone: maskStatus(this.context.services.phone.status()), mcp: this.context.services.mcp.status() })
    }
    if (method === 'GET' && pathname === '/v1/runtime') {
      const { twilioToken: _secret, ...config } = await this.context.services.runtime.getConfig()
      return ok(config)
    }
    if (method === 'POST' && pathname === '/v1/realtime/sessions') return { status: 202, body: await this.context.services.realtime.start(RealtimeStartSchema.parse(rawBody)) }
    if (method === 'POST' && pathname === '/v1/realtime/sessions/current/speech') {
      await this.context.services.realtime.appendSpeech(TextSchema.parse(rawBody).text)
      return { status: 202, body: { accepted: true } }
    }
    if (method === 'POST' && pathname === '/v1/realtime/sessions/current/text') {
      await this.context.services.realtime.appendText(TextSchema.parse(rawBody).text)
      return { status: 202, body: { accepted: true } }
    }
    if (method === 'POST' && pathname === '/v1/realtime/sessions/current/stop') {
      await this.context.services.realtime.stop()
      return { status: 202, body: { accepted: true } }
    }
    if (method === 'POST' && pathname === '/v1/events/call-lifecycle') {
      this.context.services.reportCall(CallLifecycleSchema.parse(rawBody) as never)
      return { status: 202, body: { accepted: true } }
    }
    if (method === 'POST' && pathname === '/v1/events/transcript') {
      this.context.services.reportTranscript(TranscriptEntrySchema.parse(rawBody))
      return { status: 202, body: { accepted: true } }
    }
    if (method === 'POST' && pathname === '/v1/events/guardrail') {
      this.context.services.reportGuardrail(GuardrailEventSchema.parse(rawBody))
      return { status: 202, body: { accepted: true } }
    }
    if (method === 'POST' && pathname === '/v1/recordings/start') {
      this.context.services.recordings.start(RecordingStartSchema.parse(rawBody))
      return { status: 202, body: { accepted: true } }
    }
    if (method === 'POST' && pathname === '/v1/recordings/chunk') {
      const input = RecordingChunkSchema.parse(rawBody)
      this.context.services.recordings.chunk({ callId: input.callId, seq: input.seq, data: Uint8Array.from(Buffer.from(input.dataBase64, 'base64')) })
      return { status: 202, body: { accepted: true } }
    }
    if (method === 'POST' && pathname === '/v1/recordings/finish') {
      this.context.services.recordings.finish(RecordingFinishSchema.parse(rawBody))
      return { status: 202, body: { accepted: true } }
    }
    if (method === 'GET' && pathname === '/v1/openapi.json') return ok(buildOpenApiDocument())

    if (pathname === '/v1/campaigns' && method === 'GET') {
      const query = CampaignListQuerySchema.parse(queryObject(url))
      const options = { reveal, includeEphemeral: query.includeEphemeral === '1' }
      return ok({
        selectedCampaignId: this.context.services.campaigns.workspace(options).selectedCampaignId,
        campaigns: this.context.services.campaigns.list(options)
      })
    }
    if (pathname === '/v1/campaigns' && method === 'POST') {
      return { status: 201, body: this.context.services.campaigns.create(CampaignInputSchema.parse(rawBody) as never, { reveal }) }
    }
    let match = /^\/v1\/campaigns\/([^/]+)$/.exec(pathname)
    if (match) {
      const id = decodeURIComponent(match[1] as string)
      if (method === 'GET') return ok(this.context.services.campaigns.get(id, { reveal }))
      if (method === 'PUT') return ok(this.context.services.campaigns.update(id, CampaignUpdateSchema.parse(rawBody) as never, { reveal }))
      if (method === 'DELETE') return ok(this.context.services.campaigns.delete(id, { reveal }))
    }
    match = /^\/v1\/campaigns\/([^/]+)\/select$/.exec(pathname)
    if (match && method === 'POST') return ok(this.context.services.campaigns.select(decodeURIComponent(match[1] as string), { reveal }))

    if (pathname === '/v1/calls' && method === 'POST') {
      const input = DialSchema.parse(rawBody)
      const pending = this.context.services.phone.startDial({
        peer: input.peer,
        ...(input.campaignId ? { campaignId: input.campaignId } : {}),
        ...(input.goal ? { goal: input.goal } : {}),
        idempotencyKey: input.idempotencyKey ?? `http-${Date.now()}-${Math.random()}`,
        actor: 'http'
      })
      void pending.completion.catch(() => undefined)
      return { status: 202, body: { approvalId: pending.approvalId } }
    }
    if (pathname === '/v1/tasks' && method === 'POST') {
      const input = TaskSubmitSchema.parse(rawBody)
      if (!input.idempotencyKey) throw new ServiceError('INVALID_ARGUMENT', 'idempotencyKey is required')
      const createdBy = input.createdBy === 'cli' ? 'cli' : 'http'
      const task = this.context.services.tasks.submit(
        { ...input, idempotencyKey: input.idempotencyKey } as never,
        createdBy
      )
      return { status: 202, body: { taskId: task.id, status: task.status } }
    }
    if (pathname === '/v1/tasks' && method === 'GET') {
      const query = TaskListQuerySchema.parse(queryObject(url))
      return ok({ tasks: this.context.services.tasks.list(query) })
    }
    match = /^\/v1\/tasks\/([^/]+)$/.exec(pathname)
    if (match && method === 'GET') {
      const query = TaskGetQuerySchema.parse(queryObject(url))
      return ok(this.context.services.tasks.get(decodeURIComponent(match[1] as string), {
        include: parseTaskIncludes(query.include)
      }))
    }
    match = /^\/v1\/tasks\/([^/]+)\/wait$/.exec(pathname)
    if (match && method === 'GET') {
      const query = TaskWaitQuerySchema.parse(queryObject(url))
      return ok(await this.context.services.tasks.wait(
        decodeURIComponent(match[1] as string), query.timeoutMs ?? 30_000,
        { include: parseTaskIncludes(query.include) }
      ))
    }
    match = /^\/v1\/tasks\/([^/]+)\/cancel$/.exec(pathname)
    if (match && method === 'POST') {
      return { status: 202, body: this.context.services.tasks.cancel(decodeURIComponent(match[1] as string)) }
    }
    if (pathname === '/v1/contacts' && method === 'GET') {
      const query = ListQuerySchema.parse(queryObject(url))
      return ok({ contacts: this.context.services.contacts.list({ limit: query.limit, offset: query.offset }) })
    }
    if (pathname === '/v1/contacts:batch' && method === 'POST') {
      const input = ContactBatchSchema.parse(rawBody)
      return ok({ contacts: this.context.services.contacts.upsertMany(Array.isArray(input) ? input : input.contacts) })
    }
    match = /^\/v1\/contacts\/([^/]+)$/.exec(pathname)
    if (match) {
      const phone = decodeURIComponent(match[1] as string)
      if (method === 'GET') return ok(this.context.services.contacts.get(phone))
      if (method === 'PUT') {
        const input = ContactCardUpdateSchema.parse(rawBody)
        return ok(this.context.services.contacts.upsert({ ...input, phone }))
      }
      if (method === 'DELETE') return ok(this.context.services.contacts.delete(phone))
    }
    if (pathname === '/v1/calls' && method === 'GET') {
      const query = ListQuerySchema.parse(queryObject(url))
      return ok({ calls: this.context.services.calls.list({ limit: query.limit, offset: query.offset }, { reveal }) })
    }
    if (pathname === '/v1/calls/current/hangup' && method === 'POST') return accepted(this.context.services.phone.hangup('http'))
    if (pathname === '/v1/calls/current/answer' && method === 'POST') return accepted(this.context.services.phone.answer('http'))
    if (pathname === '/v1/calls/current/reject' && method === 'POST') return accepted(this.context.services.phone.reject('http'))
    if (pathname === '/v1/calls/current/control-mode' && method === 'POST') {
      const input = ControlModeSchema.parse(rawBody)
      return accepted(this.context.services.phone.setControlMode(input.mode, 'http'))
    }

    match = /^\/v1\/calls\/([^/]+)$/.exec(pathname)
    if (match && method === 'GET') return ok(this.context.services.calls.get(decodeURIComponent(match[1] as string), { reveal }))
    match = /^\/v1\/calls\/([^/]+)\/(transcript|recording|guardrails|appointments)$/.exec(pathname)
    if (match && method === 'GET') {
      const id = decodeURIComponent(match[1] as string)
      if (match[2] === 'transcript') return ok({ transcript: this.context.services.calls.transcript(id, { reveal }) })
      if (match[2] === 'recording') return ok(this.context.services.calls.recording(id))
      if (match[2] === 'guardrails') return ok({ guardrails: this.context.services.calls.guardrails(id) })
      return ok({ appointments: this.context.services.calls.callAppointments(id, { reveal }) })
    }
    match = /^\/v1\/calls\/([^/]+)\/analysis$/.exec(pathname)
    if (match && method === 'GET') return ok(this.context.services.calls.analysis(decodeURIComponent(match[1] as string)))
    match = /^\/v1\/calls\/([^/]+)\/audit$/.exec(pathname)
    if (match && method === 'GET') {
      const query = AuditQuerySchema.parse(queryObject(url))
      return ok({ audit: this.context.services.calls.audit(
        decodeURIComponent(match[1] as string),
        { limit: query.limit, offset: query.offset },
        { reveal }
      ) })
    }
    match = /^\/v1\/calls\/([^/]+)\/recording\/audio$/.exec(pathname)
    if (match && method === 'GET') return ok(this.context.services.calls.recordingAudio(decodeURIComponent(match[1] as string)))

    if (pathname === '/v1/appointments' && method === 'GET') {
      const query = ListQuerySchema.parse(queryObject(url))
      return ok({ appointments: this.context.services.calls.listAppointments({ limit: query.limit, offset: query.offset }, { reveal }) })
    }

    if (pathname === '/v1/settings/webhook' && method === 'GET') return ok(this.context.services.webhooks.get())
    if (pathname === '/v1/settings/budget' && method === 'GET') return ok(this.context.services.budget.get())
    if (pathname === '/v1/settings/budget' && method === 'PUT') return ok(this.context.services.budget.save(BudgetSettingsSchema.parse(rawBody)))
    if (pathname === '/v1/settings/voice' && method === 'GET') return ok(this.context.services.voice.get())
    if (pathname === '/v1/settings/voice' && method === 'PUT') return ok(this.context.services.voice.save(rawBody as never))
    if (pathname === '/v1/settings/openai' && method === 'GET') return ok(this.context.services.openai.get())
    if (pathname === '/v1/settings/openai' && method === 'PUT') return ok(this.context.services.openai.save(rawBody as never))
    if (pathname === '/v1/settings/openai/test' && method === 'POST') return ok(await this.context.services.openai.test())
    if (pathname === '/v1/settings/general' && method === 'GET') return ok(this.context.services.settings.general.get())
    if (pathname === '/v1/settings/general' && method === 'PUT') return ok(this.context.services.settings.general.save(GeneralSettingsSchema.parse(rawBody)))
    if (pathname === '/v1/settings/twilio' && method === 'GET') return ok(this.context.services.twilio.get())
    if (pathname === '/v1/settings/twilio' && method === 'PUT') return ok(this.context.services.twilio.save(TwilioSettingsSchema.parse(rawBody)))
    if (pathname === '/v1/settings/twilio/test' && method === 'POST') return ok(await this.context.services.twilio.test())
    if (pathname === '/v1/settings/twilio/import' && method === 'POST') {
      return ok(this.context.services.twilio.importEnv(TwilioImportSchema.parse(rawBody).path))
    }
    if (pathname === '/v1/app/relaunch' && method === 'POST') return ok(this.context.services.twilio.relaunch())
    if (pathname === '/v1/settings/webhook' && method === 'PUT') return ok(this.context.services.webhooks.save(WebhookSettingsSchema.parse(rawBody)))
    if (pathname === '/v1/settings/webhook/test' && method === 'POST') return { status: 202, body: await this.context.services.webhooks.test() }
    if (pathname === '/v1/settings/webhook/secret/rotate' && method === 'POST') return ok(this.context.services.webhooks.rotate())
    if (pathname === '/v1/settings/webhook/deliveries' && method === 'GET') {
      const query = ListQuerySchema.parse(queryObject(url))
      return ok({ deliveries: this.context.services.webhooks.deliveries(query.limit) })
    }
    if (pathname === '/v1/settings/mcp' && method === 'GET') return ok(this.context.services.mcp.status())
    if (pathname === '/v1/settings/mcp' && method === 'PUT') {
      const input = McpSettingsSchema.parse(rawBody)
      if (input.scopes) this.context.services.mcp.setScopes(input.scopes)
      return ok(input.enabled === undefined ? this.context.services.mcp.status() : await this.context.services.mcp.setEnabled(input.enabled))
    }
    if (pathname === '/v1/settings/mcp/token/rotate' && method === 'POST') return ok(this.context.services.mcp.rotateToken())
    if (pathname === '/v1/settings/mcp/client-configs' && method === 'GET') return ok(this.context.services.mcp.clientConfigs())
    if (pathname === '/v1/settings/mcp/client-configs/apply' && method === 'POST') return ok(this.context.services.mcp.applyClientConfigs())
    if (pathname === '/v1/settings/appointments' && method === 'GET') return ok(this.context.services.appointments.get())
    if (pathname === '/v1/settings/appointments' && method === 'PUT') return ok(this.context.services.appointments.save(AppointmentSettingsSchema.parse(rawBody)))
    if (pathname === '/v1/settings/crm' && method === 'GET') return ok(this.context.services.crm.get())
    if (pathname === '/v1/settings/crm' && method === 'PUT') return ok(await this.context.services.crm.save(CrmSettingsSchema.parse(rawBody)))
    if (pathname === '/v1/settings/crm/test' && method === 'POST') return ok(await this.context.services.crm.test())
    if (pathname === '/v1/settings/crm/sync-log' && method === 'GET') {
      const query = ListQuerySchema.parse(queryObject(url))
      return ok({ entries: this.context.services.crm.syncLog(query.limit) })
    }

    if (pathname === '/v1/approvals' && method === 'GET') return ok({ approvals: this.context.services.approvals.listPending() })
    match = /^\/v1\/approvals\/([^/]+)\/decide$/.exec(pathname)
    if (match && method === 'POST') {
      const input = ApprovalDecisionSchema.parse(rawBody)
      const id = decodeURIComponent(match[1] as string)
      if (!this.context.services.approvals.decide({ id, approved: input.approved, decidedAt: Date.now() })) {
        throw new ServiceError('CONFLICT', 'Approval is no longer pending')
      }
      return ok({ id, approved: input.approved })
    }
    if (pathname === '/v1/debug/simulate-incoming' && method === 'POST') {
      if (!this.context.isMock) throw new ServiceError('MOCK_ONLY', 'Simulation is only available in mock mode')
      const input = SimulateIncomingSchema.parse(rawBody ?? {})
      return { status: 202, body: { status: await this.context.services.phone.simulateIncoming(input.peer, 'http') } }
    }
    if (API_ROUTES.some((route) => routePathMatches(route.path, pathname))) {
      throw new ServiceError('METHOD_NOT_ALLOWED', 'Method not allowed')
    }
    throw new ServiceError('NOT_FOUND', 'Route not found')
  }
}

function ok(body: unknown): CachedResponse { return { status: 200, body } }
async function accepted(promise: Promise<unknown>): Promise<CachedResponse> { return { status: 202, body: { status: await promise } } }

async function readOptionalJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new ServiceError('INVALID_ARGUMENT', 'Request body is too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new ServiceError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
}

function errorResponse(error: unknown): CachedResponse {
  if (error instanceof z.ZodError) return { status: 422, body: { error: { code: 'UNPROCESSABLE_ENTITY', message: 'Request validation failed', details: error.issues } } }
  const service = asServiceError(error)
  const status = ({
    INVALID_ARGUMENT: 400, INVALID_NUMBER: 422, UNPROCESSABLE_ENTITY: 422,
    NOT_FOUND: 404, CONFLICT: 409, CALL_IN_PROGRESS: 409, NO_ACTIVE_CALL: 409,
    APPROVAL_DENIED: 409, APPROVAL_TIMEOUT: 409, RATE_LIMITED: 429,
    SCOPE_DENIED: 403, MOCK_ONLY: 403, METHOD_NOT_ALLOWED: 405, APP_NOT_READY: 503
  } as Record<string, number>)[service.code] ?? 500
  return { status, body: { error: { code: service.code, message: service.message, ...(service.details === undefined ? {} : { details: service.details }) } } }
}

function queryObject(url: URL): Record<string, string> { return Object.fromEntries(url.searchParams) }
function parseTaskIncludes(value?: string): import('../../shared/contracts.js').CallTaskInclude[] | undefined {
  return value
    ? [...new Set(value.split(','))] as import('../../shared/contracts.js').CallTaskInclude[]
    : undefined
}
function auditRoute(method: string, pathname: string): string {
  return /^\/v1\/contacts\/[^/]+$/.test(pathname)
    ? `${method} /v1/contacts/{phone}`
    : `${method} ${pathname}`
}
function stringHeader(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isAudioResponse(value: unknown): value is import('../services/call-service.js').RecordingAudio {
  return isRecord(value) && typeof value.mime === 'string' && typeof value.bytes === 'number' && isRecord(value.stream)
}
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

function maskSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSensitive)
  if (!isRecord(value)) return value
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (/apiKey|authorization|secret|token|systemPrompt|displayName|company|tier|language|timeZone|notes|facts/i.test(key)) output[key] = '[redacted]'
    else if ((key === 'doNotCall' || key === 'blockedCallers') && Array.isArray(item)) {
      output[key] = item.map((entry) => typeof entry === 'string' ? maskPhoneNumber(entry) : maskSensitive(entry))
    }
    else if (/peer|phone|inboundNumber|outboundCallerId/i.test(key) && typeof item === 'string') output[key] = maskPhoneNumber(item)
    else output[key] = maskSensitive(item)
  }
  return output
}

function maskStatus(status: import('../../shared/contracts.js').PhoneStatusSnapshot): import('../../shared/contracts.js').PhoneStatusSnapshot {
  return status.call ? { ...status, call: { ...status.call, peer: maskPhoneNumber(status.call.peer) } } : status
}

function routePathMatches(template: string, pathname: string): boolean {
  const segments = template.split('/').map((segment) => segment.startsWith('{') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${segments.join('/')}$`).test(pathname)
}
