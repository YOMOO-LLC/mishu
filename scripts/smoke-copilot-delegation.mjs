#!/usr/bin/env node
// One-shot Scheme A probe: realtime delegation -> backing dynamic tool -> app-owned injection.
// It uses a silent WebRTC peer and a synthetic local call lifecycle. It never contacts Twilio.

import { _electron as electron } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const codexBin = process.env.CODEX_BIN ?? 'codex'
const projectCwd = resolve(process.argv[2] ?? process.cwd())
const version = spawnSync(codexBin, ['--version'], { encoding: 'utf8' })
const login = spawnSync(codexBin, ['login', 'status'], { encoding: 'utf8' })
if (version.status !== 0 || login.status !== 0 || !/logged in/i.test(login.stdout + login.stderr)) {
  console.error('[precondition] FAIL: a logged-in Codex CLI is required')
  process.exit(2)
}

const userDataDirectory = mkdtempSync(join(tmpdir(), 'codex-copilot-delegation-'))
const application = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDirectory}`],
  env: {
    ...process.env,
    LIVE_PHONE_USE_MOCKS: '0',
    CODEX_BIN: codexBin,
    CODEX_WORKDIR: projectCwd
  }
})

try {
  const page = await application.firstWindow()
  const result = await page.evaluate(async () => {
    const waitFor = (predicate, timeoutMs, label) => new Promise((resolveWait, rejectWait) => {
      const startedAt = Date.now()
      const interval = window.setInterval(() => {
        if (predicate()) {
          window.clearInterval(interval)
          resolveWait(undefined)
        } else if (Date.now() - startedAt > timeoutMs) {
          window.clearInterval(interval)
          rejectWait(new Error(`Timed out waiting for ${label}`))
        }
      }, 50)
    })

    const events = []
    window.livePhone.onEvent((event) => {
      if (event.type === 'copilot-status') {
        events.push({ type: event.type, state: event.status.state, tool: event.status.lastToolCall?.toolId })
      } else if (event.type === 'copilot-injected') {
        events.push({ type: event.type, text: event.text })
      } else if (event.type === 'assistant-message') {
        events.push({ type: event.type, text: event.text })
      } else if (event.type === 'error') {
        events.push({ type: event.type, message: event.message })
      }
    })

    const workspace = await window.livePhone.getCampaignWorkspace()
    const current = workspace.campaigns.find(({ id }) => id === workspace.selectedCampaignId)
    if (!current) throw new Error('Default campaign was not found')
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
          mode: 'delegation',
          prompt: 'Use lookup_customer once when the caller asks for their membership tier.',
          allowedToolIds: ['lookup_customer'],
          autoExecuteRisks: ['read'],
          maxToolCallsPerTurn: 1
        }
      },
      ...(current.inboundNumber ? { inboundNumber: current.inboundNumber } : {}),
      ...(current.outboundCallerId ? { outboundCallerId: current.outboundCallerId } : {})
    })
    const campaign = saved.campaigns.find(({ id }) => id === saved.selectedCampaignId)
    if (!campaign) throw new Error('Saved campaign was not found')

    const call = {
      id: 'copilot-delegation-smoke',
      direction: 'inbound',
      peer: '+14155550142',
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

    try {
      await peer.setLocalDescription(await peer.createOffer())
      await waitFor(() => peer.iceGatheringState === 'complete', 10_000, 'ICE gathering')
      const response = await window.livePhone.startRealtime({
        sdp: peer.localDescription.sdp,
        instructions: 'You are a helpful phone agent. Delegate customer lookups to the backend.'
      })
      await peer.setRemoteDescription({ type: 'answer', sdp: response.sdp })
      await waitFor(
        () => peer.connectionState === 'connected' && channel.readyState === 'open',
        20_000,
        'WebRTC connection'
      )
      const requestedAt = Date.now()
      await window.livePhone.appendText(
        'My number is +1 415 555 0142, please look up my membership level'
      )
      let observation = 'no-delegation'
      try {
        await waitFor(
          () => events.some((event) => event.type === 'copilot-injected'),
          60_000,
          'copilot injection'
        )
        observation = 'delegation-tool-injection'
      } catch {
        if (events.some((event) => event.tool === 'lookup_customer')) observation = 'tool-without-injection'
      }
      return {
        ok: observation === 'delegation-tool-injection',
        observation,
        latencyMs: Date.now() - requestedAt,
        threadId: response.threadId,
        toolIds: [...new Set(events.filter((event) => event.tool).map((event) => event.tool))],
        toolStatusEvents: events.filter((event) => event.tool).length,
        injected: events.filter((event) => event.type === 'copilot-injected').length,
        errors: events.filter((event) => event.type === 'error').map((event) => event.message)
      }
    } finally {
      peer.close()
      oscillator.stop()
      await audioContext.close()
      await window.livePhone.stopRealtime()
      await window.livePhone.reportCallLifecycle({
        call: { ...call, status: 'ended' },
        campaign,
        runtimeMode: 'mock',
        endReason: 'hangup'
      })
    }
  })
  console.log(`[precondition] PASS: ${version.stdout.trim()} login=available`)
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
} catch (error) {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await application.close()
  rmSync(userDataDirectory, { recursive: true, force: true })
}
