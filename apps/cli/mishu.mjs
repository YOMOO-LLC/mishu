#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'

const EXIT = Object.freeze({
  OK: 0,
  APP_UNAVAILABLE: 2,
  NETWORK: 3,
  AUTH: 4,
  API: 5,
  USAGE: 6,
  TIMEOUT: 7
})

/** Private-build userData folder name. Snapshot export rewrites the value to mishu. */
const APP_USER_DATA_DIR_NAME = 'mishu'

const TERMINAL_CALL_STATUSES = new Set([
  'ended',
  'completed',
  'failed',
  'error',
  'rejected',
  'canceled',
  'cancelled',
  'no_answer',
  'no-answer',
  'busy'
])

function invokedName(argv1 = process.argv[1]) {
  if (!argv1) return 'mishu'
  const name = basename(String(argv1)).replace(/\.(mjs|cjs|js)$/i, '')
  return name || 'mishu'
}

function helpText(name = invokedName()) {
  return `Usage: ${name} [global options] <command>

Global options:
  --endpoint <url>       Override the API endpoint (root or /v1 URL)
  --token <token>        Override the bearer token
  --pretty               Pretty-print JSON output
  -h, --help             Show this help

Commands:
  status
  call --to <e164> [--campaign <id>] [--goal <text>] [--wait] [--timeout <s>]
  calls ls [--limit <n>] [--status <status>]
  call get <id> [--transcript] [--reveal]
  call analysis <id>
  call audit <id> [--limit <n>]
  call recording <id> --out <file.webm>
  task submit --to <e164> --goal <text> [--campaign <id> | --prompt <text> | --prompt-file <file>] [--voice <voice>] [--policy <file>] [--campaign-name <name>] [--contact <file>] [--result-schema <file>] [--constraints <file>] [--wait] [--timeout <s>] [--include transcript,analysis,call]
  task get <id> [--include transcript,analysis,call]
  task ls [--limit <n>] [--status <status>]
  task wait <id> [--timeout <s>] [--include transcript,analysis,call]
  task cancel <id>
  budget get
  budget set --file <budget.json>
  contacts set [<e164>] --file <card-or-cards.json>
  contacts get <e164>
  contacts ls [--limit <n>]
  contacts rm <e164>
  hangup
  answer
  reject
  campaigns ls [--include-ephemeral]
  campaign create --file <campaign.json>
  campaign get <id>
  campaign set <id> --file <policy.json>
  campaign select <id>
  campaign rm <id>
  approvals ls
  approve <id>
  deny <id>
  appointments ls
  settings get <webhook|mcp|appointments|crm|twilio|voice|openai>
  settings set <webhook|mcp|appointments|crm|twilio|voice|openai> --file <settings.json>
  settings set twilio --from-env <path>
  settings set twilio [--file <settings.json>] --secret-stdin
                         Twilio secrets are accepted only from files or stdin, never argv
  twilio test
  openai test
  app relaunch
  webhook test
  simulate-incoming
  openapi`
}

class CliError extends Error {
  constructor(code, message, exitCode, details) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }
}

async function main(argv = process.argv.slice(2)) {
  const global = parseGlobalOptions(argv)
  if (global.help || global.args.length === 0) {
    process.stdout.write(`${helpText()}\n`)
    return
  }

  const connection = await resolveConnection(global)
  const client = createClient(connection)
  const result = await runCommand(global.args, client)
  printJson(result, global.pretty)
}

function parseGlobalOptions(argv) {
  const args = []
  let endpoint
  let token
  let pretty = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--pretty') {
      pretty = true
    } else if (argument === '--help' || argument === '-h') {
      help = true
    } else if (argument === '--endpoint' || argument === '--token') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) usage(`${argument} requires a value`)
      if (argument === '--endpoint') endpoint = value
      else token = value
      index += 1
    } else {
      args.push(argument)
    }
  }

  return { args, endpoint, token, pretty, help }
}

