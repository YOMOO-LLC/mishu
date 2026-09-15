/** PAID SMOKE: creates a real session; costs approximately $0.0125 or more.
 * Requires explicit user authorization. Never run as part of check/test/E2E.
 * Supply a valid WebRTC SDP offer via --sdp-file; this checks exchange/control,
 * not bidirectional audio. The browser that created the offer must apply the answer
 * for media readiness; this bounded probe closes immediately and reports final usage.
 */
import { readFile } from 'node:fs/promises'
import WebSocket from 'ws'

async function main() {
  if (!process.argv.includes('--authorized-paid-smoke')) throw new Error('Explicit authorization flag required')
  const index = process.argv.indexOf('--sdp-file')
  if (index < 0 || !process.argv[index + 1] || !process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY and --sdp-file are required')
  const sdp = await readFile(process.argv[index + 1], 'utf8')
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  const response = await fetch('https://api.openai.com/v1/live/sessions', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ session: { model: 'gpt-live-1', instructions: 'Remain silent.', audio: { output: { voice: 'marin' } }, delegation: { type: 'client' } }, transport: { type: 'webrtc', sdp } })
  })
  if (!response.ok) throw new Error('Session creation failed')
  const body = await response.json()
  if (!body.session?.id || !body.transport?.sdp) throw new Error('Invalid session response')
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(body.session.id)}/attach`, { headers, followRedirects: false })
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Final usage unconfirmed')) }, 15000)
    // Listener is installed before requesting close; do not wait for absent media.
    socket.on('message', (raw) => {
      try {
        const event = JSON.parse(raw.toString())
        if (event.type === 'session.closed') {
          console.log(JSON.stringify({ sdpExchange: true, seconds: event.usage?.seconds, reason: event.reason }))
          clearTimeout(timer); socket.close(); resolve()
        }
      } catch { /* Ignore unknown messages. */ }
    })
    socket.on('open', () => socket.send(JSON.stringify({ type: 'session.close' })))
    socket.on('error', () => { clearTimeout(timer); reject(new Error('Sideband failed; final usage unconfirmed')) })
  })
}
main().catch(() => { console.error('GPT Live API smoke failed; final usage may be unconfirmed. No credentials were logged.'); process.exitCode = 1 })
