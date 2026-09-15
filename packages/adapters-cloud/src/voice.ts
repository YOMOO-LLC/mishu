/** T12.15 VoiceSession adapter. MediaBridge production subset lives here. */
export const ADAPTERS_CLOUD_VOICE_TASK = 'T12.15'

export {
  MediaBridge,
  DEFAULT_UNSUPPRESS_SILENCE_FRAMES,
  DEFAULT_HANGUP_SILENCE_MS,
  DEFAULT_HANGUP_PLAYBACK_WAIT_MS,
  type BridgeIdentity,
  type BridgeObservation,
  type BridgeDecision,
  type BridgeDecisionKind,
  type MediaBridgeOptions
} from './voice/media-bridge.js'
export { MediaBridgeVoiceSessionAdapter } from './voice/media-bridge-session.js'
export {
  createMetrics,
  exportMetricsJson,
  type BridgeMetrics,
  type InterruptSource,
  type TurnLatency
} from './voice/metrics.js'
export {
  emptyDecisionCounts,
  inputTranscriptHasExpectedName,
  relativeMs,
  recordDecision,
  serializeCallTrace,
  rawEventType,
  type CallTrace,
  type DecisionCounts,
  type TimedDecision,
  type TimedType
} from './voice/call-trace.js'

export * from './voice/protocol/gpt-live.js'
export * from './voice/protocol/audio-transcode.js'
export * from './voice/protocol/mulaw.js'
export * from './voice/protocol/wav.js'
export {
  TWILIO_MEDIA_ENCODING,
  TWILIO_MEDIA_SAMPLE_RATE,
  TWILIO_MEDIA_CHANNELS,
  CUSTOM_PARAMETER_WHITELIST,
  whitelistCustomParameters,
  isValidMediaFormat,
  parseTwilioMessage,
  extractSequenceNumber,
  sequenceDelta,
  outboundMediaMessage,
  outboundMarkMessage,
  outboundClearMessage,
  connectStreamTwiml,
  conferenceTwiml,
  ownerGatherTwiml,
  type CustomParameterName,
  type TwilioMediaFormat,
  type TwilioStartMessage,
  type TwilioMediaMessage,
  type TwilioMarkMessage,
  type TwilioStopMessage,
  type TwilioConnectedMessage,
  type TwilioDtmfMessage,
  type TwilioInboundMessage
} from './voice/protocol/twilio-media.js'
export * from './voice/protocol/redact.js'