async function resolveConnection(options) {
  let endpoint = options.endpoint
  let token = options.token || process.env.LIVEPHONE_TOKEN
  let config

  if (!endpoint || !token) {
    const userDataPath = process.env.LIVE_PHONE_USER_DATA_PATH || defaultUserDataPath()
    const endpointPath = join(userDataPath, 'mcp', 'endpoint.json')
    try {
      config = JSON.parse(await readFile(endpointPath, 'utf8'))
      endpoint ||= config.apiEndpoint || config.endpoint
      if (!token && config.tokenPath) token = (await readFile(config.tokenPath, 'utf8')).trim()
    } catch (error) {
      throw appUnavailable(error.message)
    }
  }

  if (!endpoint || !token) throw appUnavailable('endpoint metadata is incomplete')
  return {
    endpoint: normalizeApiEndpoint(endpoint),
    token,
    discoveredLocally: !options.endpoint
  }
}

function normalizeApiEndpoint(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    usage(`Invalid endpoint URL: ${value}`)
  }
  url.search = ''
  url.hash = ''
  let pathname = url.pathname.replace(/\/+$/, '')
  if (pathname.endsWith('/mcp')) pathname = `${pathname.slice(0, -4)}/v1`
  else if (!pathname.endsWith('/v1')) pathname = `${pathname}/v1`
  url.pathname = pathname || '/v1'
  return url.toString().replace(/\/$/, '')
}

function createClient(connection) {
  return async function request(path, options = {}) {
    const url = new URL(`${connection.endpoint}/`)
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const method = options.method || 'GET'
    const headers = {
      Accept: options.response === 'buffer' ? '*/*' : 'application/json',
      Authorization: `Bearer ${connection.token}`
    }
    let body
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(options.body)
    }
    if (method !== 'GET' && method !== 'HEAD') {
      headers['Idempotency-Key'] = options.idempotencyKey || randomUUID()
    }

    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
      })
    } catch (error) {
      const causeCode = error?.cause?.code
      if (connection.discoveredLocally && ['ECONNREFUSED', 'ECONNRESET'].includes(causeCode)) {
        throw appUnavailable(error.message)
      }
      throw new CliError('NETWORK_ERROR', `Network request failed: ${error.message}`, EXIT.NETWORK)
    }

    if (!response.ok) await throwResponseError(response)
    if (options.response === 'buffer') {
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') || 'application/octet-stream'
      }
    }
    if (response.status === 204) return null
    const text = await response.text()
    return text ? parseResponseJson(text, response.status) : null
  }
}

async function throwResponseError(response) {
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = {}
  }
  const error = payload.error || {}
  if (response.status === 401) {
    throw new CliError(
      error.code || 'UNAUTHORIZED',
      'Authentication failed; the token may have rotated. Restart the command or provide the current token.',
      EXIT.AUTH,
      error.details
    )
  }
  throw new CliError(
    error.code || `HTTP_${response.status}`,
    error.message || `API request failed with HTTP ${response.status}`,
    EXIT.API,
    error.details
  )
}

function parseResponseJson(text, status) {
  try {
    return JSON.parse(text)
  } catch {
    throw new CliError('INVALID_RESPONSE', `API returned invalid JSON (HTTP ${status})`, EXIT.API)
  }
}

