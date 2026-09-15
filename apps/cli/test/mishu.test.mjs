import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const cliPath = resolve(fileURLToPath(new URL('../mishu.mjs', import.meta.url)))
const TOKEN = 'test-token'

function runCli(args, env = {}) {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      timeout: 10_000
    }, (error, stdout, stderr) => {
      resolveRun({ code: error?.code ?? 0, stdout, stderr })
    })
  })
}

async function startServer(t, responder) {
  const requests = []
  const errors = []
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const captured = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: rawBody ? JSON.parse(rawBody) : undefined
      }
      requests.push(captured)
      const result = await responder(captured, requests.length - 1)
      response.writeHead(result?.status ?? 200, result?.headers ?? { 'content-type': 'application/json' })
      const body = result?.body ?? { ok: true }
      response.end(Buffer.isBuffer(body) ? body : JSON.stringify(body))
    } catch (error) {
      errors.push(error)
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'FAKE_SERVER_ERROR', message: error.message } }))
    }
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)))
  const address = server.address()
  return { endpoint: `http://127.0.0.1:${address.port}`, requests, errors }
}

async function successfulCommand(t, args, expected) {
  const fake = await startServer(t, (request) => {
    assert.equal(request.method, expected.method ?? 'GET')
    assert.equal(request.url, expected.url)
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`)
    if (expected.body !== undefined) assert.deepEqual(request.body, expected.body)
    if (expected.write) {
      assert.match(request.headers['idempotency-key'], /^[0-9a-f-]{36}$/)
    }
    return { body: expected.response ?? { ok: true, route: request.url } }
  })
  const result = await runCli([...args, '--endpoint', fake.endpoint, '--token', TOKEN])
  assert.equal(result.code, 0, result.stderr)
  if (fake.errors.length) throw fake.errors[0]
  assert.deepEqual(JSON.parse(result.stdout), expected.output ?? expected.response ?? { ok: true, route: expected.url })
  assert.equal(fake.requests.length, 1)
}

test('--help lists the complete command surface', async () => {
  const result = await runCli(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^Usage: mishu /)
  for (const command of [
    'status', 'call --to', 'calls ls', 'call get', 'call recording', 'hangup', 'answer', 'reject',
    'campaigns ls', 'campaign create', 'campaign get', 'campaign set', 'campaign select',
    'campaign rm', 'approvals ls', 'approve',
    'deny', 'appointments ls', 'settings get', 'settings set', 'webhook test', 'simulate-incoming',
    'task submit', 'task get', 'task ls', 'task wait', 'task cancel', 'budget get', 'budget set',
    'contacts set', 'contacts get', 'contacts ls', 'contacts rm', 'twilio test', 'app relaunch',
    'openapi'
  ]) assert.match(result.stdout, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('global endpoint and token overrides select /v1 and set authorization', async (t) => {
  await successfulCommand(t, ['status'], { url: '/v1/status' })
})

test('Twilio settings get, file set, env import, test, and relaunch map to safe routes', async (t) => {
  await successfulCommand(t, ['settings', 'get', 'twilio'], { url: '/v1/settings/twilio' })
  const directory = await mkdtemp(join(tmpdir(), 'mishu-twilio-'))
  const file = join(directory, 'twilio.json')
  await writeFile(file, JSON.stringify({ apiKeySecret: 'file-only-secret', mode: 'auto' }))
  await successfulCommand(t, ['settings', 'set', 'twilio', '--file', file], {
    method: 'PUT', url: '/v1/settings/twilio', body: { apiKeySecret: 'file-only-secret', mode: 'auto' }, write: true,
    response: { configured: true, apiKeySecret: { configured: true, last4: 'cret' } }
  })
  await successfulCommand(t, ['settings', 'set', 'twilio', '--from-env', './fixtures/twilio.env'], {
    method: 'POST', url: '/v1/settings/twilio/import', body: { path: resolve('./fixtures/twilio.env') }, write: true
  })
  await successfulCommand(t, ['twilio', 'test'], { method: 'POST', url: '/v1/settings/twilio/test', body: {}, write: true })
  await successfulCommand(t, ['app', 'relaunch'], { method: 'POST', url: '/v1/app/relaunch', body: {}, write: true })
})

test('Twilio secret command-line values are rejected', async () => {
  const result = await runCli([
    'settings', 'set', 'twilio', '--api-key-secret', 'must-not-enter-argv',
    '--endpoint', 'http://127.0.0.1:1', '--token', TOKEN
  ])
  assert.equal(result.code, 6)
  assert.match(result.stderr, /Unknown option/)
  assert.doesNotMatch(result.stdout, /must-not-enter-argv/)
})

test('LIVEPHONE_TOKEN supplies the bearer token', async (t) => {
  const fake = await startServer(t, (request) => {
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`)
    return { body: { ready: true } }
  })
  const result = await runCli(['status', '--endpoint', fake.endpoint], { LIVEPHONE_TOKEN: TOKEN })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { ready: true })
})

