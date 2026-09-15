import { useEffect, useState } from 'react'
import type { Appointment, CallSession, GuardrailEvent, RecordingInfo, TranscriptEntry } from '@shared/contracts'
import { buildCallExport, maskPhoneNumber } from './services/call-export'

export interface CallDetailProps {
  session: CallSession
  transcript: TranscriptEntry[]
  recording?: RecordingInfo
  onBack: () => void
}

function formatDuration(milliseconds?: number): string {
  if (milliseconds === undefined || milliseconds < 0) return '—'
  const totalSeconds = Math.floor(milliseconds / 1000)
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function speakerLabel(speaker: TranscriptEntry['speaker']): string {
  return speaker === 'assistant' ? 'Assistant' : speaker === 'caller' ? 'Caller' : 'System'
}

function downloadCallExport(
  session: CallSession,
  transcript: TranscriptEntry[],
  recording?: RecordingInfo,
  maskPeer = true
): void {
  const exported = buildCallExport(session, transcript, recording, { maskPeer })
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `call-${session.id}.json`
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function CallDetail({ session, transcript, recording, onBack }: CallDetailProps): React.JSX.Element {
  const [showFullPeer, setShowFullPeer] = useState(false)
  const [guardrails, setGuardrails] = useState<GuardrailEvent[]>([])
  const [appointments, setAppointments] = useState<Appointment[]>([])

  useEffect(() => {
    let cancelled = false
    void window.livePhone
      .listGuardrailEvents(session.id)
      .then((events) => {
        if (!cancelled) setGuardrails(events)
      })
      .catch(() => {
        if (!cancelled) setGuardrails([])
      })
    return () => {
      cancelled = true
    }
  }, [session.id])

  useEffect(() => {
    let cancelled = false
    void window.livePhone.getCallAppointments(session.id)
      .then((items) => {
        if (!cancelled) setAppointments(items)
      })
      .catch(() => {
        if (!cancelled) setAppointments([])
      })
    return () => { cancelled = true }
  }, [session.id])

  const recordingComplete = recording?.status === 'complete' && Boolean(recording.playbackUrl)

  return (
    <section className="panel history-detail" data-testid="history-detail" aria-labelledby="history-detail-title">
      <div className="panel__heading history-detail__heading">
        <div>
          <span className="eyebrow">CALL DETAIL</span>
          <h2 id="history-detail-title">Call details</h2>
        </div>
        <button className="history-detail__back" data-testid="history-back" onClick={onBack}>← Back to list</button>
      </div>

      <div className="history-detail__body">
        <dl className="history-detail__meta">
          <div>
            <dt>Direction</dt>
            <dd>{session.direction === 'inbound' ? 'Inbound' : 'Outbound'}</dd>
          </div>
          <div>
            <dt>Number</dt>
            <dd data-testid="history-peer">
              {showFullPeer ? session.peer : maskPhoneNumber(session.peer)}
              <button
                className="history-detail__reveal"
                data-testid="history-reveal-peer"
                onClick={() => setShowFullPeer((current) => !current)}
              >
                {showFullPeer ? 'Hide full number' : 'Show full number'}
              </button>
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{statusLabel(session.status)}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd data-testid="history-duration">{formatDuration(session.durationMs)}</dd>
          </div>
          <div>
            <dt>Campaign</dt>
            <dd>{session.campaignName ?? '—'}</dd>
          </div>
          <div>
            <dt>start time</dt>
            <dd>{formatTime(session.startedAt)}</dd>
          </div>
          <div>
            <dt>end time</dt>
            <dd>{formatTime(session.endedAt)}</dd>
          </div>
          <div>
            <dt>End reason</dt>
            <dd>{session.endReason ?? '—'}</dd>
          </div>
        </dl>

        {session.contactCard && (
          <section className="history-detail__section" aria-labelledby="history-contact-card-title" data-testid="history-contact-card">
            <div className="history-detail__section-heading">
              <span className="history-detail__label" id="history-contact-card-title">Contact card at call time</span>
            </div>
            <p className="history-detail__empty">{summarizeContactCard(session.contactCard)}</p>
          </section>
        )}

        <section className="history-detail__section" aria-labelledby="history-appointments-title">
          <div className="history-detail__section-heading">
            <span className="history-detail__label" id="history-appointments-title">Appointments</span>
            <span className="history-detail__count">{appointments.length}</span>
          </div>
          {appointments.length === 0 ? (
            <p className="history-detail__empty" data-testid="history-appointments">This call has no appointments.</p>
          ) : (
            <ul className="history-appointments" data-testid="history-appointments">
              {appointments.map((appointment) => (
                <li key={appointment.id} className="history-appointment" data-testid="history-appointment">
                  <strong>{formatAppointmentTime(appointment)}</strong>
                  <span>{appointment.timeZone}</span>
                  <span>{appointmentStatusLabel(appointment.status)}</span>
                  <small>{appointmentSourceLabel(appointment.source)}</small>
                </li>
              ))}
            </ul>
          )}
        </section>

        {recordingComplete ? (
          <div className="history-detail__recording">
            <span className="history-detail__label">Recording playback</span>
            <audio controls preload="none" data-testid="history-audio" src={recording.playbackUrl}>
              Your browser cannot play audio.
            </audio>
          </div>
        ) : recording ? (
          <div className="history-detail__recording">
            <span className="history-detail__label">Recording playback</span>
            <p className="history-detail__recording-note">
              {recording.status === 'recording' ? 'Recording…' : 'Recording incomplete'}
            </p>
          </div>
        ) : (
          <div className="history-detail__recording">
            <span className="history-detail__label">Recording playback</span>
            <p className="history-detail__recording-note">No recording</p>
          </div>
        )}

        <section className="history-detail__section" aria-labelledby="history-transcript-title">
          <div className="history-detail__section-heading">
            <span className="history-detail__label" id="history-transcript-title">Call transcript</span>
            <span className="history-detail__count">{transcript.length}</span>
          </div>
          {transcript.length === 0 ? (
            <p className="history-detail__empty">This call has no transcript.</p>
          ) : (
            <div className="history-detail__transcript">
              {transcript.map((entry) => (
                <article
                  className={`history-transcript-entry history-transcript-entry--${entry.speaker}`}
                  data-testid="history-transcript-entry"
                  key={entry.id}
                >
                  <div className="history-transcript-entry__meta">
                    <span>{speakerLabel(entry.speaker)}</span>
                    <time>{formatTime(entry.timestamp)}</time>
                  </div>
                  <p>{entry.text}</p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="history-detail__section" aria-labelledby="history-guardrails-title">
          <div className="history-detail__section-heading">
            <span className="history-detail__label" id="history-guardrails-title">Guardrail events</span>
            <span className="history-detail__count">{guardrails.length}</span>
          </div>
          {guardrails.length === 0 ? (
            <p className="history-detail__empty" data-testid="history-guardrails">This call has no guardrail events.</p>
          ) : (
            <ul className="history-detail__guardrails" data-testid="history-guardrails">
              {guardrails.map((event) => (
                <li key={`${event.kind}:${event.at}`} className="history-guardrail" data-testid="history-guardrail">
                  <div className="history-guardrail__meta">
                    <strong>{guardrailKindLabel(event.kind)}</strong>
                    <time>{formatTime(event.at)}</time>
                  </div>
                  {event.details && Object.keys(event.details).length > 0 && (
                    <p>{summarizeGuardrailDetails(event.details)}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="history-detail__actions">
          <button
            className="history-detail__export"
            data-testid="history-export"
            onClick={() => downloadCallExport(session, transcript, recording, !showFullPeer)}
          >
            Export JSON
          </button>
        </div>
      </div>
    </section>
  )
}

function summarizeContactCard(card: NonNullable<CallSession['contactCard']>): string {
  return [
    card.displayName ? `Name: ${card.displayName}` : undefined,
    card.company ? `Company: ${card.company}` : undefined,
    card.tier ? `Tier: ${card.tier}` : undefined,
    card.language ? `Language: ${card.language}` : undefined,
    card.notes ? `Notes: ${card.notes}` : undefined
  ].filter(Boolean).join(' · ') || 'No summary to display.'
}

function statusLabel(status: CallSession['status']): string {
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
      return 'Waiting for calls'
    default:
      return status
  }
}

function guardrailKindLabel(kind: GuardrailEvent['kind']): string {
  switch (kind) {
    case 'max_duration':
      return 'Call timed out'
    case 'forbidden_claim':
      return 'Forbidden claim'
    case 'dnc_blocked':
      return 'DNC list block'
    case 'outside_calling_hours':
      return 'Outside calling hours'
    case 'blocked_caller':
      return 'Blocked caller'
    default:
      return kind
  }
}

function summarizeGuardrailDetails(details: Record<string, unknown>): string {
  const parts = Object.entries(details).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return `${key}: ${text}`
  })
  return parts.join(' · ')
}

function formatAppointmentTime(appointment: Appointment): string {
  return new Date(appointment.startAt).toLocaleString('en-US', {
    timeZone: appointment.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  })
}

function appointmentStatusLabel(status: Appointment['status']): string {
  return ({ tentative: 'Tentative', confirmed: 'Confirmed', cancelled: 'Cancelled', failed: 'Confirm failed' })[status]
}

function appointmentSourceLabel(source: Appointment['source']): string {
  return ({ copilot: 'Copilot', mcp: 'MCP', manual: 'Manual' })[source]
}