async function runCommand(args, request) {
  const [command, subcommand, id] = args

  if (command === 'status') {
    exactPositionals(args, 1)
    return request('status')
  }
  if (command === 'call' && subcommand === 'get') return getCall(args.slice(2), request)
  if (command === 'call' && subcommand === 'analysis') return callAnalysis(args.slice(2), request)
  if (command === 'call' && subcommand === 'audit') return callAudit(args.slice(2), request)
  if (command === 'call' && subcommand === 'recording') return downloadRecording(args.slice(2), request)
  if (command === 'call') return createCall(args.slice(1), request)
  if (command === 'calls' && subcommand === 'ls') return listCalls(args.slice(2), request)
  if (command === 'task') return taskCommand(args.slice(1), request)
  if (command === 'budget') return budgetCommand(args.slice(1), request)
  if (command === 'contacts') return contactsCommand(args.slice(1), request)
  if (['hangup', 'answer', 'reject'].includes(command)) {
    exactPositionals(args, 1)
    return request(`calls/current/${command}`, { method: 'POST', body: {} })
  }
  if (command === 'campaigns' && subcommand === 'ls') {
    const parsed = parseOptions(args.slice(2), { 'include-ephemeral': 'boolean' })
    if (parsed.positionals.length) usage('campaigns ls received unexpected arguments')
    return request('campaigns', {
      query: parsed.options['include-ephemeral'] ? { includeEphemeral: 1 } : undefined
    })
  }
  if (command === 'campaign' && subcommand === 'create') {
    const parsed = parseOptions(args.slice(2), { file: 'value' })
    if (parsed.positionals.length) usage('campaign create received unexpected arguments')
    return request('campaigns', {
      method: 'POST',
      body: await readJsonFile(requiredOption(parsed.options, 'file', 'campaign create'))
    })
  }
  if (command === 'campaign' && ['get', 'set', 'select', 'rm'].includes(subcommand)) {
    if (!id) usage(`campaign ${subcommand} requires an id`)
    if (subcommand === 'get') {
      exactPositionals(args, 3)
      return request(`campaigns/${encodeURIComponent(id)}`)
    }
    if (subcommand === 'select') {
      exactPositionals(args, 3)
      return request(`campaigns/${encodeURIComponent(id)}/select`, { method: 'POST', body: {} })
    }
    if (subcommand === 'rm') {
      exactPositionals(args, 3)
      return request(`campaigns/${encodeURIComponent(id)}`, { method: 'DELETE' })
    }
    const parsed = parseOptions(args.slice(3), { file: 'value' })
    if (parsed.positionals.length) usage('campaign set received unexpected arguments')
    const file = requiredOption(parsed.options, 'file', 'campaign set')
    return request(`campaigns/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: await readJsonFile(file)
    })
  }
  if (command === 'approvals' && subcommand === 'ls') {
    exactPositionals(args, 2)
    return request('approvals')
  }
  if (command === 'approve' || command === 'deny') {
    if (!subcommand) usage(`${command} requires an approval id`)
    exactPositionals(args, 2)
    return request(`approvals/${encodeURIComponent(subcommand)}/decide`, {
      method: 'POST',
      body: { approved: command === 'approve' }
    })
  }
  if (command === 'appointments' && subcommand === 'ls') {
    exactPositionals(args, 2)
    return request('appointments')
  }
  if (command === 'settings') return settingsCommand(args.slice(1), request)
  if (command === 'openai' && subcommand === 'test') {
    if (args.length !== 2) usage('openai test received unexpected arguments')
    return request('settings/openai/test', { method: 'POST', body: {} })
  }
  if (command === 'twilio' && subcommand === 'test') {
    exactPositionals(args, 2)
    return request('settings/twilio/test', { method: 'POST', body: {} })
  }
  if (command === 'app' && subcommand === 'relaunch') {
    exactPositionals(args, 2)
    return request('app/relaunch', { method: 'POST', body: {} })
  }
  if (command === 'webhook' && subcommand === 'test') {
    exactPositionals(args, 2)
    return request('settings/webhook/test', { method: 'POST', body: {} })
  }
  if (command === 'simulate-incoming') {
    exactPositionals(args, 1)
    return request('debug/simulate-incoming', { method: 'POST', body: {} })
  }
  if (command === 'openapi') {
    exactPositionals(args, 1)
    return request('openapi.json')
  }

  usage(`Unknown command: ${args.join(' ')}`)
}

async function createCall(args, request) {
  const parsed = parseOptions(args, {
    to: 'value',
    campaign: 'value',
    goal: 'value',
    wait: 'boolean',
    timeout: 'value'
  })
  if (parsed.positionals.length) usage('call received unexpected arguments')
  const to = requiredOption(parsed.options, 'to', 'call')
  const timeoutSeconds = parsePositiveNumber(parsed.options.timeout ?? '300', '--timeout')
  const idempotencyKey = randomUUID()
  const body = {
    to,
    ...(parsed.options.campaign ? { campaignId: parsed.options.campaign } : {}),
    ...(parsed.options.goal ? { goal: parsed.options.goal } : {}),
    idempotencyKey
  }
  const created = await request('calls', { method: 'POST', body, idempotencyKey })

  if (created?.status === 'pending_approval' || created?.approvalId) {
    return {
      ...created,
      hint: `Run mishu approve ${created.approvalId} to approve this call.`
    }
  }
  if (!parsed.options.wait) return created

  const callId = created?.callId || created?.id || created?.call?.id
  if (!callId) {
    throw new CliError('INVALID_RESPONSE', 'Call response did not include callId', EXIT.API)
  }
  return waitForCall(callId, timeoutSeconds, request)
}

async function waitForCall(callId, timeoutSeconds, request) {
  const deadline = Date.now() + timeoutSeconds * 1000
  const interval = parsePositiveNumber(process.env.LIVEPHONE_POLL_INTERVAL_MS || '1000', 'poll interval')
  let call
  while (Date.now() <= deadline) {
    call = await request(`calls/${encodeURIComponent(callId)}`)
    const status = String(call?.status || call?.call?.status || '').toLowerCase()
    if (TERMINAL_CALL_STATUSES.has(status)) {
      const transcript = await request(`calls/${encodeURIComponent(callId)}/transcript`)
      return {
        call,
        transcript,
        summary: transcript?.summary ?? call?.summary ?? call?.transcriptSummary ?? null
      }
    }
    await delay(interval)
  }
  throw new CliError('WAIT_TIMEOUT', `Call ${callId} did not finish within ${timeoutSeconds}s`, EXIT.TIMEOUT, {
    call
  })
}

async function listCalls(args, request) {
  const parsed = parseOptions(args, { limit: 'value', status: 'value' })
  if (parsed.positionals.length) usage('calls ls received unexpected arguments')
  let limit
  if (parsed.options.limit !== undefined) limit = parsePositiveInteger(parsed.options.limit, '--limit')
  return request('calls', { query: { limit, status: parsed.options.status } })
}

async function taskCommand(args, request) {
  const [action] = args
  if (action === 'submit') return submitTask(args.slice(1), request)
  if (action === 'get' || action === 'cancel' || action === 'wait') {
    const parsed = parseOptions(args.slice(1), action === 'wait'
      ? { timeout: 'value', include: 'value' }
      : action === 'get' ? { include: 'value' } : {})
    const [id, ...extra] = parsed.positionals
    if (!id || extra.length) usage(`task ${action} requires exactly one task id`)
    const include = parseInclude(parsed.options.include)
    if (action === 'get') return request(`tasks/${encodeURIComponent(id)}`, { query: { include } })
    if (action === 'cancel') return request(`tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} })
    const timeoutSeconds = parsePositiveNumber(parsed.options.timeout ?? '30', '--timeout')
    return waitForTask(id, timeoutSeconds, request, include)
  }
  if (action === 'ls') {
    const parsed = parseOptions(args.slice(1), { limit: 'value', status: 'value' })
    if (parsed.positionals.length) usage('task ls received unexpected arguments')
    return request('tasks', {
      query: {
        limit: parsed.options.limit === undefined ? undefined : parsePositiveInteger(parsed.options.limit, '--limit'),
        status: parsed.options.status
      }
    })
  }
  usage('task requires submit|get|ls|wait|cancel')
}