test('default discovery reads endpoint.json and its token file', async (t) => {
  const fake = await startServer(t, () => ({ body: { ready: true } }))
  const userData = await mkdtemp(join(tmpdir(), 'mishu-user-data-'))
  const tokenPath = join(userData, 'token')
  await mkdir(join(userData, 'mcp'))
  await writeFile(tokenPath, `${TOKEN}\n`)
  await writeFile(join(userData, 'mcp', 'endpoint.json'), JSON.stringify({
    endpoint: `${fake.endpoint}/mcp`,
    tokenPath
  }))
  const result = await runCli(['status'], { LIVE_PHONE_USER_DATA_PATH: userData })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { ready: true })
  assert.equal(fake.requests[0].url, '/v1/status')
  assert.equal(fake.requests[0].headers.authorization, `Bearer ${TOKEN}`)
})

test('call submits the documented request and reuses its idempotency key', async (t) => {
  const fake = await startServer(t, (request) => {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/calls')
    assert.equal(request.body.to, '+15551234567')
    assert.equal(request.body.campaignId, 'sales')
    assert.equal(request.body.goal, 'Book a demo')
    assert.equal(request.body.idempotencyKey, request.headers['idempotency-key'])
    return { status: 202, body: { status: 'dialing', callId: 'call-1' } }
  })
  const result = await runCli([
    'call', '--to', '+15551234567', '--campaign', 'sales', '--goal', 'Book a demo',
    '--endpoint', fake.endpoint, '--token', TOKEN
  ])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { status: 'dialing', callId: 'call-1' })
})

test('call reports pending approval with an actionable hint', async (t) => {
  const fake = await startServer(t, () => ({
    status: 202,
    body: { status: 'pending_approval', approvalId: 'approval-1', expiresAt: 123 }
  }))
  const result = await runCli(['call', '--to', '+15551234567', '--endpoint', fake.endpoint, '--token', TOKEN])
  assert.equal(result.code, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.approvalId, 'approval-1')
  assert.match(output.hint, /mishu approve approval-1/)
})

test('call --wait polls to a terminal state and includes transcript summary', async (t) => {
  const fake = await startServer(t, (request) => {
    if (request.url === '/v1/calls') {
      return { status: 202, body: { status: 'dialing', callId: 'call-2' } }
    }
    if (request.url === '/v1/calls/call-2') return { body: { id: 'call-2', status: 'ended' } }
    if (request.url === '/v1/calls/call-2/transcript') {
      return { body: { summary: 'Appointment booked', entries: [{ role: 'assistant', text: 'Done' }] } }
    }
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'not found' } } }
  })
  const result = await runCli([
    'call', '--to', '+15551234567', '--wait', '--timeout', '2', '--endpoint', fake.endpoint, '--token', TOKEN
  ], { LIVEPHONE_POLL_INTERVAL_MS: '5' })
  assert.equal(result.code, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.call.status, 'ended')
  assert.equal(output.summary, 'Appointment booked')
  assert.equal(output.transcript.entries.length, 1)
})

