/** Workspace package for @mishu/adapters-mock port-level fakes. */
export const ADAPTERS_MOCK_STUB_VERSION = 'mishu-adapters-mock-0.0.0-stub'

export {
  ADAPTERS_MOCK_CLOCK_TASK,
  FakeClock,
  FakeIdGen
} from './clock.js'
export {
  ADAPTERS_MOCK_TELEPHONY_TASK,
  MockTelephony,
  type MockOwnerOutcome,
  type MockTelephonyOptions
} from './telephony.js'
export {
  ADAPTERS_MOCK_VOICE_TASK,
  MockVoiceSession,
  type MockVoiceAction,
  type MockVoiceSessionOptions
} from './voice.js'
export {
  ADAPTERS_MOCK_MODEL_TASK,
  MockTextModel,
  type MockTextModelMatch,
  type MockTextModelOptions,
  type MockTextModelScript
} from './model.js'