async function submitTask(args, request) {
  const parsed = parseOptions(args, {
    to: 'value', campaign: 'value', goal: 'value', 'result-schema': 'value', constraints: 'value',
    callback: 'value', contact: 'value', wait: 'boolean', timeout: 'value', prompt: 'value',
    'prompt-file': 'value', voice: 'value', policy: 'value', 'campaign-name': 'value',
    include: 'value'
  })
  if (parsed.positionals.length) usage('task submit received unexpected arguments')
  const include = parseInclude(parsed.options.include)
  if (include && !parsed.options.wait) usage('task submit --include requires --wait')
  const inlineOptions = ['prompt', 'prompt-file', 'voice', 'policy', 'campaign-name']
    .filter((name) => parsed.options[name] !== undefined)
  if (parsed.options.campaign && inlineOptions.length) {
    usage('task submit --campaign is mutually exclusive with inline campaign options')
  }
  if (parsed.options.prompt && parsed.options['prompt-file']) {
    usage('task submit accepts only one of --prompt and --prompt-file')
  }
  if (inlineOptions.length && !parsed.options.prompt && !parsed.options['prompt-file']) {
    usage('task submit inline campaign options require --prompt or --prompt-file')
  }
  const prompt = parsed.options.prompt !== undefined
    ? parsed.options.prompt.trim()
    : (parsed.options['prompt-file'] ? await readTextFile(parsed.options['prompt-file']) : undefined)
  if (parsed.options.prompt !== undefined && !prompt) usage('--prompt must not be empty')
  const idempotencyKey = randomUUID()
  const body = {
    to: requiredOption(parsed.options, 'to', 'task submit'),
    goal: requiredOption(parsed.options, 'goal', 'task submit'),
    ...(parsed.options.campaign ? { campaignId: parsed.options.campaign } : {}),
    ...(prompt ? {
      campaign: {
        direction: 'outbound',
        systemPrompt: prompt,
        ...(parsed.options.voice ? { voice: parsed.options.voice } : {}),
        ...(parsed.options.policy ? { policy: await readJsonFile(parsed.options.policy) } : {}),
        ...(parsed.options['campaign-name'] ? { name: parsed.options['campaign-name'] } : {})
      }
    } : {}),
    ...(parsed.options['result-schema'] ? { resultSchema: await readJsonFile(parsed.options['result-schema']) } : {}),
    ...(parsed.options.constraints ? { constraints: await readJsonFile(parsed.options.constraints) } : {}),
    ...(parsed.options.contact ? { contact: await readJsonFile(parsed.options.contact) } : {}),
    ...(parsed.options.callback ? { callbackUrl: parsed.options.callback } : {}),
    idempotencyKey,
    createdBy: 'cli'
  }
  const task = await request('tasks', { method: 'POST', body, idempotencyKey })
  if (!parsed.options.wait) return task
  const taskId = task?.taskId || task?.id
  if (!taskId) throw new CliError('INVALID_RESPONSE', 'Task response did not include taskId', EXIT.API)
  const timeoutSeconds = parsePositiveNumber(parsed.options.timeout ?? '300', '--timeout')
  return waitForTask(taskId, timeoutSeconds, request, include)
}