test('calls ls maps filters to query parameters', async (t) => {
  await successfulCommand(t, ['calls', 'ls', '--limit', '12', '--status', 'ended'], {
    url: '/v1/calls?limit=12&status=ended'
  })
})

test('task submit sends the agent goal and can wait for the structured result', async (t) => {
  const fake = await startServer(t, (request) => {
    if (request.url === '/v1/tasks') {
      assert.equal(request.method, 'POST')
      assert.equal(request.body.to, '+15551234567')
      assert.equal(request.body.goal, 'Book a demo')
      assert.equal(request.body.createdBy, 'cli')
      assert.equal(request.body.idempotencyKey, request.headers['idempotency-key'])
      return { status: 202, body: { taskId: 'task-1', status: 'queued' } }
    }
    assert.equal(request.url, '/v1/tasks/task-1/wait?timeoutMs=2000&include=transcript%2Canalysis')
    return { body: { id: 'task-1', status: 'completed', outcome: 'reached', result: { booked: true } } }
  })
  const result = await runCli([
    'task', 'submit', '--to', '+15551234567', '--goal', 'Book a demo', '--wait', '--timeout', '2',
    '--include', 'transcript,analysis',
    '--endpoint', fake.endpoint, '--token', TOKEN
  ])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    id: 'task-1', status: 'completed', outcome: 'reached', result: { booked: true }
  })
  assert.equal(fake.requests.length, 2)
})

test('task get, ls, wait, and cancel map to task routes', async (t) => {
  await successfulCommand(t, ['task', 'get', 'task-2'], { url: '/v1/tasks/task-2' })
  await successfulCommand(t, ['task', 'ls', '--limit', '5', '--status', 'queued'], { url: '/v1/tasks?limit=5&status=queued' })
  await successfulCommand(t, ['task', 'wait', 'task-2', '--timeout', '3'], {
    url: '/v1/tasks/task-2/wait?timeoutMs=3000',
    response: { id: 'task-2', status: 'completed' }
  })
  await successfulCommand(t, ['task', 'cancel', 'task-2'], {
    method: 'POST', url: '/v1/tasks/task-2/cancel', body: {}, write: true
  })
})

test('task get and wait forward optional inline expansions', async (t) => {
  await successfulCommand(t, ['task', 'get', 'task-expanded', '--include', 'call,analysis'], {
    url: '/v1/tasks/task-expanded?include=call%2Canalysis',
    response: {
      id: 'task-expanded', status: 'completed',
      call: { id: 'call-expanded', voiceProvider: 'gpt-live-api', voiceSeconds: 9.5 }
    }
  })
  await successfulCommand(t, [
    'task', 'wait', 'task-expanded', '--timeout', '3', '--include', 'transcript,analysis,call'
  ], {
    url: '/v1/tasks/task-expanded/wait?timeoutMs=3000&include=transcript%2Canalysis%2Ccall',
    response: { id: 'task-expanded', status: 'completed' }
  })
})

test('task submit accepts an inline contact JSON file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mishu-task-contact-'))
  const file = join(directory, 'contact.json')
  await writeFile(file, JSON.stringify({ displayName: 'Ada', company: 'Analytical Engines' }))
  const fake = await startServer(t, (request) => {
    assert.equal(request.url, '/v1/tasks')
    assert.deepEqual(request.body.contact, { displayName: 'Ada', company: 'Analytical Engines' })
    return { status: 202, body: { taskId: 'task-contact', status: 'queued' } }
  })
  const result = await runCli([
    'task', 'submit', '--to', '+15551234567', '--goal', 'Confirm attendance', '--contact', file,
    '--endpoint', fake.endpoint, '--token', TOKEN
  ])
  assert.equal(result.code, 0, result.stderr)
})

