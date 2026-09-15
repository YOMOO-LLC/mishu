import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync, type WriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  CallSummary,
  CallSession,
  LivePhoneApi,
  RecordingInfo,
  TranscriptEntry
} from '../../src/shared/contracts'
import { verifySignature } from '../../src/main/webhook/signer'
import { COPILOT_INJECTION_DISCARDED } from '../../src/main/copilot/tool-executor'
import { END_CALL_WAIT_AUDIT_ACTION } from '../../src/main/call-control/tools'

interface LivePhoneWindow {
  livePhone: LivePhoneApi
}

declare const window: LivePhoneWindow

let application: ElectronApplication
let userDataDirectory: string
let electronStderr: WriteStream
let electronStderrPath: string

test.beforeEach(async ({}, testInfo) => {
  userDataDirectory = mkdtempSync(join(tmpdir(), 'mishu-e2e-'))
  electronStderrPath = testInfo.outputPath('electron-stderr.log')
  electronStderr = createWriteStream(electronStderrPath)
  application = await launchApplication()
})

test.afterEach(async ({}, testInfo) => {
  await application.close()
  await new Promise<void>((resolve, reject) => {
    electronStderr.once('error', reject)
    electronStderr.end(resolve)
  })
  await testInfo.attach('electron-stderr', { path: electronStderrPath, contentType: 'text/plain' })
  rmSync(userDataDirectory, { recursive: true, force: true })
})

async function launchApplication(env: Record<string, string> = {}): Promise<ElectronApplication> {
  const launched = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDirectory}`],
    env: {
      ...process.env,
      LIVE_PHONE_USE_MOCKS: '1',
      LIVE_PHONE_SKIP_ENV_FILE: '1',
      TWILIO_ACCOUNT_SID: '',
      TWILIO_API_KEY_SID: '',
      TWILIO_API_KEY_SECRET: '',
      TWILIO_TWIML_APP_SID: '',
      TWILIO_PHONE_NUMBER: '+13125550198',
      ...env
    }
  })
  launched.process().stderr?.pipe(electronStderr, { end: false })
  return launched
}

test('answers a simulated incoming call and hands control to a human', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('app-title')).toHaveText('Mishu')
  await expect(page.getByTestId('twilio-status')).toContainText('Connected')
  await expect(page.getByTestId('codex-status')).toContainText('Local Codex app-server')
  await expect(page.getByTestId('codex-status')).toContainText('Connected')
  await expect(page.getByTestId('control-status')).toHaveText('Waiting for a call')
  await expect(page.getByTestId('footer-codex-status')).toHaveText('Mock mode · no local app-server')

  await page.getByTestId('simulate-incoming-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Incoming ring')
  await expect(page.getByTestId('call-peer')).toContainText('+1 415 555 0142')

  await page.getByTestId('answer-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('On a call')
  await expect(page.getByTestId('control-status')).toHaveText('AI live')
  await expect(page.getByTestId('ai-control-button')).toContainText('AI takeover')
  await expect(page.getByTestId('transcript-entry')).toHaveCount(2)

  await page.getByTestId('human-control-button').click()
  await expect(page.getByTestId('human-control-button')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('control-status')).toHaveText('Human call')

  await page.getByTestId('hangup-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')
})

test('resets takeover to AI after hangup so the next inbound call is answered by AI', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.getByTestId('simulate-incoming-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Incoming ring')
  await page.getByTestId('answer-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('On a call')
  await expect(page.getByTestId('control-status')).toHaveText('AI live')

  await page.getByTestId('human-control-button').click()
  await expect(page.getByTestId('human-control-button')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('control-status')).toHaveText('Human call')

  await page.getByTestId('hangup-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')
  await expect(page.getByTestId('ai-control-button')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('human-control-button')).toHaveAttribute('aria-pressed', 'false')

  await page.getByTestId('simulate-incoming-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Incoming ring')
  await page.getByTestId('answer-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('On a call')
  await expect(page.getByTestId('control-status')).toHaveText('AI live')
  await expect(page.getByTestId('ai-control-button')).toHaveAttribute('aria-pressed', 'true')
})

test('dials an outbound call in mock mode', async () => {
  const page = await application.firstWindow()
  const input = page.getByTestId('dial-input')
  await page.getByTestId('new-campaign-button').click()
  await page.getByTestId('campaign-name-input').fill('Test campaign')
  await page.getByTestId('campaign-direction-select').selectOption('outbound')
  await page.getByTestId('campaign-voice-select').selectOption('juniper')
  await page.getByTestId('campaign-prompt-input').fill('Introduce the test package and ask if they will book a demo')
  await page.getByTestId('save-campaign-button').click()
  await expect(page.getByTestId('selected-campaign-summary')).toContainText('Introduce the test package')
  await input.fill('1 773 555 0100')
  await page.getByTestId('dial-button').click()

  await expect(page.getByTestId('call-status')).toHaveText('On a call')
  await expect(page.getByTestId('call-peer')).toContainText('+17735550100')
  await page.getByTestId('hangup-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')
  const calls = await page.evaluate(() =>
    (window as unknown as LivePhoneWindow).livePhone.listCalls({ limit: 10, offset: 0 })
  )
  expect(calls).toHaveLength(1)
})

test('recovers after a mock realtime startup failure and dials again', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  const firstDial = await page.evaluate(() =>
    (window as unknown as LivePhoneWindow).livePhone.debugPhoneCommand?.({
      type: 'dial',
      peer: '+17735550100'
    })
  )
  expect(firstDial).toMatchObject({ ok: true, status: { call: { status: 'active' } } })
  await expect(page.getByTestId('call-status')).toHaveText('On a call')

  const failed = await page.evaluate(() =>
    (window as unknown as LivePhoneWindow).livePhone.debugPhoneCommand?.({
      type: 'simulateRealtimeStartFailure'
    })
  )
  expect(failed).toMatchObject({ ok: true, status: { call: { status: 'ended' } } })
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')

  await expect.poll(async () => {
    const calls = await page.evaluate(() =>
      (window as unknown as LivePhoneWindow).livePhone.listCalls({ limit: 1, offset: 0 })
    )
    if (!calls[0]) return undefined
    return page.evaluate(
      (id) => (window as unknown as LivePhoneWindow).livePhone.getCall(id),
      calls[0].id
    )
  }).toMatchObject({ endReason: 'session_error' })

  const secondDial = await page.evaluate(() =>
    (window as unknown as LivePhoneWindow).livePhone.debugPhoneCommand?.({
      type: 'dial',
      peer: '+17735550101'
    })
  )
  expect(secondDial).toMatchObject({ ok: true, status: { call: { status: 'active' } } })
  await expect(page.getByTestId('call-status')).toHaveText('On a call')
  await expect(page.getByTestId('call-peer')).toContainText('+17735550101')
})

test('edits and saves the existing campaign without losing its prompt', async () => {
  const page = await application.firstWindow()

  await expect(page.getByText('+13125550198')).toBeVisible()
  await page.getByTestId('new-campaign-button').click()
  await page.getByTestId('campaign-name-input').fill('Incomplete')
  await page.getByTestId('save-campaign-button').click()
  await expect(page.getByTestId('campaign-form-error')).toContainText('System prompt cannot be empty')
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByText(/System prompt cannot be empty/)).toHaveCount(0)

  await page.getByRole('button', { name: 'Edit Default Campaign' }).click()
  await expect(page.getByTestId('campaign-prompt-input')).not.toHaveValue('')
  await page.getByRole('button', { name: 'Use for both' }).click()
  await expect(page.getByTestId('campaign-inbound-number')).toHaveValue('+13125550198')
  await expect(page.getByTestId('campaign-outbound-number')).toHaveValue('+13125550198')
  await page.getByTestId('save-campaign-button').click()

  await expect(page.getByTestId('campaign-editor')).toBeHidden()
  await expect(page.getByTestId('selected-campaign-summary')).toContainText('Answer or place the call politely')
  await expect(page.getByText(/System prompt cannot be empty/)).toHaveCount(0)
})

test('persists an ended call session and its transcript via the call store', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.getByTestId('simulate-incoming-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Incoming ring')
  await page.getByTestId('answer-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('On a call')
  await expect(page.getByTestId('transcript-entry')).toHaveCount(2)
  await page.getByTestId('hangup-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')

  await expect
    .poll(async () => {
      const calls = await page.evaluate(() => (window as unknown as LivePhoneWindow).livePhone.listCalls({ limit: 10, offset: 0 }))
      return calls.length
    }, { timeout: 10_000 })
    .toBe(1)

  const summaries = await page.evaluate(() => (window as unknown as LivePhoneWindow).livePhone.listCalls({ limit: 10, offset: 0 }))
  const session = summaries[0] as CallSummary
  expect(session.status).toBe('ended')
  expect(session.direction).toBe('inbound')
  expect(session.runtimeMode).toBe('mock')
  expect(session.campaignName).toBeTruthy()

  const detail = (await page.evaluate(
    (id) => (window as unknown as LivePhoneWindow).livePhone.getCall(id),
    session.id
  )) as CallSession
  expect(detail.status).toBe('ended')
  expect(detail.endReason).toBe('local_hangup')
  expect(detail.peer).toContain('+1 415 555 0142')

  const transcript = (await page.evaluate(
    (id) => (window as unknown as LivePhoneWindow).livePhone.getCallTranscript(id),
    session.id
  )) as TranscriptEntry[]
  expect(transcript).toHaveLength(2)
  expect(transcript.map(({ speaker }) => speaker).sort()).toEqual(['assistant', 'caller'])
})

test('persists remote_hangup when a mock caller disconnects', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.getByTestId('simulate-incoming-button').click()
  await page.getByTestId('answer-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('On a call')
  const result = await page.evaluate(() =>
    (window as unknown as LivePhoneWindow).livePhone.debugPhoneCommand?.({
      type: 'simulateRemoteHangup'
    })
  )
  expect(result?.ok).toBe(true)
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')

  await expect.poll(async () => {
    const calls = await page.evaluate(() =>
      (window as unknown as LivePhoneWindow).livePhone.listCalls({ limit: 1, offset: 0 })
    )
    if (!calls[0]) return undefined
    return page.evaluate(
      (id) => (window as unknown as LivePhoneWindow).livePhone.getCall(id),
      calls[0].id
    )
  }).toMatchObject({ endReason: 'remote_hangup' })
})

test('records a stereo webm file for an ended call and verifies its sha256', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.getByTestId('simulate-incoming-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Incoming ring')
  await page.getByTestId('answer-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('On a call')
  await page.waitForTimeout(1500)
  await page.getByTestId('hangup-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')

  let recording: RecordingInfo | undefined
  await expect
    .poll(async () => {
      const calls = await page.evaluate(() => (window as unknown as LivePhoneWindow).livePhone.listCalls({ limit: 5, offset: 0 }))
      if (calls.length === 0) return undefined
      const summary = calls[0] as CallSummary
      const info = await page.evaluate(
        (id) => (window as unknown as LivePhoneWindow).livePhone.getRecording(id),
        summary.id
      )
      recording = info
      return info?.status
    }, { timeout: 15_000 })
    .toBe('complete')

  expect(recording).toBeDefined()
  expect(recording?.bytes ?? 0).toBeGreaterThan(0)
  expect(recording?.status).toBe('complete')
  expect(recording?.sha256).toBeTruthy()
  expect(recording?.playbackUrl).toBeTruthy()
  expect((recording as { path?: string }).path).toBeUndefined()

  const playback = await page.evaluate(
    async (url) => {
      const response = await fetch(url)
      const buffer = await response.arrayBuffer()
      return { status: response.status, byteLength: buffer.byteLength }
    },
    recording?.playbackUrl as string
  )
  expect(playback.status).toBe(200)
  expect(playback.byteLength).toBe(recording?.bytes)
})

test('switches between the calls, history, and settings tabs', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.getByTestId('tab-history').click()
  await expect(page.getByTestId('panel-history')).toBeVisible()
  await expect(page.getByTestId('history-empty')).toBeVisible()

  await page.getByTestId('tab-settings').click()
  await expect(page.getByTestId('panel-settings')).toBeVisible()

  await page.getByTestId('tab-calls').click()
  await expect(page.getByTestId('simulate-incoming-button')).toBeVisible()
  await expect(page.getByTestId('call-status')).toHaveText('Waiting for calls')
  await expect(page.getByTestId('twilio-status')).toContainText('Connected')
})

test('round-trips mock phone commands through the main-to-renderer gateway', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('twilio-status')).toContainText('Connected')

  const dialResult = await page.evaluate(async () => {
    const api = (window as unknown as LivePhoneWindow).livePhone
    if (!api.debugPhoneCommand) throw new Error('Debug phone command API is unavailable')
    return api.debugPhoneCommand({ type: 'dial', peer: '+17735550100' })
  })
  expect(dialResult.ok).toBe(true)
  if (dialResult.ok) expect(['dialing', 'active']).toContain(dialResult.status.call?.status)
  await expect(page.getByTestId('call-status')).toHaveText('On a call')

  const statusResult = await page.evaluate(async () => {
    const api = (window as unknown as LivePhoneWindow).livePhone
    if (!api.debugPhoneCommand) throw new Error('Debug phone command API is unavailable')
    return api.debugPhoneCommand({ type: 'getStatus' })
  })
  expect(statusResult).toMatchObject({ ok: true, status: { call: { status: 'active' } } })

  const hangupResult = await page.evaluate(async () => {
    const api = (window as unknown as LivePhoneWindow).livePhone
    if (!api.debugPhoneCommand) throw new Error('Debug phone command API is unavailable')
    return api.debugPhoneCommand({ type: 'hangup' })
  })
  expect(hangupResult).toMatchObject({ ok: true, status: { call: { status: 'ended' } } })
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')
})

test('shows settings sections and completes a local approval round-trip', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('tab-settings').click()
  await expect(page.getByTestId('settings-section-webhook')).toBeVisible()
  await expect(page.getByTestId('settings-section-mcp')).toBeVisible()
  await expect(page.getByTestId('settings-section-crm')).toBeVisible()

  const decisionPromise = page.evaluate(async () => {
    const api = (window as unknown as LivePhoneWindow).livePhone
    if (!api.debugApprovalRequest) throw new Error('Debug approval API is unavailable')
    return api.debugApprovalRequest({
      id: 'approval-e2e',
      kind: 'call_dial',
      title: 'Approve test dial',
      summary: 'Verifies the local approval channel only; no real call is placed.',
      details: { peer: '+1 *** *** 0100' },
      requestedBy: 'e2e',
      expiresAt: Date.now() + 10_000
    })
  })
  await expect(page.getByTestId('approval-modal')).toBeVisible()
  await page.getByTestId('approval-approve').click()
  await expect(decisionPromise).resolves.toMatchObject({ id: 'approval-e2e', approved: true })
  await expect(page.getByTestId('approval-modal')).toBeHidden()
})

test('saves Twilio settings and tests them only against a fake local Twilio server', async () => {
  await application.close()
  const fake = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(request.url?.includes('IncomingPhoneNumbers') ? JSON.stringify({ incoming_phone_numbers: [{}] }) : '{}')
  })
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
  const address = fake.address() as AddressInfo
  test.info().attach('twilio-test-server', { body: `127.0.0.1:${address.port}`, contentType: 'text/plain' })
  try {
    application = await launchApplication({
      LIVE_PHONE_TWILIO_API_BASE_URL: `http://127.0.0.1:${address.port}`,
      TWILIO_PHONE_NUMBER: ''
    })
    const page = await application.firstWindow()
    await page.getByTestId('tab-settings').click()
    await expect(page.getByTestId('settings-section-twilio')).toBeVisible()
    await page.getByTestId('twilio-accountSid').fill(`AC${'1'.repeat(32)}`)
    await page.getByTestId('twilio-apiKeySid').fill(`SK${'2'.repeat(32)}`)
    await page.getByTestId('twilio-apiKeySecret').fill('e2e-file-only-secret')
    await page.getByRole('button', { name: 'Show', exact: true }).click()
    await expect(page.getByTestId('twilio-apiKeySecret')).toHaveAttribute('type', 'text')
    await page.getByRole('button', { name: 'Hide', exact: true }).click()
    await expect(page.getByTestId('twilio-apiKeySecret')).toHaveAttribute('type', 'password')
    await page.getByTestId('twilio-twimlAppSid').fill(`AP${'3'.repeat(32)}`)
    await page.getByTestId('twilio-phoneNumber').fill('+13125550198')
    await page.getByTestId('twilio-save').click()
    await expect(page.getByTestId('twilio-notice')).toContainText('saved')
    await expect(page.getByTestId('runtime-mode-warning')).toBeHidden()
    await page.getByTestId('twilio-test').click()
    await expect(page.getByTestId('twilio-test-results')).toContainText('token: passed')
    await expect(page.getByTestId('twilio-test-results')).toContainText('application: passed')
    await expect(page.getByTestId('twilio-test-results')).toContainText('phoneNumber: passed')
    expect(await page.locator('body').textContent()).not.toContain('e2e-file-only-secret')
  } finally {
    await new Promise<void>((resolve, reject) => fake.close((error) => error ? reject(error) : resolve()))
  }
})