async function waitForTask(taskId, timeoutSeconds, request, include) {
  const deadline = Date.now() + timeoutSeconds * 1000
  const maxLongPollMs = Math.min(
    300_000,
    parsePositiveInteger(process.env.LIVEPHONE_TASK_WAIT_MAX_MS || '300000', 'task wait max')
  )
  let task
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, Math.floor(deadline - Date.now()))
    const timeoutMs = Math.min(maxLongPollMs, remainingMs)
    task = await request(`tasks/${encodeURIComponent(taskId)}/wait`, {
      query: { timeoutMs, include },
      timeoutMs: timeoutMs + 5_000
    })
    if (TERMINAL_CALL_STATUSES.has(String(task?.status || '').toLowerCase())) return task
    const remainingAfterRequest = deadline - Date.now()
    if (remainingAfterRequest > 0) await delay(Math.min(50, remainingAfterRequest))
  }
  throw new CliError(
    'WAIT_TIMEOUT',
    `Task ${taskId} did not finish within ${timeoutSeconds}s`,
    EXIT.TIMEOUT,
    { task }
  )
}

async function callAnalysis(args, request) {
  const parsed = parseOptions(args, {})
  const [id, ...extra] = parsed.positionals
  if (!id || extra.length) usage('call analysis requires exactly one call id')
  return request(`calls/${encodeURIComponent(id)}/analysis`)
}

async function callAudit(args, request) {
  const parsed = parseOptions(args, { limit: 'value' })
  const [id, ...extra] = parsed.positionals
  if (!id || extra.length) usage('call audit requires exactly one call id')
  const limit = parsed.options.limit === undefined
    ? undefined
    : parsePositiveInteger(parsed.options.limit, '--limit')
  return request(`calls/${encodeURIComponent(id)}/audit`, { query: { limit } })
}