test('task submit builds an inline campaign from prompt, voice, policy, and name', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mishu-task-campaign-'))
  const promptFile = join(directory, 'prompt.txt')
  const policyFile = join(directory, 'policy.json')
  await writeFile(promptFile, 'Tell a short fairy tale.\n')
  await writeFile(policyFile, JSON.stringify({ maxCallDurationSec: 120 }))
  const fake = await startServer(t, (request) => {
    assert.equal(request.url, '/v1/tasks')
    assert.deepEqual(request.body.campaign, {
      name: 'Story task',
      direction: 'outbound',
      systemPrompt: 'Tell a short fairy tale.',
      voice: 'maple',
      policy: { maxCallDurationSec: 120 }
    })
    assert.equal(request.body.campaignId, undefined)
    return { status: 202, body: { taskId: 'task-inline', status: 'queued' } }
  })
  const result = await runCli([
    'task', 'submit', '--to', '+15551234567', '--goal', 'Tell a story',
    '--prompt-file', promptFile, '--voice', 'maple', '--policy', policyFile,
    '--campaign-name', 'Story task', '--endpoint', fake.endpoint, '--token', TOKEN
  ])
  assert.equal(result.code, 0, result.stderr)
})

test('task submit accepts a prompt directly', async (t) => {
  const fake = await startServer(t, (request) => {
    assert.deepEqual(request.body.campaign, {
      direction: 'outbound', systemPrompt: 'Tell a concise story.'
    })
    return { status: 202, body: { taskId: 'task-prompt', status: 'queued' } }
  })
  const result = await runCli([
    'task', 'submit', '--to', '+15551234567', '--goal', 'Tell a story',
    '--prompt', 'Tell a concise story.', '--endpoint', fake.endpoint, '--token', TOKEN
  ])
  assert.equal(result.code, 0, result.stderr)
})

test('task submit rejects campaign ids combined with inline campaign options', async () => {
  const result = await runCli([
    'task', 'submit', '--to', '+15551234567', '--goal', 'Invalid',
    '--campaign', 'saved', '--prompt', 'Inline',
    '--endpoint', 'http://127.0.0.1:1', '--token', TOKEN
  ])
  assert.equal(result.code, 6)
  assert.match(JSON.parse(result.stderr).error.message, /mutually exclusive/)
})

test('task wait loops long polls beyond one server wait window', async (t) => {
  const fake = await startServer(t, (_request, index) => ({
    body: index < 2
      ? { id: 'task-long', status: 'queued' }
      : { id: 'task-long', status: 'completed' }
  }))
  const result = await runCli([
    'task', 'wait', 'task-long', '--timeout', '1',
    '--endpoint', fake.endpoint, '--token', TOKEN
  ], { LIVEPHONE_TASK_WAIT_MAX_MS: '10' })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).status, 'completed')
  assert.equal(fake.requests.length, 3)
  assert.equal(fake.requests[0].url, '/v1/tasks/task-long/wait?timeoutMs=10')
})

test('task submit --wait shares the looping long-poll implementation', async (t) => {
  const fake = await startServer(t, (request, index) => {
    if (index === 0) return { status: 202, body: { taskId: 'task-submit-long', status: 'queued' } }
    return {
      body: index < 3
        ? { id: 'task-submit-long', status: 'queued' }
        : { id: 'task-submit-long', status: 'completed' }
    }
  })
  const result = await runCli([
    'task', 'submit', '--to', '+15551234567', '--goal', 'Wait longer', '--wait', '--timeout', '1',
    '--endpoint', fake.endpoint, '--token', TOKEN
  ], { LIVEPHONE_TASK_WAIT_MAX_MS: '10' })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).status, 'completed')
  assert.equal(fake.requests.length, 4)
})

test('budget get and set map to settings budget', async (t) => {
  await successfulCommand(t, ['budget', 'get'], { url: '/v1/settings/budget' })
  const directory = await mkdtemp(join(tmpdir(), 'mishu-budget-'))
  const file = join(directory, 'budget.json')
  await writeFile(file, JSON.stringify({ enabled: true, dailyMaxCalls: 5 }))
  await successfulCommand(t, ['budget', 'set', '--file', file], {
    method: 'PUT', url: '/v1/settings/budget', body: { enabled: true, dailyMaxCalls: 5 }, write: true
  })
})

