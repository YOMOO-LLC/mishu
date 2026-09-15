import { useEffect, useState } from 'react'
import type { TwilioCheckResult, TwilioSettingsMode, TwilioSettingsPublic, TwilioSettingsSaveInput } from '@shared/contracts'
import { Field, SegmentedControl, SettingsCard, StatusBadge } from './ui'

type FieldName = 'accountSid' | 'apiKeySid' | 'apiKeySecret' | 'twimlAppSid' | 'phoneNumber' | 'clientIdentity'
const LABELS: Record<FieldName, string> = {
  accountSid: 'Account SID', apiKeySid: 'API Key SID', apiKeySecret: 'API Key Secret',
  twimlAppSid: 'TwiML App SID', phoneNumber: 'Phone number (E.164, optional)', clientIdentity: 'Client identity'
}

export function TwilioSection(): React.JSX.Element {
  const [settings, setSettings] = useState<TwilioSettingsPublic>()
  const [values, setValues] = useState<Record<FieldName, string>>({ accountSid: '', apiKeySid: '', apiKeySecret: '', twimlAppSid: '', phoneNumber: '', clientIdentity: '' })
  const [mode, setMode] = useState<TwilioSettingsMode>('auto')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [checks, setChecks] = useState<TwilioCheckResult[]>([])
  const [showSecret, setShowSecret] = useState(false)

  useEffect(() => { void refresh() }, [])

  async function refresh(): Promise<void> {
    try {
      const current = await window.livePhone.getTwilioSettings()
      setSettings(current)
      setMode(current.mode)
      setValues((previous) => ({ ...previous, phoneNumber: current.phoneNumber.value, clientIdentity: current.clientIdentity.value }))
    } catch (reason) {
      setError(message(reason))
    }
  }

  function update(field: FieldName, value: string): void {
    setValues((current) => ({ ...current, [field]: value }))
  }

  async function save(extra: TwilioSettingsSaveInput = {}): Promise<void> {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const input: TwilioSettingsSaveInput = { mode }
      for (const field of Object.keys(values) as FieldName[]) if (values[field]) input[field] = values[field]
      Object.assign(input, extra)
      const current = await window.livePhone.saveTwilioSettings(input)
      setSettings(current)
      window.dispatchEvent(new CustomEvent('twilio-settings-updated', { detail: { configured: current.configured } }))
      setValues((value) => ({ ...value, accountSid: '', apiKeySid: '', apiKeySecret: '', twimlAppSid: '' }))
      setShowSecret(false)
      setNotice(current.restartRequired ? 'Settings saved. Restart the app to switch phone mode.' : 'Twilio settings saved.')
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  async function importEnv(): Promise<void> {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await window.livePhone.importTwilioEnv()
      if ('cancelled' in result) return
      setSettings(result.settings)
      setMode(result.settings.mode)
      window.dispatchEvent(new CustomEvent('twilio-settings-updated', { detail: { configured: result.settings.configured } }))
      setNotice(`Imported: ${result.imported.join(', ') || 'no importable fields'}`)
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  async function testConnection(): Promise<void> {
    setBusy(true)
    setError('')
    setChecks([])
    try {
      setChecks((await window.livePhone.testTwilioConnection()).checks)
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  function sourceBadge(field: FieldName): React.JSX.Element {
    const source = settings?.[field].source
    if (source === 'env') return <StatusBadge tone="warning">From .env · read-only</StatusBadge>
    if (source === 'settings') return <StatusBadge tone="success">From local settings</StatusBadge>
    return <StatusBadge>Not set</StatusBadge>
  }

  return (
    <SettingsCard
      id="twilio-settings"
      testId="settings-section-twilio"
      className="twilio-settings settings-card--wide"
      title="Phone line (Twilio)"
      description="Credentials stay in a 0600 file in the main process; a saved API Key Secret is never echoed."
      badge={<StatusBadge tone={settings?.configured ? 'success' : 'neutral'}>{settings?.configured ? 'Configured' : 'Not configured'}</StatusBadge>}
    >
      <div className="twilio-settings__grid">
        {(Object.keys(LABELS) as FieldName[]).map((field) => {
          const state = settings?.[field]
          const secret = field === 'apiKeySecret'
          const suffix = state && 'last4' in state ? state.last4 : undefined
          const placeholder = state?.configured
            ? `Set${suffix ? ` · last 4 ${suffix}` : ''} (leave blank to keep)`
            : field === 'clientIdentity' ? 'mishu' : ''
          const id = `twilio-${field}-input`
          return (
            <Field
              key={field}
              label={LABELS[field]}
              htmlFor={id}
              meta={sourceBadge(field)}
              className={state?.source === 'env' ? 'settings-field--readonly' : undefined}
            >
              <div className="settings-input-row">
                <input
                  id={id}
                  data-testid={`twilio-${field}`}
                  type={secret && !showSecret ? 'password' : 'text'}
                  value={state?.readOnly && 'value' in state ? state.value : values[field]}
                  placeholder={placeholder}
                  disabled={busy || state?.readOnly}
                  autoComplete={secret ? 'new-password' : 'off'}
                  onChange={(event) => update(field, event.target.value)}
                />
                {secret && (
                  <button
                    className="settings-button settings-button--compact"
                    type="button"
                    disabled={busy || state?.readOnly || !values.apiKeySecret}
                    aria-pressed={showSecret}
                    onClick={() => setShowSecret((visible) => !visible)}
                  >
                    {showSecret ? 'Hide' : 'Show'}
                  </button>
                )}
                {secret && state?.configured && !state.readOnly && (
                  <button
                    className="settings-button settings-button--danger settings-button--compact"
                    data-testid="twilio-secret-clear"
                    type="button"
                    disabled={busy}
                    onClick={() => void save({ apiKeySecret: null })}
                  >Clear</button>
                )}
              </div>
            </Field>
          )
        })}
      </div>

      <Field label="Runtime mode" help="Restart the app after changing mode.">
        <SegmentedControl<TwilioSettingsMode>
          label="Twilio runtime mode"
          value={mode}
          disabled={busy}
          options={[
            { value: 'auto', label: 'Auto', description: 'Choose from settings' },
            { value: 'twilio', label: 'Twilio', description: 'Use the live line' },
            { value: 'mock', label: 'Mock', description: 'Local testing only' }
          ]}
          onChange={setMode}
        />
      </Field>

      <div className="settings-actions settings-actions--bar">
        <button className="settings-button settings-button--primary" data-testid="twilio-save" disabled={busy} onClick={() => void save()}>{busy ? 'Working…' : 'Save settings'}</button>
        <button className="settings-button settings-button--secondary" data-testid="twilio-import" disabled={busy} onClick={() => void importEnv()}>Import from .env…</button>
        <button className="settings-button settings-button--secondary" data-testid="twilio-test" disabled={busy} onClick={() => void testConnection()}>Test connection</button>
        {settings?.restartRequired && <button className="settings-button settings-button--secondary" data-testid="twilio-relaunch" disabled={busy} onClick={() => void window.livePhone.relaunchApp()}>Relaunch now</button>}
      </div>

      {checks.length > 0 && (
        <ul className="settings-checks" data-testid="twilio-test-results">
          {checks.map((check) => (
            <li key={check.check}><StatusBadge tone={check.ok ? 'success' : 'danger'}>{check.check}: {check.ok ? 'passed' : check.code}</StatusBadge></li>
          ))}
        </ul>
      )}
      {notice && <p className="settings-notice" data-testid="twilio-notice">{notice}</p>}
      {error && <p className="settings-error" data-testid="twilio-error">{error}</p>}
    </SettingsCard>
  )
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
