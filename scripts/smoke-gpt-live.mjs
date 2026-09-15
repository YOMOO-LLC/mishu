import { _electron as electron } from '@playwright/test'

const application = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    LIVE_PHONE_USE_MOCKS: '1',
    CODEX_WORKDIR: process.argv[2] ?? process.cwd()
  }
})

try {
  const page = await application.firstWindow()
  const result = await page.evaluate(async () => {
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
          ...(event.error?.message || event.message
            ? { error: event.error?.message ?? event.message }
            : {})
        })
      } catch {
        realtimeEvents.push({ type: 'non-json-message' })
      }
    })

    const waitFor = (predicate, timeoutMs) =>
      new Promise((resolve, reject) => {
        const startedAt = Date.now()
        const interval = window.setInterval(() => {
          if (predicate()) {
            window.clearInterval(interval)
            resolve(undefined)
          } else if (Date.now() - startedAt > timeoutMs) {
            window.clearInterval(interval)
            reject(new Error('Timed out waiting for GPT Live WebRTC'))
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

    try {
      await peer.setLocalDescription(await peer.createOffer())
      await waitFor(() => peer.iceGatheringState === 'complete', 10_000)
      const response = await window.livePhone.startRealtime({ sdp: peer.localDescription.sdp })
      await peer.setRemoteDescription({ type: 'answer', sdp: response.sdp })
      await waitFor(
        () => peer.connectionState === 'connected' && channel.readyState === 'open',
        20_000
      )
      const bytesBeforeSpeech = await inboundAudioBytes()
      channel.send(
        JSON.stringify({
          type: 'session.context.append',
          channel: 'speakable',
          content: [{ type: 'input_text', text: 'GPT Live audio output smoke test.' }]
        })
      )
      await new Promise((resolve) => window.setTimeout(resolve, 8_000))
      const bytesAfterSpeech = await inboundAudioBytes()
      const realtimeError = realtimeEvents.find(({ type }) => type === 'error')
      if (realtimeError || bytesAfterSpeech <= bytesBeforeSpeech + 5_000) {
        throw new Error(
          `GPT Live connected but did not deliver synthesized audio: ${JSON.stringify(realtimeEvents)}`
        )
      }
      return {
        threadId: response.threadId,
        sessionId: response.sessionId,
        connectionState: peer.connectionState,
        dataChannel: channel.readyState,
        audioBytesReceived: bytesAfterSpeech - bytesBeforeSpeech,
        realtimeEventTypes: realtimeEvents.map(({ type }) => type)
      }
    } finally {
      peer.close()
      oscillator.stop()
      await context.close()
      await window.livePhone.stopRealtime()
    }
  })
  console.log(JSON.stringify(result, null, 2))
} finally {
  await application.close()
}
