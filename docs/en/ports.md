# Ports

Five ports were extracted under the rule of two. Interfaces below are taken from `packages/core/src/ports/**`, plus `Clock` / `IdGen` from `packages/core/src/clock.ts` (the fifth port lives next to the ports barrel, not under `ports/`).

`packages/core/src/ports.ts` re-exports telephony, voice-session, text-model, and `OwnerEndpoint`. Core never sees Twilio SIDs, Electron windows, or file paths.

Reusable helpers live at `@mishu/adapters-mock/contract-tests`. Each real adapter package imports them from tests and calls `describeXPortContract(makePort, options)`. Mock adapters use the same helpers, so desktop, cloud, and fake implementations share one behavioural suite.

Public-layout paths: private-repo `src/**` maps to `apps/desktop/src/**`.

## 1. TelephonyPort

Source: `packages/core/src/ports/telephony.ts`.

```ts
export type TelephonyCallObservationType = 'ringing' | 'connected' | 'ended'
export type TelephonyOwnerObservationType = 'owner_ringing' | 'owner_joined' | 'owner_failed'

export type TelephonyErrorCode =
  | 'CALL_IN_PROGRESS'
  | 'NO_ACTIVE_CALL'
  | 'CAPABILITY_UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'APP_NOT_READY'

export interface TelephonyCapabilities {
  concurrentCalls: 'single' | 'many'
  ownerKinds: readonly OwnerEndpointKind[]
}

export interface TelephonyCommandInput {
  tenantId: string
  callId: string
  commandId: string
}

export interface TelephonyDialInput extends TelephonyCommandInput {
  peer: string
}

export interface TelephonyHangupInput extends TelephonyCommandInput {
  reason: string
}

export interface TelephonyTransferInput extends TelephonyCommandInput {
  handoffId: string
  owner: OwnerEndpoint
  timeoutSec: number
}

export interface TelephonyPort {
  capabilities(input: { tenantId: string }): TelephonyCapabilities
  dial(input: TelephonyDialInput): Promise<void>
  answer(input: TelephonyCommandInput): Promise<void>
  reject(input: TelephonyCommandInput): Promise<void>
  hangup(input: TelephonyHangupInput): Promise<void>
  transferToOwner(input: TelephonyTransferInput): Promise<void>
  subscribe(listener: TelephonyListener): () => void
}
```

Single-active-call hosts report `concurrentCalls: 'single'` and throw `CALL_IN_PROGRESS`. Core never sees conference or device identifiers.

| Host | Adapter | Notes |
|---|---|---|
| Desktop | `apps/desktop/src/main/telephony/desktop-telephony-adapter.ts` (`DesktopTelephonyAdapter`) | `ownerKinds: ['local_takeover']`. Commands go through the desktop phone gateway. |
| Cloud | `packages/adapters-cloud/src/telephony/telephony-port.ts` (`TwilioRestTelephonyAdapter`) | Twilio Calls / Conference REST. Port-contract test: `packages/adapters-cloud/src/telephony/twilio-rest-telephony-adapter.port-contract.test.ts`. |
| Mock | `packages/adapters-mock/src/telephony.ts` (`MockTelephony`) | Deterministic legs. Used by `apps/cloud` as the P2 default. |

Helper: `describeTelephonyPortContract(makePort, { capabilities })`.

## 2. VoiceSessionPort

Source: `packages/core/src/ports/voice-session.ts`.

```ts
export type VoiceAudioFormat = 'webrtc-sdp' | 'pcmu-8k' | 'pcm24k'

export interface VoiceSessionCapabilities {
  sdp: boolean
  websocketFrames: boolean
  localOnly: boolean
  fallbackVoicemail: boolean
  discardPlayback: boolean
}

export interface VoiceSessionStartInput extends VoiceSessionTarget {
  format: VoiceAudioFormat
  instructions: string
  voice: string
  sdp?: string
  openingLine?: string
}

export interface VoiceSessionStartResult {
  sessionId: string
  sdp?: string
}

export interface VoiceSessionPort {
  readonly capabilities: VoiceSessionCapabilities
  start(input: VoiceSessionStartInput): Promise<VoiceSessionStartResult>
  discardPlayback(input: VoiceSessionTarget): void
  appendFallbackVoicemail(input: VoiceSessionTarget): void
  close(input: VoiceSessionTarget & { reason: string }): Promise<void>
  subscribe(listener: (event: VoiceSessionEvent) => void): () => void
}
```

SDP is optional. Desktop may use `webrtc-sdp`; cloud uses framed `pcmu-8k` or `pcm24k`. Barge-in is `discardPlayback()` only: adapters drop queued playback locally and never send a provider "stop speaking" instruction. The Codex app-server (optional local adapter) sets `localOnly: true` and must not be selected by a cloud host.