test('round-trips copilot settings and preserves newlines while typing tool ids', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByRole('button', { name: 'Edit Default Campaign' }).click()
  await page.getByTestId('copilot-section').locator('summary').click()
  await page.getByTestId('copilot-enabled').check()
  await page.getByTestId('copilot-prompt').fill('Look up the customer and return only brief facts.')
  const tools = page.getByTestId('copilot-tools')
  await tools.fill('')
  await tools.pressSequentially('lookup_customer')
  await tools.press('Enter')
  await tools.pressSequentially('appointments_make')
  await expect(tools).toHaveValue('lookup_customer\nappointments_make')
  await page.getByTestId('save-campaign-button').click()
  await expect(page.getByTestId('campaign-editor')).toBeHidden()

  await page.getByRole('button', { name: 'Edit Default Campaign' }).click()
  await page.getByTestId('copilot-section').locator('summary').click()
  await expect(page.getByTestId('copilot-enabled')).toBeChecked()
  await expect(page.getByTestId('copilot-prompt')).toHaveValue('Look up the customer and return only brief facts.')
  await expect(page.getByTestId('copilot-tools')).toHaveValue('lookup_customer\nappointments_make')
})

test('syncs an ended mock call to CRM and shows the recent sync record', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('tab-settings').click()
  await expect(page.getByTestId('crm-connection-status')).toHaveText('Connected')
  await page.getByTestId('crm-post-call-sync').check()
  await expect(page.getByTestId('crm-notice')).toContainText('saved')

  await page.getByTestId('tab-calls').click()
  await runMockIncomingCall(page)

  await expect.poll(() => {
    const database = new DatabaseSync(join(userDataDirectory, 'calls.sqlite3'))
    try {
      const row = database.prepare(
        "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'crm.note.created'"
      ).get() as { count: number }
      return row.count
    } finally {
      database.close()
    }
  }, { timeout: 10_000 }).toBe(1)

  await page.getByTestId('tab-settings').click()
  await page.getByTestId('crm-refresh').click()
  await expect(page.getByTestId('crm-sync-list')).toBeVisible()
  await expect(page.getByTestId('crm-sync-list')).toContainText('Synced')
})

test('shows a clear offline error for fake Zoho credentials in mock mode', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('tab-settings').click()
  await page.getByTestId('crm-provider').selectOption('zoho')
  await page.getByTestId('crm-client-id').fill('fake-client-id')
  await page.getByTestId('crm-client-secret').fill('fake-client-secret')
  await page.getByTestId('crm-grant-code').fill('fake-one-time-code')
  await page.getByTestId('crm-connect').click()

  await expect(page.getByTestId('crm-error')).toContainText('Zoho OAuth failed (HTTP 503)')
  await expect(page.getByTestId('crm-connection-status')).toHaveText('Not connected')
})

