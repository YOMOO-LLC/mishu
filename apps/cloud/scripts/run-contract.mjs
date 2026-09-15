#!/usr/bin/env node
/**
 * Start apps/cloud, run the same tests/contract suite against it, then stop.
 * Never prints the bearer token. CONTRACT_TOKEN is passed only via the
 * vitest child environment.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const READY_WAIT_MS = 30_000

function parseReady(line) {
  try {
    const value = JSON.parse(line)
    if (value && value.ready === true && typeof value.baseUrl === 'string' && typeof value.tokenFile === 'string') {
      return value
    }
  } catch {
    return undefined
  }
  return undefined
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`apps/cloud did not print a ready line within ${READY_WAIT_MS}ms`))
    }, READY_WAIT_MS)
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const ready = parseReady(line.trim())
        if (ready) {
          cleanup()
          resolve(ready)
          return
        }
      }
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(new Error(`apps/cloud exited before ready (code=${code} signal=${signal})`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout?.on('data', onData)
    child.once('exit', onExit)
  })
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try { child.kill('SIGTERM') } catch { resolve() }
  })
}

function runVitest(env) {
  return new Promise((resolve) => {
    const child = spawn(
      'pnpm',
      ['exec', 'vitest', 'run', '--config', 'tests/contract/vitest.config.ts'],
      { cwd: repoRoot, env, stdio: 'inherit' }
    )
    child.once('exit', (code, signal) => {
      resolve(signal ? 1 : (code ?? 1))
    })
  })
}

async function main() {
  const host = spawn(
    join(repoRoot, 'node_modules/.bin/tsx'),
    [join(repoRoot, 'apps/cloud/src/index.ts')],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        LIVE_PHONE_USE_MOCKS: '1',
        LIVE_PHONE_SKIP_ENV_FILE: '1'
      },
      stdio: ['ignore', 'pipe', 'inherit']
    }
  )
  try {
    const ready = await waitForReady(host)
    const token = readFileSync(ready.tokenFile, 'utf8').trim()
    const code = await runVitest({
      ...process.env,
      LIVE_PHONE_USE_MOCKS: '1',
      LIVE_PHONE_SKIP_ENV_FILE: '1',
      CONTRACT_BASE_URL: ready.baseUrl,
      CONTRACT_TOKEN: token
    })
    await stopChild(host)
    process.exit(code)
  } catch (error) {
    await stopChild(host)
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}

void main()
