import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startCloudHost, type CloudHost } from '../../apps/cloud/src/host.js'

export const QUICKSTART_PEER = '+15555550100'

const TERMINAL_TASK = new Set(['completed', 'failed', 'cancelled'])
const TERMINAL_CALL = new Set(['ended', 'error'])

export interface QuickstartOptions {
  baseUrl: string
  token: string
  peer?: string
  /** When true (default for a host this script started), empty the budget allowlists so the dial requires Owner approval. */
  requireApproval?: boolean
}

export interface QuickstartResult {
  campaignId: string
  approvalId: string
  taskId: string
  callId: string | undefined
  taskStatus: string
  callStatus: string | undefined
  transcript: unknown[]
}

interface Campaign {
  id: string
  name: string
}

interface Task {
  id?: string
  taskId?: string
  status: string
  callId?: string
  transcript?: unknown[]
  call?: { id: string; status: string }
}

export async function runQuickstart(options: QuickstartOptions): Promise<QuickstartResult> {
  const peer = options.peer ?? QUICKSTART_PEER
  const api = bindApi(options.baseUrl, options.token)
  const name = `Quickstart ${randomUUID().slice(0, 8)}`

  const created = await api<{ campaigns: Campaign[] }>('/campaigns?reveal=true', {
    method: 'POST',
    body: JSON.stringify({
      name,
      direction: 'outbound',
      voice: 'sol',
      systemPrompt: 'You are an AI assistant. Disclose that you are an AI on the first turn and help the caller.'
    })
  })
  const campaign = created.body.campaigns.find((item) => item.name === name)
  if (!campaign) throw new Error('Campaign create did not return the new campaign')
  await api(`/campaigns/${campaign.id}/select`, { method: 'POST', body: '{}' })

  if (options.requireApproval !== false) {
    await api('/settings/budget', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: true,
        dailyMaxCalls: 100,
        dailyMaxMinutes: 1_000,
        allowedPrefixes: [],
        allowedNumbers: [],
        allowedHours: { timeZone: 'UTC', windows: [] },
        killSwitch: false
      })
    })
  }

  const submitted = await api<{ taskId: string; status: string }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      to: peer,
      campaignId: campaign.id,
      goal: 'Confirm the mock appointment and then end the call.',
      idempotencyKey: `quickstart-${randomUUID()}`
    })
  })
  const taskId = submitted.body.taskId

  const awaiting = await poll(
    () => api<Task>(`/tasks/${taskId}`),
    (result) => result.body.status === 'awaiting_approval' || TERMINAL_TASK.has(result.body.status),
    'task awaiting approval or terminal'
  )
  if (TERMINAL_TASK.has(awaiting.body.status) && awaiting.body.status !== 'awaiting_approval') {
    throw new Error(`Task ${taskId} reached ${awaiting.body.status} before approval`)
  }

  const pending = await api<{ approvals: Array<{ id: string; kind: string }> }>('/approvals')
  const approval = pending.body.approvals.find((item) => item.kind === 'call_dial')
  if (!approval) throw new Error('No pending call_dial approval')
  await api(`/approvals/${approval.id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ approved: true })
  })

  const finished = await api<Task>(`/tasks/${taskId}/wait?timeoutMs=25000&include=transcript,analysis,call`)
  if (!TERMINAL_TASK.has(finished.body.status)) {
    throw new Error(`Task ${taskId} did not reach a terminal status (${finished.body.status})`)
  }

  const callId = finished.body.callId ?? finished.body.call?.id
  let callStatus = finished.body.call?.status
  let transcript = Array.isArray(finished.body.transcript) ? finished.body.transcript : []
  if (callId) {
    const call = await poll(
      () => api<{ id: string; status: string }>(`/calls/${callId}`),
      (result) => TERMINAL_CALL.has(result.body.status),
      `call ${callId} terminal`,
      { timeoutMs: 25_000 }
    )
    callStatus = call.body.status
    const lines = await api<{ transcript: unknown[] }>(`/calls/${callId}/transcript?reveal=true`)
    if (Array.isArray(lines.body.transcript)) transcript = lines.body.transcript
  }

  return {
    campaignId: campaign.id,
    approvalId: approval.id,
    taskId,
    callId,
    taskStatus: finished.body.status,
    callStatus,
    transcript
  }
}

export async function startQuickstartHost(): Promise<CloudHost> {
  return startCloudHost({ port: 0 })
}

interface ApiResult<T> {
  status: number
  body: T
}

function bindApi(baseUrl: string, token: string) {
  let writes = 0
  return async function api<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    if (method !== 'GET') {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json')
      if (!headers.has('idempotency-key')) headers.set('idempotency-key', `quickstart-${writes++}`)
    }
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers })
    const raw = await response.text()
    let body: T
    try {
      body = raw ? (JSON.parse(raw) as T) : ({} as T)
    } catch {
      throw new Error(`${method} ${path} returned non-JSON (${response.status}): ${raw.slice(0, 200)}`)
    }
    if (!response.ok) {
      throw new Error(`${method} ${path} failed (${response.status}): ${raw.slice(0, 500)}`)
    }
    return { status: response.status, body }
  }
}

async function poll<T>(
  read: () => Promise<T>,
  match: (value: T) => boolean,
  label: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await read()
    if (match(last)) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last)}`)
}

async function main(): Promise<void> {
  const baseUrl = process.env.MISHU_BASE_URL
  const tokenFile = process.env.MISHU_TOKEN_FILE
  let host: CloudHost | undefined
  let token: string
  let url: string

  if (baseUrl && tokenFile) {
    url = baseUrl.replace(/\/$/, '')
    token = readFileSync(tokenFile, 'utf8').trim()
  } else {
    host = await startQuickstartHost()
    url = host.ready.baseUrl
    token = readFileSync(host.ready.tokenFile, 'utf8').trim()
  }

  try {
    const result = await runQuickstart({
      baseUrl: url,
      token,
      peer: QUICKSTART_PEER,
      requireApproval: true
    })
    process.stdout.write(`${JSON.stringify({
      campaignId: result.campaignId,
      taskId: result.taskId,
      taskStatus: result.taskStatus,
      callId: result.callId,
      callStatus: result.callStatus,
      transcript: result.transcript
    }, null, 2)}\n`)
  } finally {
    await host?.stop()
  }
}

const thisFile = fileURLToPath(import.meta.url)
const entry = process.argv[1] ? resolve(process.argv[1]) : ''
if (entry && thisFile === entry) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