async function runMockIncomingCall(page: Page): Promise<void> {
  await page.getByTestId('simulate-incoming-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Incoming ring')
  await page.getByTestId('answer-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('On a call')
  await page.waitForTimeout(1500)
  await page.getByTestId('hangup-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')
}

test('shows a completed call in history with transcript, recording, and masked peer', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await runMockIncomingCall(page)

  await expect
    .poll(async () => {
      const calls = await page.evaluate(() => (window as unknown as LivePhoneWindow).livePhone.listCalls({ limit: 5, offset: 0 }))
      if (calls.length === 0) return undefined
      const info = await page.evaluate(
        (id) => (window as unknown as LivePhoneWindow).livePhone.getRecording(id),
        (calls[0] as CallSummary).id
      )
      return info?.status
    }, { timeout: 15_000 })
    .toBe('complete')

  await page.getByTestId('tab-history').click()
  await expect(page.getByTestId('history-list')).toBeVisible()
  await expect(page.getByTestId('history-row')).toHaveCount(1)

  await page.getByTestId('history-row').click()
  await expect(page.getByTestId('history-detail')).toBeVisible()
  await expect(page.getByTestId('history-transcript-entry')).toHaveCount(2)
  await expect(page.getByTestId('history-peer')).not.toContainText('415 555 0142')
  await expect(page.getByTestId('history-guardrails')).toContainText('This call has no guardrail events.')

  const audio = page.getByTestId('history-audio')
  await expect(audio).toBeVisible()
  const playbackUrl = (await audio.getAttribute('src')) as string
  expect(playbackUrl.startsWith('live-phone-recording://')).toBe(true)

  const playback = await page.evaluate(
    async (url) => {
      const response = await fetch(url)
      const buffer = await response.arrayBuffer()
      return { status: response.status, byteLength: buffer.byteLength }
    },
    playbackUrl
  )
  expect(playback.status).toBe(200)
  expect(playback.byteLength).toBeGreaterThan(0)
})

test('exports a call detail to JSON with transcript and masked peer', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await runMockIncomingCall(page)

  await expect
    .poll(async () => {
      const calls = await page.evaluate(() => (window as unknown as LivePhoneWindow).livePhone.listCalls({ limit: 5, offset: 0 }))
      return calls.length
    }, { timeout: 10_000 })
    .toBe(1)

  await page.getByTestId('tab-history').click()
  await expect(page.getByTestId('history-row')).toHaveCount(1)
  await page.getByTestId('history-row').click()
  await expect(page.getByTestId('history-detail')).toBeVisible()

  const capturePath = join(userDataDirectory, 'exported-call.json')
  await application.evaluate(({ session }, target) => {
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSavePath(target)
    })
  }, capturePath)

  await page.getByTestId('history-export').click()

  await expect
    .poll(async () => {
      try {
        const content = await readFile(capturePath, 'utf-8')
        return JSON.parse(content)
      } catch {
        return undefined
      }
    }, { timeout: 10_000 })
    .toBeTruthy()

  const exported = JSON.parse(await readFile(capturePath, 'utf-8'))
  expect(exported.schemaVersion).toBe(1)
  expect(exported.transcript).toHaveLength(2)
  expect(exported.transcript.map(({ speaker }: { speaker: string }) => speaker).sort()).toEqual(['assistant', 'caller'])
  expect(exported.call.peer).toContain('***')
  expect(exported.call.peer).not.toContain('415 555 0142')
  expect(JSON.stringify(exported)).not.toContain('"path"')
})

test('round-trips forbidden claims through the campaign policy editor', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.getByRole('button', { name: 'Edit Default Campaign' }).click()
  await expect(page.getByTestId('policy-toggle')).toBeVisible()
  await page.getByTestId('policy-toggle').click()
  const claimsField = page.getByTestId('policy-forbidden-claims')
  await claimsField.fill('guaranteed refund\none-year free trial')
  await page.getByTestId('save-campaign-button').click()
  await expect(page.getByTestId('campaign-editor')).toBeHidden()

  await page.getByRole('button', { name: 'Edit Default Campaign' }).click()
  await page.getByTestId('policy-toggle').click()
  await expect(page.getByTestId('policy-forbidden-claims')).toHaveValue('guaranteed refund\none-year free trial')
})

test('auto-hangs up with end reason max_duration when the policy limit is reached', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.getByRole('button', { name: 'Edit Default Campaign' }).click()
  await page.getByTestId('policy-toggle').click()
  await page.getByTestId('policy-max-duration').fill('30')
  await page.getByTestId('save-campaign-button').click()
  await expect(page.getByTestId('campaign-editor')).toBeHidden()

  await page.clock.install()
  await page.getByTestId('simulate-incoming-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Incoming ring')
  await page.getByTestId('answer-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('On a call')

  await page.clock.fastForward(31_000)

  await expect(page.getByTestId('call-status')).toHaveText('Call ended')

  await expect
    .poll(async () => {
      const calls = await page.evaluate(() => (window as unknown as LivePhoneWindow).livePhone.listCalls({ limit: 5, offset: 0 }))
      if (calls.length === 0) return undefined
      return (calls[0] as CallSummary).status
    }, { timeout: 10_000 })
    .toBe('ended')

  const calls = await page.evaluate(() => (window as unknown as LivePhoneWindow).livePhone.listCalls({ limit: 5, offset: 0 }))
  const detail = (await page.evaluate(
    (id) => (window as unknown as LivePhoneWindow).livePhone.getCall(id),
    (calls[0] as CallSummary).id
  )) as CallSession
  expect(detail.endReason).toBe('max_duration')

  const guardrails = (await page.evaluate(
    (id) => (window as unknown as LivePhoneWindow).livePhone.listGuardrailEvents(id),
    (calls[0] as CallSummary).id
  )) as Array<{ kind: string }>
  expect(guardrails.some(({ kind }) => kind === 'max_duration')).toBe(true)

  await page.getByTestId('tab-history').click()
  await expect(page.getByTestId('history-row')).toHaveCount(1)
  await page.getByTestId('history-row').click()
  await expect(page.getByTestId('history-detail')).toBeVisible()
  await expect(page.getByTestId('history-guardrails')).toContainText('Call timed out')
  await expect(page.getByTestId('history-guardrail')).toHaveCount(1)
})

interface CapturedWebhookRequest {
  body: string
  headers: Record<string, string | string[] | undefined>
}

