import { FakeClock } from '@mishu/adapters-mock/clock'
import { describeVoiceSessionPortContract } from '@mishu/adapters-mock/contract-tests'
import { MediaBridgeVoiceSessionAdapter } from './media-bridge-session.js'

describeVoiceSessionPortContract(
  () => new MediaBridgeVoiceSessionAdapter(new FakeClock(1_000)),
  {
    formats: ['pcmu-8k', 'pcm24k'],
    capabilities: {
      sdp: false,
      websocketFrames: true,
      localOnly: false,
      fallbackVoicemail: true,
      discardPlayback: true
    }
  }
)
