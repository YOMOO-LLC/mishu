import { useEffect, useState } from 'react'
import type { ApprovalRequest } from '@shared/contracts'

export function ApprovalModal(): React.JSX.Element | null {
  const [request, setRequest] = useState<ApprovalRequest>()
  const [remainingSeconds, setRemainingSeconds] = useState(0)
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => window.livePhone.onApprovalRequested((nextRequest) => {
    setTimedOut(false)
    setRemainingSeconds(Math.max(0, Math.ceil((nextRequest.expiresAt - Date.now()) / 1_000)))
    setRequest(nextRequest)
    playApprovalTone()
  }), [])

  useEffect(() => {
    if (!request) return undefined
    const updateCountdown = (): void => {
      const remaining = Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1_000))
      setRemainingSeconds(remaining)
      if (remaining === 0) {
        setRequest((current) => current?.id === request.id ? undefined : current)
        setTimedOut(true)
      }
    }
    updateCountdown()
    const timer = window.setInterval(updateCountdown, 100)
    return () => window.clearInterval(timer)
  }, [request])

  useEffect(() => {
    if (!timedOut) return undefined
    const timer = window.setTimeout(() => setTimedOut(false), 1_000)
    return () => window.clearTimeout(timer)
  }, [timedOut])

  if (!request) {
    return timedOut
      ? (
          <div className="campaign-modal" role="presentation" data-testid="approval-timeout">
            <section className="campaign-editor panel" role="status">
              <p className="action-error">Timed out</p>
            </section>
          </div>
        )
      : null
  }

  function decide(approved: boolean): void {
    if (!request) return
    window.livePhone.respondApproval({ id: request.id, approved, decidedAt: Date.now() })
    setRequest(undefined)
  }

  return (
    <div className="campaign-modal" role="presentation">
      <section
        className="campaign-editor panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        data-testid="approval-modal"
      >
        <div className="campaign-editor__header">
          <div>
            <span className="eyebrow">LOCAL APPROVAL</span>
            <h2 id="approval-title">{request.title}</h2>
          </div>
        </div>
        <p>{request.summary}</p>
        <p data-testid="approval-countdown">
          {remainingSeconds}s remaining
        </p>
        <pre>{JSON.stringify(request.details, null, 2)}</pre>
        <div className="campaign-editor__actions">
          <span />
          <button data-testid="approval-reject" onClick={() => decide(false)}>Decline</button>
          <button className="primary" data-testid="approval-approve" onClick={() => decide(true)}>Approve</button>
        </div>
      </section>
    </div>
  )
}

function playApprovalTone(): void {
  try {
    const AudioContextClass = window.AudioContext ?? (window as typeof window & {
      webkitAudioContext?: typeof AudioContext
    }).webkitAudioContext
    if (!AudioContextClass) return
    const context = new AudioContextClass()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(880, context.currentTime)
    gain.gain.setValueAtTime(0.08, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.2)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.addEventListener('ended', () => void context.close())
    oscillator.start()
    oscillator.stop(context.currentTime + 0.2)
    if (context.state === 'suspended') void context.resume().catch(() => context.close())
  } catch {
    // Audio notifications are best-effort and must never block local approval.
  }
}