test('contacts get, ls, and rm map to contact routes', async (t) => {
  await successfulCommand(t, ['contacts', 'get', '+13125550198'], { url: '/v1/contacts/%2B13125550198' })
  await successfulCommand(t, ['contacts', 'ls', '--limit', '5'], { url: '/v1/contacts?limit=5' })
  await successfulCommand(t, ['contacts', 'rm', '+13125550198'], {
    method: 'DELETE', url: '/v1/contacts/%2B13125550198', write: true
  })
})

test('contacts set writes a single card or a batch from JSON', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mishu-contacts-'))
  const cardFile = join(directory, 'card.json')
  await writeFile(cardFile, JSON.stringify({ phone: '+13125550198', displayName: 'Ada' }))
  await successfulCommand(t, ['contacts', 'set', '--file', cardFile], {
    method: 'PUT', url: '/v1/contacts/%2B13125550198', body: { phone: '+13125550198', displayName: 'Ada' }, write: true
  })
  const batchFile = join(directory, 'cards.json')
  await writeFile(batchFile, JSON.stringify([{ phone: '+13125550198', displayName: 'Ada' }]))
  await successfulCommand(t, ['contacts', 'set', '--file', batchFile], {
    method: 'POST', url: '/v1/contacts:batch', body: [{ phone: '+13125550198', displayName: 'Ada' }], write: true
  })
})

test('call get supports reveal and transcript', async (t) => {
  const fake = await startServer(t, (request) => {
    if (request.url === '/v1/calls/a%2Fb?reveal=true') return { body: { id: 'a/b', to: '+15551234567' } }
    if (request.url === '/v1/calls/a%2Fb/transcript') return { body: { entries: [] } }
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'not found' } } }
  })
  const result = await runCli([
    'call', 'get', 'a/b', '--transcript', '--reveal', '--endpoint', fake.endpoint, '--token', TOKEN
  ])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    call: { id: 'a/b', to: '+15551234567' },
    transcript: { entries: [] }
  })
})

test('call get without transcript returns the call resource', async (t) => {
  await successfulCommand(t, ['call', 'get', 'call-3'], {
    url: '/v1/calls/call-3',
    response: { id: 'call-3', status: 'ended', voiceProvider: 'gpt-live-api', voiceSeconds: 9.5 }
  })
})

test('call analysis gets the latest post-call result', async (t) => {
  await successfulCommand(t, ['call', 'analysis', 'call-3'], {
    url: '/v1/calls/call-3/analysis',
    response: { resultId: 'result-3', summary: 'Reached', confidence: 'high' }
  })
})

test('call audit lists bounded post-call audit entries', async (t) => {
  await successfulCommand(t, ['call', 'audit', 'call-3', '--limit', '25'], {
    url: '/v1/calls/call-3/audit?limit=25',
    response: { audit: [{ action: 'call.ended' }] }
  })
})

test('call recording downloads binary audio', async (t) => {
  const fake = await startServer(t, () => ({
    headers: { 'content-type': 'audio/webm' },
    body: Buffer.from('webm-audio')
  }))
  const directory = await mkdtemp(join(tmpdir(), 'mishu-recording-'))
  const outputPath = join(directory, 'call.webm')
  const result = await runCli([
    'call', 'recording', 'call-4', '--out', outputPath, '--endpoint', fake.endpoint, '--token', TOKEN
  ])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(fake.requests[0].url, '/v1/calls/call-4/recording/audio')
  assert.equal(await readFile(outputPath, 'utf8'), 'webm-audio')
  assert.deepEqual(JSON.parse(result.stdout), {
    callId: 'call-4', output: outputPath, bytes: 10, contentType: 'audio/webm'
  })
})

for (const action of ['hangup', 'answer', 'reject']) {
  test(`${action} controls the current call`, async (t) => {
    await successfulCommand(t, [action], {
      method: 'POST', url: `/v1/calls/current/${action}`, body: {}, write: true
    })
  })
}