async function startWebhookEndpoint(): Promise<{
  baseUrl: string
  requests: CapturedWebhookRequest[]
  close: () => Promise<void>
}> {
  const requests: CapturedWebhookRequest[] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      requests.push({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: request.headers
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

test('sends a signed webhook.test event from the settings panel', async () => {
  const endpoint = await startWebhookEndpoint()
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  try {
    await page.getByTestId('tab-settings').click()
    await expect(page.getByTestId('panel-settings')).toBeVisible()
    await expect(page.getByTestId('webhook-form-ready')).toBeVisible()

    await page.getByTestId('webhook-url-input').fill(`${endpoint.baseUrl}/hook`)
    await page.getByTestId('webhook-enabled').check()
    await page.getByTestId('webhook-event-webhook.test').check()
    await page.getByTestId('webhook-save-button').click()
    await expect(page.getByTestId('webhook-notice')).toContainText('saved')

    await page.getByTestId('webhook-rotate-button').click()
    const secret = (await page.getByTestId('webhook-secret-value').textContent()) as string
    expect(secret).toMatch(/^[0-9a-f]{64}$/)

    await page.getByTestId('webhook-test-button').click()

    await expect
      .poll(async () => endpoint.requests.length, { timeout: 10_000 })
      .toBeGreaterThan(0)

    const request = endpoint.requests[0]
    const signature = request.headers['x-mishu-signature']
    expect(
      verifySignature(secret, typeof signature === 'string' ? signature : undefined, request.body, 60_000)
    ).toBe(true)
    expect(request.headers['x-mishu-event']).toBe('webhook.test')

    await expect(page.getByTestId('webhook-deliveries')).toContainText('Delivered')
  } finally {
    await endpoint.close()
  }
})

test('delivers a call.ended webhook with a masked peer after a mock call', async () => {
  const endpoint = await startWebhookEndpoint()
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  try {
    await page.getByTestId('tab-settings').click()
    await expect(page.getByTestId('panel-settings')).toBeVisible()
    await expect(page.getByTestId('webhook-form-ready')).toBeVisible()

    await page.getByTestId('webhook-url-input').fill(`${endpoint.baseUrl}/hook`)
    await page.getByTestId('webhook-enabled').check()
    await page.getByTestId('webhook-event-call.ended').check()
    await page.getByTestId('webhook-save-button').click()
    await expect(page.getByTestId('webhook-notice')).toContainText('saved')

    await page.getByTestId('tab-calls').click()
    await expect(page.getByTestId('simulate-incoming-button')).toBeVisible()
    await runMockIncomingCall(page)

    await expect
      .poll(
        async () => endpoint.requests.some((request) => request.headers['x-mishu-event'] === 'call.ended'),
        { timeout: 15_000 }
      )
      .toBe(true)

    const request = endpoint.requests.find(
      (entry) => entry.headers['x-mishu-event'] === 'call.ended'
    ) as CapturedWebhookRequest
    const payload = JSON.parse(request.body) as { data: { peer?: string; callId?: string } }
    expect(payload.data.peer).toContain('***')
    expect(payload.data.peer).not.toContain('415 555 0142')
    expect(payload.data.callId).toBeTruthy()
  } finally {
    await endpoint.close()
  }
})

test('runs the enabled mock copilot tool, audits it, and emits an injection event', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.getByRole('button', { name: 'Edit Default Campaign' }).click()
  await page.getByTestId('copilot-section').locator('summary').click()
  await page.getByTestId('copilot-enabled').check()
  await page.getByTestId('copilot-mode').selectOption('transcript')
  await page.getByTestId('copilot-prompt').fill('Use allowlisted tools when customer data is needed.')
  await page.getByTestId('copilot-tools').fill('lookup_customer')
  await page.getByTestId('save-campaign-button').click()
  await expect(page.getByTestId('campaign-editor')).toBeHidden()

  await page.evaluate(() => {
    const target = window as unknown as LivePhoneWindow & { __copilotInjections?: string[] }
    target.__copilotInjections = []
    target.livePhone.onEvent((event) => {
      if (event.type === 'copilot-injected') target.__copilotInjections?.push(event.text)
    })
  })

  await page.getByTestId('simulate-incoming-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Incoming ring')
  await page.getByTestId('answer-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('On a call')
  await expect(page.getByTestId('copilot-last-tool')).toHaveText('lookup_customer')
  await expect.poll(
    () => page.evaluate(() =>
      ((window as unknown as { __copilotInjections?: string[] }).__copilotInjections ?? []).length
    ),
    { timeout: 10_000 }
  ).toBe(1)

  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(join(userDataDirectory, 'calls.sqlite3'), { readOnly: true })
  const audit = database.prepare(`
    SELECT actor, action, details_json FROM audit_log
    WHERE action = 'copilot.tool.executed'
  `).get() as { actor: string; action: string; details_json: string } | undefined
  database.close()
  expect(audit).toMatchObject({ actor: 'copilot', action: 'copilot.tool.executed' })
  expect(JSON.parse(audit?.details_json ?? '{}')).toMatchObject({
    toolId: 'lookup_customer',
    code: 'ok',
    success: true
  })

  await page.getByTestId('hangup-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')
})

test('lets an enabled mock copilot end the current call after its turn', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.evaluate(() => {
    const target = window as unknown as LivePhoneWindow & {
      __endCallProbe?: { requested: boolean; assistantEntriesAfterRequest: string[] }
    }
    target.__endCallProbe = { requested: false, assistantEntriesAfterRequest: [] }
    target.livePhone.onEvent((event) => {
      if (event.type === 'call-end-requested') target.__endCallProbe!.requested = true
      if (
        event.type === 'transcript' &&
        event.entry.speaker === 'assistant' &&
        target.__endCallProbe?.requested
      ) {
        target.__endCallProbe.assistantEntriesAfterRequest.push(event.entry.id)
      }
    })
  })

  await page.getByRole('button', { name: 'Edit Default Campaign' }).click()
  await page.getByTestId('copilot-section').locator('summary').click()
  await page.getByTestId('copilot-enabled').check()
  await page.getByTestId('copilot-mode').selectOption('transcript')
  await page.getByTestId('copilot-prompt').fill('When they ask to end, say a polite farewell and hang up.')
  await page.getByTestId('copilot-tools').fill('end_call')
  await page.getByTestId('save-campaign-button').click()
  await expect(page.getByTestId('campaign-editor')).toBeHidden()

  await page.getByTestId('simulate-incoming-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Incoming ring')
  await page.getByTestId('answer-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('On a call')
  await expect(page.getByTestId('copilot-last-tool')).toHaveText('end_call')
  await expect(page.getByTestId('call-status')).toHaveText('On a call')
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')

  const calls = await page.evaluate(() =>
    (window as unknown as LivePhoneWindow).livePhone.listCalls({ limit: 1, offset: 0 })
  )
  expect(calls).toHaveLength(1)
  const callId = calls[0]?.id
  if (!callId) throw new Error('Expected the ended call to be persisted')
  const detail = await page.evaluate(
    (id) => (window as unknown as LivePhoneWindow).livePhone.getCall(id),
    callId
  )
  expect(detail?.endReason).toBe('local_hangup')

  const database = new DatabaseSync(join(userDataDirectory, 'calls.sqlite3'), { readOnly: true })
  const audit = database.prepare(`
    SELECT actor, details_json FROM audit_log
    WHERE action = 'copilot.call.end_requested' ORDER BY id DESC LIMIT 1
  `).get() as { actor: string; details_json: string } | undefined
  const waited = database.prepare(`
    SELECT actor, details_json FROM audit_log
    WHERE action = ? ORDER BY id DESC LIMIT 1
  `).get(END_CALL_WAIT_AUDIT_ACTION) as { actor: string; details_json: string } | undefined
  database.close()
  expect(audit?.actor).toBe('copilot')
  expect(JSON.parse(audit?.details_json ?? '{}')).toMatchObject({
    reason: 'callee_requested',
    farewell_said: true
  })
  expect(waited?.actor).toBe('copilot')
  expect(JSON.parse(waited?.details_json ?? '{}')).toMatchObject({
    waitReason: 'turn_done',
    waitedMs: expect.any(Number)
  })
  expect(await page.evaluate(() => (
    window as unknown as {
      __endCallProbe?: { requested: boolean; assistantEntriesAfterRequest: string[] }
    }
  ).__endCallProbe)).toEqual({ requested: true, assistantEntriesAfterRequest: [] })
})

test('reaches and approves local approval for an appointment copilot tool', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.getByRole('button', { name: 'Edit Default Campaign' }).click()
  await page.getByTestId('copilot-section').locator('summary').click()
  await page.getByTestId('copilot-enabled').check()
  await page.getByTestId('copilot-mode').selectOption('transcript')
  await page.getByTestId('copilot-tools').fill('appointments_make')
  await page.getByTestId('save-campaign-button').click()
  await expect(page.getByTestId('campaign-editor')).toBeHidden()

  await page.evaluate(() => {
    const target = window as unknown as LivePhoneWindow & { __copilotInjections?: string[] }
    target.__copilotInjections = []
    target.livePhone.onEvent((event) => {
      if (event.type === 'copilot-injected') target.__copilotInjections?.push(event.text)
    })
  })

  await page.getByTestId('simulate-incoming-button').click()
  await page.getByTestId('answer-button').click()
  const approval = page.getByTestId('approval-modal')
  await expect(approval).toBeVisible()
  await expect(approval.getByRole('heading')).toContainText('appointments_make')
  await expect(page.getByTestId('approval-countdown')).toContainText('remaining')
  await page.getByTestId('approval-approve').click()
  await expect(approval).toBeHidden()
  await expect.poll(
    () => page.evaluate(() =>
      ((window as unknown as { __copilotInjections?: string[] }).__copilotInjections ?? []).length
    ),
    { timeout: 10_000 }
  ).toBe(1)
  await expect(page.getByTestId('copilot-last-tool')).toHaveText('appointments_make')

  const database = new DatabaseSync(join(userDataDirectory, 'calls.sqlite3'), { readOnly: true })
  const audit = database.prepare(`
    SELECT details_json FROM audit_log
    WHERE action = 'copilot.tool.executed'
  `).get() as { details_json: string } | undefined
  database.close()
  expect(JSON.parse(audit?.details_json ?? '{}')).toMatchObject({
    toolId: 'appointments_make',
    code: 'ok',
    success: true
  })

  await page.getByTestId('hangup-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')
})

test('shows copilot approval before timing out and audits the denial', async () => {
  await application.close()
  application = await launchApplication({
    LIVE_PHONE_APPROVAL_TIMEOUT_MS: '300'
  })
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.getByRole('button', { name: 'Edit Default Campaign' }).click()
  await page.getByTestId('copilot-section').locator('summary').click()
  await page.getByTestId('copilot-enabled').check()
  await page.getByTestId('copilot-mode').selectOption('transcript')
  await page.getByTestId('copilot-tools').fill('appointments_make')
  await page.getByTestId('save-campaign-button').click()
  await expect(page.getByTestId('campaign-editor')).toBeHidden()

  await page.evaluate(() => {
    const target = window as unknown as LivePhoneWindow & { __approvalRequests?: string[] }
    target.__approvalRequests = []
    target.livePhone.onApprovalRequested((request) => target.__approvalRequests?.push(request.title))
  })
  await page.getByTestId('simulate-incoming-button').click()
  await page.getByTestId('answer-button').click()
  await expect(page.getByTestId('approval-modal')).toBeVisible()
  await expect(page.getByTestId('approval-modal').getByRole('heading')).toContainText('appointments_make')
  await expect(page.getByTestId('approval-modal')).toBeHidden()
  await expect(page.getByTestId('approval-timeout')).toHaveText('Timed out')
  await expect.poll(
    () => page.evaluate(() =>
      ((window as unknown as { __approvalRequests?: string[] }).__approvalRequests ?? []).length
    )
  ).toBe(1)

  await expect.poll(() => {
    const database = new DatabaseSync(join(userDataDirectory, 'calls.sqlite3'), { readOnly: true })
    try {
      const row = database.prepare(`
        SELECT details_json FROM audit_log
        WHERE action = 'copilot.tool.executed'
        ORDER BY id DESC LIMIT 1
      `).get() as { details_json: string } | undefined
      return row ? JSON.parse(row.details_json) : undefined
    } finally {
      database.close()
    }
  }, { timeout: 10_000 }).toMatchObject({
    toolId: 'appointments_make',
    code: 'approval_denied',
    success: false
  })

  await page.getByTestId('hangup-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')
})

test('interrupts a stale mock copilot tool result and injects only the reevaluated turn', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.getByRole('button', { name: 'Edit Default Campaign' }).click()
  await page.getByTestId('copilot-section').locator('summary').click()
  await page.getByTestId('copilot-enabled').check()
  await page.getByTestId('copilot-mode').selectOption('transcript')
  await page.getByTestId('copilot-prompt').fill('If the caller changes their mind, re-evaluate whether a lookup is still needed.')
  await page.getByTestId('copilot-tools').fill('lookup_customer')
  await page.getByTestId('save-campaign-button').click()
  await expect(page.getByTestId('campaign-editor')).toBeHidden()

  await page.evaluate(() => {
    const target = window as unknown as LivePhoneWindow & {
      __interruptCopilot?: {
        sent: boolean
        injections: string[]
        statuses: Array<{ state: string; generation?: number; pendingToolId?: string }>
      }
    }
    target.__interruptCopilot = { sent: false, injections: [], statuses: [] }
    target.livePhone.onEvent((event) => {
      const state = target.__interruptCopilot
      if (!state) return
      if (event.type === 'copilot-status') {
        state.statuses.push({
          state: event.status.state,
          generation: event.status.generation,
          pendingToolId: event.status.pendingToolId
        })
        if (event.status.state === 'tool' && !state.sent) {
          state.sent = true
          void target.livePhone.reportTranscriptEntry({
            id: `e2e-copilot-interruption-${Date.now()}`,
            speaker: 'caller',
            text: 'Please re-evaluate the previous request; I still need the lookup.',
            final: true,
            timestamp: Date.now()
          })
        }
      } else if (event.type === 'copilot-injected') {
        state.injections.push(event.text)
      }
    })
  })

  await page.getByTestId('simulate-incoming-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Incoming ring')
  await page.getByTestId('answer-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('On a call')
  await expect.poll(
    () => page.evaluate(() =>
      (window as unknown as { __interruptCopilot?: { injections: string[] } })
        .__interruptCopilot?.injections.length ?? 0
    ),
    { timeout: 10_000 }
  ).toBe(1)
  await page.waitForTimeout(500)

  const observed = await page.evaluate(() =>
    (window as unknown as {
      __interruptCopilot?: {
        injections: string[]
        statuses: Array<{ state: string; generation?: number; pendingToolId?: string }>
      }
    }).__interruptCopilot
  )
  expect(observed?.injections).toHaveLength(1)
  expect(observed?.injections[0]).toContain('lookup_customer')
  expect(observed?.statuses).toContainEqual(expect.objectContaining({
    state: 'tool',
    generation: 0,
    pendingToolId: 'lookup_customer'
  }))
  expect(observed?.statuses).toContainEqual(expect.objectContaining({
    state: 'interrupted',
    generation: 1
  }))
  expect(observed?.statuses).toContainEqual(expect.objectContaining({
    state: 'tool',
    generation: 1,
    pendingToolId: 'lookup_customer'
  }))

  const database = new DatabaseSync(join(userDataDirectory, 'calls.sqlite3'), { readOnly: true })
  const discarded = database.prepare(`
    SELECT action, details_json FROM audit_log
    WHERE action = ?
  `).all(COPILOT_INJECTION_DISCARDED) as Array<{ action: string; details_json: string }>
  database.close()
  expect(discarded).toHaveLength(1)
  expect(discarded[0]?.action).toBe(COPILOT_INJECTION_DISCARDED)
  expect(JSON.parse(discarded[0]?.details_json ?? '{}')).toMatchObject({
    toolId: 'lookup_customer',
    generation: 0
  })

  await page.getByTestId('hangup-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')
})

test('records a tentative copilot appointment and shows it in call history', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.getByTestId('tab-settings').click()
  await expect(page.getByTestId('settings-section-appointments')).toBeVisible()
  await expect(page.getByTestId('appointments-save')).toBeEnabled()
  await page.getByTestId('appointments-time-zone').fill('America/Chicago')
  await page.getByTestId('appointments-save').click()
  await expect(page.getByTestId('appointments-notice')).toContainText('saved')

  await page.getByTestId('tab-calls').click()
  await page.getByRole('button', { name: 'Edit Default Campaign' }).click()
  await page.getByTestId('copilot-section').locator('summary').click()
  await page.getByTestId('copilot-enabled').check()
  await page.getByTestId('copilot-mode').selectOption('transcript')
  await page.getByTestId('copilot-tools').fill('appointments_make')
  await page.getByTestId('copilot-risk-draft-write').check()
  await page.getByTestId('save-campaign-button').click()

  await runMockIncomingCall(page)
  await expect.poll(async () => {
    const appointments = await page.evaluate(() =>
      (window as unknown as LivePhoneWindow).livePhone.listAppointments({ limit: 10, offset: 0 })
    )
    return appointments[0]?.status
  }, { timeout: 10_000 }).toBe('tentative')

  await page.getByTestId('tab-history').click()
  await page.getByTestId('history-row').click()
  await expect(page.getByTestId('history-appointment')).toHaveCount(1)
  await expect(page.getByTestId('history-appointments')).toContainText('Tentative')
})

test('auto-confirms a copilot appointment after the call ends', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.getByTestId('tab-settings').click()
  await expect(page.getByTestId('settings-section-appointments')).toBeVisible()
  await expect(page.getByTestId('appointments-save')).toBeEnabled()
  await page.getByTestId('appointments-time-zone').fill('America/Chicago')
  await page.getByTestId('appointments-auto-confirm').check()
  await page.getByTestId('appointments-save').click()
  await expect(page.getByTestId('appointments-notice')).toContainText('saved')

  await page.getByTestId('tab-calls').click()
  await page.getByRole('button', { name: 'Edit Default Campaign' }).click()
  await page.getByTestId('copilot-section').locator('summary').click()
  await page.getByTestId('copilot-enabled').check()
  await page.getByTestId('copilot-mode').selectOption('transcript')
  await page.getByTestId('copilot-tools').fill('appointments_make')
  await page.getByTestId('copilot-risk-draft-write').check()
  await page.getByTestId('save-campaign-button').click()

  await runMockIncomingCall(page)
  await expect.poll(() => {
    const database = new DatabaseSync(join(userDataDirectory, 'calls.sqlite3'))
    try {
      const appointment = database.prepare('SELECT status FROM appointments ORDER BY created_at DESC LIMIT 1').get() as { status: string } | undefined
      const audit = database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'appointment.confirmed'").get() as { count: number }
      return { status: appointment?.status, audit: audit.count }
    } finally {
      database.close()
    }
  }, { timeout: 10_000 }).toEqual({ status: 'confirmed', audit: 1 })

  await page.getByTestId('tab-history').click()
  await page.getByTestId('history-row').click()
  await expect(page.getByTestId('history-appointments')).toContainText('Confirmed')
})

