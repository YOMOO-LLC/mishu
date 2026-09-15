import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const phase = process.argv[2]
if (phase !== 'before' && phase !== 'after') {
  throw new Error('Usage: node scripts/capture-settings-ui.mjs <before|after>')
}

const outputDirectory = '/tmp/t82-screens'
const userDataDirectory = mkdtempSync(join(tmpdir(), 'mishu-t82-'))
const sizes = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x768', width: 1024, height: 768 }
]
const sections = [
  ['voice', '#voice-settings'],
  ['twilio', '[data-testid="settings-section-twilio"]'],
  ['webhook', '[data-testid="settings-section-webhook"]'],
  ['general', '[data-testid="settings-section-general"]'],
  ['budget', '[data-testid="settings-section-budget"]'],
  ['mcp', '[data-testid="settings-section-mcp"]'],
  ['crm', '[data-testid="settings-section-crm"]'],
  ['appointments', '[data-testid="settings-section-appointments"]']
]

mkdirSync(outputDirectory, { recursive: true })

const application = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDirectory}`],
  cwd: resolve('.'),
  env: {
    ...process.env,
    LIVE_PHONE_USE_MOCKS: '1',
    LIVE_PHONE_SKIP_ENV_FILE: '1',
    OPENAI_API_KEY: '',
    TWILIO_ACCOUNT_SID: '',
    TWILIO_API_KEY_SID: '',
    TWILIO_API_KEY_SECRET: '',
    TWILIO_TWIML_APP_SID: '',
    TWILIO_PHONE_NUMBER: '+13125550198'
  }
})

try {
  const page = await application.firstWindow()
  await page.getByTestId('app-shell').waitFor()
  await page.getByTestId('tab-settings').click()
  await page.getByTestId('panel-settings').waitFor()

  await page.getByLabel('OpenAI API key').fill('sk-proj-fake0000000000001234')
  await page.getByTestId('twilio-accountSid').fill('ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
  await page.getByTestId('twilio-apiKeySid').fill('SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
  await page.getByTestId('twilio-apiKeySecret').fill('fake-secret-000000000000')
  await page.getByTestId('twilio-twimlAppSid').fill('APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')

  for (const size of sizes) {
    await page.setViewportSize(size)
    const horizontalOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    )
    if (horizontalOverflow) throw new Error(`Horizontal overflow at ${size.name}`)
    await page.locator('.panel__heading').first().scrollIntoViewIfNeeded()
    await page.screenshot({
      path: join(outputDirectory, `${phase}-${size.name}-overview.png`)
    })

    for (const [name, selector] of sections) {
      const section = page.locator(selector)
      await section.scrollIntoViewIfNeeded()
      await section.screenshot({
        path: join(outputDirectory, `${phase}-${size.name}-${name}.png`)
      })
    }
  }
} finally {
  await application.close()
  rmSync(userDataDirectory, { recursive: true, force: true })
}