| Host | Adapter | Notes |
|---|---|---|
| Desktop | `apps/desktop/src/main/voice/voice-session-adapter.ts` (`DesktopVoiceSessionAdapter`) | WebRTC SDP via the desktop voice provider. |
| Cloud | `packages/adapters-cloud/src/voice/media-bridge-session.ts` (`MediaBridgeVoiceSessionAdapter`) | Twilio Media Streams to GPT-Live WebSocket. Port-contract test: `packages/adapters-cloud/src/voice/media-bridge-session.port-contract.test.ts`. |
| Mock | `packages/adapters-mock/src/voice.ts` (`MockVoiceSession`) | Fake event/audio clock. Default in `apps/cloud`. |

Helper: `describeVoiceSessionPortContract(makePort, { formats, capabilities })`.

## 3. TextModelPort

Source: `packages/core/src/ports/text-model.ts`.

```ts
export const TEXT_MODEL_REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const
export type TextModelReasoningEffort = (typeof TEXT_MODEL_REASONING_EFFORTS)[number]

export interface TextModelJsonSchemaFormat {
  type: 'json_schema'
  name: string
  strict: boolean
  schema: Record<string, unknown>
}

export interface TextModelCompleteRequest {
  tenantId: string
  model?: string
  input: unknown
  text?: { format: TextModelJsonSchemaFormat }
  reasoning?: { effort: TextModelReasoningEffort }
  signal?: AbortSignal
}

export interface TextModelCompleteResult {
  outputText: string
  usage?: TextModelUsage
}

export interface TextModelPort {
  complete(request: TextModelCompleteRequest): Promise<TextModelCompleteResult>
}
```

This is a one-shot structured completion, not an in-call agent loop. `tenantId` is required on every call. Adapters that wrap the Codex app-server (optional local adapter) ignore per-request `reasoning` and omit `usage`. Hangup judging is a fail-closed helper over this port (`createTextModelHangupJudge` in `packages/core/src/ports/text-model/hangup-judge.ts`): a port error, abort, empty body, or non-boolean `end` never hangs up.

| Host | Adapter | Notes |
|---|---|---|
| Desktop | `apps/desktop/src/main/analysis/text-model-adapter.ts` (`AnalysisTextModelAdapter`) | Post-call extraction over the desktop analysis backend. |
| Cloud | `packages/adapters-cloud` `createOpenAiTextModelPort` (`packages/adapters-cloud/src/model/openai-responses-transport.ts`) | OpenAI Responses. Port-contract test: `packages/adapters-cloud/src/model/openai-text-model.port-contract.test.ts`. |
| Mock | `packages/adapters-mock/src/model.ts` (`MockTextModel`) | Scripted replies. Default in `apps/cloud`. |

Helper: `describeTextModelPortContract(makePort, options?)`.

## 4. Handoff OwnerEndpoint

Source: `packages/core/src/ports/handoff-owner.ts` re-exports `OwnerEndpoint` from `@mishu/core/handoff`. The live type and accept rules are in `packages/core/src/handoff/types.ts` and `packages/core/src/handoff/endpoint.ts`.

```ts
export type OwnerEndpoint =
  | { kind: 'client'; identity: string }
  | { kind: 'pstn'; number: string }
  | { kind: 'local_takeover' }
```

Core emits `transferToOwner` with an `OwnerEndpoint`. Adapters own Conference join or local mic takeover. PSTN owners must confirm with Gather digit 1. A desktop `client` (and `local_takeover`) "answered" counts as owner-joined; see `ownerAcceptsOnAnswered` in `packages/core/src/handoff/endpoint.ts`.

| Host | Adapter | Notes |
|---|---|---|
| Desktop | `DesktopTelephonyAdapter` + renderer control-mode switch | `local_takeover` only. Audio-route facts stay in the adapter. |
| Cloud | `TwilioRestTelephonyAdapter` | `client` and `pstn` endpoints; Conference CAS in the adapter. |
| Mock | `MockTelephony` | Scripted owner outcomes (`MockOwnerOutcome`). |

There is no separate `describeHandoffPortContract` helper. Handoff behaviour is covered by core unit tests in `packages/core/src/handoff/**` and by telephony port contracts that exercise `transferToOwner`.

## 5. Clock / IdGen

Source: `packages/core/src/clock.ts` (`packages/core/src/clock/system.ts`, `packages/core/src/clock/id-gen.ts`).

```ts
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

export interface IdGen {
  id(): string
}
```

| Host | Adapter | Notes |
|---|---|---|
| Desktop | `@mishu/core/clock` `systemClock` / `systemIdGen` | Wired from `apps/desktop/src/main/index.ts`. |
| Cloud | same `systemClock` / `systemIdGen` | Wired from `apps/cloud/src/assemble.ts`. |
| Mock | `packages/adapters-mock/src/clock.ts` (`FakeClock`, `FakeIdGen`) | Stopped clock; `advance(ms)` is the only way time moves. |

Helper: `describeClockContract(makeClock)`. `makeClock` must start stopped.

## Contract-test imports

```ts
import {
  describeClockContract,
  describeTelephonyPortContract,
  describeVoiceSessionPortContract,
  describeTextModelPortContract
} from '@mishu/adapters-mock/contract-tests'
```

The `/v1` black-box kit in `tests/contract/` is a different layer: it talks HTTP to a running engine, not to a port object. Both layers must stay green. See [architecture.md](architecture.md) and [quickstart.md](quickstart.md).