test('serves masked phone status and call history over authenticated MCP', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('tab-settings').click()
  await page.getByTestId('mcp-enabled').check()
  await expect(page.getByTestId('mcp-running')).toHaveText('Running')

  const status = await page.evaluate(() => window.livePhone.getMcpStatus())
  const token = (await readFile(join(userDataDirectory, 'mcp', 'token'), 'utf8')).trim()
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  ])
  const client = new Client({ name: 'live-phone-e2e', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(status.endpoint as string), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  }))

  const phoneStatus = await client.callTool({ name: 'phone_get_status', arguments: {} })
  expect(phoneStatus.structuredContent).toMatchObject({ runtimeMode: 'mock', phoneConnection: 'ready' })

  await page.getByTestId('tab-calls').click()
  await runMockIncomingCall(page)
  const callsResult = await client.callTool({ name: 'call_list', arguments: { limit: 10, offset: 0 } })
  const calls = (callsResult.structuredContent as { calls: Array<{ peer: string }> }).calls
  expect(calls).toHaveLength(1)
  expect(calls[0]?.peer).toContain('*')
  expect(calls[0]?.peer).not.toContain('4155550142')
  await client.close()
})

test('requires local approval for MCP dialing and times out fail-closed', async () => {
  await application.close()
  application = await launchApplication({
    LIVE_PHONE_APPROVAL_TIMEOUT_MS: '1000'
  })
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('tab-settings').click()
  await page.getByTestId('mcp-enabled').check()
  await page.getByTestId('mcp-scope-control_calls').check()
  await expect(page.getByTestId('mcp-running')).toHaveText('Running')

  const status = await page.evaluate(() => window.livePhone.getMcpStatus())
  const token = (await readFile(join(userDataDirectory, 'mcp', 'token'), 'utf8')).trim()
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  ])
  const client = new Client({ name: 'live-phone-control-e2e', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(status.endpoint as string), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  }))

  const dial = client.callTool({
    name: 'call_dial',
    arguments: { peer: '+17735550100', idempotency_key: 'e2e-approved' }
  })
  await expect(page.getByTestId('approval-modal')).toBeVisible()
  await page.getByTestId('approval-approve').click()
  expect((await dial).isError).not.toBe(true)
  await page.getByTestId('tab-calls').click()
  await expect(page.getByTestId('call-status')).toHaveText('On a call')

  const hangup = await client.callTool({ name: 'call_hangup', arguments: {} })
  expect(hangup.isError).not.toBe(true)
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')

  const timedOut = client.callTool({
    name: 'call_dial',
    arguments: { peer: '+17735550101', idempotency_key: 'e2e-timeout' }
  })
  await expect(page.getByTestId('approval-modal')).toBeVisible()
  const timeoutResult = await timedOut
  expect(timeoutResult.isError).toBe(true)
  expect(timeoutResult.structuredContent).toMatchObject({ error: { code: 'APPROVAL_TIMEOUT' } })
  await client.close()
})