async function contactsCommand(args, request) {
  const [action, ...rest] = args
  if (action === 'ls') {
    const parsed = parseOptions(rest, { limit: 'value' })
    if (parsed.positionals.length) usage('contacts ls received unexpected arguments')
    return request('contacts', {
      query: { limit: parsed.options.limit === undefined ? undefined : parsePositiveInteger(parsed.options.limit, '--limit') }
    })
  }
  if (action === 'get' || action === 'rm') {
    const parsed = parseOptions(rest, {})
    const [phone, ...extra] = parsed.positionals
    if (!phone || extra.length) usage(`contacts ${action} requires exactly one E.164 phone number`)
    return request(`contacts/${encodeURIComponent(phone)}`, action === 'rm' ? { method: 'DELETE' } : undefined)
  }
  if (action === 'set') {
    const parsed = parseOptions(rest, { file: 'value' })
    if (parsed.positionals.length > 1) usage('contacts set accepts at most one E.164 phone number')
    const input = await readJsonFile(requiredOption(parsed.options, 'file', 'contacts set'))
    if (Array.isArray(input) || (input && typeof input === 'object' && Array.isArray(input.contacts))) {
      if (parsed.positionals.length) usage('contacts set batch input does not accept a positional phone number')
      return request('contacts:batch', { method: 'POST', body: input })
    }
    if (!input || typeof input !== 'object') usage('contacts set file must contain a card object or card array')
    const phone = parsed.positionals[0] || input.phone
    if (typeof phone !== 'string' || !phone) usage('contacts set requires a phone in the file or as a positional argument')
    return request(`contacts/${encodeURIComponent(phone)}`, { method: 'PUT', body: input })
  }
  usage('contacts requires set|get|ls|rm')
}

async function budgetCommand(args, request) {
  const [action, ...rest] = args
  if (action === 'get') {
    if (rest.length) usage('budget get received unexpected arguments')
    return request('settings/budget')
  }
  if (action === 'set') {
    const parsed = parseOptions(rest, { file: 'value' })
    if (parsed.positionals.length) usage('budget set received unexpected arguments')
    const file = requiredOption(parsed.options, 'file', 'budget set')
    return request('settings/budget', { method: 'PUT', body: await readJsonFile(file) })
  }
  usage('budget requires get|set')
}

async function getCall(args, request) {
  const parsed = parseOptions(args, { transcript: 'boolean', reveal: 'boolean' })
  const [id, ...extra] = parsed.positionals
  if (!id || extra.length) usage('call get requires exactly one call id')
  const call = await request(`calls/${encodeURIComponent(id)}`, {
    query: parsed.options.reveal ? { reveal: true } : undefined
  })
  if (!parsed.options.transcript) return call
  const transcript = await request(`calls/${encodeURIComponent(id)}/transcript`)
  return { call, transcript }
}

async function downloadRecording(args, request) {
  const parsed = parseOptions(args, { out: 'value' })
  const [id, ...extra] = parsed.positionals
  if (!id || extra.length) usage('call recording requires exactly one call id')
  const output = requiredOption(parsed.options, 'out', 'call recording')
  const audio = await request(`calls/${encodeURIComponent(id)}/recording/audio`, { response: 'buffer' })
  const outputPath = resolve(output)
  try {
    await writeFile(outputPath, audio.bytes)
  } catch (error) {
    throw new CliError('OUTPUT_WRITE_FAILED', `Could not write ${outputPath}: ${error.message}`, EXIT.API)
  }
  return { callId: id, output: outputPath, bytes: audio.bytes.length, contentType: audio.contentType }
}