test('campaigns ls lists campaigns', async (t) => {
  await successfulCommand(t, ['campaigns', 'ls'], { url: '/v1/campaigns' })
  await successfulCommand(t, ['campaigns', 'ls', '--include-ephemeral'], {
    url: '/v1/campaigns?includeEphemeral=1'
  })
})

test('campaign create and rm map JSON files to campaign routes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mishu-campaign-create-'))
  const file = join(directory, 'campaign.json')
  const campaign = {
    name: 'Outbound', direction: 'outbound', systemPrompt: 'Be helpful', voice: 'juniper',
    policy: { recordingDisclosure: false, maxCallDurationSec: 180 }
  }
  await writeFile(file, JSON.stringify(campaign))
  await successfulCommand(t, ['campaign', 'create', '--file', file], {
    method: 'POST', url: '/v1/campaigns', body: campaign, write: true
  })
  await successfulCommand(t, ['campaign', 'rm', 'campaign-1'], {
    method: 'DELETE', url: '/v1/campaigns/campaign-1', write: true
  })
})

test('campaign get reads one campaign', async (t) => {
  await successfulCommand(t, ['campaign', 'get', 'sales'], { url: '/v1/campaigns/sales' })
})

test('campaign set reads JSON from --file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mishu-campaign-'))
  const file = join(directory, 'policy.json')
  await writeFile(file, JSON.stringify({ policy: { maxDurationSeconds: 60 } }))
  await successfulCommand(t, ['campaign', 'set', 'sales', '--file', file], {
    method: 'PUT',
    url: '/v1/campaigns/sales',
    body: { policy: { maxDurationSeconds: 60 } },
    write: true
  })
})

test('campaign select selects one campaign', async (t) => {
  await successfulCommand(t, ['campaign', 'select', 'sales'], {
    method: 'POST', url: '/v1/campaigns/sales/select', body: {}, write: true
  })
})

test('approvals ls lists pending approvals', async (t) => {
  await successfulCommand(t, ['approvals', 'ls'], { url: '/v1/approvals' })
})

for (const [command, approved] of [['approve', true], ['deny', false]]) {
  test(`${command} decides an approval`, async (t) => {
    await successfulCommand(t, [command, 'approval-2'], {
      method: 'POST',
      url: '/v1/approvals/approval-2/decide',
      body: { approved },
      write: true
    })
  })
}

test('appointments ls lists appointments', async (t) => {
  await successfulCommand(t, ['appointments', 'ls'], { url: '/v1/appointments' })
})

for (const category of ['webhook', 'mcp', 'appointments', 'crm']) {
  test(`settings get ${category} reads settings`, async (t) => {
    await successfulCommand(t, ['settings', 'get', category], { url: `/v1/settings/${category}` })
  })

  test(`settings set ${category} writes settings from a file`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), `mishu-settings-${category}-`))
    const file = join(directory, 'settings.json')
    await writeFile(file, JSON.stringify({ enabled: true }))
    await successfulCommand(t, ['settings', 'set', category, '--file', file], {
      method: 'PUT', url: `/v1/settings/${category}`, body: { enabled: true }, write: true
    })
  })
}

test('webhook test requests a test delivery', async (t) => {
  await successfulCommand(t, ['webhook', 'test'], {
    method: 'POST', url: '/v1/settings/webhook/test', body: {}, write: true
  })
})

test('simulate-incoming uses the mock-only debug route', async (t) => {
  await successfulCommand(t, ['simulate-incoming'], {
    method: 'POST', url: '/v1/debug/simulate-incoming', body: {}, write: true
  })
})

test('openapi prints the server document', async (t) => {
  await successfulCommand(t, ['openapi'], {
    url: '/v1/openapi.json', response: { openapi: '3.1.0' }
  })
})

test('--pretty emits indented JSON', async (t) => {
  const fake = await startServer(t, () => ({ body: { ready: true } }))
  const result = await runCli(['status', '--pretty', '--endpoint', fake.endpoint, '--token', TOKEN])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /\n  "ready": true\n/)
})

