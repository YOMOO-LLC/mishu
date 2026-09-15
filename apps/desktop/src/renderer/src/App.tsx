import { useEffect, useMemo, useState } from 'react'

import type { CallStatus, TranscriptEntry } from '@shared/contracts'
import { CallHistoryPanel } from './CallHistoryPanel'
import { ApprovalModal } from './ApprovalModal'
import { CampaignPanel } from './CampaignPanel'
import { SettingsPanel } from './SettingsPanel'
import { TasksPanel } from './TasksPanel'
import { useCampaigns } from './hooks/useCampaigns'
import { useCopilotStatus } from './hooks/useCopilotStatus'
import { usePhoneController } from './hooks/usePhoneController'
import { normalizePhoneNumber } from './services/phone-number'

function formatDuration(startedAt?: number, now = Date.now()): string {
  if (!startedAt) return '00:00'
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function callStatusLabel(status?: CallStatus): string {
  switch (status) {
    case 'ringing':
      return 'Incoming ring'
    case 'dialing':
      return 'Dialing'
    case 'connecting':
      return 'Connecting'
    case 'active':
      return 'On a call'
    case 'held':
      return 'On hold'
    case 'ended':
      return 'Call ended'
    case 'error':
      return 'Connection failed'
    case 'idle':
    case undefined:
      return 'Waiting for calls'
  }
}

function StatusPill({
  label,
  status,
  idleLabel = 'Standby',
  testId
}: {
  label: string
  status: 'idle' | 'connecting' | 'ready' | 'error'
  idleLabel?: string
  testId: string
}): React.JSX.Element {
  const detail = {
    idle: idleLabel,
    connecting: 'Connecting',
    ready: 'Connected',
    error: 'Error'
  }[status]

  return (
    <div className={`status-pill status-pill--${status}`} data-testid={testId}>
      <span className="status-pill__dot" aria-hidden="true" />
      <span>{label}</span>
      <strong>{detail}</strong>
    </div>
  )
}

function PhoneIcon({ direction = 'outbound' }: { direction?: 'inbound' | 'outbound' }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.1 3.7 9.4 8a1.6 1.6 0 0 1-.28 1.9l-1.04.98a14.1 14.1 0 0 0 5.03 5.04l.99-1.04a1.6 1.6 0 0 1 1.9-.28l4.3 2.3a1.6 1.6 0 0 1 .8 1.77l-.45 2A1.7 1.7 0 0 1 19 22C9.61 22 2 14.39 2 5a1.7 1.7 0 0 1 1.33-1.65l2-.45a1.6 1.6 0 0 1 1.77.8Z" />
      {direction === 'inbound' ? <path d="m13 3 5 5m0-5v5h-5" /> : <path d="m13 8 5-5m-5 0h5v5" />}
    </svg>
  )
}