async function settingsCommand(args, request) {
  const [action, category, ...rest] = args
  const categories = new Set(['webhook', 'mcp', 'appointments', 'crm', 'twilio', 'voice', 'openai'])
  if (!['get', 'set'].includes(action) || !categories.has(category)) {
    usage('settings requires get|set and one of webhook|mcp|appointments|crm|twilio|voice|openai')
  }
  if (action === 'get') {
    if (rest.length) usage('settings get received unexpected arguments')
    return request(`settings/${category}`)
  }
  if (category === 'openai' && rest.some((arg) => arg.startsWith('--') && !['--file', '--secret-stdin'].includes(arg))) usage('OpenAI secrets require --file or --secret-stdin')
  const parsed = parseOptions(rest, { file: 'value', 'from-env': 'value', 'secret-stdin': 'boolean' })
  if (parsed.positionals.length) usage('settings set received unexpected arguments')
  if ((category !== 'twilio' && parsed.options['from-env']) || (!['twilio', 'openai'].includes(category) && parsed.options['secret-stdin'])) {
    usage('--from-env and --secret-stdin are only valid for Twilio settings')
  }
  if (parsed.options['from-env']) {
    if (parsed.options.file || parsed.options['secret-stdin']) usage('--from-env cannot be combined with --file or --secret-stdin')
    return request('settings/twilio/import', { method: 'POST', body: { path: resolve(parsed.options['from-env']) } })
  }
  if (!parsed.options.file && !parsed.options['secret-stdin']) usage('settings set requires --file or --secret-stdin')
  const body = parsed.options.file ? await readJsonFile(parsed.options.file) : {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) usage('settings set file must contain an object')
  if (parsed.options['secret-stdin']) body[category === 'openai' ? 'apiKey' : 'apiKeySecret'] = (await readStdin()).trim()
  return request(`settings/${category}`, { method: 'PUT', body })
}

function parseOptions(args, specification) {
  const options = {}
  const positionals = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    const name = argument.slice(2)
    const kind = specification[name]
    if (!kind) usage(`Unknown option: ${argument}`)
    if (kind === 'boolean') {
      options[name] = true
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) usage(`${argument} requires a value`)
    options[name] = value
    index += 1
  }
  return { options, positionals }
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new CliError('INVALID_JSON_FILE', `Could not read JSON from ${path}: ${error.message}`, EXIT.USAGE)
  }
}

async function readTextFile(path) {
  try {
    const value = (await readFile(path, 'utf8')).trim()
    if (!value) usage(`${path} must contain a non-empty prompt`)
    return value
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError('INPUT_READ_FAILED', `Could not read text from ${path}: ${error.message}`, EXIT.USAGE)
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const value = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
  if (!value.trim()) usage('stdin must contain a non-empty Twilio API Key Secret')
  return value
}

function exactPositionals(args, count) {
  if (args.length !== count) usage(`Unexpected arguments: ${args.slice(count).join(' ')}`)
}

function requiredOption(options, name, command) {
  const value = options[name]
  if (!value) usage(`${command} requires --${name}`)
  return value
}

function parsePositiveInteger(value, option) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) usage(`${option} must be a positive integer`)
  return parsed
}

function parseInclude(value) {
  if (value === undefined) return undefined
  const includes = [...new Set(String(value).split(',').map((item) => item.trim()).filter(Boolean))]
  if (!includes.length || includes.some((item) => !['transcript', 'analysis', 'call'].includes(item))) {
    usage('--include must be a comma-separated list of transcript,analysis,call')
  }
  return includes.join(',')
}

function parsePositiveNumber(value, option) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) usage(`${option} must be a positive number`)
  return parsed
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function defaultUserDataPath() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', APP_USER_DATA_DIR_NAME)
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), APP_USER_DATA_DIR_NAME)
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), APP_USER_DATA_DIR_NAME)
}

function appUnavailable(details) {
  return new CliError(
    'APP_UNAVAILABLE',
    'Start the desktop App and enable MCP/API in Settings.',
    EXIT.APP_UNAVAILABLE,
    { reason: details }
  )
}

function usage(message) {
  throw new CliError('USAGE', `${message}. Run mishu --help for usage.`, EXIT.USAGE)
}

function printJson(value, pretty) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`)
}

function printError(error) {
  const cliError = error instanceof CliError
    ? error
    : new CliError('INTERNAL_ERROR', error?.message || String(error), EXIT.API)
  const payload = {
    error: {
      code: cliError.code,
      message: cliError.message,
      ...(cliError.details !== undefined ? { details: cliError.details } : {})
    }
  }
  process.stderr.write(`${JSON.stringify(payload)}\n`)
  process.exitCode = cliError.exitCode
}

main().catch(printError)
