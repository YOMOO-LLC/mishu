#!/usr/bin/env node
// Smoke test: can GPT Live via `codex app-server` call a tool (MCP / function) mid-conversation?
//
// Study: docs/spikes/2026-09-realtime-tool-calls.md
// Purpose: produce evidence for the Path A / B / C decision in that spike, without
// touching Twilio, dialing any phone, or writing to the user's Codex directory.
//
// PRE-CONDITIONS (fail fast with a clear message if missing):
//   1. Codex CLI installed and reachable as `codex` (override with CODEX_BIN).
//   2. `codex login status` reports a logged-in ChatGPT account (realtime usage is billed to it).
//   3. `codex app-server --enable realtime_conversation` starts (realtime feature enabled).
//   4. The Electron app is built at `out/` (run `pnpm build` first; this script does NOT build).
//   5. OPTIONAL --mcp-server <name>: a Codex MCP server configured in ~/.codex/config.toml,
//      default "fetch", used for the Path B probe. The model may or may not be able to reach it
//      under the app's `approvalPolicy: never` + rejected-server-request policy.
//
// Usage:
//   node scripts/smoke-realtime-tools.mjs [project-cwd] [--mcp-server <name>]
//
// The script launches the built Electron app in mock mode (LIVE_PHONE_USE_MOCKS=1), opens a
// WebRTC peer to a fresh read-only Codex thread, and runs a bounded set of tool-call probes.
// It never dials a phone and never places a call.

import { _electron as electron } from '@playwright/test'
import { spawnSync } from 'node:child_process'

const codexBin = process.env.CODEX_BIN ?? 'codex'
const args = process.argv.slice(2)
const workdir = args[0] ?? process.cwd()
const mcpServer =
  (args.indexOf('--mcp-server') !== -1
    ? args[args.indexOf('--mcp-server') + 1]
    : undefined) ?? 'fetch'

// ---- precondition checks (fail fast, non-zero exit) -------------------------
const which = spawnSync('which', [codexBin], { encoding: 'utf8' })
if (which.status !== 0 || !which.stdout.trim()) {
  console.error(`[precondition] FAIL: Codex CLI '${codexBin}' not on PATH. Set CODEX_BIN or install Codex.`)
  process.exit(2)
}
const login = spawnSync(codexBin, ['login', 'status'], { encoding: 'utf8' })
if (login.status !== 0 || !/logged in|Logged in/i.test(login.stdout + login.stderr)) {
  console.error(
    `[precondition] FAIL: Codex is not logged in. Run 'codex login status' to confirm. ` +
      `(stderr: ${(login.stderr || '').trim().slice(0, 300)})`,
  )
  process.exit(2)
}
// The realtime feature flag is exercised by the app itself; a lightweight start check catches
// a broken app-server build early.
const probe = spawnSync(codexBin, ['app-server', '--enable', 'realtime_conversation', '--help'], {
  encoding: 'utf8',
  timeout: 15_000,
})
if (probe.status !== 0) {
  console.error(
    `[precondition] FAIL: 'codex app-server --enable realtime_conversation' did not start cleanly. ` +
      `(exit ${probe.status}: ${(probe.stderr || '').trim().slice(0, 300)})`,
  )
  process.exit(2)
}

console.log(
  `[env] codex=${codexBin} workdir=${workdir} mcp-server=${mcpServer} ` +
    `login=${(login.stdout.trim() || '?').split('\n')[0]}`,
)

// ---- launch the built app in mock mode (no Twilio, no dialing) --------------
const application = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    LIVE_PHONE_USE_MOCKS: '1',
    CODEX_WORKDIR: workdir,
  },
})

const SAMITIZE = (s) =>
  String(s)
    .replace(/[s][k]-[A-Za-z0-9_-]+/g, '[REDACTED_SK]')
    .replace(/[B][e][a][r][e][r][^\s]+/g, '[REDACTED_BEARER]')

