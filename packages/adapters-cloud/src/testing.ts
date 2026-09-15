/** Protocol-level doubles for @mishu/adapters-cloud. Port-level mocks belong to adapters-mock. */
export {
  FakeGptLiveSession,
  audioDelta,
  inputTranscript,
  outputTranscript
} from './testing/fake-gpt-live.js'
export { FakeLiveSocket } from './testing/fake-live-socket.js'
export {
  FakeTwilioMediaClient,
  twilioConnected,
  twilioStart,
  twilioMedia,
  twilioStop,
  twilioMark,
  type AdvancingClock
} from './testing/fake-twilio-media.js'
export { FakeTwilioRest } from './testing/fake-twilio-rest.js'
