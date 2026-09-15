#!/usr/bin/env node
/**
 * Capture README desktop screenshots from the built Electron app in mock mode.
 * Usage (after pnpm build from the private root, or from apps/desktop in the public tree):
 *   node scripts/capture-readme-screenshots.mjs
 *
 * Privacy: temp --user-data-dir, +1555… numbers only, never screenshot Settings → MCP.
 */
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const desktopRoot = existsDesktop(join(repoRoot, 'apps/desktop'))
  ? join(repoRoot, 'apps/desktop')
  : repoRoot
const outputDirectory = join(repoRoot, 'docs/en/images')
const WINDOW = { width: 1280, height: 800 }
const MAX_BYTES = 400 * 1024
const MOCK_NUMBER = '+15555550100'
const MOCK_INBOUND = '+15555550142'
const MOCK_DNC = '+15555550199'

function existsDesktop(dir) {
  try {
    return statSync(join(dir, 'out', 'main', 'index.js')).isFile()
  } catch {
    return false
  }
}

function requireBuiltApp() {
  const main = join(desktopRoot, 'out', 'main', 'index.js')
  try {
    if (statSync(main).isFile()) return
  } catch {
    // fall through
  }
  throw new Error(`Built app not found at ${main}. Run pnpm build (desktop) first.`)
}

function compressPng(path) {
  const before = statSync(path).size
  if (process.platform === 'darwin') {
    spawnSync('sips', ['--resampleWidth', String(WINDOW.width), path], { stdio: 'ignore' })
  }
  const after = statSync(path).size
  if (after > MAX_BYTES) {
    console.warn(`warning: ${path} is ${(after / 1024).toFixed(0)} KB (limit ~400 KB); was ${(before / 1024).toFixed(0)} KB`)
  } else {
    console.log(`wrote ${path} (${(after / 1024).toFixed(0)} KB)`)
  }
}

async function screenshotWindow(page, filename) {
  const path = join(outputDirectory, filename)
  await page.screenshot({ path, animations: 'disabled' })
  compressPng(path)
}

async function screenshotLocator(locator, filename) {
  const path = join(outputDirectory, filename)
  await locator.screenshot({ path, animations: 'disabled' })
  compressPng(path)
}

requireBuiltApp()
mkdirSync(outputDirectory, { recursive: true })
const userDataDirectory = mkdtempSync(join(tmpdir(), 'mishu-readme-shots-'))

const application = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDirectory}`],
  cwd: desktopRoot,
  env: {
    ...process.env,
    LIVE_PHONE_USE_MOCKS: '1',
    LIVE_PHONE_SKIP_ENV_FILE: '1',
    OPENAI_API_KEY: '',
    TWILIO_ACCOUNT_SID: '',
    TWILIO_API_KEY_SID: '',
    TWILIO_API_KEY_SECRET: '',
    TWILIO_TWIML_APP_SID: '',
    TWILIO_PHONE_NUMBER: MOCK_NUMBER
  }
})

const skipped = []

try {
  const page = await application.firstWindow()
  await page.getByTestId('app-shell').waitFor({ timeout: 30_000 })
  const electronWindow = await application.browserWindow(page)
  await electronWindow.evaluate((win, size) => {
    win.setContentSize(size.width, size.height)
  }, WINDOW)
  await page.setViewportSize(WINDOW)
  await new Promise((resolveWait) => setTimeout(resolveWait, 400))

  // 1. Idle Calls page. Fill the dial field with a +1555… fixture.
  await page.getByTestId('tab-calls').click()
  await page.getByTestId('dial-input').fill(MOCK_NUMBER.replace(/^\+/, ''))
  await screenshotWindow(page, 'desktop-calls.png')

  // 2. Simulated inbound call, answered, with transcript and takeover controls.
  const simulated = await page.evaluate(async (peer) => {
    const api = window.livePhone
    if (!api.debugPhoneCommand) throw new Error('Debug phone command API is unavailable')
    return api.debugPhoneCommand({ type: 'simulateIncoming', peer })
  }, MOCK_INBOUND)
  if (!simulated?.ok) throw new Error('simulateIncoming failed')
  await page.getByTestId('call-status').waitFor({ state: 'visible' })
  await page.getByTestId('answer-button').click()
  await page.getByTestId('call-status').filter({ hasText: 'On a call' }).waitFor()
  await page.getByTestId('ai-control-button').waitFor()
  await page.getByTestId('human-control-button').waitFor()
  await page.getByTestId('transcript-entry').first().waitFor({ timeout: 10_000 })
  await new Promise((resolveWait) => setTimeout(resolveWait, 400))
  await screenshotWindow(page, 'desktop-live-call.png')

  // 3. History first, while the mock call is still the latest row.
  await page.getByTestId('hangup-button').click()
  await page.getByTestId('call-status').filter({ hasText: 'Call ended' }).waitFor()
  await page.getByTestId('tab-history').click()
  await page.getByTestId('panel-history').waitFor()
  const historyRow = page.getByTestId('history-row').first()
  await historyRow.waitFor({ timeout: 10_000 })
  await historyRow.click()
  await page.getByTestId('history-detail').waitFor()
  await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  await screenshotWindow(page, 'desktop-history.png')

  // 4. Campaign editor with guardrails expanded (taller window so persona + DNC fit).
  await page.getByTestId('tab-calls').click()
  await electronWindow.evaluate((win) => {
    win.setContentSize(1280, 1400)
  })
  await page.setViewportSize({ width: 1280, height: 1400 })
  const editDefault = page.getByRole('button', { name: /Edit Default Campaign/i })
  if (await editDefault.count()) {
    await editDefault.click()
  } else {
    await page.getByTestId('new-campaign-button').click()
    await page.getByTestId('campaign-name-input').fill('Preview campaign')
    await page.getByTestId('campaign-prompt-input').fill(
      'You are a scheduling assistant. Help callers book or reschedule. Do not give medical advice.'
    )
  }
  await page.getByTestId('campaign-editor').waitFor()
  await page.getByTestId('campaign-inbound-number').fill(MOCK_NUMBER)
  await page.getByTestId('campaign-outbound-number').fill(MOCK_NUMBER)
  const toggle = page.getByTestId('policy-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await page.getByTestId('policy-editor-body').waitFor()
  await page.getByTestId('policy-calling-windows').fill('1-5 09:00-18:00')
  await page.getByTestId('policy-do-not-call').fill(MOCK_DNC)
  const recording = page.getByTestId('policy-recording-disclosure')
  if ((await recording.getAttribute('aria-pressed')) !== 'true') await recording.click()
  await page.getByTestId('campaign-prompt-input').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  await screenshotWindow(page, 'desktop-campaign.png')
  await page.getByRole('button', { name: 'Close' }).click()
  await electronWindow.evaluate((win, size) => {
    win.setContentSize(size.width, size.height)
  }, WINDOW)
  await page.setViewportSize(WINDOW)

  // 5. Settings → Voice source only. Never capture the MCP section (local paths).
  await page.getByTestId('tab-settings').click()
  await page.getByTestId('panel-settings').waitFor()
  const voice = page.locator('#voice-settings')
  await voice.waitFor()
  await voice.scrollIntoViewIfNeeded()
  await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  await screenshotLocator(voice, 'desktop-settings-voice.png')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  skipped.push(`capture aborted: ${message}`)
  console.error(message)
  process.exitCode = 1
} finally {
  await application.close()
  rmSync(userDataDirectory, { recursive: true, force: true })
}

if (skipped.length) {
  console.log('skipped or failed:')
  for (const item of skipped) console.log(`- ${item}`)
}
