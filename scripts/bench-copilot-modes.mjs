#!/usr/bin/env node
// Real-model benchmark for the two in-call copilot modes. The caller is simulated with
// realtime appendText over a silent WebRTC peer; no telephone adapter is initialized.

import { _electron as electron } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ALL_MODES = ['delegation', 'transcript']
const ALL_SCENARIOS = ['1', '2', '3', '4']
const SESSION_TIMEOUT_MS = 55_000

function parseArgs(argv) {
  const options = {
    modes: [...ALL_MODES],
    scenarios: [...ALL_SCENARIOS],
    maxSessions: 10,
    summarize: undefined,
    projectCwd: process.cwd()
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]
    if (arg === '--modes' && value) {
      options.modes = value.split(',').filter(Boolean)
      index += 1
    } else if (arg === '--scenarios' && value) {
      options.scenarios = value.split(',').filter(Boolean)
      index += 1
    } else if (arg === '--max-sessions' && value !== undefined) {
      options.maxSessions = Number(value)
      index += 1
    } else if (arg === '--summarize' && value) {
      options.summarize = resolve(value)
      index += 1
    } else if (arg === '--project' && value) {
      options.projectCwd = resolve(value)
      index += 1
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }
  if (options.modes.some((mode) => !ALL_MODES.includes(mode))) {
    throw new Error(`--modes must contain only ${ALL_MODES.join(',')}`)
  }
  if (options.scenarios.some((scenario) => !ALL_SCENARIOS.includes(scenario))) {
    throw new Error(`--scenarios must contain only ${ALL_SCENARIOS.join(',')}`)
  }
  if (!Number.isInteger(options.maxSessions) || options.maxSessions < 0) {
    throw new Error('--max-sessions must be a non-negative integer')
  }
  return options
}

function sanitize(value) {
  return String(value)
    .replace(/[s][k]-[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/[B][e][a][r][e][r]\s+[A-Za-z0-9._~-]+/g, '[REDACTED_AUTH]')
    .replace(/\+\d(?:[\s().-]*\d){6,14}/g, '[REDACTED_PHONE]')
    .slice(0, 1_000)
}

function timestampDirectoryName() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function assertPreconditions(codexBin, projectCwd) {
  const builtMain = join(projectCwd, 'out', 'main', 'index.js')
  accessSync(builtMain)
  const version = spawnSync(codexBin, ['--version'], { encoding: 'utf8' })
  const login = spawnSync(codexBin, ['login', 'status'], { encoding: 'utf8' })
  if (version.status !== 0 || login.status !== 0 || !/logged in/i.test(login.stdout + login.stderr)) {
    throw new Error('a logged-in Codex CLI is required')
  }
  return sanitize(version.stdout.trim())
}

function prepareIsolatedCodexHome() {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'codex-copilot-bench-home-'))
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const sourceAuth = join(sourceHome, 'auth.json')
  const isolatedAuth = join(isolatedHome, 'auth.json')
  if (existsSync(sourceAuth)) {
    copyFileSync(sourceAuth, isolatedAuth)
    chmodSync(isolatedAuth, 0o600)
  }
  return isolatedHome
}

function collectJsonFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...collectJsonFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path)
  }
  return files
}

function occurrenceMetrics(actual, expected) {
  const remaining = [...actual]
  let hits = 0
  for (const tool of expected) {
    const index = remaining.indexOf(tool)
    if (index >= 0) {
      hits += 1
      remaining.splice(index, 1)
    }
  }
  const duplicates = expected.reduce((total, tool) => {
    const expectedCount = expected.filter((item) => item === tool).length
    const actualCount = actual.filter((item) => item === tool).length
    return total + Math.max(0, actualCount - expectedCount)
  }, 0) / Math.max(1, new Set(expected).size)
  const unexpected = remaining.filter((tool) => !expected.includes(tool)).length
  return {
    recall: expected.length === 0 ? 'n/a' : `${hits}/${expected.length}`,
    falseTriggers: unexpected,
    duplicates
  }
}

function latencyList(result, kind) {
  const values = []
  for (let index = 0; index < result.toolCalls.length; index += 1) {
    const call = result.toolCalls[index]
    const utterance = result.utterances[Math.min(index, result.utterances.length - 1)]
    const injection = result.injections[index]
    let value
    if (kind === 'request') value = call.requestedAt - utterance.submittedAt
    if (kind === 'tool') value = call.respondedAt == null ? undefined : call.respondedAt - call.requestedAt
    if (kind === 'inject') {
      value = call.respondedAt == null || !injection ? undefined : injection.at - call.respondedAt
    }
    if (kind === 'e2e') value = !injection ? undefined : injection.at - utterance.submittedAt
    values.push(value == null || value < 0 ? '—' : String(value))
  }
  return values.length ? values.join('/') : '—'
}

