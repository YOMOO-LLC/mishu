import { useEffect, useState } from 'react'
import type {
  AppointmentBusinessHours,
  AppointmentProvider,
  AppointmentsConfig
} from '../../../shared/contracts'
import { Field, SettingsCard, StatusBadge } from './ui'

const DAYS = [
  [1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']
] as const

export function AppointmentsSection(): React.JSX.Element {
  const [config, setConfig] = useState<AppointmentsConfig>()
  const [provider, setProvider] = useState<AppointmentProvider>('mock')
  const [autoConfirm, setAutoConfirm] = useState(false)
  const [timeZone, setTimeZone] = useState('UTC')
  const [businessHours, setBusinessHours] = useState<AppointmentBusinessHours>({
    days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00'
  })
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.livePhone.getAppointmentsConfig()
      .then((value) => {
        if (cancelled) return
        setConfig(value)
        setProvider(value.provider)
        setAutoConfirm(value.autoConfirm)
        setTimeZone(value.timeZone)
        setBusinessHours(value.businessHours)
      })
      .catch((loadError) => {
        if (!cancelled) setError(message(loadError))
      })
    return () => { cancelled = true }
  }, [])

  async function save(): Promise<void> {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const saved = await window.livePhone.saveAppointmentsConfig({
        provider, autoConfirm, timeZone, businessHours
      })
      setConfig(saved)
      setNotice('Appointment settings saved')
    } catch (saveError) {
      setError(message(saveError))
    } finally {
      setSaving(false)
    }
  }

  function toggleDay(day: number, checked: boolean): void {
    setBusinessHours((current) => ({
      ...current,
      days: checked
        ? [...new Set([...current.days, day])].sort()
        : current.days.filter((value) => value !== day)
    }))
  }

  return (
    <SettingsCard className="appointments-settings" testId="settings-section-appointments" title="Appointments & calendar" description="Intents are recorded during the call; the calendar is written after hangup when auto-confirm is on." badge={<StatusBadge tone={autoConfirm ? 'success' : 'neutral'}>{!config ? 'Loading…' : autoConfirm ? 'Auto-confirm' : 'Intent only'}</StatusBadge>}>

      <div className="appointments-form">
        <Field label="Calendar backend" htmlFor="appointments-provider">
          <select id="appointments-provider" data-testid="appointments-provider" value={provider} disabled={saving} onChange={(event) => setProvider(event.target.value as AppointmentProvider)}>
            <option value="mock">Mock (local)</option>
            <option value="zoho">Zoho (reserved)</option>
          </select>
        </Field>

        <label className="settings-switch">
          <span>Auto-confirm after the call</span>
          <input data-testid="appointments-auto-confirm" type="checkbox" checked={autoConfirm} disabled={saving} onChange={(event) => setAutoConfirm(event.target.checked)} />
        </label>

        <Field label="Business time zone (IANA)" htmlFor="appointments-time-zone"><input id="appointments-time-zone" data-testid="appointments-time-zone" value={timeZone} disabled={saving} onChange={(event) => setTimeZone(event.target.value)} placeholder="America/Chicago" /></Field>

        <fieldset className="appointments-days">
          <legend>Business days</legend>
          {DAYS.map(([day, label]) => (
            <label key={day}>
              <input type="checkbox" checked={businessHours.days.includes(day)} disabled={saving} onChange={(event) => toggleDay(day, event.target.checked)} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>

        <div className="appointments-hours">
          <Field label="Start" htmlFor="appointments-hours-start"><input id="appointments-hours-start" data-testid="appointments-hours-start" type="time" value={businessHours.start} disabled={saving} onChange={(event) => setBusinessHours((current) => ({ ...current, start: event.target.value }))} /></Field>
          <Field label="End" htmlFor="appointments-hours-end"><input id="appointments-hours-end" data-testid="appointments-hours-end" type="time" value={businessHours.end} disabled={saving} onChange={(event) => setBusinessHours((current) => ({ ...current, end: event.target.value }))} /></Field>
        </div>

        <button className="settings-button settings-button--primary appointments-save" data-testid="appointments-save" disabled={!config || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save appointment settings'}
        </button>
      </div>
      {notice && <p className="settings-notice" data-testid="appointments-notice">{notice}</p>}
      {error && <p className="settings-error" data-testid="appointments-error">{error}</p>}
    </SettingsCard>
  )
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