try {
  const page = await application.firstWindow()
  const result = await page.evaluate(
    async ({ mcpServer }) => {
      const peer = new RTCPeerConnection()
      const context = new AudioContext()
      const destination = context.createMediaStreamDestination()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      gain.gain.value = 0
      oscillator.connect(gain).connect(destination)
      oscillator.start()
      peer.addTrack(destination.stream.getAudioTracks()[0], destination.stream)
      const channel = peer.createDataChannel('oai-events')
      const realtimeEvents = []
      channel.addEventListener('message', ({ data }) => {
        if (typeof data !== 'string') return
        try {
          const event = JSON.parse(data)
          realtimeEvents.push({
            type: event.type,
            ...(event.item?.type ? { itemType: event.item.type } : {}),
            ...(event.error?.message || event.message
              ? { error: event.error?.message ?? event.message }
              : {}),
          })
        } catch {
          realtimeEvents.push({ type: 'non-json-message' })
        }
      })

      // App-side events surfaced by the Electron main process (transcript, assistant-message, error).
      const appEvents = []
      window.livePhone.onEvent((event) => {
        appEvents.push({
          type: event.type,
          ...(event.type === 'transcript'
            ? { speaker: event.entry?.speaker, final: event.entry?.final, text: event.entry?.text }
            : {}),
          ...(event.type === 'assistant-message' ? { text: event.text } : {}),
          ...(event.type === 'error' ? { message: event.message } : {}),
        })
      })

      const waitFor = (predicate, timeoutMs, label) =>
        new Promise((resolve, reject) => {
          const startedAt = Date.now()
          const interval = window.setInterval(() => {
            if (predicate()) {
              window.clearInterval(interval)
              resolve(undefined)
            } else if (Date.now() - startedAt > timeoutMs) {
              window.clearInterval(interval)
              reject(new Error('Timed out waiting for ' + label))
            }
          }, 50)
        })

      const inboundAudioBytes = async () => {
        let bytes = 0
        ;(await peer.getStats()).forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            bytes += report.bytesReceived ?? 0
          }
        })
        return bytes
      }

      const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))
      // Poll appEvents for an assistant-message / final transcript containing a marker.
      const waitForAssistantSaid = (needle, timeoutMs) =>
        waitFor(
          () =>
            appEvents.some(
              (e) =>
                (e.type === 'assistant-message' && e.text && e.text.toLowerCase().includes(needle)) ||
                (e.type === 'transcript' &&
                  e.speaker === 'assistant' &&
                  e.final &&
                  e.text &&
                  e.text.toLowerCase().includes(needle)),
            ),
          timeoutMs,
          `assistant to mention "${needle}"`,
        )

      const startedAt = Date.now()
      const log = []
      const note = (msg) => {
        log.push({ atMs: Date.now() - startedAt, msg })
      }

      try {
        await peer.setLocalDescription(await peer.createOffer())
        await waitFor(() => peer.iceGatheringState === 'complete', 10_000, 'ICE gathering')
        const response = await window.livePhone.startRealtime({
          sdp: peer.localDescription.sdp,
          instructions:
            'You are a phone agent. If asked to look something up, use the fetch tool ' +
            `(MCP server '${mcpServer}') to read the URL and repeat the title. If a tool is ` +
            'unavailable, say so clearly.',
        })
        await peer.setRemoteDescription({ type: 'answer', sdp: response.sdp })
        await waitFor(
          () => peer.connectionState === 'connected' && channel.readyState === 'open',
          20_000,
          'WebRTC connected',
        )
        note(`realtime started thread=${response.threadId} session=${response.sessionId ?? 'n/a'}`)

        // ---- Experiment 1 (Path A / B probe): request a tool call mid-conversation ----
        const before = await inboundAudioBytes()
        await window.livePhone.appendText(
          `Please use the fetch tool to read https://example.com and repeat the page title back to me.`,
        )
        note('sent appendText: "use fetch tool to read https://example.com"')
        let gotTitle = false
        try {
          await waitForAssistantSaid('example domain', 30_000)
          gotTitle = true
          note('assistant repeated the fetched page title in audio/transcript')
        } catch {
          note('assistant did not repeat the fetched page title within 30s')
        }
        await sleep(4_000)
        const after = await inboundAudioBytes()
        const pathA_probe = {
          gotTitle,
          audioBytesReceived: after - before,
          realtimeEventTypes: realtimeEvents.map((e) => e.type),
          toolItemsInRealtime: realtimeEvents.filter((e) =>
            /function|tool|call/i.test(e.type + (e.itemType ?? '')),
          ),
          appEventTypes: [...new Set(appEvents.map((e) => e.type))],
        }
        note(`experiment1(pathA/probe) gotTitle=${gotTitle} audioBytes=${after - before}`)

        // ---- Experiment 3 (Path C validation): inject an external result via appendText ----
        const beforeC = await inboundAudioBytes()
        await window.livePhone.appendText(
          'External tool result: the page https://example.com has the title "Example Domain". ' +
            'Please verbally confirm this result to the caller.',
        )
        note('sent appendText: injected external tool result (Path C)')
        let confirmedInjection = false
        try {
          await waitForAssistantSaid('example domain', 30_000)
          confirmedInjection = true
          note('assistant confirmed the injected external tool result')
        } catch {
          note('assistant did not confirm the injected result within 30s')
        }
        await sleep(2_000)
        const afterC = await inboundAudioBytes()
        const pathC_probe = {
          confirmedInjection,
          audioBytesReceived: afterC - beforeC,
        }
        note(`experiment2(pathC) confirmedInjection=${confirmedInjection} audioBytes=${afterC - beforeC}`)

        return {
          threadId: response.threadId,
          sessionId: response.sessionId,
          connectionState: peer.connectionState,
          dataChannel: channel.readyState,
          pathA_probe,
          pathC_probe,
          log,
          realtimeEventTypes: [...new Set(realtimeEvents.map((e) => e.type))],
          assistantMessages: appEvents.filter((e) => e.type === 'assistant-message'),
          finalTranscripts: appEvents.filter((e) => e.type === 'transcript' && e.final),
        }
      } finally {
        peer.close()
        oscillator.stop()
        await context.close()
        await window.livePhone.stopRealtime()
      }
    },
    { mcpServer },
  )
  console.log(JSON.stringify(result, null, 2))
} finally {
  await application.close()
}