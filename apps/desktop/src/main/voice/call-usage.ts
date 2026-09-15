import type { CallStore } from '../call-store.js'
import type { VoiceProviderName } from '../../shared/contracts.js'
import type { VoiceEvent } from './provider.js'

/** Keep the call association after call.ended so graceful-close usage is not lost. */
export function bindVoiceUsage(
  voice: { subscribe(listener: (event: VoiceEvent) => void): () => void },
  store: CallStore,
  provider: () => VoiceProviderName
): () => void {
  let callId: string | undefined
  let seconds: number | undefined
  const unlistenCall = store.onEvent((event) => {
    if (event.type !== 'call.started') return
    callId = event.call.id
    store.setVoiceUsage(callId, provider(), seconds)
  })
  const unlistenVoice = voice.subscribe((event) => {
    if (event.type === 'started') {
      callId = store.getActiveCallId()
      seconds = undefined
    } else if (event.type === 'usage') {
      seconds = Math.max(seconds ?? 0, event.seconds)
      callId ??= store.getActiveCallId()
      if (callId) store.setVoiceUsage(callId, 'gpt-live-api', seconds)
    } else if (event.type === 'closed') {
      if (provider() === 'gpt-live-api') {
        store.writeAudit('voice.session.closed', callId, {
          reason: event.reason,
          finalUsageConfirmed: !['connection_lost', 'finalization_timeout'].includes(event.reason)
        })
      }
      seconds = undefined
      callId = undefined
    }
  })
  return () => { unlistenVoice(); unlistenCall() }
}
