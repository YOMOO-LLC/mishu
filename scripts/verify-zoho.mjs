#!/usr/bin/env node

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { tsImport } from 'tsx/esm/api'

const EXIT = Object.freeze({ OK: 0, NO_CREDENTIALS: 2, CONNECTION_FAILED: 3, LOOKUP_FAILED: 4, USAGE: 64 })
const scriptPath = fileURLToPath(import.meta.url)
const projectPath = resolve(dirname(scriptPath), '..')

/** Private-build userData folder name. Snapshot export rewrites the value to mishu. */
const APP_USER_DATA_DIR_NAME = 'mishu'

export async function runVerifyZoho(argv = process.argv.slice(2), options = {}) {
  const output = options.stdout ?? process.stdout
  const errorOutput = options.stderr ?? process.stderr
  const parsed = parseArgs(argv)
  if (parsed.help) {
    output.write('Usage: node scripts/verify-zoho.mjs --phone <E.164> [--user-data <path>]\n')
    return EXIT.OK
  }
  const userDataPath = options.userDataPath
    ?? parsed.userDataPath
    ?? process.env.LIVE_PHONE_USER_DATA_PATH
    ?? defaultUserDataPath()
  const { ZohoSecretsStore } = await tsImport('../apps/desktop/src/main/crm/zoho/secrets.ts', import.meta.url)
  let secrets
  try {
    secrets = new ZohoSecretsStore(userDataPath).load()
  } catch (error) {
    errorOutput.write(`Zoho credentials: INVALID (exit ${EXIT.CONNECTION_FAILED}): ${safeError(error)}\n`)
    return EXIT.CONNECTION_FAILED
  }
  if (!secrets) {
    output.write(`Zoho credentials not found at ${join(userDataPath, 'crm', 'zoho-secrets.json')}.\n`)
    output.write(await todoChecklist())
    return EXIT.NO_CREDENTIALS
  }
  if (!parsed.phone) {
    errorOutput.write('Zoho credentials found, but --phone <E.164> is required for the lookup check.\n')
    return EXIT.USAGE
  }
  let phone
  try {
    phone = normalizePhone(parsed.phone)
  } catch (error) {
    errorOutput.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT.USAGE
  }
  const { ZohoCrmClient } = await tsImport('../apps/desktop/src/main/crm/zoho/client.ts', import.meta.url)
  const client = new ZohoCrmClient(secrets, { fetch: options.fetchImpl ?? globalThis.fetch })

  try {
    await client.testConnection()
    output.write('Zoho connection: OK\n')
  } catch (error) {
    errorOutput.write(`Zoho connection: FAILED (exit ${EXIT.CONNECTION_FAILED}): ${safeError(error, secrets)}\n`)
    return EXIT.CONNECTION_FAILED
  }

  try {
    const contact = await client.lookupByPhone(phone)
    output.write(`Zoho phone lookup ${maskPhone(phone)}: OK (${contact ? 'match found' : 'no match'})\n`)
    return EXIT.OK
  } catch (error) {
    errorOutput.write(`Zoho phone lookup ${maskPhone(phone)}: FAILED (exit ${EXIT.LOOKUP_FAILED}): ${safeError(error, secrets)}\n`)
    return EXIT.LOOKUP_FAILED
  }
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') result.help = true
    else if (argument === '--phone' || argument === '--user-data') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      if (argument === '--phone') result.phone = value
      else result.userDataPath = resolve(value)
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return result
}

function normalizePhone(value) {
  const normalized = value.trim().replace(/[\s().-]/g, '')
  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) throw new Error('--phone must be E.164')
  return normalized
}

function maskPhone(phone) {
  if (phone.length <= 7) return `${phone.slice(0, 2)}***${phone.slice(-2)}`
  return `${phone.slice(0, 2)}${'*'.repeat(Math.max(3, phone.length - 6))}${phone.slice(-4)}`
}

function safeError(error, secrets = {}) {
  let message = error instanceof Error ? error.message : String(error)
  for (const value of [secrets.clientId, secrets.clientSecret, secrets.refreshToken]) {
    if (value) message = message.replaceAll(value, '[redacted]')
  }
  return message.replace(/\s+/g, ' ').slice(0, 300)
}

async function todoChecklist() {
  const path = join(projectPath, 'docs', 'crm-zoho-setup.md')
  try {
    const document = await readFile(path, 'utf8')
    const start = document.indexOf('## Verification script TODO')
    if (start >= 0) {
      const contentStart = document.indexOf('\n', start) + 1
      const nextHeading = document.indexOf('\n## ', contentStart)
      const checklist = document.slice(contentStart, nextHeading >= 0 ? nextHeading : undefined)
        .split('\n')
        .filter((line) => line.startsWith('- [ ] '))
        .join('\n')
      if (checklist) return `Zoho setup TODO:\n${checklist}\n`
    }
  } catch {}
  return 'Zoho setup TODO: read docs/crm-zoho-setup.md, configure a Self Client, and connect it in Settings.\n'
}

function defaultUserDataPath() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', APP_USER_DATA_DIR_NAME)
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), APP_USER_DATA_DIR_NAME)
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), APP_USER_DATA_DIR_NAME)
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  runVerifyZoho().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`Zoho verification usage error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = EXIT.USAGE
  })
}