function Transcript({
  entries,
  emptyState
}: {
  entries: TranscriptEntry[]
  emptyState: { title: string; detail: string }
}): React.JSX.Element {
  return (
    <section className="transcript panel" aria-labelledby="transcript-title">
      <div className="panel__heading">
        <div>
          <span className="eyebrow">LIVE TRANSCRIPT</span>
          <h2 id="transcript-title">Live transcript</h2>
        </div>
        <span className="live-chip"><i />Live</span>
      </div>

      <div className="transcript__body" data-testid="transcript-list" aria-live="polite">
        {entries.length === 0 ? (
          <div className="transcript__empty" data-testid="transcript-empty">
            <span className="waveform" aria-hidden="true">
              {[8, 18, 26, 13, 32, 20, 10].map((height, index) => (
                <i key={index} style={{ height }} />
              ))}
            </span>
            <strong>{emptyState.title}</strong>
            <p>{emptyState.detail}</p>
          </div>
        ) : (
          entries.map((entry) => (
            <article
              className={`transcript-entry transcript-entry--${entry.speaker}`}
              data-testid="transcript-entry"
              key={entry.id}
            >
              <div className="transcript-entry__meta">
                <span>{entry.speaker === 'assistant' ? 'Assistant' : entry.speaker === 'caller' ? 'Caller' : 'System'}</span>
                <time>{new Date(entry.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</time>
              </div>
              <p>{entry.text}</p>
              {!entry.final && <span className="typing-dot" aria-label="Transcribing" />}
            </article>
          ))
        )}
      </div>
    </section>
  )
}

export default function App(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'calls' | 'tasks' | 'history' | 'settings'>('calls')
  const {
    state,
    dial,
    answer,
    reject,
    hangup,
    setCallProfile,
    setCampaignSnapshot,
    setControlMode,
    simulateIncoming: requestSimulatedIncoming
  } = usePhoneController()
  const {
    workspace: campaignWorkspace,
    loading: campaignsLoading,
    error: campaignError,
    clearError: clearCampaignError,
    saveCampaign,
    deleteCampaign,
    selectCampaign
  } = useCampaigns()
  const copilotStatus = useCopilotStatus()
  const [number, setNumber] = useState('+1 312 555 0198')
  const [numberError, setNumberError] = useState('')
  const [actionError, setActionError] = useState('')
  const [now, setNow] = useState(Date.now())
  const [voiceProvider, setVoiceProvider] = useState('codex')
  useEffect(() => {
    void window.livePhone.getVoiceSettings?.().then((value) => setVoiceProvider(value.provider))
    const update = (event: Event): void => setVoiceProvider((event as CustomEvent<{ provider: string }>).detail.provider)
    window.addEventListener('voice-settings-updated', update)
    const unsubscribe = window.livePhone.onEvent((event) => { if (event.type === 'voice-settings') setVoiceProvider(event.settings.provider) })
    return () => { unsubscribe(); window.removeEventListener('voice-settings-updated', update) }
  }, [])
  const [twilioConfiguredLocally, setTwilioConfiguredLocally] = useState(false)

  const {
    call,
    codexConnection,
    controlMode,
    phoneConnection,
    runtimeMode,
    transcript,
    twilioPhoneNumber,
    runtimeNotice,
    codexError
  } = state

  const isActive = call?.status === 'active' || call?.status === 'held'
  const isRinging = call?.status === 'ringing'
  const campaignLocked = Boolean(call && !['ended', 'error', 'idle'].includes(call.status))
  const campaigns = campaignWorkspace?.campaigns ?? []
  const selectedCampaign = campaigns.find(({ id }) => id === campaignWorkspace?.selectedCampaignId)
  const duration = useMemo(() => formatDuration(call?.startedAt, now), [call?.startedAt, now])

  useEffect(() => {
    if (!isActive) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [isActive])

  useEffect(() => {
    const handle = (event: Event): void => {
      setTwilioConfiguredLocally(Boolean((event as CustomEvent<{ configured?: boolean }>).detail?.configured))
    }
    window.addEventListener('twilio-settings-updated', handle)
    return () => window.removeEventListener('twilio-settings-updated', handle)
  }, [])

  useEffect(() => {
    if (selectedCampaign) {
      setCallProfile(selectedCampaign)
      setCampaignSnapshot(selectedCampaign)
    }
  }, [selectedCampaign, setCallProfile, setCampaignSnapshot])

  function startOutboundCall(): void {
    let peer: string
    try {
      peer = normalizePhoneNumber(number)
    } catch (error) {
      setNumberError(error instanceof Error ? error.message : String(error))
      return
    }
    if (!selectedCampaign) {
      setActionError('Select a Campaign first')
      return
    }
    if (selectedCampaign.direction === 'inbound') {
      setActionError('This Campaign is inbound-only; choose one that supports outbound')
      return
    }
    setNumberError('')
    setActionError('')
    void dial(peer, selectedCampaign.systemPrompt, selectedCampaign.voice).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error))
    })
  }

  function simulateIncoming(): void {
    setActionError('')
    void requestSimulatedIncoming('+1 415 555 0142').catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error))
    })
  }

  function answerCall(): void {
    setActionError('')
    void answer().catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error))
    })
  }

  function endCall(action: 'reject' | 'hangup'): void {
    setActionError('')
    const pending = action === 'reject' ? reject() : hangup()
    void pending.catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error))
    })
  }

  function selectControlMode(mode: 'ai' | 'human'): void {
    setActionError('')
    void setControlMode(mode).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error))
    })
  }

  const heroState = isActive ? 'active' : isRinging ? 'ringing' : call?.status === 'dialing' ? 'dialing' : 'idle'
  const controlState = !isActive
    ? { className: 'idle', label: 'Waiting for a call' }
    : controlMode === 'human'
      ? { className: 'human', label: 'Human call' }
      : codexConnection.status === 'ready'
        ? { className: 'ai', label: 'AI live' }
        : codexConnection.status === 'connecting'
          ? { className: 'connecting', label: 'AI connecting' }
          : codexConnection.status === 'error'
            ? { className: 'error', label: 'AI error' }
            : { className: 'idle', label: 'AI disconnected' }
  const footerState = runtimeMode === 'loading'
    ? { status: 'connecting', label: 'Loading runtime config' }
    : runtimeMode === 'mock'
      ? { status: 'idle', label: 'Mock mode · no local app-server' }
      : codexConnection.status === 'idle'
        ? { status: 'idle', label: 'GPT Live not started' }
        : codexConnection.status === 'connecting'
          ? { status: 'connecting', label: 'Connecting to local Codex app-server' }
          : codexConnection.status === 'ready'
            ? { status: 'ready', label: voiceProvider === 'gpt-live-api' ? 'GPT Live · API connected' : 'Local Codex app-server · GPT Live connected' }
            : { status: 'error', label: 'Codex app-server / GPT Live error' }
  const transcriptEmptyState = !isActive
    ? { title: 'Transcripts appear here after a call starts', detail: 'Caller and Assistant speech is labeled in real time.' }
    : controlMode === 'human'
      ? { title: 'Human takeover in progress', detail: 'Switch back to AI takeover for live AI answers.' }
      : codexConnection.status === 'ready'
        ? { title: 'Assistant is ready; you can speak now', detail: 'Assistant greets the caller first; you do not need to reconfirm the line.' }
        : codexConnection.status === 'error'
          ? { title: 'Assistant failed to join', detail: 'You can switch to human takeover first, then retry AI.' }
          : { title: 'Assistant is joining, please wait…', detail: 'Wait for the assistant greeting before speaking so the opening is not missed.' }

  return (
    <main className="app-shell" data-testid="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark"><PhoneIcon /></span>
          <div>
            <strong data-testid="app-title">Mishu</strong>
            <span>AI phone assistant</span>
          </div>
        </div>
        <div className="topbar__status">
          <div
            className={`copilot-badge copilot-badge--${copilotStatus.state}`}
            data-testid="copilot-status"
          >
            <span>Copilot</span>
            <strong>{copilotStatus.enabled ? copilotStatus.state : 'Off'}</strong>
            {copilotStatus.lastToolCall && (
              <small data-testid="copilot-last-tool">{copilotStatus.lastToolCall.toolId}</small>
            )}
          </div>
          <StatusPill label={voiceProvider === 'gpt-live-api' ? 'GPT Live · API' : 'Local Codex app-server'} status={codexConnection.status} idleLabel="Not started" testId="codex-status" />
          <StatusPill label={runtimeMode === 'mock' ? 'Twilio Mock' : 'Twilio'} status={phoneConnection} testId="twilio-status" />
        </div>
      </header>

      <nav className="tab-bar" aria-label="Main navigation">
        <button
          className={`tab-button ${activeTab === 'calls' ? 'selected' : ''}`}
          data-testid="tab-calls"
          onClick={() => setActiveTab('calls')}
        >Calls</button>
        <button
          className={`tab-button ${activeTab === 'tasks' ? 'selected' : ''}`}
          data-testid="tab-tasks"
          onClick={() => setActiveTab('tasks')}
        >Tasks</button>
        <button
          className={`tab-button ${activeTab === 'history' ? 'selected' : ''}`}
          data-testid="tab-history"
          onClick={() => setActiveTab('history')}
        >History</button>
        <button
          className={`tab-button ${activeTab === 'settings' ? 'selected' : ''}`}
          data-testid="tab-settings"
          onClick={() => setActiveTab('settings')}
        >Settings</button>
      </nav>

      {((runtimeNotice && !twilioConfiguredLocally) || codexError) && (
        <section className="runtime-warnings" aria-label="Runtime notices">
          {runtimeNotice && !twilioConfiguredLocally && (
            <div className="runtime-warning runtime-warning--mock" data-testid="runtime-mode-warning">
              <strong>Twilio is not configured; running in mock mode</strong>
              <button data-testid="runtime-settings-button" onClick={() => {
                setActiveTab('settings')
                window.setTimeout(() => document.getElementById('twilio-settings')?.scrollIntoView(), 0)
              }}>Open settings</button>
            </div>
          )}
          {codexError && (
            <div className="runtime-warning runtime-warning--error" data-testid="codex-config-warning">
              <strong>Codex CLI is unavailable</strong>
              <span>{codexError}</span>
            </div>
          )}
        </section>
      )}

      {activeTab === 'calls' ? (
      <div className="workspace">
        <CampaignPanel
          campaigns={campaigns}
          selectedCampaignId={campaignWorkspace?.selectedCampaignId}
          disabled={campaignLocked}
          loading={campaignsLoading}
          error={campaignError}
          twilioPhoneNumber={twilioPhoneNumber}
          onClearError={clearCampaignError}
          onSelect={selectCampaign}
          onSave={saveCampaign}
          onDelete={deleteCampaign}
        />
        <section className="phone-column">
          <section className={`call-hero call-hero--${heroState} panel`} aria-labelledby="call-state-title">
            <div className="call-hero__ambient" aria-hidden="true"><i /><i /><i /></div>
            <span className="eyebrow">CALL SESSION</span>
            <div className="call-avatar">
              <PhoneIcon direction={call?.direction ?? 'outbound'} />
            </div>
            <h1 id="call-state-title" data-testid="call-status">{callStatusLabel(call?.status)}</h1>
            <p className="call-peer" data-testid="call-peer">
              {call?.peer ?? 'Line is ready to answer or place a call'}
            </p>
            <div className="call-metrics">
              <span>{call?.direction === 'inbound' ? 'Inbound' : call ? 'Outbound' : 'Idle'}</span>
              <strong data-testid="call-duration">{duration}</strong>
              <span>
                {isActive
                  ? controlMode === 'human'
                    ? 'Human takeover'
                    : codexConnection.status === 'ready'
                      ? 'AI ready'
                      : 'AI joining'
                  : 'Not in control'}
              </span>
            </div>

            {isRinging ? (
              <div className="incoming-actions" data-testid="incoming-banner">
                <button className="round-action round-action--decline" data-testid="reject-button" onClick={() => endCall('reject')}>
                  <PhoneIcon /><span>Decline</span>
                </button>
                <button className="round-action round-action--accept" data-testid="answer-button" onClick={answerCall}>
                  <PhoneIcon /><span>Answer</span>
                </button>
              </div>
            ) : isActive || call?.status === 'dialing' || call?.status === 'connecting' ? (
              <button className="hangup-button" data-testid="hangup-button" onClick={() => endCall('hangup')}>
                <PhoneIcon />Hang up
              </button>
            ) : (
              <div className="dialer">
                <div className="active-campaign-brief" data-testid="active-campaign-brief">
                  <span>Using Campaign</span>
                  <strong>{selectedCampaign?.name ?? (campaignsLoading ? 'Loading…' : 'None selected')}</strong>
                  <small>{selectedCampaign ? `${selectedCampaign.voice} · ${selectedCampaign.direction === 'both' ? 'Inbound + outbound' : selectedCampaign.direction === 'outbound' ? 'Outbound only' : 'Inbound only'}` : 'Create a campaign on the left first'}</small>
                </div>
                <label htmlFor="phone-number">Place a call</label>
                <div className={`dialer__field ${numberError ? 'dialer__field--error' : ''}`}>
                  <span>+</span>
                  <input
                    id="phone-number"
                    data-testid="dial-input"
                    inputMode="tel"
                    value={number.replace(/^\+/, '')}
                    onChange={(event) => setNumber(`+${event.target.value}`)}
                    onKeyDown={(event) => event.key === 'Enter' && startOutboundCall()}
                    aria-describedby={numberError ? 'phone-error' : undefined}
                  />
                  <button data-testid="dial-button" disabled={!selectedCampaign || selectedCampaign.direction === 'inbound'} onClick={startOutboundCall} aria-label="Place call">
                    <PhoneIcon />
                  </button>
                </div>
                {numberError && <p className="field-error" id="phone-error">{numberError}</p>}
                {runtimeMode === 'mock' && (
                  <button className="simulate-link" data-testid="simulate-incoming-button" onClick={simulateIncoming}>
                    Simulate an inbound call
                  </button>
                )}
                {(actionError || state.error) && <p className="action-error" data-testid="action-error">{actionError || state.error}</p>}
              </div>
            )}
          </section>

          <section className="control-card panel" aria-labelledby="control-title">
            <div className="panel__heading panel__heading--compact">
              <div>
                <span className="eyebrow">CALL CONTROL</span>
                <h2 id="control-title">Call takeover</h2>
              </div>
              <span className={`control-state control-state--${controlState.className}`} data-testid="control-status">
                {controlState.label}
              </span>
            </div>
            <div className="segmented-control" role="group" aria-label="Call takeover mode">
              <button
                className={controlMode === 'ai' ? 'selected' : ''}
                data-testid="ai-control-button"
                disabled={!isActive}
                onClick={() => selectControlMode('ai')}
                aria-pressed={controlMode === 'ai'}
              >
                <span className="mode-icon mode-icon--ai">✦</span>
                <span><strong>AI takeover</strong><small>AI answers live</small></span>
              </button>
              <button
                className={controlMode === 'human' ? 'selected' : ''}
                data-testid="human-control-button"
                disabled={!isActive}
                onClick={() => selectControlMode('human')}
                aria-pressed={controlMode === 'human'}
              >
                <span className="mode-icon">◎</span>
                <span><strong>Human takeover</strong><small>Microphone passthrough</small></span>
              </button>
            </div>
          </section>
        </section>

        <Transcript entries={transcript} emptyState={transcriptEmptyState} />
      </div>
      ) : activeTab === 'tasks' ? (
        <TasksPanel onOpenCall={() => setActiveTab('history')} />
      ) : activeTab === 'history' ? (
        <CallHistoryPanel />
      ) : (
        <SettingsPanel />
      )}

      <footer className={`footer-bar footer-bar--${footerState.status}`}>
        <span data-testid="footer-codex-status"><i />{footerState.label}</span>
        <span>{runtimeMode === 'mock' ? 'Demo mode' : runtimeMode === 'twilio' ? 'Live line' : 'Initializing'}</span>
      </footer>
      <ApprovalModal />
    </main>
  )
}
