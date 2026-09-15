import { useEffect, useState } from 'react'
import type { CallBudget } from '@shared/contracts'
import { Field, SettingsCard, StatusBadge } from './ui'

const EMPTY: CallBudget = {
  enabled: false, dailyMaxCalls: 0, dailyMaxMinutes: 0,
  allowedPrefixes: [], allowedNumbers: [],
  allowedHours: { timeZone: 'UTC', windows: [] }, killSwitch: false
}

export function BudgetSection(): React.JSX.Element {
  const [budget, setBudget] = useState<CallBudget>(EMPTY)
  const [numbers, setNumbers] = useState('')
  const [prefixes, setPrefixes] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void window.livePhone.getBudget().then((value) => {
      setBudget(value)
      setNumbers(value.allowedNumbers.join('\n'))
      setPrefixes(value.allowedPrefixes.join('\n'))
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [])

  async function save(): Promise<void> {
    try {
      const saved = await window.livePhone.saveBudget({
        ...budget,
        allowedNumbers: lines(numbers),
        allowedPrefixes: lines(prefixes)
      })
      setBudget(saved)
      setNotice('Budget saved')
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setNotice('')
    }
  }

  return (
    <SettingsCard className="settings-subsection budget-settings" testId="settings-section-budget" title="Autodial budget" description="Off by default. Tasks request local approval when this is off or any limit is exceeded. The kill switch blocks tasks immediately." badge={<StatusBadge tone={budget.enabled ? 'success' : 'neutral'}>{budget.enabled ? 'Enabled' : 'Disabled'}</StatusBadge>}>
      <label className="settings-switch"><span>Enable in-budget direct dial</span><input type="checkbox" checked={budget.enabled} onChange={(event) => setBudget({ ...budget, enabled: event.target.checked })} /></label>
      <label className="settings-switch settings-switch--danger"><span>Kill switch</span><input type="checkbox" checked={budget.killSwitch} onChange={(event) => setBudget({ ...budget, killSwitch: event.target.checked })} /></label>
      <div className="budget-grid">
        <Field label="Daily max calls"><input type="number" min="0" value={budget.dailyMaxCalls} onChange={(event) => setBudget({ ...budget, dailyMaxCalls: Number(event.target.value) })} /></Field>
        <Field label="Daily max minutes"><input type="number" min="0" value={budget.dailyMaxMinutes} onChange={(event) => setBudget({ ...budget, dailyMaxMinutes: Number(event.target.value) })} /></Field>
        <Field label="Allowed numbers (one per line)"><textarea value={numbers} onChange={(event) => setNumbers(event.target.value)} /></Field>
        <Field label="Allowed prefixes (one per line)"><textarea value={prefixes} onChange={(event) => setPrefixes(event.target.value)} /></Field>
      </div>
      <button className="settings-button settings-button--primary" onClick={() => void save()}>Save budget</button>
      {notice && <p className="settings-notice">{notice}</p>}
      {error && <p className="settings-error">{error}</p>}
    </SettingsCard>
  )
}

function lines(value: string): string[] {
  return [...new Set(value.split(/\s+/).map((item) => item.trim()).filter(Boolean))]
}