test('missing local discovery gives the App startup hint and exit 2', async () => {
  const emptyUserData = await mkdtemp(join(tmpdir(), 'mishu-missing-'))
  const result = await runCli(['status'], {
    LIVE_PHONE_USER_DATA_PATH: emptyUserData,
    LIVEPHONE_TOKEN: ''
  })
  assert.equal(result.code, 2)
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'APP_UNAVAILABLE')
  assert.match(error.message, /Start the desktop App and enable MCP\/API/)
})

test('401 explains token rotation and exits 4', async (t) => {
  const fake = await startServer(t, () => ({
    status: 401,
    body: { error: { code: 'UNAUTHORIZED', message: 'bad token' } }
  }))
  const result = await runCli(['status', '--endpoint', fake.endpoint, '--token', 'stale'])
  assert.equal(result.code, 4)
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'UNAUTHORIZED')
  assert.match(error.message, /token may have rotated/i)
})

test('network errors exit 3', async () => {
  const result = await runCli(['status', '--endpoint', 'http://127.0.0.1:1', '--token', TOKEN])
  assert.equal(result.code, 3)
  assert.equal(JSON.parse(result.stderr).error.code, 'NETWORK_ERROR')
})

test('invalid command arguments exit 6 with JSON', async () => {
  const result = await runCli(['--endpoint'])
  assert.equal(result.code, 6)
  const payload = JSON.parse(result.stderr)
  assert.equal(payload.error.code, 'USAGE')
  assert.match(payload.error.message, /Run mishu --help for usage/)
})

test('call --wait timeout exits 7', async (t) => {
  const fake = await startServer(t, (request) => {
    if (request.url === '/v1/calls') return { status: 202, body: { status: 'dialing', callId: 'slow' } }
    return { body: { id: 'slow', status: 'ringing' } }
  })
  const result = await runCli([
    'call', '--to', '+15551234567', '--wait', '--timeout', '0.02', '--endpoint', fake.endpoint, '--token', TOKEN
  ], { LIVEPHONE_POLL_INTERVAL_MS: '5' })
  assert.equal(result.code, 7)
  assert.equal(JSON.parse(result.stderr).error.code, 'WAIT_TIMEOUT')
})

test('task wait timeout exits 7 with the last task snapshot', async (t) => {
  const fake = await startServer(t, () => ({ body: { id: 'slow-task', status: 'queued' } }))
  const result = await runCli([
    'task', 'wait', 'slow-task', '--timeout', '0.03',
    '--endpoint', fake.endpoint, '--token', TOKEN
  ], { LIVEPHONE_TASK_WAIT_MAX_MS: '10' })
  assert.equal(result.code, 7)
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'WAIT_TIMEOUT')
  assert.equal(error.details.task.status, 'queued')
})

test('voice and OpenAI settings commands are symmetric and never accept inline secrets', async (t) => {
  await successfulCommand(t, ['settings', 'get', 'voice'], { url: '/v1/settings/voice' })
  await successfulCommand(t, ['settings', 'get', 'openai'], { url: '/v1/settings/openai' })
  await successfulCommand(t, ['openai', 'test'], { method: 'POST', url: '/v1/settings/openai/test', body: {} })
  const directory = await mkdtemp(join(tmpdir(), 'mishu-openai-'))
  const file = join(directory, 'settings.json')
  await writeFile(file, JSON.stringify({ apiKey: 'fake-secret-key-1234' }))
  await successfulCommand(t, ['settings', 'set', 'openai', '--file', file], {
    method: 'PUT', url: '/v1/settings/openai', body: { apiKey: 'fake-secret-key-1234' }, write: true,
    response: { apiKey: { configured: true, last4: '1234' } }
  })
  const result = await runCli(['settings', 'set', 'openai', '--api-key=fake-secret-key-1234'])
  assert.notEqual(result.code, 0)
  assert.ok(!JSON.stringify(result).includes('fake-secret-key-1234'))
})

test('mishu --help shows mishu as the invoked name', async () => {
  const result = await runCli(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^Usage: mishu \[global options\]/)
})
