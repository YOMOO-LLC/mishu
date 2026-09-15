#!/usr/bin/env node
// Verifies the sidecar-thread dynamic-tool round trip without Electron or a phone call.
//
// Preconditions:
//   1. Codex CLI 0.153.4 or newer is on PATH (override with CODEX_BIN).
//   2. `codex login status` succeeds for the current local Codex account.
//   3. The optional first argument is a readable project cwd; it defaults to process.cwd().
//
// The app-server gets an isolated temporary CODEX_HOME containing only a short-lived copy of
// auth.json when that file exists. The thread is ephemeral, read-only, and uses approval=never.
// All temporary state is removed on exit. No Electron build, telephony service, or user-data
// directory is touched.

import { spawn, spawnSync } from 'node:child_process'
import { access, chmod, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const codexBin = process.env.CODEX_BIN ?? 'codex'
const projectCwd = resolve(process.argv[2] ?? process.cwd())
const toolName = 'lookup_customer'
const requestedPhone = '+1 415 555 0142'
const fakeRecord = 'DEMO_CUSTOMER: Avery Example; tier=Gold; city=Demo City'
const overallTimeoutMs = 120_000
const requestTimeoutMs = 30_000

function sanitize(value) {
  return String(value)
    .replace(/[s][k]-[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/[B][e][a][r][e][r]\s+[A-Za-z0-9._~-]+/g, '[REDACTED_AUTH]')
}

function fail(message, details) {
  const suffix = details ? `: ${sanitize(details).slice(0, 800)}` : ''
  throw new Error(`${message}${suffix}`)
}

async function assertReadable(path, label) {
  try {
    await access(path, fsConstants.R_OK)
  } catch (error) {
    fail(`${label} is not readable`, error)
  }
}

const versionCheck = spawnSync(codexBin, ['--version'], { encoding: 'utf8' })
if (versionCheck.status !== 0) {
  console.error(`[precondition] FAIL: Codex CLI '${codexBin}' is unavailable`)
  process.exit(2)
}

const loginCheck = spawnSync(codexBin, ['login', 'status'], { encoding: 'utf8' })
if (loginCheck.status !== 0 || !/logged in/i.test(loginCheck.stdout + loginCheck.stderr)) {
  console.error('[precondition] FAIL: local Codex login is unavailable; run `codex login status`')
  process.exit(2)
}

await assertReadable(projectCwd, 'project cwd')

const isolatedHome = await mkdtemp(join(tmpdir(), 'codex-dynamic-tools-'))
const sourceHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
const sourceAuth = join(sourceHome, 'auth.json')
const isolatedAuth = join(isolatedHome, 'auth.json')

try {
  try {
    await access(sourceAuth, fsConstants.R_OK)
    await copyFile(sourceAuth, isolatedAuth)
    await chmod(isolatedAuth, 0o600)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    // Some installations keep credentials outside auth.json; let the CLI report auth failure.
  }

  console.log(
    `[precondition] PASS: ${versionCheck.stdout.trim()} login=available isolated-state=temporary`,
  )

  const child = spawn(codexBin, ['app-server'], {
    cwd: projectCwd,
    env: { ...process.env, CODEX_HOME: isolatedHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let nextId = 1
  let exited = false
  let stderrTail = ''
  const pending = new Map()
  const notifications = []
  const waiters = new Set()
  const toolCalls = []
  const assistantMessages = []

  const write = (message) => {
    if (exited || !child.stdin.writable) fail('app-server stdin is unavailable')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  const request = (method, params, timeoutMs = requestTimeoutMs) => {
    const id = nextId++
    write({ id, method, params })
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timed out waiting for ${method}`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout)
          resolveRequest(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          rejectRequest(error)
        },
      })
    })
  }

  const respond = (id, result) => write({ id, result })
  const reject = (id, message) =>
    write({ id, error: { code: -32601, message: sanitize(message).slice(0, 240) } })

  const notifyWaiters = (message) => {
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue
      waiters.delete(waiter)
      clearTimeout(waiter.timeout)
      waiter.resolve(message)
    }
  }

  const waitForNotification = (predicate, timeoutMs, label) => {
    const existing = notifications.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolveWait, rejectWait) => {
      const waiter = {
        predicate,
        resolve: resolveWait,
        timeout: setTimeout(() => {
          waiters.delete(waiter)
          rejectWait(new Error(`timed out waiting for ${label}`))
        }, timeoutMs),
      }
      waiters.add(waiter)
    })
  }

  const onServerRequest = (message) => {
    if (message.method !== 'item/tool/call') {
      reject(message.id, `unexpected app-server request: ${message.method}`)
      return
    }

    const params = message.params ?? {}
    if (params.tool !== toolName || params.namespace != null) {
      respond(message.id, {
        contentItems: [{ type: 'inputText', text: 'Tool is not registered by this smoke client.' }],
        success: false,
      })
      return
    }
    const phone = params.arguments?.phone
    if (typeof phone !== 'string' || !phone.replace(/\D/g, '').endsWith('0142')) {
      respond(message.id, {
        contentItems: [{ type: 'inputText', text: 'The demo phone argument was invalid.' }],
        success: false,
      })
      return
    }

    toolCalls.push({
      tool: params.tool,
      namespace: params.namespace ?? null,
      phone,
      threadId: params.threadId,
      turnId: params.turnId,
      callId: params.callId,
    })
    console.log(`[tool] request ${toolName} phone=${requestedPhone}`)
    respond(message.id, {
      contentItems: [{ type: 'inputText', text: fakeRecord }],
      success: true,
    })
    console.log('[tool] response success=true record=DEMO_CUSTOMER')
  }

  const onMessage = (message) => {
    if (message && Object.hasOwn(message, 'id') && !message.method) {
      const callback = pending.get(message.id)
      if (!callback) return
      pending.delete(message.id)
      if (message.error) {
        callback.reject(new Error(`${message.error.message ?? 'JSON-RPC error'}`))
      } else {
        callback.resolve(message.result)
      }
      return
    }

    if (message && Object.hasOwn(message, 'id') && message.method) {
      onServerRequest(message)
      return
    }

    if (!message?.method) return
    notifications.push(message)
    if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
      assistantMessages.push(message.params.item.text ?? '')
    }
    notifyWaiters(message)
  }

  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      onMessage(JSON.parse(line))
    } catch (error) {
      for (const callback of pending.values()) callback.reject(error)
      pending.clear()
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderrTail = sanitize((stderrTail + chunk).slice(-4_000))
  })

  child.on('exit', (code, signal) => {
    exited = true
    const error = new Error(
      `app-server exited before smoke completed (code=${code}, signal=${signal})`,
    )
    for (const callback of pending.values()) callback.reject(error)
    pending.clear()
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout)
      waiter.resolve({ method: '__app_server_exit__', params: { code, signal } })
    }
    waiters.clear()
  })

  const overallTimeout = setTimeout(() => {
    if (!exited) child.kill('SIGTERM')
  }, overallTimeoutMs)

  try {
    await request('initialize', {
      clientInfo: {
        name: 'dynamic_tools_smoke',
        title: 'Dynamic Tools Smoke',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })

    const threadResponse = await request('thread/start', {
      cwd: projectCwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      developerInstructions:
        'You are a deterministic in-call copilot smoke test. Use lookup_customer exactly once ' +
        'when asked to look up the demo caller. Never use shell, files, web, or any other tool. ' +
        'After the tool result, answer briefly and include the customer name, tier, and city.',
      dynamicTools: [
        {
          type: 'function',
          name: toolName,
          description: 'Look up a caller in a fixed demonstration customer directory.',
          inputSchema: {
            type: 'object',
            properties: { phone: { type: 'string', description: 'Caller phone number' } },
            required: ['phone'],
            additionalProperties: false,
          },
          deferLoading: false,
        },
      ],
    })
    const threadId = threadResponse?.thread?.id
    if (!threadId) fail('thread/start did not return a thread id')
    console.log('[thread] started ephemeral read-only copilot')

    const turnResponse = await request('turn/start', {
      threadId,
      input: [
        {
          type: 'text',
          text:
            `The caller says their number is ${requestedPhone}. ` +
            'Look up the customer with the registered tool and report the returned record.',
        },
      ],
    })
    const turnId = turnResponse?.turn?.id
    if (!turnId) fail('turn/start did not return a turn id')

    const completed = await waitForNotification(
      (message) =>
        message.method === 'turn/completed' &&
        (!message.params?.turn?.id || message.params.turn.id === turnId),
      overallTimeoutMs - requestTimeoutMs,
      'turn/completed',
    )
    if (completed.method === '__app_server_exit__') fail('app-server exited', stderrTail)

    const matchingCalls = toolCalls.filter(
      (call) => call.threadId === threadId && call.turnId === turnId && call.tool === toolName,
    )
    if (matchingCalls.length !== 1) {
      fail(`expected exactly one ${toolName} call, received ${matchingCalls.length}`, stderrTail)
    }

    const finalText = assistantMessages.join('\n').trim()
    for (const expected of ['Avery Example', 'Gold', 'Demo City']) {
      if (!finalText.includes(expected)) {
        fail(`assistant response did not contain '${expected}'`, finalText || stderrTail)
      }
    }

    const dynamicCompleted = notifications.some(
      (message) =>
        message.method === 'item/completed' &&
        message.params?.item?.type === 'dynamicToolCall' &&
        message.params.item.tool === toolName &&
        message.params.item.success === true,
    )
    if (!dynamicCompleted) fail('missing successful dynamicToolCall item/completed')

    console.log(`[assistant] ${sanitize(finalText).replace(/\s+/g, ' ')}`)
    console.log(
      JSON.stringify(
        {
          ok: true,
          tool: toolName,
          toolCallCount: matchingCalls.length,
          dynamicToolCompleted: true,
          assistantContainsFakeRecord: true,
          thread: 'ephemeral',
          sandbox: 'read-only',
          approvalPolicy: 'never',
        },
        null,
        2,
      ),
    )
  } finally {
    clearTimeout(overallTimeout)
    if (!exited) {
      child.kill('SIGTERM')
      await new Promise((resolveExit) => {
        const force = setTimeout(() => {
          if (!exited) child.kill('SIGKILL')
          resolveExit()
        }, 2_000)
        child.once('exit', () => {
          clearTimeout(force)
          resolveExit()
        })
      })
    }
  }
} catch (error) {
  console.error(`[FAIL] ${sanitize(error instanceof Error ? error.message : error)}`)
  process.exitCode = 1
} finally {
  await rm(isolatedHome, { recursive: true, force: true })
}