test('completes the API parity workflow without UI interaction', async () => {
  await application.close()
  const mcpDirectory = join(userDataDirectory, 'mcp')
  mkdirSync(mcpDirectory, { recursive: true })
  writeFileSync(join(mcpDirectory, 'settings.json'), JSON.stringify({
    enabled: true,
    scopes: ['read', 'manage_campaigns', 'control_calls', 'send_messages']
  }))
  application = await launchApplication({
    LIVE_PHONE_APPROVAL_TIMEOUT_MS: '10000'
  })
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('twilio-status')).toContainText('Connected')

  const endpointFile = join(mcpDirectory, 'endpoint.json')
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(endpointFile, 'utf8')).endpoint as string }
    catch { return undefined }
  }).toContain('/mcp')
  const endpoint = JSON.parse(await readFile(endpointFile, 'utf8')).endpoint as string
  const base = endpoint.replace(/\/mcp$/, '/v1')
  const token = (await readFile(join(mcpDirectory, 'token'), 'utf8')).trim()
  let writeSequence = 0
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const method = init.method ?? 'GET'
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method !== 'GET' ? { 'content-type': 'application/json', 'Idempotency-Key': `e2e-api-${writeSequence++}` } : {}),
        ...init.headers
      }
    })
    const body = await response.json() as T & { error?: unknown }
    if (!response.ok) throw new Error(`API ${method} ${path} failed (${response.status}): ${JSON.stringify(body)}`)
    return body
  }

  const workspace = await api<{ selectedCampaignId: string; campaigns: Array<Record<string, unknown>> }>('/campaigns?reveal=true')
  const selected = workspace.campaigns.find(({ id }) => id === workspace.selectedCampaignId) as Record<string, unknown>
  const policy = selected.policy as Record<string, unknown>
  await api(`/campaigns/${workspace.selectedCampaignId}?reveal=true`, {
    method: 'PUT',
    body: JSON.stringify({
      policy: {
        ...policy,
        persona: 'API parity receptionist',
        copilot: {
          enabled: true,
          mode: 'transcript',
          prompt: 'Record an appointment request when appropriate.',
          allowedToolIds: ['appointments_make'],
          autoExecuteRisks: ['read', 'draft-write'],
          maxToolCallsPerTurn: 3
        }
      }
    })
  })

  const incoming = await api<{ status: { call?: { status: string } } }>('/debug/simulate-incoming', {
    method: 'POST', body: JSON.stringify({ peer: '+14155550142' })
  })
  expect(incoming.status.call?.status).toBe('ringing')
  const answered = await api<{ status: { call?: { status: string } } }>('/calls/current/answer', {
    method: 'POST', body: '{}'
  })
  expect(answered.status.call?.status).toBe('active')
  await new Promise((resolve) => setTimeout(resolve, 1600))
  const hungUp = await api<{ status: { call?: { status: string } } }>('/calls/current/hangup', {
    method: 'POST', body: '{}'
  })
  expect(hungUp.status.call?.status).toBe('ended')

  await expect.poll(async () => (await api<{ calls: Array<{ status: string }> }>('/calls')).calls[0]?.status).toBe('ended')
  const calls = await api<{ calls: Array<{ id: string; status: string }> }>('/calls')
  const callId = calls.calls[0]?.id as string
  const transcript = await api<{ transcript: unknown[] }>(`/calls/${callId}/transcript`)
  expect(transcript.transcript.length).toBeGreaterThanOrEqual(2)
  let recording: { status: string; bytes?: number } | undefined
  await expect.poll(async () => {
    try {
      const current = await api<{ status: string; bytes?: number }>(`/calls/${callId}/recording`)
      recording = current
      return current.status
    } catch { return undefined }
  }, { timeout: 15_000 }).toBe('complete')
  const completedRecording = recording as { status: string; bytes?: number }
  const audio = await fetch(`${base}/calls/${callId}/recording/audio`, { headers: { Authorization: `Bearer ${token}` } })
  expect(audio.status).toBe(200)
  expect((await audio.arrayBuffer()).byteLength).toBe(completedRecording.bytes)
  const appointments = await api<{ appointments: unknown[] }>(`/calls/${callId}/appointments`)
  expect(Array.isArray(appointments.appointments)).toBe(true)

  const webhook = await startWebhookEndpoint()
  try {
    await api('/settings/webhook', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, url: `${webhook.baseUrl}/hook`, events: ['webhook.test', 'approval.requested'] })
    })
    const delivery = await api<{ status: string }>('/settings/webhook/test', { method: 'POST', body: '{}' })
    expect(delivery.status).toBe('delivered')

    const dial = await api<{ approvalId: string }>('/calls', {
      method: 'POST', body: JSON.stringify({ peer: '+17735550100', idempotencyKey: 'api-approved-dial' })
    })
    const pending = await api<{ approvals: Array<{ id: string }> }>('/approvals')
    expect(pending.approvals.map(({ id }) => id)).toContain(dial.approvalId)
    await api(`/approvals/${dial.approvalId}/decide`, {
      method: 'POST', body: JSON.stringify({ approved: true })
    })
    await expect.poll(async () => (await api<{ phone: { call?: { status: string } } }>('/status')).phone.call?.status).toBe('active')
    await expect.poll(() => webhook.requests.some((request) => request.headers['x-mishu-event'] === 'approval.requested')).toBe(true)
    await api('/calls/current/hangup', { method: 'POST', body: '{}' })
  } finally {
    await webhook.close()
  }
})

test('runs approved, budgeted, and CLI call tasks end to end', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('tab-settings').click()
  await page.getByTestId('mcp-enabled').check()
  await page.getByTestId('mcp-scope-control_calls').check()
  await expect(page.getByTestId('mcp-running')).toHaveText('Running')
  const mcpDirectory = join(userDataDirectory, 'mcp')
  await expect(page.getByTestId('twilio-status')).toContainText('Connected')

  const endpointFile = join(mcpDirectory, 'endpoint.json')
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(endpointFile, 'utf8')).endpoint as string }
    catch { return undefined }
  }).toContain('/mcp')
  const endpoint = JSON.parse(await readFile(endpointFile, 'utf8')).endpoint as string
  const base = endpoint.replace(/\/mcp$/, '/v1')
  const token = (await readFile(join(mcpDirectory, 'token'), 'utf8')).trim()
  let writeSequence = 0
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const method = init.method ?? 'GET'
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method !== 'GET' ? { 'content-type': 'application/json', 'Idempotency-Key': `task-e2e-${writeSequence++}` } : {}),
        ...init.headers
      }
    })
    const body = await response.json() as T & { error?: unknown }
    if (!response.ok) throw new Error(`API ${method} ${path} failed (${response.status}): ${JSON.stringify(body)}`)
    return body
  }
  const resultSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['attending'],
    properties: { attending: { type: ['boolean', 'null'] } }
  }

  const first = await api<{ taskId: string; status: string }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      to: '+17735550110', goal: 'Confirm attendance', resultSchema,
      idempotencyKey: 'task-e2e-approved'
    })
  })
  expect(first.status).toBe('queued')
  await expect.poll(async () => (await api<{ status: string }>(`/tasks/${first.taskId}`)).status).toBe('awaiting_approval')
  const pending = await api<{ approvals: Array<{ id: string; kind: string }> }>('/approvals')
  const approval = pending.approvals.find(({ kind }) => kind === 'call_dial')
  expect(approval).toBeTruthy()
  await api(`/approvals/${approval?.id}/decide`, {
    method: 'POST', body: JSON.stringify({ approved: true })
  })
  await page.getByTestId('approval-approve').click()
  await expect(page.getByTestId('approval-modal')).toBeHidden()
  const approvedResult = await api<{
    status: string; outcome?: string; result?: unknown; callId?: string
    transcript?: TranscriptEntry[]
    analysis?: { summary: string; confidence: string; resultId: string }
  }>(
    `/tasks/${first.taskId}/wait?timeoutMs=10000&include=transcript,analysis`
  )
  expect(approvedResult).toMatchObject({ status: 'completed', outcome: 'reached' })
  expect(approvedResult.result).toEqual({ attending: false })
  expect(approvedResult.callId).toBeTruthy()
  expect(approvedResult.transcript?.length).toBeGreaterThanOrEqual(2)
  expect(approvedResult.analysis).toMatchObject({
    resultId: expect.any(String), summary: expect.any(String), confidence: expect.any(String)
  })
  const audit = await api<{ audit: Array<{ action: string }> }>(
    `/calls/${approvedResult.callId}/audit?limit=100`
  )
  expect(audit.audit.some(({ action }) => action === 'call.ended')).toBe(true)

  const allowedNumbers = ['+17735550111', '+17735550112']
  await api('/settings/budget', {
    method: 'PUT',
    body: JSON.stringify({
      enabled: true, dailyMaxCalls: 10, dailyMaxMinutes: 60,
      allowedPrefixes: [], allowedNumbers,
      allowedHours: { timeZone: 'UTC', windows: [] }, killSwitch: false
    })
  })
  const approvalsBefore = (await api<{ approvals: unknown[] }>('/approvals')).approvals.length
  const direct = await api<{ taskId: string }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      to: allowedNumbers[0], goal: 'Confirm the budgeted task', resultSchema,
      idempotencyKey: 'task-e2e-budgeted'
    })
  })
  const directResult = await api<{ status: string; outcome?: string }>(`/tasks/${direct.taskId}/wait?timeoutMs=10000`)
  expect(directResult).toMatchObject({ status: 'completed', outcome: 'reached' })
  expect((await api<{ approvals: unknown[] }>('/approvals')).approvals).toHaveLength(approvalsBefore)

  const { execFile } = await import('node:child_process')
  const cliResult = await new Promise<{ stdout: string }>((resolve, reject) => {
    execFile(process.execPath, [
      join(process.cwd(), 'apps/cli/mishu.mjs'),
      'task', 'submit', '--to', allowedNumbers[1], '--goal', 'Confirm from CLI',
      '--wait', '--timeout', '10', '--endpoint', base, '--token', token
    ], { env: { ...process.env } }, (error, stdout, stderr) => {
      if (error) reject(new Error(`CLI failed: ${stderr || error.message}`))
      else resolve({ stdout })
    })
  })
  expect(JSON.parse(cliResult.stdout)).toMatchObject({ status: 'completed', outcome: 'reached' })

  await page.getByTestId('tab-tasks').click()
  await expect(page.getByTestId('tasks-list')).toBeVisible()
  await expect(page.getByTestId(`task-${first.taskId}`)).toContainText('Completed')
  await page.getByTestId('tab-settings').click()
  await expect(page.getByTestId('settings-section-budget')).toBeVisible()
})

