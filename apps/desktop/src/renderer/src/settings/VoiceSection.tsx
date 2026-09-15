import { useEffect, useState } from 'react'
import { LIVE_API_VOICES, type OpenAiSettingsPublic, type VoiceSettings } from '../../../shared/contracts'
import { Field, SegmentedControl, SettingsCard, StatusBadge } from './ui'

export function VoiceSection(): React.JSX.Element {
  const [voice, setVoice] = useState<VoiceSettings>()
  const [keyInfo, setKeyInfo] = useState<OpenAiSettingsPublic>()
  const [key, setKey] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void Promise.all([window.livePhone.getVoiceSettings(), window.livePhone.getOpenAiSettings()])
      .then(([voice, info]) => { setVoice(voice); setKeyInfo(info) })
      .catch(() => setMessage('Unable to load voice settings'))
  }, [])

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    setMessage('')
    try {
      await action()
    } catch {
      setMessage('Save failed; source and keys cannot change during a call.')
    } finally {
      setBusy(false)
    }
  }

  async function update(input: Partial<VoiceSettings>): Promise<void> {
    const result = await window.livePhone.saveVoiceSettings(input)
    setVoice(result)
    window.dispatchEvent(new CustomEvent('voice-settings-updated', { detail: result }))
  }

  const apiSelected = voice?.provider === 'gpt-live-api'
  const keyReadOnly = keyInfo?.apiKey.readOnly ?? false
  const messageTone = /fail|unable|cannot|could not/i.test(message) ? 'danger' : 'success'

  return (
    <SettingsCard
      id="voice-settings"
      className="voice-settings settings-card--wide"
      title="Voice source"
      description="Choose how live voice connects and manage separate GPT Live API settings."
      badge={<StatusBadge tone={apiSelected ? 'warning' : 'success'}>{apiSelected ? 'GPT Live API' : 'Codex app-server (local)'}</StatusBadge>}
    >
      <div className="settings-group">
        <div className="settings-group__heading">
          <strong>Source</strong>
          <span>Codex app-server uses local sign-in; GPT Live API uses a separate key and is billed per second.</span>
        </div>
        <SegmentedControl
          label="Voice source"
          value={voice?.provider ?? 'codex'}
          disabled={busy || !voice}
          options={[
            { value: 'codex', label: 'Codex app-server (local)', description: 'Local sign-in' },
            { value: 'gpt-live-api', label: 'GPT Live API', description: 'Separate API credentials' }
          ]}
          onChange={(provider) => void run(() => update({ provider }))}
        />
      </div>

      <div className="settings-group">
        <div className="settings-group__heading settings-group__heading--inline">
          <strong>OpenAI API key</strong>
          {keyInfo?.apiKey.configured ? (
            <StatusBadge tone="success">Set · last 4 {keyInfo.apiKey.last4}</StatusBadge>
          ) : (
            <StatusBadge>API key not set</StatusBadge>
          )}
          {keyReadOnly && <StatusBadge tone="warning">From .env · read-only</StatusBadge>}
        </div>
        <Field
          label="Enter a new key"
          htmlFor="openai-api-key"
          help="Saved keys are never echoed; leave blank to keep the current value."
          className={keyReadOnly ? 'settings-field--readonly' : undefined}
        >
          <input
            id="openai-api-key"
            aria-label="OpenAI API key"
            type="password"
            autoComplete="off"
            value={key}
            disabled={busy || keyReadOnly}
            placeholder={keyInfo?.apiKey.configured ? 'Enter a new key to replace it' : 'sk-…'}
            onChange={(event) => setKey(event.target.value)}
          />
        </Field>
        <div className="settings-actions">
          <button className="settings-button settings-button--primary" disabled={busy || !key || keyReadOnly} onClick={() => void run(async () => {
            const input = key
            setKey('')
            setKeyInfo(await window.livePhone.saveOpenAiSettings({ apiKey: input }))
            setMessage('Key saved')
          })}>Save API key</button>
          <button className="settings-button settings-button--secondary" disabled={busy || !keyInfo?.apiKey.configured} onClick={() => void run(async () => {
            const result = await window.livePhone.testOpenAiConnection()
            setMessage(result.ok ? 'API key test passed' : `API key test failed: ${result.code}`)
          })}>Test API key</button>
          <button className="settings-button settings-button--danger" disabled={busy || keyReadOnly || !keyInfo?.apiKey.configured} onClick={() => void run(async () => {
            setKey('')
            setKeyInfo(await window.livePhone.saveOpenAiSettings({ apiKey: null }))
          })}>Clear API key</button>
        </div>
      </div>

      <div className={`settings-group${apiSelected ? '' : ' settings-group--disabled'}`}>
        <div className="settings-group__heading">
          <strong>GPT Live options</strong>
          <span>{apiSelected ? 'Applies only when GPT Live API is the source.' : 'Configurable after switching to GPT Live API; Codex app-server uses the Campaign voice.'}</span>
        </div>
        <div className="voice-settings__options">
          <Field label="Voice" htmlFor="api-voice">
            <select
              id="api-voice"
              aria-label="API voice"
              value={voice?.apiVoice ?? 'marin'}
              disabled={busy || !voice || !apiSelected}
              onChange={(event) => void run(() => update({ apiVoice: event.target.value as VoiceSettings['apiVoice'] }))}
            >
              {LIVE_API_VOICES.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </Field>
          <Field label="Session start timing" help="On answer: no charge if nobody picks up, speech starts a few seconds later. On dial: faster speech, ring time is billed.">
            <SegmentedControl
              label="Session start timing"
              value={voice?.startPolicy ?? 'on_dial'}
              disabled={busy || !voice || !apiSelected}
              options={[
                { value: 'on_answer', label: 'On answer' },
                { value: 'on_dial', label: 'On dial' }
              ]}
              onChange={(startPolicy) => void run(() => update({ startPolicy }))}
            />
          </Field>
        </div>
        {apiSelected && <p className="settings-help">Copilot supports transcript mode; delegation mode is skipped.</p>}
      </div>

      {message && <div className="settings-inline-status" role="status"><StatusBadge tone={messageTone}>{message}</StatusBadge></div>}
    </SettingsCard>
  )
}
