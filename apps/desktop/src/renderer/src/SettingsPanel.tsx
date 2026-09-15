import { VoiceSection } from './settings/VoiceSection'
import { useEffect, useRef, useState } from 'react'
import {
  shouldHydrateConfig,
  useWebhookSettings
} from './hooks/useWebhookSettings'
import { CrmSection } from './settings/CrmSection'
import { McpSection } from './settings/McpSection'
import { AppointmentsSection } from './settings/AppointmentsSection'
import { BudgetSection } from './settings/BudgetSection'
import { GeneralSection } from './settings/GeneralSection'
import { TwilioSection } from './settings/TwilioSection'
import { SettingsCard } from './settings/ui'

const EVENT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'call.started', label: 'Call started · call.started' },
  { value: 'call.ended', label: 'Call ended · call.ended' },
  { value: 'call.transcript.final', label: 'Final transcript · call.transcript.final' },
  { value: 'recording.ready', label: 'Recording ready · recording.ready' },
  { value: 'guardrail.triggered', label: 'Guardrail triggered · guardrail.triggered' },
  { value: 'call.summary', label: 'Call summary · call.summary' },
  { value: 'call.analyzed', label: 'Structured result · call.analyzed' },
  { value: 'task.queued', label: 'Task queued · task.queued' },
  { value: 'task.started', label: 'Task started · task.started' },
  { value: 'task.completed', label: 'Task completed · task.completed' },
  { value: 'task.failed', label: 'Task failed · task.failed' },
  { value: 'task.cancelled', label: 'Task cancelled · task.cancelled' },
  { value: 'crm.synced', label: 'CRM synced · crm.synced' },
  { value: 'webhook.test', label: 'Test event · webhook.test' }
]

function deliveryStatusLabel(status: string): string {
  switch (status) {
    case 'delivered':
      return 'Delivered'
    case 'failed':
      return 'Failed'
    case 'dead':
      return 'Abandoned'
    case 'delivering':
      return 'Delivering'
    case 'pending':
      return 'Pending'
    default:
      return status
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function SettingsPanel(): React.JSX.Element {
  const {
    config,
    deliveries,
    loading,
    error,
    notice,
    lastRotatedSecret,
    saveConfig,
    rotateSecret,
    sendTest,
    clearError,
    clearNotice,
    refresh
  } = useWebhookSettings()

  const [url, setUrl] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [events, setEvents] = useState<string[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const hydrated = useRef(false)

  useEffect(() => {
    if (config && shouldHydrateConfig(config, hydrated.current, dirty)) {
      hydrated.current = true
      setUrl(config.url)
      setEnabled(config.enabled)
      setEvents(config.events)
      setDirty(false)
    }
  }, [config, dirty])

  function markDirty(): void {
    setDirty(true)
  }

  function toggleEvent(value: string, checked: boolean): void {
    markDirty()
    setEvents((current) =>
      checked ? [...current, value] : current.filter((event) => event !== value)
    )
  }

  async function submitSave(): Promise<void> {
    setSaving(true)
    try {
      await saveConfig({ url, enabled, events })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="panel settings-panel" data-testid="panel-settings">
      <div className="panel__heading">
        <div>
          <span className="eyebrow">SETTINGS</span>
          <h2>Settings</h2>
        </div>
      </div>

      <div className="settings-body">
        <VoiceSection />
        <TwilioSection />
        <section className="settings-stack" data-testid="settings-section-webhook">
        <SettingsCard className="webhook-settings" titleId="webhook-title" title="Webhook delivery" description="Call lifecycle events are signed and delivered to your URL with backoff.">

          <div
            data-testid={loading ? 'webhook-form-loading' : 'webhook-form-ready'}
            className="webhook-form"
          >
          <label className="settings-field webhook-row">
            <span>Destination URL</span>
            <input
              data-testid="webhook-url-input"
              value={url}
              disabled={loading}
              onChange={(event) => {
                markDirty()
                setUrl(event.target.value)
              }}
              placeholder="https://example.com/hook (https or localhost http only)"
            />
          </label>

          <label className="settings-switch webhook-row--switch">
            <span>Enabled</span>
            <input
              type="checkbox"
              data-testid="webhook-enabled"
              checked={enabled}
              disabled={loading}
              onChange={(event) => {
                markDirty()
                setEnabled(event.target.checked)
              }}
            />
          </label>

          <fieldset className="webhook-events">
            <legend>Subscribed events</legend>
            {EVENT_OPTIONS.map((option) => (
              <label key={option.value} className="webhook-event">
                <input
                  type="checkbox"
                  data-testid={`webhook-event-${option.value}`}
                  checked={events.includes(option.value)}
                  disabled={loading}
                  onChange={(event) => toggleEvent(option.value, event.target.checked)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>

          <div className="settings-actions">
            <button
              className="settings-button settings-button--primary"
              data-testid="webhook-save-button"
              disabled={saving || loading}
              onClick={() => void submitSave()}
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>
            <button className="settings-button settings-button--secondary" data-testid="webhook-rotate-button" disabled={loading} onClick={() => void rotateSecret()}>
              Generate / rotate secret
            </button>
            <button className="settings-button settings-button--secondary" data-testid="webhook-test-button" disabled={loading} onClick={() => void sendTest()}>
              Send test event
            </button>
          </div>
          </div>

          {lastRotatedSecret && (
            <div className="webhook-secret" data-testid="webhook-secret-preview">
              <strong>New secret (copy now; shown only this once)</strong>
              <code data-testid="webhook-secret-value">{lastRotatedSecret}</code>
            </div>
          )}

          {notice && (
            <p className="settings-notice" data-testid="webhook-notice">
              {notice}
            </p>
          )}
          {error && (
            <p className="settings-error" data-testid="webhook-error">
              {error}
            </p>
          )}
        </SettingsCard>

        <SettingsCard className="webhook-deliveries" titleId="deliveries-title" title="Recent deliveries" description="Review recent delivery status, attempts, and errors.">
          {deliveries.length === 0 ? (
            <p className="webhook-deliveries__empty" data-testid="webhook-deliveries-empty">
              No deliveries yet
            </p>
          ) : (
            <table className="webhook-deliveries__table" data-testid="webhook-deliveries">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Status / error</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((delivery) => (
                  <tr key={delivery.id} data-testid={`webhook-delivery-${delivery.id}`}>
                    <td>{delivery.eventType}</td>
                    <td data-testid={`webhook-delivery-status-${delivery.id}`}>
                      {deliveryStatusLabel(delivery.status)}
                    </td>
                    <td>{delivery.attempts}</td>
                    <td>
                      {delivery.lastStatusCode ?? ''}
                      {delivery.lastError ? ` ${delivery.lastError}` : ''}
                    </td>
                    <td>{formatTime(delivery.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="webhook-deliveries__actions">
            <button
              className="settings-button settings-button--secondary"
              data-testid="webhook-refresh-button"
              onClick={() => {
                clearError()
                clearNotice()
                void refresh()
              }}
            >
              Refresh
            </button>
          </div>
        </SettingsCard>
        </section>
        <GeneralSection />
        <BudgetSection />
        <McpSection />
        <CrmSection />
        <AppointmentsSection />
      </div>
    </section>
  )
}