test('runs an approved HTTP task with an inline campaign without changing the UI selection', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  const selectedBefore = await page.evaluate(async () => {
    const workspace = await window.livePhone.getCampaignWorkspace()
    return workspace.selectedCampaignId
  })

  await page.getByTestId('tab-settings').click()
  await page.getByTestId('mcp-enabled').check()
  await page.getByTestId('mcp-scope-control_calls').check()
  await expect(page.getByTestId('mcp-running')).toHaveText('Running')

  const mcpDirectory = join(userDataDirectory, 'mcp')
  const endpointFile = join(mcpDirectory, 'endpoint.json')
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(endpointFile, 'utf8')).endpoint as string }
    catch { return undefined }
  }).toContain('/mcp')
  const endpoint = JSON.parse(await readFile(endpointFile, 'utf8')).endpoint as string
  const base = endpoint.replace(/\/mcp$/, '/v1')
  const token = (await readFile(join(mcpDirectory, 'token'), 'utf8')).trim()
  let writeSequence = 0
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const method = init.method ?? 'GET'
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method !== 'GET'
          ? { 'content-type': 'application/json', 'Idempotency-Key': `inline-task-e2e-${writeSequence++}` }
          : {}),
        ...init.headers
      }
    })
    const body = await response.json() as T & { error?: unknown }
    if (!response.ok) throw new Error(`API ${method} ${path} failed (${response.status}): ${JSON.stringify(body)}`)
    return body
  }

  const inlineCampaignName = 'HTTP Inline Campaign'
  const submitted = await api<{ taskId: string; status: string }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      to: '+17735550113',
      goal: 'Confirm the inline campaign task',
      campaign: {
        name: inlineCampaignName,
        direction: 'outbound',
        systemPrompt: 'Use the inline campaign for this call only.',
        voice: 'sol'
      },
      idempotencyKey: 'inline-campaign-task-e2e'
    })
  })
  expect(submitted.status).toBe('queued')
  await expect.poll(async () =>
    (await api<{ status: string }>(`/tasks/${submitted.taskId}`)).status
  ).toBe('awaiting_approval')

  const pending = await api<{ approvals: Array<{ id: string; kind: string }> }>('/approvals')
  const approval = pending.approvals.find(({ kind }) => kind === 'call_dial')
  expect(approval).toBeTruthy()
  await api(`/approvals/${approval?.id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ approved: true })
  })
  await expect(page.getByTestId('approval-modal')).toBeVisible()
  await page.getByTestId('approval-approve').click()
  await expect(page.getByTestId('approval-modal')).toBeHidden()

  await expect.poll(async () =>
    (await api<{ status: string }>(`/tasks/${submitted.taskId}`)).status,
  { timeout: 5_000, intervals: [10, 20, 50, 100] }).toBe('in_call')
  const completed = await api<{ status: string; outcome?: string; callId?: string }>(
    `/tasks/${submitted.taskId}/wait?timeoutMs=10000`
  )
  expect(completed).toMatchObject({ status: 'completed', outcome: 'reached' })
  expect(completed.callId).toBeTruthy()

  const call = await page.evaluate(
    (id) => window.livePhone.getCall(id),
    completed.callId as string
  )
  expect(call?.campaignName).toBe(inlineCampaignName)
  const selectedAfter = await page.evaluate(async () => {
    const workspace = await window.livePhone.getCampaignWorkspace()
    return workspace.selectedCampaignId
  })
  expect(selectedAfter).toBe(selectedBefore)
})

test('uses the saved systemPrompt when an HTTP-created policy campaign starts a task call', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('tab-settings').click()
  await page.getByTestId('mcp-enabled').check()
  await page.getByTestId('mcp-scope-control_calls').check()
  await expect(page.getByTestId('mcp-running')).toHaveText('Running')

  const mcpDirectory = join(userDataDirectory, 'mcp')
  const endpointFile = join(mcpDirectory, 'endpoint.json')
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(endpointFile, 'utf8')).endpoint as string }
    catch { return undefined }
  }).toContain('/mcp')
  const endpoint = JSON.parse(await readFile(endpointFile, 'utf8')).endpoint as string
  const base = endpoint.replace(/\/mcp$/, '/v1')
  const token = (await readFile(join(mcpDirectory, 'token'), 'utf8')).trim()
  let writeSequence = 0
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const method = init.method ?? 'GET'
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method !== 'GET' ? {
          'content-type': 'application/json',
          'Idempotency-Key': `saved-policy-task-e2e-${writeSequence++}`
        } : {}),
        ...init.headers
      }
    })
    const body = await response.json() as T
    if (!response.ok) {
      throw new Error(`API ${method} ${path} failed (${response.status}): ${JSON.stringify(body)}`)
    }
    return body
  }

  const systemPrompt = 'Open with the saved appointment reminder script.'
  const workspace = await api<{
    selectedCampaignId: string
    campaigns: Array<{ id: string; name: string; systemPrompt: string; policy: { persona: string } }>
  }>('/campaigns?reveal=true', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Saved HTTP Policy Campaign',
      direction: 'outbound',
      systemPrompt,
      voice: 'sol',
      policy: {
        recordingDisclosure: false,
        maxCallDurationSec: 180,
        copilot: { enabled: false }
      }
    })
  })
  const campaign = workspace.campaigns.find(({ name }) => name === 'Saved HTTP Policy Campaign')
  expect(campaign).toMatchObject({ systemPrompt, policy: { persona: '' } })

  const submitted = await api<{ taskId: string; status: string }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      to: '+17735550114',
      goal: 'Confirm the appointment time.',
      campaignId: campaign?.id,
      idempotencyKey: 'saved-policy-campaign-task-e2e'
    })
  })
  expect(submitted.status).toBe('queued')
  await expect.poll(async () =>
    (await api<{ status: string }>(`/tasks/${submitted.taskId}`)).status
  ).toBe('awaiting_approval')

  const pending = await api<{ approvals: Array<{ id: string; kind: string }> }>('/approvals')
  const approval = pending.approvals.find(({ kind }) => kind === 'call_dial')
  expect(approval).toBeTruthy()
  await api(`/approvals/${approval?.id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ approved: true })
  })
  await expect(page.getByTestId('approval-modal')).toBeVisible()
  await page.getByTestId('approval-approve').click()
  await expect(page.getByTestId('approval-modal')).toBeHidden()

  const completed = await api<{ status: string; callId?: string }>(
    `/tasks/${submitted.taskId}/wait?timeoutMs=10000`
  )
  expect(completed.status).toBe('completed')
  const database = new DatabaseSync(join(userDataDirectory, 'calls.sqlite3'), { readOnly: true })
  const call = database.prepare(`
    SELECT campaign_id, campaign_name, campaign_system_prompt
    FROM call_sessions WHERE id = ?
  `).get(completed.callId!) as {
    campaign_id: string
    campaign_name: string
    campaign_system_prompt: string
  }
  database.close()
  expect(call).toEqual({
    campaign_id: campaign?.id,
    campaign_name: 'Saved HTTP Policy Campaign',
    campaign_system_prompt: systemPrompt
  })
})

test('quits promptly after an incoming call is hidden to the tray', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('simulate-incoming-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Incoming ring')

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => ({
    count: BrowserWindow.getAllWindows().length,
    visible: BrowserWindow.getAllWindows()[0]?.isVisible()
  }))).toEqual({ count: 1, visible: false })

  const startedAt = Date.now()
  const exited = new Promise<void>((resolve) => application.process().once('exit', () => resolve()))
  void application.evaluate(({ app }) => app.quit()).catch(() => undefined)
  await exited
  expect(Date.now() - startedAt).toBeLessThan(5_000)
})

test('keeps HTTP tasks and incoming calls alive after the window closes to tray', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('tab-settings').click()
  await expect(page.getByTestId('settings-section-general')).toBeVisible()
  await expect(page.getByTestId('general-minimize-to-tray')).toBeChecked()
  await page.getByTestId('mcp-enabled').check()
  await expect(page.getByTestId('mcp-running')).toHaveText('Running')

  const mcpDirectory = join(userDataDirectory, 'mcp')
  const endpointFile = join(mcpDirectory, 'endpoint.json')
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(endpointFile, 'utf8')).endpoint as string }
    catch { return undefined }
  }).toContain('/mcp')
  const endpoint = JSON.parse(await readFile(endpointFile, 'utf8')).endpoint as string
  const base = endpoint.replace(/\/mcp$/, '/v1')
  const token = (await readFile(join(mcpDirectory, 'token'), 'utf8')).trim()
  let writeSequence = 0
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const method = init.method ?? 'GET'
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method !== 'GET' ? {
          'content-type': 'application/json',
          'Idempotency-Key': `background-e2e-${writeSequence++}`
        } : {}),
        ...init.headers
      }
    })
    const body = await response.json() as T
    if (!response.ok) throw new Error(`API ${method} ${path} failed (${response.status}): ${JSON.stringify(body)}`)
    return body
  }

  const updated = await api<{
    minimizeToTray: boolean
    launchAtLogin: boolean
    startHidden: boolean
  }>('/settings/general', {
    method: 'PUT',
    body: JSON.stringify({ minimizeToTray: true, launchAtLogin: false, startHidden: true })
  })
  expect(updated).toEqual({ minimizeToTray: true, launchAtLogin: false, startHidden: true })
  await expect(api('/settings/general')).resolves.toEqual(updated)

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => ({
    count: BrowserWindow.getAllWindows().length,
    visible: BrowserWindow.getAllWindows()[0]?.isVisible()
  }))).toEqual({ count: 1, visible: false })

  await expect(api<{ phone: { phoneConnection: string } }>('/status')).resolves.toMatchObject({
    phone: { phoneConnection: 'ready' }
  })
  const incoming = await api<{ status: { call?: { status: string } } }>('/debug/simulate-incoming', {
    method: 'POST',
    body: JSON.stringify({ peer: '+14155550142' })
  })
  expect(incoming.status.call?.status).toBe('ringing')
  await expect.poll(async () => (await api<{ calls: Array<{ status: string }> }>('/calls')).calls[0]?.status)
    .toBe('ringing')

  await application.close()
  application = await launchApplication()
  const hiddenPage = await application.firstWindow()
  await hiddenPage.waitForLoadState('domcontentloaded')
  await expect.poll(() => application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false)
  await application.evaluate(({ app }) => { app.emit('activate') })
  await expect.poll(() => application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true)
})