function markdownSummary(results) {
  const ordered = [...results].sort((a, b) =>
    ALL_MODES.indexOf(a.mode) - ALL_MODES.indexOf(b.mode) || Number(a.scenario) - Number(b.scenario)
  )
  const lines = [
    '| Mode | Scenario | Recall | False triggers | Duplicates | Submit→call ms | Tool ms | Reply→inject ms | E2E ms | turns | tokens |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  ]
  for (const result of ordered) {
    const tools = result.toolCalls.map(({ toolId }) => toolId)
    const metrics = occurrenceMetrics(tools, result.expectedTools)
    lines.push(
      `| ${result.mode} | ${result.scenario} | ${metrics.recall} | ${metrics.falseTriggers} | ` +
      `${metrics.duplicates} | ${latencyList(result, 'request')} | ${latencyList(result, 'tool')} | ` +
      `${latencyList(result, 'inject')} | ${latencyList(result, 'e2e')} | ${result.turns} | ` +
      `${result.tokensApprox ?? '—'} |`
    )
  }
  return lines.join('\n')
}

function summarizeDirectory(directory) {
  const results = collectJsonFiles(directory)
    .map((path) => JSON.parse(readFileSync(path, 'utf8')))
    .filter((result) => result?.schema === 'copilot-mode-benchmark/v1')
  if (results.length === 0) throw new Error(`No benchmark JSON results found in ${directory}`)
  process.stdout.write(`${markdownSummary(results)}\n`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.summarize) {
    summarizeDirectory(options.summarize)
    return
  }

  const plannedSessions = options.modes.length * options.scenarios.length
  if (plannedSessions === 0 || plannedSessions > options.maxSessions) {
    throw new Error(
      `session limit prevents run: planned=${plannedSessions} max=${options.maxSessions}`
    )
  }

  const codexBin = process.env.CODEX_BIN ?? 'codex'
  const version = assertPreconditions(codexBin, options.projectCwd)
  const resultDirectory = join('/tmp', 'copilot-bench', timestampDirectoryName())
  mkdirSync(resultDirectory, { recursive: true })
  const userDataDirectory = mkdtempSync(join(tmpdir(), 'codex-copilot-bench-user-'))
  const isolatedCodexHome = prepareIsolatedCodexHome()
  let sessionCount = 0

  const application = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDirectory}`],
    cwd: options.projectCwd,
    env: {
      ...process.env,
      LIVE_PHONE_USE_MOCKS: '0',
      CODEX_BIN: codexBin,
      CODEX_HOME: isolatedCodexHome,
      CODEX_WORKDIR: options.projectCwd
    }
  })

  try {
    const page = await application.firstWindow()
    for (const mode of options.modes) {
      for (const scenario of options.scenarios) {
        if (sessionCount >= options.maxSessions) {
          throw new Error(`session limit reached at ${sessionCount}/${options.maxSessions}`)
        }
        sessionCount += 1
        const result = await runScenario(page, mode, scenario, sessionCount)
        const path = join(resultDirectory, `${mode}-scenario-${scenario}.json`)
        writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
        console.log(
          `[session ${sessionCount}/${options.maxSessions}] ${mode} scenario=${scenario} ` +
          `tools=${result.toolCalls.map(({ toolId }) => toolId).join(',') || 'none'} ` +
          `injections=${result.injections.length} errors=${result.errors.length}`
        )
      }
    }
    console.log(`[precondition] PASS: ${version} login=available isolated-state=temporary`)
    console.log(`[result] directory=${resultDirectory}`)
    console.log(`[result] realtime-sessions=${sessionCount}`)
    console.log(markdownSummary(collectJsonFiles(resultDirectory).map((path) => JSON.parse(readFileSync(path, 'utf8')))))
  } finally {
    await application.close()
    rmSync(userDataDirectory, { recursive: true, force: true })
    rmSync(isolatedCodexHome, { recursive: true, force: true })
  }
}

async function runScenario(page, mode, scenarioId, sessionNumber) {
  return page.evaluate(async ({ mode: selectedMode, scenarioId: selectedScenarioId, sessionNumber: runNumber, timeoutMs }) => {
    const scenario = {
      '1': {
        name: 'explicit lookup',
        utterances: ['My number is +1 415 555 0142, please look up my membership level'],
        expectedTools: ['lookup_customer']
      },
      '2': {
        name: 'casual question',
        utterances: ['Are you open on weekends? I am just asking'],
        expectedTools: []
      },
      '3': {
        name: 'two-step intent',
        utterances: [
          'My number is +1 415 555 0142, look up my level',
          'Then book a demo for next Tuesday at 3pm'
        ],
        expectedTools: ['lookup_customer', 'schedule_demo']
      },
      '4': {
        name: 'caller interruption',
        utterances: [
          'My number is +1 415 555 0142, please look up my level',
          'Wait, do not look that up, I will try another day'
        ],
        expectedTools: ['lookup_customer']
      }
    }[selectedScenarioId]

    const startedAt = Date.now()
    const elapsed = () => Date.now() - startedAt
    const result = {
      schema: 'copilot-mode-benchmark/v1',
      mode: selectedMode,
      scenario: selectedScenarioId,
      scenarioName: scenario.name,
      expectedTools: scenario.expectedTools,
      toolCalls: [],
      injections: [],
      utterances: [],
      turns: 0,
      tokensApprox: null,
      errors: [],
      timeline: []
    }
    const safe = (value) => String(value)
      .replace(/[s][k]-[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
      .replace(/[B][e][a][r][e][r]\s+[A-Za-z0-9._~-]+/g, '[REDACTED_AUTH]')
      .replace(/\+\d(?:[\s().-]*\d){6,14}/g, '[REDACTED_PHONE]')
      .slice(0, 600)
    const waitFor = (predicate, waitMs, label) => new Promise((resolveWait, rejectWait) => {
      const deadline = Date.now() + waitMs
      const timer = window.setInterval(() => {
        if (predicate()) {
          window.clearInterval(timer)
          resolveWait(undefined)
        } else if (Date.now() >= deadline) {
          window.clearInterval(timer)
          rejectWait(new Error(`timed out waiting for ${label}`))
        }
      }, 40)
    })
    const sleep = (ms) => new Promise((resolveSleep) => window.setTimeout(resolveSleep, ms))
    let priorState = 'idle'
    let activityCycles = 0
    let pendingRequestAt
    const respondedKeys = new Set()
    let unsubscribeEvent = () => undefined
    let unsubscribeApproval = () => undefined

    unsubscribeEvent = window.livePhone.onEvent((event) => {
      const at = Date.now()
      if (event.type === 'copilot-status') {
        const state = event.status.state
        if ((state === 'thinking' || state === 'tool') && priorState === 'idle') activityCycles += 1
        if (state === 'tool' && priorState !== 'tool') {
          pendingRequestAt = at
          result.timeline.push({ at: elapsed(), type: 'tool-requested' })
        }
        const last = event.status.lastToolCall
        if (last && !respondedKeys.has(`${last.toolId}:${last.at}`)) {
          respondedKeys.add(`${last.toolId}:${last.at}`)
          result.toolCalls.push({
            toolId: last.toolId,
            requestedAt: pendingRequestAt ?? at,
            respondedAt: at,
            ok: last.ok
          })
          pendingRequestAt = undefined
          result.timeline.push({ at: elapsed(), type: 'tool-responded', toolId: last.toolId, ok: last.ok })
        }
        priorState = state
      } else if (event.type === 'copilot-injected') {
        result.injections.push({ at, text: safe(event.text) })
        result.timeline.push({ at: elapsed(), type: 'copilot-injected', text: safe(event.text) })
      } else if (event.type === 'assistant-message') {
        result.timeline.push({ at: elapsed(), type: 'assistant-message', text: safe(event.text) })
      } else if (event.type === 'transcript' && event.entry.final) {
        result.timeline.push({
          at: elapsed(),
          type: 'transcript-final',
          speaker: event.entry.speaker,
          text: '[REDACTED_UTTERANCE]'
        })
      } else if (event.type === 'error') {
        result.errors.push(safe(event.message))
        result.timeline.push({ at: elapsed(), type: 'error', source: event.source, message: safe(event.message) })
      }
    })
    unsubscribeApproval = window.livePhone.onApprovalRequested((request) => {
      result.timeline.push({ at: elapsed(), type: 'test-approval', kind: request.kind })
      window.livePhone.respondApproval({ id: request.id, approved: true, decidedAt: Date.now() })
    })

    const workspace = await window.livePhone.getCampaignWorkspace()
    const current = workspace.campaigns.find(({ id }) => id === workspace.selectedCampaignId)
    if (!current) throw new Error('default campaign was not found')
    const saved = await window.livePhone.saveCampaign({
      id: current.id,
      name: current.name,
      direction: current.direction,
      systemPrompt: current.systemPrompt,
      voice: current.voice,
      policy: {
        ...current.policy,
        copilot: {
          enabled: true,
          mode: selectedMode,
          prompt: [
            'For membership requests, call lookup_customer exactly once.',
            'For scheduling requests, call schedule_demo exactly once.',
            'Never call a tool for business-hours questions or casual conversation.',
            'Respect a caller cancellation and never repeat an action.'
          ].join(' '),
          allowedToolIds: ['lookup_customer', 'schedule_demo'],
          autoExecuteRisks: ['read'],
          maxToolCallsPerTurn: 3
        }
      },
      ...(current.inboundNumber ? { inboundNumber: current.inboundNumber } : {}),
      ...(current.outboundCallerId ? { outboundCallerId: current.outboundCallerId } : {})
    })
    const campaign = saved.campaigns.find(({ id }) => id === saved.selectedCampaignId)
    if (!campaign) throw new Error('saved campaign was not found')
    const call = {
      id: `copilot-bench-${selectedMode}-${selectedScenarioId}-${runNumber}-${Date.now()}`,
      direction: 'inbound',
      peer: '+1 415 555 0199',
      status: 'active',
      startedAt: Date.now()
    }
    await window.livePhone.reportCallLifecycle({ call, campaign, runtimeMode: 'mock' })

    const peer = new RTCPeerConnection()
    const audioContext = new AudioContext()
    const destination = audioContext.createMediaStreamDestination()
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    gain.gain.value = 0
    oscillator.connect(gain).connect(destination)
    oscillator.start()
    peer.addTrack(destination.stream.getAudioTracks()[0], destination.stream)
    const channel = peer.createDataChannel('oai-events')

    const submit = async (index) => {
      const submittedAt = Date.now()
      result.utterances.push({ index: index + 1, submittedAt, text: '[REDACTED_UTTERANCE]' })
      result.timeline.push({ at: elapsed(), type: 'utterance-submitted', index: index + 1 })
      await window.livePhone.appendText(scenario.utterances[index])
      if (selectedMode === 'transcript') {
        await window.livePhone.reportTranscriptEntry({
          id: `copilot-bench-transcript-${runNumber}-${index}-${submittedAt}`,
          speaker: 'caller',
          text: scenario.utterances[index],
          final: true,
          timestamp: submittedAt
        })
      }
    }

    try {
      await peer.setLocalDescription(await peer.createOffer())
      await waitFor(() => peer.iceGatheringState === 'complete', 10_000, 'ICE gathering')
      const realtime = await window.livePhone.startRealtime({
        sdp: peer.localDescription.sdp,
        instructions: [
          'You are a concise phone agent.',
          'Delegate membership lookup and scheduling actions to the backend.',
          'Do not delegate casual business-hours questions.',
          'Respect caller cancellation immediately.'
        ].join(' ')
      })
      await window.livePhone.reportCallLifecycle({
        call,
        campaign,
        runtimeMode: 'mock',
        threadId: realtime.threadId,
        ...(realtime.sessionId ? { sessionId: realtime.sessionId } : {})
      })
      await peer.setRemoteDescription({ type: 'answer', sdp: realtime.sdp })
      await waitFor(
        () => peer.connectionState === 'connected' && channel.readyState === 'open',
        20_000,
        'WebRTC connection'
      )

      await submit(0)
      if (selectedScenarioId === '1') {
        await waitFor(() => result.injections.length >= 1 || result.errors.length > 0, timeoutMs, 'lookup result')
      } else if (selectedScenarioId === '2') {
        await sleep(18_000)
      } else if (selectedScenarioId === '3') {
        await waitFor(() => result.injections.length >= 1 || result.errors.length > 0, timeoutMs, 'first injection')
        await submit(1)
        await waitFor(() => result.injections.length >= 2 || result.errors.length > 0, timeoutMs, 'second injection')
      } else {
        await waitFor(() => result.timeline.some(({ type }) => type === 'tool-requested') || result.errors.length > 0, timeoutMs, 'tool request before interruption')
        await submit(1)
        await waitFor(() => priorState === 'idle' && result.toolCalls.length >= 1 || result.errors.length > 0, timeoutMs, 'post-interruption settling')
        await sleep(2_000)
      }
    } catch (error) {
      result.errors.push(safe(error instanceof Error ? error.message : error))
    } finally {
      result.turns = activityCycles
      peer.close()
      oscillator.stop()
      await audioContext.close()
      await window.livePhone.stopRealtime().catch(() => undefined)
      await window.livePhone.reportCallLifecycle({
        call: { ...call, status: 'ended' },
        campaign,
        runtimeMode: 'mock',
        endReason: 'hangup'
      })
      unsubscribeEvent()
      unsubscribeApproval()
    }
    return result
  }, { mode, scenarioId, sessionNumber, timeoutMs: SESSION_TIMEOUT_MS })
}

main().catch((error) => {
  console.error(`[FAIL] ${sanitize(error instanceof Error ? error.message : error)}`)
  process.exitCode = 1
})
