import type {
  CallEndReason,
  CodexConnectionState,
  ConnectionStatus,
  PhoneCall,
  TranscriptEntry
} from '../../../shared/contracts'

export type ControlMode = 'ai' | 'human'

export interface PhoneAdapterState {
  connection: ConnectionStatus
  call?: PhoneCall
  error?: string
  endReason?: CallEndReason
}

export interface PhoneAdapter {
  getState(): PhoneAdapterState
  subscribe(listener: () => void): () => void
  initialize(token?: string): Promise<void>
  dial(peer: string): Promise<void>
  answer(): Promise<void>
  reject(): Promise<void>
  hangup(reason?: CallEndReason): Promise<void>
  setControlMode(mode: ControlMode): Promise<void>
  setAssistantStream(stream?: MediaStream): Promise<void>
  getCallerStream(): MediaStream | undefined
  getAssistantStream?(): MediaStream | undefined
  dispose(): Promise<void>
  simulateIncoming?(peer?: string): Promise<void>
  simulateRemoteHangup?(): Promise<void>
}

/**
 * Renderer call-control methods that the desktop TelephonyPort adapter maps
 * through PhoneCommandGateway. setControlMode('human') is
 * transferToOwner({ owner: { kind: 'local_takeover' } }). Audio Device APIs
 * stay on PhoneAdapter and are not part of the port.
 */
export type PhoneAdapterCallControl = Pick<
  PhoneAdapter,
  'dial' | 'answer' | 'reject' | 'hangup' | 'setControlMode'
>

export interface GptLiveState {
  connection: CodexConnectionState
  outputStream?: MediaStream
}

export interface PhoneControllerState {
  runtimeMode: 'loading' | 'mock' | 'twilio'
  twilioPhoneNumber?: string
  configPath?: string
  runtimeNotice?: string
  codexCommand?: string
  codexError?: string
  phoneConnection: ConnectionStatus
  codexConnection: CodexConnectionState
  call?: PhoneCall
  controlMode: ControlMode
  transcript: TranscriptEntry[]
  error?: string
}