test('uses an HTTP contact card in contact_lookup and preserves its call snapshot', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.evaluate(async () => {
    const api = (window as unknown as LivePhoneWindow).livePhone
    const workspace = await api.getCampaignWorkspace()
    const selected = workspace.campaigns.find(({ id }) => id === workspace.selectedCampaignId)
    if (!selected) throw new Error('Selected campaign not found')
    await api.saveCampaign({
      ...selected,
      policy: {
        ...selected.policy,
        copilot: {
          enabled: true,
          mode: 'transcript',
          prompt: 'Look up the local contact card for the current call first.',
          allowedToolIds: ['contact_lookup'],
          autoExecuteRisks: ['read'],
          maxToolCallsPerTurn: 2,
          mayEndCall: true
        }
      }
    })
    await api.setMcpEnabled(true)
    const target = window as unknown as LivePhoneWindow & { __contactInjections?: string[] }
    target.__contactInjections = []
    api.onEvent((event) => {
      if (event.type === 'copilot-injected') target.__contactInjections?.push(event.text)
    })
  })

  const endpointFile = join(userDataDirectory, 'mcp', 'endpoint.json')
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(endpointFile, 'utf8')).endpoint as string }
    catch { return undefined }
  }).toContain('/mcp')
  const endpoint = JSON.parse(await readFile(endpointFile, 'utf8')).endpoint as string
  const base = endpoint.replace(/\/mcp$/, '/v1')
  const token = (await readFile(join(userDataDirectory, 'mcp', 'token'), 'utf8')).trim()
  const response = await fetch(`${base}/contacts/%2B14155550142`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'Idempotency-Key': 'contact-card-e2e'
    },
    body: JSON.stringify({
      displayName: 'Ada Lovelace', company: 'Analytical Engines', tier: 'Gold',
      language: 'en', notes: 'Interested in the pilot.', source: 'e2e-agent'
    })
  })
  expect(response.status).toBe(200)

  await page.getByTestId('simulate-incoming-button').click()
  await page.getByTestId('answer-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('On a call')
  await expect(page.getByTestId('copilot-last-tool')).toHaveText('contact_lookup')
  await expect.poll(() => page.evaluate(() =>
    ((window as unknown as { __contactInjections?: string[] }).__contactInjections ?? [])
      .some((text) => text.includes('Ada Lovelace'))
  ), { timeout: 10_000 }).toBe(true)
  await expect.poll(() => {
    const database = new DatabaseSync(join(userDataDirectory, 'calls.sqlite3'), { readOnly: true })
    try {
      const row = database.prepare(`
        SELECT details_json FROM audit_log
        WHERE action = 'copilot.tool.executed' ORDER BY id DESC LIMIT 1
      `).get() as { details_json: string } | undefined
      return row ? JSON.parse(row.details_json).toolId : undefined
    } finally {
      database.close()
    }
  }, { timeout: 10_000 }).toBe('contact_lookup')

  await page.getByTestId('hangup-button').click()
  await expect(page.getByTestId('call-status')).toHaveText('Call ended')
  await page.getByTestId('tab-history').click()
  await expect(page.getByTestId('history-row')).toHaveCount(1)
  await page.getByTestId('history-row').click()
  await expect(page.getByTestId('history-contact-card')).toContainText('Ada Lovelace')
  await expect(page.getByTestId('history-contact-card')).toContainText('Analytical Engines')
})

test('uses an inline task campaign for copilot policy and ends the mock call', async () => {
  const page = await application.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('tab-settings').click()
  await page.getByTestId('mcp-enabled').check()
  await page.getByTestId('mcp-scope-control_calls').check()
  await expect(page.getByTestId('mcp-running')).toHaveText('Running')

  const mcpDirectory = join(userDataDirectory, 'mcp')
  const endpointFile = join(mcpDirectory, 'endpoint.json')
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(endpointFile, 'utf8')).endpoint as string }
    catch { return undefined }
  }).toContain('/mcp')
  const endpoint = JSON.parse(await readFile(endpointFile, 'utf8')).endpoint as string
  const base = endpoint.replace(/\/mcp$/, '/v1')
  const token = (await readFile(join(mcpDirectory, 'token'), 'utf8')).trim()
  let writeSequence = 0
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const method = init.method ?? 'GET'
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method !== 'GET' ? {
          'content-type': 'application/json',
          'Idempotency-Key': `inline-copilot-e2e-${writeSequence++}`
        } : {}),
        ...init.headers
      }
    })
    const body = await response.json() as T
    if (!response.ok) {
      throw new Error(`API ${method} ${path} failed (${response.status}): ${JSON.stringify(body)}`)
    }
    return body
  }

  const submitted = await api<{ taskId: string; status: string }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      to: '+17735550120',
      goal: 'End the mock call after the caller is finished.',
      campaign: {
        name: 'Ephemeral Copilot E2E',
        direction: 'outbound',
        systemPrompt: 'Politely complete this one-time call.',
        voice: 'sol',
        policy: {
          recordingDisclosure: false,
          copilot: {
            enabled: true,
            mode: 'transcript',
            prompt: 'End the call when the caller indicates the conversation is complete.',
            allowedToolIds: ['end_call'],
            autoExecuteRisks: ['read'],
            maxToolCallsPerTurn: 2,
            mayEndCall: true
          }
        }
      },
      idempotencyKey: 'inline-copilot-task-e2e'
    })
  })
  expect(submitted.status).toBe('queued')

  const task = await api<{ campaignId: string }>(`/tasks/${submitted.taskId}`)
  await expect.poll(async () =>
    (await api<{ status: string }>(`/tasks/${submitted.taskId}`)).status
  ).toBe('awaiting_approval')
  const pending = await api<{ approvals: Array<{ id: string; kind: string }> }>('/approvals')
  const approval = pending.approvals.find(({ kind }) => kind === 'call_dial')
  expect(approval).toBeTruthy()
  await api(`/approvals/${approval?.id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ approved: true })
  })
  await expect(page.getByTestId('approval-modal')).toBeVisible()
  await page.getByTestId('approval-approve').click()
  await expect(page.getByTestId('approval-modal')).toBeHidden()

  const completed = await api<{ status: string; callId?: string }>(
    `/tasks/${submitted.taskId}/wait?timeoutMs=10000`
  )
  expect(completed.status).toBe('completed')
  expect(completed.callId).toBeTruthy()
  const callId = completed.callId
  if (!callId) throw new Error('Expected the inline copilot task to persist a call')

  const call = await api<{ endReason?: string }>(`/calls/${callId}`)
  expect(call.endReason).toBe('local_hangup')

  const database = new DatabaseSync(join(userDataDirectory, 'calls.sqlite3'), { readOnly: true })
  const started = database.prepare(`
    SELECT COUNT(*) AS count, MIN(actor) AS actor, MAX(details_json) AS details_json,
      SUM(CASE WHEN call_id IS NULL THEN 1 ELSE 0 END) AS null_count
    FROM audit_log
    WHERE action = 'copilot.session.started' AND (call_id = ? OR call_id IS NULL)
  `).get(callId) as {
    count: number
    actor: string
    details_json: string
    null_count: number
  }
  const ended = database.prepare(`
    SELECT actor FROM audit_log
    WHERE action = 'copilot.call.end_requested' AND call_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(callId) as { actor: string } | undefined
  database.close()

  expect(started.count).toBe(1)
  expect(started.null_count).toBe(0)
  expect(started?.actor).toBe('copilot')
  expect(JSON.parse(started?.details_json ?? '{}')).toMatchObject({
    campaignId: task.campaignId,
    mode: 'transcript',
    tools: ['end_call']
  })
  expect(ended?.actor).toBe('copilot')
})

test('switches voice source and tests an OpenAI key with a free fake model endpoint', async () => {
  await application.close()
  const requests: string[] = []
  const fake = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.writeHead(request.url === '/v1/models/gpt-live-1' ? 200 : 400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: 'gpt-live-1' }))
  })
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
  try {
    application = await launchApplication({ OPENAI_API_KEY: '', OPENAI_PROJECT_ID: '', OPENAI_ORG_ID: '', LIVE_PHONE_OPENAI_TEST_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` })
    const page = await application.firstWindow()
    await page.getByTestId('tab-settings').click()
    await expect(page.getByRole('radiogroup', { name: 'Voice source' }).getByRole('radio', { name: /Codex app-server \(local\)/ })).toBeVisible()
    await page.getByRole('radiogroup', { name: 'Voice source' }).getByRole('radio', { name: /GPT Live API/ }).click()
    await expect(page.getByRole('radiogroup', { name: 'Session start timing' }).getByRole('radio', { name: 'On answer' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('codex-status')).toContainText('GPT Live · API')
    await page.getByLabel('OpenAI API key', { exact: true }).fill('fake-e2e-key-1234')
    await page.getByRole('button', { name: 'Save API key', exact: true }).click()
    await expect(page.locator('#voice-settings')).toContainText('Set · last 4 1234')
    await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveValue('')
    await page.getByRole('button', { name: 'Test API key', exact: true }).click()
    await expect(page.locator('#voice-settings')).toContainText('API key test passed')
    expect(requests).toEqual(['GET /v1/models/gpt-live-1'])
    expect(JSON.stringify(await page.evaluate(() => window.livePhone.getOpenAiSettings()))).not.toContain('fake-e2e-key-1234')
    await page.getByRole('button', { name: 'Clear API key', exact: true }).click()
    await expect(page.locator('#voice-settings')).toContainText('API key not set')
  } finally { await new Promise<void>((resolve) => fake.close(() => resolve())) }
})
